"""Read the printed number against the candidates, instead of trusting free OCR alone.

Free OCR on the tiny bottom line often gets most of "125/197" right and then loses a digit ("25/197",
"12/13" for "112/113") or reads the slash as a 1 or a 7 ("69197" for "69/97"). The picture search has
already narrowed the card to 20 printings whose real number and printed total are known, so instead of
asking "what does this text say" we ask "which of these 20 printings is this text a damaged copy of".
A printing is accepted only when the text matches its "number/total" with at most a couple of edits
(more edits only allowed for longer patterns), and no other printing matches as well. Pure functions: no
OCR engine and no database needed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Characters OCR mixes up with digits, turned into digits before matching. The slash itself is kept.
_LOOKALIKE = str.maketrans({"O": "0", "o": "0", "D": "0", "Q": "0", "I": "1", "l": "1", "|": "/", "\\": "/", "S": "5", "B": "8", "Z": "2"})
_SLASH_MISREADS = ("/", "1", "7", "")  # the separator as printed, then as it is often misread (or lost)
MISREAD_PENALTY = 0.5


@dataclass
class ConstrainedRead:
    index: int  # position in the candidate list
    number: str  # the candidate's real number
    total: str | None  # the candidate's real printed total
    distance: float
    runner_up: float | None  # distance of the next printing with a different number/total (None = no other)


def _digits(value) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _prepare(lines: list[str]) -> str:
    """The recognised lines as one string of digits, slashes and spaces."""
    parts = []
    for line in lines:
        text = str(line).translate(_LOOKALIKE)
        parts.append(re.sub(r"[^0-9/]", " ", text))
    return " ".join(parts)


def _best_substring_distance(pattern: str, text: str, limit: int) -> int | None:
    """Fewest edits to turn some substring of ``text`` into ``pattern`` (Sellers), or None above ``limit``."""
    if not pattern:
        return None
    previous = list(range(len(pattern) + 1))  # a match may start anywhere: column 0 costs nothing along the text
    best = previous[-1]
    for char in text:
        current = [0]
        for j, expected in enumerate(pattern, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (0 if char == expected else 1)))
        previous = current
        best = min(best, previous[-1])
    return best if best <= limit else None


def _allowed_edits(number: str, total: str) -> int:
    size = len(number) + len(total)
    if size >= 6:
        return 2
    if size >= 4:
        return 1
    return 0


def _forms(value: str) -> list[str]:
    value = value.lstrip("0") or "0"
    return list(dict.fromkeys([value, value.zfill(3)]))


def pattern_distance(number, total, text: str) -> float | None:
    """How far ``text`` is from this printing's "number/total"; None when it is not close enough."""
    n, t = _digits(number), _digits(total)
    if not n or not t:
        return None
    limit = _allowed_edits(n.lstrip("0") or "0", t.lstrip("0") or "0")
    best: float | None = None
    for number_form in _forms(n):
        for total_form in _forms(t):
            for sep in _SLASH_MISREADS:
                distance = _best_substring_distance(f"{number_form}{sep}{total_form}", text, limit + 1)
                if distance is None:
                    continue
                score = distance + (0 if sep == "/" else MISREAD_PENALTY)
                if score <= limit and (best is None or score < best):
                    best = score
    return best


def constrain(lines: list[str], candidates: list[dict]) -> ConstrainedRead | None:
    """The one candidate whose number/total the recognised text is a (damaged) copy of, or None.

    ``candidates`` carry ``number`` and ``printed_total``. Alphabetic gallery numbers (TG06, SWSH062) are
    not handled here: only plain numeric "n/total" printings take part.
    """
    text = _prepare(lines)
    if not re.search(r"\d", text):
        return None
    scored: list[tuple[float, int, str, str | None]] = []
    for position, candidate in enumerate(candidates):
        number, total = candidate.get("number"), candidate.get("printed_total")
        if not re.fullmatch(r"\d+", str(number or "")) or not _digits(total):
            continue
        distance = pattern_distance(number, total, text)
        if distance is not None:
            scored.append((distance, position, str(number), str(total)))
    if not scored:
        return None
    scored.sort(key=lambda item: (item[0], item[1]))
    best = scored[0]
    # Printings that print the same number and total are one answer as far as the text goes; the picture
    # (or another rule) has to separate them, so the read is withheld.
    others = [item for item in scored[1:] if (_digits(item[2]).lstrip("0"), _digits(item[3]).lstrip("0")) != (_digits(best[2]).lstrip("0"), _digits(best[3]).lstrip("0"))]
    same_text = [item for item in scored[1:] if item not in others]
    if same_text:
        return None
    runner_up = others[0][0] if others else None
    if runner_up is not None and runner_up <= best[0] + MISREAD_PENALTY:
        return None  # no clear winner
    return ConstrainedRead(index=best[1], number=best[2], total=best[3], distance=best[0], runner_up=runner_up)
