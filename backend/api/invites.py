"""Invite links and the audit log (mounted under /api/auth).

Admins issue single-use, expiring invite links; whoever opens one can create an account with the
invite's role. Only a hash of the token is stored. Every step is written to the audit log.
"""

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.auth import (
    TokenResponse,
    get_current_user,
    multi_user_enabled,
    validate_new_password,
)
from database import get_db
from models import AuditLog, Invite, User
from services.audit import record_audit, serialize_audit
from services.auth import ACCESS_TOKEN_EXPIRE_MINUTES, create_access_token, hash_password
from services.client_ip import client_ip
from services.login_throttle import LoginThrottle
from services.sessions import create_session

router = APIRouter()

# Accept and check attempts with a bad token are throttled per client address, separately from
# logins so a refused invite never locks anyone out of signing in.
invite_throttle = LoginThrottle()

REJECT_MESSAGES = {
    "not_found": "This invite link is not valid.",
    "used": "This invite has already been used.",
    "revoked": "This invite was revoked.",
    "expired": "This invite has expired.",
    "multi_user_off": "Invites are not available right now.",
}
MIN_USERNAME = 2
MAX_USERNAME = 32


class CreateInviteRequest(BaseModel):
    role: Literal["trainer", "admin"] = "trainer"
    expires_in_days: Literal[1, 7, 30] = 7
    note: str | None = Field(default=None, max_length=200)


class AcceptInviteRequest(BaseModel):
    username: str
    password: str


def _hash_token(token: str) -> str:
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.utcnow()


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() + "Z" if value else None


def invite_status(invite: Invite, now: datetime | None = None) -> str:
    if invite.used_at is not None:
        return "used"
    if invite.revoked_at is not None:
        return "revoked"
    if invite.expires_at <= (now or _now()):
        return "expired"
    return "pending"


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


def _require_multi_user(db: Session) -> None:
    if not multi_user_enabled(db):
        raise HTTPException(status_code=409, detail="Invites need multi-user mode")


def _users_by_id(db: Session, ids) -> dict[int, User]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    return {user.id: user for user in db.query(User).filter(User.id.in_(ids)).all()}


def _person(users: dict[int, User], user_id: int | None) -> dict | None:
    if user_id is None:
        return None
    user = users.get(user_id)
    return {"id": user_id, "username": user.username if user else None}


def serialize_invite(invite: Invite, users: dict[int, User], now: datetime | None = None) -> dict:
    return {
        "id": invite.id,
        "status": invite_status(invite, now),
        "role": invite.role,
        "note": invite.note,
        "created_at": _iso(invite.created_at),
        "expires_at": _iso(invite.expires_at),
        "created_by": _person(users, invite.created_by),
        "used_at": _iso(invite.used_at),
        "used_by": _person(users, invite.used_by),
        "revoked_at": _iso(invite.revoked_at),
        "revoked_by": _person(users, invite.revoked_by),
    }


def _link_for(request: Request, token: str) -> str:
    origin = request.headers.get("origin")
    if not origin:
        referer = request.headers.get("referer") or ""
        parts = referer.split("/", 3)
        origin = "/".join(parts[:3]) if len(parts) >= 3 and referer.startswith("http") else None
    base = (origin or str(request.base_url)).rstrip("/")
    return f"{base}/invite/{token}"


# ── Admin endpoints ──────────────────────────────────────────────────────────


@router.post("/invites")
def create_invite(
    data: CreateInviteRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    _require_multi_user(db)
    token = secrets.token_urlsafe(32)
    now = _now()
    invite = Invite(
        token_hash=_hash_token(token),
        created_by=current_user.id,
        created_at=now,
        expires_at=now + timedelta(days=data.expires_in_days),
        role=data.role,
        note=(data.note or "").strip() or None,
    )
    db.add(invite)
    db.flush()
    record_audit(
        db,
        "invite.created",
        request=request,
        actor=current_user,
        target_type="invite",
        target_id=invite.id,
        details={"role": invite.role, "expires_at": _iso(invite.expires_at), "note": invite.note},
        commit=False,
    )
    db.commit()
    db.refresh(invite)
    result = serialize_invite(invite, {current_user.id: current_user}, now)
    # The raw token is returned here and never again.
    result["token"] = token
    result["link"] = _link_for(request, token)
    return result


@router.get("/invites")
def list_invites(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    _require_multi_user(db)
    invites = db.query(Invite).order_by(Invite.id.desc()).limit(200).all()
    users = _users_by_id(
        db,
        [i for invite in invites for i in (invite.created_by, invite.used_by, invite.revoked_by)],
    )
    now = _now()
    return [serialize_invite(invite, users, now) for invite in invites]


@router.delete("/invites/{invite_id}")
def revoke_invite(
    invite_id: int,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    _require_multi_user(db)
    invite = db.query(Invite).filter(Invite.id == invite_id).first()
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite not found")
    if invite.used_at is not None:
        raise HTTPException(status_code=409, detail="This invite has already been used")
    if invite.revoked_at is None:
        invite.revoked_at = _now()
        invite.revoked_by = current_user.id
        record_audit(
            db,
            "invite.revoked",
            request=request,
            actor=current_user,
            target_type="invite",
            target_id=invite.id,
            details={"role": invite.role},
            commit=False,
        )
        db.commit()
    return {"message": "Invite revoked"}


@router.get("/audit")
def list_audit(
    limit: int = 50,
    before: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    _require_multi_user(db)
    limit = max(1, min(int(limit), 200))
    query = db.query(AuditLog)
    if before is not None:
        query = query.filter(AuditLog.id < before)
    rows = query.order_by(AuditLog.id.desc()).limit(limit + 1).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    users = {uid: u.username for uid, u in _users_by_id(db, [row.actor_user_id for row in rows]).items()}
    return {
        "entries": [serialize_audit(row, users) for row in rows],
        "next_before": rows[-1].id if has_more and rows else None,
    }


# ── Public endpoints ─────────────────────────────────────────────────────────


def _lookup(db: Session, token: str) -> tuple[Invite | None, str | None]:
    """The invite for a raw token and, when it cannot be used, the reason."""
    invite = db.query(Invite).filter(Invite.token_hash == _hash_token(token)).first()
    if invite is None:
        return None, "not_found"
    status = invite_status(invite)
    return invite, None if status == "pending" else status


def _throttled(request: Request) -> None:
    ip = client_ip(request)
    retry_after = invite_throttle.retry_after(ip, ip)
    if retry_after:
        raise HTTPException(
            status_code=429,
            detail="Too many invalid invite attempts. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )


def _reject(db: Session, request: Request, invite: Invite | None, reason: str, status_code: int):
    ip = client_ip(request)
    invite_throttle.record_failure(ip, ip)
    record_audit(
        db,
        "invite.rejected",
        request=request,
        target_type="invite",
        target_id=invite.id if invite else None,
        details={"reason": reason},
    )
    raise HTTPException(
        status_code=status_code,
        detail={"reason": reason, "message": REJECT_MESSAGES.get(reason, "This invite cannot be used.")},
    )


@router.get("/invites/{token}/check")
def check_invite(token: str, request: Request, db: Session = Depends(get_db)):
    """Whether a link is usable. Reveals nothing but validity, the reason, the role and the expiry."""
    _throttled(request)
    if not multi_user_enabled(db):
        return {"valid": False, "reason": "multi_user_off"}
    invite, reason = _lookup(db, token)
    if reason:
        # A guessed token counts against the throttle but is not logged as a rejection: a page
        # load of a stale link is not an event worth an audit row.
        ip = client_ip(request)
        invite_throttle.record_failure(ip, ip)
        return {"valid": False, "reason": reason}
    return {"valid": True, "role": invite.role, "expires_at": _iso(invite.expires_at)}


@router.post("/invites/{token}/accept", response_model=TokenResponse)
def accept_invite(token: str, data: AcceptInviteRequest, request: Request, db: Session = Depends(get_db)):
    _throttled(request)
    if not multi_user_enabled(db):
        raise HTTPException(status_code=409, detail={"reason": "multi_user_off", "message": REJECT_MESSAGES["multi_user_off"]})
    invite, reason = _lookup(db, token)
    if reason:
        _reject(db, request, invite, reason, 404 if reason == "not_found" else 410)

    username = (data.username or "").strip()
    if len(username) < MIN_USERNAME or len(username) > MAX_USERNAME:
        raise HTTPException(
            status_code=400,
            detail=f"Username must be {MIN_USERNAME}-{MAX_USERNAME} characters",
        )
    validate_new_password(data.password)
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="Username already exists")

    user = User(
        username=username,
        hashed_password=hash_password(data.password),
        role=invite.role,
        is_active=True,
        must_change_password=False,
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="Username already exists") from None

    # Claim the invite atomically so two simultaneous accepts cannot both succeed.
    now = _now()
    claimed = db.execute(
        update(Invite)
        .where(
            Invite.id == invite.id,
            Invite.used_at.is_(None),
            Invite.revoked_at.is_(None),
            Invite.expires_at > now,
        )
        .values(used_at=now, used_by=user.id)
    ).rowcount
    if claimed != 1:
        db.rollback()
        invite, reason = _lookup(db, token)
        _reject(db, request, invite, reason or "used", 410)

    record_audit(
        db,
        "invite.accepted",
        request=request,
        target_type="invite",
        target_id=invite.id,
        details={"user_id": user.id, "username": user.username, "role": user.role},
        commit=False,
    )
    record_audit(
        db,
        "user.created_via_invite",
        request=request,
        target_type="user",
        target_id=user.id,
        details={"invite_id": invite.id, "role": user.role, "invited_by": invite.created_by},
        commit=False,
    )
    db.commit()
    db.refresh(user)

    lifetime = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    session = create_session(db, user.id, lifetime, request.headers.get("user-agent"))
    access_token = create_access_token(
        {"sub": str(user.id), "role": user.role, "sid": session.id},
        expires_delta=lifetime,
    )
    return TokenResponse(
        access_token=access_token,
        user={
            "id": user.id,
            "username": user.username,
            "role": user.role,
            "avatar_id": user.avatar_id,
            "must_change_password": user.must_change_password,
        },
    )
