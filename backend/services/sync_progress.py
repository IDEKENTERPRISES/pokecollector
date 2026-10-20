"""In-memory progress of the running sync, for GET /api/sync/status.

Nothing is written to the database per card: the sync updates a small dict under a lock and the
status endpoint copies it. It is per process, like the endpoint's running flags.
"""

from __future__ import annotations

import threading
from typing import Any

_lock = threading.Lock()
_state: dict[str, Any] | None = None


def start(kind: str) -> None:
    """Begin tracking a sync of `kind` ("full" or "price")."""
    global _state
    with _lock:
        _state = {"kind": kind, "stage": "starting", "done": 0, "total": 0}


def update(stage: str, done: int = 0, total: int = 0) -> None:
    """Set the stage and its counters. total 0 means the size is not known."""
    with _lock:
        if _state is not None:
            _state.update(stage=stage, done=max(0, int(done)), total=max(0, int(total)))


def advance(done: int, total: int | None = None) -> None:
    """Move the counters of the current stage."""
    with _lock:
        if _state is not None:
            _state["done"] = max(0, int(done))
            if total is not None:
                _state["total"] = max(0, int(total))


def finish() -> None:
    global _state
    with _lock:
        _state = None


def snapshot() -> dict[str, Any] | None:
    """A copy of the progress, or None when no sync is tracked."""
    with _lock:
        return dict(_state) if _state is not None else None
