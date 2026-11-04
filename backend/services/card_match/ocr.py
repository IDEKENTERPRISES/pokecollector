"""Read the printed identifiers from a flattened card: collector number and set total, set code, HP.

Engine: RapidOCR (PaddleOCR PP-OCRv4 mobile detection and recognition models, ONNX Runtime, Apache-2.0;
the model files ship inside the pip wheel, so nothing downloads at runtime). Tesseract was the
alternative; RapidOCR installs cleanly in the slim image (it needs no system packages when installed
with ``--no-deps`` next to ``opencv-python-headless``) and keeps the same ONNX Runtime the embedder uses.

Where to look on the flat card (fractions of the picture):
  - bottom-left strip and bottom-right strip: the collector number ("018/091"), set code ("SVI EN"),
    on older cards the number sits bottom-right ("58/102"), promos print "SWSH062" with no total;
  - top-right strip: "HP 70".
Parsing is plain regexes on the recognised text; ``parse_text`` is pure so tests need no engine.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field

import numpy as np

from . import config

# (x0, y0, x1, y1) as fractions of the flat card picture. The tight strips are quick (little text in them);
# when no number is found there, the wide strips take a second look (older cards print flavour text lower).
STRIPS = {"tight": [(0.0, 0.945, 0.55, 1.0), (0.45, 0.945, 1.0, 1.0)], "wide": [(0.0, 0.925, 0.55, 1.0), (0.45, 0.925, 1.0, 1.0)]}
HP_STRIP = (0.45, 0.0, 1.0, 0.14)

_NUMBER_TOTAL = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{0,4}\s?\d{1,3}[A-Za-z]?)\s*[/|\\]\s*([A-Za-z]{0,4}\s?\d{1,3})")  # no end guard: a stray mark after the total reads as one more digit
# A number glued to the text before it ("GAMEFREAK1999Wizards.58/102"): digits only, no prefix.
_NUMBER_TOTAL_LOOSE = re.compile(r"(\d{1,3})\s*[/|\\]\s*([0-9OoIl|]{2,3})")
_PROMO = re.compile(r"(?<![A-Za-z0-9])(SWSH|SVP|SM|XY|BW|HGSS|DP|NP|SVE|MEP|MEE)\s?-?\s?(\d{1,3})(?![0-9/])", re.IGNORECASE)
_HP_BEFORE = re.compile(r"(?:HP|PV|KP|PS|PF)\s*(\d{2,3})", re.IGNORECASE)
_HP_AFTER = re.compile(r"(?<!\d)(\d{2,3})\s?HP", re.IGNORECASE)
_TOKEN = re.compile(r"[A-Z0-9]{2,6}")
_LANG_CODES = {"EN", "DE", "FR", "IT", "ES", "PT", "JP", "KO", "NL", "PL", "RU", "ID", "TH", "ZH"}

# Digit look-alikes OCR confuses inside the number group.
_DIGITISE = str.maketrans({"O": "0", "o": "0", "D": "0", "Q": "0", "I": "1", "l": "1", "|": "1", "S": "5", "B": "8", "Z": "2"})


@dataclass
class OcrResult:
    number_local: str | None = None  # "018", "TG06", "SWSH062"
    number_total: str | None = None  # "091", "TG30"
    hp: str | None = None
    tokens: list[str] = field(default_factory=list)  # upper-case words, to match against set codes
    lines: list[str] = field(default_factory=list)  # raw recognised text, for diagnostics
    seconds: float = 0.0

    def as_card_info(self, set_codes: set[str] | None = None) -> dict:
        """The dict `api.recognize` rules read. ``set_code`` is a token that equals a known set code."""
        set_code = None
        if set_codes:
            known = {code.upper() for code in set_codes if code}
            set_code = next((token for token in self.tokens if token in known), None)
        return {
            "number_local": self.number_local, "number_total": self.number_total,
            "set_code": set_code, "hp": self.hp, "language": "en",
        }


def _clean_number_part(text: str, *, digits_only_tail: bool = True) -> str:
    text = re.sub(r"\s+", "", text)
    match = re.fullmatch(r"([A-Za-z]*)(\d{1,3}|[A-Za-z0-9]{1,3})([A-Za-z]?)", text)
    if not match:
        return text
    prefix, body, suffix = match.groups()
    if len(prefix) == 1 and prefix in "OoIlSBZDQ":  # real prefixes are two letters or more: this is a misread digit
        prefix, body = "", prefix.translate(_DIGITISE) + body
    return f"{prefix.upper()}{body.translate(_DIGITISE) if digits_only_tail else body}{suffix.upper()}"


def find_hp(text: str) -> str | None:
    match = _HP_BEFORE.search(text) or _HP_AFTER.search(text)
    return match.group(1) if match else None


def parse_text(lines: list[str]) -> OcrResult:
    """Pull number/total, HP and set-code tokens out of recognised text lines."""
    result = OcrResult(lines=list(lines))
    joined = "  ".join(lines)
    match = _NUMBER_TOTAL.search(joined)
    if match:
        result.number_local = _clean_number_part(match.group(1))
        result.number_total = _clean_number_part(match.group(2))
    elif loose := _NUMBER_TOTAL_LOOSE.search(joined):
        result.number_local = _clean_number_part(loose.group(1))
        result.number_total = _clean_number_part(loose.group(2))
    else:
        promo = _PROMO.search(joined)
        if promo:
            result.number_local = f"{promo.group(1).upper()}{promo.group(2).translate(_DIGITISE)}"
    result.hp = find_hp(joined)
    for token in _TOKEN.findall(joined.upper()):
        if token not in _LANG_CODES and token not in result.tokens:
            result.tokens.append(token)
    # Tokens glued to a number ("SVI018") also tell the set code; split letters off the front.
    for token in list(result.tokens):
        letters = re.match(r"([A-Z]{2,5})\d", token)
        if letters and letters.group(1) not in result.tokens:
            result.tokens.append(letters.group(1))
    return result


class OcrReader:
    """RapidOCR on the bottom strips (and optionally the HP strip) of a flat card."""

    def __init__(self, threads: int | None = None) -> None:
        from rapidocr_onnxruntime import RapidOCR

        count = threads or config.threads()
        self.engine = RapidOCR(
            intra_op_num_threads=count, inter_op_num_threads=1, use_cls=False,
            det_limit_side_len=480, det_limit_type="max",
        )
        self._lock = threading.Lock()

    def _strip_lines(self, card: np.ndarray, box: tuple[float, float, float, float]) -> list[str]:
        import cv2

        h, w = card.shape[:2]
        x0, y0, x1, y1 = box
        strip = card[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
        # Small caps text: a 2x upscale helps the detector without growing the cost much.
        strip = cv2.resize(strip, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
        with self._lock:
            found, _timing = self.engine(cv2.cvtColor(strip, cv2.COLOR_RGB2BGR))
        if not found:
            return []
        ordered = sorted(found, key=lambda item: min(point[0] for point in item[0]))
        return [str(item[1]) for item in ordered]

    def read(self, card: np.ndarray, *, read_hp: bool = True) -> OcrResult:
        import time

        started = time.monotonic()
        lines: list[str] = []
        for box in STRIPS["tight"]:
            lines += self._strip_lines(card, box)
        result = parse_text(lines)
        if result.number_local is None:
            for box in STRIPS["wide"]:
                lines += self._strip_lines(card, box)
            result = parse_text(lines)
        if read_hp:
            hp_lines = self._strip_lines(card, HP_STRIP)
            hp = find_hp("  ".join(hp_lines))
            if hp:
                result.hp = hp
            else:  # "HP" and the figure on separate lines, or the HP word misread
                figures = [int(m) for m in re.findall(r"(?<!\d)(\d{2,3})(?!\d)", " ".join(hp_lines))]
                result.hp = next((str(v) for v in figures if 30 <= v <= 340 and v % 10 == 0), None)
            result.lines += [f"[hp] {line}" for line in hp_lines]
        result.seconds = round(time.monotonic() - started, 3)
        return result


_reader: OcrReader | None = None
_reader_lock = threading.Lock()


def get_reader() -> OcrReader:
    global _reader
    with _reader_lock:
        if _reader is None:
            _reader = OcrReader()
        return _reader
