"""Scanner lab (admins): the picture matcher's index, benchmark, shadow comparison and picture-first counts."""

import base64
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import Card, User
from services import scan_trace
from services.card_match import MATCHER_VERSION, benchmark, config, embed, index as index_module, jobs as jobs_module, misses as misses_module, shadow as shadow_module, variants
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
        "job": jobs_module.jobs.status(),
        "reports": benchmark.latest_reports(),
        "labelled_traces": benchmark.count_labelled_traces(trace_dir),
        "thresholds": benchmark.thresholds(),
    }


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
