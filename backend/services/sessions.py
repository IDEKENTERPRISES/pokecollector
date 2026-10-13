"""Server-side sessions behind the signed login tokens.

A JWT alone cannot be taken back once issued. Each login therefore also creates a
``UserSession`` row, the token carries the row's id as ``sid``, and the token is only
accepted while that row exists and has not expired. Ending a session deletes the row.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from models import UserSession

# Recording "last used" on every request would turn each read into a write.
LAST_USED_RESOLUTION = timedelta(minutes=5)


def _utcnow() -> datetime:
    return datetime.utcnow()


def create_session(db: Session, user_id: int, lifetime: timedelta, user_agent: str | None = None) -> UserSession:
    now = _utcnow()
    purge_expired(db, now)
    session = UserSession(
        id=secrets.token_hex(24),
        user_id=user_id,
        created_at=now,
        last_used_at=now,
        expires_at=now + lifetime,
        user_agent=(user_agent or "")[:255] or None,
    )
    db.add(session)
    db.commit()
    return session


def get_active_session(db: Session, session_id: str | None, user_id: int) -> UserSession | None:
    if not session_id:
        return None
    session = db.query(UserSession).filter(
        UserSession.id == str(session_id),
        UserSession.user_id == user_id,
    ).first()
    if session is None or session.expires_at <= _utcnow():
        return None
    return session


def touch(db: Session, session: UserSession) -> None:
    now = _utcnow()
    if session.last_used_at is None or now - session.last_used_at >= LAST_USED_RESOLUTION:
        session.last_used_at = now
        db.commit()


def revoke_session(db: Session, user_id: int, session_id: str) -> bool:
    deleted = db.query(UserSession).filter(
        UserSession.id == session_id,
        UserSession.user_id == user_id,
    ).delete(synchronize_session=False)
    db.commit()
    return bool(deleted)


def revoke_sessions(db: Session, user_id: int, *, keep: str | None = None, commit: bool = True) -> int:
    """End every session of a user, optionally keeping one (the caller's own)."""
    query = db.query(UserSession).filter(UserSession.user_id == user_id)
    if keep:
        query = query.filter(UserSession.id != keep)
    deleted = query.delete(synchronize_session=False)
    if commit:
        db.commit()
    return int(deleted or 0)


def purge_expired(db: Session, now: datetime | None = None) -> None:
    db.query(UserSession).filter(UserSession.expires_at <= (now or _utcnow())).delete(
        synchronize_session=False
    )
