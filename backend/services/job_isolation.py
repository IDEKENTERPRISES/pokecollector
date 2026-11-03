"""Per-trainer isolation for scheduler jobs that loop over trainers in one session."""
from __future__ import annotations

import logging
from contextlib import contextmanager

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


@contextmanager
def trainer_savepoint(db: Session, label: str, user_id):
    """Run one trainer's work in a savepoint. If it raises, only that work is undone and the error is
    logged with the user id; work already done for other trainers in this session is kept."""
    try:
        with db.begin_nested():
            yield
            db.flush()  # a bad row surfaces here, against this trainer, not at the next one
    except Exception:
        logger.exception("%s failed for user %s", label, user_id)
