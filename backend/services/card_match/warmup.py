"""Load the picture model and OCR at startup and run one dummy inference through each (CARD_MATCH_WARM=1).

The sessions then stay loaded for the life of the process (``embed.get_embedder`` and ``ocr.get_reader`` cache them),
so the first real scan pays neither CUDA start-up nor session creation. Runs in a background thread so the API
comes up at once; a failure is logged and leaves the lazy path as it was.
"""

from __future__ import annotations

import logging
import threading

import time

from . import device, embed, lifecycle, model_specs

logger = logging.getLogger(__name__)

WARM_INTERVAL = 20.0  # seconds between warm-ups the endpoint will start
_request_lock = threading.Lock()
_last_request = float("-inf")
_warming = False


def warm_up() -> dict:
    """Warm both models; returns {"embedder": seconds | None, "ocr": seconds | None}. Never raises."""
    result: dict = {"embedder": None, "ocr": None}
    before = device.gpu_used_mb()
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
    try:  # version 15: the second engine is warmed only when the options in use include ``serverocr``
        from . import variants

        if variants.parse(variants.active_label()).serverocr:
            from . import ocr_server

            result["ocr_server"] = ocr_server.warm_up()
    except Exception:  # noqa: BLE001
        logger.exception("Card matcher: server OCR warm-up failed")
    view = device.report()
    after = device.gpu_used_mb()
    # The card's used memory around the warm-up (whole card, so another program on it shows up too): what the shares are tuned from.
    logger.info("Card matcher warm: picture model on %s (%s ms), OCR on %s (%s ms); card memory used %s -> %s MB",
                view["embedder"].get("label"), view["embedder"].get("warm_ms"), view["ocr"].get("label"), view["ocr"].get("warm_ms"), before, after)
    return result


def is_warm() -> bool:
    """Both models are loaded right now (nothing to do for a warm request)."""
    from . import ocr

    embedder = embed._cache.get((model_specs.DEFAULT_MODEL, embed.config.threads()))
    reader = ocr._reader
    return bool(embedder is not None and embedder.session is not None and reader is not None and reader.engine is not None)


def request_warm(now: float | None = None) -> dict:
    """The warm endpoint: counts as use, and starts a background warm-up if the models are not loaded.
    Returns at once. At most one warm-up per WARM_INTERVAL seconds; does nothing unless CARD_MATCH_WARM is on."""
    global _last_request, _warming
    lifecycle.touch()
    if not device.warm_enabled():
        return {"status": "off"}
    now = time.monotonic() if now is None else now
    with _request_lock:
        if _warming:
            return {"status": "warming"}
        if is_warm():
            return {"status": "warm"}
        if now - _last_request < WARM_INTERVAL:
            return {"status": "rate-limited"}
        _last_request = now
        _warming = True

    def work() -> None:
        global _warming
        try:
            warm_up()
        finally:
            _warming = False

    threading.Thread(target=work, name="card-match-warm-request", daemon=True).start()
    return {"status": "warming"}


def start_in_background() -> bool:
    if not device.warm_enabled():
        return False
    threading.Thread(target=warm_up, name="card-match-warmup", daemon=True).start()
    return True
