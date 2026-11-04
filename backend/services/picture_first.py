"""Picture match first, Ollama as the fallback (docs/CARD_MATCH.md, "Picture match first").

A server switch (admin setting ``scan_picture_first``; default from the ``SCAN_PICTURE_FIRST`` environment
variable, on only in docker-compose.nonprod.yml). With it on, the scan queue runs the picture matcher on the
recognition image before it calls the scanner:

* the matcher decides      -> done in well under a second, the scanner is not called  (path ``decided``)
* unsure, scanner reachable -> the scanner runs as before, with the matcher's top matches as extra candidates
                               (path ``unsure_ollama``)
* unsure, scanner down      -> the scan goes to the inbox now with the matcher's best matches, and the trainer
                               may press "Wait for the scanner"  (path ``unsure_inbox``)
* model/index not ready, an error, a timeout, the switch off -> exactly today's behaviour.

The matcher never blocks the queue: one run at a time per process on a single worker thread (the matcher's own
3-thread cap applies inside it), a few seconds at most, and any failure returns ``None`` so the caller falls
through to the old path. Nothing here writes to ``card_match``.

The path is stored with the scan (``recognized["_picture"]``) and in the diagnostics trace (``picture_match``);
the Scanner lab counts them over the last 7 days, including how often the trainer then confirmed a different card
than the picture decided.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import datetime
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)

SETTING_KEY = "scan_picture_first"
TRUE = {"1", "true", "yes", "on"}

PATH_DECIDED = "decided"
PATH_OLLAMA = "unsure_ollama"
PATH_INBOX = "unsure_inbox"

MATCH_IMAGE_MAX_SIDE = 2048  # the same decode the shadow run and the benchmark use
INBOX_MATCH_LIMIT = 12  # matches shown when the scan goes to the inbox unsure
DECIDED_MATCH_LIMIT = 8
EXTRA_CANDIDATE_LIMIT = 6  # picture matches added to the scanner's own candidates
LAB_WINDOW_DAYS = 7


def timeout_seconds() -> float:
    try:
        return max(0.5, min(30.0, float(os.environ.get("SCAN_PICTURE_FIRST_TIMEOUT_SECONDS", "5"))))
    except ValueError:
        return 5.0


def env_default() -> bool:
    return os.environ.get("SCAN_PICTURE_FIRST", "").strip().lower() in TRUE


def enabled(db) -> bool:
    """The admin's choice when there is one, else the environment default. Never raises."""
    try:
        from models import Setting

        row = db.query(Setting).filter(Setting.key == SETTING_KEY).first()
        if row is not None:
            return str(row.value).strip().lower() in TRUE
    except Exception:
        logger.exception("Could not read the picture-first setting")
    return env_default()


def _default_factory():
    from services.card_match.shadow import default_matcher

    return default_matcher()


# Tests replace this. It returns (matcher, None) or (None, reason).
matcher_factory: Callable[[], tuple] = _default_factory

_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="picture-first")


@dataclass
class PictureRun:
    """What one matcher run produced."""

    result: Any  # card_match.pipeline.MatchResult
    elapsed_ms: float
    matcher: Any = None
    input_info: dict = field(default_factory=dict)

    @property
    def decided(self) -> bool:
        return self.result.status == "decided" and bool(self.result.decision)


def _run_blocking(image_bytes: bytes, deadline: float, full_bytes: bytes | None = None):
    from services.card_match.images import decode_rgb

    if time.monotonic() >= deadline:
        return None  # waited in line past its time: the caller already moved on
    matcher, reason = matcher_factory()
    if matcher is None:
        logger.info("Picture match not ready: %s", reason)
        return None
    photo = decode_rgb(image_bytes, max_side=MATCH_IMAGE_MAX_SIDE)
    full_photo = None
    if full_bytes:
        try:  # only sharpens the text reading; the shadow run and the benchmark read the same way
            full_photo = decode_rgb(full_bytes, max_side=MATCH_IMAGE_MAX_SIDE)
        except Exception:
            full_photo = None
    started = time.perf_counter()
    result = matcher.match(photo, full_photo=full_photo) if full_photo is not None else matcher.match(photo)
    elapsed = (time.perf_counter() - started) * 1000
    info = {"bytes": len(image_bytes), "width": int(photo.shape[1]), "height": int(photo.shape[0])}
    return PictureRun(result=result, elapsed_ms=round(elapsed, 1), matcher=matcher, input_info=info)


async def run_matcher(image_bytes: bytes, full_bytes: bytes | None = None) -> PictureRun | None:
    """Run the matcher on one recognition image (``full_bytes``: the full-resolution photo, for reading the
    text). ``None`` when it is not ready, failed or took too long."""
    limit = timeout_seconds()
    deadline = time.monotonic() + limit
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(loop.run_in_executor(_executor, _run_blocking, image_bytes, deadline, full_bytes), timeout=limit)
    except asyncio.TimeoutError:
        logger.warning("Picture match took longer than %.1f s; using the scanner path", limit)
    except Exception as exc:
        logger.warning("Picture match failed (%s); using the scanner path", type(exc).__name__)
    return None


# ── Turning the matcher's answer into what the review reads ──────────────────

def _load_candidates(db, matches: list[dict], first_id: str | None, limit: int) -> list[dict]:
    """The scan review's candidate dicts for the matcher's matches, ``first_id`` (a card id) first."""
    from models import Card, Set

    ordered = [m for m in matches if m.get("card_id")]
    if first_id:
        ordered.sort(key=lambda m: 0 if m["card_id"] == first_id else 1)  # stable: similarity order otherwise
    ordered = ordered[:limit]
    ids = [m["card_id"] for m in ordered]
    if not ids:
        return []
    cards = {card.id: card for card in db.query(Card).filter(Card.id.in_(ids)).all()}
    set_ids = {card.set_id for card in cards.values() if card.set_id}
    sets = {}
    if set_ids:
        for row in db.query(Set).filter(Set.tcg_set_id.in_(set_ids)):
            sets[(row.tcg_set_id, row.lang)] = row
    out = []
    for match in ordered:
        card = cards.get(match["card_id"])
        if card is None:
            continue
        lang = card.lang or "en"
        local_set = sets.get((card.set_id, lang))
        out.append({
            "id": card.id,
            "tcg_card_id": card.tcg_card_id or match.get("tcg_card_id"),
            "name": card.name,
            "card_type": card.supertype,
            "set": local_set.name if local_set else match.get("set"),
            "set_abbreviation": local_set.abbreviation if local_set else None,
            "printed_total": ((local_set.printed_total or None) if local_set else None) or match.get("printed_total"),
            "number": card.number,
            "image": card.images_small or card.custom_image_url,
            "image_hd": card.images_large or card.custom_image_url,
            "rarity": card.rarity,
            "lang": lang,
            "_lang": lang,
            "_number_extra": False,
            "_gallery_alternative": False,
        })
    return out


def _meta(run: PictureRun, path: str, **extra) -> dict:
    result = run.result
    decision = result.decision or {}
    meta = {
        "path": path,
        "mechanism": decision.get("mechanism"),
        "similarity": decision.get("similarity"),
        "unsure_reason": result.unsure_reason,
        "ms": run.elapsed_ms,
        "top": (result.matches[0].get("tcg_card_id") if result.matches else None),
    }
    if decision:
        meta["decided_card"] = decision.get("tcg_card_id")
    meta.update(extra)
    return meta


def decided_result(db, run: PictureRun, *, earlier: dict | None = None) -> dict | None:
    """The queue result for a scan the matcher decided, or None when its card cannot be loaded."""
    from api.recognize import normalize_recognized_card_info

    decision = run.result.decision
    candidates = _load_candidates(db, run.result.matches, decision["card_id"], DECIDED_MATCH_LIMIT)
    if not candidates or candidates[0]["id"] != decision["card_id"]:
        return None
    card = candidates[0]
    recognized = normalize_recognized_card_info({
        "name": card["name"], "name_en": card["name"], "language": "en",
        "number_local": card["number"], "number_total": card.get("printed_total"),
    })
    recognized["_picture"] = _meta(run, PATH_DECIDED, **_carry(earlier))
    return {"recognized": recognized, "matches": candidates}


def inbox_result(db, run: PictureRun, *, earlier: dict | None = None) -> dict | None:
    """The queue result for an unsure scan that goes to the inbox while the scanner is down."""
    candidates = _load_candidates(db, run.result.matches, None, INBOX_MATCH_LIMIT)
    if not candidates:
        return None
    return {
        "recognized": {"language": "en", "_picture": _meta(run, PATH_INBOX, **_carry(earlier))},
        "matches": candidates,
    }


def attach_to_scanner_result(db, result: dict, run: PictureRun, *, earlier: dict | None = None) -> None:
    """Unsure, scanner answered: keep its result, add the matcher's top matches it did not already list."""
    try:
        present = {str(match.get("tcg_card_id") or "") for match in result.get("matches") or []}
        extra_matches = [m for m in run.result.matches if str(m.get("tcg_card_id") or "") not in present]
        extras = _load_candidates(db, extra_matches, None, EXTRA_CANDIDATE_LIMIT)
        if extras and not result.get("_identity_confident"):
            result["matches"] = list(result.get("matches") or []) + extras
        recognized = result.get("recognized")
        if isinstance(recognized, dict):
            recognized["_picture"] = _meta(run, PATH_OLLAMA, extra_candidates=len(extras), **_carry(earlier))
    except Exception:
        logger.exception("Could not add the picture matches to the scanner result")


def _carry(earlier: dict | None) -> dict:
    """Remember across a "Wait for the scanner" that the scan first went to the inbox."""
    if isinstance(earlier, dict) and (earlier.get("path") == PATH_INBOX or earlier.get("was_inbox")):
        return {"was_inbox": True}
    return {}


def earlier_picture(recognized) -> dict | None:
    picture = recognized.get("_picture") if isinstance(recognized, dict) else None
    return picture if isinstance(picture, dict) else None


# ── Trace ────────────────────────────────────────────────────────────────────

def record_in_trace(trace, user_id: int, job_id, item_id, run: PictureRun, meta: dict, selected: str | None = None) -> None:
    """Trace entry for the path taken, plus the shadow-mode record when that is on (so shadow keeps working)."""
    try:
        trace.record_picture_match(meta)
        if selected is not None:
            trace.record_decision("picture_match", selected)
        from services.card_match import config

        if trace.enabled and config.shadow_enabled() and job_id and item_id:
            from services import scan_trace
            from services.card_match import shadow

            if not scan_trace.has_shadow(user_id, job_id, item_id):
                scan_trace.record_shadow(
                    user_id, job_id, item_id,
                    shadow._shadow_payload(run.result, input_info=run.input_info, matcher=run.matcher),
                )
                shadow.store_text_card(user_id, job_id, item_id, run.result)
    except Exception:
        logger.exception("Could not record the picture match in the trace")


# ── Wait for the scanner ─────────────────────────────────────────────────────

def can_wait(item) -> bool:
    """A scan the picture sent to the inbox unsure, still unresolved with its photo kept."""
    picture = earlier_picture(item.recognized)
    return bool(
        picture and picture.get("path") == PATH_INBOX and item.status == "done" and not item.resolved and item.image_path
    )


def put_back_to_wait(db, item) -> None:
    """Back to the waiting state; released once the scanner answers, like any scan parked there."""
    from services.scanner_reachability import WAITING_REASON

    now = datetime.datetime.utcnow()
    picture = dict(earlier_picture(item.recognized) or {})
    picture["wait"] = True  # the next run must not send it to the inbox again
    item.recognized = {**(item.recognized or {}), "_picture": picture}
    item.status = "retrying"
    item.retry_reason = WAITING_REASON
    item.next_attempt_at = None
    item.error = None
    item.updated_at = now
    job = item.job
    job.status = "pending"
    job.finished_at = None
    job.updated_at = now
    db.commit()


def record_confirmation(item, confirmed_card_id: str) -> None:
    """Remember which card the trainer added, next to what the picture decided (for the lab's error rate)."""
    picture = earlier_picture(item.recognized)
    if picture is None:
        return
    item.recognized = {**item.recognized, "_picture": {**picture, "confirmed": confirmed_card_id}}


# ── Scanner lab ──────────────────────────────────────────────────────────────

def lab_counts(db, *, now: datetime.datetime | None = None) -> dict:
    """Paths taken over the last 7 days, from the scans themselves (they live 14 days)."""
    from models import ScanJobItem

    now = now or datetime.datetime.utcnow()
    cutoff = now - datetime.timedelta(days=LAB_WINDOW_DAYS)
    counts = {"decided": 0, "ollama": 0, "inbox": 0, "decided_confirmed": 0, "picked_different": 0}
    rows = db.query(ScanJobItem.recognized).filter(ScanJobItem.created_at >= cutoff, ScanJobItem.recognized.isnot(None)).all()
    for (recognized,) in rows:
        picture = earlier_picture(recognized)
        if not picture:
            continue
        path = picture.get("path")
        if path == PATH_DECIDED:
            counts["decided"] += 1
            if picture.get("confirmed"):
                counts["decided_confirmed"] += 1
                if picture["confirmed"] != picture.get("decided_card"):
                    counts["picked_different"] += 1
        elif path == PATH_OLLAMA:
            counts["ollama"] += 1
        if path == PATH_INBOX or picture.get("was_inbox"):
            counts["inbox"] += 1
    counts["days"] = LAB_WINDOW_DAYS
    counts["error_pct"] = round(100 * counts["picked_different"] / counts["decided_confirmed"], 1) if counts["decided_confirmed"] else None
    return counts
