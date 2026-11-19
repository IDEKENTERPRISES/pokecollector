"""Version 15 test (option ``serverocr``): a stronger second try at the card number.

When the normal reading (the whole ladder, ``wholeread`` and ``widefirst`` included) ends without a complete number, the same flat
card is read again by a second RapidOCR engine built on the PP-OCRv4 *server* detection and recognition models (a bigger pair than the
mobile ones in the wheel). Only the first ``ocr.QUICK_STEPS`` steps run (the two tight number strips, then the plain bottom band),
plain preprocessing first, and the second try stops at the first complete number.

What it can change: a number the first read did not complete. ``merge`` keeps the first reading whenever it is complete, never touches
the name read, and takes the second reading only when it is MORE complete than the first. Everything else (parsing, lookup, the decision
rules and their thresholds) treats the number exactly as any other read.

The engine is built on first use, registered with ``lifecycle`` (idle unload frees its GPU sessions) and its sessions take their own
shares of the same per-process GPU budget (``device.py``), so with the budget used up by the picture model and the mobile OCR they run on the
CPU, with the reason recorded (``device.report()["ocr_server"]``). With the option off nothing here is ever imported or built.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time

import numpy as np

from . import config, device, lifecycle, ocr as ocr_module
from .model_specs import OCR_MODEL_SPECS

logger = logging.getLogger(__name__)

SOURCE = "server_ocr"
SERVER_BUDGET_SECONDS = 4.0  # no further step is read once the second try has taken this long (the server models are slow on a CPU)
KIND = "ocr-server"


def model_paths() -> tuple:
    return tuple(config.model_dir() / OCR_MODEL_SPECS[name]["filename"] for name in ("ocr-server-det", "ocr-server-rec"))


def models_available() -> bool:
    return all(path.is_file() for path in model_paths())


_checked: set[str] = set()


def _verify(path) -> None:
    """The pinned checksum, checked once per file before it is first loaded."""
    key = str(path)
    if key in _checked:
        return
    spec = next(spec for spec in OCR_MODEL_SPECS.values() if spec["filename"] == path.name)
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != spec["sha256"]:
        raise ValueError(f"OCR model file {path} does not match the pinned checksum")
    _checked.add(key)


class ServerOcrReader(ocr_module.OcrReader):
    """An ``OcrReader`` whose RapidOCR engine runs the PP-OCRv4 server models. The engine is built on first use, not here."""

    kind = KIND

    def __init__(self, threads: int | None = None) -> None:
        self._threads = threads
        self._lock = threading.Lock()
        self._whole = {}
        self.mode = "detect"
        self.device = None
        self.fallback_reason = None
        lifecycle.register(self)  # no ``_load_engine`` here: the first read builds it

    def _new_engine(self, rapid_class, count: int):
        det, rec = model_paths()
        for path in (det, rec):
            _verify(path)
        # The recogniser's character list is read from the ONNX metadata (rapidocr-onnxruntime 1.3.x), so no ``rec_keys_path`` is needed.
        return rapid_class(
            det_model_path=str(det), rec_model_path=str(rec), intra_op_num_threads=count, inter_op_num_threads=1, use_cls=False,
            det_limit_side_len=480, det_limit_type="max",
        )

    def second_try(self, card: np.ndarray, previous: ocr_module.OcrResult, *, flipped: bool) -> tuple[ocr_module.OcrResult, dict]:
        """(the merged reading, what happened). ``card`` is the flat card the first read used, ``flipped`` the way up it was read.
        Never replaces a complete number and never raises into a scan."""
        began = time.perf_counter()
        before = ocr_module.completeness(previous)
        info: dict = {"tried": True, "steps": 0, "number": None, "total": None, "complete": False, "rescued": False, "ms": 0.0, "error": None}
        if ocr_module.is_complete(previous):
            info["tried"] = False
            return previous, info
        try:
            second = self.read(card, read_hp=False, flipped=bool(flipped), stage="quick", budget=SERVER_BUDGET_SECONDS)
        except Exception as exc:  # noqa: BLE001 - a missing model or a broken engine leaves the first reading as it was
            logger.warning("Card matcher: the server OCR second try failed (%s: %s)", type(exc).__name__, exc)
            info["error"] = f"{type(exc).__name__}: {exc}"[:200]
            info["ms"] = round((time.perf_counter() - began) * 1000, 1)
            return previous, info
        for strip in second.strips:
            strip["label"] = f"server-{strip.get('label')}"
            strip["source"] = SOURCE
        info.update(steps=second.attempts, number=second.number_local, total=second.number_total, complete=ocr_module.is_complete(second))
        if ocr_module.completeness(second) > before:
            merged = ocr_module.merge_reads(previous, second)
        else:  # nothing more complete: keep the first reading, record what the second try looked at
            merged = previous
            merged.strips = list(previous.strips) + list(second.strips)
            merged.seconds += second.seconds
            merged.attempts += second.attempts
        info["rescued"] = ocr_module.completeness(merged) > before
        info["ms"] = round((time.perf_counter() - began) * 1000, 1)
        view = device.report()["ocr_server"]
        info["device"], info["reason"] = view.get("device"), view.get("reason")
        return merged, info


_reader: ServerOcrReader | None = None
_reader_lock = threading.Lock()


def get_server_reader() -> ServerOcrReader:
    global _reader
    with _reader_lock:
        if _reader is None:
            _reader = ServerOcrReader()
        return _reader


def warm_up() -> float | None:
    """Warm the second engine (builds it); None when its model files are not there."""
    if not models_available():
        return None
    return get_server_reader().warm_up()
