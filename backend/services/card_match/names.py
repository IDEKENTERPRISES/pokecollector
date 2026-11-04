"""Read the card's name and look it up in the local card list, without a vision model.

Today's Ollama path reads a name and a number with a vision model and then searches the card table by
name. The same lookup here starts from the name line OCR reads at the top of the flattened card. OCR
damages names ("Charizrd ex", "Boss's Orders"), so the lookup is fuzzy: the read name is compared with
every distinct catalogue name and the printings of the close ones become *text candidates*, filtered or
boosted by the number and printed total read at the bottom. The pipeline merges them with the picture
top 20 (``pipeline.CardMatcher``).

Name normalising and comparing reuses ``api.recognize`` (``_name_search_key``, ``_simplify_name``,
``_scanner_names_compatible``): the same rules that decide whether a read name and a catalogue name
are the same card on the Ollama path. ``parse_name_lines`` and ``NameIndex`` are pure (no OCR engine,
no database) so tests need neither.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field
from typing import Iterable

# Strip of the flat card read for the name and HP in one pass (fractions of the picture).
NAME_STRIP = (0.03, 0.02, 1.0, 0.15)
NAME_ZOOM = 2.0
NAME_MIN_SCORE = 0.72  # fuzzy name similarity needed to bring a catalogue name in
NAME_CLOSE_BAND = 0.12  # names this close to the best score come in too
MAX_NAMES = 8
MAX_TEXT_CANDIDATES = 200

# Words printed near the name that are not part of it.
_STAGE_WORDS = re.compile(
    r"^(?:basic|stage\s*[12]|stage|restored|mega|vmax\s*climax|baby|level\s*up|item|supporter|stadium|"
    r"trainer|pok[eé]mon\s*tool|tool|ace\s*spec|technical\s*machine|energy|special\s*energy)\b[\s:.\-]*",
    re.IGNORECASE,
)
_EVOLVES = re.compile(r"\b(?:evolves?\s+from|put\s+on|stage\s*[12]\b).*$", re.IGNORECASE)
_HP_TAIL = re.compile(r"\s*(?:\b(?:hp|pv|kp|ps|pf)\s*\d{2,3}|\d{2,3}\s*hp)\b.*$", re.IGNORECASE)
_NOT_NAME_CHARS = re.compile(r"[^A-Za-zÀ-ɏ0-9 '’&.\-:♀♂]")
_LETTERS = re.compile(r"[A-Za-zÀ-ɏ]")


@dataclass
class NameRead:
    name: str | None = None
    raw: list[str] = field(default_factory=list)  # the recognised lines, for diagnostics
    hp: str | None = None


def clean_name_line(text: str) -> str:
    """One recognised line -> the part that can be a card name ('' when none)."""
    text = _HP_TAIL.sub("", str(text or "")).strip()
    text = _EVOLVES.sub("", text).strip()
    for _ in range(2):  # "BASIC" then another label
        stripped = _STAGE_WORDS.sub("", text).strip()
        if stripped == text:
            break
        text = stripped
    text = _NOT_NAME_CHARS.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip(" .:-'")
    # Energy symbols read as stray digits or single letters at the end ("Pikachu 0", "Pikachu G").
    text = re.sub(r"\s+(?:\d{1,2}|[A-Z])$", "", text) if len(text) > 4 and re.search(r"[a-z]{3}", text) else text
    return text if len(_LETTERS.findall(text)) >= 2 else ""


def parse_name_lines(items: Iterable) -> NameRead:
    """Pick the card name from what OCR read in the top strip.

    ``items`` are strings, or ``(text, height)`` pairs: the name is printed in the biggest type of the
    strip, so with heights the tallest plausible line wins; without them the longest plausible line does.
    The same lines give the HP ("HP 70") when it is there.
    """
    from . import ocr

    entries: list[tuple[str, float | None]] = []
    for item in items:
        text, height = (item if isinstance(item, tuple) else (item, None))
        entries.append((str(text or ""), height))
    raw = [text for text, _height in entries]
    result = NameRead(raw=raw, hp=ocr.find_hp("  ".join(raw)))
    best: tuple[float, str] | None = None
    for text, height in entries:
        cleaned = clean_name_line(text)
        if not cleaned:
            continue
        score = (height or 0.0) * 10 + len(cleaned)
        if best is None or score > best[0]:
            best = (score, cleaned)
    result.name = best[1] if best else None
    return result


# ── The catalogue side ────────────────────────────────────────────────────────

@dataclass
class NameRow:
    card_id: str
    name: str
    number: str | None
    printed_total: str | None
    key: str = ""
    base_key: str = ""


@dataclass
class TextHit:
    card_id: str
    name_score: float  # 0..1 (1 = the same name)
    number_ok: bool | None  # True / False when a number was read, None when not
    total_ok: bool | None


def name_key(name: str) -> str:
    """Case, accent and separator free form of a name (the Ollama path's own key, lower-cased)."""
    from api import recognize as rules

    return rules._name_search_key(rules._normalized_scanner_name(name)).casefold()


def base_key(name: str) -> str:
    """The key without a trailing card-type suffix (ex, V, GX ...), so "Charizrd" still finds "Charizard ex"."""
    from api import recognize as rules

    return name_key(rules._simplify_name(rules._normalized_scanner_name(name)))


def _ratio(matcher: "difflib.SequenceMatcher", other: str) -> float:
    """Similarity of ``other`` to the matcher's second sequence (set once; the first changes per call)."""
    if not other:
        return 0.0
    matcher.set_seq1(other)
    if matcher.real_quick_ratio() < 0.6 or matcher.quick_ratio() < 0.6:
        return 0.0
    return matcher.ratio()


def _similar(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    matcher = difflib.SequenceMatcher(None, left, right, autojunk=False)
    if matcher.real_quick_ratio() < 0.6 or matcher.quick_ratio() < 0.6:
        return 0.0
    return matcher.ratio()


class NameIndex:
    """Every indexed card's name, number and printed total, searchable by a damaged name."""

    def __init__(self, rows: Iterable[NameRow]) -> None:
        self.rows: dict[str, NameRow] = {}
        self._by_key: dict[str, list[str]] = {}
        for row in rows:
            row.key = row.key or name_key(row.name)
            row.base_key = row.base_key or base_key(row.name)
            self.rows[row.card_id] = row
            self._by_key.setdefault(row.key, []).append(row.card_id)

    def __len__(self) -> int:
        return len(self.rows)

    def row(self, card_id: str) -> NameRow | None:
        return self.rows.get(card_id)

    def score_names(self, read_name: str) -> list[tuple[float, str]]:
        """(score, name key) of the catalogue names close to the read name, best first."""
        read_key, read_base = name_key(read_name), base_key(read_name)
        if not read_key:
            return []
        full = difflib.SequenceMatcher(None, autojunk=False)
        full.set_seq2(read_key)
        base = difflib.SequenceMatcher(None, autojunk=False)
        base.set_seq2(read_base or read_key)
        scored = []
        for key, ids in self._by_key.items():
            if key == read_key:
                scored.append((1.0, key))
                continue
            if abs(len(key) - len(read_key)) > 0.5 * max(len(key), len(read_key)) and abs(len(self.rows[ids[0]].base_key) - len(read_base)) > 0.5 * max(len(read_base), 1):
                continue
            score = max(_ratio(full, key), 0.97 * _ratio(base, self.rows[ids[0]].base_key))
            if score >= NAME_MIN_SCORE:
                scored.append((score, key))
        scored.sort(key=lambda item: -item[0])
        return scored

    def search(self, read_name: str | None, number: str | None = None, total: str | None = None, *, limit: int = MAX_TEXT_CANDIDATES) -> list[TextHit]:
        """Printings of the catalogue names close to ``read_name``, best name first; with a number read, the
        printings that carry it come before the others."""
        if not read_name:
            return []
        scored = self.score_names(read_name)
        if not scored:
            return []
        floor = scored[0][0] - NAME_CLOSE_BAND
        hits: list[TextHit] = []
        for score, key in scored[:MAX_NAMES]:
            if score < floor:
                break
            for card_id in self._by_key[key]:
                hits.append(self.agreement(card_id, score, number, total))
        hits.sort(key=lambda hit: (-hit.name_score, hit.number_ok is not True, hit.total_ok is False))
        if number:
            with_number = [hit for hit in hits if hit.number_ok]
            if with_number:  # the printings that do not carry the read number only fill the space left
                rest = [hit for hit in hits if not hit.number_ok]
                hits = with_number + rest
        return hits[:limit]

    def agreement(self, card_id: str, name_score: float, number: str | None, total: str | None) -> TextHit:
        """How a catalogue card agrees with the number and total read at the bottom."""
        from api import recognize as rules

        row = self.rows[card_id]
        number_ok = rules._numbers_match(number, row.number) if number else None
        total_ok = None
        if total and row.printed_total:
            read, printed = rules._normalize_printed_total(total), rules._normalize_printed_total(row.printed_total)
            total_ok = read is not None and read == printed
        return TextHit(card_id=card_id, name_score=name_score, number_ok=number_ok, total_ok=total_ok)

    def name_score_of(self, card_id: str, read_name: str | None) -> float:
        """How well one card's name matches the read name (0 when nothing was read)."""
        from api import recognize as rules

        row = self.rows.get(card_id)
        if row is None or not read_name:
            return 0.0
        if rules._scanner_names_compatible(read_name, row.name):
            return 1.0
        score = max(_similar(name_key(read_name), row.key), 0.97 * _similar(base_key(read_name), row.base_key))
        return score if score >= NAME_MIN_SCORE else 0.0


def build_name_index(session_factory, card_ids: Iterable[str]) -> NameIndex:
    """Name rows for the indexed cards, from the local card table (read-only)."""
    from models import Card, Set

    wanted = set(card_ids)
    db = session_factory()
    try:
        totals = {}
        for row in db.query(Set.tcg_set_id, Set.lang, Set.printed_total):
            totals[(row.tcg_set_id, row.lang)] = row.printed_total
        rows = []
        for card in db.query(Card.id, Card.name, Card.number, Card.set_id, Card.lang):
            if card.id not in wanted or not card.name:
                continue
            total = totals.get((card.set_id, card.lang or "en"))
            rows.append(NameRow(card_id=card.id, name=card.name, number=card.number, printed_total=str(total) if total else None))
        return NameIndex(rows)
    finally:
        db.close()


_cache: dict = {}


def get_name_index(session_factory, index) -> NameIndex:
    """The name index for a picture index, built once per index build."""
    key = (id(index), len(index))
    cached = _cache.get("value")
    if cached and cached[0] == key:
        return cached[1]
    value = build_name_index(session_factory, index.card_ids)
    _cache["value"] = (key, value)
    return value
