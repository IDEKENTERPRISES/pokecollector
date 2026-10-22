"""Offline card database endpoints (F13). Card data only: no user data, no custom cards."""

import threading

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from services import offline_carddb

router = APIRouter()

# Building a language's payloads reads every card once. Let two builds run at a time at most;
# everything else is served from memory.
_build_slots = threading.BoundedSemaphore(2)


def _require_enabled() -> None:
    if not offline_carddb.offline_carddb_enabled():
        raise HTTPException(status_code=404, detail="Offline card database is turned off")


def _require_language(db: Session, lang: str) -> None:
    if lang not in offline_carddb.languages(db):
        raise HTTPException(status_code=404, detail="Language is not synced on this server")


def _etag_matches(request: Request, etag: str) -> bool:
    header = request.headers.get("if-none-match", "")
    return etag in {part.strip().removeprefix("W/").strip('"') for part in header.split(",") if part.strip()}


def _gzip_response(request: Request, payload: dict) -> Response:
    etag = payload["hash"]
    headers = {
        "ETag": f'"{etag}"',
        "Cache-Control": "private, no-cache",
        "Vary": "Authorization",
    }
    if _etag_matches(request, etag):
        return Response(status_code=304, headers=headers)
    headers["Content-Encoding"] = "gzip"
    return Response(content=payload["gzip"], media_type="application/json", headers=headers)


@router.get("/manifest")
def get_manifest(
    lang: str | None = Query(None, min_length=2, max_length=12),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_enabled()
    if lang:
        _require_language(db, lang)
    with _build_slots:
        return offline_carddb.manifest(db, lang)


@router.get("/sets/{lang}/{set_id}")
def get_set(
    lang: str,
    set_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_enabled()
    _require_language(db, lang)
    with _build_slots:
        payload = offline_carddb.set_payload(db, lang, set_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Set not found")
    return _gzip_response(request, payload)


@router.get("/prices/{lang}")
def get_prices(
    lang: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_enabled()
    _require_language(db, lang)
    with _build_slots:
        payload = offline_carddb.prices_payload(db, lang)
    return _gzip_response(request, payload)
