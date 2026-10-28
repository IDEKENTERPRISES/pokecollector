import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User, UserAchievement, UserEvent
from services.progress.checkin import CheckinError, record_checkin

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


def _unseen_query(db: Session, user_id: int):
    return db.query(UserAchievement).filter(
        UserAchievement.user_id == user_id, UserAchievement.seen_at.is_(None)
    ).order_by(UserAchievement.unlocked_at.asc(), UserAchievement.id.asc())


@router.get("/unlocks/unseen")
def unseen_unlocks(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Badges earned but not yet celebrated, oldest first. Works in single-user mode."""
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
    return {"unlocks": items}


@router.post("/unlocks/seen")
def mark_unlocks_seen(
    body: SeenRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mark badges as celebrated: the given ids, or every unseen one when `ids` is omitted."""
    query = _unseen_query(db, current_user.id)
    if body.ids is not None:
        query = query.filter(UserAchievement.achievement_id.in_(body.ids))
    now = datetime.datetime.utcnow()
    count = 0
    for row in query.all():
        row.seen_at = now
        count += 1
    db.commit()
    return {"marked": count}
