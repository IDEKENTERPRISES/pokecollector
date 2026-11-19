"""Wipe all user data (Settings > Administrator), mounted under /api/admin. See services/data_wipe.py."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.auth import get_current_user, multi_user_enabled
from database import get_db
from models import User
from services import data_wipe
from services.auth import verify_password

router = APIRouter()


class WipeRequest(BaseModel):
    phrase: str = ""
    password: str | None = None


def _require_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")


@router.get("/data-wipe/preview")
def preview_data_wipe(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the wipe would delete and keep, and whether it can run right now."""
    _require_admin(current_user)
    problem = data_wipe.env_admin_problem()
    credentials = data_wipe.env_admin_credentials()
    return {
        "phrase": data_wipe.CONFIRM_PHRASE,
        "requires_password": multi_user_enabled(db),
        "env_admin_ready": problem is None,
        "env_admin_problem": problem,
        "env_admin_username": credentials[0] if credentials else None,
        "busy_reason": data_wipe.busy_reason(db),
        "delete": data_wipe.count_wipe_rows(db),
        "keep": sorted(data_wipe.KEEP_TABLES),
        "files": data_wipe.file_preview(),
    }


@router.post("/data-wipe")
async def run_data_wipe(
    body: WipeRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_admin(current_user)
    if body.phrase != data_wipe.CONFIRM_PHRASE:
        raise HTTPException(status_code=400, detail=f"Type {data_wipe.CONFIRM_PHRASE} to confirm.")
    if multi_user_enabled(db) and not (
        body.password and verify_password(body.password, current_user.hashed_password)
    ):
        raise HTTPException(status_code=403, detail="Enter your password to wipe the data.")
    try:
        return await run_in_threadpool(
            data_wipe.wipe_all_user_data,
            db,
            current_user,
            request=request,
        )
    except data_wipe.WipeRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
