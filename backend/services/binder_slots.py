"""Helpers that keep binder_slots in step with bulk binder_cards deletes."""
from sqlalchemy.orm import Session

from models import BinderCard, BinderSlot


def delete_slots_for_entries(db: Session, entries_query) -> int:
    """Delete the pockets of every binder_cards row in ``entries_query``.

    Call this before a bulk ``entries_query.delete()``: bulk deletes skip ORM
    cascades, and SQLite (tests) does not enforce ON DELETE CASCADE.
    """
    ids = entries_query.with_entities(BinderCard.id).subquery()
    return db.query(BinderSlot).filter(
        BinderSlot.binder_card_id.in_(db.query(ids.c.id))
    ).delete(synchronize_session=False)
