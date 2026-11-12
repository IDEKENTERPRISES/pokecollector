"""Scanner lab (admins): the picture matcher's index, benchmark, shadow comparison and picture-first counts."""

import base64
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import Card, User
from services import scan_storage, scan_trace, trace_sources
from services.card_match import MATCHER_VERSION, benchmark, config, embed, index as index_module, jobs as jobs_module, misses as misses_module, phone as phone_module, phone_speed as phone_speed_module, shadow as shadow_module, variants
from services.card_match.model_specs import DEFAULT_MODEL, MODEL_SPECS

router = APIRouter()


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


def _ocr_available() -> bool:
    try:
        import rapidocr_onnxruntime  # noqa: F401
        return True
    except ImportError:
        return False


def _english_picture_total(db: Session) -> int:
    return int(index_module.picture_query(db, "en").with_entities(func.count(Card.id)).scalar() or 0)


@router.get("/status")
def card_match_status(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    trace_dir = scan_trace.trace_root() or scan_trace.trace_storage_root()
    spec = MODEL_SPECS[DEFAULT_MODEL]
    return {
        "matcher_version": MATCHER_VERSION,
        "model": {"name": DEFAULT_MODEL, "available": embed.model_available(DEFAULT_MODEL), "license": spec["license"], "dim": spec["dim"]},
        "ocr_available": _ocr_available(),
        "threads": config.threads(),
        "autorun": config.autorun_enabled(),
        "index_after_sync": config.index_after_sync_enabled(),
        "english_total": _english_picture_total(db),
        "index": index_module.index_status(DEFAULT_MODEL),
        "extra_indexes": {
            name: {**index_module.index_status(name), "label": spec["label"], "available": embed.model_available(spec["model"])}
            for name, spec in variants.index_specs().items() if name != DEFAULT_MODEL
        },
        "options": {"active": variants.active_label(), "compare": list(variants.COMPARE_LABELS)},
        "misses": _misses_summary(),
        "phone": _phone_summary(),
        "phone_error": jobs_module.phone_error(),
        "job": jobs_module.jobs.status(),
        "reports": benchmark.latest_reports(),
        "labelled_traces": benchmark.count_labelled_traces(trace_dir),
        "labelled_traces_local": benchmark.count_labelled_traces(trace_dir, source=trace_sources.LOCAL),
        "trace_sources": _trace_sources(),
        "thresholds": benchmark.thresholds(),
    }


def _phone_summary() -> dict:
    """Version 11, "Phone settings": the int8 model's and indexes' sizes, the options the comparison rows use, the bundle."""
    model = MODEL_SPECS[variants.PHONE_MODEL]
    indexes = {name: index_module.index_status(name) for name in (variants.PHONE_INDEX, variants.PHONE_ART_INDEX)}
    return {
        "model": {"name": variants.PHONE_MODEL, "size_bytes": model["size_bytes"], "available": embed.model_available(variants.PHONE_MODEL),
                  "fp32_size_bytes": MODEL_SPECS[DEFAULT_MODEL]["size_bytes"], "fp16_size_bytes": MODEL_SPECS[variants.FP16_MODEL]["size_bytes"]},
        "indexes": indexes,
        "labels": [variants.PHONE_LABEL, variants.PHONE_LITE_LABEL, variants.IN_USE + "+fp16+index8"],
        "bundle": phone_module.bundle_status(),
    }


_SOURCE_STATUS_TTL_SECONDS = 30
_source_status_cache: dict = {"at": 0.0, "key": None, "value": []}


def _trace_sources() -> list[dict]:
    """One line per read-only source (prod's scans): readable or not and why, how many scans, how many confirmed, the newest date.
    Read-only, and cached for a moment because it reads every trace once."""
    roots = trace_sources.readonly_roots()
    key = [(root.label, str(root.path)) for root in roots]
    now = time.monotonic()
    cache = _source_status_cache
    if cache["key"] != key or now - cache["at"] > _SOURCE_STATUS_TTL_SECONDS:
        cache.update(at=now, key=key, value=[trace_sources.source_status(root) for root in roots])
    return cache["value"]


def _misses_summary() -> dict | None:
    report = misses_module.load_latest()
    if report is None:
        return None
    return {"created_at": report["created_at"], "scans": report["scans"], "misses": report["misses"], "counts": report["counts"]}


@router.get("/misses")
def card_match_misses(tag: str | None = None, offset: int = 0, limit: int = misses_module.PAGE_SIZE, current_user: User = Depends(get_current_user)):
    """Confirmed real scans where the right card was not the first pick, with thumbnails and likely causes."""
    _require_admin(current_user)
    if tag and tag not in misses_module.TAGS:
        raise HTTPException(status_code=422, detail="Unknown tag")
    return misses_module.page(tag, max(0, offset), max(1, min(limit, 200)))


@router.get("/misses/{key}/full")
def card_match_miss_full(key: str, current_user: User = Depends(get_current_user)):
    """One miss at full size: the photo with the corners drawn and the flat card as it was read, inline (the
    lab page cannot load images that need a bearer token)."""
    _require_admin(current_user)
    photo, card = misses_module.full_image(key, "photo"), misses_module.full_image(key, "card")
    if photo is None and card is None:
        raise HTTPException(status_code=404, detail="Not found")

    def inline(data):
        return ("data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")) if data else None

    return {"photo": inline(photo), "card": inline(card), "strips": misses_module.strip_views(key) or []}


_SHADOW_REPORT_TTL_SECONDS = 20
_shadow_report_cache: dict = {"at": 0.0, "value": None, "dir": None}


@router.get("/shadow")
def card_match_shadow(current_user: User = Depends(get_current_user)):
    """Shadow mode: the matcher beside today's scanner path on real scans (docs/CARD_MATCH.md)."""
    _require_admin(current_user)
    now = time.monotonic()
    trace_dir = scan_trace.trace_root() or scan_trace.trace_storage_root()
    cache = _shadow_report_cache
    if cache["value"] is None or cache["dir"] != trace_dir or now - cache["at"] > _SHADOW_REPORT_TTL_SECONDS:
        cache.update(at=now, dir=trace_dir, value=shadow_module.shadow_report(trace_dir))
    return {"enabled": config.shadow_enabled(), "worker": shadow_module.runner.status(), "report": _shadow_report_cache["value"]}


@router.get("/picture-first")
def card_match_picture_first(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Picture match first: whether it is on, and what the last 7 days looked like (services/picture_first.py)."""
    _require_admin(current_user)
    from services import picture_first

    return {
        "enabled": picture_first.enabled(db),
        "env_default": picture_first.env_default(),
        "timeout_seconds": picture_first.timeout_seconds(),
        "counts": picture_first.lab_counts(db),
    }


def _require_ready(need_index: bool) -> None:
    if not embed.model_available(DEFAULT_MODEL):
        raise HTTPException(status_code=409, detail="The model file is not in this image")
    if need_index:
        existing = index_module.index_status(DEFAULT_MODEL)
        if not existing["built"] or not existing["count"]:
            raise HTTPException(status_code=409, detail="Build the index first")
        if not _ocr_available():
            raise HTTPException(status_code=409, detail="The OCR library is not installed")


class IndexRequest(BaseModel):
    name: str = DEFAULT_MODEL


@router.post("/index")
def start_index(body: IndexRequest | None = None, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    name = body.name if body else DEFAULT_MODEL
    spec = variants.index_specs().get(name)
    if spec is None:
        raise HTTPException(status_code=422, detail="Unknown index")
    if not embed.model_available(spec["model"]):
        raise HTTPException(status_code=409, detail="The model file is not in this image")
    started, status = jobs_module.start_index(name)
    return {"started": started, "job": status}


@router.post("/phone-bundle/build")
def build_phone_bundle(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not embed.model_available(variants.PHONE_MODEL):
        raise HTTPException(status_code=409, detail="The int8 model file is not in this image")
    for name in (variants.PHONE_INDEX, variants.PHONE_ART_INDEX):
        status = index_module.index_status(name)
        if not status["built"] or not status["count"]:
            raise HTTPException(status_code=409, detail="Build the two int8 indexes first")
    started, status = jobs_module.start_phone_bundle()
    return {"started": started, "job": status}


_BUNDLE_CACHE = "private, max-age=3600, must-revalidate"


def _not_modified(request: Request, etag: str) -> bool:
    wanted = {part.strip().removeprefix("W/") for part in request.headers.get("if-none-match", "").split(",")}
    return etag in wanted or "*" in wanted


@router.get("/phone-bundle/manifest")
def phone_bundle_manifest(request: Request, current_user: User = Depends(get_current_user)):
    """The phone bundle's manifest (any signed-in user; read-only). ETag = the manifest's own sha256."""
    path = phone_module.bundle_dir() / phone_module.MANIFEST
    if not path.is_file():
        raise HTTPException(status_code=404, detail="The phone bundle is not built yet")
    etag = f'"{phone_module._sha256_file(path)}"'
    if _not_modified(request, etag):
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": _BUNDLE_CACHE})
    return FileResponse(path, media_type="application/json", headers={"ETag": etag, "Cache-Control": _BUNDLE_CACHE})


@router.get("/phone-bundle/files/{path:path}")
def phone_bundle_file(path: str, request: Request, current_user: User = Depends(get_current_user)):
    """One file of the phone bundle, only if the manifest lists exactly this path (no traversal). ETag = its sha256."""
    found = phone_module.resolve_file(path)
    if found is None:
        raise HTTPException(status_code=404, detail="Not in the phone bundle")
    full, entry = found
    etag = f'"{entry["sha256"]}"'
    if _not_modified(request, etag):
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": _BUNDLE_CACHE})
    return FileResponse(full, media_type="application/octet-stream", headers={"ETag": etag, "Cache-Control": _BUNDLE_CACHE})


@router.post("/phone-speed")
async def post_phone_speed(request: Request, current_user: User = Depends(get_current_user)):
    """Step 2: one phone speed-test run (admins). Either JSON (timings, device, answer) or multipart: `data` (that JSON as text)
    plus `photo`, the capture taken or picked on the test page (never the built-in sample). The photo goes through the
    scan upload checks and is stored with the run, admin-only; the JSON holds numbers and short texts only."""
    _require_admin(current_user)
    limit = scan_storage.MAX_FILE_BYTES + phone_speed_module.MAX_JSON_BYTES + 65536
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=413, detail="Too large")
    photo = None
    if request.headers.get("content-type", "").lower().startswith("multipart/form-data"):
        form = await request.form()
        raw = form.get("data")
        upload = form.get("photo")
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > phone_speed_module.MAX_JSON_BYTES:
            raise HTTPException(status_code=413 if isinstance(raw, str) else 422, detail="The data part must be JSON text of at most 32 KB")
        if upload is not None and not hasattr(upload, "read"):
            raise HTTPException(status_code=422, detail="photo must be a file")
        if upload is not None:
            try:
                data = await scan_storage.read_limited_upload(upload, remaining_job_bytes=scan_storage.MAX_FILE_BYTES)
                photo = scan_storage.sanitize_image_bytes(data).data
            except scan_storage.ScanUploadError as error:
                raise HTTPException(status_code=422, detail=str(error))
    else:
        raw = await request.body()
        if len(raw) > phone_speed_module.MAX_JSON_BYTES:
            raise HTTPException(status_code=413, detail="Too large")
    try:
        run = phone_speed_module.record(json.loads(raw), current_user.username, photo=photo)
    except (ValueError, phone_speed_module.SpeedRunError) as error:  # SpeedRunError is a ValueError; so is bad JSON
        raise HTTPException(status_code=422, detail=str(error)[:200])
    if photo is not None:
        phone_speed_module.start_compare(run["id"])
    return {"saved": True, "run": run}


@router.get("/phone-speed")
def get_phone_speed(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return {"runs": phone_speed_module.latest(10)}


@router.get("/phone-speed/{run_id}/photo")
def get_phone_speed_photo(run_id: str, size: str = "thumb", current_user: User = Depends(get_current_user)):
    """The stored photo of a run, for admins only: inline, never cached, never as a download. `size=thumb` is a small copy."""
    _require_admin(current_user)
    path = phone_speed_module.photo_path(run_id)
    if path is None:
        raise HTTPException(status_code=404, detail="No photo for this run")
    data = path.read_bytes()
    if size != "full":
        import io

        from PIL import Image

        with Image.open(io.BytesIO(data)) as image:
            image.thumbnail((160, 160))
            out = io.BytesIO()
            image.convert("RGB").save(out, format="JPEG", quality=70)
            data = out.getvalue()
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, no-store", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff"})


@router.delete("/phone-speed/{run_id}")
def delete_phone_speed(run_id: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if not phone_speed_module.delete(run_id):
        raise HTTPException(status_code=404, detail="No such run")
    return {"deleted": True}


class BenchmarkRequest(BaseModel):
    kind: str = "synthetic"


@router.post("/benchmark")
def start_benchmark(body: BenchmarkRequest, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if body.kind not in ("synthetic", "labelled", "compare-synthetic", "compare-labelled", "ocr-check"):
        raise HTTPException(status_code=422, detail="kind must be synthetic, labelled, compare-synthetic, compare-labelled or ocr-check")
    _require_ready(True)
    started, status = jobs_module.start_benchmark(body.kind, DEFAULT_MODEL)
    return {"started": started, "job": status}


@router.post("/stop")
def stop_job(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    jobs_module.jobs.stop()
    return {"job": jobs_module.jobs.status()}
