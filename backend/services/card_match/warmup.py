"""Load the picture model and OCR at startup and run one dummy inference through each (CARD_MATCH_WARM=1).

The sessions then stay loaded for the life of the process (``embed.get_embedder`` and ``ocr.get_reader`` cache them),
so the first real scan pays neither CUDA start-up nor session creation. Runs in a background thread so the API
comes up at once; a failure is logged and leaves the lazy path as it was.
"""

from __future__ import annotations

import logging
import threading

from . import device, embed, model_specs

logger = logging.getLogger(__name__)


def warm_up() -> dict:
    """Warm both models; returns {"embedder": seconds | None, "ocr": seconds | None}. Never raises."""
    result: dict = {"embedder": None, "ocr": None}
    try:
        if embed.model_available(model_specs.DEFAULT_MODEL):
            result["embedder"] = embed.get_embedder(model_specs.DEFAULT_MODEL).warm_up()
    except Exception:  # noqa: BLE001
        logger.exception("Card matcher: picture model warm-up failed")
    try:
        from .ocr import get_reader

        result["ocr"] = get_reader().warm_up()
    except Exception:  # noqa: BLE001
        logger.exception("Card matcher: OCR warm-up failed")
    view = device.report()
    logger.info("Card matcher warm: picture model on %s (%s ms), OCR on %s (%s ms)",
                view["embedder"].get("label"), view["embedder"].get("warm_ms"), view["ocr"].get("label"), view["ocr"].get("warm_ms"))
    return result


def start_in_background() -> bool:
    if not device.warm_enabled():
        return False
    threading.Thread(target=warm_up, name="card-match-warmup", daemon=True).start()
    return True
