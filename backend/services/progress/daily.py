"""The daily loop for one trainer: today's quests, streak, XP and the Pokémon of the day."""
from __future__ import annotations

import datetime
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from models import UserDailyActivity, UserSetting
from services.progress import quests as quest_module
from services.progress import xp as xp_module
from services.progress.checkin import MAX_AGE_DAYS, TIME_ZONE_KEY, CheckinError, validate_time_zone
from services.progress.streak import compute_streak


def user_zone(db: Session, user_id: int) -> ZoneInfo:
    row = db.query(UserSetting).filter(UserSetting.user_id == user_id, UserSetting.key == TIME_ZONE_KEY).first()
    try:
        return validate_time_zone(row.value if row else "UTC")
    except CheckinError:
        return ZoneInfo("UTC")


def local_today(zone: ZoneInfo, now: datetime.datetime | None = None) -> datetime.date:
    now = now or datetime.datetime.utcnow()
    return now.replace(tzinfo=datetime.timezone.utc).astimezone(zone).date()


def parse_local_date(value, today: datetime.date) -> datetime.date:
    try:
        day = datetime.date.fromisoformat(value)
    except (TypeError, ValueError):
        raise CheckinError("date must be YYYY-MM-DD")
    if day > today + datetime.timedelta(days=1) or day < today - datetime.timedelta(days=MAX_AGE_DAYS):
        raise CheckinError("date is out of range")
    return day


def activity_row(db: Session, user_id: int, day: datetime.date, now=None, create: bool = False):
    row = db.query(UserDailyActivity).filter(
        UserDailyActivity.user_id == user_id, UserDailyActivity.local_date == day).first()
    if row is None and create:
        now = now or datetime.datetime.utcnow()
        row = UserDailyActivity(
            user_id=user_id, local_date=day, first_seen_at=now, last_seen_at=now, opens=1, offline=True, data={})
        db.add(row)
        db.flush()
    return row


def set_activity_flag(db: Session, user_id: int, day: datetime.date, key: str, value) -> bool:
    """Record a fact about a day once; the first value wins. Returns True when it was new."""
    row = activity_row(db, user_id, day, create=True)
    data = dict(row.data or {})
    if data.get(key):
        return False
    data[key] = value
    row.data = data
    db.flush()
    return True


def sync_daily(db: Session, user_id: int, day: datetime.date | None = None) -> dict:
    """Check the day's quests, store the ones met, and award their XP. Idempotent; does not commit."""
    zone = user_zone(db, user_id)
    day = day or local_today(zone)
    chosen = quest_module.select_quests(user_id, day)
    row = activity_row(db, user_id, day)
    if row is None:
        return {"date": day, "chosen": chosen, "done": []}
    data = dict(row.data or {})
    met = quest_module.check_quests(db, user_id, day, zone, data)
    stored = set((data.get("quests") or {}).get("done") or [])
    done = sorted(stored | (met & set(chosen)), key=quest_module.QUEST_IDS.index)
    if set(done) != stored:
        data["quests"] = {"chosen": chosen, "done": done}
        row.data = data
    for quest_id in done:
        xp_module.award(db, user_id, xp_module.SOURCE_QUEST, f"{day.isoformat()}:{quest_id}", xp_module.QUEST_XP)
    if len(done) == len(chosen):
        xp_module.award(db, user_id, xp_module.SOURCE_QUEST_ALL, day.isoformat(), xp_module.ALL_QUESTS_XP)
    db.flush()
    return {"date": day, "chosen": chosen, "done": done}


QUEST_CELEBRATION_DAYS = 2  # today and yesterday: older quests are never celebrated late


def unseen_quest_completions(db: Session, user_id: int, today: datetime.date) -> list[dict]:
    """Quests completed but not yet celebrated, oldest first: [{key, date, quest_id, xp, bonus_xp}].

    The key is "<date>:<quest_id>", the ledger's own source key. When the day's last quest finished
    all of them, `bonus_xp` carries the all-quests bonus on that final quest."""
    from models import UserXpLedger

    oldest = (today - datetime.timedelta(days=QUEST_CELEBRATION_DAYS - 1)).isoformat()
    rows = db.query(UserXpLedger).filter(
        UserXpLedger.user_id == user_id, UserXpLedger.source == xp_module.SOURCE_QUEST,
        UserXpLedger.seen_at.is_(None), UserXpLedger.source_key >= f"{oldest}:",
    ).order_by(UserXpLedger.created_at.asc(), UserXpLedger.id.asc()).all()
    if not rows:
        return []
    bonuses = {row.source_key: row for row in db.query(UserXpLedger).filter(
        UserXpLedger.user_id == user_id, UserXpLedger.source == xp_module.SOURCE_QUEST_ALL,
        UserXpLedger.source_key.in_({row.source_key.split(":", 1)[0] for row in rows}))}
    # The bonus rides on the quest that finished the day: the latest award of that day.
    latest = {}
    for row in db.query(UserXpLedger).filter(
        UserXpLedger.user_id == user_id, UserXpLedger.source == xp_module.SOURCE_QUEST,
        UserXpLedger.source_key.in_([f"{day}:{quest}" for day in bonuses for quest in quest_module.QUEST_IDS]),
    ).order_by(UserXpLedger.created_at.asc(), UserXpLedger.id.asc()):
        latest[row.source_key.split(":", 1)[0]] = row.source_key
    items = []
    for row in rows:
        day, _, quest_id = row.source_key.partition(":")
        if quest_id not in quest_module.QUEST_IDS:
            continue
        bonus = bonuses.get(day)
        items.append({
            "key": row.source_key,
            "date": day,
            "quest_id": quest_id,
            "xp": int(row.amount),
            "bonus_xp": int(bonus.amount) if bonus and latest.get(day) == row.source_key else 0,
            "completed_at": row.created_at.isoformat() if row.created_at else None,
        })
    return items


def mark_quests_seen(db: Session, user_id: int, keys=None) -> int:
    """Celebrated: the given quest keys, or every unseen quest award when `keys` is None."""
    from models import UserXpLedger

    query = db.query(UserXpLedger).filter(
        UserXpLedger.user_id == user_id, UserXpLedger.source == xp_module.SOURCE_QUEST,
        UserXpLedger.seen_at.is_(None))
    if keys is not None:
        query = query.filter(UserXpLedger.source_key.in_(list(keys)))
    now = datetime.datetime.utcnow()
    count = 0
    for row in query.all():
        row.seen_at = now
        count += 1
    return count


def award_streak_xp(db: Session, user_id: int, streak: dict) -> None:
    for day in streak["run_days"]:
        xp_module.award(db, user_id, xp_module.SOURCE_STREAK, day.isoformat(), xp_module.STREAK_DAY_XP)


def user_streak(db: Session, user_id: int, today: datetime.date) -> dict:
    days = [d for (d,) in db.query(UserDailyActivity.local_date).filter(UserDailyActivity.user_id == user_id)]
    return compute_streak(days, today)


def daily_stats(db: Session, user_id: int) -> dict:
    """Metrics for the daily-track badges."""
    today = local_today(user_zone(db, user_id))
    rows = db.query(UserDailyActivity.local_date, UserDailyActivity.data).filter(
        UserDailyActivity.user_id == user_id).order_by(UserDailyActivity.local_date.asc()).all()
    streak = compute_streak([day for day, _ in rows], today)
    wins, best_run, run, previous = 0, 0, 0, None
    quests_done = 0
    for day, data in rows:
        data = data or {}
        quests_done += len((data.get("quests") or {}).get("done") or [])
        wtp = data.get("wtp")
        if not wtp:
            continue
        if wtp.get("correct"):
            wins += 1
            run = run + 1 if previous is not None and (day - previous).days == 1 else 1
            best_run = max(best_run, run)
            previous = day
        else:
            run, previous = 0, None
    return {
        "streak_best": max(streak["best"], streak["current"]),
        "wtp_wins": wins,
        "wtp_best_run": best_run,
        "quests_done": quests_done,
    }


def _species_cards(db: Session, dex_id: int):
    from models import Card
    from services.digital_sets import digital_sets_enabled
    from services.pokedex import normalize_dex_ids

    query = db.query(Card).filter(Card.is_custom == False, Card.dex_ids.isnot(None))  # noqa: E712
    if not digital_sets_enabled(db):
        query = query.filter(Card.is_digital == False)  # noqa: E712
    if db.get_bind().dialect.name == "postgresql":
        from sqlalchemy import cast
        from sqlalchemy.dialects.postgresql import JSONB

        return query.filter(Card.dex_ids.op("@>")(cast([dex_id], JSONB))).all()
    return [card for card in query.all() if dex_id in normalize_dex_ids(card.dex_ids)]


def _print_summary(price, card, with_set: bool = False) -> dict:
    entry = {"card_id": card.id, "name": card.name, "price": round(float(price), 2)}
    if with_set:
        set_ref = getattr(card, "set_ref", None)
        entry["set_name"] = getattr(set_ref, "name", None) or card.set_id
        entry["number"] = card.number
        entry["lang"] = card.lang
    return entry


def pokemon_of_day_info(db: Session, user_id: int, day: datetime.date) -> dict:
    """How many printings of the day's Pokémon the trainer owns, the cheapest printing when they own
    none, and the most expensive printing (owned or not), both by the trainer's price field. The
    cheapest and most expensive lines only offer printings in the server's catalogue languages."""
    from models import CollectionItem
    from services.card_values import effective_market_price
    from services.card_visibility import get_configured_sync_languages
    from services.pokedex_splash import species_for_date
    from services.sync_service import _user_price_field

    dex_id = species_for_date(day)
    cards = _species_cards(db, dex_id)
    ids = [card.id for card in cards]
    owned = set()
    if ids:
        owned = {card_id for (card_id,) in db.query(CollectionItem.card_id).filter(
            CollectionItem.user_id == user_id, CollectionItem.card_id.in_(ids)).distinct()}
    info = {"dex_id": dex_id, "owned_printings": len(owned), "cheapest": None, "most_expensive": None}
    field = _user_price_field(db, user_id)
    languages = set(get_configured_sync_languages(db))
    priced = [(effective_market_price(card, None, field), card) for card in cards if card.lang in languages]
    priced = [(price, card) for price, card in priced if price and price > 0]
    if priced:
        if not owned:
            price, card = min(priced, key=lambda pair: (pair[0], pair[1].id))
            info["cheapest"] = _print_summary(price, card)
        price, card = min(priced, key=lambda pair: (-pair[0], pair[1].id))
        info["most_expensive"] = _print_summary(price, card, with_set=True)
    return info


def today_summary(db: Session, user_id: int, day: datetime.date) -> dict:
    zone = user_zone(db, user_id)
    result = sync_daily(db, user_id, day)
    streak = user_streak(db, user_id, local_today(zone))
    award_streak_xp(db, user_id, streak)
    row = activity_row(db, user_id, day)
    wtp = (row.data or {}).get("wtp") if row else None
    db.commit()
    return {
        "date": day.isoformat(),
        "streak": {
            "current": streak["current"], "best": streak["best"],
            "freeze_available": streak["freeze_available"], "active_today": streak["active_today"],
        },
        "quests": [{"id": q, "done": q in result["done"]} for q in result["chosen"]],
        "xp": xp_module.level_info(xp_module.total_xp(db, user_id)),
        "pokemon": pokemon_of_day_info(db, user_id, day),
        "wtp": {"played": bool(wtp), "correct": bool(wtp and wtp.get("correct"))},
    }
