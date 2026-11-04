"""Shadow mode (docs/SCAN_RESEARCH.md section 3.8, Phase 2): run the picture matcher beside today's scanner.

With ``SCAN_MATCHER_SHADOW=1`` every stored scan photo from a trainer who shares scanner diagnostics goes
through the matcher once, in the background, right after upload, and the result is written next to that
scan's diagnostics trace (``scan_trace.record_shadow``). Nothing a trainer sees changes, and the real
recognition never waits for it: one worker thread, low priority, the matcher's own thread cap, and it
steps aside while an admin index or benchmark job is running. It does not need Ollama, so it also covers
scans waiting for the scanner.

This module also reads the traces back for the Scanner lab: how often the two paths agree and who was
right on the scans the trainer confirmed.
"""

from __future__ import annotations

import collections
import json
import logging
import statistics
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import MATCHER_VERSION, config
from .model_specs import DEFAULT_MODEL

logger = logging.getLogger(__name__)

MAX_QUEUED = 500  # a burst beyond this is dropped (and counted), not held in memory
SEEN_LIMIT = 5000
MAX_SIDE = 2048  # the stored review photo is already at most this large
IDLE_POLL_SECONDS = 5.0


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ── Getting ready ────────────────────────────────────────────────────────────

def default_matcher():
    """(matcher, None) when the model, the index and OCR are all there; (None, reason) otherwise."""
    from . import embed, index as index_module, pipeline

    model = DEFAULT_MODEL
    if not embed.model_available(model):
        return None, "model_missing"
    index = index_module.get_index(model)
    if index is None or len(index) == 0:
        return None, "index_not_built"
    try:
        import rapidocr_onnxruntime  # noqa: F401
    except ImportError:
        return None, "ocr_missing"
    try:
        from . import variants
        from .ocr import get_reader
        from database import SessionLocal

        options = variants.parse(variants.active_label())
        if variants.missing_indexes(options):  # an option whose index is not built yet runs without that part
            options = variants.Options(names=options.names, tta=options.tta)
        return variants.build_matcher(options, SessionLocal, ocr_reader=get_reader()), None
    except Exception as exc:  # a corrupt model file, ONNX Runtime missing, ...
        logger.warning("Shadow matcher not ready: %s", exc)
        return None, "model_error"


def _read_stored_photo(relative_path: str) -> bytes:
    """The same bytes the scan trace stores (and the labelled benchmark re-runs): the guide-frame crop made
    for recognition when there is one, else the stored photo. Reading the full photo instead gave the matcher
    a card much smaller in the frame, with the bottom-line text too small to read."""
    from services import scan_storage

    return scan_storage.read_recognition_image(relative_path)


def _read_full_photo(relative_path: str) -> bytes:
    """The full-resolution stored photo (up to 2048 px): what the text is read from, flattened at the card corners."""
    from services import scan_storage

    return scan_storage.resolve_scan_path(relative_path).read_bytes()


def store_text_card(user_id: int, job_id: int, item_id: int, result) -> None:
    """Keep the flat card the text was read from beside the shadow record (never raises)."""
    try:
        from services import scan_trace
        from .images import encode_jpeg

        if getattr(result, "text_card", None) is not None:
            scan_trace.record_shadow_card(user_id, job_id, item_id, encode_jpeg(result.text_card, 90))
    except Exception:
        logger.exception("Could not store the matcher's flat card")


def _trainer_consents(user_id: int) -> bool:
    from database import SessionLocal
    from services import scan_trace

    db = SessionLocal()
    try:
        return scan_trace.user_trace_enabled(db, user_id)
    finally:
        db.close()


def _shadow_payload(result, *, input_info: dict | None = None, matcher=None) -> dict:
    return {
        "schema_version": 1,
        "status": "ok",
        "created_at": _now(),
        "matcher_version": MATCHER_VERSION,
        "model": DEFAULT_MODEL,
        "outcome": result.status,
        "decision": result.decision,
        "unsure_reason": result.unsure_reason,
        "matches": result.matches,
        "ocr": result.ocr,
        "detection": result.detection,
        "timings_ms": result.timings_ms,
        # So a future difference from the benchmark is visible: what went in, and what was loaded.
        "input": input_info or {},
        "ocr_available": bool(getattr(matcher, "ocr_reader", None)) if matcher is not None else None,
        "index_count": len(matcher.index) if matcher is not None and getattr(matcher, "index", None) is not None else None,
    }


def _skipped_payload(reason: str) -> dict:
    return {
        "schema_version": 1, "status": "skipped", "reason": reason, "created_at": _now(),
        "matcher_version": MATCHER_VERSION, "model": DEFAULT_MODEL,
    }


# ── The background worker ────────────────────────────────────────────────────

class ShadowRunner:
    """One worker thread, one photo at a time, each photo once. The collaborators are injectable for tests."""

    def __init__(
        self,
        *,
        matcher_factory: Callable[[], tuple] = default_matcher,
        photo_reader: Callable[[str], bytes] = _read_stored_photo,
        full_photo_reader: Callable[[str], bytes] = _read_full_photo,
        consent_check: Callable[[int], bool] = _trainer_consents,
        busy_check: Callable[[], bool] | None = None,
        low_priority: bool = True,
    ) -> None:
        self._matcher_factory = matcher_factory
        self._photo_reader = photo_reader
        self._full_photo_reader = full_photo_reader
        self._consent_check = consent_check
        self._busy_check = busy_check
        self._low_priority = low_priority
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._queue: collections.deque = collections.deque()
        self._seen: collections.OrderedDict = collections.OrderedDict()
        self._thread: threading.Thread | None = None
        self._working = False
        self._counts: collections.Counter = collections.Counter()
        self._skipped: collections.Counter = collections.Counter()
        self._last_error: str | None = None

    # -- queueing --------------------------------------------------------------------------

    def submit(self, user_id: int, job_id: int, item_id: int, image_path: str) -> bool:
        """Queue one stored photo unless it was queued before. Never blocks and never raises."""
        key = (int(user_id), int(job_id), int(item_id))
        with self._lock:
            if key in self._seen:
                return False
            if len(self._queue) >= MAX_QUEUED:
                self._counts["dropped"] += 1
                return False
            self._seen[key] = True
            while len(self._seen) > SEEN_LIMIT:
                self._seen.popitem(last=False)
            self._queue.append((key, image_path))
            self._counts["queued"] += 1
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._loop, name="card-match-shadow", daemon=True)
                self._thread.start()
            self._wake.notify()
        return True

    def status(self) -> dict:
        with self._lock:
            return {
                "enabled": config.shadow_enabled(),
                "waiting": len(self._queue) + (1 if self._working else 0),
                "ran": self._counts["ran"], "skipped": dict(self._skipped), "dropped": self._counts["dropped"],
                "last_error": self._last_error,
            }

    def wait_idle(self, timeout: float = 10.0) -> bool:
        """Test helper: block until the queue is empty and nothing is running."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if not self._queue and not self._working:
                    return True
            time.sleep(0.01)
        return False

    # -- the worker --------------------------------------------------------------------------

    def _loop(self) -> None:
        if self._low_priority:
            config.lower_priority()
        config.apply_thread_caps()
        while True:
            with self._lock:
                while not self._queue:
                    if not self._wake.wait(timeout=300):
                        if not self._queue:
                            self._thread = None
                            return
                key, image_path = self._queue.popleft()
                self._working = True
            try:
                self._wait_for_admin_jobs()
                self._run_one(key, image_path)
            except Exception as exc:  # the shadow must never take anything else down
                logger.exception("Shadow run failed")
                with self._lock:
                    self._last_error = f"{type(exc).__name__}: {exc}"[:200]
            finally:
                with self._lock:
                    self._working = False

    def _wait_for_admin_jobs(self) -> None:
        """Step aside while an index build or benchmark runs, so the box is never doing both."""
        busy = self._busy_check
        if busy is None:
            from .jobs import jobs

            busy = jobs.is_running
        while busy():
            time.sleep(IDLE_POLL_SECONDS)

    def _skip(self, user_id: int, job_id: int, item_id: int, reason: str, *, record: bool = True) -> None:
        from services import scan_trace

        with self._lock:
            self._skipped[reason] += 1
        if record:
            scan_trace.record_shadow(user_id, job_id, item_id, _skipped_payload(reason))

    def _run_one(self, key: tuple[int, int, int], image_path: str) -> None:
        from services import scan_trace
        from .images import decode_rgb

        user_id, job_id, item_id = key
        if not self._consent_check(user_id):
            return  # the trainer switched diagnostics off after uploading: record nothing
        if scan_trace.has_shadow(user_id, job_id, item_id):
            return  # already done (before a restart)
        matcher, reason = self._matcher_factory()
        if matcher is None:
            self._skip(user_id, job_id, item_id, reason or "not_ready")
            return
        try:
            raw = self._photo_reader(image_path)
            photo = decode_rgb(raw, max_side=MAX_SIDE)
        except Exception:
            self._skip(user_id, job_id, item_id, "photo_unavailable")
            return
        try:  # the sharper photo only sharpens the text; without it the run reads the recognition image
            full_photo = decode_rgb(self._full_photo_reader(image_path), max_side=MAX_SIDE)
        except Exception:
            full_photo = None
        try:
            result = matcher.match(photo, full_photo=full_photo) if full_photo is not None else matcher.match(photo)
        except Exception as exc:
            logger.warning("Shadow match failed: %s", exc)
            self._skip(user_id, job_id, item_id, "match_failed")
            return
        input_info = {"bytes": len(raw), "width": int(photo.shape[1]), "height": int(photo.shape[0])}
        if scan_trace.record_shadow(user_id, job_id, item_id, _shadow_payload(result, input_info=input_info, matcher=matcher)):
            store_text_card(user_id, job_id, item_id, result)
            with self._lock:
                self._counts["ran"] += 1


runner = ShadowRunner()


def schedule_job(db, user_id: int, job) -> int:
    """Queue every photo of a freshly uploaded job. Cheap, never raises; 0 unless the flag is on and the
    trainer shares diagnostics (the same consent as the scan trace)."""
    if not config.shadow_enabled():
        return 0
    try:
        from models import ScanJobItem
        from services import scan_trace

        if not scan_trace.user_trace_enabled(db, user_id):
            return 0
        queued = 0
        rows = db.query(ScanJobItem.id, ScanJobItem.image_path).filter(ScanJobItem.job_id == job.id).order_by(ScanJobItem.position).all()
        for item_id, image_path in rows:
            if image_path and runner.submit(user_id, job.id, item_id, image_path):
                queued += 1
        return queued
    except Exception:
        logger.exception("Could not queue the shadow run")
        return 0


# ── Reading the comparison back ──────────────────────────────────────────────

def _pct(part: int, whole: int) -> float | None:
    return round(100 * part / whole, 1) if whole else None


def score_pairs(pairs: list[tuple[str, str | None, str | None]]) -> dict:
    """Matcher against the current (Ollama) path on the same confirmed scans.

    ``pairs`` holds ``(confirmed card, matcher's pick or None, current path's pick or None)``; a pick is None
    when that path did not decide. Where both decided and differ, says who was right.
    """
    matcher_decided = sum(1 for _t, m, _c in pairs if m)
    matcher_right = sum(1 for t, m, _c in pairs if m and m == t)
    current_decided = sum(1 for _t, _m, c in pairs if c)
    current_right = sum(1 for t, _m, c in pairs if c and c == t)
    both = [(t, m, c) for t, m, c in pairs if m and c]
    differ = [(t, m, c) for t, m, c in both if m != c]
    matcher_wins = sum(1 for t, m, c in differ if m == t)
    current_wins = sum(1 for t, m, c in differ if c == t)
    n = len(pairs)
    return {
        "n": n,
        "matcher": {"decided": matcher_decided, "right": matcher_right, "decided_pct": _pct(matcher_decided, n), "right_pct": _pct(matcher_right, matcher_decided)},
        "current": {"decided": current_decided, "right": current_right, "decided_pct": _pct(current_decided, n), "right_pct": _pct(current_right, current_decided)},
        "both_decided": len(both),
        "agree": len(both) - len(differ),
        "differ": len(differ),
        "differ_matcher_right": matcher_wins,
        "differ_current_right": current_wins,
        "differ_neither_right": len(differ) - matcher_wins - current_wins,
    }


def _name_in(rows: list[dict], card_id: str | None) -> str | None:
    return next((row.get("name") for row in rows if card_id and row.get("tcg_card_id") == card_id and row.get("name")), None)


def latest_traces(trace_dir: Path | None) -> list[dict]:
    """The newest trace of each scanned item that has a shadow result, newest first."""
    if trace_dir is None or not trace_dir.is_dir():
        return []
    newest: dict[tuple, dict] = {}
    for path in trace_dir.glob("user-*/*/job*-item*-*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data.get("shadow"), dict):
            continue
        key = (path.parent.parent.name, data.get("job_id"), data.get("item_id"))
        if key not in newest or str(data.get("created_at")) > str(newest[key].get("created_at")):
            newest[key] = data
    return sorted(newest.values(), key=lambda data: str(data.get("created_at")), reverse=True)


def confirmed_traces(trace_dir: Path | None) -> list[dict]:
    """The newest trace of each scan the trainer confirmed a card for (with or without a shadow result)."""
    if trace_dir is None or not trace_dir.is_dir():
        return []
    newest: dict[tuple, dict] = {}
    for path in trace_dir.glob("user-*/*/*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not data.get("ground_truth"):
            continue
        key = (path.parent.parent.name, data.get("job_id"), data.get("item_id")) if data.get("job_id") and data.get("item_id") else (path.name,)
        if key not in newest or str(data.get("created_at")) > str(newest[key].get("created_at")):
            newest[key] = data
    return list(newest.values())


def how_confirmed(trace_dir: Path | None) -> dict:
    """How the confirmed cards were chosen, and what that means for each path.

    ``counts`` has one number per way of choosing (see ``scan_trace.CONFIRMATION_SOURCES``). A card the
    trainer had to find by search (``manual_search`` / ``manual_no_result``) was offered by no scanner, so it
    counts as a miss for the matcher and for Ollama alike: ``manual`` says how many there were and how often
    each path at least had the card among its candidates (always 0 for the picture matcher and Ollama by
    definition of a manual pick; kept so the lab can show it next to the other numbers).
    """
    from services.scan_trace import CONFIRMATION_SOURCES

    counts = {source: 0 for source in CONFIRMATION_SOURCES}
    unlabelled = 0
    for data in confirmed_traces(trace_dir):
        source = (data.get("confirmation") or {}).get("source")
        if source in counts:
            counts[source] += 1
        else:
            unlabelled += 1  # confirmed before the source was recorded
    manual = counts["manual_search"] + counts["manual_no_result"]
    total = sum(counts.values())
    return {
        "counts": counts,
        "total": total,
        "unlabelled": unlabelled,
        "manual": manual,
        "manual_pct": _pct(manual, total),
    }


def shadow_report(trace_dir: Path | None, *, examples: int = 8) -> dict:
    """What the Scanner lab shows: the two paths side by side on the scans recorded in shadow mode."""
    traces = latest_traces(trace_dir)
    ran = [d for d in traces if d["shadow"].get("status") == "ok"]
    skipped = collections.Counter(d["shadow"].get("reason") or "unknown" for d in traces if d["shadow"].get("status") == "skipped")
    agreement = collections.Counter(d["shadow"].get("agreement") for d in ran)
    both = agreement["same"] + agreement["different"]
    decided = [d for d in ran if (d["shadow"].get("decision") or {}).get("tcg_card_id")]
    totals = [d["shadow"]["timings_ms"]["total"] for d in ran if (d["shadow"].get("timings_ms") or {}).get("total") is not None]
    # Only English cards are a fair test: the index holds nothing else.
    confirmed = [d for d in ran if d.get("ground_truth") and d["shadow"].get("truth_lang") in (None, "en")]
    pairs = [
        (d["ground_truth"], (d["shadow"].get("decision") or {}).get("tcg_card_id"), (d.get("decision") or {}).get("selected"))
        for d in confirmed
    ]
    confirmed_scores = score_pairs(pairs)
    decided_confirmed = [d for d in confirmed if (d["shadow"].get("decision") or {}).get("tcg_card_id")]
    disagreements = []
    for d in ran:
        shadow = d["shadow"]
        if shadow.get("agreement") != "different":
            continue
        matcher_pick = shadow["decision"]["tcg_card_id"]
        current_pick = shadow.get("current_selected")
        truth = d.get("ground_truth")
        disagreements.append({
            "matcher": _name_in(shadow.get("matches") or [], matcher_pick) or matcher_pick,
            "current": _name_in(d.get("candidates") or [], current_pick) or current_pick,
            "confirmed": (_name_in(d.get("candidates") or [], truth) or _name_in(shadow.get("matches") or [], truth) or truth) if truth else None,
            "right": None if not truth else ("matcher" if matcher_pick == truth else "current" if current_pick == truth else "neither"),
        })
        if len(disagreements) >= examples:
            break
    return {
        "scans": len(traces),
        "compared": len(ran),
        "skipped": dict(skipped),
        "agreement": {
            "same": agreement["same"], "different": agreement["different"], "matcher_only": agreement["matcher_only"],
            "current_only": agreement["current_only"], "neither": agreement["neither"],
            "both_decided": both, "agree_pct": _pct(agreement["same"], both),
        },
        "matcher_decided": len(decided),
        "matcher_decided_pct": _pct(len(decided), len(ran)),
        "confirmed": {**confirmed_scores, "matcher_decided_confirmed": len(decided_confirmed)},
        "median_ms": round(statistics.median(totals), 1) if totals else None,
        "disagreements": disagreements,
        "how_confirmed": how_confirmed(trace_dir),
        "matcher_version": MATCHER_VERSION,
    }
