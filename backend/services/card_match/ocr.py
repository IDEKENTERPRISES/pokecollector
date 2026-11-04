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
import time
from dataclasses import dataclass, field

import numpy as np

from . import config

# (x0, y0, x1, y1) as fractions of the flat card picture. The tight strips are quick (little text in them);
# when no number is found there, the wide strips take a second look (older cards print flavour text lower).
STRIPS = {"tight": [(0.0, 0.945, 0.55, 1.0), (0.45, 0.945, 1.0, 1.0)], "wide": [(0.0, 0.905, 0.55, 1.0), (0.45, 0.905, 1.0, 1.0)]}
WIDE_ZOOM = 3.0
REFERENCE_HEIGHT = 880  # the zooms above are for a card this tall; a sharper card needs less upscaling for the same strip size
HP_STRIP = (0.45, 0.0, 1.0, 0.14)

_NUMBER_TOTAL = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{0,4}\s?\d{1,3}[A-Za-z]?)\s*[/\\]\s*([A-Za-z]{0,4}\s?\d{1,3})")  # no end guard: a stray mark after the total reads as one more digit
# A slash read as a bar ("018|091"): only when nothing separates it from the digits, because a bar with spaces
# around it is a printed divider ("30C | 017/128", the 30th Celebration mark).
_NUMBER_TOTAL_BAR = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{0,4}\d{1,3}[A-Za-z]?)\|([A-Za-z]{0,4}\d{1,3})")
# A number glued to the text before it ("GAMEFREAK1999Wizards.58/102"): digits only, no prefix.
_NUMBER_TOTAL_LOOSE = re.compile(r"(\d{1,3})(?:\s*[/\\]\s*|\|)([0-9OoIl|]{2,3})")
# The slash is thin and often read as nothing: "SVI EN 018/091" comes out "SVIEN018091". A line that ENDS in five or
# six digit-like characters is a number glued to its total (three digits and three, or two and three: "58102").
_NUMBER_GLUED = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]{0,7}?\s?([0-9OoIlSZBDQ]{5,6})\s*$")
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
    flipped: bool = False  # the number was read on the card turned 180 degrees
    number_confidence: float | None = None  # mean recogniser confidence of the line(s) the number came from
    strips: list[dict] = field(default_factory=list)  # every region read: label, box, variant, zoom, and each line's text and confidence
    attempts: int = 0  # how many regions were read for the number

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
    if prefix.upper() in _LANG_CODES:  # "SSP EN 038/270": the language code belongs to the set code, not the number
        prefix = ""
    if len(prefix) == 1 and prefix in "OoIlSBZDQ":  # real prefixes are two letters or more: this is a misread digit
        prefix, body = "", prefix.translate(_DIGITISE) + body
    return f"{prefix.upper()}{body.translate(_DIGITISE) if digits_only_tail else body}{suffix.upper()}"


def completeness(result: OcrResult) -> int:
    """0 nothing, 1 a number, 2 number and total (or a promo number, which has no total)."""
    if not result.number_local:
        return 0
    if result.number_total or re.match(r"[A-Z]{2,4}\d", result.number_local):
        return 2
    return 1


def is_complete(result: OcrResult) -> bool:
    return completeness(result) == 2


def _glued_number(lines: list[str]) -> tuple[str, str] | None:
    for line in lines:
        match = _NUMBER_GLUED.search(line.strip())
        if not match:
            continue
        blob = match.group(1)
        if sum(ch.isdigit() for ch in blob) < 4:
            continue
        digits = blob.translate(_DIGITISE)
        split = 3 if len(digits) == 6 else 2
        local, total = digits[:split], digits[split:]
        if digits.isdigit() and int(local) > 0 and int(total) > 0:
            return local, total
    return None


def find_hp(text: str) -> str | None:
    match = _HP_BEFORE.search(text) or _HP_AFTER.search(text)
    return match.group(1) if match else None


def parse_text(lines: list[str]) -> OcrResult:
    """Pull number/total, HP and set-code tokens out of recognised text lines."""
    result = OcrResult(lines=list(lines))
    joined = "  ".join(lines)
    match = _NUMBER_TOTAL.search(joined) or _NUMBER_TOTAL_BAR.search(joined)
    if match:
        result.number_local = _clean_number_part(match.group(1))
        result.number_total = _clean_number_part(match.group(2))
    elif loose := _NUMBER_TOTAL_LOOSE.search(joined):
        result.number_local = _clean_number_part(loose.group(1))
        result.number_total = _clean_number_part(loose.group(2))
    elif glued := _glued_number(lines):
        result.number_local, result.number_total = glued
    else:
        promo = _PROMO.search(joined)
        if promo:
            result.number_local = f"{promo.group(1).upper()}{promo.group(2).translate(_DIGITISE)}"
    result.hp = find_hp(joined)
    for token in _TOKEN.findall(joined.upper()):
        if token not in _LANG_CODES and token not in result.tokens:
            result.tokens.append(token)
    # Tokens glued to a number ("SVI018") also tell the set code; split letters off the front, and a language
    # code off the end ("SVIEN018" -> "SVIEN" -> "SVI").
    for token in list(result.tokens):
        letters = re.match(r"([A-Z]{2,5})\d", token)
        if letters and letters.group(1) not in result.tokens:
            result.tokens.append(letters.group(1))
    for token in list(result.tokens):
        if len(token) > 4 and token[-2:] in _LANG_CODES and token[:-2] not in result.tokens:
            result.tokens.append(token[:-2])
    return result


@dataclass
class Line:
    """One recognised line: text, confidence, and its box in the read picture's pixels."""
    text: str
    score: float
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def height(self) -> float:
        return self.y1 - self.y0


# ── Picking by pattern (pure) ────────────────────────────────────────────────

_SLASH_NUMBER = re.compile(r"\d{1,3}\s*[/|\\]\s*[0-9OoIl|]{2,3}")
_NOT_A_NAME = re.compile(
    r"nintendo|creatures|gamefreak|game\s*freak|illus|©|\(c\)|\bturn\b|\byou\b|\byour\b|\bdamage\b|\battack|\bflip\b|knocked|"
    r"\bdiscard|opponent|\brule\b|\bdeck\b|\bcards?\b|\bthis\b|\bprize|weakness|resistance|retreat|\d{2,}/\d{2,}", re.IGNORECASE)
_COPYRIGHT = re.compile(r"nintendo|creatures|game\s*freak|©|\(c\)|illus", re.IGNORECASE)
MAX_NAME_CHARS = 28
MAX_NAME_WORDS = 4


def is_name_like(text: str) -> bool:
    """Could this recognised line be a card's name rather than body text, a copyright line or a number?
    Names are short, mostly letters and start with capitals; rules text is long and sentence-like."""
    from . import names

    cleaned = names.clean_name_line(text)
    if len(re.findall(r"[A-Za-zÀ-ɏ]", cleaned)) < 3 or len(cleaned) > MAX_NAME_CHARS:
        return False
    if _NOT_A_NAME.search(cleaned) or _COPYRIGHT.search(str(text or "")):
        return False
    words = cleaned.split()
    if len(words) > MAX_NAME_WORDS:
        return False
    lower = sum(1 for word in words if word[:1].islower() and word.casefold() not in {"of", "the", "and", "de", "du", "la", "van"})
    return not (len(words) >= 3 and lower * 2 >= len(words))


def pick_number_lines(lines: list[Line]) -> tuple[OcrResult, float | None]:
    """The number and total from recognised lines, and the confidence of the line that carried them.

    A single line that holds a whole "018/091" (or the glued "018091") wins over a number stitched together from
    neighbouring lines; with several, the most confident. Falls back to reading all the text together."""
    best: tuple[tuple[int, float], OcrResult] | None = None
    for line in lines:
        single = parse_text([line.text])
        if single.number_local and single.number_total:
            key = (1 if _SLASH_NUMBER.search(line.text) else 0, line.score)
            if best is None or key > best[0]:
                best = (key, single)
    result = parse_text([line.text for line in lines])
    if best is not None:
        result.number_local, result.number_total = best[1].number_local, best[1].number_total
        return result, round(best[0][1], 3)
    carriers = [line.score for line in lines if _PROMO.search(line.text)]
    return result, round(sum(carriers) / len(carriers), 3) if carriers and result.number_local else None


def better_read(old: OcrResult | None, new: OcrResult) -> OcrResult:
    """The more useful of two readings of the same card: more complete, then more confident. When the two agree
    on the number, the agreement raises the confidence (two views reading the same digits is the consistency check)."""
    if old is None:
        return new
    if (old.number_local, old.number_total) == (new.number_local, new.number_total) and old.number_local:
        old.number_confidence = round(min(1.0, max(old.number_confidence or 0.0, new.number_confidence or 0.0) + 0.1), 3)
        for token in new.tokens:
            if token not in old.tokens:
                old.tokens.append(token)
        return old
    old_key = (completeness(old), old.number_confidence or 0.0)
    new_key = (completeness(new), new.number_confidence or 0.0)
    winner, loser = (new, old) if new_key > old_key else (old, new)
    for token in loser.tokens:
        if token not in winner.tokens:
            winner.tokens.append(token)
    return winner


# ── Preprocessing (pure) ─────────────────────────────────────────────────────

VARIANTS = ("plain", "sharp", "clahe", "binary", "deglare")
GLARE_MIN, GLARE_MAX = 0.003, 0.45  # fraction of a strip that is blown out: below it nothing to remove, above it nothing to recover


def glare_mask(strip: np.ndarray):
    import cv2

    hsv = cv2.cvtColor(strip, cv2.COLOR_RGB2HSV)
    return ((hsv[:, :, 2] >= 235) & (hsv[:, :, 1] <= 70)).astype(np.uint8)


def _clahe(strip: np.ndarray, clip: float = 3.0) -> np.ndarray:
    import cv2

    lab = cv2.cvtColor(strip, cv2.COLOR_RGB2LAB)
    lab[:, :, 0] = cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 3)).apply(lab[:, :, 0])
    return cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)


def prepare(strip: np.ndarray, variant: str) -> np.ndarray | None:
    """The strip as the recogniser should see it, or None when this variant would change nothing (``deglare``
    on a strip with no glare), so the caller skips a pointless second read.

    plain: as photographed. sharp: unsharp mask. clahe: local contrast normalisation (foil, dim rooms).
    binary: black text on white by an adaptive threshold (flat, low-contrast prints). deglare: blown-out
    patches filled in from their surroundings, then local contrast (sleeves and top-loaders)."""
    import cv2

    if variant == "plain":
        return strip
    if variant == "sharp":
        return cv2.addWeighted(strip, 1.8, cv2.GaussianBlur(strip, (0, 0), 2.0), -0.8, 0)
    if variant == "clahe":
        return _clahe(strip)
    if variant == "binary":
        gray = cv2.cvtColor(_clahe(strip, 2.0), cv2.COLOR_RGB2GRAY)
        if float(np.median(gray)) < 110:  # light text on a dark card: flip so the text is the dark mark
            gray = 255 - gray
        block = max(15, (min(gray.shape) // 2) | 1)
        binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, 10)
        return cv2.cvtColor(binary, cv2.COLOR_GRAY2RGB)
    if variant == "deglare":
        mask = glare_mask(strip)
        fraction = float(mask.mean())
        if not GLARE_MIN <= fraction <= GLARE_MAX:
            return None
        mask = cv2.dilate(mask, np.ones((5, 5), np.uint8))
        return _clahe(cv2.inpaint(strip, mask, 3, cv2.INPAINT_TELEA), 2.0)
    raise ValueError(f"unknown variant {variant}")


# ── Where the reader looks ───────────────────────────────────────────────────

# (label, box as fractions of the card, variant, zoom, low thresholds). The first two rows are what version 4 read.
LEGACY_LADDER = (  # version 4: fixed strips, the wide ones only when the tight ones found no complete number
    ("number-left-tight", STRIPS["tight"][0], "plain", 2.0, False),
    ("number-right-tight", STRIPS["tight"][1], "plain", 2.0, False),
    ("number-left-wide", STRIPS["wide"][0], "sharp", WIDE_ZOOM, False),
    ("number-right-wide", STRIPS["wide"][1], "sharp", WIDE_ZOOM, False),
)
BOTTOM_BAND = (0.0, 0.885, 1.0, 1.0)
NUMBER_LADDER = LEGACY_LADDER[:2] + (  # the fast first try, the whole bottom band, the wide strips, then more preprocessing
    ("bottom-band", BOTTOM_BAND, "plain", 3.0, True),
) + LEGACY_LADDER[2:] + (
    ("bottom-band", BOTTOM_BAND, "clahe", 2.5, True),
    ("bottom-band", BOTTOM_BAND, "deglare", 2.5, True),
    ("bottom-band", BOTTOM_BAND, "binary", 3.0, True),
)
NAME_BAND = (0.03, 0.015, 0.80, 0.115)  # the name line only; the HP and energy symbol to the right are left out
NAME_LADDER = (
    ("name-line", None, "plain", 2.0, False),  # None: names.NAME_STRIP, the strip version 4 read
    ("name-band", NAME_BAND, "clahe", 2.5, True),
    ("name-band", NAME_BAND, "binary", 3.0, True),
    ("name-band", NAME_BAND, "deglare", 2.5, True),
)
EXPANDED = {"top": (0.0, 0.0, 1.0, 0.24), "bottom": (0.0, 0.72, 1.0, 1.0)}  # the last-resort bands
WHOLE_SIDE = 960  # the longest side the detector looks at in one read
BUDGET_SECONDS = 1.2  # no further region is read once one card's reading has taken this long
ACCEPT_CONFIDENCE = 0.85  # a complete number this sure needs no second view


def render_strip(card: np.ndarray, strip: dict) -> np.ndarray:
    """The exact picture the recogniser got for one recorded region (for the lab's strip view)."""
    import cv2

    if strip.get("flipped"):
        card = np.ascontiguousarray(card[::-1, ::-1])
    h, w = card.shape[:2]
    x0, y0, x1, y1 = strip["box"]
    crop = card[int(y0 * h):max(int(y1 * h), int(y0 * h) + 1), int(x0 * w):max(int(x1 * w), int(x0 * w) + 1)]
    zoom = strip.get("zoom") or 1.0
    crop = cv2.resize(crop, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_CUBIC)
    return prepare(crop, strip.get("variant", "plain")) if crop.size else crop


class OcrReader:
    """RapidOCR on regions of a flat card, found and read by pattern.

    Number ladder (each step only when the one before did not give a complete, confident number and total):
    the tight strips, then the whole bottom band under preprocessing variants
    (local contrast, binarised, glare removed), then a much taller band as a last resort. Name ladder: the name strip,
    then the top band under the same variants. If all of that found nothing, a much taller band at the top and the
    bottom (a card flattened with a margin). Whatever is read is picked by pattern
    (``pick_number_lines``, ``is_name_like``), not by where it was found, so a card flattened with a margin, or
    printed with the number somewhere unusual, still reads. ``flipped`` says which way up the card is (the
    picture search knows); otherwise the turned card is tried too when nothing complete came out.
    """

    def __init__(self, threads: int | None = None) -> None:
        from rapidocr_onnxruntime import RapidOCR

        count = threads or config.threads()
        self.engine = RapidOCR(
            intra_op_num_threads=count, inter_op_num_threads=1, use_cls=False,
            det_limit_side_len=480, det_limit_type="max",
        )
        self._lock = threading.Lock()
        self._whole: dict[tuple, list[Line]] = {}
        self.mode = "detect"  # "fixed": version 4's fixed strips only (the OCR check compares the two)

    # -- one recogniser call --------------------------------------------------

    def _run(self, picture: np.ndarray, *, low: bool = False) -> list[Line]:
        import cv2

        side = 480 if self.mode == "fixed" else int(min(WHOLE_SIDE, max(480, max(picture.shape[:2]))))
        with self._lock:
            self.engine.text_det.preprocess_op.limit_side_len = side
            if low:  # fainter text counts: glossy and sleeved cards read with less contrast
                found, _timing = self.engine(cv2.cvtColor(picture, cv2.COLOR_RGB2BGR), box_thresh=0.35, text_score=0.4)
            else:
                found, _timing = self.engine(cv2.cvtColor(picture, cv2.COLOR_RGB2BGR), box_thresh=0.5, text_score=0.5)
        lines = []
        for item in found or []:
            xs, ys = [point[0] for point in item[0]], [point[1] for point in item[0]]
            lines.append(Line(str(item[1]), float(item[2]) if len(item) > 2 else 0.0, min(xs), min(ys), max(xs), max(ys)))
        return sorted(lines, key=lambda line: line.x0)

    def _zoom(self, card: np.ndarray, zoom: float) -> float:
        h = card.shape[0]
        # real detail instead of upscaled pixels on a sharper card; but small text keeps a real upscale
        return max(1.0, zoom * REFERENCE_HEIGHT / h) if h > REFERENCE_HEIGHT else zoom

    def _scan(self, card: np.ndarray, label: str, box, variant: str, zoom: float, low: bool, record: list[dict], flipped: bool) -> list[Line] | None:
        """Read one region; None when the variant changes nothing for it. Appends what was read to ``record``."""
        import cv2

        h, w = card.shape[:2]
        x0, y0, x1, y1 = box
        crop = card[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
        zoom = self._zoom(card, zoom)
        strip = prepare(cv2.resize(crop, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_CUBIC), variant)
        if strip is None:
            return None
        lines = self._run(strip, low=low)
        record.append({"label": label, "box": [round(v, 4) for v in box], "variant": variant, "zoom": round(zoom, 3), "low": low, "flipped": flipped,
                       "lines": [{"text": line.text, "score": round(line.score, 3)} for line in lines[:14]]})
        return lines

    def _expanded(self, card: np.ndarray, record: list[dict], flipped: bool, which: str) -> list[Line]:
        """The last resort when the usual regions found nothing: a much taller band at the top or the bottom, so a card
        flattened with a margin (corners found a little wide) or printed with the text somewhere unusual still reads.
        Cached per card and side: the number read and the name read of one scan share each pass. A whole-card pass
        was tried first and costs about a second on the same CPU (every line of rules text is recognised too)."""
        key = (hash(card[::53, ::47].tobytes()), card.shape, flipped, which)
        if key not in self._whole:
            if len(self._whole) > 12:
                self._whole.clear()
            scratch: list[dict] = []
            lines = self._scan(card, f"{which}-wide", EXPANDED[which], "clahe", 2.0, True, scratch, flipped) or []
            self._whole[key] = (lines, scratch[0])
        lines, entry = self._whole[key]
        record.append(entry)
        return lines

    def _strip_items(self, card: np.ndarray, box: tuple[float, float, float, float], *, zoom: float = 2.0, sharpen: bool = False) -> list[tuple[str, float]]:
        """(text, height in strip pixels) per recognised line of one strip, left to right (the plain single-strip read
        the tests and ad-hoc tools use; the ladder goes through ``_scan``)."""
        import cv2

        h, w = card.shape[:2]
        x0, y0, x1, y1 = box
        strip = cv2.resize(card[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)], None, fx=self._zoom(card, zoom), fy=self._zoom(card, zoom), interpolation=cv2.INTER_CUBIC)
        if sharpen:
            strip = prepare(strip, "sharp")
        with self._lock:
            found, _timing = self.engine(cv2.cvtColor(strip, cv2.COLOR_RGB2BGR))
        ordered = sorted(found or [], key=lambda item: min(point[0] for point in item[0]))
        return [(str(item[1]), float(max(point[1] for point in item[0]) - min(point[1] for point in item[0]))) for item in ordered]

    # -- the name -------------------------------------------------------------

    def read_name(self, card: np.ndarray, *, flipped: bool = False):
        """The name line (and the HP) at the top of the flat card; ``flipped`` turns the card first."""
        from . import names

        started = time.monotonic()
        if flipped:
            card = np.ascontiguousarray(card[::-1, ::-1])
        record: list[dict] = []
        ladder = NAME_LADDER[:1] if self.mode == "fixed" else NAME_LADDER
        found: list[Line] = []
        all_lines: list[Line] = []
        for label, box, variant, zoom, low in ladder:
            if found or (all_lines and time.monotonic() - started > BUDGET_SECONDS):
                break
            lines = self._scan(card, label, box or names.NAME_STRIP, variant, zoom if box else names.NAME_ZOOM, low, record, flipped)
            if lines is None:
                continue
            all_lines += lines
            found = [line for line in lines if is_name_like(line.text)]
        if not found and self.mode != "fixed" and time.monotonic() - started <= BUDGET_SECONDS * 1.5:
            top = self._expanded(card, record, flipped, "top")
            all_lines += top
            found = [line for line in top if is_name_like(line.text) and line.y1 / record[-1]["zoom"] / card.shape[0] <= 0.2]
        read = names.parse_name_lines([(line.text, line.height) for line in found])
        read.raw = [line.text for line in all_lines][:12]
        read.strips = record
        read.hp = read.hp or find_hp("  ".join(line.text for line in all_lines))
        return read

    # -- the number -----------------------------------------------------------

    def _read_card(self, card: np.ndarray) -> OcrResult:
        flipped = bool(getattr(self, "_turned", False))  # set by ``read``: which way up this card is being read
        record: list[dict] = []
        started = time.monotonic()
        ladder = LEGACY_LADDER if self.mode == "fixed" else NUMBER_LADDER
        lines: list[Line] = []
        best: OcrResult | None = None
        reads = 0
        for label, box, variant, zoom, low in ladder:
            if best is not None and completeness(best) == 2 and (best.number_confidence or 0.0) >= ACCEPT_CONFIDENCE:
                break
            if reads and time.monotonic() - started > BUDGET_SECONDS:
                break
            got = self._scan(card, label, box, variant, zoom, low, record, flipped)
            if got is None:
                continue
            reads += 1
            lines += got
            if "band" in label:  # independent readings of the same area, merged by agreement
                reading, confidence = pick_number_lines(got)
                reading.number_confidence = confidence
                best = better_read(best, reading)
            else:  # the strips are halves of one reading: pick from everything read so far
                best, confidence = pick_number_lines(lines)
                best.number_confidence = confidence
        if (best is None or completeness(best) < 2) and self.mode != "fixed" and time.monotonic() - started <= BUDGET_SECONDS * 1.5:
            bottom = self._expanded(card, record, flipped, "bottom")
            lines += bottom
            reading, confidence = pick_number_lines(bottom)
            reading.number_confidence = confidence
            best = better_read(best, reading) if best is not None else reading
        result = best or parse_text([])
        result.lines = [line.text for line in lines]
        result.attempts = reads
        result.strips = record
        return result

    def read(self, card: np.ndarray, *, read_hp: bool = True, flipped: bool | None = None) -> OcrResult:
        """``flipped`` True/False: the picture search already says which way up the card is, so read only that
        way. None: unknown, so try upright first and the turned card when no complete number came out."""
        started = time.monotonic()
        turned = bool(flipped)
        if turned:
            card = np.ascontiguousarray(card[::-1, ::-1])
        self._turned = turned
        result = self._read_card(card)
        if flipped is None and not is_complete(result):
            other = np.ascontiguousarray(card[::-1, ::-1])
            self._turned = not turned
            retry = self._read_card(other)
            if completeness(retry) > completeness(result):
                result, card, turned = retry, other, not turned
            else:
                result.strips += retry.strips
        result.flipped = turned
        if read_hp:
            hp_lines = [line.text for line in self._scan(card, "hp", HP_STRIP, "plain", 2.0, False, result.strips, turned) or []]
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
