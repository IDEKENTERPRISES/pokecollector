"""Keep the matcher warm only while it is being used (the GPU is shared with Jellyfin transcoding).

Every use of a model (a scan's picture embedding or OCR read, a Scanner lab job, an index build) runs inside
``in_use()``. When nothing has used the matcher for ``CARD_MATCH_IDLE_UNLOAD_MINUTES`` (default 10, 0 = never) and no use
is in progress, a background thread releases every model session that holds GPU memory (``unload()`` on each registered
embedder/OCR reader). The Python objects stay, so anything holding one (a cached matcher) keeps working: the next use
reloads its sessions (``ensure loaded``). A use in progress is never cut off: unloading only happens at zero active uses.

What this frees: each session's CUDA memory arena (the model weights and scratch space). What it cannot free: ONNX Runtime
keeps the process's CUDA context (driver-side, roughly 100 to 200 MB on a Pascal card) until the process exits.
The log line written at each unload shows the card's used memory before and after, so the real figure can be read there.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import weakref
from contextlib import contextmanager

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_active = 0
_last_use = time.monotonic()
_registered: "weakref.WeakSet" = weakref.WeakSet()
_reaper: threading.Thread | None = None
_clock = time.monotonic  # replaced in tests


def idle_minutes() -> float:
    try:
        return max(0.0, float(os.environ.get("CARD_MATCH_IDLE_UNLOAD_MINUTES", "10")))
    except ValueError:
        return 10.0


def register(obj) -> None:
    """An embedder or OCR reader with ``unload() -> bool`` (True when it released GPU sessions)."""
    with _lock:
        _registered.add(obj)


def touch() -> None:
    global _last_use
    with _lock:
        _last_use = _clock()


@contextmanager
def in_use():
    """Wrap any use of a model; the matcher counts as busy (and not idle) until it exits."""
    global _active, _last_use
    with _lock:
        _active += 1
        _last_use = _clock()
    try:
        yield
    finally:
        with _lock:
            _active -= 1
            _last_use = _clock()


def is_busy() -> bool:
    with _lock:
        return _active > 0


def unload_if_idle(*, minutes: float | None = None) -> bool:
    """Release GPU sessions if the matcher has been idle long enough. Returns True when something was unloaded."""
    from . import device

    limit = idle_minutes() if minutes is None else minutes
    if limit <= 0 or not _idle_for(limit):
        return False
    before = device.gpu_used_mb()  # outside the lock: nvidia-smi is a subprocess
    with _lock:
        if _active > 0 or _clock() - _last_use < limit * 60:  # used again meanwhile
            return False
        unloaded = [obj for obj in list(_registered) if obj.unload()]
    if unloaded:
        after = device.gpu_used_mb()
        logger.info("Card matcher: idle for %s min, released the GPU sessions of %d model(s); card memory used %s -> %s MB",
                    limit, len(unloaded), before, after)
    return bool(unloaded)


def _idle_for(minutes: float) -> bool:
    with _lock:
        return _active == 0 and _clock() - _last_use >= minutes * 60


def _loop() -> None:
    while True:
        minutes = idle_minutes()
        time.sleep(min(60.0, max(5.0, minutes * 15)) if minutes else 60.0)
        try:
            unload_if_idle()
        except Exception:  # noqa: BLE001 - the reaper must never die
            logger.exception("Card matcher: idle unload failed")


def ensure_reaper() -> None:
    """Start the idle-unload thread the first time a model takes GPU memory (not at all when disabled)."""
    global _reaper
    if idle_minutes() <= 0:
        return
    with _lock:
        if _reaper is not None and _reaper.is_alive():
            return
        _reaper = threading.Thread(target=_loop, name="card-match-idle-unload", daemon=True)
        _reaper.start()


def reset_for_tests() -> None:
    global _active, _last_use, _clock
    with _lock:
        _active = 0
        _clock = time.monotonic
        _last_use = _clock()
        _registered.clear()
