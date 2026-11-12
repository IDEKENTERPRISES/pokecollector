"""Admin banners: messages an administrator shows as a card on trainers' Home.

Admin endpoints are mounted under /api/admin (`admin_router`), trainer endpoints under /api/banners
(`router`). The sender name and picture are stored as they were when the banner was saved. Text is
plain text; the route comes from a fixed list. Every action is written to the audit log.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import Banner, BannerDismissal, User
from services import notifications
from services.audit import record_audit

admin_router = APIRouter()
router = APIRouter()

MAX_MESSAGE = 280
MAX_NAME = 40
STYLES = ("info", "success", "warning", "alert")
LIST_LIMIT = 100


class BannerRequest(BaseModel):
    message: str = Field(max_length=2000)
    sender_mode: Literal["me", "custom"] = "me"
    sender_name: str | None = Field(default=None, max_length=200)
    avatar_mode: Literal["me", "pokemon"] = "me"
    avatar_id: int | None = None
    style: str = "info"
    route: str | None = None
    audience: Literal["all", "some"] = "all"
    user_ids: list[int] = []
    ends_at: datetime | None = None
    dismissible: bool = True

    @field_validator("message", "sender_name")
    @classmethod
    def _tidy(cls, value):
        return None if value is None else " ".join(value.split())


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() + "Z" if value else None


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _audience_ids(row: Banner) -> list[int]:
    try:
        return [int(x) for x in json.loads(row.audience_user_ids or "[]")]
    except (ValueError, TypeError):
        return []


def _status(row: Banner, now: datetime) -> str:
    if row.ended_at is not None:
        return "ended"
    if row.ends_at is not None and row.ends_at <= now:
        return "expired"
    return "active"


def serialize_admin(row: Banner, now: datetime) -> dict:
    return {
        "id": row.id,
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
        "created_by_user_id": row.created_by_user_id,
        "sender_mode": row.sender_mode,
        "sender_name": row.sender_name,
        "avatar_mode": row.avatar_mode,
        "avatar_id": row.avatar_id,
        "message": row.message,
        "style": row.style,
        "route": row.route,
        "audience": row.audience,
        "user_ids": _audience_ids(row),
        "ends_at": _iso(row.ends_at),
        "ended_at": _iso(row.ended_at),
        "dismissible": bool(row.dismissible),
        "status": _status(row, now),
    }


def serialize_trainer(row: Banner) -> dict:
    return {
        "id": row.id,
        "created_at": _iso(row.created_at),
        "label": "admin" if row.sender_mode == "me" else "system",
        "sender_name": row.sender_name,
        "avatar_id": row.avatar_id,
        "message": row.message,
        "style": row.style,
        "route": row.route,
        "dismissible": bool(row.dismissible),
    }


def _apply(payload: BannerRequest, row: Banner, current_user: User, db: Session) -> None:
    """Validate the payload and copy it onto `row` (sender and picture are fixed at save time)."""
    if not payload.message or len(payload.message) > MAX_MESSAGE:
        raise HTTPException(status_code=422, detail=f"Message is required and at most {MAX_MESSAGE} characters")
    if payload.style not in STYLES:
        raise HTTPException(status_code=422, detail="Unknown style")
    route = payload.route or None
    if route is not None and route not in notifications.ANNOUNCEMENT_ROUTES:
        raise HTTPException(status_code=422, detail="Unknown page to open")

    if payload.sender_mode == "me":
        sender_name = current_user.username
    else:
        sender_name = payload.sender_name or ""
        if not sender_name or len(sender_name) > MAX_NAME:
            raise HTTPException(status_code=422, detail=f"Name is required and at most {MAX_NAME} characters")

    if payload.avatar_mode == "me":
        avatar_id = current_user.avatar_id
    else:
        avatar_id = payload.avatar_id
        if avatar_id is None or not 1 <= avatar_id <= 151:
            raise HTTPException(status_code=422, detail="Choose a Pokémon from 1 to 151")

    user_ids: list[int] = []
    if payload.audience == "some":
        user_ids = sorted(set(payload.user_ids))
        if not user_ids:
            raise HTTPException(status_code=422, detail="Choose at least one trainer")
        active = {uid for (uid,) in db.query(User.id).filter(User.is_active == True).all()}  # noqa: E712
        unknown = [uid for uid in user_ids if uid not in active]
        if unknown:
            raise HTTPException(status_code=422, detail=f"Unknown trainers: {unknown}")

    ends_at = _naive_utc(payload.ends_at)
    if ends_at is not None and ends_at <= datetime.utcnow():
        raise HTTPException(status_code=422, detail="The end time must be in the future")

    row.sender_mode, row.sender_name = payload.sender_mode, sender_name
    row.avatar_mode, row.avatar_id = payload.avatar_mode, avatar_id
    row.message, row.style, row.route = payload.message, payload.style, route
    row.audience = payload.audience
    row.audience_user_ids = json.dumps(user_ids) if payload.audience == "some" else None
    row.ends_at = ends_at
    row.dismissible = payload.dismissible


def _audit_details(row: Banner) -> dict:
    details = {
        "banner_id": row.id,
        "sender_mode": row.sender_mode,
        "audience": "all" if row.audience == "all" else _audience_ids(row),
    }
    if row.sender_mode == "custom":
        details["sender_name"] = row.sender_name
    return details


def _get(db: Session, banner_id: int) -> Banner:
    row = db.get(Banner, banner_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Banner not found")
    return row


@admin_router.post("/banners")
def create_banner(
    payload: BannerRequest, request: Request,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    _require_admin(current_user)
    row = Banner(created_at=datetime.utcnow(), created_by_user_id=current_user.id)
    _apply(payload, row, current_user, db)
    db.add(row)
    db.flush()
    record_audit(
        db, "banner.created", request=request, actor=current_user,
        target_type="banner", target_id=row.id, details=_audit_details(row), commit=False,
    )
    db.commit()
    return serialize_admin(row, datetime.utcnow())


@admin_router.get("/banners")
def list_banners(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_admin(current_user)
    now = datetime.utcnow()
    rows = db.query(Banner).order_by(Banner.id.desc()).limit(LIST_LIMIT).all()
    return {"entries": [serialize_admin(row, now) for row in rows]}


@admin_router.put("/banners/{banner_id}")
def update_banner(
    banner_id: int, payload: BannerRequest, request: Request,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    _require_admin(current_user)
    row = _get(db, banner_id)
    _apply(payload, row, current_user, db)
    row.updated_at = datetime.utcnow()
    record_audit(
        db, "banner.updated", request=request, actor=current_user,
        target_type="banner", target_id=row.id, details=_audit_details(row), commit=False,
    )
    db.commit()
    return serialize_admin(row, datetime.utcnow())


@admin_router.post("/banners/{banner_id}/end")
def end_banner(
    banner_id: int, request: Request,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    _require_admin(current_user)
    row = _get(db, banner_id)
    if row.ended_at is None:
        row.ended_at = datetime.utcnow()
    record_audit(
        db, "banner.ended", request=request, actor=current_user,
        target_type="banner", target_id=row.id, details=_audit_details(row), commit=False,
    )
    db.commit()
    return serialize_admin(row, datetime.utcnow())


@admin_router.delete("/banners/{banner_id}")
def delete_banner(
    banner_id: int, request: Request,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    _require_admin(current_user)
    row = _get(db, banner_id)
    details = _audit_details(row)
    db.query(BannerDismissal).filter(BannerDismissal.banner_id == row.id).delete()
    db.delete(row)
    record_audit(
        db, "banner.deleted", request=request, actor=current_user,
        target_type="banner", target_id=banner_id, details=details, commit=False,
    )
    db.commit()
    return {"deleted": True}


@router.get("/active")
def active_banners(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    dismissed = {
        bid for (bid,) in db.query(BannerDismissal.banner_id).filter(BannerDismissal.user_id == current_user.id).all()
    }
    rows = db.query(Banner).filter(Banner.ended_at.is_(None)).order_by(Banner.id.desc()).all()
    visible = []
    for row in rows:
        if row.ends_at is not None and row.ends_at <= now:
            continue
        if row.id in dismissed:
            continue
        if row.audience == "some" and current_user.id not in _audience_ids(row):
            continue
        visible.append(serialize_trainer(row))
    return {"banners": visible}


@router.post("/{banner_id}/dismiss")
def dismiss_banner(
    banner_id: int, request: Request,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    row = _get(db, banner_id)
    if row.audience == "some" and current_user.id not in _audience_ids(row):
        raise HTTPException(status_code=404, detail="Banner not found")
    if not row.dismissible:
        raise HTTPException(status_code=409, detail="This banner cannot be dismissed")
    exists = db.query(BannerDismissal).filter(
        BannerDismissal.banner_id == row.id, BannerDismissal.user_id == current_user.id
    ).first()
    if exists is None:
        db.add(BannerDismissal(banner_id=row.id, user_id=current_user.id, created_at=datetime.utcnow()))
        record_audit(
            db, "banner.dismissed", request=request, actor=current_user,
            target_type="banner", target_id=row.id, details=_audit_details(row), commit=False,
        )
        db.commit()
    return {"dismissed": True}
