"""Notification categories, per-user preferences, quiet hours and the daily digest.

See docs/ENGAGEMENT_DESIGN.md §7 P4. Instant categories (scans ready, wishlist price alerts, badges)
are queued and sent by `flush_due` as soon as quiet hours allow; digest categories (new sets,
wishlist dips, big movers) are queued and sent as one push a day at the user's digest time.

Each queued row keeps `details`, what the event was about as it was when it happened (card name,
prices, badge id, ...). Pushes say what they are about by default; a trainer who switches off
"Show card names and prices" (`notify_show_details`) gets the content-light texts instead.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
from dataclasses import dataclass
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

from models import (
    Card, CollectionItem, NotificationQueue, Set, User, UserAchievement, UserSetting, WishlistItem,
)
from services import push, telegram
from services.job_isolation import trainer_savepoint
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

# Reactions and comments on a trainer's feed events (docs/SOCIAL_DESIGN.md §6.7).
# The first activity on an event pushes at once; more within this many seconds folds into one follow-up push.
# The scheduler's notification job runs every 30 s, so the follow-up leaves within about a minute of the window ending.
FEED_PUSH_WINDOW_SECONDS = 30
# Most pushes of this category per trainer per rolling hour; the rest waits as one summary.
FEED_PUSH_HOURLY_CAP = 6
FEED_PUSH_CAP_WINDOW_MINUTES = 60

TIME_ZONE_KEY = "time_zone"
DIGEST_HOUR_KEY = "notify_digest_hour"
QUIET_ENABLED_KEY = "notify_quiet_hours"
LAST_DIGEST_KEY = "notify_last_digest"
SHOW_DETAILS_KEY = "notify_show_details"

# Lock-screen friendly: the service worker clips a body at 300 characters, so lists are fitted
# to that, with "and N more" for the rest. push.MAX_PAYLOAD_BYTES is the hard limit on top.
MAX_BODY_CHARS = 300
MAX_NAME_CHARS = 40


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
    "weekly_recap": Category("weekly_recap", False, INSTANT, "/", "recap"),
    "wrapped": Category("wrapped", True, INSTANT, "/", "Wrapped"),
    "badges": Category("badges", True, INSTANT, "/achievements", "badge"),
    "goal_milestones": Category("goal_milestones", True, INSTANT, "/goals", "goal"),
    "swap_offers": Category("swap_offers", True, INSTANT, "/trades/offers", "swap offer"),
    "feed_activity": Category("feed_activity", True, INSTANT, "/leaderboard/activity", "reaction or comment"),
    "announcements": Category("announcements", True, INSTANT, "/", "announcement"),
}

# Routes an administrator may point an announcement at (never free-text URLs).
ANNOUNCEMENT_ROUTES = ("/", "/sets", "/wishlist", "/collection", "/scans", "/achievements", "/leaderboard/activity")
# Swap offers are social: the frontend shows their Settings row only while the admin's switch is on.
UI_CATEGORIES = [c.id for c in CATEGORIES.values() if c.timing]


def pref_key(category: str) -> str:
    return f"notify_{category}"


def default_settings() -> dict[str, str]:
    """Defaults merged into the settings API response."""
    defaults = {pref_key(c.id): "true" if c.default else "false" for c in CATEGORIES.values()}
    defaults[DIGEST_HOUR_KEY] = str(DEFAULT_DIGEST_HOUR)
    defaults[QUIET_ENABLED_KEY] = "false"
    defaults[SHOW_DETAILS_KEY] = "true"
    return defaults


def boolean_keys() -> set[str]:
    return {pref_key(c.id) for c in CATEGORIES.values()} | {QUIET_ENABLED_KEY, SHOW_DETAILS_KEY}


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
    return False if value is None else value.strip().lower() in {"true", "1", "yes", "on"}


def show_details(db: Session, user_id: int) -> bool:
    """Whether pushes may name cards and prices (default on)."""
    value = _setting(db, user_id, SHOW_DETAILS_KEY)
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


def _log(event: str, category: str, user_id: int, subject_key: str, reason: str) -> None:
    """One INFO line per queue decision. Never the payload, a card name or a push endpoint."""
    logger.info("Notification %s: category=%s user=%s subject=%s %s", event, category, user_id, subject_key, reason)


def enqueue(
    db: Session,
    user_id: int,
    category: str,
    subject_key: str,
    *,
    now: datetime.datetime | None = None,
    repeat_days: int | None = None,
    details: dict | None = None,
) -> bool:
    """Queue one notification unless the category is off or the subject was already queued.

    `repeat_days=None` means once ever for the subject; otherwise once per that many days.
    `details` is stored with the row as the event was when it happened (see the module docstring).
    The caller commits.
    """
    now = now or datetime.datetime.utcnow()
    if not category_enabled(db, user_id, category):
        _log("not queued", category, user_id, subject_key, "category_off")
        return False
    seen = db.query(NotificationQueue).filter(
        NotificationQueue.user_id == user_id,
        NotificationQueue.category == category,
        NotificationQueue.subject_key == subject_key,
    )
    if repeat_days is not None:
        seen = seen.filter(NotificationQueue.created_at > now - datetime.timedelta(days=repeat_days))
    if seen.first() is not None:
        _log("not queued", category, user_id, subject_key, "duplicate")
        return False
    send_after = send_time_for_instant(db, user_id, now) if CATEGORIES[category].timing == INSTANT else now
    db.add(NotificationQueue(
        user_id=user_id, category=category, subject_key=subject_key, created_at=now, send_after=send_after,
        details=details or None,
    ))
    _log("queued", category, user_id, subject_key, f"send_after={send_after.isoformat()}")
    return True


def _card_details(db: Session, card: Card, **extra) -> dict:
    """The card as the push names it: name, set (name and code) and number."""
    set_row = None
    if card.set_id:
        set_row = db.query(Set).filter(Set.tcg_set_id == card.set_id, Set.lang == (card.lang or "en")).first()
    return {
        "card_id": card.id,
        "name": card.name,
        "set": set_row.name if set_row else None,
        "set_code": ((set_row.abbreviation or "").strip() or None) if set_row else None,
        "number": card.number,
        **extra,
    }


def notify_wishlist_alert(
    db: Session,
    user_id: int,
    card_id: str,
    now: datetime.datetime | None = None,
    *,
    price: float | None = None,
    threshold: float | None = None,
    alert_type: str | None = None,
) -> bool:
    """A wishlist price threshold was crossed. Price and threshold are kept as they were now."""
    details: dict = {"card_id": card_id}
    card = db.query(Card).filter(Card.id == card_id).first()
    if card is not None:
        details = _card_details(db, card)
    if price is not None and threshold is not None:
        details.update(price=round(float(price), 2), threshold=round(float(threshold), 2), alert_type=alert_type)
    return enqueue(db, user_id, "wishlist_alerts", f"card:{card_id}", now=now, repeat_days=1, details=details)


def notify_scans_ready(
    db: Session, user_id: int, job_id: int, now: datetime.datetime | None = None, count: int | None = None
) -> bool:
    """Called when a scan job needs review; one push per job. `count` is its items to review now."""
    details = {"job_id": job_id, "count": int(count)} if count is not None else {"job_id": job_id}
    return enqueue(db, user_id, "scans_ready", f"job:{job_id}", now=now, details=details)


def build_announcement_payload(details: dict | None) -> str | None:
    """An administrator's message exactly as written (the "show card names" switch never blanks it).
    None when the row carries no text."""
    details = details or {}
    title = " ".join(str(details.get("title") or "").split())
    body = " ".join(str(details.get("body") or "").split())
    if not title or not body:
        return None
    route = details.get("route")
    navigate = route if route in ANNOUNCEMENT_ROUTES else CATEGORIES["announcements"].navigate
    return push.encode_payload_fitted(title, body, navigate)


def queue_announcement(
    db: Session, user_id: int, announcement_id: int, title: str, body: str, route: str,
    now: datetime.datetime | None = None,
) -> str:
    """Queue one admin announcement for a trainer. Returns "queued", "off" (announcements switched off)
    or "unreachable" (no push subscription and no Telegram). The caller commits."""
    from models import PushSubscription

    if not category_enabled(db, user_id, "announcements"):
        return "off"
    has_push = db.query(PushSubscription.id).filter(PushSubscription.user_id == user_id).first() is not None
    if not has_push and not telegram.is_configured(db, user_id):
        return "unreachable"
    queued = enqueue(
        db, user_id, "announcements", f"announcement:{announcement_id}", now=now,
        details={"announcement_id": announcement_id, "title": title, "body": body, "route": route},
    )
    return "queued" if queued else "off"


def _active_user_ids(db: Session) -> list[int]:
    return [uid for (uid,) in db.query(User.id).filter(User.is_active == True).all()]  # noqa: E712


def on_new_sets(db: Session, set_ids: list[str]) -> None:
    """New sets were marked `is_new`: Telegram (respects TELEGRAM_ENABLED) and a digest entry per user."""
    if not set_ids:
        return
    rows = db.query(Set).filter(Set.id.in_(set_ids)).all()
    new_sets = [{"name": s.name, "series": s.series or ""} for s in rows]
    for user_id in _active_user_ids(db):
        with trainer_savepoint(db, "New-sets notification", user_id):
            if not category_enabled(db, user_id, "new_sets"):
                continue
            try:
                telegram.send_new_sets_notification(new_sets, db=db, user_id=user_id)
            except Exception:
                logger.exception("Telegram new-sets notification failed for user %s", user_id)
            for s in rows:
                enqueue(db, user_id, "new_sets", f"set:{s.id}", details={"name": s.name, "series": s.series or ""})
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
        with trainer_savepoint(db, "Wishlist dip check", item.user_id):
            if not category_enabled(db, item.user_id, "wishlist_dips"):
                continue
            price = effective_market_price(item.card, price_field=_price_field(db, item.user_id))
            if is_dip(price, item.card.price_avg30):
                avg30 = item.card.price_avg30
                details = _card_details(
                    db, item.card,
                    price=round(price, 2), avg30=round(avg30, 2), drop_pct=round((avg30 - price) / avg30 * 100, 1),
                )
                queued += enqueue(
                    db, item.user_id, "wishlist_dips", f"card:{item.card_id}", now=now, repeat_days=REPEAT_DAYS,
                    details=details,
                )

    owned = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).filter(
        CollectionItem.card_id.in_(ids)
    ).all()
    seen: set[tuple[int, str]] = set()
    for item in owned:
        with trainer_savepoint(db, "Big-mover check", item.user_id):
            key = (item.user_id, item.card_id)
            if key in seen or not category_enabled(db, item.user_id, "big_movers"):
                continue
            seen.add(key)
            price = effective_market_price(item.card, price_field=_price_field(db, item.user_id))
            if is_big_move(price, item.card.price_avg7, mover_threshold(db, item.user_id)):
                baseline = item.card.price_avg7
                details = _card_details(
                    db, item.card,
                    price=round(price, 2), baseline=round(baseline, 2),
                    change_pct=round((price - baseline) / baseline * 100, 1),
                )
                queued += enqueue(
                    db, item.user_id, "big_movers", f"card:{item.card_id}", now=now, repeat_days=REPEAT_DAYS,
                    details=details,
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


def build_scans_payload(count: int, review_count: int | None = None) -> str:
    """Actionable: carries the icon number (`count`) so the service worker can set the app badge.

    `review_count` switches on the detailed text ("3 scans ready to review"); without it the
    content-light "Scans ready to review" is sent.
    """
    if review_count is None:
        body = "Scans ready to review"
    else:
        body = f"{review_count} scan{'' if review_count == 1 else 's'} ready to review"
    payload = json.loads(push._encode_payload("PokéCollector", body, CATEGORIES["scans_ready"].navigate))
    payload["app_badge"] = int(count)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def build_badge_payload(badge_id: str | None = None) -> str:
    """"Badge unlocked" naming the badge and tier; content-light "You earned a badge" without an id."""
    navigate = CATEGORIES["badges"].navigate
    if not badge_id:
        return push._encode_payload("PokéCollector", "You earned a badge", navigate)
    from services.achievements import FALLBACK_BADGE_NAME, registry_by_id

    entry = registry_by_id().get(badge_id) or {}
    name = (entry.get("name") or "").strip()
    tier = (entry.get("tier") or "").strip().capitalize()
    body = name or f"You earned {FALLBACK_BADGE_NAME}"
    if tier:
        body = f"{body} · {tier}"
    return push.encode_payload_fitted("Badge unlocked", body, navigate)


def build_goal_payload(details: dict | None, detailed: bool) -> str:
    """"Goal milestone" naming the goal and the percent; content-light without details or a name."""
    details = details or {}
    goal_id = details.get("goal_id")
    navigate = f"/goals/{int(goal_id)}" if isinstance(goal_id, int) else CATEGORIES["goal_milestones"].navigate
    percent = details.get("percent")
    name = " ".join(str(details.get("title") or "").split())
    if not detailed or not name or not isinstance(percent, int):
        return push.encode_payload_fitted("Goal milestone", "One of your goals reached a new milestone", navigate)
    if percent >= 100:
        return push.encode_payload_fitted("Goal complete", f"{_clip(name, 80)}: 100%", navigate)
    return push.encode_payload_fitted("Goal milestone", f"{_clip(name, 80)}: {percent}% done", navigate)


# --- detailed texts ------------------------------------------------------------------------
# Prices are EUR, the currency the catalogue stores (Cardmarket); the backend has no per-user
# conversion helper to call while a push is built, so they are shown with €.


def _money(value) -> str:
    return f"€{float(value):.2f}"


def _clip(text, limit: int = MAX_NAME_CHARS) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _percent(value) -> str:
    return f"{abs(float(value)):.0f}%"


def _card_label(details: dict) -> str:
    """"Charizard ex (OBF 125)": name, then the set code (or set name) and the number."""
    name = _clip(details.get("name")) or "Card"
    code = _clip(details.get("set_code") or details.get("set"), 20)
    number = str(details.get("number") or "").strip()
    inner = " ".join(part for part in (code, number) if part)
    if inner and not code:
        inner = f"#{number}"
    return f"{name} ({inner})" if inner else name


def _fit(items: list[str], budget: int, sep: str = " · ", more_sep: str | None = None) -> str:
    """Join the items; when they exceed `budget` characters the last ones become "and N more"."""
    more_sep = sep if more_sep is None else more_sep
    shown = list(items)
    while True:
        hidden = len(items) - len(shown)
        text = sep.join(shown) + (f"{more_sep}and {hidden} more" if hidden else "")
        if len(text) <= budget or len(shown) <= 1:
            return text
        shown.pop()


def _dip_item(d: dict) -> str:
    return f"{_clip(d.get('name'))} −{_percent(d.get('drop_pct') or 0)} {_money(d.get('price') or 0)}"


def _mover_item(d: dict) -> str:
    pct = float(d.get("change_pct") or 0)
    return f"{_clip(d.get('name'))} {'▲' if pct >= 0 else '▼'}{_percent(pct)} {_money(d.get('price') or 0)}"


def _single_dip(d: dict) -> str:
    return (
        f"{_card_label(d)} is down {_percent(d.get('drop_pct') or 0)} to {_money(d.get('price') or 0)} "
        f"(30-day avg {_money(d.get('avg30') or 0)})"
    )


def _single_mover(d: dict) -> str:
    pct = float(d.get("change_pct") or 0)
    return (
        f"{_card_label(d)} is {'up' if pct >= 0 else 'down'} {_percent(pct)} to {_money(d.get('price') or 0)} "
        f"(7-day avg {_money(d.get('baseline') or 0)})"
    )


# Per digest category: the line prefix of a mixed digest, how to sort and render its entries.
def _sorted_dips(entries: list[dict]) -> list[dict]:
    return sorted(entries, key=lambda d: -(d.get("drop_pct") or 0))


def _sorted_movers(entries: list[dict]) -> list[dict]:
    return sorted(entries, key=lambda d: -abs(d.get("change_pct") or 0))


_DETAIL_ORDER = ("wishlist_dips", "big_movers", "new_sets")
_TITLE_NOUNS = {"wishlist_dips": "Wishlist dip", "big_movers": "Big mover", "new_sets": "New set"}


def _detail_texts(category: str, entries: list[dict]) -> list[str]:
    if category == "wishlist_dips":
        return [_dip_item(d) for d in _sorted_dips(entries)]
    if category == "big_movers":
        return [_mover_item(d) for d in _sorted_movers(entries)]
    return [_clip(d.get("name"), 60) for d in entries if d.get("name")] or [_digest_line(category, len(entries))]


def _digest_route(groups: dict[str, list[dict]]) -> str:
    """Wishlist for dips only, the one card's page for a single card, the category page for one
    kind of entry, otherwise the home screen."""
    cards = {d.get("card_id") for cat in ("wishlist_dips", "big_movers") for d in groups.get(cat, [])}
    if "new_sets" not in groups and len(cards) == 1 and None not in cards:
        card_id = next(iter(cards))
        if "big_movers" in groups:
            return f"/collection?cardId={quote(str(card_id), safe='')}"
        return CATEGORIES["wishlist_dips"].navigate
    if len(groups) == 1:
        return CATEGORIES[next(iter(groups))].navigate
    return "/"


def build_detail_digest_payload(groups: dict[str, list[dict | None]]) -> str | None:
    """One push for the day that says what it is about.

    `groups` maps a digest category to the `details` of its queued rows. A category with a row
    that has no details (queued before they were stored) is shown as a count, as before.
    """
    groups = {c: list(rows) for c, rows in groups.items() if rows and c in CATEGORIES}
    if not groups:
        return None
    counts = {c: len(rows) for c, rows in groups.items()}
    detailed = {
        c: rows for c, rows in groups.items()
        if c in _DETAIL_ORDER and all(isinstance(d, dict) and d for d in rows)
    }
    if not detailed:
        return build_digest_payload(counts)
    navigate = _digest_route(detailed) if len(detailed) == len(groups) else "/"

    if len(groups) == 1:
        category, entries = next(iter(detailed.items()))
        if len(entries) == 1 and category in ("wishlist_dips", "big_movers"):
            title = _TITLE_NOUNS[category]
            body = _single_dip(entries[0]) if category == "wishlist_dips" else _single_mover(entries[0])
        else:
            noun = _TITLE_NOUNS[category]
            title = noun if len(entries) == 1 else f"{len(entries)} {noun.lower()}s"
            sep, more_sep = (", ", " ") if category == "new_sets" else (" · ", " · ")
            body = _fit(_detail_texts(category, entries), MAX_BODY_CHARS, sep, more_sep)
        return push.encode_payload_fitted(title, body, navigate)

    prefixes = {"wishlist_dips": "Wishlist: ", "big_movers": "Movers: ", "new_sets": "New sets: "}
    lines: list[str] = []
    budget = max(40, (MAX_BODY_CHARS - (len(groups) - 1)) // len(groups))
    for category, rows in groups.items():
        if category in detailed:
            prefix = prefixes[category]
            sep, more_sep = (", ", " ") if category == "new_sets" else (" · ", " · ")
            lines.append(prefix + _fit(_detail_texts(category, rows), budget - len(prefix), sep, more_sep))
        else:
            lines.append(_digest_line(category, len(rows)))
    title = ", ".join(_digest_line(c, n) for c, n in counts.items())
    return push.encode_payload_fitted(title, "\n".join(lines), navigate)


def build_wishlist_alert_payload(details: dict | None, fallback_name: str = "", hide_card: bool = False) -> str:
    """"Charizard ex is now €12.40, under your €13.00 alert"; the light text when no price was kept.

    `hide_card` (the trainer switched off card names and prices) names no card and shows no price.
    """
    navigate = CATEGORIES["wishlist_alerts"].navigate
    if hide_card:
        return push.encode_payload_fitted(
            "Wishlist price alert", "A card on your wishlist hit your price alert", navigate
        )
    details = details or {}
    name = (details.get("name") or fallback_name or "").strip()
    price, threshold = details.get("price"), details.get("threshold")
    if price is None or threshold is None:
        return push.build_price_alert_payload(name)
    over = details.get("alert_type") == "above"
    body = f"{_clip(name) or 'Card'} is now {_money(price)}, {'over' if over else 'under'} your {_money(threshold)} alert"
    return push.encode_payload_fitted("Wishlist price alert", body, CATEGORIES["wishlist_alerts"].navigate)


def scans_needing_review(db: Session, user_id: int) -> int:
    """The icon number: unresolved finished items of this user's scan jobs."""
    from models import ScanJobItem

    return db.query(ScanJobItem).filter(
        ScanJobItem.user_id == user_id,
        ScanJobItem.resolved == False,  # noqa: E712
        ScanJobItem.status.in_(("done", "failed")),
    ).count()


def swap_offers_waiting(db: Session, user_id: int) -> int:
    """Swap offers waiting for this trainer's answer. 0 while the social switch is off."""
    from services.social_feature import social_enabled
    from services.swaps import waiting_count

    return waiting_count(db, user_id) if social_enabled(db) else 0


def icon_number(db: Session, user_id: int) -> int:
    """The app-icon number: scans waiting for review plus swap offers waiting for the trainer (social on only)."""
    return scans_needing_review(db, user_id) + swap_offers_waiting(db, user_id)


_SWAP_TITLES = {
    "offer": "Swap offer",
    "counter": "Swap counter-offer",
    "accepted": "Swap accepted",
    "swapped": "Confirm your swap",
    "completed": "Swap complete",
    "declined": "Swap declined",
    "cancelled": "Swap called off",
}
_SWAP_LIGHT = {
    "offer": "You have a new swap offer",
    "counter": "A swap offer was updated",
    "accepted": "Your swap offer was accepted",
    "swapped": "Your swap partner tapped Swapped",
    "completed": "Your swap is complete",
    "declined": "A swap offer was declined",
    "cancelled": "A swap was called off",
}
SWAP_NAMED_CARDS = 2  # a side with more cards than this is counted ("3 cards") instead of listed


def _swap_side(cards, cash: bool = False) -> str:
    """"Charizard ex (OBF 125)", "A and B", or "3 cards"; never an amount. `cash` adds "+ cash"."""
    cards = [_clip(c, MAX_NAME_CHARS + 12) for c in (cards or []) if c]
    if not cards:
        return ""
    text = " and ".join(cards) if len(cards) <= SWAP_NAMED_CARDS else f"{len(cards)} cards"
    return f"{text} + cash" if cash else text


def build_swap_payload(details: dict | None, detailed: bool, badge: int | None = None) -> str:
    """Swap-offer push. Detailed: names the trainer and the cards ("Brock offered Charizard ex (OBF 125) for
    your Greninja ex (TWM 106)"), cash as "+ cash", never an amount. Content-light otherwise.
    It opens the offer itself. `badge` is the icon number (scans plus offers waiting); a decline carries none.

    Rows queued before the cards were named only carry counts, and keep their old wording."""
    details = details or {}
    kind = details.get("kind") if details.get("kind") in _SWAP_TITLES else "offer"
    name = " ".join(str(details.get("partner") or "").split())
    gives, gets = details.get("gives"), details.get("gets")
    give_cards, get_cards = details.get("give_cards"), details.get("get_cards")
    named = isinstance(give_cards, list) and isinstance(get_cards, list)
    offer_id = details.get("offer_id")
    navigate = f"/trades/offers/{int(offer_id)}" if isinstance(offer_id, int) else "/trades/offers"
    if not detailed or not name:
        body = _SWAP_LIGHT[kind]
    else:
        who = _clip(name, 30)
        cash = bool(details.get("cash"))
        got = _swap_side(get_cards) if named else ""
        gave = _swap_side(give_cards, cash) if named else ""
        if named and cash and not gave:
            got = _swap_side(get_cards, True)
        if kind in ("offer", "counter") and named and got:
            verb = "offered" if kind == "offer" else "countered:"
            body = f"{who} {verb} {got} for your {gave}" if gave else f"{who} {verb} {got}"
        elif kind in ("offer", "counter") and isinstance(gives, int) and isinstance(gets, int):
            verb = "offered" if kind == "offer" else "countered with"
            body = f"{who} {verb} {gets} card{'' if gets == 1 else 's'} for {gives} of yours"
        elif kind == "accepted" and named and got:
            body = f"{who} accepted: {got} for your {gave}. Meet up, then both tap Swapped." if gave else (
                f"{who} accepted: {got}. Meet up, then both tap Swapped.")
        elif kind == "accepted":
            body = f"{who} accepted your swap"
        elif kind == "swapped" and named and got:
            body = f"{who} tapped Swapped. Tap yours once you have {got}."
        elif kind == "swapped":
            body = f"{who} tapped Swapped. Tap yours once you have the cards"
        elif kind == "completed" and named and got:
            body = f"{got} is in your collection." if len(get_cards) == 1 else f"{got} are in your collection."
        elif kind == "completed":
            body = f"Your swap with {who} is complete"
        elif kind == "declined":
            body = f"{who} declined your swap offer"
        elif kind == "cancelled":
            body = f"{who} called off your swap"
        else:
            body = f"{who} sent a swap offer"
    payload = json.loads(push.encode_payload_fitted(_SWAP_TITLES[kind], body, navigate))
    if badge is not None and kind not in ("declined", "cancelled"):
        payload["app_badge"] = int(badge)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def swap_push_still_relevant(db: Session, row: NotificationQueue) -> bool:
    """False when the offer moved on while the push waited (answered, cancelled, expired, confirmed)."""
    from models import SwapOffer

    details = row.details or {}
    offer = db.query(SwapOffer).filter(SwapOffer.id == details.get("offer_id")).first()
    if offer is None:
        return False
    kind = details.get("kind")
    if kind in ("offer", "counter"):
        return (
            offer.state in ("proposed", "countered")
            and offer.turn_user_id == row.user_id
            and int(offer.revision) == details.get("revision")
        )
    if kind == "accepted":
        return offer.state == "accepted"
    if kind == "swapped":
        mine = offer.from_confirmed_at if row.user_id == offer.from_user_id else offer.to_confirmed_at
        return offer.state == "accepted" and mine is None
    if kind == "declined":
        return offer.state == "declined"
    if kind == "cancelled":
        return offer.state == "cancelled"
    return offer.state == "completed"


def _mark_sent(rows, now: datetime.datetime) -> None:
    for row in rows:
        row.sent_at = now


def _send(db: Session, user_id: int, payload: str) -> dict | None:
    """Send to the user's devices. Returns the `send_to_user` counts, or None when it raised."""
    try:
        return push.send_to_user(db, user_id, payload)
    except Exception:
        logger.exception("Web push failed for user %s", user_id)
        return None


def _sent_reason(outcome: dict | None) -> str:
    if outcome is None:
        return "send_failed"
    delivered = "" if outcome.get("sent") else " (no device received it)"
    return f"sent={outcome.get('sent', 0)} removed={outcome.get('removed', 0)}{delivered}"


def _flush_isolated(db: Session, label: str, user_id: int, step, *args) -> None:
    """One flush step, committed on its own. Sending commits inside `push.send_to_user`, which a savepoint
    cannot span, so a failure rolls back only the uncommitted work of this step; steps already committed stay."""
    try:
        step(db, *args)
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("%s failed for user %s", label, user_id)


def flush_due(db: Session, now: datetime.datetime | None = None) -> dict:
    """Send what is due. Run every 30 seconds by the scheduler."""
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
            _flush_isolated(db, "Notification flush", row.user_id, _flush_instant, row, now, result)
        else:
            by_user_digest.setdefault(row.user_id, []).append(row)

    for user_id, rows in by_user_digest.items():
        _flush_isolated(db, "Digest flush", user_id, _flush_digest, user_id, rows, now, result)

    cutoff = now - datetime.timedelta(days=QUEUE_RETENTION_DAYS)
    db.query(NotificationQueue).filter(NotificationQueue.created_at < cutoff).delete(synchronize_session=False)
    db.commit()
    return result


def _flush_instant(db: Session, row: NotificationQueue, now: datetime.datetime, result: dict) -> None:
    category, user_id, subject = row.category, row.user_id, row.subject_key
    if quiet_hours_enabled(db, user_id):
        zone = user_zone(db, user_id)
        if in_quiet_hours(now, zone):
            row.send_after = quiet_hours_end(now, zone)
            _log("deferred", category, user_id, subject, f"reason=quiet_hours until={row.send_after.isoformat()}")
            return
    if category == "feed_activity":  # sends every due row of the trainer, folded per event
        flush_feed_activity(db, user_id, now, result)
        return
    count = scans_needing_review(db, user_id) if category == "scans_ready" else 0
    row.sent_at = now
    if not category_enabled(db, user_id, category):
        _log("skipped", category, user_id, subject, "reason=category_off")
        return
    if category == "scans_ready":
        if count <= 0:  # already reviewed
            _log("skipped", category, user_id, subject, "reason=already_reviewed")
            return
        review_count = None
        if show_details(db, user_id):
            # This job's items as they were when it finished, but never more than are still waiting.
            kept = (row.details or {}).get("count")
            review_count = min(int(kept), count) if isinstance(kept, int) and kept > 0 else count
        outcome = _send(db, user_id, build_scans_payload(count + swap_offers_waiting(db, user_id), review_count))
        result["instant"] += 1
        _log("flushed", category, user_id, subject, f"{_sent_reason(outcome)} to_review={count}")
    elif category == "wishlist_alerts":
        card = db.query(Card).filter(Card.id == subject.split("card:", 1)[-1]).first()
        if show_details(db, user_id):
            payload = build_wishlist_alert_payload(row.details, card.name if card else "")
        else:
            payload = build_wishlist_alert_payload(None, hide_card=True)
        outcome = _send(db, user_id, payload)
        result["instant"] += 1
        _log("flushed", category, user_id, subject, _sent_reason(outcome))
    elif category == "badges":
        achievement_id = subject.split("badge:", 1)[-1]
        pending = db.query(UserAchievement).filter_by(
            user_id=user_id, achievement_id=achievement_id, seen_at=None
        ).first()
        if pending is None:  # the trainer already saw the sheet
            _log("skipped", category, user_id, subject, "reason=sheet_already_seen")
            return
        badge_id = (row.details or {}).get("badge_id") or achievement_id
        outcome = _send(db, user_id, build_badge_payload(badge_id if show_details(db, user_id) else None))
        result["instant"] += 1
        _log("flushed", category, user_id, subject, _sent_reason(outcome))
    elif category == "goal_milestones":
        details = row.details or {}
        outcome = _send(db, user_id, build_goal_payload(details, show_details(db, user_id)))
        result["instant"] += 1
        _log("flushed", category, user_id, subject, _sent_reason(outcome))
    elif category == "swap_offers":
        from services.social_feature import social_enabled

        if not social_enabled(db):
            _log("skipped", category, user_id, subject, "reason=social_off")
            return
        if not swap_push_still_relevant(db, row):
            _log("skipped", category, user_id, subject, "reason=offer_moved_on")
            return
        payload = build_swap_payload(row.details, show_details(db, user_id), icon_number(db, user_id))
        outcome = _send(db, user_id, payload)
        result["instant"] += 1
        _log("flushed", category, user_id, subject, _sent_reason(outcome))
    elif category == "announcements":
        payload = build_announcement_payload(row.details)
        if payload is None:
            _log("skipped", category, user_id, subject, "reason=no_text")
            return
        outcome = _send(db, user_id, payload)
        _send_announcement_telegram(db, user_id, row.details)
        result["instant"] += 1
        _log("flushed", category, user_id, subject, _sent_reason(outcome))
    elif category == "weekly_recap":
        from services.recap import build_recap_push

        title, body = build_recap_push(row.details if show_details(db, user_id) else None)
        outcome = _send(db, user_id, push.encode_payload_fitted(title, body, CATEGORIES[category].navigate))
        result["instant"] += 1
        _log("flushed", category, user_id, subject, _sent_reason(outcome))
    elif category == "wrapped":
        from services.recap import build_wrapped_push

        title, body, navigate = build_wrapped_push(subject, row.details if show_details(db, user_id) else None)
        outcome = _send(db, user_id, push.encode_payload_fitted(title, body, navigate))
        result["instant"] += 1
        _log("flushed", category, user_id, subject, _sent_reason(outcome))


def _send_announcement_telegram(db: Session, user_id: int, details: dict | None) -> None:
    import html

    details = details or {}
    try:
        if telegram.is_configured(db, user_id):
            telegram.send_message(
                f"<b>{html.escape(str(details.get('title') or ''))}</b>\n{html.escape(str(details.get('body') or ''))}",
                db=db, user_id=user_id,
            )
    except Exception:
        logger.exception("Telegram announcement failed for user %s", user_id)


def _flush_digest(db: Session, user_id: int, rows, now: datetime.datetime, result: dict) -> None:
    zone = user_zone(db, user_id)
    local = local_now(now, zone)
    hour = digest_hour(db, user_id)
    today = local.date().isoformat()
    # Only inside the daily window (digest hour up to quiet hours) and at most once a day.
    if not (hour <= local.hour < QUIET_START_HOUR):
        logger.info("Digest waiting for the daily window: user=%s entries=%s reason=outside_window", user_id, len(rows))
        return
    if _setting(db, user_id, LAST_DIGEST_KEY) == today:
        logger.info("Digest waiting for tomorrow: user=%s entries=%s reason=already_sent_today", user_id, len(rows))
        return
    counts: dict[str, int] = {}
    groups: dict[str, list] = {}
    for row in rows:
        if category_enabled(db, user_id, row.category):
            counts[row.category] = counts.get(row.category, 0) + 1
            groups.setdefault(row.category, []).append(row.details)
    _mark_sent(rows, now)
    if show_details(db, user_id):
        payload = build_detail_digest_payload(groups)
    else:
        payload = build_digest_payload(counts)
    if payload:
        outcome = _send(db, user_id, payload)
        _set_setting(db, user_id, LAST_DIGEST_KEY, today)
        result["digests"] += 1
        logger.info(
            "Digest flushed: user=%s categories=%s %s", user_id, ",".join(sorted(counts)), _sent_reason(outcome)
        )
    else:
        logger.info("Digest skipped: user=%s entries=%s reason=all_categories_off", user_id, len(rows))


def job_review_count(db: Session, job_id: int) -> int:
    """How many of the job's items wait for the trainer."""
    from models import ScanJobItem

    return db.query(ScanJobItem).filter(
        ScanJobItem.job_id == job_id,
        ScanJobItem.resolved == False,  # noqa: E712
        ScanJobItem.status.in_(("done", "failed")),
    ).count()


def job_needs_review(db: Session, job_id: int) -> bool:
    return job_review_count(db, job_id) > 0


def on_scan_job_finished(db: Session, job, now: datetime.datetime | None = None) -> None:
    """A scan job reached "needs review". Queues one push per job; never raises into the scan queue."""
    try:
        with db.begin_nested():
            review_count = job_review_count(db, job.id)
            if review_count > 0:
                notify_scans_ready(db, job.user_id, job.id, now=now, count=review_count)
            else:
                _log("not queued", "scans_ready", job.user_id, f"job:{job.id}", "reason=nothing_to_review")
    except Exception:
        logger.exception("Could not queue the scans-ready notification for job %s", getattr(job, "id", None))


# --- reactions and comments on feed events -------------------------------------------------------
# Rows: subject `e{event}:r:{actor}:{kind}` (a reaction) or `e{event}:c:{comment}` (a comment), owner = the
# event's trainer. `details`: kind, event_id, actor, label (what the event was, never an amount) and
# `lead` (this row opened a window and pushes at once). Flags set at send time: `pushed`, `head` (the
# first row of one push, so pushes can be counted), `capped` (held back by the hourly cap).


def _feed_event_label(db: Session, event) -> str:
    """What the event was, as the push names it: "Base Set completion", "Charizard ex pull". Never an amount."""
    from services.progress.evaluator import (
        EVENT_ACHIEVEMENT_UNLOCKED, EVENT_BIG_PULL, EVENT_GOAL_COMPLETED, EVENT_SET_COMPLETED,
    )

    payload = event.payload or {}
    if event.kind == EVENT_SET_COMPLETED:
        name = _clip(payload.get("set_name"), 50)
        return f"{name} completion" if name else "set completion"
    if event.kind == EVENT_BIG_PULL:
        name = _clip(payload.get("name"), 50)
        if not name and payload.get("card_id"):
            card = db.query(Card).filter(Card.id == payload["card_id"]).first()
            name = _clip(card.name, 50) if card else ""
        return f"{name} pull" if name else "big pull"
    if event.kind == EVENT_ACHIEVEMENT_UNLOCKED:
        from services.achievements import registry_by_id

        name = _clip((registry_by_id().get(payload.get("achievement_id") or event.subject_key) or {}).get("name"), 50)
        return f"{name} badge" if name else "badge"
    if event.kind == EVENT_GOAL_COMPLETED:
        name = _clip(payload.get("title"), 50)
        return f"{name} goal" if name else "goal"
    return "challenge result"


def feed_activity_link(event_id: int, comments: bool) -> str:
    """Where the push opens: the feed at the event, with its comments sheet open for a comment."""
    return f"/leaderboard/activity?event={int(event_id)}" + ("&comments=1" if comments else "")


def _feed_window_end(db: Session, owner_id: int, event_id: int, now: datetime.datetime) -> datetime.datetime | None:
    """When the current window on the event ends, or None when no window is open (the next activity leads)."""
    window = datetime.timedelta(seconds=FEED_PUSH_WINDOW_SECONDS)
    rows = db.query(NotificationQueue).filter(
        NotificationQueue.user_id == owner_id,
        NotificationQueue.category == "feed_activity",
        NotificationQueue.subject_key.like(f"e{int(event_id)}:%"),
        NotificationQueue.created_at > now - datetime.timedelta(hours=2),
    ).all()
    ends = []
    for row in rows:
        details = row.details or {}
        if row.sent_at is not None and details.get("pushed"):
            ends.append(row.sent_at + window)
        elif row.sent_at is None and details.get("lead"):
            ends.append(row.send_after + window)
    end = max(ends, default=None)
    return end if end is not None and end > now else None


def _queue_feed_activity(db: Session, event, actor, subject: str, details: dict, now) -> bool:
    from services.social_feature import social_enabled

    if actor.id == event.user_id or not social_enabled(db):
        return False
    end = _feed_window_end(db, event.user_id, event.id, now)
    details = {
        **details, "event_id": event.id, "actor": actor.username,
        "label": _feed_event_label(db, event), "lead": end is None,
    }
    key = f"e{event.id}:{subject}"
    if not enqueue(db, event.user_id, "feed_activity", key, now=now, details=details):
        return False
    if end is not None:
        db.flush()
        row = db.query(NotificationQueue).filter_by(
            user_id=event.user_id, category="feed_activity", subject_key=key
        ).first()
        row.send_after = max(row.send_after, end)
    return True


def notify_feed_reaction(db: Session, event, actor, kind: str, now: datetime.datetime | None = None) -> bool:
    """Another trainer reacted to the event's owner. Never for your own event. The caller commits."""
    return _queue_feed_activity(
        db, event, actor, f"r:{actor.id}:{kind}", {"kind": "reaction", "reaction": kind},
        now or datetime.datetime.utcnow(),
    )


def notify_feed_comment(db: Session, event, actor, comment, now: datetime.datetime | None = None) -> bool:
    return _queue_feed_activity(
        db, event, actor, f"c:{comment.id}", {"kind": "comment"}, now or datetime.datetime.utcnow()
    )


def cancel_feed_reaction(db: Session, event_id: int, actor_id: int, kind: str) -> None:
    """A reaction was taken back: if its push has not gone out, it never does."""
    from models import UserEvent

    owner_id = db.query(UserEvent.user_id).filter(UserEvent.id == event_id).scalar()
    if owner_id is None:
        return
    db.query(NotificationQueue).filter(
        NotificationQueue.user_id == owner_id,
        NotificationQueue.category == "feed_activity",
        NotificationQueue.subject_key == f"e{event_id}:r:{actor_id}:{kind}",
        NotificationQueue.sent_at.is_(None),
    ).delete(synchronize_session=False)


def _feed_row_still_there(db: Session, row: NotificationQueue) -> bool:
    """False when the reaction was removed or the comment deleted while its push waited."""
    from models import EventComment, EventReaction

    parts = row.subject_key.split(":")
    try:
        event_id = int(parts[0][1:])
        if parts[1] == "r":
            return db.query(EventReaction.id).filter_by(
                event_id=event_id, user_id=int(parts[2]), kind=parts[3]
            ).first() is not None
        return db.query(EventComment.id).filter_by(id=int(parts[2]), event_id=event_id).first() is not None
    except (IndexError, ValueError):
        return False


def _names_phrase(names: list[str]) -> str:
    names = [_clip(n, 24) for n in names]
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return f"{names[0]} and {len(names) - 1} others"


def build_feed_activity_payload(rows: list[dict], detailed: bool, event_id: int | None = None) -> str:
    """One push about the activity on one event (or, without `event_id`, a summary of several).

    Detailed: "Misty and 2 others reacted to your Base Set completion", "3 new comments on your Charizard ex
    pull". Content-light: no names, no event. Never an amount. A push with a comment opens the comments sheet.
    """
    reactions = [r for r in rows if r.get("kind") == "reaction"]
    comments = [r for r in rows if r.get("kind") == "comment"]
    label = _clip(rows[0].get("label"), 70) if rows else ""
    if event_id is None:
        body = f"{len(rows)} new reactions and comments" if detailed else "You have new reactions and comments"
        return push.encode_payload_fitted("New activity", body, CATEGORIES["feed_activity"].navigate)
    navigate = feed_activity_link(event_id, bool(comments))
    if reactions and comments:
        title = "New activity"
        body = (
            f"{len(rows)} new reactions and comments on your {label}"
            if detailed and label else "New reactions and comments on your activity"
        )
    elif comments:
        title = "New comment" if len(comments) == 1 else "New comments"
        if not detailed or not label:
            body = "Someone commented on your activity" if len(comments) == 1 else "New comments on your activity"
        elif len(comments) == 1:
            body = f"{_clip(comments[0].get('actor'), 24) or 'Someone'} commented on your {label}"
        else:
            body = f"{len(comments)} new comments on your {label}"
    else:
        title = "New reaction" if len(reactions) == 1 else "New reactions"
        if not detailed or not label:
            body = "Someone reacted to your activity" if len(reactions) == 1 else "New reactions on your activity"
        else:
            actors = list(dict.fromkeys(r.get("actor") or "Someone" for r in reactions))
            body = f"{_names_phrase(actors)} reacted to your {label}"
    return push.encode_payload_fitted(title, body, navigate)


def _feed_pushes_in_window(db: Session, user_id: int, now: datetime.datetime) -> list[datetime.datetime]:
    """Send times of this trainer's feed pushes in the last hour, oldest first."""
    rows = db.query(NotificationQueue).filter(
        NotificationQueue.user_id == user_id,
        NotificationQueue.category == "feed_activity",
        NotificationQueue.sent_at > now - datetime.timedelta(minutes=FEED_PUSH_CAP_WINDOW_MINUTES),
    ).all()
    return sorted(r.sent_at for r in rows if (r.details or {}).get("head"))


def _mark_feed_rows(rows, now: datetime.datetime, *, pushed: bool) -> None:
    for index, row in enumerate(rows):
        row.sent_at = now
        if pushed:
            row.details = {**(row.details or {}), "pushed": True, **({"head": True} if index == 0 else {})}


def _hold_feed_rows(rows, until: datetime.datetime) -> None:
    for row in rows:
        row.send_after = until
        row.details = {**(row.details or {}), "capped": True}


def flush_feed_activity(db: Session, user_id: int, now: datetime.datetime, result: dict) -> None:
    """Send what is due for one trainer: one push per event, or one summary after the cap held pushes back.
    Handles every due row of the trainer at once, so the rows of one event fold into one push."""
    from services.feed import visible_event
    from services.social_feature import social_enabled

    due = db.query(NotificationQueue).filter(
        NotificationQueue.user_id == user_id,
        NotificationQueue.category == "feed_activity",
        NotificationQueue.sent_at.is_(None),
        NotificationQueue.send_after <= now,
    ).order_by(NotificationQueue.id).all()
    if not due:
        return
    if not social_enabled(db) or not category_enabled(db, user_id, "feed_activity"):
        _mark_feed_rows(due, now, pushed=False)
        _log("skipped", "feed_activity", user_id, "feed", "reason=social_or_category_off")
        return
    groups: dict[int, list[NotificationQueue]] = {}
    for row in due:
        event_id = int(row.subject_key.split(":")[0][1:])
        if _feed_row_still_there(db, row) and visible_event(db, user_id, event_id, include_own=True) is not None:
            groups.setdefault(event_id, []).append(row)
        else:
            _mark_feed_rows([row], now, pushed=False)
            _log("skipped", "feed_activity", user_id, row.subject_key, "reason=gone")
    if not groups:
        return
    detailed = show_details(db, user_id)

    def blocked() -> datetime.datetime | None:
        sent = _feed_pushes_in_window(db, user_id, now)
        if len(sent) < FEED_PUSH_HOURLY_CAP:
            return None
        return sent[len(sent) - FEED_PUSH_HOURLY_CAP] + datetime.timedelta(minutes=FEED_PUSH_CAP_WINDOW_MINUTES)

    all_rows = [r for rs in groups.values() for r in rs]
    held_before = any((r.details or {}).get("capped") for r in all_rows)
    if held_before and len(groups) > 1:
        until = blocked()
        if until is not None:
            _hold_feed_rows(all_rows, until)
            return
        outcome = _send(db, user_id, build_feed_activity_payload([r.details or {} for r in all_rows], detailed))
        _mark_feed_rows(all_rows, now, pushed=True)
        result["instant"] += 1
        _log("flushed", "feed_activity", user_id, "summary", _sent_reason(outcome))
        return
    for event_id, rows in groups.items():
        until = blocked()
        if until is not None:
            _hold_feed_rows(rows, until)
            _log("deferred", "feed_activity", user_id, f"e{event_id}", f"reason=hourly_cap until={until.isoformat()}")
            continue
        outcome = _send(db, user_id, build_feed_activity_payload([r.details or {} for r in rows], detailed, event_id))
        _mark_feed_rows(rows, now, pushed=True)
        db.flush()
        result["instant"] += 1
        _log("flushed", "feed_activity", user_id, f"e{event_id}", _sent_reason(outcome))
