"""Swap offers (/api/swaps). Every route answers 404 while the admin's social switch is off."""
from typing import List, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from services import swaps
from services.social_feature import require_social

router = APIRouter(dependencies=[Depends(require_social)])


class SwapItemIn(BaseModel):
    collection_item_id: int
    quantity: int = Field(default=1, ge=1, le=swaps.MAX_QUANTITY)


class SwapCreate(BaseModel):
    to_user_id: int
    items: List[SwapItemIn] = Field(min_length=1, max_length=swaps.MAX_ITEMS)
    cash_amount: float = Field(default=0, ge=0, le=swaps.MAX_CASH)
    cash_payer_user_id: Optional[int] = None
    note: Optional[str] = Field(default=None, max_length=swaps.NOTE_MAX)


class SwapCounter(BaseModel):
    items: List[SwapItemIn] = Field(min_length=1, max_length=swaps.MAX_ITEMS)
    cash_amount: float = Field(default=0, ge=0, le=swaps.MAX_CASH)
    cash_payer_user_id: Optional[int] = None
    note: Optional[str] = Field(default=None, max_length=swaps.NOTE_MAX)
    revision: Optional[int] = None


class SwapAnswer(BaseModel):
    # The revision the trainer was looking at; a mismatch answers 409 so nobody accepts a stale offer.
    revision: Optional[int] = None


def _error(exc: swaps.SwapError) -> JSONResponse:
    content = {"detail": exc.detail}
    if isinstance(exc, swaps.SwapUnavailable):
        content["unavailable"] = exc.unavailable
    return JSONResponse(status_code=exc.status_code, content=content)


def _one(db: Session, offer_id: int, user: User) -> dict:
    offer = swaps.get_offer(db, offer_id, user.id)
    return swaps.serialize_offers(db, [offer], user.id)[0]


def _run(db: Session, user: User, offer_id: int, action) -> JSONResponse | dict:
    """Load and lock the offer, apply `action(offer)`, commit; any SwapError rolls everything back."""
    try:
        swaps.expire_stale(db, user_id=user.id)
        offer = swaps.get_offer(db, offer_id, user.id, lock=True)
        if offer.state == swaps.EXPIRED:
            db.commit()
            raise swaps.SwapError(409, "This offer expired")
        action(offer)
        db.commit()
    except swaps.SwapError as exc:
        db.rollback()  # the expiry, if any, was already committed above
        return _error(exc)
    except Exception:
        db.rollback()
        raise
    return _one(db, offer_id, user)


@router.get("")
@router.get("/")
def list_swaps(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """`incoming` (offers sent to me), `outgoing` (offers I made), `history` (finished), `waiting_count`."""
    if swaps.expire_stale(db, user_id=current_user.id):
        db.commit()
    return swaps.list_offers(db, current_user.id)


@router.get("/waiting")
def waiting_swaps(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The number that goes on the app icon: offers whose turn it is, not expired."""
    return {"count": swaps.waiting_count(db, current_user.id)}


@router.post("")
@router.post("/")
def create_swap(body: SwapCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        offer = swaps.create_offer(
            db, current_user, body.to_user_id, body.items, body.cash_amount, body.cash_payer_user_id, body.note,
        )
        db.commit()
    except swaps.SwapError as exc:
        db.rollback()
        return _error(exc)
    except Exception:
        db.rollback()
        raise
    return _one(db, offer.id, current_user)


@router.get("/{offer_id}")
def get_swap(offer_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        if swaps.expire_stale(db, user_id=current_user.id):
            db.commit()
        return _one(db, offer_id, current_user)
    except swaps.SwapError as exc:
        return _error(exc)


@router.post("/{offer_id}/counter")
def counter_swap(offer_id: int, body: SwapCounter, current_user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    return _run(db, current_user, offer_id, lambda offer: swaps.counter_offer(
        db, offer, current_user, body.items, body.cash_amount, body.cash_payer_user_id, body.note, body.revision,
    ))


@router.post("/{offer_id}/accept")
def accept_swap(offer_id: int, body: SwapAnswer = SwapAnswer(), current_user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    return _run(db, current_user, offer_id, lambda offer: swaps.accept_offer(db, offer, current_user, body.revision))


@router.post("/{offer_id}/decline")
def decline_swap(offer_id: int, body: SwapAnswer = SwapAnswer(), current_user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    return _run(db, current_user, offer_id, lambda offer: swaps.decline_offer(db, offer, current_user, body.revision))


@router.post("/{offer_id}/cancel")
def cancel_swap(offer_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _run(db, current_user, offer_id, lambda offer: swaps.cancel_offer(db, offer, current_user))


@router.post("/{offer_id}/confirm-swapped")
def confirm_swapped(offer_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Tap "Swapped". The second trainer's tap completes the swap; if a card is gone the answer is 409 with
    `unavailable` naming it, nothing changes and the offer stays accepted."""
    return _run(db, current_user, offer_id, lambda offer: swaps.confirm_swapped(db, offer, current_user))
