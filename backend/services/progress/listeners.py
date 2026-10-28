"""Session listeners that mark a user's progress dirty when their data changes.

Best-effort fast path: ``after_flush`` collects user ids, ``after_commit`` marks
them in a short separate session, ``after_rollback`` discards them. Bulk
``query().delete()`` and raw SQL skip ORM events; the scheduled jobs cover that.
"""
import logging

from sqlalchemy import event, select
from sqlalchemy.orm import Session

from models import Binder, BinderCard, CollectionItem, ProductPurchase, Trade, WishlistItem

logger = logging.getLogger(__name__)

_PENDING = "progress_dirty_user_ids"
_BIND = "progress_dirty_bind"
_registered = False

_DIRECT_MODELS = (CollectionItem, WishlistItem, Trade, ProductPurchase)


def _collect(session: Session, flush_context) -> None:
    try:
        ids = session.info.setdefault(_PENDING, set())
        for obj in list(session.new) + list(session.dirty) + list(session.deleted):
            if isinstance(obj, _DIRECT_MODELS):
                if obj.user_id is not None:
                    ids.add(obj.user_id)
            elif isinstance(obj, BinderCard) and obj.binder_id is not None:
                owner = session.execute(
                    select(Binder.user_id).where(Binder.id == obj.binder_id)
                ).scalar()
                if owner is not None:
                    ids.add(owner)
        if ids:
            session.info[_BIND] = session.get_bind()
    except Exception:
        logger.debug("Progress dirty collection failed", exc_info=True)


def _mark(session: Session) -> None:
    ids = session.info.pop(_PENDING, None)
    bind = session.info.pop(_BIND, None)
    if not ids or bind is None:
        return
    try:
        from services.progress.state import mark_users_dirty

        with Session(bind=bind) as marker:
            mark_users_dirty(marker, ids)
    except Exception:
        logger.debug("Progress dirty marking failed", exc_info=True)


def _discard(session: Session) -> None:
    session.info.pop(_PENDING, None)
    session.info.pop(_BIND, None)


def register_progress_listeners() -> None:
    """Register the listeners once for every Session."""
    global _registered
    if _registered:
        return
    event.listen(Session, "after_flush", _collect)
    event.listen(Session, "after_commit", _mark)
    event.listen(Session, "after_rollback", _discard)
    _registered = True


def unregister_progress_listeners() -> None:
    global _registered
    if not _registered:
        return
    event.remove(Session, "after_flush", _collect)
    event.remove(Session, "after_commit", _mark)
    event.remove(Session, "after_rollback", _discard)
    _registered = False
