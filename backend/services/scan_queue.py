"""Fair, restart-safe background processing for sanitized card scans."""

from __future__ import annotations

import asyncio
import datetime
import logging
import os
import threading
import uuid
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from models import ScanJob, ScanJobItem, ScanQueueUserState, User
from services import picture_first
from services.gemini_rate_limit import gemini_priority_scope
from services.scanner_reachability import (
    WAITING_EXPIRY_GRACE_DAYS,
    WAITING_REASON,
    endpoint_reachable,
)
from services.scan_storage import (
    ScanUploadError,
    delete_job_directory,
    delete_scan_image,
    downscale_for_recognition,
    read_recognition_image,
    resolve_scan_path,
)

logger = logging.getLogger(__name__)

MAX_RECOGNITION_ATTEMPTS = 3
# The largest selectable AI-response timeout can be consumed by three initial
# recognition attempts and two visual-verification attempts. Twenty minutes
# leaves several minutes for retry backoff, bounded reference downloads, and
# database work before another worker may reclaim the item.
LEASE_SECONDS = 20 * 60
TRANSIENT_BACKOFF_SECONDS = (30, 120, 600, 1800, 3600, 21600)
RECOGNITION_BACKOFF_SECONDS = (2, 10, 30)
TERMINAL_ITEM_STATUSES = {"done", "failed"}

def _env_positive_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default
    return value if value >= 1 else default


# Gemini is a cloud service that serves several photos at once.
MAX_CONCURRENT_SCAN_PROCESSING = _env_positive_int("SCAN_MAX_CONCURRENT_GEMINI", 3)
# An OpenAI-compatible endpoint (Ollama on a gaming PC) serves one photo at a
# time; letting three wait on it made the queued ones time out. Raise this only
# for a server that really runs requests in parallel (OLLAMA_NUM_PARALLEL).
MAX_CONCURRENT_OPENAI_SCANS = _env_positive_int("SCAN_MAX_CONCURRENT_OPENAI", 1)
_SCAN_PROCESSING_SLOT_POLL_SECONDS = 0.1


class _ProcessWideAsyncSemaphore:
    """Bound async work across the web and scheduler event loops in one process."""

    def __init__(self, value: int):
        self._semaphore = threading.BoundedSemaphore(value)

    async def __aenter__(self):
        # APScheduler drains the queue from a separate event loop, so an
        # asyncio.Semaphore created at module import can become bound to the
        # web loop and fail when the scheduler overlaps it. A non-blocking
        # process-wide semaphore keeps the bound exact without blocking either
        # loop's thread while all processing slots are occupied.
        while not self._semaphore.acquire(blocking=False):
            await asyncio.sleep(_SCAN_PROCESSING_SLOT_POLL_SECONDS)
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        self._semaphore.release()


_scan_processing_semaphore = _ProcessWideAsyncSemaphore(
    MAX_CONCURRENT_SCAN_PROCESSING
)


_endpoint_gates: dict[tuple[str, int], _ProcessWideAsyncSemaphore] = {}
_endpoint_gates_lock = threading.Lock()


def _endpoint_gate(url: str) -> _ProcessWideAsyncSemaphore:
    """One process-wide gate per endpoint (and per configured limit)."""
    key = (url, MAX_CONCURRENT_OPENAI_SCANS)
    with _endpoint_gates_lock:
        gate = _endpoint_gates.get(key)
        if gate is None:
            gate = _ProcessWideAsyncSemaphore(MAX_CONCURRENT_OPENAI_SCANS)
            _endpoint_gates[key] = gate
        return gate


def _openai_endpoint_for_user(db: Session, user_id: int) -> str | None:
    """The endpoint URL when this user scans through an OpenAI-compatible provider."""
    from services.scan_providers import OPENAI, get_provider, openai_base_url

    try:
        return openai_base_url() if get_provider(db, user_id).name == OPENAI else None
    except Exception:
        return None


class _ProcessingSlots:
    """Endpoint gate first, then the shared slot, so waiters never hog global slots."""

    def __init__(self, claim):
        self._claim = claim
        self._gate = None

    async def __aenter__(self):
        endpoint = getattr(self._claim, "openai_endpoint", None)
        self._gate = _endpoint_gate(endpoint) if endpoint else None
        if self._gate is not None:
            await self._gate.__aenter__()
        try:
            await _scan_processing_semaphore.__aenter__()
        except BaseException:
            if self._gate is not None:
                await self._gate.__aexit__(None, None, None)
            raise
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        await _scan_processing_semaphore.__aexit__(exc_type, exc, traceback)
        if self._gate is not None:
            await self._gate.__aexit__(exc_type, exc, traceback)


@dataclass(frozen=True)
class ClaimedScanItem:
    item_id: int
    lease_token: str
    item_ids: tuple[int, ...] = ()
    composite: bool = False
    recognition_cache_item_ids: tuple[int, ...] = ()
    # Set when the owner scans through an OpenAI-compatible endpoint, which
    # serves one photo at a time (see MAX_CONCURRENT_OPENAI_SCANS).
    openai_endpoint: str | None = None

    @property
    def all_item_ids(self) -> tuple[int, ...]:
        return self.item_ids or (self.item_id,)


class TransientScanError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retry_after_seconds: float | None = None,
        retry_reason: str | None = None,
    ):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds
        self.retry_reason = retry_reason


class RecognitionScanError(RuntimeError):
    pass


class PermanentScanError(RuntimeError):
    pass


class ScannerWaitingError(RuntimeError):
    """The scanner endpoint is switched off: park the scan without a retry penalty."""

    retry_reason = WAITING_REASON


def _eligible_items(now: datetime.datetime):
    return and_(
        ScanJobItem.status.in_(["pending", "retrying"]),
        # Scans waiting for the scanner are released by release_waiting_scans(),
        # not by a timer.
        or_(ScanJobItem.retry_reason.is_(None), ScanJobItem.retry_reason != WAITING_REASON),
        or_(ScanJobItem.next_attempt_at.is_(None), ScanJobItem.next_attempt_at <= now),
        ScanJob.expires_at > now,
    )


def recover_expired_leases(db: Session, *, now: datetime.datetime | None = None) -> int:
    """Return work abandoned by a crashed worker to the retry queue."""
    now = now or datetime.datetime.utcnow()
    items = (
        db.query(ScanJobItem)
        .filter(
            ScanJobItem.status == "processing",
            ScanJobItem.lease_expires_at.is_not(None),
            ScanJobItem.lease_expires_at <= now,
        )
        .all()
    )
    for item in items:
        item.status = "retrying"
        item.next_attempt_at = now
        item.retry_reason = None
        item.recognized = None
        item.lease_token = None
        item.lease_expires_at = None
        item.error = "Processing was interrupted and will resume automatically."
        item.updated_at = now
    if items:
        db.commit()
    return len(items)


def claim_next_scan_item(
    db: Session,
    *,
    now: datetime.datetime | None = None,
    lease_seconds: int = LEASE_SECONDS,
) -> ClaimedScanItem | None:
    """Atomically claim one individual photo or a two-to-four-photo group."""
    now = now or datetime.datetime.utcnow()

    state = (
        db.query(ScanQueueUserState)
        .join(ScanJobItem, ScanJobItem.user_id == ScanQueueUserState.user_id)
        .join(ScanJob, ScanJob.id == ScanJobItem.job_id)
        .filter(_eligible_items(now))
        .order_by(
            ScanQueueUserState.last_dispatched_at.asc().nullsfirst(),
            ScanQueueUserState.user_id.asc(),
        )
        .with_for_update(skip_locked=True)
        .first()
    )
    if state is None:
        db.rollback()
        return None

    item = (
        db.query(ScanJobItem)
        .join(ScanJob, ScanJob.id == ScanJobItem.job_id)
        .filter(ScanJobItem.user_id == state.user_id, _eligible_items(now))
        .order_by(ScanJob.created_at.asc(), ScanJobItem.position.asc())
        .with_for_update(skip_locked=True)
        .first()
    )
    if item is None:
        db.rollback()
        return None

    items = [item]
    if item.batch_mode:
        siblings = (
            db.query(ScanJobItem)
            .join(ScanJob, ScanJob.id == ScanJobItem.job_id)
            .filter(
                ScanJobItem.job_id == item.job_id,
                ScanJobItem.position > item.position,
                ScanJobItem.batch_mode.is_(True),
                _eligible_items(now),
            )
            .order_by(ScanJobItem.position.asc())
            .limit(3)
            .with_for_update(skip_locked=True)
            .all()
        )
        items.extend(siblings)

    recognition_cache_item_ids = tuple(
        claimed_item.id
        for claimed_item in items
        if (
            claimed_item.retry_reason == "catalogue_unavailable"
            and isinstance(claimed_item.recognized, dict)
        )
    )
    lease_token = uuid.uuid4().hex
    lease_expires_at = now + datetime.timedelta(seconds=lease_seconds)
    for claimed_item in items:
        claimed_item.status = "processing"
        claimed_item.retry_reason = None
        claimed_item.lease_token = lease_token
        claimed_item.lease_expires_at = lease_expires_at
        claimed_item.updated_at = now
    state.last_dispatched_at = now
    job = item.job
    job.status = "running"
    if not job.started_at:
        job.started_at = now
    job.updated_at = now
    openai_endpoint = _openai_endpoint_for_user(db, item.user_id)
    db.commit()
    return ClaimedScanItem(
        openai_endpoint=openai_endpoint,
        item_id=item.id,
        item_ids=tuple(claimed_item.id for claimed_item in items),
        lease_token=lease_token,
        composite=len(items) > 1,
        recognition_cache_item_ids=recognition_cache_item_ids,
    )


def _backoff(values: tuple[int, ...], failure_count: int) -> int:
    index = max(0, min(len(values) - 1, failure_count - 1))
    return values[index]


def _leased_item(db: Session, claim: ClaimedScanItem) -> ScanJobItem | None:
    now = datetime.datetime.utcnow()
    return (
        db.query(ScanJobItem)
        .filter(
            ScanJobItem.id == claim.item_id,
            ScanJobItem.status == "processing",
            ScanJobItem.lease_token == claim.lease_token,
            ScanJobItem.lease_expires_at.is_not(None),
            ScanJobItem.lease_expires_at > now,
        )
        .with_for_update()
        .first()
    )


def _leased_items(db: Session, claim: ClaimedScanItem) -> list[ScanJobItem]:
    now = datetime.datetime.utcnow()
    return (
        db.query(ScanJobItem)
        .filter(
            ScanJobItem.id.in_(claim.all_item_ids),
            ScanJobItem.status == "processing",
            ScanJobItem.lease_token == claim.lease_token,
            ScanJobItem.lease_expires_at.is_not(None),
            ScanJobItem.lease_expires_at > now,
        )
        .order_by(ScanJobItem.position.asc())
        .with_for_update()
        .all()
    )


def _refresh_job_status(db: Session, job: ScanJob, now: datetime.datetime) -> None:
    finished_now = False
    # The caller has just changed item statuses in this session. SessionLocal runs with
    # autoflush off, so without this the query below would still see the old ("processing")
    # status of those items, the job would never be marked finished and no "scans ready"
    # push would be queued.
    db.flush()
    statuses =[row[0] for row in db.query(ScanJobItem.status).filter(ScanJobItem.job_id == job.id).all()]
    if not statuses:
        job.status = "failed"
        job.error_message = "The scan job contains no photos."
        job.finished_at = now
    elif all(status in TERMINAL_ITEM_STATUSES for status in statuses):
        job.status = "done" if any(status == "done" for status in statuses) else "failed"
        job.finished_at = now
        finished_now = True
    elif any(status == "processing" for status in statuses):
        job.status = "running"
    else:
        job.status = "pending"
    job.updated_at = now
    if finished_now:
        from services.notifications import on_scan_job_finished

        on_scan_job_finished(db, job, now)


def complete_claim(db: Session, claim: ClaimedScanItem, result: dict) -> bool:
    now = datetime.datetime.utcnow()
    item = _leased_item(db, claim)
    if item is None:
        db.rollback()
        return False
    item.status = "done"
    item.recognized = result.get("recognized")
    item.matches = result.get("matches")
    item.error = None
    item.lease_token = None
    item.lease_expires_at = None
    item.next_attempt_at = None
    item.retry_reason = None
    item.updated_at = now
    _refresh_job_status(db, item.job, now)
    db.commit()
    return True


def complete_claim_group(
    db: Session,
    claim: ClaimedScanItem,
    results: list[dict | None],
) -> bool:
    """Persist confident positions and queue unclear ones as individual scans."""
    now = datetime.datetime.utcnow()
    items = _leased_items(db, claim)
    if len(items) != len(claim.all_item_ids) or len(results) != len(items):
        db.rollback()
        return False
    for item, result in zip(items, results):
        if result is None:
            item.status = "pending"
            item.batch_mode = False
            item.recognized = None
            item.matches = None
            item.next_attempt_at = now
            item.retry_reason = None
        else:
            item.status = "done"
            item.recognized = result.get("recognized")
            item.matches = result.get("matches")
            item.next_attempt_at = None
            item.retry_reason = None
        item.error = None
        item.lease_token = None
        item.lease_expires_at = None
        item.updated_at = now
    _refresh_job_status(db, items[0].job, now)
    db.commit()
    return True


def fail_claim(
    db: Session,
    claim: ClaimedScanItem,
    error: str,
    *,
    transient: bool = False,
    permanent: bool = False,
    retry_after_seconds: float | None = None,
    retry_reason: str | None = None,
    waiting: bool = False,
) -> bool:
    now = datetime.datetime.utcnow()
    items = _leased_items(db, claim)
    if len(items) != len(claim.all_item_ids):
        db.rollback()
        return False

    for item in items:
        item.error = str(error)
        item.lease_token = None
        item.lease_expires_at = None
        if permanent:
            item.status = "failed"
            item.next_attempt_at = None
            item.retry_reason = None
        elif waiting:
            # Neither attempts nor transient_failures move: being switched off
            # is not the scan's fault and must not climb the retry ladder.
            item.status = "retrying"
            item.next_attempt_at = None
            item.retry_reason = WAITING_REASON
            item.error = None
        elif transient:
            item.transient_failures += 1
            item.status = "retrying"
            delay = (
                max(0.0, float(retry_after_seconds))
                if retry_after_seconds is not None
                else _backoff(TRANSIENT_BACKOFF_SECONDS, item.transient_failures)
            )
            item.next_attempt_at = now + datetime.timedelta(
                seconds=delay
            )
            item.retry_reason = retry_reason
        else:
            item.attempts += 1
            item.retry_reason = None
            if item.attempts >= MAX_RECOGNITION_ATTEMPTS:
                item.status = "failed"
                item.next_attempt_at = None
            else:
                item.status = "retrying"
                item.next_attempt_at = now + datetime.timedelta(
                    seconds=_backoff(RECOGNITION_BACKOFF_SECONDS, item.attempts)
                )
        item.updated_at = now
    _refresh_job_status(db, items[0].job, now)
    db.commit()
    return True


def _load_recognition_cache(
    db: Session,
    item_ids: list[int] | tuple[int, ...],
    lease_token: str | None,
) -> dict[int, dict]:
    """Load parsed recognition only while this worker still owns the lease."""
    if not item_ids or not lease_token:
        return {}
    now = datetime.datetime.utcnow()
    rows = (
        db.query(ScanJobItem.id, ScanJobItem.recognized)
        .filter(
            ScanJobItem.id.in_(item_ids),
            ScanJobItem.status == "processing",
            ScanJobItem.lease_token == lease_token,
            ScanJobItem.lease_expires_at.is_not(None),
            ScanJobItem.lease_expires_at > now,
        )
        .all()
    )
    db.rollback()
    return {
        row.id: dict(row.recognized)
        for row in rows
        if isinstance(row.recognized, dict)
    }


def _persist_recognition_cache(
    recognized_by_item_id: dict[int, dict],
    lease_token: str | None,
) -> None:
    """Persist paid extraction results without committing the processor session."""
    if not recognized_by_item_id or not lease_token:
        return
    from database import SessionLocal

    cache_db = SessionLocal()
    try:
        now = datetime.datetime.utcnow()
        rows = (
            cache_db.query(ScanJobItem)
            .filter(
                ScanJobItem.id.in_(recognized_by_item_id),
                ScanJobItem.status == "processing",
                ScanJobItem.lease_token == lease_token,
                ScanJobItem.lease_expires_at.is_not(None),
                ScanJobItem.lease_expires_at > now,
            )
            .with_for_update()
            .all()
        )
        if {row.id for row in rows} != set(recognized_by_item_id):
            cache_db.rollback()
            raise RuntimeError("The scan lease expired before recognition could be saved.")
        for row in rows:
            row.recognized = recognized_by_item_id[row.id]
            row.updated_at = now
        cache_db.commit()
    finally:
        cache_db.close()


def _clear_recognition_cache(claim: ClaimedScanItem) -> None:
    """Discard a cache unless the failure is specifically catalogue-related."""
    from database import SessionLocal

    cache_db = SessionLocal()
    try:
        now = datetime.datetime.utcnow()
        (
            cache_db.query(ScanJobItem)
            .filter(
                ScanJobItem.id.in_(claim.all_item_ids),
                ScanJobItem.status == "processing",
                ScanJobItem.lease_token == claim.lease_token,
                ScanJobItem.lease_expires_at.is_not(None),
                ScanJobItem.lease_expires_at > now,
            )
            .update(
                {ScanJobItem.recognized: None},
                synchronize_session=False,
            )
        )
        cache_db.commit()
    finally:
        cache_db.close()


def _earlier_picture_for_item(db: Session, item_id: int | None) -> dict | None:
    """What an earlier run of this scan recorded about the picture match (for "Wait for the scanner")."""
    if item_id is None:
        return None
    try:
        recognized = db.query(ScanJobItem.recognized).filter(ScanJobItem.id == item_id).scalar()
        db.rollback()
        return picture_first.earlier_picture(recognized)
    except Exception:
        db.rollback()
        return None


def _picture_meta_for_trace(scanner_result: dict, run) -> dict:
    recognized = scanner_result.get("recognized")
    meta = recognized.get("_picture") if isinstance(recognized, dict) else None
    return meta if isinstance(meta, dict) else {"path": picture_first.PATH_OLLAMA}


async def _scanner_answers() -> bool:
    from services.scan_providers import openai_base_url

    return await endpoint_reachable(openai_base_url())


async def _picture_first_early_result(
    db: Session,
    user_id: int,
    provider,
    image_bytes: bytes,
    run,
    earlier: dict | None,
    *,
    job_id: int | None,
    item_id: int | None,
) -> dict | None:
    """A finished scan result when the picture alone settles it (decided, or unsure with the scanner down)."""
    try:
        if run.decided:
            result = picture_first.decided_result(db, run, earlier=earlier)
            selected = run.result.decision["tcg_card_id"]
        elif (
            not provider.is_gemini
            and not (earlier or {}).get("wait")
            and not await _scanner_answers()
        ):
            result = picture_first.inbox_result(db, run, earlier=earlier)
            selected = None
        else:
            return None
        if result is None:
            return None
        from services.scan_trace import create_scan_trace

        trace = create_scan_trace(
            db, user_id, mode="single", job_id=job_id, item_id=item_id,
            filename="sanitized-scan.jpg", provider="picture", model=run.result.status,
        )
        try:
            trace.set_image(image_bytes)
            trace.record_candidates(result["matches"])
            picture_first.record_in_trace(
                trace, user_id, job_id, item_id, run, result["recognized"]["_picture"], selected=selected
            )
        finally:
            trace.save()
        return result
    except Exception:
        logger.exception("Picture match result could not be used; using the scanner path")
        db.rollback()
        return None


async def _require_scanner_reachable(provider) -> None:
    """Park the scan (no retry penalty) while the local endpoint is switched off."""
    if provider.is_gemini:
        return
    from services.scan_providers import openai_base_url

    if not await endpoint_reachable(openai_base_url()):
        raise ScannerWaitingError("Waiting for the scanner")


def _fit_image_for_provider(provider, image_bytes: bytes, content_type: str):
    """A self-hosted model is sent about 1024 px, never the 2048 px review photo."""
    from services.scan_providers import openai_is_self_hosted

    if provider.is_gemini or not openai_is_self_hosted():
        return image_bytes, content_type
    return downscale_for_recognition(image_bytes, content_type)


async def default_scan_processor(
    db: Session,
    user_id: int,
    image_bytes: bytes,
    content_type: str,
    *,
    job_id: int | None = None,
    item_id: int | None = None,
    lease_token: str | None = None,
    reuse_recognition_cache: bool = False,
) -> dict:
    """Reuse the proven single-card scanner path with background priority."""
    from api.recognize import match_card_info, recognize_sanitized_card
    from services.scan_providers import get_provider, require_scanner_capability_mode
    from services.scan_trace import create_scan_trace

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise PermanentScanError("The scan owner is no longer an active user.")
    provider = get_provider(db, user_id)
    picture_run, picture_earlier = None, None
    if picture_first.enabled(db):
        picture_earlier = _earlier_picture_for_item(db, item_id)
        picture_run = await picture_first.run_matcher(image_bytes)
        if picture_run is not None:
            early = await _picture_first_early_result(
                db, user_id, provider, image_bytes, picture_run, picture_earlier, job_id=job_id, item_id=item_id
            )
            if early is not None:
                return early
    require_scanner_capability_mode(db, user_id, provider.name, provider.model())
    api_key = provider.credential(db, user_id)
    if provider.requires_credential() and not api_key:
        raise HTTPException(
            status_code=400,
            detail=provider.missing_credential_message(),
        )
    await _require_scanner_reachable(provider)
    image_bytes, content_type = _fit_image_for_provider(provider, image_bytes, content_type)
    trace = create_scan_trace(
        db,
        user_id,
        mode="single",
        job_id=job_id,
        item_id=item_id,
        filename="sanitized-scan.jpg",
        provider=provider.name,
        model=provider.model(),
    )
    trace.set_image(image_bytes)
    cache = _load_recognition_cache(
        db,
        [item_id] if item_id is not None and reuse_recognition_cache else [],
        lease_token,
    )
    cached_card_info = cache.get(item_id) if item_id is not None else None
    try:
        if cached_card_info is not None:
            trace.record_cached_extraction(cached_card_info)
            return await match_card_info(
                db,
                cached_card_info,
                allow_visual_verification=False,
                photo_bytes=image_bytes,
                trace=trace,
                prewarm_candidates=True,
            )
        # Only Gemini has a shared per-key budget to protect; other providers get
        # a no-op scope rather than queueing behind Gemini's limiter.
        with provider.rate_limit_scope("background"):
            scanner_result = await recognize_sanitized_card(
                db,
                user_id,
                image_bytes,
                content_type,
                trace=trace,
                prewarm_candidates=True,
                rate_limit_priority="background",
                on_recognized=(
                    lambda card_info: _persist_recognition_cache(
                        {item_id: card_info}, lease_token
                    )
                    if item_id is not None
                    else None
                ),
            )
        if picture_run is not None:
            picture_first.attach_to_scanner_result(
                db, scanner_result, picture_run, earlier=picture_earlier
            )
            picture_first.record_in_trace(
                trace, user_id, job_id, item_id, picture_run,
                _picture_meta_for_trace(scanner_result, picture_run),
            )
        return scanner_result
    except Exception as exc:
        trace.record_error(str(getattr(exc, "detail", exc)))
        raise
    finally:
        trace.save()


async def default_composite_processor(
    db: Session,
    user_id: int,
    images: list[bytes],
    content_types: list[str],
    *,
    job_id: int | None = None,
    item_ids: list[int] | tuple[int, ...] | None = None,
    lease_token: str | None = None,
    recognition_cache_item_ids: list[int] | tuple[int, ...] | None = None,
) -> list[dict | None]:
    """Recognize a small grid and flag unclear positions for individual work."""
    from api.recognize import (
        CatalogueFallbackBudget,
        CompositeRecognitionError,
        match_composite_card_info,
        recognize_composite_card_info,
    )
    from services.scan_providers import (
        SCANNER_CAPABILITY_DEGRADED,
        get_provider,
        require_scanner_capability_mode,
        resolve_scanner_request_timeout,
    )
    from services.card_composite import build_composite
    from services.scan_trace import create_scan_trace

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise PermanentScanError("The scan owner is no longer an active user.")
    provider = get_provider(db, user_id)
    request_timeout_seconds = resolve_scanner_request_timeout(
        db, user_id, provider.name
    )
    try:
        capability_mode = require_scanner_capability_mode(
            db, user_id, provider.name, provider.model()
        )
    except HTTPException as exc:
        raise PermanentScanError(str(exc.detail)) from None
    # Jobs persist their grouping choice before the provider request starts. If
    # the owner retests or changes the provider while a batch is waiting, do
    # not let a group queued under a previous full-capability proof reach a
    # provider now known to support only one image. Returning unresolved
    # positions makes complete_claim_group() requeue each photo individually.
    if capability_mode == SCANNER_CAPABILITY_DEGRADED:
        return [None] * len(images)
    api_key = provider.credential(db, user_id)
    # A local endpoint needs no credential, so ask the provider rather than
    # assuming an empty key means "not configured".
    if provider.requires_credential() and not api_key:
        raise PermanentScanError(
            f"No {provider.name} API key is configured for the scan owner."
        )
    await _require_scanner_reachable(provider)

    images = [
        _fit_image_for_provider(provider, image, "image/jpeg")[0] for image in images
    ]
    trace_item_ids = list(item_ids or [])
    traces = [
        create_scan_trace(
            db,
            user_id,
            mode="composite",
            job_id=job_id,
            item_id=(trace_item_ids[position] if position < len(trace_item_ids) else None),
            filename=f"sanitized-scan-{position + 1}.jpg",
            provider=provider.name,
            model=provider.model(),
        )
        for position in range(len(images))
    ]
    catalogue_fallback_budget = CatalogueFallbackBudget()
    for trace, image in zip(traces, images):
        trace.add_secret(api_key)
        trace.set_image(image)

    try:
        cache = _load_recognition_cache(
            db,
            list(recognition_cache_item_ids or []),
            lease_token,
        )
        recognized_by_position = {
            position: cache[item_id]
            for position, item_id in enumerate(trace_item_ids)
            if item_id in cache
        }
        if recognized_by_position:
            for position, card_info in recognized_by_position.items():
                traces[position].record_cached_extraction(card_info)
        else:
            with provider.rate_limit_scope("background"):
                try:
                    recognized_by_position = await recognize_composite_card_info(
                        api_key,
                        build_composite(images),
                        len(images),
                        traces=traces,
                        provider=provider,
                        request_timeout_seconds=request_timeout_seconds,
                    )
                except CompositeRecognitionError as exc:
                    for trace in traces:
                        trace.record_error(str(exc))
                    recognized_by_position = {}
            _persist_recognition_cache(
                {
                    trace_item_ids[position]: card_info
                    for position, card_info in recognized_by_position.items()
                    if position < len(trace_item_ids)
                },
                lease_token,
            )

        results: list[dict | None] = []
        for position in range(len(images)):
            card_info = recognized_by_position.get(position)
            has_name = bool(str((card_info or {}).get("name") or "").strip())
            if not has_name:
                traces[position].record_decision("individual_fallback")
                results.append(None)
                continue
            result = await match_composite_card_info(
                db,
                card_info,
                photo_bytes=images[position],
                trace=traces[position],
                prewarm_candidates=True,
                catalogue_fallback_budget=catalogue_fallback_budget,
            )
            if not bool(result.get("_identity_confident")):
                traces[position].record_decision("individual_fallback")
            results.append(
                result
                if bool(result.get("_identity_confident"))
                else None
            )
        return results
    except Exception as exc:
        for trace in traces:
            trace.record_error(str(getattr(exc, "detail", exc)))
        raise
    finally:
        for trace in traces:
            trace.save()


def _scan_error_from_http(error: HTTPException) -> RuntimeError:
    from services.scan_providers import ScannerUnreachableError

    if isinstance(error, ScannerUnreachableError):
        return ScannerWaitingError(str(error.detail))
    if error.status_code in {429, 502, 503, 504}:
        return TransientScanError(
            str(error.detail),
            retry_after_seconds=getattr(error, "retry_after_seconds", None),
            retry_reason=getattr(error, "retry_reason", None),
        )
    if error.status_code in {400, 401, 403, 409}:
        return PermanentScanError(str(error.detail))
    return RecognitionScanError(str(error.detail))


async def process_claimed_scan_item(
    claim: ClaimedScanItem,
    *,
    processor=default_scan_processor,
    composite_processor=default_composite_processor,
) -> None:
    from database import SessionLocal

    # Bounds how many of these run at once — see MAX_CONCURRENT_SCAN_PROCESSING
    # for why: the DB session opened just below stays checked out for the
    # entire recognition call, including the slow vision-model HTTP work.
    async with _ProcessingSlots(claim):
        db = SessionLocal()
        try:
            try:
                items = _leased_items(db, claim)
                if len(items) != len(claim.all_item_ids):
                    db.rollback()
                    return
                image_bytes = [read_recognition_image(item.image_path) for item in items]
                user_id = items[0].user_id
                content_types = [item.content_type for item in items]
                job_id = items[0].job_id
                item_ids = [item.id for item in items]
                db.rollback()  # Release the row lock during upstream network work.
                if claim.composite:
                    if composite_processor is default_composite_processor:
                        results = await composite_processor(
                            db,
                            user_id,
                            image_bytes,
                            content_types,
                            job_id=job_id,
                            item_ids=item_ids,
                            lease_token=claim.lease_token,
                            recognition_cache_item_ids=claim.recognition_cache_item_ids,
                        )
                    else:
                        results = await composite_processor(
                            db, user_id, image_bytes, content_types
                        )
                else:
                    if processor is default_scan_processor:
                        result = await processor(
                            db,
                            user_id,
                            image_bytes[0],
                            content_types[0],
                            job_id=job_id,
                            item_id=item_ids[0],
                            lease_token=claim.lease_token,
                            reuse_recognition_cache=(
                                item_ids[0] in claim.recognition_cache_item_ids
                            ),
                        )
                    else:
                        result = await processor(
                            db, user_id, image_bytes[0], content_types[0]
                        )
                    results = [result]
            except HTTPException as exc:
                db.rollback()
                error = _scan_error_from_http(exc)
            except (FileNotFoundError, OSError, ScanUploadError) as exc:
                db.rollback()
                error = PermanentScanError(f"Stored scan photo is unavailable: {exc}")
            except (
                ScannerWaitingError,
                TransientScanError,
                RecognitionScanError,
                PermanentScanError,
            ) as exc:
                db.rollback()
                error = exc
            except Exception as exc:
                db.rollback()
                logger.exception("Unexpected scan processing error for item %s", claim.item_id)
                error = TransientScanError(str(exc))
            else:
                if claim.composite:
                    complete_claim_group(db, claim, results)
                else:
                    complete_claim(db, claim, results[0])
                return

            uses_recognition_cache = (
                composite_processor is default_composite_processor
                if claim.composite
                else processor is default_scan_processor
            )
            if (
                uses_recognition_cache
                and getattr(error, "retry_reason", None) != "catalogue_unavailable"
            ):
                _clear_recognition_cache(claim)

            fail_claim(
                db,
                claim,
                str(error),
                waiting=isinstance(error, ScannerWaitingError),
                transient=isinstance(error, TransientScanError),
                permanent=isinstance(error, PermanentScanError),
                retry_after_seconds=getattr(error, "retry_after_seconds", None),
                retry_reason=getattr(error, "retry_reason", None),
            )
        finally:
            db.close()


async def drain_scan_queue(
    *,
    max_items: int = 50,
    processor=default_scan_processor,
    composite_processor=default_composite_processor,
) -> int:
    """Process a bounded fair pass; concurrent workers safely skip claimed rows."""
    from database import SessionLocal

    processed = 0
    for _ in range(max_items):
        db = SessionLocal()
        try:
            recover_expired_leases(db)
            claim = claim_next_scan_item(db)
        finally:
            db.close()
        if claim is None:
            break
        await process_claimed_scan_item(
            claim,
            processor=processor,
            composite_processor=composite_processor,
        )
        processed += len(claim.all_item_ids)
        await asyncio.sleep(0)
    return processed


def resolve_scan_item(db: Session, item: ScanJobItem) -> ScanJobItem:
    """Mark one review complete and immediately remove its stored photo."""
    relative_path = item.image_path
    item.resolved = True
    item.image_path = None
    item.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(item)
    delete_scan_image(relative_path)
    return item


def retry_scan_item(db: Session, item: ScanJobItem) -> ScanJobItem:
    """Start a fresh individual recognition cycle for a reviewable item."""
    if item.resolved:
        raise ValueError("This scan has already been handled.")
    if item.status not in {"done", "failed", "retrying", "pending"}:
        raise ValueError("This scan is still being processed.")
    if not item.image_path or not resolve_scan_path(item.image_path).is_file():
        raise ValueError("The stored scan photo is no longer available.")

    now = datetime.datetime.utcnow()
    item.status = "pending"
    item.attempts = 0
    item.transient_failures = 0
    item.next_attempt_at = now
    item.retry_reason = None
    item.lease_token = None
    item.lease_expires_at = None
    item.recognized = None
    item.matches = None
    item.error = None
    item.batch_mode = False
    item.updated_at = now
    item.job.status = "pending"
    item.job.finished_at = None
    item.job.error_message = None
    item.job.updated_at = now
    db.commit()
    db.refresh(item)
    return item


def waiting_scan_count(db: Session) -> int:
    return (
        db.query(ScanJobItem)
        .filter(
            ScanJobItem.status == "retrying",
            ScanJobItem.retry_reason == WAITING_REASON,
        )
        .count()
    )


def hold_expiry_for_waiting_scans(
    db: Session, *, now: datetime.datetime | None = None
) -> int:
    """Pause the 14-day clock for jobs whose scans are waiting for the scanner.

    The expiry is kept at least WAITING_EXPIRY_GRACE_DAYS ahead, so a scan that
    was never recognised is not deleted unseen, and still has time to run once
    the scanner is back. Call this before purge_expired_scan_jobs().
    """
    now = now or datetime.datetime.utcnow()
    floor = now + datetime.timedelta(days=WAITING_EXPIRY_GRACE_DAYS)
    job_ids = [
        row[0]
        for row in db.query(ScanJobItem.job_id)
        .filter(
            ScanJobItem.status == "retrying",
            ScanJobItem.retry_reason == WAITING_REASON,
        )
        .distinct()
        .all()
    ]
    if not job_ids:
        return 0
    updated = (
        db.query(ScanJob)
        .filter(ScanJob.id.in_(job_ids), ScanJob.expires_at < floor)
        .update({ScanJob.expires_at: floor}, synchronize_session=False)
    )
    db.commit()
    return updated


def release_waiting_scans(
    db: Session, *, now: datetime.datetime | None = None
) -> int:
    """Put every scan that was waiting for the scanner back in the queue."""
    now = now or datetime.datetime.utcnow()
    items = (
        db.query(ScanJobItem)
        .filter(
            ScanJobItem.status == "retrying",
            ScanJobItem.retry_reason == WAITING_REASON,
        )
        .all()
    )
    for item in items:
        item.status = "pending"
        item.retry_reason = None
        item.next_attempt_at = now
        item.updated_at = now
    if items:
        db.commit()
    return len(items)


async def release_waiting_scans_if_reachable(db: Session) -> int:
    """Once-a-minute check: free all waiting scans as soon as the endpoint answers."""
    if waiting_scan_count(db) == 0:
        return 0
    from services.scan_providers import openai_base_url

    if not await endpoint_reachable(openai_base_url(), force=True):
        return 0
    return release_waiting_scans(db)


def purge_expired_scan_jobs(db: Session, *, now: datetime.datetime | None = None) -> int:
    """Delete every job and review photo at its fixed 14-day expiry."""
    now = now or datetime.datetime.utcnow()
    jobs = db.query(ScanJob).filter(ScanJob.expires_at <= now).all()
    job_ids = [job.id for job in jobs]
    for job in jobs:
        db.delete(job)
    db.commit()
    for job_id in job_ids:
        delete_job_directory(job_id)
    return len(job_ids)


def job_progress(db: Session, job: ScanJob) -> dict:
    items = db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).all()
    counts = {status: sum(1 for item in items if item.status == status) for status in {
        "pending", "processing", "retrying", "done", "failed"
    }}
    active = counts["pending"] + counts["processing"] + counts["retrying"]
    failed_attention = sum(
        1
        for item in items
        if not item.resolved and item.status == "failed"
    )
    attention = sum(
        1
        for item in items
        if not item.resolved and item.status in {"done", "failed"}
    )
    next_retry_item = min(
        (
            item
            for item in items
            if item.status == "retrying" and item.next_attempt_at is not None
        ),
        key=lambda item: item.next_attempt_at,
        default=None,
    )
    waiting_count = sum(
        1
        for item in items
        if item.status == "retrying" and item.retry_reason == WAITING_REASON
    )
    return {
        "id": job.id,
        "status": job.status,
        "total": len(items),
        **counts,
        "processed": counts["done"] + counts["failed"],
        "active": active,
        "attention": attention,
        "failed_attention": failed_attention,
        "next_retry_at": (
            next_retry_item.next_attempt_at.isoformat() if next_retry_item else None
        ),
        "retry_reason": (
            WAITING_REASON
            if waiting_count and waiting_count == counts["retrying"]
            else (next_retry_item.retry_reason if next_retry_item else None)
        ),
        "waiting_for_scanner": waiting_count,
        # Kept as a stable alias for badge clients built against Lamiskin's
        # original queue payload.
        "unresolved": attention,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "expires_at": job.expires_at.isoformat() if job.expires_at else None,
        "error_message": job.error_message,
    }
