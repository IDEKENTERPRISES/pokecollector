"""Admin correction of a scan's confirmed card ("The scanner was right" in Scanner lab).

A trainer's confirmed card is the trace's ``ground_truth``. When the trainer got it wrong, an admin can set it to another
card. Nothing is lost: the old value is kept in ``ground_truth_corrections`` (newest last), so the correction can be undone.

Only traces under this server's own writable trace root can change. A trace in a read-only root (prod's, mounted on nonprod)
is refused with the reason. The scan photo is never touched or copied.

A scan can have several attempts (one trace file each, same user, job and item); all of them are corrected together,
the way ``scan_trace.record_ground_truth`` labels them.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from services import scan_trace, trace_sources

logger = logging.getLogger(__name__)

KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,80}$")  # the Misses key: the trace file name, made safe, at most 80 characters
CORRECTIONS = "ground_truth_corrections"
UNDONE = "ground_truth_corrections_undone"
REASON_MAX = 200


class CorrectionError(Exception):
    status = 400


class TraceNotFound(CorrectionError):
    status = 404


class ReadOnlyTrace(CorrectionError):
    status = 409


class NothingToDo(CorrectionError):
    status = 409


def trace_key(path: Path, source: str = trace_sources.LOCAL) -> str:
    """The key Misses uses for a trace (see ``misses.MissCollector.add``)."""
    name = path.stem if source == trace_sources.LOCAL else f"{source}-{path.stem}"
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in name)[:80]


def _find_in(root: Path | None, key: str) -> Path | None:
    if root is None:
        return None
    try:
        # The key holds only letters, digits, "-" and "_", so it is never a glob pattern or a path.
        # (A 80-character key may be a cut-off name, so it also matches longer file names.)
        pattern = f"user-*/*/{key}*.json" if len(key) >= 80 else f"user-*/*/{key}.json"
        for path in sorted(root.glob(pattern)):
            if path.is_file() and not path.is_symlink() and trace_key(path) == key:
                return path
    except OSError:
        return None
    return None


def find_trace(key: str) -> Path:
    """The writable local trace of a Misses key. Raises ``TraceNotFound`` / ``ReadOnlyTrace``."""
    if not isinstance(key, str) or not KEY_PATTERN.match(key):
        raise TraceNotFound("No such scan")
    for root in scan_trace._cleanup_roots():
        path = _find_in(root, key)
        if path is not None:
            trace_sources.ensure_writable(path)
            return path
    for root in trace_sources.readonly_roots():
        prefix = f"{root.label}-"
        if key.startswith(prefix) and _find_named(root.path, key[len(prefix):], root.label, key):
            raise ReadOnlyTrace(
                f"This scan comes from the read-only source '{root.label}'. It can only be corrected on the server that owns it."
            )
    raise TraceNotFound("No such scan")


def _find_named(root: Path, stem: str, label: str, key: str) -> bool:
    try:
        return any(trace_key(path, label) == key for path in root.glob(f"user-*/*/{stem[:80]}*.json"))
    except OSError:
        return False


def _attempts(path: Path, data: dict) -> list[Path]:
    """Every attempt of the same scan in the same user folder (the file itself when it has no job and item)."""
    job, item = data.get("job_id"), data.get("item_id")
    if not job or not item:
        return [path]
    user_dir = path.parent.parent
    found = sorted(user_dir.glob(f"*/job{scan_trace._safe(job)}-item{scan_trace._safe(item)}-*.json"))
    return found if path in found else [path, *found]


def _read(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("not a trace")
    return data


def _write(path: Path, data: dict) -> None:
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        scan_trace._write_private(temp, json.dumps(data, indent=2, ensure_ascii=False, default=str))
        temp.replace(path)
    except Exception:
        temp.unlink(missing_ok=True)
        raise


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _relabel(data: dict, card_id: str, confirmation: dict | None) -> None:
    data["ground_truth"] = card_id
    if confirmation is not None:
        data["confirmation"] = confirmation
    scan_trace.rescore_label(data, card_id)


def correct(key: str, card_id: str, *, by_user_id: int, by_username: str | None, reason: str = "") -> dict:
    """Set the confirmed card of the scan behind ``key`` to ``card_id`` (the caller has checked it is a real card)."""
    path = find_trace(key)
    reason = (reason or "").strip()[:REASON_MAX]
    changed: list[tuple[Path, dict]] = []
    old = None
    with scan_trace._TRACE_LOCK:
        first = _read(path)
        old = first.get("ground_truth")
        if not old:
            raise NothingToDo("This scan has no confirmed card to correct.")
        if old == card_id:
            raise NothingToDo("The confirmed card is already that card.")
        stamp = _now()
        for attempt in _attempts(path, first):
            trace_sources.ensure_writable(attempt)
            data = _read(attempt)
            if not data.get("ground_truth"):
                continue
            before = data.get("ground_truth")
            confirmation = dict(data.get("confirmation") or {})
            entry = {
                "from": before, "to": card_id, "by_user_id": by_user_id, "by_username": by_username, "at": stamp, "reason": reason,
                "from_confirmation": data.get("confirmation"),
            }
            data.setdefault(CORRECTIONS, []).append(entry)
            confirmation.update({
                "source": confirmation.get("source") if str(confirmation.get("source") or "").startswith("manual")
                else scan_trace.classify_confirmation(data, card_id),
                "lang": "en", "card_id": card_id, "corrected": True,
            })
            _relabel(data, card_id, confirmation)
            changed.append((attempt, data))
        for attempt, data in changed:
            _write(attempt, data)
    return {"key": key, "from": old, "to": card_id, "attempts": len(changed), "correction": current_correction(changed[0][1])}


def undo(key: str, *, by_user_id: int, by_username: str | None) -> dict:
    """Put back the card the last correction replaced. Raises ``NothingToDo`` when the scan was not corrected."""
    path = find_trace(key)
    changed: list[tuple[Path, dict]] = []
    restored_from = restored_to = None
    with scan_trace._TRACE_LOCK:
        first = _read(path)
        for attempt in _attempts(path, first):
            trace_sources.ensure_writable(attempt)
            data = _read(attempt)
            corrections = data.get(CORRECTIONS) or []
            if not corrections:
                continue
            entry = corrections.pop()
            data[CORRECTIONS] = corrections
            if not corrections:
                data.pop(CORRECTIONS, None)
            data.setdefault(UNDONE, []).append({**entry, "undone_by_user_id": by_user_id, "undone_by_username": by_username, "undone_at": _now()})
            restored_from, restored_to = data.get("ground_truth"), entry["from"]
            confirmation = entry.get("from_confirmation")
            if confirmation is None:
                data.pop("confirmation", None)
            _relabel(data, restored_to, confirmation if isinstance(confirmation, dict) else None)
            changed.append((attempt, data))
        if not changed:
            raise NothingToDo("This scan has not been corrected.")
        for attempt, data in changed:
            _write(attempt, data)
    return {"key": key, "from": restored_from, "to": restored_to, "attempts": len(changed), "correction": current_correction(changed[0][1])}


def current_correction(data: dict) -> dict | None:
    """The correction now in force on a trace (what the lab shows), or None."""
    corrections = data.get(CORRECTIONS) or []
    if not corrections:
        return None
    last = corrections[-1]
    return {k: last.get(k) for k in ("from", "to", "by_user_id", "by_username", "at", "reason")}


def corrections_overview(root: Path | None) -> dict:
    """Every corrected scan under this server's own trace root: ``{"by_key": {key: correction}, "scans": n}``.
    Reads only; a file that cannot be read is skipped."""
    by_key: dict[str, dict] = {}
    scans: set = set()
    if root is None:
        return {"by_key": by_key, "scans": 0}
    try:
        files = sorted(root.glob("user-*/*/*.json"))
    except OSError:
        return {"by_key": by_key, "scans": 0}
    for path in files:
        try:
            raw = path.read_text(encoding="utf-8")
            if CORRECTIONS not in raw:  # cheap test before parsing every trace
                continue
            data = json.loads(raw)
        except (OSError, ValueError):
            continue
        correction = current_correction(data) if isinstance(data, dict) else None
        if not correction:
            continue
        by_key[trace_key(path)] = correction
        scans.add((data.get("user_id"), data.get("job_id"), data.get("item_id")) if data.get("job_id") else path.name)
    return {"by_key": by_key, "scans": len(scans)}
