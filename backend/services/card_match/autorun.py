"""The nonprod autorun: Scanner lab runs every test by itself after a deploy that changed what the tests measure (docs/CARD_MATCH.md, "The autorun").

``SCAN_MATCHER_AUTORUN=1`` (nonprod only; prod never sets it, so nothing here can run there) makes the server, shortly after startup, compute a
*plan fingerprint* and run the chain when it differs from the one in ``autorun.json``. The admin switch "Run the tests by itself after each deploy"
(a server setting, default on where the variable is set) can turn that off; the "Run all tests now" button runs the chain at once.

The fingerprint hashes: the matcher version, every compare row's signature (``variants.row_signature``: the matcher version, each option word with
its ``OPTION_VERSIONS`` number, the custom model's id and calibration time), the newest custom model's id and calibration time, the build times of
the indexes the rows need, and the scan-set fingerprint. So a deploy that adds or changes a row, brings new confirmed scans or a new or
recalibrated custom model runs the tests; a deploy that changes none of these runs nothing.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config, custom_models
from .jobs import AUTORUN_WARMUP_WAIT_SECONDS, jobs, start_benchmark, start_calibration, start_index
from .model_specs import DEFAULT_MODEL

logger = logging.getLogger(__name__)

MIN_LABELLED = 100  # confirmed traces needed before the real-photo steps run by themselves
SETTING_KEY = "scan_matcher_autorun"
TRUE = {"1", "true", "yes", "on"}
UNAVAILABLE = "The autorun is not available on this server"
FORCED = "forced"  # the "why" of every row when "Run all tests now" is pressed

REAL_STEPS = ("ocr-check", "labelled", "compare-labelled")
SYNTHETIC_STEPS = ("synthetic", "compare-synthetic")


def _version() -> str:
    from . import MATCHER_VERSION  # read at call time

    return str(MATCHER_VERSION)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ── The admin switch ──────────────────────────────────────────────────────────

def available() -> bool:
    """Only where ``SCAN_MATCHER_AUTORUN`` is set (nonprod). On prod this is False and the switch, the button and the API refuse."""
    return config.autorun_enabled()


def switch_on(db=None) -> bool:
    """The admin's choice (a ``Setting`` row, like Matcher only), else on where the environment variable is set. Always False where the autorun is not available."""
    if not available():
        return False
    own = db is None
    try:
        if own:
            from database import SessionLocal

            db = SessionLocal()
        from models import Setting

        row = db.query(Setting).filter(Setting.key == SETTING_KEY).first()
        return True if row is None else str(row.value).strip().lower() in TRUE
    except Exception:
        logger.exception("Could not read the autorun switch")
        return True
    finally:
        if own and db is not None:
            db.close()


def set_switch(db, value: bool, actor=None, request=None) -> bool:
    """Store the switch and audit a real change. Raises ``PermissionError`` where the autorun is not available."""
    from models import Setting
    from services.audit import record_audit

    if not available():
        raise PermissionError(UNAVAILABLE)
    before = switch_on(db)
    row = db.query(Setting).filter(Setting.key == SETTING_KEY).first()
    text = "true" if value else "false"
    if row:
        row.value = text
    else:
        db.add(Setting(key=SETTING_KEY, value=text))
    if bool(value) != before:
        record_audit(db, "scanner.matcher_autorun.updated", request=request, actor=actor, target_type="scanner",
                     details={"matcher_autorun": {"before": before, "after": bool(value)}}, commit=False)
    db.commit()
    return bool(value)


# ── The plan fingerprint ──────────────────────────────────────────────────────

def all_labels() -> list[str]:
    from . import variants

    return list(dict.fromkeys((*variants.COMPARE_LABELS, *variants.SYNTHETIC_COMPARE_LABELS)))


def needed_index_names(data_dir: Path | None = None) -> list[str]:
    """The indexes the default model and every row read."""
    from . import variants

    names = {DEFAULT_MODEL, variants.ART_INDEX}
    for label in all_labels():
        names.update(variants.needed_indexes(variants.parse(label), data_dir))
    return sorted(names)


def scan_set_fingerprint(data_dir: Path | None = None) -> str | None:
    """The fingerprint ``run_compare`` saves in its report (None while the default index is missing or no scans can be read)."""
    from . import benchmark, index as index_module
    from services import scan_trace

    try:
        index = index_module.get_index(DEFAULT_MODEL, data_dir)
        if index is None:
            return None
        return benchmark.scan_fingerprint(benchmark.eligible_traces(index, scan_trace.trace_root() or scan_trace.trace_storage_root()))
    except Exception:
        logger.exception("Card-match autorun: could not fingerprint the scan set")
        return None


def plan_inputs(scan_fp: str | None, data_dir: Path | None = None) -> dict:
    from . import index as index_module, variants

    entry = custom_models.newest(data_dir)
    return {
        "matcher_version": _version(),
        "rows": {label: variants.row_signature(label, data_dir) for label in all_labels()},
        "custom": {"id": entry["id"] if entry else None, "calibrated_at": ((entry or {}).get("calibration") or {}).get("at")},
        "indexes": {name: index_module.index_status(name, data_dir).get("built_at") for name in needed_index_names(data_dir)},
        "scans": scan_fp,
    }


def plan_fingerprint(scan_fp: str | None, data_dir: Path | None = None) -> str:
    return hashlib.sha256(json.dumps(plan_inputs(scan_fp, data_dir), sort_keys=True).encode("utf-8")).hexdigest()


def marker_path() -> Path:
    return config.data_dir() / "autorun.json"


def log_path() -> Path:
    return config.data_dir() / "autorun-log.json"


def read_marker() -> dict:
    try:
        value = json.loads(marker_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def read_log() -> dict | None:
    try:
        value = json.loads(log_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def autorun_due(model: str = DEFAULT_MODEL, data_dir: Path | None = None) -> bool:
    """Whether the plan fingerprint differs from the marker's (a missing marker, or one with no fingerprint, always differs)."""
    stored = read_marker().get("plan_fingerprint")
    return not stored or stored != plan_fingerprint(scan_set_fingerprint(data_dir), data_dir)


# ── Which steps run ───────────────────────────────────────────────────────────

def index_steps(data_dir: Path | None = None) -> dict[str, str]:
    """step name -> index name: the default model's two indexes and the newest custom model's two (when a custom model exists)."""
    from . import variants

    steps = {"index": DEFAULT_MODEL, "art-index": variants.ART_INDEX}
    entry = custom_models.newest(data_dir)
    if entry:
        names = custom_models.index_names(entry["id"])
        steps["custom-index"] = names["whole"]
        steps["custom-art-index"] = names["art"]
    return steps


def calibration_due(entry: dict | None, tuned_fingerprint: str | None) -> bool:
    """The newest custom model has no calibration, or its calibration is older than the model, the matcher version or the scan set it was made on."""
    if not entry:
        return False
    calibration = entry.get("calibration") or {}
    if not calibration.get("thresholds"):
        return True
    if str(calibration.get("at") or "") < str(entry.get("uploaded_at") or ""):
        return True
    if str(calibration.get("matcher_version")) != _version():
        return True
    return tuned_fingerprint is not None and calibration.get("scan_fingerprint") != tuned_fingerprint


def tuned_fingerprint(model_id: str, data_dir: Path | None = None) -> str | None:
    """The fingerprint of the Tuned scans a calibration of ``model_id`` would use (None when an index is not built yet)."""
    from . import benchmark, calibration, index as index_module
    from services import scan_trace

    try:
        default, custom = index_module.get_index(DEFAULT_MODEL, data_dir), index_module.get_index(model_id, data_dir)
        if default is None or custom is None:
            return None
        return benchmark.scan_fingerprint(calibration.tuned_traces(default.card_ids, custom.card_ids, scan_trace.trace_root() or scan_trace.trace_storage_root()))
    except Exception:
        logger.exception("Card-match autorun: could not fingerprint the Tuned scans")
        return None


def choose_steps(*, missing: list[str], calibrate: bool, version_changed: bool, scans_changed: bool, enough_real: bool, force: bool = False) -> list[str]:
    """The chain's steps in order. What the owner decides from comes first.

    (a) ``warm-up`` and the index builds, for the indexes in ``missing`` (step names); (b) ``calibrate``; (c) ``ocr-check`` only when the matcher
    version or the scan set changed; (d) ``labelled`` (writes Misses) and (e) ``compare-labelled``, with at least ``MIN_LABELLED`` confirmed scans;
    (f) the synthetic runs, only when the matcher version changed. ``force`` ("Run all tests now") treats everything as changed."""
    steps: list[str] = []
    if missing:
        steps.append("warm-up")
        steps.extend(name for name in ("index", "art-index", "custom-index", "custom-art-index") if name in missing)
    if calibrate or force:
        steps.append("calibrate")
    if enough_real:
        if version_changed or scans_changed or force:
            steps.append("ocr-check")
        steps.extend(("labelled", "compare-labelled"))
    if version_changed or force:
        steps.extend(SYNTHETIC_STEPS)
    return steps


def depends_on(step: str) -> tuple[str, ...]:
    """The index steps whose failure skips ``step``."""
    if step == "calibrate":
        return ("index", "art-index", "custom-index", "custom-art-index")
    if step in REAL_STEPS + SYNTHETIC_STEPS:
        return ("index",)
    return ()


# ── Running ───────────────────────────────────────────────────────────────────

_state_lock = threading.Lock()
_state: dict = {"running": False, "trigger": None, "step": None, "started_at": None}


def state() -> dict:
    with _state_lock:
        return dict(_state)


def _set_state(**changes) -> None:
    with _state_lock:
        _state.update(changes)


def _write_log(log: dict) -> None:
    try:
        path = log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(log, default=str), encoding="utf-8")
    except OSError:
        logger.exception("Could not write the card-match autorun log")


def _audit_calibration(model_id: str):
    def audit(stored: dict) -> None:
        try:
            from database import SessionLocal
            from services.audit import record_audit

            db = SessionLocal()
            try:
                record_audit(db, "card_match.model_calibrated", actor=None, target_type="card_match_model", target_id=model_id,
                             details={"actor": "autorun", "scans": stored["scans"], "thresholds": stored["thresholds"], "default": stored["default"]})
            finally:
                db.close()
        except Exception:
            logger.exception("Could not audit the autorun's calibration")
    return audit


def run_chain(*, trigger: str, warmer=None, model: str = DEFAULT_MODEL, force: bool = False, data_dir: Path | None = None) -> dict | None:
    """Work out the steps and run them. A failing step is logged and the chain goes on (a failed index build skips the steps that need that
    index; a refused calibration leaves the ``calibrated`` row skipped with its reason). Returns the log, or None when the user stopped it.
    The marker is written at the end with the fingerprint of the state the chain left behind."""
    from . import benchmark, index as index_module, variants
    from services import scan_trace

    marker = read_marker()
    jobs._stop.clear()  # a Stop pressed long ago must not end this run before it starts
    started = _now()
    _set_state(running=True, trigger=trigger, step=None, started_at=started)
    try:
        scan_fp = scan_set_fingerprint(data_dir)
        steps_map = index_steps(data_dir)
        missing = [name for name, index_name in steps_map.items()
                   if not (index_module.index_status(index_name, data_dir).get("built") and index_module.index_status(index_name, data_dir).get("count"))]
        entry = custom_models.newest(data_dir)
        calibrate = bool(entry) and calibration_due(entry, tuned_fingerprint(entry["id"], data_dir) if entry else None)
        enough = benchmark.count_labelled_traces(scan_trace.trace_root() or scan_trace.trace_storage_root()) >= MIN_LABELLED
        steps = choose_steps(
            missing=missing, calibrate=calibrate or (force and bool(entry)), force=force, enough_real=enough,
            version_changed=marker.get("matcher_version") != _version(), scans_changed=marker.get("scan_fingerprint") != scan_fp,
        )
        if not entry and "calibrate" in steps:
            steps.remove("calibrate")
        log = {"matcher_version": _version(), "trigger": trigger, "started_at": started, "finished_at": None, "steps": [], "planned": steps}
        failed: set[str] = set()

        def finish_step(record: dict) -> None:
            log["steps"].append(record)
            _write_log(log)

        for name in steps:
            if jobs._stop.is_set():
                break
            began, clock = _now(), time.monotonic()
            _set_state(step=name)
            blocked = [dep for dep in depends_on(name) if dep in failed]
            if blocked:
                finish_step({"step": name, "started_at": began, "seconds": 0, "skipped": f"needs {', '.join(blocked)}, which failed"})
                continue
            if name == "warm-up":
                if warmer is not None:
                    warmer.start()
                    deadline = time.monotonic() + AUTORUN_WARMUP_WAIT_SECONDS
                    while warmer.is_running() and time.monotonic() < deadline:
                        time.sleep(10)
                finish_step({"step": name, "started_at": began, "seconds": round(time.monotonic() - clock, 1)})
                continue
            rows = None
            if name == "compare-labelled" or name == "compare-synthetic":
                kind = name.split("-", 1)[1]
                plan = benchmark.plan_rows(kind, scan_set_fingerprint(data_dir), data_dir)
                if force:  # "Run all tests now": every row
                    plan = {label: FORCED for label in (variants.SYNTHETIC_COMPARE_LABELS if kind == "synthetic" else variants.COMPARE_LABELS)}
                rows = [{"label": label, "why": why} for label, why in plan.items()]
                action = (lambda plan=plan, name=name: start_benchmark(name, model, list(plan), dict(plan)))
            elif name in steps_map:
                action = (lambda index_name=steps_map[name]: start_index(index_name))
            elif name == "calibrate":
                action = (lambda: start_calibration(entry["id"], _audit_calibration(entry["id"])))
            else:
                action = (lambda name=name: start_benchmark(name, model))
            began_job, _status = action()
            while not began_job:  # another job (a manual one) is running: wait our turn
                if jobs._stop.is_set():
                    break
                time.sleep(15)
                began_job, _status = action()
            if not began_job:
                break
            jobs.wait()
            error = jobs.status().get("error")
            if jobs._stop.is_set():
                break
            record = {"step": name, "started_at": began, "seconds": round(time.monotonic() - clock, 1), "error": error}
            if rows is not None:
                record["rows"] = rows
            if error:
                failed.add(name)
                logger.error("Card-match autorun step %s failed: %s", name, error)
            finish_step(record)
        stopped = jobs._stop.is_set()
        log["finished_at"] = _now()
        log["stopped"] = stopped
        _write_log(log)
        if stopped:
            return None
        final_scans = scan_set_fingerprint(data_dir)
        try:
            marker_path().parent.mkdir(parents=True, exist_ok=True)
            marker_path().write_text(json.dumps({
                "matcher_version": _version(), "model": model, "finished_at": log["finished_at"], "trigger": trigger,
                "plan_fingerprint": plan_fingerprint(final_scans, data_dir), "scan_fingerprint": final_scans,
                "steps": [{key: step.get(key) for key in ("step", "seconds", "error", "skipped")} for step in log["steps"]],
            }), encoding="utf-8")
        except OSError:
            logger.exception("Could not write the card-match autorun marker")
        return log
    except Exception:
        logger.exception("Card-match autorun chain crashed")
        return None
    finally:
        _set_state(running=False, step=None)


def autorun_once(warmer=None, model: str = DEFAULT_MODEL, *, delay_seconds: float = 90) -> bool:
    """SCAN_MATCHER_AUTORUN=1 (nonprod only). After ``delay_seconds`` (the app finishes starting) the chain runs when the switch is on and the plan
    fingerprint differs from the marker's. Returns whether a check was scheduled (False where the autorun is not available)."""
    if not available():
        return False

    def check_then_run() -> None:
        time.sleep(delay_seconds)
        if not switch_on():
            logger.info("Card-match autorun: switched off, nothing runs")
            return
        if not autorun_due(model):
            logger.info("Card-match autorun: nothing changed since the last run")
            return
        run_chain(trigger="deploy", warmer=warmer, model=model)

    threading.Thread(target=check_then_run, name="card-match-autorun", daemon=True).start()
    return True


def start_run_all(warmer=None, model: str = DEFAULT_MODEL) -> tuple[bool, str | None]:
    """"Run all tests now": the same chain at once, ignoring the fingerprint. ``(started, refusal)``. Raises ``PermissionError`` where the autorun
    is not available (prod). Refused while a job or the chain is running."""
    if not available():
        raise PermissionError(UNAVAILABLE)
    with _state_lock:
        if _state["running"] or jobs.is_running():
            return False, "A job is running; wait for it or stop it first"
        _state.update(running=True, trigger="manual", step=None, started_at=_now())
    threading.Thread(target=lambda: run_chain(trigger="manual", warmer=warmer, model=model, force=True), name="card-match-autorun-manual", daemon=True).start()
    return True, None


def info(db=None) -> dict:
    """For Scanner lab: where the autorun exists, the switch, what runs now, the last run's log."""
    if not available():
        return {"available": False}
    return {"available": True, "enabled": switch_on(db), "state": state(), "log": read_log(), "marker": {k: read_marker().get(k) for k in ("finished_at", "trigger")}}
