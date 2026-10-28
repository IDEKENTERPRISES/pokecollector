"""Daily quests: three a day from a catalogue, chosen per user and local date, checked from data."""
from __future__ import annotations

import datetime
import hashlib
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

QUESTS_PER_DAY = 3

# id -> what it needs. The strings shown to the trainer live in en.js under `today.quest.<id>`.
QUEST_IDS = (
    "review_scans",
    "binder_card",
    "view_pokemon",
    "play_wtp",
    "missing_closest",
    "add_card",
    "wishlist_card",
)


def select_quests(user_id: int, day: datetime.date) -> list[str]:
    """The same three quests for a user and date, whatever the process or machine."""
    def rank(quest_id: str) -> str:
        return hashlib.sha256(f"{user_id}:{day.isoformat()}:{quest_id}".encode()).hexdigest()

    return sorted(sorted(QUEST_IDS, key=rank)[:QUESTS_PER_DAY], key=QUEST_IDS.index)


def day_bounds_utc(day: datetime.date, zone: ZoneInfo) -> tuple[datetime.datetime, datetime.datetime]:
    """Naive UTC start (inclusive) and end (exclusive) of a local day."""
    start = datetime.datetime(day.year, day.month, day.day, tzinfo=zone)
    end = start + datetime.timedelta(days=1)
    utc = datetime.timezone.utc
    return (start.astimezone(utc).replace(tzinfo=None), end.astimezone(utc).replace(tzinfo=None))


def _closest_set_key(db: Session, user_id: int):
    """(set_id, lang) of the incomplete set the trainer has the largest share of, else None."""
    from sqlalchemy import func

    from models import Card, CollectionItem

    owned = {}
    for set_id, lang, count in db.query(Card.set_id, Card.lang, func.count(func.distinct(Card.id))).join(
        CollectionItem, CollectionItem.card_id == Card.id
    ).filter(
        CollectionItem.user_id == user_id, Card.is_custom == False, Card.set_id.isnot(None),  # noqa: E712
    ).group_by(Card.set_id, Card.lang).all():
        owned[(set_id, lang)] = count
    if not owned:
        return None
    sizes = {
        (row.set_id, row.lang): row.n
        for row in db.query(Card.set_id, Card.lang, func.count(Card.id).label("n")).filter(
            Card.set_id.in_({key[0] for key in owned}), Card.is_custom == False  # noqa: E712
        ).group_by(Card.set_id, Card.lang).all()
    }
    best, best_ratio = None, 0.0
    for key, count in sorted(owned.items()):
        total = sizes.get(key) or 0
        if total and count < total and count / total > best_ratio:
            best, best_ratio = key, count / total
    return best


def check_quests(db: Session, user_id: int, day: datetime.date, zone: ZoneInfo, activity_data: dict) -> set[str]:
    """Which quests of the catalogue are met on this local day (the caller keeps only the chosen ones)."""
    from models import Binder, BinderCard, Card, CollectionItem, ScanJobItem, WishlistItem

    start, end = day_bounds_utc(day, zone)
    done: set[str] = set()
    if db.query(ScanJobItem.id).filter(
        ScanJobItem.user_id == user_id, ScanJobItem.resolved == True,  # noqa: E712
        ScanJobItem.status == "done", ScanJobItem.updated_at >= start, ScanJobItem.updated_at < end,
    ).first():
        done.add("review_scans")
    if db.query(BinderCard.id).join(Binder, Binder.id == BinderCard.binder_id).filter(
        Binder.user_id == user_id, BinderCard.added_at >= start, BinderCard.added_at < end,
    ).first():
        done.add("binder_card")
    if activity_data.get("viewed"):
        done.add("view_pokemon")
    if activity_data.get("wtp"):
        done.add("play_wtp")
    added = db.query(CollectionItem.card_id).filter(
        CollectionItem.user_id == user_id, CollectionItem.added_at >= start, CollectionItem.added_at < end,
    ).all()
    if added:
        done.add("add_card")
        closest = _closest_set_key(db, user_id)
        added_ids = [card_id for (card_id,) in added]
        # The closest set is the one still incomplete after today's pulls; a pull that finished a set counts too.
        sets_of_added = {(set_id, lang) for set_id, lang in db.query(Card.set_id, Card.lang).filter(
            Card.id.in_(added_ids))}
        if closest in sets_of_added or _finished_a_set(db, user_id, sets_of_added):
            done.add("missing_closest")
    if db.query(WishlistItem.id).filter(
        WishlistItem.user_id == user_id, WishlistItem.created_at >= start, WishlistItem.created_at < end,
    ).first():
        done.add("wishlist_card")
    return done


def _finished_a_set(db: Session, user_id: int, set_keys) -> bool:
    from sqlalchemy import func

    from models import Card, CollectionItem

    for set_id, lang in set_keys:
        if not set_id:
            continue
        total = db.query(func.count(Card.id)).filter(
            Card.set_id == set_id, Card.lang == lang, Card.is_custom == False).scalar() or 0  # noqa: E712
        have = db.query(func.count(func.distinct(Card.id))).join(
            CollectionItem, CollectionItem.card_id == Card.id
        ).filter(CollectionItem.user_id == user_id, Card.set_id == set_id, Card.lang == lang).scalar() or 0
        if total and have >= total:
            return True
    return False
