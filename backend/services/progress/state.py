"""Progress state helpers: dirty marking and shared constants."""
import datetime
import logging

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import ProgressState, User

logger = logging.getLogger(__name__)

# A new collection row worth at least this many EUR (per copy) is a "big pull".
BIG_PULL_EUR = 20.0
# Rows added longer ago than this are imports or restores, not pulls.
BIG_PULL_MAX_AGE = datetime.timedelta(days=2)
# Users evaluated per progress_dirty_job run.
DIRTY_BATCH_SIZE = 25


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


def mark_users_dirty(db: Session, user_ids, now: datetime.datetime | None = None) -> None:
    """Upsert progress_state.dirty_at for the users and commit."""
    ids = sorted({int(user_id) for user_id in user_ids if user_id is not None})
    if not ids:
        return
    now = now or _now()
    try:
        _upsert_dirty(db, ids, now)
        db.commit()
    except IntegrityError:
        # Another session created a row between our read and insert; retry once.
        db.rollback()
        _upsert_dirty(db, ids, now)
        db.commit()


def _upsert_dirty(db: Session, ids: list[int], now: datetime.datetime) -> None:
    existing = {
        row.user_id: row
        for row in db.query(ProgressState).filter(ProgressState.user_id.in_(ids)).all()
    }
    for user_id in ids:
        row = existing.get(user_id)
        if row is None:
            db.add(ProgressState(
                user_id=user_id,
                dirty_at=now,
                completed_sets=[],
                last_seen_collection_id=0,
                state_version=1,
            ))
        else:
            row.dirty_at = now


def mark_all_users_dirty(db: Session) -> int:
    """Mark every active user dirty (value-based badges, nightly safety net)."""
    ids = [user_id for (user_id,) in db.query(User.id).filter(User.is_active == True).all()]  # noqa: E712
    mark_users_dirty(db, ids)
    return len(ids)


def mark_all_users_dirty_safely(db: Session) -> None:
    """Guarded call for the end of a sync: progress must never fail a sync."""
    try:
        mark_all_users_dirty(db)
    except Exception:
        db.rollback()
        logger.exception("Could not mark users dirty for progress evaluation")
