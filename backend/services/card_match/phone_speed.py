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
CLIENT_ID = re.compile(r"^[A-Za-z0-9_\-]{8,64}$")
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


MATCHER_STAGES = ("finder", "views", "embed", "search", "ocr_number", "name", "second_read", "decide", "total")


def _short(value, where: str, limit: int = MAX_STRING):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise SpeedRunError(f"{where} must be a short text")
    return value


def _flag(value, where: str):
    if not isinstance(value, bool):
        raise SpeedRunError(f"{where} must be true or false")
    return value


def _small_object(value, where: str, shape: dict):
    """An object with only the named fields (``shape``: name -> "text" | "flag" | "number"), each optional, null allowed."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - set(shape):
        raise SpeedRunError(f"{where} holds unknown fields")
    out = {}
    for key, kind in shape.items():
        if key not in value or value[key] is None:
            out[key] = None
        elif kind == "text":
            out[key] = _short(value[key], f"{where}.{key}", 80)
        elif kind == "flag":
            out[key] = _flag(value[key], f"{where}.{key}")
        else:
            out[key] = _number(value[key], f"{where}.{key}")
    return out


def _clean_matcher(matcher) -> dict:
    """What the phone's full matcher answered for the photo (step 3d): the decision, the top 20, what it read and its stage times."""
    if not isinstance(matcher, dict):
        raise SpeedRunError("matcher must be an object")
    allowed = {"version", "backend", "mode", "runs", "stable", "decided", "card", "mechanism", "reason", "similarity", "picture_only", "top20", "read",
               "orientation", "detection", "wholeread", "catalogue", "photo", "timings"}
    if set(matcher) - allowed:
        raise SpeedRunError("matcher holds unknown fields")
    out: dict = {}
    for key in ("version", "runs", "similarity"):
        out[key] = None if matcher.get(key) is None else _number(matcher[key], f"matcher.{key}")
    for key, limit in (("backend", 80), ("mode", 24), ("card", 64), ("mechanism", 40), ("reason", 80)):
        out[key] = _short(matcher.get(key), f"matcher.{key}", limit)
    if out["card"] is not None and not CARD_ID.match(out["card"]):
        raise SpeedRunError("matcher.card is not a card id")
    for key in ("stable", "decided", "picture_only"):
        out[key] = _flag(matcher.get(key, False), f"matcher.{key}")
    picks = matcher.get("top20", [])
    if not isinstance(picks, list) or len(picks) > MAX_TOP:
        raise SpeedRunError("matcher.top20 holds at most 20 cards")
    out["top20"] = []
    for pick in picks:
        if not isinstance(pick, list) or len(pick) != 2 or not isinstance(pick[0], str) or not CARD_ID.match(pick[0]):
            raise SpeedRunError("A matcher pick is [card id, similarity]")
        score = _number(pick[1], "similarity")
        if abs(score) > 2:
            raise SpeedRunError("similarity is out of range")
        out["top20"].append([pick[0], round(float(score), 4)])
    out["read"] = _small_object(matcher.get("read"), "matcher.read", {"number": "text", "total": "text", "name": "text", "source": "text"})
    out["orientation"] = _small_object(matcher.get("orientation"), "matcher.orientation", {"by": "text", "flipped": "flag"})
    out["detection"] = _small_object(matcher.get("detection"), "matcher.detection", {"source": "text", "found": "flag"})
    out["wholeread"] = _small_object(matcher.get("wholeread"), "matcher.wholeread", {"tried": "flag", "rescued": "flag"})
    out["catalogue"] = _small_object(matcher.get("catalogue"), "matcher.catalogue", {"present": "flag", "cards": "number"})
    out["photo"] = _small_object(matcher.get("photo"), "matcher.photo", {"width": "number", "height": "number", "bytes": "number"})
    timings = matcher.get("timings") or {}
    if not isinstance(timings, dict) or set(timings) - set(MATCHER_STAGES):
        raise SpeedRunError("matcher.timings holds unknown stages")
    out["timings"] = {}
    for stage, pair in timings.items():
        if not isinstance(pair, list) or len(pair) != 2:
            raise SpeedRunError("A stage time is [first, median]")
        out["timings"][stage] = [None if value is None else _number(value, f"matcher.timings.{stage}") for value in pair]
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
    if set(body) - {"timings", "device", "answer", "crashed_step", "client_id", "matcher"}:
        raise SpeedRunError("Unknown field")
    out = {"timings": out_timings, "device": out_device}
    client_id = body.get("client_id")
    if client_id is not None:
        if not isinstance(client_id, str) or not CLIENT_ID.match(client_id):
            raise SpeedRunError("client_id must be 8 to 64 letters, digits, dashes or underscores")
        out["client_id"] = client_id
    if crashed is not None:
        out["crashed_step"] = crashed
    if body.get("answer") is not None:
        out["answer"] = _clean_answer(body["answer"])
    if body.get("matcher") is not None:
        out["matcher"] = _clean_matcher(body["matcher"])
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
    if run.get("client_id"):
        with _lock:
            existing = _find_by_client_id(run["client_id"], data_dir)
        if existing is not None:  # the same run posted again (a retry, a second tap, a queue replay): stored once
            existing["duplicate"] = True
            return existing
    now = now or datetime.datetime.now(datetime.timezone.utc)
    run["at"] = now.replace(microsecond=0).isoformat()
    run["by"] = str(user)[:64]
    run["matcher_version"] = MATCHER_VERSION
    run["id"] = new_run_id(now)
    run["has_photo"] = photo is not None
    run["server"] = {"status": "pending" if photo is not None else "no_photo"}
    with _lock:
        if run.get("client_id") and _find_by_client_id(run["client_id"], data_dir) is not None:  # lost a race with the same post
            existing = _find_by_client_id(run["client_id"], data_dir)
            existing["duplicate"] = True
            return existing
        folder = root(data_dir) / run["id"]
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        if photo is not None:
            (folder / PHOTO).write_bytes(photo)
        _write_json(folder / RESULT, run)
        _trim(data_dir)
    return run


def _find_by_client_id(client_id: str, data_dir: Path | None = None) -> dict | None:
    """A stored run that came with this client-generated id, if any (the stored runs are few: the newest ``KEEP``)."""
    for folder in reversed(_run_folders(data_dir)):
        run = _read_json(folder / RESULT)
        if run is not None and run.get("client_id") == client_id:
            return run
    return None


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
    way = server.get("phone_way")
    if isinstance(way, dict) and way.get("status") == "ok":
        lists = {"whole": [_norm(item["id"]) for item in way.get("whole20", [])], "art": [_norm(item["id"]) for item in way.get("art20", [])]}
        per_backend = {}
        for backend, kinds in phone.items():
            row = {}
            for kind, server_ids in lists.items():
                phone_ids = [_norm(item[0]) for item in (kinds.get(kind) or [])]
                if phone_ids and server_ids:
                    row[kind] = {"top1_agree": phone_ids[0] == server_ids[0], "overlap": len(set(phone_ids) & set(server_ids))}
            if row:
                per_backend[backend] = row
        size = run.get("device") or {}
        orientation = None  # the phone and the stored photo must be the same way up (EXIF rotation applied the same way)
        if size.get("photoWidth") and size.get("photoHeight") and way.get("photo_size"):
            orientation = (size["photoHeight"] >= size["photoWidth"]) == (way["photo_size"][1] >= way["photo_size"][0])
        if per_backend:
            out["phone_way"] = {"backends": per_backend, "orientation_agree": orientation}
    return out or None


def compare_matcher(run: dict) -> dict | None:
    """The phone's full matcher against the server's kept set on the phone's model and index (``server["phone8"]``), for the stored photo:
    the same decided / undecided, the same card, the same mechanism, and how many of the top 20 are shared."""
    matcher = run.get("matcher")
    if not isinstance(matcher, dict):
        return None
    server = run.get("server") or {}
    entry = server.get("phone8")
    phone_card = _norm(matcher.get("card")) if matcher.get("decided") and matcher.get("card") else None
    if not isinstance(entry, dict) or entry.get("status") == "error" or "outcome" not in entry:
        return {"status": server.get("status") or "pending", "phone": phone_card, "picture_only": bool(matcher.get("picture_only"))}
    decision = entry.get("decision")
    server_card = _norm(decision.get("id")) if isinstance(decision, dict) and decision.get("id") else None
    same_decided = (phone_card is None) == (server_card is None)
    same_card = same_decided and phone_card == server_card
    same_mechanism = bool(same_card and (phone_card is None or matcher.get("mechanism") == (decision or {}).get("mechanism")))
    phone_ids = {_norm(item[0]) for item in matcher.get("top20") or []}
    server_ids = {_norm(item.get("id")) for item in entry.get("top20") or []}
    return {
        "status": "compared", "phone": phone_card, "server": server_card, "agree": same_card, "same_decided": same_decided, "same_card": same_card,
        "same_mechanism": same_mechanism, "overlap": len(phone_ids & server_ids), "picture_only": bool(matcher.get("picture_only")),
        "phone_mechanism": matcher.get("mechanism"), "server_mechanism": (decision or {}).get("mechanism"),
        "phone_reason": matcher.get("reason"), "server_reason": entry.get("unsure_reason"),
    }


def latest(count: int = 10, data_dir: Path | None = None) -> list[dict]:
    """The last ``count`` runs, newest first, with the phone/server agreement worked out."""
    runs = []
    for folder in reversed(_run_folders(data_dir)[-count:]):
        run = _read_json(folder / RESULT)
        if run is None:
            continue
        run["compare"] = compare_summary(run)
        run["matcher_compare"] = compare_matcher(run)
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


def phone_guide_box(width: int, height: int) -> tuple[float, float, float, float]:
    """x0, y0, x1, y1 (fractions of the photo) of the card the phone cuts: a centred 63:88 box, 90% of the height, or 96% of
    the width when that is the limit. The same arithmetic as `guideCardBox` in frontend/src/phonespeed/views.js; the shared
    reference `frontend/tests/fixtures/phone-matcher/v11/guide-box-reference.json` pins both."""
    card_h = 0.9 * height
    card_w = card_h * 63 / 88
    if card_w > 0.96 * width:
        card_w = 0.96 * width
        card_h = card_w * 88 / 63
    return ((width - card_w) / 2 / width, (height - card_h) / 2 / height, (width + card_w) / 2 / width, (height + card_h) / 2 / height)


def phone_crop(photo_rgb, card_size: tuple[int, int] = (630, 880)):
    """The phone's flat card from the photo: the `phone_guide_box` crop (floor of each edge, like the phone's cropRgba),
    resized to 630 x 880 (area average when shrinking, cubic when enlarging). No finder, no flattening."""
    import cv2

    height, width = photo_rgb.shape[:2]
    x0, y0, x1, y1 = phone_guide_box(width, height)
    left, top, right, bottom = max(0, int(x0 * width)), max(0, int(y0 * height)), min(width, int(x1 * width)), min(height, int(y1 * height))
    crop = photo_rgb[top:bottom, left:right]
    shrinking = crop.shape[1] >= card_size[0] and crop.shape[0] >= card_size[1]
    return cv2.resize(crop, card_size, interpolation=cv2.INTER_AREA if shrinking else cv2.INTER_CUBIC)


def phone_way_answer(photo_rgb, *, embedder=None, whole_index=None, art_index=None) -> dict:
    """The server does exactly what the phone did, for like-for-like comparison: the phone's crop, the 8-bit model, the card at
    0 degrees only, CLS and L2 normalised; the top 20 of the 8-bit whole-card index, and of the 8-bit artwork index searched
    with the embedding of the artwork window of that same card. Indexes are read as the phone stores them (int8 + a scale)."""
    from . import detect, embed, index as index_module, phone, variants

    embedder = embedder or embed.get_embedder(variants.PHONE_MODEL)
    whole_index = whole_index if whole_index is not None else index_module.get_index(variants.PHONE_INDEX)
    art_index = art_index if art_index is not None else index_module.get_index(variants.PHONE_ART_INDEX)
    if whole_index is None or not len(whole_index) or art_index is None or not len(art_index):
        raise RuntimeError("the int8 indexes are not built")
    card = phone_crop(photo_rgb)
    whole_query = embedder.embed([card])
    art_query = embedder.embed([detect.art_crop(card)])
    pick = lambda hits: [{"id": card_id, "similarity": round(float(score), 4)} for card_id, score in hits]  # noqa: E731
    return {
        "status": "ok", "label": "phone's way (int8 model, centre crop, 0 degrees)",
        "photo_size": [int(photo_rgb.shape[1]), int(photo_rgb.shape[0])],
        "whole20": pick(phone.int8_view(whole_index).search(whole_query, 20)[0]),
        "art20": pick(phone.int8_view(art_index).search(art_query, 20)[0]),
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


def compare_server(run_id: str, data_dir: Path | None = None, matcher_factory=None, phone_way_factory=None) -> dict:
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
                try:  # the like-for-like answer first: it is the cheap one
                    result["phone_way"] = (phone_way_factory or phone_way_answer)(photo)
                except Exception as error:
                    logger.warning("Phone speed test: the phone's-way comparison failed: %s", error)
                    result["phone_way"] = {"status": "error", "error": f"{type(error).__name__}: {error}"[:200]}
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
