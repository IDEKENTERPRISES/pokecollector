"""Background jobs for the matcher: build the index, run the benchmark. One at a time, in a thread,
at low priority, with ONNX Runtime and OpenCV held to the thread cap. The admin API starts them; so do
the nonprod autorun (autorun.py) and the after-sync hook."""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import MATCHER_VERSION, config, lifecycle
from .model_specs import DEFAULT_MODEL

logger = logging.getLogger(__name__)

def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class MatchJobs:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._state = self._idle()

    @staticmethod
    def _idle() -> dict:
        return {"running": False, "kind": None, "started_at": None, "finished_at": None, "progress": {}, "error": None, "summary": None}

    def status(self) -> dict:
        with self._lock:
            return json.loads(json.dumps(self._state, default=str))

    def is_running(self) -> bool:
        with self._lock:
            return self._state["running"]

    def stop(self) -> None:
        self._stop.set()

    def _progress(self, state: dict) -> None:
        with self._lock:
            self._state["progress"] = state

    def start(self, kind: str, work: Callable[[], dict | None]) -> tuple[bool, dict]:
        """Run ``work()`` in a background thread unless a job is already running. (started, status)."""
        with self._lock:
            if self._state["running"]:
                return False, json.loads(json.dumps(self._state, default=str))
            self._stop.clear()
            self._state = {**self._idle(), "running": True, "kind": kind, "started_at": _now()}
            self._thread = threading.Thread(target=self._run, args=(kind, work), name=f"card-match-{kind}", daemon=True)
            self._thread.start()
        return True, self.status()

    def _run(self, kind: str, work: Callable[[], dict | None]) -> None:
        summary = None
        error = None
        try:
            config.lower_priority()
            config.apply_thread_caps()
            with lifecycle.in_use():  # a job is use for its whole length: the GPU sessions are never unloaded under it
                summary = work()
        except Exception as exc:
            logger.exception("Card-match job %s failed", kind)
            error = str(exc) or exc.__class__.__name__
        finally:
            with self._lock:
                self._state.update(running=False, finished_at=_now(), error=error, summary=summary)

    def wait(self, timeout: float | None = None) -> None:
        thread = self._thread
        if thread is not None:
            thread.join(timeout)


jobs = MatchJobs()


# ── The jobs themselves ──────────────────────────────────────────────────────

def _session_factory():
    from database import SessionLocal

    return SessionLocal


def build_index_work(model: str = DEFAULT_MODEL, *, session_factory=None, embedder=None, data_dir: Path | None = None) -> dict:
    """``model`` is an index name from ``variants.index_specs()``: the whole-card index of a model, or the
    artwork-only index of the default model."""
    from . import index as index_module, variants
    from .embed import get_embedder

    spec = variants.index_specs().get(model, {"model": model, "crop": "full"})
    result = index_module.build_index(
        session_factory or _session_factory(), embedder or get_embedder(spec["model"]), data_dir=data_dir,
        progress=jobs._progress, should_stop=jobs._stop.is_set, crop=spec["crop"], index_name=model,
    )
    if spec.get("custom") and embedder is None:  # the custom model may have just become usable: give it the picture model's GPU share
        from . import warmup

        warmup.promote_picture_model()
    return result


def benchmark_work(kind: str, model: str = DEFAULT_MODEL, *, session_factory=None, embedder=None, data_dir: Path | None = None,
                   count: int = 400, options: str | None = None, labels: list[str] | None = None,
                   why: dict[str, str] | None = None) -> dict:
    """``kind``: synthetic, labelled (the option set in use, or ``options``), or compare-synthetic /
    compare-labelled (every option set side by side; a clear winner on real photos becomes the one in use)."""
    from . import benchmark, misses, pipeline, variants
    from .embed import get_embedder
    from .index import get_index
    from .ocr import get_reader
    from services import scan_trace

    factory = session_factory or _session_factory()
    index = get_index(model, data_dir)
    if index is None or len(index) == 0:
        raise RuntimeError("The picture index is empty: build it first")
    from services import trace_sources

    trace_dir = scan_trace.trace_root() or scan_trace.trace_storage_root()
    # Real scans can come from the local folder, from a read-only source (prod's, SCAN_TRACE_READONLY_DIRS), or both.
    has_traces = bool(trace_dir) or bool(trace_sources.readonly_roots())
    try:  # pictures made from scans that were deleted at their source go at the start of every run
        misses.purge_vanished(data_dir)
    except Exception:
        logger.exception("Card-match: could not clear the pictures of deleted scans")
    if kind == "ocr-check":
        from . import ocr_check

        if not has_traces:
            raise RuntimeError("No diagnostics traces with a confirmed answer yet")
        report = ocr_check.run_ocr_check(factory, get_reader(), trace_dir=trace_dir, progress=jobs._progress, should_stop=jobs._stop.is_set)
        if report is None:
            raise RuntimeError("No diagnostics traces with a confirmed answer yet")
        path = benchmark.save_report(report, data_dir)
        return {"report": path.name, "kind": kind, "n": report["traces"], "duration_seconds": report["duration_seconds"]}
    if kind.startswith("compare-"):
        base_kind = kind.split("-", 1)[1]
        if base_kind == "labelled" and not has_traces:
            raise RuntimeError("No diagnostics traces with a confirmed answer for English cards yet")
        # The synthetic comparison chooses nothing (only real photos do), so it runs a short list on fewer photos.
        synthetic = base_kind == "synthetic"
        run_labels, selected, reference = benchmark.resolve_compare_labels(base_kind, labels, data_dir)
        report = benchmark.run_compare(
            base_kind, factory, run_labels, selected=selected, reference=reference, data_dir=data_dir,
            trace_dir=trace_dir, ocr_reader=get_reader(), progress=jobs._progress, should_stop=jobs._stop.is_set,
            count=variants.SYNTHETIC_COMPARE_COUNT if synthetic else count, why=why,
        )
        if base_kind == "labelled" and report["winner"] and not jobs._stop.is_set():
            winner = next(row for row in report["rows"] if row["label"] == report["winner"])
            variants.save_chosen(
                winner["label"],
                f"best of {len(report['rows'])} option sets on {winner['n']} real photos: top 20 {winner['top20']}%, decided {winner['decided']}%, {winner['decided_wrong']} wrong",
                data_dir,
            )
        path = benchmark.save_report(report, data_dir)
        return {"report": path.name, "kind": kind, "n": report["metrics"]["n"], "duration_seconds": report["duration_seconds"], "winner": report["winner"]}
    if options is not None:
        matcher = variants.build_matcher(variants.parse(options), factory, data_dir=data_dir, ocr_reader=get_reader())
    elif embedder is not None:  # tests hand in their own embedder
        matcher = pipeline.CardMatcher(index, embedder, pipeline.db_candidate_loader(factory), get_reader())
    else:
        matcher = variants.build_matcher(variants.parse(variants.active_label(data_dir)), factory, data_dir=data_dir, ocr_reader=get_reader())
    if kind == "labelled":
        collector = misses.MissCollector(matcher.candidate_loader, data_dir)
        report = (
            benchmark.run_labelled(factory, matcher, trace_dir=trace_dir, progress=jobs._progress, should_stop=jobs._stop.is_set, collector=collector)
            if has_traces else None
        )
        if report is None:
            raise RuntimeError("No diagnostics traces with a confirmed answer for English cards yet")
    else:
        report = benchmark.run_synthetic(factory, matcher, count=count, data_dir=data_dir, progress=jobs._progress, should_stop=jobs._stop.is_set)
    path = benchmark.save_report(report, data_dir)
    return {"report": path.name, "kind": kind, "n": report["metrics"]["n"], "duration_seconds": report["duration_seconds"]}


def calibrate_work(model_id: str, *, session_factory=None, data_dir: Path | None = None, on_stored: Callable[[dict], None] | None = None) -> dict:
    """Version 16 test: the Scanner lab job that calibrates one custom model's picture thresholds (``calibration.py``). ``on_stored`` (the audit
    log entry) is called with the stored calibration."""
    from . import calibration
    from services import scan_trace, trace_sources

    trace_dir = scan_trace.trace_root() or scan_trace.trace_storage_root()
    if not trace_dir and not trace_sources.readonly_roots():
        raise RuntimeError("No diagnostics traces with a confirmed answer yet")
    try:
        stored = calibration.run_calibration(model_id, session_factory or _session_factory(), data_dir=data_dir, trace_dir=trace_dir,
                                             progress=jobs._progress, should_stop=jobs._stop.is_set)
    except calibration.CalibrationError as exc:
        raise RuntimeError(str(exc)) from exc
    if on_stored is not None:
        on_stored(stored)
    return {"kind": "calibrate", "model": model_id, "scans": stored["scans"], "thresholds": stored["thresholds"]}


def start_calibration(model_id: str, on_stored: Callable[[dict], None] | None = None) -> tuple[bool, dict]:
    return jobs.start("calibrate", lambda: calibrate_work(model_id, on_stored=on_stored))


def start_index(model: str = DEFAULT_MODEL) -> tuple[bool, dict]:
    return jobs.start("index", lambda: build_index_work(model))


def custom_indexes_work(model_id: str, *, build=None) -> dict:
    """Build a custom model's whole-card index, then its artwork index, in one job (a stop or a failure of the first ends the job)."""
    from . import custom_models

    build = build or build_index_work
    names = custom_models.index_names(model_id)
    summary = {}
    for kind in ("whole", "art"):
        if jobs._stop.is_set():
            break
        summary[kind] = build(names[kind])
    return {"kind": "custom-indexes", "model": model_id, "indexes": summary}


def start_custom_indexes(model_id: str) -> tuple[bool, dict]:
    """After an upload: the model's two index builds, one job after another. Does nothing (False) while another job is running."""
    return jobs.start("index", lambda: custom_indexes_work(model_id))


def start_benchmark(kind: str = "synthetic", model: str = DEFAULT_MODEL, labels: list[str] | None = None, why: dict[str, str] | None = None) -> tuple[bool, dict]:
    """``labels``: for the two comparisons, the rows to run (None or empty: all of them). ``why``: the autorun's reason for each row, saved in the report."""
    return jobs.start(f"benchmark-{kind}", lambda: benchmark_work(kind, model, labels=labels, why=why))


AUTORUN_WARMUP_WAIT_SECONDS = 4 * 3600  # how long the autorun waits for the picture warm-up (autorun.py)


# ── After a card sync (the nonprod autorun is in autorun.py) ─────────────────

def index_after_warmup(warmer) -> None:
    """After the picture warmer finishes, add the new pictures to the index (SCAN_MATCHER_INDEX_AFTER_SYNC=1)."""
    if not config.index_after_sync_enabled():
        return

    def wait_then_build() -> None:
        deadline = time.monotonic() + AUTORUN_WARMUP_WAIT_SECONDS
        while warmer.is_running() and time.monotonic() < deadline:
            time.sleep(10)
        start_index()

    threading.Thread(target=wait_then_build, name="card-match-after-sync", daemon=True).start()
