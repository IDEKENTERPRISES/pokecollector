from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User, UserEvent
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
