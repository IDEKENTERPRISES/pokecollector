"""Swap offers between two trainers (docs/ENGAGEMENT_DESIGN.md §7, P11).

State machine (who may act):

    proposed  --accept/decline/counter--> turn user        (the recipient, first)
    countered --accept/decline/counter--> turn user        (the proposer, then the recipient again, ...)
    proposed / countered --cancel-->      the proposer only
    accepted  --cancel-->                 either trainer
    accepted  --confirm ("Swapped")-->    either trainer; the second tap completes the swap
    proposed / countered / accepted --14 days without a change--> expired (scheduler)

A counter replaces the items and cash, bumps `revision` and hands the turn to the other trainer.
Completion re-checks every copy, releases binder and deck allocations, then logs one Trade per
trainer through the trade engine (`api.trades.create_trade_for_user`), all in one transaction.

Functions here never commit: the route (or the scheduler job) does.
"""
import datetime
import logging
import math

from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from models import (
    Binder,
    BinderCard,
    Card,
    CollectionItem,
    Set,
    SwapOffer,
    SwapOfferItem,
    Trade,
    User,
    WishlistItem,
)
from services import notifications
from services.binder_allocations import collection_item_allocated_quantity
from services.card_visibility import visible_card_filter

logger = logging.getLogger(__name__)

EXPIRY_DAYS = 14
NOTE_MAX = 140
MAX_ITEMS = 40
MAX_QUANTITY = 99
MAX_CASH = 100000.0

PROPOSED = "proposed"
COUNTERED = "countered"
ACCEPTED = "accepted"
COMPLETED = "completed"
DECLINED = "declined"
CANCELLED = "cancelled"
EXPIRED = "expired"

STATES = (PROPOSED, COUNTERED, ACCEPTED, COMPLETED, DECLINED, CANCELLED, EXPIRED)
OPEN_STATES = (PROPOSED, COUNTERED)  # somebody has to answer
ACTIVE_STATES = (PROPOSED, COUNTERED, ACCEPTED)
FINAL_STATES = (COMPLETED, DECLINED, CANCELLED, EXPIRED)

# state -> the actions allowed in it (who may act is checked separately)
ALLOWED_TRANSITIONS = {
    PROPOSED: {"accept", "decline", "counter", "cancel"},
    COUNTERED: {"accept", "decline", "counter", "cancel"},
    ACCEPTED: {"cancel", "confirm"},
}


class SwapError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class SwapUnavailable(SwapError):
    """A copy on the table is gone or short; `unavailable` names them for the response."""

    def __init__(self, unavailable: list[dict]):
        names = ", ".join(sorted({u["card_name"] or u["card_id"] or "a card" for u in unavailable}))
        super().__init__(409, f"No longer available: {names}")
        self.unavailable = unavailable


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


def _expiry(now: datetime.datetime) -> datetime.datetime:
    return now + datetime.timedelta(days=EXPIRY_DAYS)


# --- lookups -------------------------------------------------------------------------------


def other_party(offer: SwapOffer, user_id: int) -> int:
    return offer.to_user_id if user_id == offer.from_user_id else offer.from_user_id


def is_party(offer: SwapOffer, user_id: int) -> bool:
    return user_id in (offer.from_user_id, offer.to_user_id)


def get_offer(db: Session, offer_id: int, user_id: int, *, lock: bool = False) -> SwapOffer:
    """The offer, for one of its two trainers. Anybody else gets 404, as if it did not exist."""
    query = db.query(SwapOffer).options(joinedload(SwapOffer.items)).filter(SwapOffer.id == offer_id)
    if lock:
        query = query.with_for_update(of=SwapOffer)
    offer = query.first()
    if offer is None or not is_party(offer, user_id):
        raise SwapError(404, "Swap offer not found")
    return offer


def expire_stale(db: Session, now: datetime.datetime | None = None, user_id: int | None = None) -> int:
    """Move offers nobody touched for 14 days to `expired`. One indexed UPDATE; the caller commits."""
    now = now or _now()
    query = db.query(SwapOffer).filter(SwapOffer.state.in_(ACTIVE_STATES), SwapOffer.expires_at <= now)
    if user_id is not None:
        query = query.filter(or_(SwapOffer.from_user_id == user_id, SwapOffer.to_user_id == user_id))
    return query.update(
        {"state": EXPIRED, "turn_user_id": None, "updated_at": now}, synchronize_session=False
    )


def waiting_count(db: Session, user_id: int, now: datetime.datetime | None = None) -> int:
    """Offers waiting for this trainer's answer: their turn and not expired."""
    now = now or _now()
    return db.query(SwapOffer.id).filter(
        SwapOffer.state.in_(OPEN_STATES),
        SwapOffer.turn_user_id == user_id,
        SwapOffer.expires_at > now,
    ).count()


# --- building items --------------------------------------------------------------------------


def _price(card, variant, price_field):
    from api.trades import _snapshot_price

    return _snapshot_price(card, variant, None, price_field)


def _clean_cash(amount, payer_user_id, parties: tuple[int, int]) -> tuple[float, int | None]:
    try:
        value = float(amount or 0)
    except (TypeError, ValueError):
        raise SwapError(422, "cash must be a number")
    if not math.isfinite(value) or value < 0 or value > MAX_CASH:
        raise SwapError(422, "cash must be a finite, non-negative amount")
    value = round(value, 2)
    if value <= 0:
        return 0.0, None
    if payer_user_id not in parties:
        raise SwapError(422, "Say which trainer pays the cash")
    return value, payer_user_id


def _clean_note(note) -> str | None:
    text = " ".join(str(note or "").split())
    if len(text) > NOTE_MAX:
        raise SwapError(422, f"The note can be at most {NOTE_MAX} characters")
    return text or None


def build_items(db: Session, actor_id: int, partner_id: int, requested) -> list[SwapOfferItem]:
    """Check what the acting trainer put on the table and snapshot it.

    Each entry names a collection copy; whoever owns it is the giver (it must be the actor or the
    partner). Cards asked from the partner follow the Compare page's trade-suggestion rules: a real
    (not custom) card visible to the partner, with a spare copy (more than one owned), and not
    promised to binders beyond what is spare. The actor's own cards just have to be theirs.
    """
    if not requested:
        raise SwapError(422, "Put at least one card on the table")
    if len(requested) > MAX_ITEMS:
        raise SwapError(422, f"At most {MAX_ITEMS} cards in one offer")
    seen: set[int] = set()
    items: list[SwapOfferItem] = []
    for entry in requested:
        item_id = int(entry.collection_item_id)
        quantity = int(entry.quantity)
        if item_id in seen:
            raise SwapError(422, "Each copy can be listed once")
        seen.add(item_id)
        if quantity < 1 or quantity > MAX_QUANTITY:
            raise SwapError(422, f"quantity must be between 1 and {MAX_QUANTITY}")
        copy = db.query(CollectionItem).options(joinedload(CollectionItem.card)).filter(
            CollectionItem.id == item_id,
            CollectionItem.user_id.in_((actor_id, partner_id)),
        ).first()
        card = copy.card if copy else None
        if copy is None or card is None or card.is_custom:
            raise SwapError(404, "Card not found")
        giver_id = copy.user_id
        if db.query(Card.id).filter(Card.id == card.id, visible_card_filter(db, giver_id, "all")).first() is None:
            raise SwapError(404, "Card not found")
        have = int(copy.quantity or 0)
        if giver_id == partner_id:
            # one copy always stays with its owner; binder and deck allocations are not spare either
            spare = have - max(collection_item_allocated_quantity(db, giver_id, copy.id), 1)
            if have <= 1 or quantity > spare:
                raise SwapError(409, f"{card.name} has no spare copy to ask for")
        elif quantity > have:
            raise SwapError(409, f"You only have {have} of {card.name}")
        field = notifications._price_field(db, giver_id)
        items.append(SwapOfferItem(
            giver_user_id=giver_id,
            collection_item_id=copy.id,
            card_id=card.id,
            variant=copy.variant,
            condition=copy.condition,
            lang=copy.lang,
            quantity=quantity,
            card_name=card.name,
            set_id=card.set_id,
            card_number=card.number,
            value_per_card=_price(card, copy.variant, field),
        ))
    return items


# --- transitions -----------------------------------------------------------------------------


def create_offer(db: Session, proposer: User, to_user_id: int, items, cash_amount, cash_payer_user_id, note,
                 now: datetime.datetime | None = None) -> SwapOffer:
    now = now or _now()
    if to_user_id == proposer.id:
        raise SwapError(422, "You cannot swap with yourself")
    partner = db.query(User).filter(User.id == to_user_id, User.is_active == True).first()  # noqa: E712
    if partner is None:
        raise SwapError(404, "Trainer not found")
    cash, payer = _clean_cash(cash_amount, cash_payer_user_id, (proposer.id, partner.id))
    built = build_items(db, proposer.id, partner.id, items)
    offer = SwapOffer(
        from_user_id=proposer.id, to_user_id=partner.id, state=PROPOSED, turn_user_id=partner.id,
        revision=1, cash_amount=cash, cash_payer_user_id=payer, note=_clean_note(note),
        expires_at=_expiry(now), created_at=now, updated_at=now,
    )
    db.add(offer)
    db.flush()
    for row in built:
        row.offer_id = offer.id
        db.add(row)
    db.flush()
    db.refresh(offer)
    _notify(db, offer, partner.id, "offer", proposer, now)
    return offer


def _require_open_turn(offer: SwapOffer, user_id: int, revision: int | None) -> None:
    if offer.state not in OPEN_STATES:
        raise SwapError(409, f"This offer is {offer.state}")
    if offer.turn_user_id != user_id:
        raise SwapError(403, "It is not your turn on this offer")
    _check_revision(offer, revision)


def _check_revision(offer: SwapOffer, revision: int | None) -> None:
    if revision is not None and int(revision) != int(offer.revision):
        raise SwapError(409, "This offer changed. Reload it first")


def _touch(offer: SwapOffer, now: datetime.datetime) -> None:
    offer.updated_at = now
    offer.expires_at = _expiry(now)


def diff_revisions(before: dict, built: list[SwapOfferItem], cash: tuple[float, int | None],
                   note: str | None) -> list[dict]:
    """What a counter changed: cards added or removed, a different quantity, the cash, the note.
    `giver_user_id` says whose card it is; the reader turns that into "what you give"."""
    old = {i.collection_item_id: i for i in before["items"]}
    new = {i.collection_item_id: i for i in built}
    changes = []

    def card(kind, item, **extra):
        return {"change": kind, "giver_user_id": item.giver_user_id, "collection_item_id": item.collection_item_id,
                "card_name": item.card_name, "set_id": item.set_id, "card_number": item.card_number, **extra}

    for key, item in new.items():
        if key not in old:
            changes.append(card("added", item, to=int(item.quantity)))
        elif int(old[key].quantity) != int(item.quantity):
            changes.append(card("quantity", item, **{"from": int(old[key].quantity), "to": int(item.quantity)}))
    for key, item in old.items():
        if key not in new:
            changes.append(card("removed", item, **{"from": int(item.quantity)}))
    if before["cash"] != cash:
        changes.append({
            "change": "cash",
            "from": {"amount": before["cash"][0], "payer_user_id": before["cash"][1]},
            "to": {"amount": cash[0], "payer_user_id": cash[1]},
        })
    if (before["note"] or None) != (note or None):
        changes.append({"change": "note", "from": before["note"], "to": note})
    return changes


def counter_offer(db: Session, offer: SwapOffer, actor: User, items, cash_amount, cash_payer_user_id, note,
                  revision: int | None = None, now: datetime.datetime | None = None) -> SwapOffer:
    now = now or _now()
    _require_open_turn(offer, actor.id, revision)
    partner_id = other_party(offer, actor.id)
    cash, payer = _clean_cash(cash_amount, cash_payer_user_id, (actor.id, partner_id))
    built = build_items(db, actor.id, partner_id, items)
    before = {"items": list(offer.items), "cash": (float(offer.cash_amount or 0), offer.cash_payer_user_id),
              "note": offer.note}
    for old in list(offer.items):
        offer.items.remove(old)
    db.flush()
    for row in built:
        row.offer_id = offer.id
        db.add(row)
    offer.cash_amount = cash
    offer.cash_payer_user_id = payer
    offer.note = _clean_note(note)
    offer.changes = diff_revisions(before, built, (cash, payer), offer.note)
    offer.revision = int(offer.revision) + 1
    offer.state = COUNTERED if offer.state == PROPOSED else PROPOSED
    offer.turn_user_id = partner_id
    offer.from_confirmed_at = None
    offer.to_confirmed_at = None
    _touch(offer, now)
    db.flush()
    db.refresh(offer)
    _notify(db, offer, partner_id, "counter", actor, now)
    return offer


def find_unavailable(db: Session, offer: SwapOffer) -> list[dict]:
    """Copies on the table that are gone, belong to somebody else now, or are short."""
    problems = []
    for item in offer.items:
        copy = db.query(CollectionItem).filter(CollectionItem.id == item.collection_item_id).first()
        available = int(copy.quantity or 0) if copy is not None and copy.user_id == item.giver_user_id else 0
        if available < int(item.quantity):
            problems.append({
                "item_id": item.id,
                "card_id": item.card_id,
                "card_name": item.card_name,
                "giver_user_id": item.giver_user_id,
                "needed": int(item.quantity),
                "available": available,
            })
    return problems


def accept_offer(db: Session, offer: SwapOffer, actor: User, revision: int | None = None,
                 now: datetime.datetime | None = None) -> SwapOffer:
    now = now or _now()
    _require_open_turn(offer, actor.id, revision)
    problems = find_unavailable(db, offer)
    if problems:
        raise SwapUnavailable(problems)
    offer.state = ACCEPTED
    offer.turn_user_id = None
    _touch(offer, now)
    db.flush()
    _notify(db, offer, other_party(offer, actor.id), "accepted", actor, now)
    return offer


def decline_offer(db: Session, offer: SwapOffer, actor: User, revision: int | None = None,
                  now: datetime.datetime | None = None) -> SwapOffer:
    now = now or _now()
    _require_open_turn(offer, actor.id, revision)
    offer.state = DECLINED
    offer.turn_user_id = None
    offer.updated_at = now
    db.flush()
    _notify(db, offer, other_party(offer, actor.id), "declined", actor, now)
    return offer


def cancel_offer(db: Session, offer: SwapOffer, actor: User, now: datetime.datetime | None = None) -> SwapOffer:
    now = now or _now()
    if offer.state not in ALLOWED_TRANSITIONS or "cancel" not in ALLOWED_TRANSITIONS[offer.state]:
        raise SwapError(409, f"This offer is {offer.state}")
    if offer.state == ACCEPTED:
        if not is_party(offer, actor.id):
            raise SwapError(404, "Swap offer not found")
    elif actor.id != offer.from_user_id:
        raise SwapError(403, "Only the trainer who made the offer can cancel it")
    offer.state = CANCELLED
    offer.turn_user_id = None
    offer.updated_at = now
    db.flush()
    return offer


def confirm_swapped(db: Session, offer: SwapOffer, actor: User, now: datetime.datetime | None = None) -> SwapOffer:
    """A trainer taps "Swapped". The second tap completes the swap or raises `SwapUnavailable`."""
    now = now or _now()
    if offer.state != ACCEPTED:
        raise SwapError(409, f"This offer is {offer.state}")
    mine = "from_confirmed_at" if actor.id == offer.from_user_id else "to_confirmed_at"
    theirs = "to_confirmed_at" if actor.id == offer.from_user_id else "from_confirmed_at"
    if getattr(offer, mine) is not None:
        raise SwapError(409, "You already tapped Swapped")
    setattr(offer, mine, now)
    _touch(offer, now)
    partner_id = other_party(offer, actor.id)
    if getattr(offer, theirs) is None:
        db.flush()
        _notify(db, offer, partner_id, "swapped", actor, now)
        return offer
    complete_offer(db, offer, now)
    return offer


# --- completion --------------------------------------------------------------------------------


def release_allocations(db: Session, user_id: int, copy: CollectionItem, keep_quantity: int) -> int:
    """Free binder and Real Deck slots so at most `keep_quantity` copies stay allocated. Returns the freed count."""
    from services.binder_slots import reconcile_slots

    rows = db.query(BinderCard).join(Binder, Binder.id == BinderCard.binder_id).filter(
        Binder.user_id == user_id,
        or_(Binder.binder_type.in_(("collection", "physical_deck")), Binder.binder_type.is_(None)),
        BinderCard.collection_item_id == copy.id,
    ).order_by(BinderCard.id.desc()).all()
    allocated = sum(int(row.required_quantity or 1) for row in rows)
    excess = allocated - max(int(keep_quantity), 0)
    freed = 0
    touched: set[int] = set()
    for row in rows:
        if excess <= 0:
            break
        quantity = int(row.required_quantity or 1)
        touched.add(row.binder_id)
        if quantity <= excess:
            excess -= quantity
            freed += quantity
            db.delete(row)  # its pockets go with it (cascade)
        else:
            row.required_quantity = quantity - excess
            freed += excess
            excess = 0
    db.flush()
    for binder_id in touched:
        binder = db.get(Binder, binder_id)
        if binder is not None:
            reconcile_slots(db, binder, create=False)
    db.flush()
    return freed


def complete_offer(db: Session, offer: SwapOffer, now: datetime.datetime | None = None) -> SwapOffer:
    """Move the cards and log a Trade for each trainer. All or nothing: on `SwapUnavailable`
    nothing has been changed (the caller rolls back)."""
    from api.trades import ALLOWED_CONDITIONS, create_trade_for_user
    from schemas import TradeCreate, TradeIncomingItemCreate, TradeOutgoingItemCreate
    from services.printing_detail_tags import printing_detail_names

    now = now or _now()
    ids = sorted({offer.from_user_id, offer.to_user_id})
    users = {
        user.id: user
        for user in db.query(User).filter(User.id.in_(ids)).order_by(User.id).with_for_update().all()
    }
    problems = find_unavailable(db, offer)
    if problems:
        raise SwapUnavailable(problems)

    copies = {
        item.id: db.query(CollectionItem).options(joinedload(CollectionItem.card)).filter(
            CollectionItem.id == item.collection_item_id
        ).one()
        for item in offer.items
    }
    # Read everything the incoming side needs before any copy is moved or deleted.
    plans: dict[int, TradeCreate] = {}
    for user_id in ids:
        partner_id = other_party(offer, user_id)
        field = notifications._price_field(db, user_id)
        outgoing, incoming = [], []
        for item in offer.items:
            copy = copies[item.id]
            if item.giver_user_id == user_id:
                outgoing.append(TradeOutgoingItemCreate(collection_item_id=copy.id, quantity=item.quantity))
                continue
            condition = copy.condition if copy.condition in ALLOWED_CONDITIONS else "NM"
            incoming.append(TradeIncomingItemCreate(
                card_id=copy.card_id,
                quantity=item.quantity,
                condition=condition,
                variant=copy.variant or "Normal",
                printing_details=printing_detail_names(copy.printing_detail_tags),
                lang=copy.lang or "en",
                purchase_price=_price(copy.card, copy.variant, field),
            ))
        cash = float(offer.cash_amount or 0)
        plans[user_id] = TradeCreate(
            partner_name=users[partner_id].username,
            trade_date=now.date(),
            notes=f"Swap offer #{offer.id}",
            outgoing_cash=cash if offer.cash_payer_user_id == user_id else 0,
            incoming_cash=cash if cash > 0 and offer.cash_payer_user_id == partner_id else 0,
            outgoing=outgoing,
            incoming=incoming,
        )

    for user_id in ids:
        plan = plans[user_id]
        for entry in plan.outgoing:
            copy = copies[next(i.id for i in offer.items if i.collection_item_id == entry.collection_item_id)]
            release_allocations(db, user_id, copy, int(copy.quantity or 0) - entry.quantity)
        create_trade_for_user(
            db, users[user_id], plan, notifications._price_field(db, user_id),
            commit=False, swap_offer_id=offer.id,
        )

    offer.state = COMPLETED
    offer.turn_user_id = None
    offer.completed_at = now
    offer.updated_at = now
    db.flush()
    for user_id in ids:
        _notify(db, offer, user_id, "completed", users[other_party(offer, user_id)], now)
    return offer


# --- notifications -------------------------------------------------------------------------------


def _set_codes(db: Session, cards) -> dict[tuple, str]:
    """(set_id, lang) -> the code printed on the card ("OBF"), from the cards' own sets."""
    pairs = {(c.set_id, c.lang) for c in cards if c is not None and c.set_id}
    codes: dict[tuple, str] = {}
    if not pairs:
        return codes
    rows = db.query(Set.tcg_set_id, Set.lang, Set.abbreviation).filter(
        Set.tcg_set_id.in_({p[0] for p in pairs})
    ).all()
    for tcg_id, lang, abbreviation in rows:
        if abbreviation:
            codes[(tcg_id, lang)] = abbreviation
    return codes


def set_code(codes: dict, set_id, lang) -> str:
    return codes.get((set_id, lang)) or str(set_id or "").upper()


def _card_labels(db: Session, offer: SwapOffer) -> dict[int, str]:
    """item id -> "Charizard ex (OBF 125)" for the push texts."""
    ids = {i.card_id for i in offer.items if i.card_id}
    cards = {c.id: c for c in db.query(Card).filter(Card.id.in_(ids)).all()} if ids else {}
    codes = _set_codes(db, cards.values())
    labels = {}
    for item in offer.items:
        card = cards.get(item.card_id)
        code = set_code(codes, item.set_id, card.lang if card else None)
        tag = " ".join(part for part in (code, item.card_number) if part)
        labels[item.id] = f"{item.card_name or 'Card'} ({tag})" if tag else (item.card_name or "Card")
    return labels


def _notify(db: Session, offer: SwapOffer, recipient_id: int, kind: str, actor: User,
            now: datetime.datetime) -> None:
    """One push per offer, revision and kind. `kind`: offer, counter, accepted, swapped, completed, declined.
    The details name the cards, never amounts; cash is only a flag."""
    try:
        labels = _card_labels(db, offer)
        details = {
            "offer_id": offer.id,
            "revision": int(offer.revision),
            "kind": kind,
            "partner": actor.username,
            "gives": sum(int(i.quantity) for i in offer.items if i.giver_user_id == recipient_id),
            "gets": sum(int(i.quantity) for i in offer.items if i.giver_user_id != recipient_id),
            "give_cards": [labels[i.id] for i in offer.items if i.giver_user_id == recipient_id],
            "get_cards": [labels[i.id] for i in offer.items if i.giver_user_id != recipient_id],
            "cash": float(offer.cash_amount or 0) > 0,
        }
        with db.begin_nested():
            notifications.enqueue(
                db, recipient_id, "swap_offers", f"swap:{offer.id}:r{int(offer.revision)}:{kind}",
                now=now, details=details,
            )
    except Exception:
        logger.exception("Could not queue the swap-offer notification for offer %s", offer.id)


# --- reading -----------------------------------------------------------------------------------


def actions_for(offer: SwapOffer, user_id: int) -> list[str]:
    if offer.state in OPEN_STATES:
        actions = ["accept", "decline", "counter"] if offer.turn_user_id == user_id else []
        if user_id == offer.from_user_id:
            actions.append("cancel")
        return actions
    if offer.state == ACCEPTED:
        mine = offer.from_confirmed_at if user_id == offer.from_user_id else offer.to_confirmed_at
        return ["cancel"] if mine is not None else ["confirm", "cancel"]
    return []


def _side_values(db: Session, offer: SwapOffer, user_id: int, cards: dict) -> dict:
    """What the offer is worth to this trainer, at their own price field and today's prices
    (the same valuation as `POST /api/trades/value`)."""
    field = notifications._price_field(db, user_id)
    gives = gets = 0.0
    missing = 0
    for item in offer.items:
        value = _price(cards.get(item.card_id), item.variant, field) * int(item.quantity)
        if value <= 0:
            missing += 1
        if item.giver_user_id == user_id:
            gives += value
        else:
            gets += value
    cash = float(offer.cash_amount or 0)
    if cash > 0:
        if offer.cash_payer_user_id == user_id:
            gives += cash
        else:
            gets += cash
    return {
        "price_field": field,
        "gives": round(gives, 2),
        "gets": round(gets, 2),
        "delta": round(gets - gives, 2),
        "missing_prices": missing,
    }


def _changes_view(offer: SwapOffer, viewer_id: int) -> list[dict]:
    """The last counter's changes with `gives` from the viewer's side. Empty on a first revision."""
    if int(offer.revision) <= 1 or not offer.changes:
        return []
    return [
        {**change, "gives": change.get("giver_user_id") == viewer_id} if "giver_user_id" in change else change
        for change in offer.changes
    ]


def serialize_offers(db: Session, offers: list[SwapOffer], viewer_id: int) -> list[dict]:
    if not offers:
        return []
    card_ids = {item.card_id for offer in offers for item in offer.items if item.card_id}
    cards = {c.id: c for c in db.query(Card).filter(Card.id.in_(card_ids)).all()} if card_ids else {}
    user_ids = {uid for offer in offers for uid in (offer.from_user_id, offer.to_user_id)}
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()}
    codes = _set_codes(db, cards.values())
    trade_ids = {
        trade.swap_offer_id: trade.id
        for trade in db.query(Trade.id, Trade.swap_offer_id).filter(
            Trade.swap_offer_id.in_([o.id for o in offers if o.state == COMPLETED]),
            Trade.user_id == viewer_id,
        ).all()
    }

    def user_view(uid):
        user = users.get(uid)
        return {"id": uid, "username": user.username if user else None, "avatar_id": user.avatar_id if user else None}

    result = []
    for offer in offers:
        partner_id = other_party(offer, viewer_id)
        mine_confirmed = offer.from_confirmed_at if viewer_id == offer.from_user_id else offer.to_confirmed_at
        theirs_confirmed = offer.to_confirmed_at if viewer_id == offer.from_user_id else offer.from_confirmed_at
        result.append({
            "id": offer.id,
            "state": offer.state,
            "revision": int(offer.revision),
            "role": "proposer" if viewer_id == offer.from_user_id else "recipient",
            "from_user": user_view(offer.from_user_id),
            "to_user": user_view(offer.to_user_id),
            "partner": user_view(partner_id),
            "turn_user_id": offer.turn_user_id,
            "your_turn": offer.state in OPEN_STATES and offer.turn_user_id == viewer_id,
            "actions": actions_for(offer, viewer_id),
            "note": offer.note,
            "changes": _changes_view(offer, viewer_id),
            "unavailable": find_unavailable(db, offer) if offer.state == ACCEPTED else [],
            "cash": {"amount": float(offer.cash_amount or 0), "payer_user_id": offer.cash_payer_user_id},
            "items": [
                {
                    "id": item.id,
                    "giver_user_id": item.giver_user_id,
                    "gives": item.giver_user_id == viewer_id,
                    "collection_item_id": item.collection_item_id,
                    "card_id": item.card_id,
                    "card_name": item.card_name,
                    "set_id": item.set_id,
                    "set_code": set_code(codes, item.set_id, cards[item.card_id].lang if item.card_id in cards else None),
                    "card_number": item.card_number,
                    "types": (cards[item.card_id].types if item.card_id in cards else None) or [],
                    "variant": item.variant,
                    "condition": item.condition,
                    "lang": item.lang,
                    "quantity": int(item.quantity),
                    "value_per_card": float(item.value_per_card or 0),
                    "images_small": cards[item.card_id].images_small if item.card_id in cards else None,
                }
                for item in offer.items
            ],
            "values": {
                "you": _side_values(db, offer, viewer_id, cards),
                "partner": _side_values(db, offer, partner_id, cards),
            },
            "you_confirmed": mine_confirmed is not None,
            "partner_confirmed": theirs_confirmed is not None,
            "expires_at": offer.expires_at.isoformat() if offer.expires_at else None,
            "completed_at": offer.completed_at.isoformat() if offer.completed_at else None,
            "created_at": offer.created_at.isoformat() if offer.created_at else None,
            "updated_at": offer.updated_at.isoformat() if offer.updated_at else None,
            "trade_id": trade_ids.get(offer.id),
        })
    return result


def list_offers(db: Session, viewer_id: int, history_limit: int = 50) -> dict:
    base = db.query(SwapOffer).options(joinedload(SwapOffer.items)).filter(
        or_(SwapOffer.from_user_id == viewer_id, SwapOffer.to_user_id == viewer_id)
    )
    active = base.filter(SwapOffer.state.in_(ACTIVE_STATES)).order_by(SwapOffer.updated_at.desc(), SwapOffer.id.desc()).all()
    history = base.filter(SwapOffer.state.in_(FINAL_STATES)).order_by(
        SwapOffer.updated_at.desc(), SwapOffer.id.desc()
    ).limit(history_limit).all()
    views = serialize_offers(db, active + history, viewer_id)
    by_id = {v["id"]: v for v in views}
    return {
        "incoming": [by_id[o.id] for o in active if o.to_user_id == viewer_id],
        "outgoing": [by_id[o.id] for o in active if o.from_user_id == viewer_id],
        "history": [by_id[o.id] for o in history],
        "waiting_count": waiting_count(db, viewer_id),
    }


# --- candidates --------------------------------------------------------------------------------


def _wishlist_ids(db: Session, owner_id: int) -> set[str]:
    return {
        row.card_id
        for row in db.query(WishlistItem.card_id).join(Card, Card.id == WishlistItem.card_id).filter(
            WishlistItem.user_id == owner_id, Card.is_custom == False,  # noqa: E712
            visible_card_filter(db, owner_id, "all"),
        ).all()
    }


def candidates(db: Session, viewer: User, partner: User, side: str, flt: str = "all", q: str | None = None,
               limit: int = 300) -> dict:
    """Copies that can go on the table, in the shape the picker and Compare need.

    `side="give"` lists the viewer's own copies (any quantity); `"get"` the partner's spare copies (the rule
    `build_items` enforces). `on_wishlist` marks cards the other trainer is looking for: the partner's wishlist
    for `give` (only when Compare may show it) and the viewer's own for `get`. `counts` ignore the filter."""
    from services.public_profile_feature import public_profiles_enabled

    giving = side == "give"
    owner = viewer if giving else partner
    rows = db.query(CollectionItem).options(joinedload(CollectionItem.card)).join(
        Card, Card.id == CollectionItem.card_id
    ).filter(
        CollectionItem.user_id == owner.id, Card.is_custom == False,  # noqa: E712
        CollectionItem.quantity > 0, visible_card_filter(db, owner.id, "all"),
    )
    text = " ".join(str(q or "").split())
    if text:
        rows = rows.filter(Card.name.ilike(f"%{text}%"))
    copies = rows.order_by(Card.name.asc(), CollectionItem.id.asc()).all()

    wishlist_visible = (not giving) or bool(
        public_profiles_enabled(db) and partner.is_profile_public
        and (partner.wishlist_visibility or "private") in {"trade_matches", "public"}
    )
    wanted = _wishlist_ids(db, partner.id if giving else viewer.id) if wishlist_visible else set()
    field = notifications._price_field(db, viewer.id)
    codes = _set_codes(db, [c.card for c in copies])
    entries = []
    for copy in copies:
        have = int(copy.quantity or 0)
        if giving:
            offerable = have
            spare = have > 1
        else:
            offerable = max(have - max(collection_item_allocated_quantity(db, owner.id, copy.id), 1), 0)
            if have <= 1 or offerable < 1:
                continue
            spare = True
        card = copy.card
        entries.append({
            "collection_item_id": copy.id,
            "card_id": card.id,
            "card_name": card.name,
            "set_id": card.set_id,
            "set_code": set_code(codes, card.set_id, card.lang),
            "card_number": card.number,
            "variant": copy.variant,
            "condition": copy.condition,
            "lang": copy.lang,
            "images_small": card.images_small,
            "types": card.types or [],
            "quantity": have,
            "offerable": offerable,
            "on_wishlist": card.id in wanted,
            "spare": spare,
            "value": _price(card, copy.variant, field),
        })
    counts = {
        "all": len(entries),
        "spares": sum(1 for e in entries if e["spare"]),
        "wishlist": sum(1 for e in entries if e["on_wishlist"]),
    }
    if flt == "wishlist":
        entries = [e for e in entries if e["on_wishlist"]]
    elif flt == "spares":
        entries = [e for e in entries if e["spare"]]
    return {"items": entries[:limit], "counts": counts, "wishlist_visible": wishlist_visible}
