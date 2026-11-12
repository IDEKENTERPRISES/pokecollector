"""Administrator-sent notifications (Settings > Administrator), mounted under /api/admin.

An admin writes a title and a message, picks where it opens (from a fixed list) and who gets it.
Each recipient gets one `announcements` row in the notification queue, so quiet hours, push and
Telegram behave like the other instant categories. Every send is stored and written to the audit log.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import AdminNotification, User
from services import notifications
from services.audit import record_audit

router = APIRouter()

MAX_TITLE = 60
MAX_BODY = 240
MAX_SENDS_PER_HOUR = 10
HISTORY_LIMIT = 50


class SendNotificationRequest(BaseModel):
    title: str = Field(max_length=200)
    body: str = Field(max_length=2000)
    route: str = "/"
    recipients: Literal["all"] | list[int] = "all"

    @field_validator("title", "body")
    @classmethod
    def _tidy(cls, value: str) -> str:
        return " ".join((value or "").split())


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() + "Z" if value else None


def serialize(row: AdminNotification) -> dict:
    return {
        "id": row.id,
        "created_at": _iso(row.created_at),
        "sent_by": row.sent_by_username,
        "title": row.title,
        "body": row.body,
        "route": row.route,
        "recipient_count": row.recipient_count,
        "queued_count": row.queued_count,
        "skipped_count": row.skipped_count,
    }


@router.post("/notifications")
def send_notification(
    payload: SendNotificationRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    if not payload.title or len(payload.title) > MAX_TITLE:
        raise HTTPException(status_code=422, detail=f"Title is required and at most {MAX_TITLE} characters")
    if not payload.body or len(payload.body) > MAX_BODY:
        raise HTTPException(status_code=422, detail=f"Message is required and at most {MAX_BODY} characters")
    if payload.route not in notifications.ANNOUNCEMENT_ROUTES:
        raise HTTPException(status_code=422, detail="Unknown page to open")

    active = {uid for (uid,) in db.query(User.id).filter(User.is_active == True).all()}  # noqa: E712
    if payload.recipients == "all":
        user_ids = sorted(active)
    else:
        user_ids = sorted(set(payload.recipients))
        if not user_ids:
            raise HTTPException(status_code=422, detail="Choose at least one trainer")
        unknown = [uid for uid in user_ids if uid not in active]
        if unknown:
            raise HTTPException(status_code=422, detail=f"Unknown trainers: {unknown}")

    now = datetime.utcnow()
    recent = db.query(AdminNotification).filter(
        AdminNotification.sent_by_user_id == current_user.id,
        AdminNotification.created_at > now - timedelta(hours=1),
    ).count()
    if recent >= MAX_SENDS_PER_HOUR:
        raise HTTPException(status_code=429, detail="You can send at most 10 notifications an hour")

    record = AdminNotification(
        created_at=now, sent_by_user_id=current_user.id, sent_by_username=current_user.username,
        title=payload.title, body=payload.body, route=payload.route,
        recipient_count=len(user_ids), queued_count=0, skipped_count=0,
    )
    db.add(record)
    db.flush()
    queued = skipped = 0
    for user_id in user_ids:
        outcome = notifications.queue_announcement(
            db, user_id, record.id, payload.title, payload.body, payload.route, now=now
        )
        if outcome == "queued":
            queued += 1
        else:
            skipped += 1
    record.queued_count, record.skipped_count = queued, skipped
    record_audit(
        db, "admin.notification_sent", request=request, actor=current_user,
        target_type="admin_notification", target_id=record.id,
        details={
            "title": payload.title, "route": payload.route,
            "recipients": "all" if payload.recipients == "all" else len(user_ids),
            "recipient_count": len(user_ids), "queued": queued, "skipped": skipped,
        },
        commit=False,
    )
    db.commit()
    return {"id": record.id, "recipient_count": len(user_ids), "queued": queued, "skipped": skipped}


@router.get("/notifications")
def list_notifications(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_admin(current_user)
    rows = db.query(AdminNotification).order_by(AdminNotification.id.desc()).limit(HISTORY_LIMIT).all()
    return {"entries": [serialize(row) for row in rows]}
