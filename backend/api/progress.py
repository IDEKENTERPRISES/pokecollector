import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User, UserAchievement, UserEvent
from services.progress import daily
from services.progress.checkin import CheckinError, record_checkin
from services.progress.state import mark_users_dirty

router = APIRouter()


class CheckinRequest(BaseModel):
    time_zone: str
    dates: List[str]


@router.post("/checkin")
def checkin(
    body: CheckinRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Record the phone's time zone and the local days the app was opened."""
    try:
        return record_checkin(db, current_user.id, body.time_zone, body.dates)
    except CheckinError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/events")
def list_events(
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The current user's own progress events, newest first."""
    rows = db.query(UserEvent).filter(UserEvent.user_id == current_user.id).order_by(
        UserEvent.occurred_at.desc(), UserEvent.id.desc()
    ).limit(limit).all()
    return [
        {
            "id": row.id,
            "kind": row.kind,
            "occurred_at": row.occurred_at.isoformat() if row.occurred_at else None,
            "subject_key": row.subject_key,
            "payload": row.payload or {},
        }
        for row in rows
    ]


class SeenRequest(BaseModel):
    ids: Optional[List[str]] = None
    quest_keys: Optional[List[str]] = None


def _unseen_query(db: Session, user_id: int):
    return db.query(UserAchievement).filter(
        UserAchievement.user_id == user_id, UserAchievement.seen_at.is_(None)
    ).order_by(UserAchievement.unlocked_at.asc(), UserAchievement.id.asc())


@router.get("/unlocks/unseen")
def unseen_unlocks(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Badges earned and daily quests completed but not yet celebrated, oldest first. Works in
    single-user mode."""
    from services.achievements import registry_by_id

    known = registry_by_id()
    items = []
    for row in _unseen_query(db, current_user.id).all():
        config = known.get(row.achievement_id)
        if config is None:
            continue
        items.append({
            "id": config["id"],
            "name_key": config["name_key"],
            "description_key": config["description_key"],
            "tier": config["tier"],
            "track": config["track"],
            "art": config.get("art"),
            "badge_id": config.get("badge_id"),
            "unlocked_at": row.unlocked_at.isoformat() if row.unlocked_at else None,
        })
    today = daily.local_today(daily.user_zone(db, current_user.id))
    return {"unlocks": items, "quests": daily.unseen_quest_completions(db, current_user.id, today)}


@router.post("/unlocks/seen")
def mark_unlocks_seen(
    body: SeenRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mark celebrations as seen. `ids` are badges and `quest_keys` are quest completions; with
    neither given, every unseen badge and quest is marked. Naming only one kind leaves the other."""
    everything = body.ids is None and body.quest_keys is None
    now = datetime.datetime.utcnow()
    count = 0
    if everything or body.ids is not None:
        query = _unseen_query(db, current_user.id)
        if body.ids is not None:
            query = query.filter(UserAchievement.achievement_id.in_(body.ids))
        for row in query.all():
            row.seen_at = now
            count += 1
    quests_marked = 0
    if everything or body.quest_keys is not None:
        quests_marked = daily.mark_quests_seen(db, current_user.id, None if everything else body.quest_keys)
    db.commit()
    return {"marked": count, "quests_marked": quests_marked}


def _requested_day(db: Session, user_id: int, value):
    today = daily.local_today(daily.user_zone(db, user_id))
    if value is None:
        return today
    try:
        return daily.parse_local_date(value, today)
    except CheckinError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/today")
def today_card(
    date: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The Today card: streak, three quests, XP and level, the Pokémon of the day's ownership."""
    day = _requested_day(db, current_user.id, date)
    return daily.today_summary(db, current_user.id, day)


class DayRequest(BaseModel):
    date: Optional[str] = None


@router.post("/daily/view")
def view_pokemon_of_day(
    body: DayRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The trainer looked at today's Pokémon: the "look at today's Pokémon" quest."""
    day = _requested_day(db, current_user.id, body.date)
    daily.set_activity_flag(db, current_user.id, day, "viewed", True)
    db.commit()
    return daily.today_summary(db, current_user.id, day)


class WtpAnswer(BaseModel):
    date: str
    dex_id: int


@router.post("/wtp/answer")
def answer_wtp(
    body: WtpAnswer,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Record the trainer's one try at Who's That Pokémon. The first answer for a date wins, so
    replaying an offline result is harmless."""
    from services.progress.wtp import wtp_species

    day = _requested_day(db, current_user.id, body.date)
    answer = wtp_species(day)
    correct = body.dex_id == answer
    daily.set_activity_flag(db, current_user.id, day, "wtp", {"dex_id": body.dex_id, "correct": correct})
    row = daily.activity_row(db, current_user.id, day)
    stored = (row.data or {}).get("wtp") or {}
    db.commit()
    mark_users_dirty(db, [current_user.id])
    summary = daily.today_summary(db, current_user.id, day)
    return {"correct": bool(stored.get("correct")), "answer": answer, "chosen": stored.get("dex_id"), "today": summary}
