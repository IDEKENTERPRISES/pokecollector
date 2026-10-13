"""Throttle failed logins by client address and by username.

Only failures count, so a household sharing one address is not locked out by its own
successful logins. Two independent limits apply:

* per client address: slows password guessing from one machine;
* per username (across addresses): slows guessing spread over many machines. The cost is
  that someone can deliberately burn a victim's allowance; the window is short and
  clears by itself, and bcrypt's cost already limits how fast guesses can be made.

State is in memory and per process. That is enough for the default single-worker
deployment; a restart clears it.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from typing import Callable

IP_MAX_FAILURES = 10
IP_WINDOW_SECONDS = 5 * 60
USER_MAX_FAILURES = 20
USER_WINDOW_SECONDS = 15 * 60
_MAX_TRACKED_KEYS = 10_000


class LoginThrottle:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._ip_failures: dict[str, deque[float]] = defaultdict(deque)
        self._user_failures: dict[str, deque[float]] = defaultdict(deque)

    @staticmethod
    def _user_key(username: str) -> str:
        return (username or "").strip().lower()

    def _recent(self, store: dict[str, deque[float]], key: str, window: int) -> deque[float]:
        entries = store[key]
        cutoff = self._clock() - window
        while entries and entries[0] <= cutoff:
            entries.popleft()
        if not entries:
            store.pop(key, None)
        return entries

    def retry_after(self, ip: str, username: str) -> int:
        """Seconds until another attempt is allowed, or 0 when not throttled."""
        now = self._clock()
        waits = []
        with self._lock:
            ip_entries = self._recent(self._ip_failures, ip, IP_WINDOW_SECONDS)
            if len(ip_entries) >= IP_MAX_FAILURES:
                waits.append(ip_entries[0] + IP_WINDOW_SECONDS - now)
            user_key = self._user_key(username)
            user_entries = self._recent(self._user_failures, user_key, USER_WINDOW_SECONDS)
            if len(user_entries) >= USER_MAX_FAILURES:
                waits.append(user_entries[0] + USER_WINDOW_SECONDS - now)
        return max(1, int(max(waits) + 0.999)) if waits else 0

    def record_failure(self, ip: str, username: str) -> None:
        now = self._clock()
        with self._lock:
            self._ip_failures[ip].append(now)
            self._user_failures[self._user_key(username)].append(now)
            if len(self._ip_failures) > _MAX_TRACKED_KEYS or len(self._user_failures) > _MAX_TRACKED_KEYS:
                self._prune_locked()

    def record_success(self, username: str) -> None:
        with self._lock:
            self._user_failures.pop(self._user_key(username), None)

    def _prune_locked(self) -> None:
        for store, window in (
            (self._ip_failures, IP_WINDOW_SECONDS),
            (self._user_failures, USER_WINDOW_SECONDS),
        ):
            for key in list(store):
                self._recent(store, key, window)

    def reset(self) -> None:
        with self._lock:
            self._ip_failures.clear()
            self._user_failures.clear()


login_throttle = LoginThrottle()
