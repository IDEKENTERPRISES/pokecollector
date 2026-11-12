"""Phone speed test (step 2): what an admin's iPhone measured, kept one folder per run.

``<card-match data>/phone-speed/<run id>/result.json`` (timings, device facts, what the phone computed for the photo, and
later the server's own answer for the same photo) and, when the photo was taken or picked on the test page,
``photo.jpg`` (sanitised through ``scan_storage.sanitize_image_bytes`` like every scan upload). The built-in sample is never
uploaded. Photos live under the scan-diagnostics rules: kept for ``SCAN_TRACE_KEEP_DAYS`` when it is set (nothing extra
otherwise), shown only through the admin endpoints, never downloadable or exportable; an admin can delete a run.

The JSON holds numbers, booleans and short strings only (no pixels besides the one stored photo).
"""

from __future__ import annotations

import datetime
import json
import logging
import math
import os
import re
import secrets
import shutil
import tempfile
import threading
from pathlib import Path

from . import MATCHER_VERSION, config

logger = logging.getLogger(__name__)

DIR = "phone-speed"
RESULT = "result.json"
PHOTO = "photo.jpg"
KEEP = 100  # a safety cap on stored runs (each may hold a photo); the day limit is SCAN_TRACE_KEEP_DAYS
MAX_JSON_BYTES = 32768
MAX_TIMINGS = 80
MAX_DEVICE_FIELDS = 24
MAX_STRING = 200
MAX_TOP = 20
MAX_OCR_LINES = 20
NAME = re.compile(r"^[A-Za-z0-9_.\-]{1,48}$")
CARD_ID = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")
RUN_ID = re.compile(r"^\d{8}T\d{12}-[0-9a-f]{8}$")
_lock = threading.RLock()
_compare_lock = threading.Lock()  # one server comparison at a time: each loads the matcher and reads text


class SpeedRunError(ValueError):
    """The posted run is not a small set of numbers and device facts."""


def root(data_dir: Path | None = None) -> Path:
    return (data_dir or config.data_dir()) / DIR


def run_dir(run_id: str, data_dir: Path | None = None) -> Path | None:
    """The folder of a run, only for a well-formed id of an existing run (no path ever comes from the client)."""
    if not isinstance(run_id, str) or not RUN_ID.match(run_id):
        return None
    folder = root(data_dir) / run_id
    return folder if folder.is_dir() and not folder.is_symlink() else None


def _number(value, where: str):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SpeedRunError(f"{where} must be a number")
    if not math.isfinite(value) or abs(value) > 1e9:
        raise SpeedRunError(f"{where} is out of range")
    return float(value) if isinstance(value, float) else int(value)


def _clean_answer(answer) -> dict:
    """What the phone computed for the photo: per backend the top-20 whole-card and artwork picks, and OCR text lines."""
    if not isinstance(answer, dict) or set(answer) - {"topk", "ocr_lines"}:
        raise SpeedRunError("answer must hold topk and ocr_lines only")
    out: dict = {}
    topk = answer.get("topk", {})
    if not isinstance(topk, dict) or len(topk) > 4:
        raise SpeedRunError("topk must be a small object")
    out["topk"] = {}
    for backend, kinds in topk.items():
        if not isinstance(backend, str) or not NAME.match(backend) or not isinstance(kinds, dict) or set(kinds) - {"whole", "art"}:
            raise SpeedRunError("Bad topk entry")
        out["topk"][backend] = {}
        for kind, picks in kinds.items():
            if not isinstance(picks, list) or len(picks) > MAX_TOP:
                raise SpeedRunError("A top list holds at most 20 cards")
            rows = []
            for pick in picks:
                if not isinstance(pick, list) or len(pick) != 2 or not isinstance(pick[0], str) or not CARD_ID.match(pick[0]):
                    raise SpeedRunError("A pick is [card id, similarity]")
                score = _number(pick[1], "similarity")
                if abs(score) > 2:
                    raise SpeedRunError("similarity is out of range")
                rows.append([pick[0], round(float(score), 5)])
            out["topk"][backend][kind] = rows
    lines = answer.get("ocr_lines", [])
    if not isinstance(lines, list) or len(lines) > MAX_OCR_LINES or any(not isinstance(item, str) or len(item) > MAX_STRING for item in lines):
        raise SpeedRunError("ocr_lines must be a few short texts")
    out["ocr_lines"] = lines
    return out


def clean(body) -> dict:
    """Validate one run and return what is stored. Raises SpeedRunError."""
    if not isinstance(body, dict):
        raise SpeedRunError("A JSON object is needed")
    timings, device = body.get("timings"), body.get("device")
    crashed = body.get("crashed_step")
    if crashed is not None and (not isinstance(crashed, str) or not NAME.match(crashed)):
        raise SpeedRunError("crashed_step must be a step name")
    # A crashed page posts the steps that finished: none at all is possible, and is still a result.
    if not isinstance(timings, dict) or (not timings and crashed is None):
        raise SpeedRunError("timings must be an object of numbers")
    if len(timings) > MAX_TIMINGS:
        raise SpeedRunError("Too many timings")
    out_timings = {}
    for key, value in timings.items():
        if not isinstance(key, str) or not NAME.match(key):
            raise SpeedRunError("Bad timing name")
        out_timings[key] = None if value is None else _number(value, key)  # null = the step did not run or failed
    device = device if device is not None else {}
    if not isinstance(device, dict) or len(device) > MAX_DEVICE_FIELDS:
        raise SpeedRunError("device must be a small object")
    out_device = {}
    for key, value in device.items():
        if not isinstance(key, str) or not NAME.match(key):
            raise SpeedRunError("Bad device field name")
        if value is None or isinstance(value, bool):
            out_device[key] = value
        elif isinstance(value, (int, float)):
            out_device[key] = _number(value, key)
        elif isinstance(value, str):
            if len(value) > MAX_STRING:
                raise SpeedRunError(f"{key} is too long")
            out_device[key] = value
        else:
            raise SpeedRunError(f"{key} must be a number, a boolean or a short text")
    if set(body) - {"timings", "device", "answer", "crashed_step"}:
        raise SpeedRunError("Unknown field")
    out = {"timings": out_timings, "device": out_device}
    if crashed is not None:
        out["crashed_step"] = crashed
    if body.get("answer") is not None:
        out["answer"] = _clean_answer(body["answer"])
    return out


def _write_json(path: Path, data: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def new_run_id(now: datetime.datetime | None = None) -> str:
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return f"{now.strftime('%Y%m%dT%H%M%S%f')}-{secrets.token_hex(4)}"


def record(body, user: str, data_dir: Path | None = None, now: datetime.datetime | None = None, photo: bytes | None = None) -> dict:
    """Store one run (and its already sanitised JPEG, if any). Returns the stored run, with its ``id``."""
    run = clean(body)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    run["at"] = now.replace(microsecond=0).isoformat()
    run["by"] = str(user)[:64]
    run["matcher_version"] = MATCHER_VERSION
    run["id"] = new_run_id(now)
    run["has_photo"] = photo is not None
    run["server"] = {"status": "pending" if photo is not None else "no_photo"}
    with _lock:
        folder = root(data_dir) / run["id"]
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        if photo is not None:
            (folder / PHOTO).write_bytes(photo)
        _write_json(folder / RESULT, run)
        _trim(data_dir)
    return run


def _run_folders(data_dir: Path | None = None) -> list[Path]:
    base = root(data_dir)
    try:
        return sorted((p for p in base.iterdir() if RUN_ID.match(p.name) and p.is_dir() and not p.is_symlink()), key=lambda p: p.name)
    except OSError:
        return []


def _trim(data_dir: Path | None = None) -> None:
    for folder in _run_folders(data_dir)[:-KEEP]:
        shutil.rmtree(folder, ignore_errors=True)


def get(run_id: str, data_dir: Path | None = None) -> dict | None:
    folder = run_dir(run_id, data_dir)
    return _read_json(folder / RESULT) if folder else None


def _norm(card_id) -> str:
    """``sv1-1_en`` and ``sv1-1`` name the same printing: drop a trailing language suffix."""
    return re.sub(r"_[a-z]{2,3}$", "", str(card_id or ""))


def compare_summary(run: dict) -> dict | None:
    """Per server option set, whether the phone's and the server's answers agree for the stored photo.

    The phone's lists are the whole-card (and artwork) picture searches; the server's are its final ranking, which also
    uses the number and name reads. So top 1 can differ where the server's text reading helped: the phone's own lists
    are compared as they are."""
    phone = (run.get("answer") or {}).get("topk") or {}
    server = run.get("server") or {}
    out = {}
    for label_key in ("in_use", "phone8"):
        entry = server.get(label_key)
        if not isinstance(entry, dict) or entry.get("status") == "error" or not entry.get("top20"):
            continue
        server_ids = [_norm(item["id"]) for item in entry["top20"]]
        per_backend = {}
        for backend, kinds in phone.items():
            picks = kinds.get("whole") or []
            if not picks:
                continue
            phone_ids = [_norm(item[0]) for item in picks]
            per_backend[backend] = {
                "top1_agree": phone_ids[0] == server_ids[0],
                "phone_top1_in_server_top20": phone_ids[0] in server_ids,
                "server_top1_in_phone_top20": server_ids[0] in phone_ids,
                "overlap": len(set(phone_ids) & set(server_ids)),
            }
        if per_backend:
            out[label_key] = per_backend
    return out or None


def latest(count: int = 10, data_dir: Path | None = None) -> list[dict]:
    """The last ``count`` runs, newest first, with the phone/server agreement worked out."""
    runs = []
    for folder in reversed(_run_folders(data_dir)[-count:]):
        run = _read_json(folder / RESULT)
        if run is None:
            continue
        run["compare"] = compare_summary(run)
        runs.append(run)
    return runs


def photo_path(run_id: str, data_dir: Path | None = None) -> Path | None:
    folder = run_dir(run_id, data_dir)
    path = folder / PHOTO if folder else None
    return path if path and path.is_file() and not path.is_symlink() else None


def delete(run_id: str, data_dir: Path | None = None) -> bool:
    """Remove a run, its photo and its JSON."""
    with _lock:
        folder = run_dir(run_id, data_dir)
        if folder is None:
            return False
        shutil.rmtree(folder, ignore_errors=True)
        return True


def purge_old(keep_days: int | None = None, *, now: datetime.datetime | None = None, data_dir: Path | None = None) -> int:
    """Delete runs older than ``keep_days`` (default: SCAN_TRACE_KEEP_DAYS; unset = keep everything). Returns how many went."""
    if keep_days is None:
        from services import scan_trace

        keep_days = scan_trace.trace_keep_days()
    if not keep_days or keep_days <= 0:
        return 0
    now = now or datetime.datetime.now(datetime.timezone.utc)
    cutoff = now - datetime.timedelta(days=keep_days)
    removed = 0
    with _lock:
        for folder in _run_folders(data_dir):
            try:
                made = datetime.datetime.strptime(folder.name[:15], "%Y%m%dT%H%M%S").replace(tzinfo=datetime.timezone.utc)
            except ValueError:
                continue
            if made < cutoff:
                shutil.rmtree(folder, ignore_errors=True)
                removed += 1
    return removed


# -- the server's answer for the same photo ---------------------------------------------------------------------------


def _answer_of(result, label: str, milliseconds: float) -> dict:
    return {
        "status": "ok", "label": label, "ms": round(milliseconds),
        "outcome": result.status, "unsure_reason": result.unsure_reason,
        "decision": ({"id": result.decision.get("tcg_card_id"), "mechanism": result.decision.get("mechanism"), "similarity": round(float(result.decision.get("similarity") or 0), 4)}
                     if result.decision else None),
        "top20": [{"id": match.get("tcg_card_id"), "similarity": round(float(match.get("similarity") or 0), 4)} for match in (result.matches or [])[:MAX_TOP]],
    }


def default_matcher(label: str):
    """The server's matcher for an option label; raises RuntimeError when its indexes or model are missing here."""
    from . import embed, variants
    from .ocr import get_reader

    options = variants.parse(label)
    if not embed.model_available(variants.model_name(options)):
        raise RuntimeError("the model file is not in this image")
    missing = variants.missing_indexes(options)
    if missing:
        raise RuntimeError(f"index not built: {', '.join(missing)}")
    from database import SessionLocal

    return variants.build_matcher(options, SessionLocal, ocr_reader=get_reader())


def compare_server(run_id: str, data_dir: Path | None = None, matcher_factory=None) -> dict:
    """Run the server's matcher on the stored photo with the option set in use and with the phone settings; store both
    answers (top 20 and the decision) next to the phone's. Never raises: a failure is stored as the answer."""
    import time

    from . import variants
    from .images import decode_rgb

    factory = matcher_factory or default_matcher
    path = photo_path(run_id, data_dir)
    result: dict = {"status": "done"}
    if path is None:
        result = {"status": "no_photo"}
    else:
        try:
            photo = decode_rgb(path.read_bytes(), max_side=2048)
        except Exception as error:
            photo = None
            result = {"status": "error", "error": f"the stored photo could not be read: {type(error).__name__}"}
        if photo is not None:
            with _compare_lock:
                for key, label in (("in_use", variants.active_label()), ("phone8", variants.PHONE_KEPT_LABEL)):
                    try:
                        matcher = factory(label)
                        start = time.perf_counter()
                        outcome = matcher.match(photo)
                        result[key] = _answer_of(outcome, label, (time.perf_counter() - start) * 1000)
                    except Exception as error:
                        logger.warning("Phone speed test: the server comparison %s failed: %s", key, error)
                        result[key] = {"status": "error", "label": label, "error": f"{type(error).__name__}: {error}"[:200]}
    with _lock:
        folder = run_dir(run_id, data_dir)  # the run may have been deleted meanwhile
        if folder is not None:
            run = _read_json(folder / RESULT)
            if run is not None:
                run["server"] = result
                _write_json(folder / RESULT, run)
    return result


def start_compare(run_id: str, data_dir: Path | None = None) -> threading.Thread:
    data_dir = data_dir or config.data_dir()
    thread = threading.Thread(target=compare_server, args=(run_id, data_dir), name="phone-speed-compare", daemon=True)
    thread.start()
    return thread
