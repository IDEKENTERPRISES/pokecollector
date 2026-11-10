"""Experience points: an idempotent ledger and a gentle level curve."""
from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import UserXpLedger

SOURCE_QUEST = "quest"
SOURCE_QUEST_ALL = "quest_all"
SOURCE_STREAK = "streak"
SOURCE_BADGE = "badge"
SOURCE_SET = "set"
SOURCE_CHALLENGE = "challenge"

QUEST_XP = 10
ALL_QUESTS_XP = 15
STREAK_DAY_XP = 5
SET_XP = 100
BADGE_XP = {"bronze": 20, "silver": 40, "gold": 80}

MAX_LEVEL = 100
CURVE_BASE = 50
CURVE_POWER = 1.5


def xp_for_level(level: int) -> int:
    """Total XP at which `level` starts. Level 1 is 0; 2 is 50; 5 is 400; 10 is 1,350."""
    if level <= 1:
        return 0
    return round(CURVE_BASE * (level - 1) ** CURVE_POWER)


def level_for_xp(xp: int) -> int:
    xp = max(0, int(xp or 0))
    level = 1
    while level < MAX_LEVEL and xp >= xp_for_level(level + 1):
        level += 1
    return level


def level_info(xp: int) -> dict:
    xp = max(0, int(xp or 0))
    level = level_for_xp(xp)
    start = xp_for_level(level)
    end = xp_for_level(level + 1) if level < MAX_LEVEL else start
    return {"xp": xp, "level": level, "level_start": start, "next_level_at": end if level < MAX_LEVEL else None}


def award(db: Session, user_id: int, source: str, source_key: str, amount: int) -> bool:
    """Add XP once per (source, key). Returns True when it was new."""
    if amount <= 0:
        return False
    exists = db.query(UserXpLedger.id).filter(
        UserXpLedger.user_id == user_id, UserXpLedger.source == source, UserXpLedger.source_key == source_key
    ).first()
    if exists:
        return False
    try:
        with db.begin_nested():
            db.add(UserXpLedger(user_id=user_id, source=source, source_key=source_key, amount=amount))
        return True
    except IntegrityError:
        return False


def total_xp(db: Session, user_id: int) -> int:
    return int(db.query(func.coalesce(func.sum(UserXpLedger.amount), 0)).filter(
        UserXpLedger.user_id == user_id).scalar() or 0)


def totals_for(db: Session, user_ids) -> dict[int, int]:
    rows = db.query(UserXpLedger.user_id, func.sum(UserXpLedger.amount)).filter(
        UserXpLedger.user_id.in_(list(user_ids))).group_by(UserXpLedger.user_id).all()
    return {user_id: int(total or 0) for user_id, total in rows}
