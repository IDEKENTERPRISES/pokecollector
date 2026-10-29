"""Binder pockets: one pocket per copy, kept in step with ``binder_cards``.

``binder_cards`` stays the source of truth for which copies exist; ``binder_slots`` only says where
each one sits. A collection binder row with ``required_quantity`` N owns N pockets; a planned binder
row owns N pockets too (shown as ghosts for copies not owned yet).
"""
import hashlib
import logging

from sqlalchemy import event
from sqlalchemy.orm import Session

from models import BinderCard, BinderSlot

logger = logging.getLogger(__name__)

POCKET_LAYOUTS = (4, 9, 12)
SLOT_BINDER_TYPES = {"collection", "wishlist"}
MAX_SLOT_INDEX = 24000


def delete_slots_for_entries(db: Session, entries_query) -> int:
    """Delete the pockets of every binder_cards row in ``entries_query``.

    Call this before a bulk ``entries_query.delete()``: bulk deletes skip ORM
    cascades, and SQLite (tests) does not enforce ON DELETE CASCADE.
    """
    ids = entries_query.with_entities(BinderCard.id).subquery()
    return db.query(BinderSlot).filter(
        BinderSlot.binder_card_id.in_(db.query(ids.c.id))
    ).delete(synchronize_session=False)


class SlotError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def binder_has_pockets(binder) -> bool:
    return (binder.binder_type or "collection") in SLOT_BINDER_TYPES


def _copy_count(row) -> int:
    return max(1, int(row.required_quantity or 1))


def _default_order_key(row):
    # "recent" first, like the binder grid's default sort.
    added = row.added_at.timestamp() if row.added_at else 0.0
    return (-added, -row.id)


def slot_version(pocket_layout: int, slots) -> str:
    """A stable fingerprint of the layout; any move, gap change or resize changes it."""
    triples = sorted((s.slot_index, s.binder_card_id, s.copy_index) for s in slots)
    raw = f"{int(pocket_layout or 9)}|" + ";".join(f"{a}:{b}:{c}" for a, b, c in triples)
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def reconcile_slots(db: Session, binder, preferred: dict | None = None, create: bool = True) -> bool:
    """Make the pockets match the binder's copies. Returns True when anything changed.

    Copies that no longer exist (row gone, quantity lowered) free their pocket and leave a gap.
    Copies without a pocket take the first free one; with no pockets at all this is the lazy first
    assignment in the binder's default order. ``preferred`` maps (binder_card_id, copy_index) to a
    wanted slot_index that is used when still free. ``create=False`` only maintains a binder that
    already has pockets.
    """
    if not binder_has_pockets(binder):
        return False
    rows = db.query(BinderCard).filter(BinderCard.binder_id == binder.id).all()
    quantity = {row.id: _copy_count(row) for row in rows}
    slots = db.query(BinderSlot).filter(BinderSlot.binder_id == binder.id).all()
    if not slots and not create:
        return False

    changed = False
    kept = []
    for slot in slots:
        if quantity.get(slot.binder_card_id, 0) > slot.copy_index:
            kept.append(slot)
        else:
            db.delete(slot)
            changed = True
    if changed:
        db.flush()

    placed = {(s.binder_card_id, s.copy_index) for s in kept}
    taken = {s.slot_index for s in kept}
    missing = []
    for row in sorted(rows, key=_default_order_key):
        for copy_index in range(quantity[row.id]):
            if (row.id, copy_index) not in placed:
                missing.append((row.id, copy_index))
    if not missing:
        return changed

    preferred = preferred or {}
    leftover = []
    new_slots = []
    for key in missing:
        wanted = preferred.get(key)
        if wanted is not None and 0 <= wanted <= MAX_SLOT_INDEX and wanted not in taken:
            taken.add(wanted)
            new_slots.append(BinderSlot(binder_id=binder.id, slot_index=wanted, binder_card_id=key[0], copy_index=key[1]))
        else:
            leftover.append(key)
    cursor = 0
    for key in leftover:
        while cursor in taken:
            cursor += 1
        taken.add(cursor)
        new_slots.append(BinderSlot(binder_id=binder.id, slot_index=cursor, binder_card_id=key[0], copy_index=key[1]))
    db.add_all(new_slots)
    db.flush()
    return True


def layout_payload(db: Session, binder) -> dict:
    slots = db.query(BinderSlot).filter(BinderSlot.binder_id == binder.id).order_by(BinderSlot.slot_index).all()
    layout = int(binder.pocket_layout or 9)
    return {
        "pocket_layout": layout,
        "version": slot_version(layout, slots),
        "slots": [
            {"slot_index": s.slot_index, "binder_card_id": s.binder_card_id, "copy_index": s.copy_index}
            for s in slots
        ],
    }


def get_layout(db: Session, binder) -> dict:
    """The binder's pockets, assigning or repairing them first."""
    if not binder_has_pockets(binder):
        raise SlotError(409, "Only binders and planned binders have pockets")
    reconcile_slots(db, binder)
    return layout_payload(db, binder)


def replace_layout(db: Session, binder, version: str, slots: list[dict]) -> dict:
    """Whole-layout replace. Every copy must be placed exactly once, no two in one pocket."""
    if not binder_has_pockets(binder):
        raise SlotError(409, "Only binders and planned binders have pockets")
    reconcile_slots(db, binder)
    current = layout_payload(db, binder)
    if str(version) != current["version"]:
        raise SlotError(409, "The binder layout changed; reload and try again")

    valid = {
        (row.id, copy_index)
        for row in db.query(BinderCard).filter(BinderCard.binder_id == binder.id).all()
        for copy_index in range(_copy_count(row))
    }
    seen_copies = set()
    seen_pockets = set()
    for item in slots:
        index, card_id, copy_index = item["slot_index"], item["binder_card_id"], item["copy_index"]
        if index < 0 or copy_index < 0:
            raise SlotError(422, "Pocket and copy numbers cannot be negative")
        if index > MAX_SLOT_INDEX:
            raise SlotError(422, "Pocket number is too large")
        key = (card_id, copy_index)
        if key not in valid:
            raise SlotError(422, "A card in the layout does not belong to this binder")
        if key in seen_copies:
            raise SlotError(422, "A copy is placed more than once")
        if index in seen_pockets:
            raise SlotError(422, "Two copies share one pocket")
        seen_copies.add(key)
        seen_pockets.add(index)
    if seen_copies != valid:
        raise SlotError(422, "Every copy must be placed exactly once")

    _write_slots(db, binder, [(s["slot_index"], s["binder_card_id"], s["copy_index"]) for s in slots])
    return layout_payload(db, binder)


def _write_slots(db: Session, binder, triples) -> None:
    for old in db.query(BinderSlot).filter(BinderSlot.binder_id == binder.id).all():
        db.expunge(old)
    db.query(BinderSlot).filter(BinderSlot.binder_id == binder.id).delete(synchronize_session=False)
    db.expire(binder, ["slots"])
    db.add_all(
        BinderSlot(binder_id=binder.id, slot_index=index, binder_card_id=card_id, copy_index=copy_index)
        for index, card_id, copy_index in triples
    )
    db.flush()


def compact_layout(db: Session, binder) -> dict:
    """Close the gaps: keep the order, renumber the pockets 0..n-1."""
    if not binder_has_pockets(binder):
        raise SlotError(409, "Only binders and planned binders have pockets")
    reconcile_slots(db, binder)
    slots = db.query(BinderSlot).filter(BinderSlot.binder_id == binder.id).order_by(BinderSlot.slot_index).all()
    triples = [(position, s.binder_card_id, s.copy_index) for position, s in enumerate(slots)]
    _write_slots(db, binder, triples)
    return layout_payload(db, binder)


def slot_positions(db: Session, binder_id: int) -> dict:
    """{(binder_card_id, copy_index): slot_index} for exports."""
    return {
        (s.binder_card_id, s.copy_index): s.slot_index
        for s in db.query(BinderSlot).filter(BinderSlot.binder_id == binder_id).all()
    }


# --- keep pockets in step with every ORM change to binder_cards ------------
_DIRTY = "binder_slots_dirty"
_registered = False


def _collect(session, flush_context, instances) -> None:
    for obj in list(session.new) + list(session.dirty) + list(session.deleted):
        if isinstance(obj, BinderCard) and obj.binder_id is not None:
            session.info.setdefault(_DIRTY, set()).add(obj.binder_id)


def _sync_before_commit(session) -> None:
    try:
        # Pending changes are flushed (and collected) at commit; flush now so we can follow them.
        session.flush()
        ids = session.info.pop(_DIRTY, None)
        if not ids:
            return
        from models import Binder

        for binder_id in ids:
            binder = session.get(Binder, binder_id)
            if binder is not None:
                reconcile_slots(session, binder, create=False)
    except Exception:
        logger.warning("Binder pocket sync failed", exc_info=True)
        raise


def _discard(session) -> None:
    session.info.pop(_DIRTY, None)


def register_binder_slot_listeners() -> None:
    """Register once for every Session: new copies take the first free pocket, removed ones leave a gap."""
    global _registered
    if _registered:
        return
    event.listen(Session, "before_flush", _collect)
    event.listen(Session, "before_commit", _sync_before_commit)
    event.listen(Session, "after_rollback", _discard)
    _registered = True


def unregister_binder_slot_listeners() -> None:
    global _registered
    if not _registered:
        return
    event.remove(Session, "before_flush", _collect)
    event.remove(Session, "before_commit", _sync_before_commit)
    event.remove(Session, "after_rollback", _discard)
    _registered = False
