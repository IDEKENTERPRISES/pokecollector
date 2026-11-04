"""Shared "is the scanner endpoint answering?" state for the scan queue.

A self-hosted model endpoint is often switched off. Without this, each queued
scan discovered that on its own and climbed the six-hour retry ladder. One
cached answer per endpoint lets every scan wait the same way and be released
the moment the endpoint answers again.
"""

from __future__ import annotations

import threading
import time

import httpx

CHECK_TIMEOUT_SECONDS = 2.0
CACHE_SECONDS = 60.0
WAITING_REASON = "scanner_unreachable"
# While scans wait for the scanner their 14-day clock is held: the expiry is
# kept at least this far ahead, so nothing unrecognised is deleted unseen.
WAITING_EXPIRY_GRACE_DAYS = 2

_lock = threading.Lock()
_state: dict[str, tuple[bool, float]] = {}


def _cached(url: str) -> bool | None:
    with _lock:
        entry = _state.get(url)
    if entry is None:
        return None
    up, checked_at = entry
    if time.monotonic() - checked_at > CACHE_SECONDS:
        return None
    return up


def record_reachability(url: str, up: bool) -> None:
    with _lock:
        _state[url] = (up, time.monotonic())


def reset_reachability() -> None:
    with _lock:
        _state.clear()


def known_down(url: str) -> bool:
    return _cached(url) is False


async def endpoint_reachable(url: str, *, force: bool = False) -> bool:
    """True when something answers at ``url``; any HTTP status counts as an answer."""
    if not force:
        cached = _cached(url)
        if cached is not None:
            return cached
    try:
        async with httpx.AsyncClient(timeout=CHECK_TIMEOUT_SECONDS) as client:
            await client.get(f"{url.rstrip('/')}/models")
        up = True
    except httpx.RequestError:
        up = False
    record_reachability(url, up)
    return up
