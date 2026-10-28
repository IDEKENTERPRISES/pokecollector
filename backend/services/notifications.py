"""Notification categories, per-user preferences, quiet hours and the daily digest.

See docs/ENGAGEMENT_DESIGN.md §7 P4. Instant categories (scans ready) are queued and sent by
`flush_due` as soon as quiet hours allow; digest categories (new sets, wishlist dips, big movers)
are queued and sent as one push a day at the user's digest time. Payloads carry no prices.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
from dataclasses import dataclass
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

from models import (
    Card, CollectionItem, NotificationQueue, Set, User, UserAchievement, UserSetting, WishlistItem,
)
from services import push, telegram
from services.card_values import effective_market_price, normalize_price_field

logger = logging.getLogger(__name__)

INSTANT = "instant"
DIGEST = "digest"

# Constants from the design doc.
DIP_PERCENT = 15.0
DIP_MIN_EUR = 1.0
MOVER_DEFAULT_PERCENT = 10.0
MOVER_MIN_EUR = 2.0
REPEAT_DAYS = 7
DEFAULT_DIGEST_HOUR = 18
QUIET_START_HOUR = 22
QUIET_END_HOUR = 8
QUEUE_RETENTION_DAYS = 30

TIME_ZONE_KEY = "time_zone"
DIGEST_HOUR_KEY = "notify_digest_hour"
QUIET_ENABLED_KEY = "notify_quiet_hours"
LAST_DIGEST_KEY = "notify_last_digest"


@dataclass(frozen=True)
class Category:
    id: str
    default: bool
    timing: str | None  # None: not wired yet (a later phase turns it on)
    navigate: str
    digest_text: str  # singular/plural handled by `_digest_line`


# Later phases (badges P6, goals P10, swap offers P11, weekly recap P9) add their entry here
# with a `timing`; the Settings UI shows a row only for categories in `UI_CATEGORIES`.
CATEGORIES: dict[str, Category] = {
    "scans_ready": Category("scans_ready", True, INSTANT, "/scans", "scan"),
    "wishlist_alerts": Category("wishlist_alerts", True, INSTANT, "/wishlist", "price alert"),
    "new_sets": Category("new_sets", True, DIGEST, "/sets", "new set"),
    "wishlist_dips": Category("wishlist_dips", True, DIGEST, "/wishlist", "wishlist dip"),
    "big_movers": Category("big_movers", False, DIGEST, "/collection", "big mover"),
    "weekly_recap": Category("weekly_recap", False, None, "/", "recap"),
    "badges": Category("badges", True, INSTANT, "/achievements", "badge"),
    "goal_milestones": Category("goal_milestones", True, None, "/", "goal"),
    "swap_offers": Category("swap_offers", True, None, "/", "swap offer"),
}
UI_CATEGORIES = [c.id for c in CATEGORIES.values() if c.timing]


def pref_key(category: str) -> str:
    return f"notify_{category}"


def default_settings() -> dict[str, str]:
    """Defaults merged into the settings API response."""
    defaults = {pref_key(c.id): "true" if c.default else "false" for c in CATEGORIES.values()}
    defaults[DIGEST_HOUR_KEY] = str(DEFAULT_DIGEST_HOUR)
    defaults[QUIET_ENABLED_KEY] = "true"
    return defaults


def boolean_keys() -> set[str]:
    return {pref_key(c.id) for c in CATEGORIES.values()} | {QUIET_ENABLED_KEY}


def normalize_digest_hour(value) -> str:
    """Digest hour as a string, kept outside quiet hours (08–21)."""
    try:
        hour = int(str(value).split(":")[0])
    except (TypeError, ValueError):
        hour = DEFAULT_DIGEST_HOUR
    return str(min(max(hour, QUIET_END_HOUR), QUIET_START_HOUR - 1))


def _setting(db: Session, user_id: int, key: str) -> str | None:
    row = db.query(UserSetting).filter(UserSetting.user_id == user_id, UserSetting.key == key).first()
    return row.value if row else None


def _set_setting(db: Session, user_id: int, key: str, value: str) -> None:
    row = db.query(UserSetting).filter(UserSetting.user_id == user_id, UserSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(UserSetting(user_id=user_id, key=key, value=value))


def category_enabled(db: Session, user_id: int, category: str) -> bool:
    spec = CATEGORIES[category]
    value = _setting(db, user_id, pref_key(category))
    if value is None:
        return spec.default
    return value.strip().lower() in {"true", "1", "yes", "on"}


def digest_hour(db: Session, user_id: int) -> int:
    return int(normalize_digest_hour(_setting(db, user_id, DIGEST_HOUR_KEY)))


def quiet_hours_enabled(db: Session, user_id: int) -> bool:
    value = _setting(db, user_id, QUIET_ENABLED_KEY)
    return True if value is None else value.strip().lower() in {"true", "1", "yes", "on"}


def server_zone() -> datetime.tzinfo:
    name = os.getenv("TZ", "").strip()
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            pass
    return datetime.datetime.now().astimezone().tzinfo or datetime.timezone.utc


def user_zone(db: Session, user_id: int) -> datetime.tzinfo:
    name = _setting(db, user_id, TIME_ZONE_KEY)
    if name:
        try:
            return ZoneInfo(name.strip())
        except (ZoneInfoNotFoundError, ValueError, OSError):
            pass
    return server_zone()


def _utc(dt: datetime.datetime) -> datetime.datetime:
    return dt.replace(tzinfo=datetime.timezone.utc)


def local_now(now: datetime.datetime, zone: datetime.tzinfo) -> datetime.datetime:
    """`now` is naive UTC; returns the aware local time."""
    return _utc(now).astimezone(zone)


def in_quiet_hours(now: datetime.datetime, zone: datetime.tzinfo) -> bool:
    hour = local_now(now, zone).hour
    return hour >= QUIET_START_HOUR or hour < QUIET_END_HOUR


def quiet_hours_end(now: datetime.datetime, zone: datetime.tzinfo) -> datetime.datetime:
    """Naive UTC time at which the quiet window that contains `now` ends (08:00 local)."""
    local = local_now(now, zone)
    end = local.replace(hour=QUIET_END_HOUR, minute=0, second=0, microsecond=0)
    if local.hour >= QUIET_START_HOUR:
        end += datetime.timedelta(days=1)
    return end.astimezone(datetime.timezone.utc).replace(tzinfo=None)


def send_time_for_instant(db: Session, user_id: int, now: datetime.datetime) -> datetime.datetime:
    if quiet_hours_enabled(db, user_id):
        zone = user_zone(db, user_id)
        if in_quiet_hours(now, zone):
            return quiet_hours_end(now, zone)
    return now


# --- queue ------------------------------------------------------------------------------


def enqueue(
    db: Session,
    user_id: int,
    category: str,
    subject_key: str,
    *,
    now: datetime.datetime | None = None,
    repeat_days: int | None = None,
) -> bool:
    """Queue one notification unless the category is off or the subject was already queued.

    `repeat_days=None` means once ever for the subject; otherwise once per that many days.
    The caller commits.
    """
    now = now or datetime.datetime.utcnow()
    if not category_enabled(db, user_id, category):
        return False
    seen = db.query(NotificationQueue).filter(
        NotificationQueue.user_id == user_id,
        NotificationQueue.category == category,
        NotificationQueue.subject_key == subject_key,
    )
    if repeat_days is not None:
        seen = seen.filter(NotificationQueue.created_at > now - datetime.timedelta(days=repeat_days))
    if seen.first() is not None:
        return False
    send_after = send_time_for_instant(db, user_id, now) if CATEGORIES[category].timing == INSTANT else now
    db.add(NotificationQueue(
        user_id=user_id, category=category, subject_key=subject_key, created_at=now, send_after=send_after,
    ))
    return True


def notify_wishlist_alert(db: Session, user_id: int, card_id: str, now: datetime.datetime | None = None) -> bool:
    """A wishlist price threshold was crossed. The payload (card name only) is built when it is sent."""
    return enqueue(db, user_id, "wishlist_alerts", f"card:{card_id}", now=now, repeat_days=1)


def notify_scans_ready(db: Session, user_id: int, job_id: int, now: datetime.datetime | None = None) -> bool:
    """Called when a scan job needs review; one push per job."""
    return enqueue(db, user_id, "scans_ready", f"job:{job_id}", now=now)


def _active_user_ids(db: Session) -> list[int]:
    return [uid for (uid,) in db.query(User.id).filter(User.is_active == True).all()]  # noqa: E712


def on_new_sets(db: Session, set_ids: list[str]) -> None:
    """New sets were marked `is_new`: Telegram (respects TELEGRAM_ENABLED) and a digest entry per user."""
    if not set_ids:
        return
    rows = db.query(Set).filter(Set.id.in_(set_ids)).all()
    new_sets = [{"name": s.name, "series": s.series or ""} for s in rows]
    for user_id in _active_user_ids(db):
        if not category_enabled(db, user_id, "new_sets"):
            continue
        try:
            telegram.send_new_sets_notification(new_sets, db=db, user_id=user_id)
        except Exception:
            logger.exception("Telegram new-sets notification failed for user %s", user_id)
        for s in rows:
            enqueue(db, user_id, "new_sets", f"set:{s.id}")
    db.commit()


def on_new_sets_safely(db: Session, set_ids: list[str]) -> None:
    try:
        on_new_sets(db, set_ids)
    except Exception:
        db.rollback()
        logger.exception("Could not queue new-set notifications")


# --- price events (dips, movers) ---------------------------------------------------------


def is_dip(price, avg30) -> bool:
    """At least 15 % below the 30-day average and at least €1 lower."""
    if not price or not avg30 or price <= 0 or avg30 <= 0:
        return False
    drop = avg30 - price
    return drop >= DIP_MIN_EUR and drop / avg30 * 100 >= DIP_PERCENT


def is_big_move(price, baseline, threshold_percent) -> bool:
    """Moved by at least `threshold_percent` and at least €2, either direction."""
    if not price or not baseline or price <= 0 or baseline <= 0:
        return False
    change = abs(price - baseline)
    return change >= MOVER_MIN_EUR and change / baseline * 100 >= threshold_percent


def mover_threshold(db: Session, user_id: int) -> float:
    """The (formerly unused) `price_alert_threshold`, per user, default 10 %."""
    try:
        value = float(_setting(db, user_id, "price_alert_threshold") or MOVER_DEFAULT_PERCENT)
    except ValueError:
        return MOVER_DEFAULT_PERCENT
    return value if value > 0 else MOVER_DEFAULT_PERCENT


def _price_field(db: Session, user_id: int) -> str:
    return normalize_price_field(_setting(db, user_id, "price_primary") or "price_trend")


def queue_price_events(db: Session, card_ids: list[str], now: datetime.datetime | None = None) -> int:
    """Queue wishlist dips and big movers for the updated cards. Returns the number queued."""
    if not card_ids:
        return 0
    now = now or datetime.datetime.utcnow()
    queued = 0
    ids = list(card_ids)

    wishlist = db.query(WishlistItem).join(Card, Card.id == WishlistItem.card_id).filter(
        WishlistItem.card_id.in_(ids)
    ).all()
    for item in wishlist:
        if not category_enabled(db, item.user_id, "wishlist_dips"):
            continue
        price = effective_market_price(item.card, price_field=_price_field(db, item.user_id))
        if is_dip(price, item.card.price_avg30):
            queued += enqueue(
                db, item.user_id, "wishlist_dips", f"card:{item.card_id}", now=now, repeat_days=REPEAT_DAYS
            )

    owned = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).filter(
        CollectionItem.card_id.in_(ids)
    ).all()
    seen: set[tuple[int, str]] = set()
    for item in owned:
        key = (item.user_id, item.card_id)
        if key in seen or not category_enabled(db, item.user_id, "big_movers"):
            continue
        seen.add(key)
        price = effective_market_price(item.card, price_field=_price_field(db, item.user_id))
        if is_big_move(price, item.card.price_avg7, mover_threshold(db, item.user_id)):
            queued += enqueue(
                db, item.user_id, "big_movers", f"card:{item.card_id}", now=now, repeat_days=REPEAT_DAYS
            )
    db.commit()
    return queued


def queue_price_events_safely(db: Session, card_ids: list[str]) -> None:
    try:
        queue_price_events(db, card_ids)
    except Exception:
        db.rollback()
        logger.exception("Could not queue price notifications")


# --- sending -----------------------------------------------------------------------------


def _digest_line(category: str, count: int) -> str:
    noun = CATEGORIES[category].digest_text
    return f"{count} {noun}{'' if count == 1 else 's'}"


def build_digest_payload(counts: dict[str, int]) -> str | None:
    """One content-light push for the day: counts only, never prices or card names."""
    counts = {c: n for c, n in counts.items() if n > 0 and c in CATEGORIES}
    if not counts:
        return None
    body = ", ".join(_digest_line(c, n) for c, n in counts.items())
    navigate = CATEGORIES[next(iter(counts))].navigate if len(counts) == 1 else "/"
    return push._encode_payload("PokéCollector", body, navigate)


def build_scans_payload(count: int) -> str:
    """Actionable: carries the icon number so the service worker can set the app badge."""
    payload = json.loads(push._encode_payload("PokéCollector", "Scans ready to review", CATEGORIES["scans_ready"].navigate))
    payload["app_badge"] = int(count)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def build_badge_payload() -> str:
    """Content-light: it never names the badge."""
    return push._encode_payload("PokéCollector", "You earned a badge", CATEGORIES["badges"].navigate)


def scans_needing_review(db: Session, user_id: int) -> int:
    """The icon number: unresolved finished items of this user's scan jobs."""
    from models import ScanJobItem

    return db.query(ScanJobItem).filter(
        ScanJobItem.user_id == user_id,
        ScanJobItem.resolved == False,  # noqa: E712
        ScanJobItem.status.in_(("done", "failed")),
    ).count()


def _mark_sent(rows, now: datetime.datetime) -> None:
    for row in rows:
        row.sent_at = now


def _send(db: Session, user_id: int, payload: str) -> None:
    try:
        push.send_to_user(db, user_id, payload)
    except Exception:
        logger.exception("Web push failed for user %s", user_id)


def flush_due(db: Session, now: datetime.datetime | None = None) -> dict:
    """Send what is due. Run every minute by the scheduler."""
    now = now or datetime.datetime.utcnow()
    result = {"instant": 0, "digests": 0}

    due = db.query(NotificationQueue).filter(
        NotificationQueue.sent_at.is_(None), NotificationQueue.send_after <= now
    ).order_by(NotificationQueue.id).all()

    by_user_digest: dict[int, list[NotificationQueue]] = {}
    for row in due:
        spec = CATEGORIES.get(row.category)
        if spec is None or spec.timing is None:
            continue
        if spec.timing == INSTANT:
            _flush_instant(db, row, now, result)
        else:
            by_user_digest.setdefault(row.user_id, []).append(row)

    for user_id, rows in by_user_digest.items():
        _flush_digest(db, user_id, rows, now, result)

    cutoff = now - datetime.timedelta(days=QUEUE_RETENTION_DAYS)
    db.query(NotificationQueue).filter(NotificationQueue.created_at < cutoff).delete(synchronize_session=False)
    db.commit()
    return result


def _flush_instant(db: Session, row: NotificationQueue, now: datetime.datetime, result: dict) -> None:
    if quiet_hours_enabled(db, row.user_id):
        zone = user_zone(db, row.user_id)
        if in_quiet_hours(now, zone):
            row.send_after = quiet_hours_end(now, zone)
            return
    count = scans_needing_review(db, row.user_id) if row.category == "scans_ready" else 0
    row.sent_at = now
    if not category_enabled(db, row.user_id, row.category):
        return
    if row.category == "scans_ready":
        if count <= 0:  # already reviewed
            return
        _send(db, row.user_id, build_scans_payload(count))
        result["instant"] += 1
    elif row.category == "wishlist_alerts":
        card = db.query(Card).filter(Card.id == row.subject_key.split("card:", 1)[-1]).first()
        _send(db, row.user_id, push.build_price_alert_payload(card.name if card else ""))
        result["instant"] += 1
    elif row.category == "badges":
        achievement_id = row.subject_key.split("badge:", 1)[-1]
        pending = db.query(UserAchievement).filter_by(
            user_id=row.user_id, achievement_id=achievement_id, seen_at=None
        ).first()
        if pending is None:  # the trainer already saw the sheet
            return
        _send(db, row.user_id, build_badge_payload())
        result["instant"] += 1


def _flush_digest(db: Session, user_id: int, rows, now: datetime.datetime, result: dict) -> None:
    zone = user_zone(db, user_id)
    local = local_now(now, zone)
    hour = digest_hour(db, user_id)
    today = local.date().isoformat()
    # Only inside the daily window (digest hour up to quiet hours) and at most once a day.
    if not (hour <= local.hour < QUIET_START_HOUR):
        return
    if _setting(db, user_id, LAST_DIGEST_KEY) == today:
        return
    counts: dict[str, int] = {}
    for row in rows:
        if category_enabled(db, user_id, row.category):
            counts[row.category] = counts.get(row.category, 0) + 1
    _mark_sent(rows, now)
    payload = build_digest_payload(counts)
    if payload:
        _send(db, user_id, payload)
        _set_setting(db, user_id, LAST_DIGEST_KEY, today)
        result["digests"] += 1


def job_needs_review(db: Session, job_id: int) -> bool:
    from models import ScanJobItem

    return db.query(ScanJobItem).filter(
        ScanJobItem.job_id == job_id,
        ScanJobItem.resolved == False,  # noqa: E712
        ScanJobItem.status.in_(("done", "failed")),
    ).first() is not None


def on_scan_job_finished(db: Session, job, now: datetime.datetime | None = None) -> None:
    """A scan job reached "needs review". Queues one push per job; never raises into the scan queue."""
    try:
        with db.begin_nested():
            if job_needs_review(db, job.id):
                notify_scans_ready(db, job.user_id, job.id, now=now)
    except Exception:
        logger.exception("Could not queue the scans-ready notification for job %s", getattr(job, "id", None))
