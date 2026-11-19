"""Matcher only (no AI): the admin switch that cuts every scanner provider off (docs/scanner-providers.md).

A server setting ``scan_matcher_only`` (default from the ``SCAN_MATCHER_ONLY`` environment variable, off). While it is
on, the app never contacts Ollama, an OpenAI-compatible endpoint or Gemini, and every scan gets the picture matcher's
result however unsure it is. Nothing here touches anyone's stored provider, model, endpoint or key, so switching it off
restores exactly what was there.

Two layers keep it airtight:

* the flows above (scan queue, the single scan, the scanner test, retries, the minute sweep) check ``enabled(db)`` and
  answer from the matcher;
* the functions that really send a request to a provider call ``assert_provider_allowed()`` first and raise
  ``MatcherOnlyError``. That is the safety net; it reads a process flag that every ``enabled(db)`` call refreshes, so it
  needs no database session of its own.
"""

from __future__ import annotations

import logging
import os
import threading

logger = logging.getLogger(__name__)

SETTING_KEY = "scan_matcher_only"
TRUE = {"1", "true", "yes", "on"}

MESSAGE = "Matcher only is on: AI scanning is switched off"
INDEX_NOT_READY = "The picture index isn't ready yet"
INDEX_NOT_READY_ADMIN = "The picture index isn't ready yet. Build it in Scanner lab."
INDEX_REASONS = {"index_not_built", "model_missing", "ocr_missing", "model_error"}


class MatcherOnlyError(RuntimeError):
    """Raised by the lowest layer when something tries to reach a provider while Matcher only is on."""

    def __init__(self, message: str = MESSAGE):
        super().__init__(message)


_lock = threading.Lock()
_flag: bool | None = None  # None until a database read or a write has told this process


def env_default() -> bool:
    return os.environ.get("SCAN_MATCHER_ONLY", "").strip().lower() in TRUE


def set_flag(value: bool | None) -> None:
    global _flag
    with _lock:
        _flag = value


def reset() -> None:
    set_flag(None)


def enabled(db) -> bool:
    """The admin's choice when there is one, else the environment default. Never raises; refreshes the process flag."""
    value = env_default()
    try:
        from models import Setting

        row = db.query(Setting).filter(Setting.key == SETTING_KEY).first()
        if row is not None:
            value = str(row.value).strip().lower() in TRUE
    except Exception:
        logger.exception("Could not read the matcher-only setting")
        try:
            db.rollback()
        except Exception:
            pass
    set_flag(value)
    return value


def active() -> bool:
    """The process flag, for code that has no database session. Unknown means the environment default."""
    with _lock:
        flag = _flag
    return env_default() if flag is None else flag


def assert_provider_allowed() -> None:
    """Called by every function that actually sends a request to a provider."""
    if active():
        raise MatcherOnlyError()
