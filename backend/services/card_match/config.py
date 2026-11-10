"""Environment-driven settings for the picture matcher."""

from __future__ import annotations

import os
from pathlib import Path

TRUE = {"1", "true", "yes", "on"}


def data_dir() -> Path:
    return Path(os.environ.get("CARD_MATCH_DIR", "/app/data/card-match"))


def model_dir() -> Path:
    return Path(os.environ.get("CARD_MATCH_MODEL_DIR", "/app/card-match-models"))


def threads() -> int:
    """ONNX Runtime and OpenCV thread cap (default 3 of the T340's 6 cores)."""
    try:
        return max(1, min(8, int(os.environ.get("CARD_MATCH_THREADS", "3"))))
    except ValueError:
        return 3


def autorun_enabled() -> bool:
    return os.environ.get("SCAN_MATCHER_AUTORUN", "").strip().lower() in TRUE


def index_after_sync_enabled() -> bool:
    return os.environ.get("SCAN_MATCHER_INDEX_AFTER_SYNC", "").strip().lower() in TRUE


def shadow_enabled() -> bool:
    """SCAN_MATCHER_SHADOW=1 (nonprod only): run the matcher beside the current scanner path."""
    return os.environ.get("SCAN_MATCHER_SHADOW", "").strip().lower() in TRUE


def apply_thread_caps() -> None:
    """Cap OpenCV's own thread pool (ONNX Runtime gets its cap per session)."""
    try:
        import cv2

        cv2.setNumThreads(threads())
    except ImportError:  # OpenCV is optional until a photo is processed
        pass


def lower_priority() -> None:
    """Be nice to the other services on the box (this thread only on Linux; a no-op elsewhere)."""
    try:
        os.nice(10)
    except (AttributeError, OSError):
        pass
