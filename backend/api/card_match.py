"""Scanner lab (admins): the picture matcher's index, benchmark, shadow comparison and picture-first counts."""

import base64
import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import Card, User
from services import scan_trace, trace_correction, trace_sources
from services.audit import record_audit
from services.card_match import MATCHER_VERSION, autorun as autorun_module, benchmark, config, custom_models, embed, index as index_module, device as device_module, jobs as jobs_module, warmup, misses as misses_module, shadow as shadow_module, variants
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


def _compare_rows(kind: str) -> list[dict]:
    """The rows of a comparison for the picker: label, readable title, group, whether it always runs, and how long it took last time."""
    labels = variants.SYNTHETIC_COMPARE_LABELS if kind == "synthetic" else variants.COMPARE_LABELS
    reference = set(variants.compare_reference_labels(labels))
    times = benchmark.last_row_seconds(kind)
    return [
        {"label": label, "title": variants.compare_title(label), "group": variants.compare_group(label), "reference": label in reference,
         "seconds": (times.get(label) or {}).get("seconds"), "measured_at": (times.get(label) or {}).get("at")}
        for label in labels
    ]


@router.post("/warm")
def warm_card_matcher(current_user: User = Depends(get_current_user)):
    """Any signed-in user's scanner screen calls this when it opens: loads the picture model and OCR in the background
    (so the first scan is not slow after an idle unload) and returns at once. Rate-limited; a no-op unless CARD_MATCH_WARM is on."""
    return warmup.request_warm()


@router.get("/status")
def card_match_status(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    trace_dir = scan_trace.trace_root() or scan_trace.trace_storage_root()
    spec = MODEL_SPECS[DEFAULT_MODEL]
    picture_model = warmup.picture_model()
    return {
        "matcher_version": MATCHER_VERSION,
        "model": {"name": DEFAULT_MODEL, "available": embed.model_available(DEFAULT_MODEL), "license": spec["license"], "dim": spec["dim"]},
        "ocr_available": _ocr_available(),
        "device": device_module.report(picture_model),
        "picture_model": picture_model,  # the model the options in use run on (DINOv2-small, or the custom model): its GPU/CPU is "device.embedder"
        "threads": config.threads(),
        "autorun": config.autorun_enabled(),
        "autorun_info": autorun_module.info(db),
        "index_after_sync": config.index_after_sync_enabled(),
        "english_total": _english_picture_total(db),
        "index": index_module.index_status(DEFAULT_MODEL),
        "extra_indexes": {
            name: {**index_module.index_status(name), "label": spec["label"], "available": embed.model_available(spec["model"])}
            for name, spec in variants.index_specs().items() if name != DEFAULT_MODEL and not spec.get("custom")
        },
        "custom_models": _custom_models_view(),
        "options": {
            "active": variants.active_label(), "compare": list(variants.COMPARE_LABELS),
            "compare_rows": _compare_rows("labelled"), "compare_rows_synthetic": _compare_rows("synthetic"),
        },
        "misses": _misses_summary(),
        "job": jobs_module.jobs.status(),
        "reports": benchmark.latest_reports(),
        "labelled_traces": benchmark.count_labelled_traces(trace_dir),
        "labelled_traces_local": benchmark.count_labelled_traces(trace_dir, source=trace_sources.LOCAL),
        "corrected_labels": trace_correction.corrections_overview(trace_dir)["scans"],
        "trace_sources": _trace_sources(),
        "thresholds": benchmark.thresholds(),
    }


def _pinned_view(entry: dict) -> dict | None:
    """The calibration pinned from the environment, when this model decides with it (it has none of its own)."""
    from services.card_match import pipeline

    calibration = custom_models.effective_calibration(entry)
    if not calibration or calibration["origin"] != "environment":
        return None
    return {"source": calibration["source"], "at": calibration["at"], "thresholds": calibration["thresholds"],
            "default": pipeline.default_thresholds().as_dict()}


def _custom_models_view() -> list[dict]:
    """Uploaded custom models, newest first, each with the status of its two indexes."""
    out = []
    for entry in sorted(custom_models.list_models(), key=lambda e: e.get("uploaded_at", ""), reverse=True):
        names = custom_models.index_names(entry["id"])
        out.append({
            **{key: entry[key] for key in ("id", "name", "sha256", "size_bytes", "uploaded_by", "uploaded_at", "dim")},
            "sha_short": entry["sha256"][:8], "available": embed.model_available(entry["id"]),
            "indexes": {kind: {**index_module.index_status(index_name), "name": index_name} for kind, index_name in names.items()},
            "calibration": entry.get("calibration"),  # version 16 test: {at, scans, thresholds, default, ...} or None
            "calibration_pinned": _pinned_view(entry),
            "in_use": entry["id"] == custom_models.selected_name(),  # the model the ``custom`` option uses
        })
    return out


@router.get("/models")
def list_custom_models(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return {"models": _custom_models_view(), "max_bytes": custom_models.MAX_BYTES}


@router.post("/models")
def upload_custom_model(
    request: Request, file: UploadFile = File(...), name: str = Form(""),
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user),
):
    """Upload a picture model (.onnx, at most 400 MB; see docs/CARD_MATCH.md, "Custom picture models")."""
    _require_admin(current_user)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > custom_models.MAX_BYTES + (1 << 20):
        raise HTTPException(status_code=413, detail=f"The file is over the {custom_models.MAX_BYTES // (1024 * 1024)} MB limit")
    if not (file.filename or "").lower().endswith(".onnx"):
        raise HTTPException(status_code=422, detail="The file must be an .onnx model")
    try:
        entry = custom_models.save_upload(file.file, name or (file.filename or "")[:-5], current_user.username)
    except custom_models.CustomModelError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))
    record_audit(
        db, "card_match.model_uploaded", request=request, actor=current_user, target_type="card_match_model", target_id=entry["id"],
        details={"name": entry["name"], "sha256": entry["sha256"], "size_bytes": entry["size_bytes"]},
    )
    jobs_module.start_custom_indexes(entry["id"])  # its two index builds, one after the other, unless a job is running (then the Build buttons do it)
    return {"model": next((m for m in _custom_models_view() if m["id"] == entry["id"]), entry)}


@router.delete("/models/{model_id}")
def delete_custom_model(model_id: str, request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Remove an uploaded model, its file and both its indexes."""
    _require_admin(current_user)
    if not custom_models.is_custom_name(model_id):
        raise HTTPException(status_code=404, detail="Unknown model")
    if jobs_module.jobs.is_running():
        raise HTTPException(status_code=409, detail="A matcher job is running: stop it or wait before deleting a model")
    try:
        entry = custom_models.delete_model(model_id)
    except custom_models.CustomModelError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))
    record_audit(
        db, "card_match.model_deleted", request=request, actor=current_user, target_type="card_match_model", target_id=model_id,
        details={"name": entry["name"], "sha256": entry["sha256"]},
    )
    return {"deleted": model_id}


@router.post("/models/{model_id}/calibrate")
def calibrate_custom_model(model_id: str, request: Request, current_user: User = Depends(get_current_user)):
    """Version 16 test: work out this model's own picture thresholds from the real scans (a Scanner lab job; see docs/CARD_MATCH.md)."""
    _require_admin(current_user)
    if not custom_models.is_custom_name(model_id) or custom_models.get_model(model_id) is None:
        raise HTTPException(status_code=404, detail="Unknown model")
    missing = [name for name in (*custom_models.index_names(model_id).values(), DEFAULT_MODEL, variants.ART_INDEX)
               if not (index_module.index_status(name).get("built") and index_module.index_status(name).get("count"))]
    if missing:
        raise HTTPException(status_code=409, detail=f"Build the indexes first (missing: {', '.join(missing)})")
    if not _ocr_available():
        raise HTTPException(status_code=409, detail="The OCR library is not installed")
    actor_id, actor_name = current_user.id, current_user.username

    def audit(stored: dict) -> None:
        from database import SessionLocal

        db = SessionLocal()
        try:
            actor = db.query(User).filter(User.id == actor_id).first()
            record_audit(
                db, "card_match.model_calibrated", request=request, actor=actor, target_type="card_match_model", target_id=model_id,
                details={"actor": actor_name, "scans": stored["scans"], "thresholds": stored["thresholds"], "default": stored["default"]},
            )
        finally:
            db.close()

    started, status = jobs_module.start_calibration(model_id, audit)
    return {"started": started, "job": status}


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


class CorrectionRequest(BaseModel):
    card_id: str
    reason: str = ""


def _card_summary(card: Card) -> dict:
    return {"tcg_card_id": card.tcg_card_id, "name": card.name, "set": card.set_id, "number": card.number}


def _local_trace_root():
    return scan_trace.trace_root() or scan_trace.trace_storage_root()


@router.get("/traces/corrections")
def card_match_trace_corrections(current_user: User = Depends(get_current_user)):
    """The scans whose confirmed card an admin corrected on this server, by Misses key (for the lab's "Corrected by ... Undo")."""
    _require_admin(current_user)
    return trace_correction.corrections_overview(_local_trace_root())


@router.post("/traces/{key}/correct")
def card_match_trace_correct(key: str, body: CorrectionRequest, request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Set the confirmed card of a scan to another card (an English, physical catalogue card); the old value is kept for Undo."""
    _require_admin(current_user)
    card_id = (body.card_id or "").strip()
    card = index_module.picture_query(db, "en").filter(Card.tcg_card_id == card_id).first() if card_id else None
    if card is None:
        raise HTTPException(status_code=422, detail="Unknown card: it must be an English, physical card in the catalogue")
    try:
        result = trace_correction.correct(key, card_id, by_user_id=current_user.id, by_username=current_user.username, reason=body.reason)
    except trace_correction.CorrectionError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))
    record_audit(
        db, "scan_trace.ground_truth_corrected", request=request, actor=current_user, target_type="scan_trace", target_id=key,
        details={"from_card_id": result["from"], "to_card_id": result["to"], "note": (body.reason or "").strip()[:200]},
    )
    return {**result, "card": _card_summary(card)}


@router.post("/traces/{key}/undo-correct")
def card_match_trace_undo_correct(key: str, request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Put back the confirmed card the last correction replaced."""
    _require_admin(current_user)
    try:
        result = trace_correction.undo(key, by_user_id=current_user.id, by_username=current_user.username)
    except trace_correction.CorrectionError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))
    record_audit(
        db, "scan_trace.ground_truth_restored", request=request, actor=current_user, target_type="scan_trace", target_id=key,
        details={"from_card_id": result["from"], "to_card_id": result["to"]},
    )
    return result


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
    from services import matcher_only, picture_first

    return {
        "enabled": picture_first.enabled(db),
        "matcher_only": matcher_only.enabled(db),
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


class BenchmarkRequest(BaseModel):
    kind: str = "synthetic"
    labels: list[str] | None = None  # compare-labelled / compare-synthetic: the rows to run (None or empty: all of them)


@router.post("/benchmark")
def start_benchmark(body: BenchmarkRequest, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if body.kind not in ("synthetic", "labelled", "compare-synthetic", "compare-labelled", "ocr-check"):
        raise HTTPException(status_code=422, detail="kind must be synthetic, labelled, compare-synthetic, compare-labelled or ocr-check")
    labels = None
    if body.kind in ("compare-labelled", "compare-synthetic") and body.labels:
        try:
            benchmark.resolve_compare_labels(body.kind.split("-", 1)[1], body.labels)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        labels = body.labels
    _require_ready(True)
    started, status = jobs_module.start_benchmark(body.kind, DEFAULT_MODEL, labels)
    return {"started": started, "job": status}


class AutorunSwitchRequest(BaseModel):
    enabled: bool


def _require_autorun_available() -> None:
    if not autorun_module.available():  # prod: SCAN_MATCHER_AUTORUN is off, so nothing here can run
        raise HTTPException(status_code=409, detail=autorun_module.UNAVAILABLE)


@router.post("/autorun/switch")
def set_autorun_switch(body: AutorunSwitchRequest, request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Nonprod only: "Run the tests by itself after each deploy" (a server setting; audited)."""
    _require_admin(current_user)
    _require_autorun_available()
    autorun_module.set_switch(db, body.enabled, current_user, request)
    return {"autorun_info": autorun_module.info(db)}


@router.post("/autorun/run")
def run_all_tests_now(current_user: User = Depends(get_current_user)):
    """Nonprod only: "Run all tests now" starts the autorun's chain at once, ignoring the fingerprint. Refused while a job runs."""
    _require_admin(current_user)
    _require_autorun_available()
    from services.card_picture_packs import card_picture_warmer

    started, refusal = autorun_module.start_run_all(card_picture_warmer)
    if not started:
        raise HTTPException(status_code=409, detail=refusal)
    return {"started": True, "autorun_info": autorun_module.info()}


@router.post("/stop")
def stop_job(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    jobs_module.jobs.stop()
    return {"job": jobs_module.jobs.status()}
