"""Background jobs for the matcher: build the index, run the benchmark. One at a time, in a thread,
at low priority, with ONNX Runtime and OpenCV held to the thread cap. The admin API starts them; so do
the nonprod autorun and the after-sync hook."""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import MATCHER_VERSION, config
from .model_specs import DEFAULT_MODEL

logger = logging.getLogger(__name__)

AUTORUN_WARMUP_WAIT_SECONDS = 4 * 3600  # how long the autorun waits for the picture warm-up


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
    return index_module.build_index(
        session_factory or _session_factory(), embedder or get_embedder(spec["model"]), data_dir=data_dir,
        progress=jobs._progress, should_stop=jobs._stop.is_set, crop=spec["crop"], index_name=model,
    )


def benchmark_work(kind: str, model: str = DEFAULT_MODEL, *, session_factory=None, embedder=None, data_dir: Path | None = None,
                   count: int = 400, options: str | None = None) -> dict:
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
        report = benchmark.run_compare(
            base_kind, factory, variants.SYNTHETIC_COMPARE_LABELS if synthetic else variants.COMPARE_LABELS, data_dir=data_dir,
            trace_dir=trace_dir, ocr_reader=get_reader(), progress=jobs._progress, should_stop=jobs._stop.is_set,
            count=variants.SYNTHETIC_COMPARE_COUNT if synthetic else count,
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


def start_index(model: str = DEFAULT_MODEL) -> tuple[bool, dict]:
    return jobs.start("index", lambda: build_index_work(model))


def start_benchmark(kind: str = "synthetic", model: str = DEFAULT_MODEL) -> tuple[bool, dict]:
    return jobs.start(f"benchmark-{kind}", lambda: benchmark_work(kind, model))


AUTORUN_MIN_LABELLED = 100  # confirmed traces needed before the real-photo benchmark runs by itself


# ── After a card sync, and once after a nonprod deploy ───────────────────────

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


def autorun_plan(*, indexes_ready: bool, enough_real: bool) -> list[str]:
    """The autorun's steps, in order. What the owner decides from comes first: the OCR check, the real-photo
    benchmark and the real-photo comparison. The synthetic runs choose nothing and go last. When the indexes are already
    built the real-photo steps run before the picture warm-up and the index update (version 5 ran those first and the
    synthetic benchmark before any real-photo report: about two hours before the first report)."""
    real = ["ocr-check", "labelled", "compare-labelled"] if enough_real else []
    build = ["warm-up", "index", "art-index"]
    synthetic = ["synthetic", "compare-synthetic"]
    return (real + build + synthetic) if indexes_ready else (build + real + synthetic)


def _autorun_log(entries: list[dict]) -> None:
    """When each autorun step started and how long it took, so a slow rerun can be explained from the file."""
    try:
        path = config.data_dir() / "autorun-log.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"matcher_version": MATCHER_VERSION, "steps": entries}), encoding="utf-8")
    except OSError:
        logger.exception("Could not write the card-match autorun log")


def _autorun_marker() -> Path:
    return config.data_dir() / "autorun.json"


def autorun_due(model: str = DEFAULT_MODEL) -> bool:
    try:
        marker = json.loads(_autorun_marker().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    return marker.get("matcher_version") != MATCHER_VERSION or marker.get("model") != model


def autorun_once(warmer=None, model: str = DEFAULT_MODEL, *, delay_seconds: float = 90) -> bool:
    """SCAN_MATCHER_AUTORUN=1 (nonprod only): once per matcher version. In the order of ``autorun_plan``: the OCR
    check, the real-photo benchmark and comparison (when at least ``AUTORUN_MIN_LABELLED`` scans are confirmed),
    filling the picture cache and building the indexes, then the synthetic benchmark and its short comparison.
    Returns whether a run was started."""
    if not config.autorun_enabled() or not autorun_due(model):
        return False

    def chain() -> None:
        time.sleep(delay_seconds)  # let the app finish starting
        from . import benchmark, index as index_module, variants
        from services import scan_trace

        enough = benchmark.count_labelled_traces(scan_trace.trace_root() or scan_trace.trace_storage_root()) >= AUTORUN_MIN_LABELLED
        try:
            ready = all(index_module.index_status(name).get("built") and index_module.index_status(name).get("count")
                        for name in (model, variants.ART_INDEX))
        except Exception:
            ready = False
        actions = {
            "index": lambda: start_index(model), "art-index": lambda: start_index(variants.ART_INDEX),
            "ocr-check": lambda: start_benchmark("ocr-check", model), "labelled": lambda: start_benchmark("labelled", model),
            "compare-labelled": lambda: start_benchmark("compare-labelled", model),
            "synthetic": lambda: start_benchmark("synthetic", model), "compare-synthetic": lambda: start_benchmark("compare-synthetic", model),
        }
        log: list[dict] = []
        for name in autorun_plan(indexes_ready=ready, enough_real=enough):
            began, clock = _now(), time.monotonic()
            if name == "warm-up":
                if warmer is not None:
                    warmer.start()
                    deadline = time.monotonic() + AUTORUN_WARMUP_WAIT_SECONDS
                    while warmer.is_running() and time.monotonic() < deadline:
                        time.sleep(10)
                log.append({"step": name, "started_at": began, "seconds": round(time.monotonic() - clock, 1)})
                _autorun_log(log)
                continue
            step = actions[name]
            started, _status = step()
            while not started:  # another job (a manual one) is running: wait our turn
                time.sleep(15)
                started, _status = step()
            jobs.wait()
            error = jobs.status().get("error")
            log.append({"step": name, "started_at": began, "seconds": round(time.monotonic() - clock, 1), "error": error})
            _autorun_log(log)
            if error:
                logger.error("Card-match autorun stopped: %s", error)
                return
        try:
            marker = _autorun_marker()
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(json.dumps({"matcher_version": MATCHER_VERSION, "model": model, "finished_at": _now(), "steps": log}), encoding="utf-8")
        except OSError:
            logger.exception("Could not write the card-match autorun marker")

    threading.Thread(target=chain, name="card-match-autorun", daemon=True).start()
    return True
