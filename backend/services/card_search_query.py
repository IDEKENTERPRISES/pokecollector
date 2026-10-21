"""Smart card search: free text such as "Morpeko 117 PBL" and fuzzy name correction.

The query is split into tokens that can come in any order:
  - a number token ("117", "017", "117/185", "TG12", "SV049"),
  - a set token (a set abbreviation, TCGdex set id, or the full set name),
  - the rest, which is the name query.

If the name query finds nothing, the closest known name (a Pokémon species or a card
name) is used instead, with strict limits so a correct name is never "fixed".
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

from sqlalchemy import func
from sqlalchemy.orm import Session

from models import Card
from services.pokedex import load_pokedex
from services.text_search import strip_diacritics

_NUMBER_RE = re.compile(r"^(?:\d{1,4}|[a-z]{1,4}\d{1,3})(?:/[a-z0-9]+)?$", re.IGNORECASE)
_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)
MIN_PREFIX_LENGTH = 4


def normalize_words(text: str | None) -> list[str]:
    """Accent- and case-insensitive alphanumeric words ("Poké Ball" -> ["poke", "ball"])."""
    return _WORD_RE.findall(strip_diacritics(text))


def normalize_name(text: str | None) -> str:
    return " ".join(normalize_words(text))


@dataclass
class SetIndex:
    """Visible sets keyed for lookups. Each key maps to the set of TCGdex set ids."""

    codes: dict[str, set[str]] = field(default_factory=dict)  # abbreviation, tcg_set_id, id
    names: dict[str, set[str]] = field(default_factory=dict)  # normalised full name

    @classmethod
    def from_sets(cls, sets) -> "SetIndex":
        index = cls()
        for item in sets:
            tcg_id = getattr(item, "tcg_set_id", None) or getattr(item, "id", None)
            if not tcg_id:
                continue
            for code in (getattr(item, "abbreviation", None), getattr(item, "tcg_set_id", None), getattr(item, "id", None)):
                key = "".join(normalize_words(code))
                if key:
                    index.codes.setdefault(key, set()).add(tcg_id)
            name = normalize_name(getattr(item, "name", None))
            if name:
                index.names.setdefault(name, set()).add(tcg_id)
        return index


@lru_cache(maxsize=1)
def species_display() -> dict[str, str]:
    names: dict[str, str] = {}
    for entry in load_pokedex():
        for key in ("name_en", "name_de"):
            printed = entry.get(key)
            normalized = normalize_name(printed)
            if normalized and normalized not in names:
                names[normalized] = printed
    return names


def species_names() -> frozenset[str]:
    return frozenset(species_display())


@lru_cache(maxsize=1)
def species_words() -> frozenset[str]:
    return frozenset(word for name in species_display() for word in name.split())


@dataclass
class ParsedQuery:
    name: str = ""
    set_ids: set[str] = field(default_factory=set)
    number: str = ""
    changed: bool = False  # a set or number was recognised


def parse_query(text: str, index: SetIndex, name_words: frozenset[str] | None = None) -> ParsedQuery:
    """Split a free-text query into a name, set ids and a card number.

    A word that is also a Pokémon name is never read as a set code ("Mew ex" stays a name
    search although MEW is a set), and a set can never be the whole query.
    """
    words = text.split()
    known_words = species_words() | (name_words or frozenset())
    keyed = [(word, "".join(normalize_words(word))) for word in words]
    used = [False] * len(words)
    set_ids: set[str] = set()

    # 1. Full set names, longest runs first ("Vivid Voltage").
    normalized_tokens = [normalize_name(word) for word in words]
    for size in range(min(len(words), 6), 0, -1):
        for start in range(0, len(words) - size + 1):
            if any(used[start:start + size]) or set_ids:
                continue
            if size == len(words):
                continue  # a set cannot be the whole query
            run = " ".join(token for token in normalized_tokens[start:start + size] if token)
            matches = index.names.get(run)
            if not matches:
                continue
            if size == 1 and run in known_words:
                continue
            set_ids = set(matches)
            for position in range(start, start + size):
                used[position] = True

    # 2. A set abbreviation or id.
    if not set_ids:
        for position, (_, key) in enumerate(keyed):
            if used[position] or not key or key in known_words or len(words) == 1:
                continue
            matches = index.codes.get(key)
            if matches:
                set_ids = set(matches)
                used[position] = True
                break

    # 3. A unique prefix of a set name (4+ characters) that no Pokémon name starts with.
    if not set_ids and len(words) > 1:
        for position, (_, key) in enumerate(keyed):
            if used[position] or len(key) < MIN_PREFIX_LENGTH or key in known_words:
                continue
            if any(name.startswith(key) for name in species_display()):
                continue
            prefixed = [ids for name, ids in index.names.items() if name.startswith(key)]
            if len(prefixed) == 1:
                set_ids = set(prefixed[0])
                used[position] = True
                break

    # 4. A number.
    number = ""
    for position, word in enumerate(words):
        if used[position] or not _NUMBER_RE.match(word):
            continue
        # "Pokémon 3" style names are rare; the caller falls back to the plain name search.
        number = word.split("/")[0]
        used[position] = True
        break

    name = " ".join(word for position, word in enumerate(words) if not used[position])
    return ParsedQuery(name=name, set_ids=set_ids, number=number, changed=bool(set_ids or number))


# ── Fuzzy names ──────────────────────────────────────────────────────────────

def max_edits(length: int) -> int:
    """Typos allowed for a name of this length: none up to 4 letters, 1 for 5-7, 2 from 8."""
    if length <= 4:
        return 0
    if length <= 7:
        return 1
    return 2


def edit_distance(a: str, b: str, limit: int) -> int:
    """Damerau-Levenshtein (optimal string alignment), or limit+1 when it exceeds the limit."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    previous2: list[int] | None = None
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            value = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            if previous2 is not None and i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                value = min(value, previous2[j - 2] + 1)
            current[j] = value
        if min(current) > limit:
            return limit + 1
        previous2, previous = previous, current
    return previous[-1]


_card_names_cache: dict[str, object] = {"signature": None, "names": {}}


def card_names(db: Session) -> dict[str, str]:
    """Distinct catalogue card names (normalised -> as printed), rebuilt when the card count changes."""
    signature = db.query(func.count(Card.id)).filter(Card.is_custom == False).scalar()  # noqa: E712
    if _card_names_cache["signature"] != signature:
        rows = db.query(Card.name).filter(Card.is_custom == False).distinct().all()  # noqa: E712
        names: dict[str, str] = {}
        for (printed,) in rows:
            key = normalize_name(printed)
            if key and key not in names:
                names[key] = printed
        _card_names_cache["names"] = names
        _card_names_cache["signature"] = signature
    return _card_names_cache["names"]  # type: ignore[return-value]


def reset_card_names_cache() -> None:
    _card_names_cache["signature"] = None
    _card_names_cache["names"] = {}


def suggest_names(db: Session, query: str) -> list[str]:
    """Candidate corrections for a misspelt name, best first, within the strict limits.

    Returns nothing when the query is already a known name, or when two different names tie
    (species names win a tie against card names).
    """
    normalized = normalize_name(query)
    limit = max_edits(len(normalized))
    if not normalized or limit == 0:
        return []
    species = species_display()
    catalogue = card_names(db)
    if normalized in species or normalized in catalogue:
        return []

    best = limit + 1
    found: dict[str, int] = {}
    for candidate in {**catalogue, **species}:
        distance = edit_distance(normalized, candidate, limit)
        if distance > limit:
            continue
        found[candidate] = distance
        best = min(best, distance)
    closest = [name for name, distance in found.items() if distance == best]
    if not closest:
        return []
    if len(closest) > 1:
        closest_species = [name for name in closest if name in species]
        if len(closest_species) != 1:
            return []
        closest = closest_species
    return [species.get(name) or catalogue[name] for name in closest]
