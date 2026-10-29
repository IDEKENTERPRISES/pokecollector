"""Weekly recap and the 2026 Wrapped data (engagement P9a).

The weekly recap covers the last complete Monday–Sunday week in the trainer's time zone; from
Sunday 18:00 local time it already covers the week that is ending. Wrapped is one year of the same
facts. Nothing here is stored: both are computed on read from the collection, portfolio snapshots,
trades, products, user_events, user_daily_activity and user_achievements.

Amounts are plain numbers in the trainer's price field. Hiding values is the client's job (the
recap card and the share image mask them); the push text never names an amount.
"""
from __future__ import annotations

import datetime
import os
from collections import Counter, defaultdict
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from models import (
    Card, CollectionItem, PortfolioSnapshot, ProductPurchase, Set as CardSet, Trade, UserAchievement,
    UserDailyActivity, UserEvent, UserXpLedger,
)
from services.card_values import effective_market_price
from services.card_visibility import visible_any_card_filter
from services.delights import DNA_TYPES, _TYPE_ALIASES
from services.digital_sets import digital_sets_enabled
from services.progress import daily
from services.progress.evaluator import EVENT_SET_COMPLETED
from services.progress.streak import compute_streak
from services.progress.xp import level_for_xp, total_xp

RECAP_FROM_HOUR = 18  # Sunday, local time
RECAP_SHOW_DAYS = (6, 0, 1)  # Sunday (from 18:00), Monday, Tuesday
WRAPPED_START = (12, 1)
WRAPPED_END = (1, 15)
PREVIEW_ENV = "WRAPPED_PREVIEW"


def _image(card_id: str) -> str:
    from services.delights import _image as image

    return image(card_id)


def _to_utc_naive(local: datetime.datetime) -> datetime.datetime:
    return local.astimezone(datetime.timezone.utc).replace(tzinfo=None)


def _local_midnight(day: datetime.date, zone: ZoneInfo) -> datetime.datetime:
    return _to_utc_naive(datetime.datetime.combine(day, datetime.time.min, tzinfo=zone))


def _local_date(stamp: datetime.datetime, zone: ZoneInfo) -> datetime.date:
    return stamp.replace(tzinfo=datetime.timezone.utc).astimezone(zone).date()


def _acquired(item: CollectionItem):
    return item.acquired_at or item.added_at


def _price_field(db: Session, user_id: int) -> str:
    from services.sync_service import _user_price_field

    return _user_price_field(db, user_id)


def recap_week(now: datetime.datetime, zone: ZoneInfo) -> dict:
    """Which Monday–Sunday week the recap covers at `now` (naive UTC), and whether to show it."""
    local = now.replace(tzinfo=datetime.timezone.utc).astimezone(zone)
    today = local.date()
    weekday = today.weekday()  # Monday = 0
    sunday_evening = weekday == 6 and local.hour >= RECAP_FROM_HOUR
    if sunday_evening:
        monday = today - datetime.timedelta(days=6)
    else:
        monday = today - datetime.timedelta(days=weekday + 7)
    show = sunday_evening or weekday in (0, 1)
    return {"monday": monday, "sunday": monday + datetime.timedelta(days=6), "show": show}


def iso_week_key(monday: datetime.date) -> str:
    year, week, _ = monday.isocalendar()
    return f"{year}-W{week:02d}"


def _snapshot_values(db: Session, user_id: int, start: datetime.datetime, end: datetime.datetime) -> dict | None:
    base = db.query(PortfolioSnapshot).filter(PortfolioSnapshot.user_id == user_id)
    first = base.filter(PortfolioSnapshot.date < end, PortfolioSnapshot.date >= start).order_by(
        PortfolioSnapshot.date.asc(), PortfolioSnapshot.id.asc()).first()
    last = base.filter(PortfolioSnapshot.date < end).order_by(
        PortfolioSnapshot.date.desc(), PortfolioSnapshot.id.desc()).first()
    before = base.filter(PortfolioSnapshot.date < start).order_by(
        PortfolioSnapshot.date.desc(), PortfolioSnapshot.id.desc()).first()
    opening = before or first
    if opening is None or last is None or opening.id == last.id:
        return None
    start_value = round(float(opening.total_value or 0), 2)
    end_value = round(float(last.total_value or 0), 2)
    change = round(end_value - start_value, 2)
    return {
        "start": start_value,
        "end": end_value,
        "change": change,
        "percent": round(change / start_value * 100, 1) if start_value > 0 else None,
    }


def _closest_set(db: Session, user_id: int) -> dict | None:
    query = db.query(Card.set_id, Card.lang, Card.id).join(
        CollectionItem, CollectionItem.card_id == Card.id
    ).filter(CollectionItem.user_id == user_id, Card.is_custom == False, Card.set_id.isnot(None))  # noqa: E712
    if not digital_sets_enabled(db):
        query = query.filter(Card.is_digital == False)  # noqa: E712
    owned: dict[tuple, set] = defaultdict(set)
    for set_id, lang, card_id in query.distinct().all():
        owned[(set_id, lang)].add(card_id)
    if not owned:
        return None
    set_ids = {key[0] for key in owned}
    sizes = {
        (row.set_id, row.lang): row.n
        for row in db.query(Card.set_id, Card.lang, func.count(Card.id).label("n")).filter(
            Card.set_id.in_(set_ids), Card.is_custom == False  # noqa: E712
        ).group_by(Card.set_id, Card.lang)
    }
    best = None
    for key, cards in owned.items():
        total = sizes.get(key, 0)
        missing = total - len(cards)
        if total <= 0 or missing <= 0:
            continue
        rank = (missing, -len(cards), key)
        if best is None or rank < best[0]:
            best = (rank, key, total, len(cards))
    if best is None:
        return None
    _, (set_id, lang), total, have = best
    row = db.query(CardSet).filter(CardSet.tcg_set_id == set_id, CardSet.lang == lang).first()
    return {
        "set_id": row.id if row else f"{set_id}_{lang}",
        "name": (row.name if row else None) or set_id,
        "owned": have,
        "total": total,
        "missing": total - have,
    }


def _week_badges(db: Session, user_id: int, start: datetime.datetime, end: datetime.datetime) -> list[dict]:
    from services.achievements import registry_by_id

    known = registry_by_id()
    rows = db.query(UserAchievement).filter(
        UserAchievement.user_id == user_id, UserAchievement.backfilled == False,  # noqa: E712
        UserAchievement.unlocked_at >= start, UserAchievement.unlocked_at < end,
    ).order_by(UserAchievement.unlocked_at.asc(), UserAchievement.id.asc()).all()
    badges = []
    for row in rows:
        config = known.get(row.achievement_id)
        if config is None:
            continue
        badges.append({
            "id": config["id"], "name_key": config.get("name_key"), "tier": config.get("tier"),
            "badge_id": config.get("badge_id"), "art": config.get("art"),
        })
    return badges


def weekly_recap(db: Session, user_id: int, now: datetime.datetime | None = None) -> dict:
    now = now or datetime.datetime.utcnow()
    zone = daily.user_zone(db, user_id)
    week = recap_week(now, zone)
    monday, sunday = week["monday"], week["sunday"]
    start = _local_midnight(monday, zone)
    end = _local_midnight(sunday + datetime.timedelta(days=1), zone)
    field = _price_field(db, user_id)

    items = (
        db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id)
        .options(joinedload(CollectionItem.card))
        .filter(CollectionItem.user_id == user_id, visible_any_card_filter(db, user_id, "all"))
        .all()
    )
    added = 0
    best = None
    for item in items:
        stamp = _acquired(item)
        if stamp is None or item.card is None or not (start <= stamp < end):
            continue
        added += int(item.quantity or 1)
        price = float(effective_market_price(item.card, item.variant, field) or 0)
        if best is None or (price, -item.id) > (best[0], -best[1].id):
            best = (price, item)
    best_pull = None
    if best is not None:
        price, item = best
        best_pull = {
            "item_id": item.id, "card_id": item.card.id, "name": item.card.name,
            "variant": item.variant, "image": _image(item.card.id), "price": round(price, 2),
        }

    last_day = min(sunday, daily.local_today(zone, now))
    streak = daily.user_streak(db, user_id, last_day)
    value = _snapshot_values(db, user_id, start, end)
    badges = _week_badges(db, user_id, start, end)
    has_activity = bool(added or badges or (value and value["change"] != 0))
    return {
        "week_start": monday.isoformat(),
        "week_end": sunday.isoformat(),
        "week_key": iso_week_key(monday),
        "show": bool(week["show"]),
        "has_activity": has_activity,
        "cards_added": added,
        "value": value,
        "best_pull": best_pull,
        "closest_set": _closest_set(db, user_id),
        "streak": {"current": streak["current"], "best": streak["best"]},
        "badges": badges,
    }


# ---- Sunday push ----

def build_recap_push(details: dict | None) -> tuple[str, str]:
    """Title and body. Names the card count and best pull, never an amount."""
    if not details:
        return "Your week in PokéCollector", "Your weekly recap is ready"
    added = int(details.get("cards_added") or 0)
    parts = []
    if added:
        parts.append(f"{added} card{'' if added == 1 else 's'} added")
    if details.get("best_pull_name"):
        parts.append(f"best pull: {details['best_pull_name']}")
    badges = int(details.get("badges") or 0)
    if badges:
        parts.append(f"{badges} badge{'' if badges == 1 else 's'}")
    return "Your week in PokéCollector", " · ".join(parts) or "Your weekly recap is ready"


def queue_weekly_recaps(db: Session, now: datetime.datetime | None = None) -> int:
    """Queue the Sunday push for every user whose local time is Sunday 18:00 or later and whose
    week had activity. One per user per ISO week (the subject key is the week)."""
    from models import NotificationQueue, User
    from services import notifications

    now = now or datetime.datetime.utcnow()
    queued = 0
    for (user_id,) in db.query(User.id).filter(User.is_active == True).all():  # noqa: E712
        try:
            if not notifications.category_enabled(db, user_id, "weekly_recap"):
                continue
            zone = daily.user_zone(db, user_id)
            local = now.replace(tzinfo=datetime.timezone.utc).astimezone(zone)
            if local.weekday() != 6 or local.hour < RECAP_FROM_HOUR:
                continue
            subject = f"week:{iso_week_key(recap_week(now, zone)['monday'])}"
            if db.query(NotificationQueue.id).filter_by(
                user_id=user_id, category="weekly_recap", subject_key=subject
            ).first() is not None:
                continue  # already queued this week: skip before loading the collection
            recap = weekly_recap(db, user_id, now)
            if not recap["has_activity"]:
                continue
            details = {
                "week": recap["week_key"], "cards_added": recap["cards_added"],
                "best_pull_name": (recap["best_pull"] or {}).get("name"), "badges": len(recap["badges"]),
            }
            if notifications.enqueue(db, user_id, "weekly_recap", f"week:{recap['week_key']}", now=now,
                                     details=details):
                queued += 1
        except Exception:
            db.rollback()
            continue
    db.commit()
    return queued


# ---- Wrapped ----

class WrappedUnavailable(Exception):
    pass


def preview_enabled() -> bool:
    return os.getenv(PREVIEW_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def wrapped_available(year: int, today: datetime.date) -> bool:
    return datetime.date(year, *WRAPPED_START) <= today <= datetime.date(year + 1, *WRAPPED_END)


def wrapped(db: Session, user_id: int, year: int, today: datetime.date | None = None,
            now: datetime.datetime | None = None) -> dict:
    """One year of the trainer's collecting. `today` overrides the local date (tests, WRAPPED_PREVIEW).
    With WRAPPED_PREVIEW set and no `today`, the window check is skipped."""
    zone = daily.user_zone(db, user_id)
    real_today = daily.local_today(zone, now)
    if today is None and not preview_enabled():
        today = real_today
    if today is not None and not wrapped_available(year, today):
        raise WrappedUnavailable()
    effective_today = today or real_today
    year_start, year_end = datetime.date(year, 1, 1), datetime.date(year, 12, 31)
    start_utc = _local_midnight(year_start, zone)
    end_utc = _local_midnight(year_end + datetime.timedelta(days=1), zone)
    field = _price_field(db, user_id)

    all_items = (
        db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id)
        .options(joinedload(CollectionItem.card).joinedload(Card.set_ref))
        .filter(CollectionItem.user_id == user_id, visible_any_card_filter(db, user_id, "all"))
        .all()
    )
    items = []
    earliest_added = None
    for item in all_items:
        stamp = _acquired(item)
        if stamp is None or item.card is None:
            continue
        if item.added_at and (earliest_added is None or item.added_at < earliest_added):
            earliest_added = item.added_at
        if start_utc <= stamp < end_utc:
            items.append((item, _local_date(stamp, zone)))

    total = sum(int(i.quantity or 1) for i, _ in items)
    months: Counter = Counter()
    types: Counter = Counter()
    artists: Counter = Counter()
    dex: Counter = Counter()
    dex_names: dict[int, Counter] = defaultdict(Counter)
    sets_touched = set()
    best = None
    first = None
    for item, day in items:
        card, qty = item.card, int(item.quantity or 1)
        months[day.month] += qty
        sets_touched.add((card.set_id, card.lang))
        for raw in (card.types or [])[:1]:
            key = _TYPE_ALIASES.get(str(raw).lower(), str(raw).lower())
            types[key if key in DNA_TYPES else "colorless"] += qty
        if card.artist:
            artists[card.artist.strip()] += qty
        for dex_id in (card.dex_ids or [])[:1]:
            if isinstance(dex_id, int):
                dex[dex_id] += qty
                dex_names[dex_id][card.name] += qty
        stamp = _acquired(item)
        if first is None or (stamp, item.id) < (_acquired(first), first.id):
            first = item
        price = float(effective_market_price(card, item.variant, field) or 0)
        if best is None or (price, -item.id) > (best[0], -best[1].id):
            best = (price, item)

    def card_ref(item, price=None):
        set_row = item.card.set_ref
        ref = {"item_id": item.id, "card_id": item.card.id, "name": item.card.name,
               "variant": item.variant, "image": _image(item.card.id),
               "set_name": set_row.name if set_row else None, "number": item.card.number or None,
               "acquired_on": _local_date(_acquired(item), zone).isoformat()}
        if price is not None:
            ref["price"] = round(price, 2)
        return ref

    def top(counter, label):
        if not counter:
            return None
        key, count = sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0])))[0]
        return {label: key, "count": count}

    top_pokemon = None
    if dex:
        dex_id, count = sorted(dex.items(), key=lambda kv: (-kv[1], kv[0]))[0]
        top_pokemon = {"dex_id": dex_id, "name": dex_names[dex_id].most_common(1)[0][0], "count": count}
    biggest = None
    if months:
        month, count = sorted(months.items(), key=lambda kv: (-kv[1], kv[0]))[0]
        biggest = {"month": month, "count": count}

    events = db.query(UserEvent).filter(
        UserEvent.user_id == user_id, UserEvent.occurred_at >= start_utc, UserEvent.occurred_at < end_utc)
    set_events = events.filter(UserEvent.kind == EVENT_SET_COMPLETED).order_by(
        UserEvent.occurred_at.asc(), UserEvent.id.asc()).all()
    sets_completed = len(set_events)
    completed_sets = [
        {"set_id": e.subject_key, "name": (e.payload or {}).get("set_name") or e.subject_key} for e in set_events
    ]
    xp_year = int(db.query(func.coalesce(func.sum(UserXpLedger.amount), 0)).filter(
        UserXpLedger.user_id == user_id, UserXpLedger.created_at >= start_utc,
        UserXpLedger.created_at < end_utc).scalar() or 0)
    level = level_for_xp(total_xp(db, user_id))
    badges = db.query(UserAchievement).filter(
        UserAchievement.user_id == user_id, UserAchievement.backfilled == False,  # noqa: E712
        UserAchievement.unlocked_at >= start_utc, UserAchievement.unlocked_at < end_utc).count()

    activity = db.query(UserDailyActivity.local_date, UserDailyActivity.data).filter(
        UserDailyActivity.user_id == user_id).order_by(UserDailyActivity.local_date.asc()).all()
    in_year = [(d, data or {}) for d, data in activity if year_start <= d <= year_end]
    streak = compute_streak([d for d, _ in in_year], min(effective_today, year_end))
    wtp_wins = sum(1 for _, data in in_year if (data.get("wtp") or {}).get("correct"))
    quests_done = sum(len((data.get("quests") or {}).get("done") or []) for _, data in in_year)

    snaps = db.query(PortfolioSnapshot).filter(
        PortfolioSnapshot.user_id == user_id, PortfolioSnapshot.date < end_utc, PortfolioSnapshot.date >= start_utc
    ).order_by(PortfolioSnapshot.date.asc(), PortfolioSnapshot.id.asc()).all()
    value = None
    if snaps:
        peak = max(snaps, key=lambda s: float(s.total_value or 0))
        value = {
            "start": round(float(snaps[0].total_value or 0), 2),
            "end": round(float(snaps[-1].total_value or 0), 2),
            "peak": round(float(peak.total_value or 0), 2),
            "peak_date": peak.date.date().isoformat(),
            "start_date": snaps[0].date.date().isoformat(),
            # The last snapshot of each month that has one, so the chart follows the year.
            "series": [{"month": m, "value": v} for m, v in sorted(
                {_local_date(snap.date, zone).month: round(float(snap.total_value or 0), 2) for snap in snaps}.items())],
        }

    trades = db.query(Trade).filter(Trade.user_id == user_id, Trade.trade_date >= year_start,
                                    Trade.trade_date <= year_end).all()
    products = db.query(ProductPurchase).filter(
        ProductPurchase.user_id == user_id, ProductPurchase.purchase_date >= year_start,
        ProductPurchase.purchase_date <= year_end).all()

    starts = [d for d, _ in activity[:1]]
    first_snap = db.query(func.min(PortfolioSnapshot.date)).filter(PortfolioSnapshot.user_id == user_id).scalar()
    first_event = db.query(func.min(UserEvent.occurred_at)).filter(UserEvent.user_id == user_id).scalar()
    for stamp in (first_snap, first_event, earliest_added):
        if stamp:
            starts.append(_local_date(stamp, zone))
    history_starts = min(starts) if starts else None

    return {
        "year": year,
        "history_starts": history_starts.isoformat() if history_starts else None,
        "partial_history": bool(history_starts and history_starts > year_start),
        "totals": {
            "cards": total,
            "unique_cards": len({i.card_id for i, _ in items}),
            "sets_touched": len(sets_touched),
            "sets_completed": sets_completed,
        },
        "first_card": card_ref(first) if first else None,
        "best_pull": card_ref(best[1], best[0]) if best else None,
        "biggest_month": biggest,
        "monthly": [months.get(m, 0) for m in range(1, 13)],
        "completed_sets": completed_sets,
        "closest_set": _closest_set(db, user_id),
        "top_pokemon": top_pokemon,
        "top_type": top(types, "type"),
        "top_illustrator": top(artists, "name"),
        "value": value,
        "longest_streak": streak["best"],
        "wtp_wins": wtp_wins,
        "quests_done": quests_done,
        "badges_earned": badges,
        "level": level,
        "xp_year": xp_year,
        "trades": {
            "count": len(trades),
            "incoming_value": round(sum(float(t.incoming_value or 0) for t in trades), 2),
            "outgoing_value": round(sum(float(t.outgoing_value or 0) for t in trades), 2),
        },
        "products": {
            "count": len(products),
            "spent": round(sum(float(p.purchase_price or 0) for p in products), 2),
        },
    }
