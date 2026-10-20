"""Transient TCGdex failures: classify them and retry them at the end of a sync.

A lookup that fails with a 5xx, 429, timeout or connection error says nothing about the card
or set, so the sync keeps it and tries again after the rest is done, with exponential backoff
and honouring Retry-After. Anything else (a 404 or another 4xx, a parse error) is permanent and
keeps its normal handling.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Callable

import httpx

from services import sync_progress

logger = logging.getLogger(__name__)

RETRY_ROUNDS = 3
RETRY_BASE_DELAY_SECONDS = 2.0
RETRY_MAX_DELAY_SECONDS = 30.0
RETRY_AFTER_CAP_SECONDS = 60.0


class TransientSyncError(Exception):
    """Raised by a retry callback whose lookup failed for a transient reason."""


def is_transient_error(exc: BaseException) -> bool:
    if isinstance(exc, TransientSyncError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return status == 429 or status >= 500
    return isinstance(exc, (httpx.TimeoutException, httpx.TransportError))


def retry_after_seconds(exc: BaseException) -> float:
    """Seconds the server asked us to wait (Retry-After), 0 when unknown."""
    response = getattr(exc, "response", None)
    value = response.headers.get("Retry-After") if response is not None else None
    try:
        return max(0.0, min(float(value), RETRY_AFTER_CAP_SECONDS)) if value is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


@dataclass
class _Entry:
    kind: str
    key: str
    attempt: Callable[[], None]
    wait: float = 0.0


@dataclass
class RetryQueue:
    """Collects transient failures during a sync and retries them at the end."""

    entries: list[_Entry] = field(default_factory=list)
    queued: int = 0
    recovered: int = 0
    permanent: int = 0
    rounds_run: int = 0

    def add(self, kind: str, key: str, attempt: Callable[[], None], exc: BaseException | None = None) -> None:
        """Queue a failed lookup. `attempt` redoes it and raises if it fails again."""
        self.entries.append(_Entry(kind, key, attempt, retry_after_seconds(exc) if exc else 0.0))
        self.queued += 1

    def run(self, *, rounds: int = RETRY_ROUNDS, sleep: Callable[[float], None] | None = None) -> dict[str, int]:
        sleep = sleep or time.sleep
        pending = self.entries
        self.entries = []
        for round_number in range(1, rounds + 1):
            if not pending:
                break
            delay = min(RETRY_BASE_DELAY_SECONDS * 2 ** (round_number - 1), RETRY_MAX_DELAY_SECONDS)
            sleep(max(delay, max(entry.wait for entry in pending)))
            self.rounds_run = round_number
            sync_progress.update("retrying", 0, len(pending))
            still: list[_Entry] = []
            recovered = 0
            for index, entry in enumerate(pending, start=1):
                try:
                    entry.attempt()
                    recovered += 1
                except Exception as exc:
                    if is_transient_error(exc):
                        entry.wait = retry_after_seconds(exc)
                        still.append(entry)
                    else:
                        self.permanent += 1
                        logger.warning("Retry of %s %s failed permanently: %s", entry.kind, entry.key, exc)
                sync_progress.advance(index)
            self.recovered += recovered
            logger.info(
                "Sync retry round %s/%s: retried=%s recovered=%s still_failing=%s",
                round_number, rounds, len(pending), recovered, len(still),
            )
            pending = still
        self.entries = pending
        return self.stats()

    def stats(self) -> dict[str, int]:
        return {
            "retried": self.queued,
            "recovered": self.recovered,
            "still_failing": len(self.entries),
            "permanent": self.permanent,
        }
