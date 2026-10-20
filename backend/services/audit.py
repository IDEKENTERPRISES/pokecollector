"""Audit log: who did what, from where.

``record_audit`` is the one place that writes ``AuditLog`` rows, so logging another admin action
later is a single call. The client address comes from ``services.client_ip`` (the TCP peer is
always a proxy), and details are stored as JSON text.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from models import AuditLog
from services.client_ip import client_ip

logger = logging.getLogger(__name__)


def record_audit(
    db: Session,
    action: str,
    *,
    request=None,
    actor=None,
    target_type: str | None = None,
    target_id: Any = None,
    details: dict | None = None,
    commit: bool = True,
) -> AuditLog:
    """Append one entry. `actor` is a User (or None for anonymous actions such as an invite
    being refused). With `commit=False` the row joins the caller's transaction."""
    payload = dict(details or {})
    if actor is not None:
        payload.setdefault("actor", getattr(actor, "username", None))
    entry = AuditLog(
        created_at=datetime.utcnow(),
        actor_user_id=getattr(actor, "id", None),
        action=action,
        target_type=target_type,
        target_id=None if target_id is None else str(target_id),
        ip=client_ip(request) if request is not None else None,
        user_agent=((request.headers.get("user-agent") or "")[:255] or None) if request is not None else None,
        details=json.dumps(payload, default=str) if payload else None,
    )
    db.add(entry)
    if commit:
        db.commit()
    else:
        db.flush()
    return entry


def serialize_audit(entry: AuditLog, usernames: dict[int, str] | None = None) -> dict:
    try:
        details = json.loads(entry.details) if entry.details else {}
    except ValueError:
        details = {}
    actor_name = (usernames or {}).get(entry.actor_user_id) or details.get("actor")
    return {
        "id": entry.id,
        "created_at": entry.created_at.isoformat() + "Z" if entry.created_at else None,
        "actor_user_id": entry.actor_user_id,
        "actor_username": actor_name,
        "action": entry.action,
        "target_type": entry.target_type,
        "target_id": entry.target_id,
        "ip": entry.ip,
        "user_agent": entry.user_agent,
        "details": details,
    }
