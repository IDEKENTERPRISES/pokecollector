"""Candidate lookups from printed text other than the card's name: number/total/set code, and body text.

Two lanes, both pure (no OCR engine, no database; ``build_lookup_index`` is the only database reader):

*Number lane.* OCR reads "017/128" at the bottom of the card and sometimes a set code ("PAL", "SVI").
OCR's own parse can be fooled by what sits next to the number ("30C | 017/128" parses as 30C over 017), so
this lane scans every recognised line for ``number/total`` pairs itself. Each pair is looked up in the card
table: every card with that number whose printed set total matches, narrowed by the set code where the code
maps to a set (the sets table's ``abbreviation``, the TCGdex set id, or the small ``EXTRA_SET_CODES`` table).
Levels, strongest first: ``number_total_set``, ``number_total``, ``number_set``, ``number`` (number alone:
too many cards to add, so it only boosts cards the picture already found).

*Card-text lane.* The card table keeps each card's attack names and effects, ability names and effects and
the trainer effect (TCGdex ``attacks``, ``abilities``, ``effect``), so body text OCR reads can be matched
without any new sync. Sentences are indexed by their rarer words; an OCR line is matched against the best few
sentences by how much of it they contain. A sentence printed on many cards ("You may play only 1 Supporter
card during your turn") proves little, so a line that matches many cards adds nobody and boosts less. The
rule-box wording of "ex" / "GX" / "V" cards ("Pokémon ex rule") is not stored anywhere; it only boosts cards
of that kind that the picture already found.

Neither lane decides alone: ``pipeline.decide`` still needs the picture to agree.
"""

from __future__ import annotations

import difflib
import math
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable

# Printed set codes the sets table may lack: code -> TCGdex set ids. Only promo sets, whose cards print their
# code in front of the number; everything else comes from ``Set.abbreviation`` / ``Set.tcg_set_id``.
EXTRA_SET_CODES = {
    "SVP": ("svp",), "PRSV": ("svp",), "SWSH": ("swshp",), "PRSW": ("swshp",), "SMP": ("smp",), "PRSM": ("smp",),
    "XYP": ("xyp",), "BWP": ("bwp",), "MEP": ("mep",),
}

# Letters that really are part of a printed card number (gallery subsets, promo series, old sets). Any other run of three
# or more letters in front of a number ("PBL039/084") is the set code printed next to it, not part of the number.
NUMBER_PREFIXES = frozenset({
    "TG", "GG", "SV", "RC", "SWSH", "SVP", "SMP", "SM", "XYP", "XY", "BWP", "BW", "DP", "HGSS", "MEP", "SH", "PR", "PRSV", "PRSW", "PRSM",
    "H", "S", "P", "NP", "RT",
})


def is_set_code_prefix(letters: str) -> bool:
    """Letters glued to a number that are a set code, not a number prefix ("PBL" in "PBL039")."""
    letters = str(letters or "").upper()
    return len(letters) >= 3 and letters not in NUMBER_PREFIXES


LEVEL_ORDER = ("number_total_set", "number_total", "number_set", "number")
# How much each level moves a printing up the combined ranking (picture similarity is the base).
LEVEL_BONUS = {"number_total_set": 0.20, "number_total": 0.14, "number_set": 0.10, "number": 0.0}
MAX_ADDED_PER_PAIR = 30  # cards one number/total pair may bring in (a bare number would bring hundreds)
TEXT_WEIGHT = 0.15
RULE_WEIGHT = 0.04
TEXT_ADD_MAX_CARDS = 12  # a sentence printed on more cards than this proves little: it adds nobody
TEXT_MIN_COVERAGE = 0.80  # how much of the shorter of line and sentence must be shared
TEXT_MIN_CHARS = 18
NAME_MIN_CHARS = 6
MAX_TEXT_LINES = 14

_PAIR = re.compile(r"(?<![0-9])([A-Za-z]{0,4}\s?\d{1,3})\s*[/\\]\s*([A-Za-z]{0,4}\s?\d{1,3})(?![0-9])")
_PAIR_BAR = re.compile(r"(?<![0-9A-Za-z])(\d{1,3})\s*\|\s*(\d{2,3})(?![0-9])")
_WORD_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9]{1,5}|[0-9]+[A-Za-z]+[A-Za-z0-9]*")
_RULE = re.compile(r"\b(ex|gx|vmax|vstar|v)\s+rule\b|\bpok.?mon[\s-]+(ex|gx|v)\b.{0,40}\bknocked\s+out", re.IGNORECASE)
_PRIZE_RULE = re.compile(r"knocked\s+out.{0,30}(?:opponent|takes).{0,25}prize", re.IGNORECASE)
_SUFFIXES = ("vstar", "vmax", "gx", "ex", "v")


def _number_key(value: str | None) -> str | None:
    """"017" -> "17", "TG06" -> "TG6", "swsh020" -> "SWSH20" (the same number written differently)."""
    text = re.sub(r"\s+", "", str(value or "")).upper()
    match = re.fullmatch(r"([A-Z]{0,5})0*(\d{1,3})([A-Z]?)", text)
    if not match:
        return None
    return f"{match.group(1)}{match.group(2)}{match.group(3)}"


def _total_key(value) -> str | None:
    """A printed total as digits ("128", "TG30" -> "30"); None when it is not a plain size."""
    text = re.sub(r"\s+", "", str(value or "")).upper()
    match = re.fullmatch(r"(?:TG|GG|SV|RC)?0*(\d{1,4})", text)
    return match.group(1) if match else None


def norm_text(text: str) -> str:
    """Lower case, accents and punctuation gone, single spaces: the comparable form of body text."""
    text = unicodedata.normalize("NFKD", str(text or "")).casefold()
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text)).strip()


# ── Reading the identifiers out of OCR lines ────────────────────────────────

def number_pairs(lines: Iterable[str], parsed_number: str | None = None, parsed_total: str | None = None) -> list[tuple[str, str | None]]:
    """Every "number/total" pair the recognised text holds, as (number, total); ``(number, None)`` for a bare
    promo number. OCR's own parse comes first (it knows where the number sits), then each pair found in the lines."""
    pairs: list[tuple[str, str | None]] = []

    def add(number, total):
        key = _number_key(number)
        if key is None:
            return
        total_key = _total_key(total) if total else None
        letters = re.match(r"[A-Z]*", key).group(0)
        if is_set_code_prefix(letters):  # "PBL039": the letters are a set code, so look the bare number up as well
            bare = (key[len(letters):], total_key)
            if bare not in pairs:
                pairs.append(bare)
        pair = (key, total_key)
        if pair not in pairs:
            pairs.append(pair)

    if parsed_number:
        add(parsed_number, parsed_total)
    for line in lines:
        text = str(line or "")
        if text.startswith("[hp]"):
            continue
        for match in _PAIR.finditer(text):
            add(match.group(1), match.group(2))
        for match in _PAIR_BAR.finditer(text):  # a slash read as a bar
            add(match.group(1), match.group(2))
    return pairs


def set_code_tokens(tokens: Iterable[str], lines: Iterable[str] = ()) -> list[str]:
    """Upper-case words that could be a printed set code (they hold a letter)."""
    out: list[str] = []
    for token in list(tokens) + [t for line in lines for t in _WORD_TOKEN.findall(str(line or "").upper())]:
        token = str(token).upper()
        if re.search(r"[A-Z]", token) and 2 <= len(token) <= 6 and token not in out:
            out.append(token)
        glued = re.fullmatch(r"([A-Z]{2,5})\d{1,3}[A-Z]?", token)  # "PBL039": the set code in front of the number
        if glued and glued.group(1) not in out:
            out.append(glued.group(1))
    return out


# ── The catalogue side ───────────────────────────────────────────────────────

@dataclass
class LookupRow:
    card_id: str
    name: str
    number: str | None
    printed_total: str | None
    set_id: str | None = None
    suffix: str | None = None
    texts: list[tuple[str, str]] = field(default_factory=list)  # (kind "name" | "effect", text)


@dataclass
class NumberHit:
    card_id: str
    level: str
    pair: tuple[str, str | None]


@dataclass
class TextHit:
    score: float  # 0..1: how much of the matched line the card's own text contains, scaled by how specific it is
    cards: int  # how many cards print that text
    via: str  # "effect" | "name"


@dataclass
class LookupEvidence:
    """What the two lanes found for one photo."""
    numbers: dict[str, NumberHit] = field(default_factory=dict)
    text: dict[str, TextHit] = field(default_factory=dict)
    rule_kinds: set[str] = field(default_factory=set)
    suffix_of: dict[str, str | None] = field(default_factory=dict)
    set_codes: list[str] = field(default_factory=list)  # tokens that map to a set
    pairs: list[tuple[str, str | None]] = field(default_factory=list)

    def empty(self) -> bool:
        return not (self.numbers or self.text or self.rule_kinds)

    def add_ids(self) -> list[str]:
        """Cards worth bringing into the candidate list even when the picture search missed them."""
        out = [h.card_id for h in self.numbers.values() if h.level != "number"]
        out += [card_id for card_id, hit in self.text.items() if hit.cards <= TEXT_ADD_MAX_CARDS]
        return list(dict.fromkeys(out))

    def number_bonus(self, card_id: str) -> float:
        hit = self.numbers.get(card_id)
        return LEVEL_BONUS[hit.level] if hit else 0.0

    def bonus(self, card_id: str, *, number: bool = True) -> float:
        """The lookup's boost for one card; ``number=False`` leaves the number lane's part out (it is counted elsewhere)."""
        total = self.number_bonus(card_id) if number else 0.0
        text = self.text.get(card_id)
        if text:
            total += TEXT_WEIGHT * text.score
        if self.rule_kinds and self.suffix_of.get(card_id) in self.rule_kinds:
            total += RULE_WEIGHT
        return total

    def level_of(self, card_id: str) -> str | None:
        hit = self.numbers.get(card_id)
        return hit.level if hit else None

    def unique_at_or_above(self, level: str) -> int:
        """How many cards were found at ``level`` or a stronger one."""
        limit = LEVEL_ORDER.index(level)
        return sum(1 for h in self.numbers.values() if LEVEL_ORDER.index(h.level) <= limit)

    def trace(self) -> dict:
        return {
            "pairs": [list(pair) for pair in self.pairs[:4]], "set_codes": self.set_codes[:3],
            "number_hits": {level: sum(1 for h in self.numbers.values() if h.level == level) for level in LEVEL_ORDER if any(h.level == level for h in self.numbers.values())},
            "text_hits": {card_id: [round(h.score, 3), h.cards, h.via] for card_id, h in list(self.text.items())[:5]},
            "rule": sorted(self.rule_kinds),
        }


def _suffix_of(name: str, suffix: str | None) -> str | None:
    tail = norm_text(suffix or name).split(" ")[-1] if (suffix or name) else ""
    return tail if tail in _SUFFIXES else None


class LookupIndex:
    def __init__(self, rows: Iterable[LookupRow], set_codes: dict[str, Iterable[str]] | None = None) -> None:
        """``set_codes``: upper-case printed code -> set ids, from the sets table."""
        self.rows: dict[str, LookupRow] = {}
        self._by_number: dict[str, list[str]] = {}
        self.set_codes: dict[str, set[str]] = {code.upper(): set(ids) for code, ids in (set_codes or {}).items()}
        for code, ids in EXTRA_SET_CODES.items():
            self.set_codes.setdefault(code, set()).update(ids)
        self._suffix: dict[str, str | None] = {}
        self._segments: list[str] = []
        self._segment_cards: list[set[str]] = []
        self._segment_kind: list[str] = []
        self._token_segments: dict[str, set[int]] = {}
        self._name_buckets: dict[int, list[int]] = {}
        seen: dict[tuple[str, str], int] = {}
        for row in rows:
            self.rows[row.card_id] = row
            key = _number_key(row.number)
            if key:
                self._by_number.setdefault(key, []).append(row.card_id)
            self._suffix[row.card_id] = _suffix_of(row.name, row.suffix)
            for kind, text in row.texts:
                normal = norm_text(text)
                if len(normal) < (NAME_MIN_CHARS if kind == "name" else TEXT_MIN_CHARS):
                    continue
                segment = seen.get((kind, normal))
                if segment is None:
                    segment = len(self._segments)
                    seen[(kind, normal)] = segment
                    self._segments.append(normal)
                    self._segment_cards.append(set())
                    self._segment_kind.append(kind)
                    if kind == "name":
                        self._name_buckets.setdefault(len(normal), []).append(segment)
                    else:
                        for token in set(normal.split()):
                            if len(token) >= 4:
                                self._token_segments.setdefault(token, set()).add(segment)
                self._segment_cards[segment].add(row.card_id)
        total = max(1, len(self._segments))
        # Words on a fifth of all sentences carry no information ("your", "this", "card").
        self._idf = {token: math.log(total / len(ids)) for token, ids in self._token_segments.items() if len(ids) <= 0.2 * total}

    def __len__(self) -> int:
        return len(self.rows)

    # -- number lane --

    def sets_for_codes(self, tokens: Iterable[str]) -> tuple[set[str], list[str]]:
        found: set[str] = set()
        used: list[str] = []
        for token in tokens:
            ids = self.set_codes.get(str(token).upper())
            if ids:
                found |= ids
                used.append(str(token).upper())
        return found, used

    def find_numbers(self, pairs: list[tuple[str, str | None]], tokens: Iterable[str] = ()) -> tuple[dict[str, NumberHit], list[str]]:
        """Cards carrying a read number, at the strongest level each reaches. A total that was read and
        disagrees removes the card from the strong levels (it can still be a number-only boost)."""
        set_ids, used_codes = self.sets_for_codes(tokens)
        hits: dict[str, NumberHit] = {}

        def put(card_id: str, level: str, pair):
            old = hits.get(card_id)
            if old is None or LEVEL_ORDER.index(level) < LEVEL_ORDER.index(old.level):
                hits[card_id] = NumberHit(card_id, level, pair)

        for pair in pairs:
            number, total = pair
            ids = self._by_number.get(number, [])
            strong: list[tuple[str, str]] = []
            for card_id in ids:
                row = self.rows[card_id]
                in_set = bool(set_ids) and row.set_id in set_ids
                printed = _total_key(row.printed_total)
                total_ok = bool(total) and printed is not None and printed == total
                if total_ok and in_set:
                    strong.append((card_id, "number_total_set"))
                elif total_ok:
                    strong.append((card_id, "number_total"))
                elif in_set and not total:
                    strong.append((card_id, "number_set"))
                else:
                    put(card_id, "number", pair)
            if len(strong) > MAX_ADDED_PER_PAIR:  # a bare number or a very common one: keep as boosts only
                for card_id, _level in strong:
                    put(card_id, "number", pair)
                continue
            for card_id, level in strong:
                put(card_id, level, pair)
        return hits, used_codes

    # -- card-text lane --

    def find_text(self, lines: Iterable[str]) -> tuple[dict[str, TextHit], set[str]]:
        """(card id -> best text match, rule kinds named such as {"ex"}) for OCR'd body text."""
        hits: dict[str, TextHit] = {}
        rules: set[str] = set()
        joined = " ".join(str(line or "") for line in lines if not str(line or "").startswith("[hp]"))
        for match in _RULE.finditer(joined):
            kind = (match.group(1) or match.group(2) or "").lower()
            if kind:
                rules.add(kind)
        if _PRIZE_RULE.search(joined):
            rules.add("ex")
        used = 0
        for line in lines:
            line = str(line or "")
            if line.startswith("[hp]") or used >= MAX_TEXT_LINES:
                continue
            normal = norm_text(line)
            if len(normal) < NAME_MIN_CHARS:
                continue
            used += 1
            found = self._match_effect(normal) if len(normal) >= TEXT_MIN_CHARS else []
            found += self._match_name(re.sub(r"\b\d+\b", " ", normal).strip())
            for score, segment, via in found:
                cards = self._segment_cards[segment]
                spec = 1.0 if len(cards) <= 6 else 6.0 / len(cards)
                for card_id in cards:
                    value = score * spec
                    old = hits.get(card_id)
                    if old is None:
                        hits[card_id] = TextHit(value, len(cards), via)
                    else:  # a second agreeing line adds a little
                        hits[card_id] = TextHit(min(1.0, max(old.score, value) + 0.15 * min(old.score, value)), min(old.cards, len(cards)), via)
        return hits, rules

    def _match_effect(self, normal: str) -> list[tuple[float, int, str]]:
        tokens = {t for t in normal.split() if len(t) >= 4 and t in self._idf}
        if len(tokens) < 2:
            return []
        votes: dict[int, float] = {}
        for token in tokens:
            for segment in self._token_segments[token]:
                if self._segment_kind[segment] == "effect":
                    votes[segment] = votes.get(segment, 0.0) + self._idf[token]
        out = []
        matcher = difflib.SequenceMatcher(None, autojunk=False)
        matcher.set_seq2(normal)
        for segment in sorted(votes, key=lambda s: -votes[s])[:6]:
            text = self._segments[segment]
            matcher.set_seq1(text)
            shared = sum(block.size for block in matcher.get_matching_blocks() if block.size >= 3)
            coverage = shared / max(1, min(len(text), len(normal)))
            if coverage >= TEXT_MIN_COVERAGE:
                out.append((coverage, segment, "effect"))
        return out

    def _match_name(self, normal: str) -> list[tuple[float, int, str]]:
        """An attack or ability name: the whole cleaned line is (nearly) the name."""
        if len(normal) < NAME_MIN_CHARS or len(normal.split()) > 4:
            return []
        out = []
        for length in range(len(normal) - 2, len(normal) + 3):
            for segment in self._name_buckets.get(length, ()):
                text = self._segments[segment]
                if text == normal:
                    out.append((1.0, segment, "name"))
                elif text[0] == normal[0] and difflib.SequenceMatcher(None, text, normal, autojunk=False).ratio() >= 0.9:
                    out.append((0.9, segment, "name"))
        return out

    # -- both lanes --

    def search(self, lines: list[str], parsed_number: str | None, parsed_total: str | None, tokens: Iterable[str], *, number: bool = True, text: bool = True) -> LookupEvidence:
        evidence = LookupEvidence()
        if number:
            evidence.pairs = number_pairs(lines, parsed_number, parsed_total)
            candidates = set_code_tokens(tokens, lines)
            evidence.numbers, evidence.set_codes = self.find_numbers(evidence.pairs, candidates)
        if text:
            evidence.text, evidence.rule_kinds = self.find_text(lines)
        evidence.suffix_of = self._suffix  # shared, read-only
        return evidence


def _sentences(text: str | None) -> list[str]:
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+|\n+", str(text or "")) if part.strip()]


def card_texts(card_effect, attacks, abilities) -> list[tuple[str, str]]:
    """(kind, text) for every searchable piece of a card: attack and ability names, effect sentences."""
    out: list[tuple[str, str]] = []
    for sentence in _sentences(card_effect):
        out.append(("effect", sentence))
    for group in (attacks, abilities):
        for item in group if isinstance(group, list) else []:
            if not isinstance(item, dict):
                continue
            if item.get("name"):
                out.append(("name", str(item["name"])))
            for sentence in _sentences(item.get("effect")):
                out.append(("effect", sentence))
    return out


def build_lookup_index(session_factory, card_ids: Iterable[str]) -> LookupIndex:
    """Lookup rows for the indexed cards, from the local card table (read-only)."""
    from models import Card, Set

    wanted = set(card_ids)
    db = session_factory()
    try:
        totals: dict[tuple, int | None] = {}
        codes: dict[str, set[str]] = {}
        for row in db.query(Set.tcg_set_id, Set.lang, Set.printed_total, Set.abbreviation):
            totals[(row.tcg_set_id, row.lang)] = row.printed_total
            for code in (row.abbreviation, row.tcg_set_id):
                if code:
                    codes.setdefault(str(code).upper(), set()).add(row.tcg_set_id)
        rows = []
        for card in db.query(Card.id, Card.name, Card.number, Card.set_id, Card.lang, Card.suffix, Card.card_effect, Card.attacks, Card.abilities):
            if card.id not in wanted or not card.name:
                continue
            total = totals.get((card.set_id, card.lang or "en"))
            rows.append(LookupRow(
                card_id=card.id, name=card.name, number=card.number, printed_total=str(total) if total else None,
                set_id=card.set_id, suffix=card.suffix, texts=card_texts(card.card_effect, card.attacks, card.abilities),
            ))
        return LookupIndex(rows, codes)
    finally:
        db.close()


_cache: dict = {}


def get_lookup_index(session_factory, index) -> LookupIndex:
    """The lookup index for a picture index, built once per index build."""
    key = (id(index), len(index))
    cached = _cache.get("value")
    if cached and cached[0] == key:
        return cached[1]
    value = build_lookup_index(session_factory, index.card_ids)
    _cache["value"] = (key, value)
    return value
