"""photo -> find the card -> embed (0 and 180 degrees) -> top 20 pictures -> read the corners -> decide.

Pure: it reads the index and the catalogue (through ``candidate_loader``) and writes nothing.
The decision reuses the ranking rules in ``api.recognize`` (``_candidate_rank_key`` and
``_metadata_decision``: number, printed total, set code, regulation mark, artist, HP), and adds the
picture evidence on top: a rule decision is only accepted when its printing is also among the
closest pictures; with no usable number, a picture-only decision needs a high similarity and a
clear lead. The thresholds are provisional until the benchmark fixes them.

Text candidates (``names.py``): the name line at the top of the card is read too, the local card list is
searched for close names (filtered by the number and total read), and those printings join the picture
top 20 before the ranking. A candidate's picture similarity comes from the picture index whether it was
found by picture or by name, so the two kinds are ranked on the same scale; the name and number only
move a printing up within the list. Deciding still needs the picture to agree.

Lookups (``lookup.py``): every printing with a number/total (and set code) the text holds, and cards whose attack,
ability or effect text matches the body text, join the list the same way. A printing found by its number alone may
be decided far down the picture ranking only when it is the one card at its level and the picture still agrees.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from . import config, constrained, detect as detect_module, ocr as ocr_module
from .index import CardIndex, tcg_card_id

TOP_K = 20


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


# Picture evidence needed on top of the printed-identifier rules.
SIM_MIN_WITH_RULES = _env_float("CARD_MATCH_SIM_MIN_WITH_RULES", 0.55)
RANK_MAX_WITH_RULES = 10  # the rule-chosen printing must be within this many closest pictures
# With no usable number: the picture alone must be this sure.
SIM_MIN_PICTURE_ONLY = _env_float("CARD_MATCH_SIM_MIN_PICTURE_ONLY", 0.80)
LEAD_MIN_PICTURE_ONLY = _env_float("CARD_MATCH_LEAD_MIN_PICTURE_ONLY", 0.06)
# The number was read but names nothing among the closest pictures (a misread that could not be corrected):
# the picture alone may still decide, but only on a much bigger similarity and lead than with no number at
# all, because a reprint with the same artwork scores almost the same as the card itself.
SIM_MIN_PICTURE_STRONG = _env_float("CARD_MATCH_SIM_MIN_PICTURE_STRONG", 0.88)
LEAD_MIN_PICTURE_STRONG = _env_float("CARD_MATCH_LEAD_MIN_PICTURE_STRONG", 0.10)
# A card whose printed name was also read and agrees (exact) may be decided by the picture with a smaller lead.
SIM_MIN_NAME_PICTURE = _env_float("CARD_MATCH_SIM_MIN_NAME_PICTURE", 0.80)
LEAD_MIN_NAME_PICTURE = _env_float("CARD_MATCH_LEAD_MIN_NAME_PICTURE", 0.03)
NAME_AGREES = 0.95  # name score that counts as "the same name"
# A rule-chosen printing found by its name may sit further down the picture ranking (reprints crowd it).
RANK_MAX_WITH_NAME = 40
# How much text agreement moves a printing up the combined ranking (picture similarity is the base).
NAME_WEIGHT, NUMBER_WEIGHT, TOTAL_WEIGHT = 0.25, 0.12, 0.04
PICTURE_KEEP = 5  # the closest pictures always stay in the list
# A printing found by its printed number (``lookup.py``) may sit further down the picture ranking, because reprints
# and look-alikes crowd it, but the picture must still agree: unique number + total + set code is strongest.
LOOKUP_RANK_MAX = int(_env_float("CARD_MATCH_LOOKUP_RANK_MAX", 60))
LOOKUP_SIM_SET = _env_float("CARD_MATCH_LOOKUP_SIM_SET", 0.60)  # number + total + set code, one card
LOOKUP_SIM_TOTAL = _env_float("CARD_MATCH_LOOKUP_SIM_TOTAL", 0.65)  # number + total, one card
LOOKUP_RANK_MAX_TOTAL = int(_env_float("CARD_MATCH_LOOKUP_RANK_MAX_TOTAL", 30))
# The card text agrees with exactly this card (a sentence only a few cards print) and the picture is close.
TEXT_AGREES, TEXT_MAX_CARDS = 0.85, 3
# Reprints (same name, near-identical pictures): the printing whose artwork-only similarity is clearly highest.
REPRINT_ART_LEAD = _env_float("CARD_MATCH_REPRINT_ART_LEAD", 0.04)
# Version 8, two holes behind a wrong decision (Darumaka read as 023/086 and decided as Black & White #23/114).
# 1) A printing chosen because it carries the read number must not print a total that contradicts a total that was read
#    ("086" read, 114 printed). Totals are compared as numbers, so "086" and 86 agree.
# 2) The number lane (several printings carry the number, the picture breaks the tie) and the rules lane must not decide a
#    printing when another printing of the SAME NAME is closer in the picture by more than this. A reprint with the same
#    artwork scores within about 0.03 of the card itself (REPRINT_ART_LEAD is 0.04), so 0.10 is more than twice the
#    reprint noise; the Darumaka case was 0.1512 (0.7928 against 0.6416), well over it.
SAME_NAME_PICTURE_MARGIN = _env_float("CARD_MATCH_SAME_NAME_PICTURE_MARGIN", 0.10)
# Which way up the card is. The camera guide is portrait and trainers hold cards upright, so upright is the
# default. The picture search may say "turned" only when the turned view beats the upright one by this much
# (a card in the index scores far higher in its own orientation; a card that is not there, or a holo with
# glare, scores about the same both ways and must not flip). Anything closer is settled by reading the text.
ORIENT_MARGIN = _env_float("CARD_MATCH_ORIENT_MARGIN", 0.10)
ROTATED_MIN_SIMILARITY = 0.45  # measuring a real rotation against the confirmed card: the turned view must also be this close


@dataclass
class MatchResult:
    status: str  # "decided" | "unsure"
    decision: dict | None  # {"card_id", "tcg_card_id", "mechanism", "similarity", "lead"} when decided
    unsure_reason: str | None
    matches: list[dict]  # top picture matches, best first: card_id, tcg_card_id, similarity, rank, name, number, ...
    detection: dict
    ocr: dict
    timings_ms: dict = field(default_factory=dict)
    text_card: object = None  # the flat card the text was read from (numpy array); not part of ``as_dict``
    card: object = None  # the flat card the picture was embedded from (numpy array); not part of ``as_dict``

    def as_dict(self) -> dict:
        return {
            "status": self.status, "decision": self.decision, "unsure_reason": self.unsure_reason,
            "matches": self.matches, "detection": self.detection, "ocr": self.ocr, "timings_ms": self.timings_ms,
        }


CandidateLoader = Callable[[list[str]], dict[str, dict]]


def db_candidate_loader(session_factory) -> CandidateLoader:
    """Catalogue rows for card ids, in the dict shape the ranking rules read. Read-only."""

    def load(card_ids: list[str]) -> dict[str, dict]:
        from models import Card, Set

        db = session_factory()
        try:
            cards = db.query(Card).filter(Card.id.in_(card_ids)).all()
            set_ids = {card.set_id for card in cards if card.set_id}
            sets = {}
            if set_ids:
                for row in db.query(Set).filter(Set.tcg_set_id.in_(set_ids)):
                    sets[(row.tcg_set_id, row.lang)] = row
            out = {}
            for card in cards:
                local_set = sets.get((card.set_id, card.lang or "en"))
                out[card.id] = {
                    "id": card.tcg_card_id or tcg_card_id(card.id), "tcg_card_id": card.tcg_card_id or tcg_card_id(card.id),
                    "name": card.name, "number": card.number, "hp": card.hp, "artist": card.artist,
                    "regulation_mark": card.regulation_mark, "card_type": (card.supertype or "").lower() or None,
                    "set": local_set.name if local_set else None,
                    "set_abbreviation": local_set.abbreviation if local_set else None,
                    "printed_total": (local_set.printed_total or None) if local_set else None,
                    "_lang": card.lang or "en", "images_small": card.images_small, "images_large": card.images_large, "rarity": card.rarity,
                }
            return out
        finally:
            db.close()

    return load


def _timer() -> float:
    return time.perf_counter()


def _lookup_near(card: dict) -> bool:
    """A printing found by its printed number may sit far down the picture ranking only with a unique number +
    total match and a picture that still agrees."""
    level, unique = card.get("_lookup"), card.get("_lookup_unique")
    if not unique:
        return False
    if level == "number_total_set":
        return card["_rank"] <= LOOKUP_RANK_MAX and card["_similarity"] >= LOOKUP_SIM_SET
    if level == "number_total":
        return card["_rank"] <= LOOKUP_RANK_MAX_TOTAL and card["_similarity"] >= LOOKUP_SIM_TOTAL
    return False


def _name_conflict(card: dict) -> bool:
    """A name was read that is in the catalogue, and it is not this card's name."""
    return bool(card.get("_name_known")) and card.get("_name_score", 0.0) <= 0.0


def _reprint_choice(candidates: list[dict]) -> dict | None:
    """Several printings of one name look alike: take the one whose artwork-only similarity is clearly highest,
    when the group as a whole is clearly the picture's answer. Never guesses: no artwork scores, no lead, no choice."""
    from . import names

    ranked = sorted(candidates, key=lambda card: card["_rank"])
    if len(ranked) < 2 or ranked[0]["_similarity"] < SIM_MIN_PICTURE_ONLY:
        return None
    key = names.name_key(ranked[0].get("name") or "")
    group = [card for card in ranked if names.name_key(card.get("name") or "") == key]
    if not key or len(group) < 2 or any(card.get("_art_similarity") is None for card in group):
        return None
    others = [card for card in ranked if card not in group]
    if others and group[0]["_similarity"] - others[0]["_similarity"] < LEAD_MIN_PICTURE_ONLY:
        return None
    by_art = sorted(group, key=lambda card: -card["_art_similarity"])
    lead = by_art[0]["_art_similarity"] - by_art[1]["_art_similarity"]
    winner = by_art[0]
    if lead < REPRINT_ART_LEAD or winner["_similarity"] < SIM_MIN_PICTURE_ONLY or winner["_rank"] > 5:
        return None
    return {"candidate": winner, "mechanism": "reprint_art_lead", "lead": round(lead, 4)}


def _total_contradiction(card_info: dict, card: dict) -> bool:
    """A total was read, the card prints one, and they are different numbers ("086" against 114)."""
    from api import recognize as rules

    return rules._printed_total_signal(card_info.get("number_total"), card.get("printed_total")) == 2


def _closer_same_name(chosen: dict, candidates: list[dict]) -> dict | None:
    """Another printing of the chosen card's name whose picture is closer by more than ``SAME_NAME_PICTURE_MARGIN``."""
    from . import names

    key = names.name_key(chosen.get("name") or "")
    if not key:
        return None
    rivals = [c for c in candidates if c is not chosen and names.name_key(c.get("name") or "") == key
              and c["_similarity"] - chosen["_similarity"] > SAME_NAME_PICTURE_MARGIN]
    return max(rivals, key=lambda c: c["_similarity"]) if rivals else None


def decide(card_info: dict, candidates: list[dict], *, reprint: bool = False, fallback: bool = False,
           number_read: bool = True) -> tuple[dict | None, str | None]:
    """The lanes of ``_decide_lanes``, then one check that holds for every lane: a card whose printed total contradicts a
    total that was read is never decided (the number lanes check it for the printing they choose; the picture-only lanes
    had no number to compare, but a read total alone can still rule a printing out)."""
    chosen, reason = _decide_lanes(card_info, candidates, reprint=reprint, fallback=fallback, number_read=number_read)
    if chosen is not None and _total_contradiction(card_info, chosen["candidate"]):
        return None, "total_contradicts_read"
    return chosen, reason


def _decide_lanes(card_info: dict, candidates: list[dict], *, reprint: bool = False, fallback: bool = False,
                  number_read: bool = True) -> tuple[dict | None, str | None]:
    """(chosen candidate + mechanism, or None + reason) from OCR'd identifiers and picture scores.

    Each candidate carries ``_similarity``, ``_rank`` (1 = closest picture) and ``_lead`` for the top one.
    ``fallback``: the card was not found on the recognition image (it came from the full photo or the plain guide
    crop). Such a card may add and rank candidates, but it is only decided when a number was actually read from it
    (``number_read``: OCR's own, not one filled in from a lookup) and the picture agrees; a picture-only
    decision, which would rest on a crop that may not be the card at all, is never taken.
    """
    from api import recognize as rules  # the existing rules; imported here so this package imports cheaply

    if not candidates:
        return None, "no_picture_matches"
    if fallback and not (number_read and card_info.get("number_local")):
        return None, "card_not_found_no_number_read"
    by_similarity = sorted(candidates, key=lambda card: card["_rank"])
    top_picture = by_similarity[0]
    lead = top_picture["_similarity"] - (by_similarity[1]["_similarity"] if len(by_similarity) > 1 else 0.0)
    if card_info.get("number_local"):
        number_hits = [c for c in candidates if rules._numbers_match(card_info["number_local"], c.get("number"))]
        decided, mechanism = rules._metadata_decision(card_info, candidates)
        if decided:
            chosen = sorted(candidates, key=lambda card: rules._candidate_rank_key(card_info, card))[0]
            near = chosen["_rank"] <= RANK_MAX_WITH_RULES or (chosen.get("_name_score", 0.0) >= 0.9 and chosen["_rank"] <= RANK_MAX_WITH_NAME)
            if chosen.get("_lookup") and _name_conflict(chosen):
                return None, "number_lookup_conflicts_with_name"  # picture, number and name must agree
            if _total_contradiction(card_info, chosen):
                return None, "total_contradicts_read"
            if _closer_same_name(chosen, candidates) is not None:
                return None, "closer_printing_of_same_name"
            if chosen["_similarity"] >= SIM_MIN_WITH_RULES and (near or _lookup_near(chosen)):
                return {"candidate": chosen, "mechanism": mechanism, "lead": round(lead, 4)}, None
            return None, "rules_choice_not_close_in_picture"
        if not number_hits:
            if not fallback and top_picture["_similarity"] >= SIM_MIN_PICTURE_STRONG and lead >= LEAD_MIN_PICTURE_STRONG:
                return {"candidate": top_picture, "mechanism": "picture_lead_strong", "lead": round(lead, 4)}, None
            return None, "number_not_among_picture_matches"
        # The number matches several printings: the picture breaks the tie only when it is clear.
        if len(number_hits) > 1:
            number_hits.sort(key=lambda card: card["_rank"])
            gap = number_hits[0]["_similarity"] - number_hits[1]["_similarity"]
            if gap >= LEAD_MIN_PICTURE_ONLY and number_hits[0]["_similarity"] >= SIM_MIN_WITH_RULES:
                pick = number_hits[0]
                if _total_contradiction(card_info, pick):
                    return None, "total_contradicts_read"
                if _closer_same_name(pick, candidates) is not None:
                    return None, "closer_printing_of_same_name"
                return {"candidate": pick, "mechanism": "number_and_picture", "lead": round(gap, 4)}, None
        if reprint and not fallback and (found := _reprint_choice(candidates)):
            return found, None
        return None, "number_matches_several_printings"
    if top_picture["_similarity"] >= SIM_MIN_PICTURE_ONLY and lead >= LEAD_MIN_PICTURE_ONLY:
        return {"candidate": top_picture, "mechanism": "picture_lead", "lead": round(lead, 4)}, None
    if (top_picture.get("_name_score", 0.0) >= NAME_AGREES and top_picture["_similarity"] >= SIM_MIN_NAME_PICTURE
            and lead >= LEAD_MIN_NAME_PICTURE):
        return {"candidate": top_picture, "mechanism": "name_and_picture", "lead": round(lead, 4)}, None
    if (top_picture.get("_text_score", 0.0) >= TEXT_AGREES and top_picture.get("_text_cards", 99) <= TEXT_MAX_CARDS
            and not _name_conflict(top_picture)
            and top_picture["_similarity"] >= SIM_MIN_NAME_PICTURE and lead >= LEAD_MIN_NAME_PICTURE):
        return {"candidate": top_picture, "mechanism": "text_and_picture", "lead": round(lead, 4)}, None
    if reprint and (found := _reprint_choice(candidates)):
        return found, None
    return None, "no_number_and_picture_not_clear"


def number_from_lookup(card_info: dict, candidates: list[dict]) -> dict | None:
    """OCR's own number parse can be fooled by the text beside the number ("30C | 017/128" reads as 30C over 017).
    When it names none of the candidates but the number lookup found a printing by number and total, read that
    printing's number and total instead. Changes ``card_info`` in place; returns what changed, or None."""
    from api import recognize as rules

    read = card_info.get("number_local")
    if read and any(rules._numbers_match(read, c.get("number")) for c in candidates):
        return None
    found = [c for c in candidates if c.get("_lookup") in ("number_total_set", "number_total")]
    if not found:
        return None
    order = ("number_total_set", "number_total")
    found.sort(key=lambda c: (order.index(c["_lookup"]), -c["_similarity"]))
    best = found[0]
    card_info["number_local"] = best.get("number")
    if best.get("printed_total"):
        card_info["number_total"] = str(best["printed_total"])
    return {"read": read, "number": best.get("number"), "total": card_info.get("number_total"), "level": best["_lookup"]}


def correct_number(card_info: dict, candidates: list[dict], lines: list[str]) -> dict | None:
    """When the number OCR read names none of the closest printings (or none was read), look for the one
    printing whose "number/total" the recognised text is a damaged copy of, and read that number instead.
    Changes ``card_info`` in place; returns what changed, for the trace, or None."""
    from api import recognize as rules

    if not candidates or not lines:
        return None
    read = card_info.get("number_local")
    if read and any(rules._numbers_match(read, c.get("number")) for c in candidates):
        return None
    found = constrained.constrain(lines, candidates)
    if found is None:
        return None
    card_info["number_local"] = found.number
    card_info["number_total"] = found.total
    return {"read": read, "number": found.number, "total": found.total, "distance": found.distance}


@dataclass
class Signal:
    """One picture index and how to build its query: the whole card, or the artwork window only."""
    name: str
    index: CardIndex
    embedder: object
    crop: str = "full"  # "full" | "art"


class CardMatcher:
    def __init__(
        self, index: CardIndex, embedder, candidate_loader: CandidateLoader, ocr_reader=None, *, read_hp: bool = False,
        extra_signals=(), tta: bool = False, names=None, label: str = "baseline",
        lookup=None, use_number: bool = False, use_text: bool = False, reprint: bool = False, fastread: bool = False,
        number_once: bool = False, corners: bool = False, wholepic: bool = False, trustrejected: bool = False,
    ) -> None:
        self.index = index
        self.embedder = embedder
        self.candidate_loader = candidate_loader
        self.ocr_reader = ocr_reader
        self.read_hp = read_hp
        self.extra_signals: list[Signal] = list(extra_signals)
        self.tta = tta
        self.names = names  # a names.NameIndex turns the text search on
        self.label = label
        self.lookup = lookup  # a lookup.LookupIndex: the number / set code lane and the card-text lane
        self.use_number = bool(lookup is not None and use_number)
        self.use_text = bool(lookup is not None and use_text)
        self.number_once = number_once  # a read number is worth one boost in the ranking, not two (see ``merge_candidates``)
        self.fastread = fastread  # a shorter reading ladder and a lower time budget (ocr.FAST_BUDGET_SECONDS)
        self.corners = corners  # version 8: the card finder judges every quad for plausibility (detect.plausibility_problem)
        self.wholepic = wholepic  # a refused quad: the whole picture is the card, not the centre guide crop
        self.trustrejected = trustrejected  # a refused quad with the guide crop used is decided by the normal rules, not the strict fallback ones
        self.reprint = reprint  # break ties between reprints by the artwork-only similarity
        self._row_maps: dict[int, np.ndarray] = {}

    def _rows_in_primary(self, signal: Signal) -> np.ndarray:
        """For each row of the main index, the row of the same card in another index (-1: not there)."""
        cached = self._row_maps.get(id(signal.index))
        if cached is None or len(cached) != len(self.index):
            other = signal.index.row_of
            cached = np.array([other.get(card_id, -1) for card_id in self.index.card_ids], dtype=np.int64)
            self._row_maps[id(signal.index)] = cached
        return cached

    def _main_scores(self, upright: np.ndarray) -> tuple[np.ndarray, float, float]:
        """(every indexed card's best similarity over the card at 0 and 180 degrees, the best score of the
        upright view, the best score of the turned view)."""
        views = [upright, np.ascontiguousarray(upright[::-1, ::-1])]
        if not len(self.index):
            return np.zeros(0, dtype=np.float32), 0.0, 0.0
        raw = self.embedder.embed(views) @ self.index.vectors.T
        return raw.max(axis=0), float(raw[0].max()), float(raw[1].max())

    def _picture_scores(self, best: np.ndarray, upright: np.ndarray, flipped: bool, art_out: dict | None = None) -> np.ndarray:
        """The per-card picture score for a card known to be ``flipped`` or not. Test-time augmentation adds
        views of the oriented card, and each extra index (artwork only, a second model) adds its own
        similarity: the result is their average per card."""
        oriented = np.ascontiguousarray(upright[::-1, ::-1]) if flipped else upright
        extra_views = detect_module.augmented_views(oriented) if self.tta else []
        if extra_views:
            best = np.maximum(best, self.index.best_scores(self.embedder.embed(extra_views)))
        if self.extra_signals:
            total = best.copy()
            for signal in self.extra_signals:
                pictures = [oriented] + extra_views
                if signal.crop == "art":
                    pictures = [detect_module.art_crop(picture) for picture in pictures]
                other = signal.index.best_scores(signal.embedder.embed(pictures))
                rows = self._rows_in_primary(signal)
                own = np.where(rows >= 0, other[np.maximum(rows, 0)], best) if len(other) else best
                if art_out is not None and signal.crop == "art":
                    art_out["art"] = own  # the artwork-only similarity of every card, for telling reprints apart
                total += own
            best = total / (1 + len(self.extra_signals))
        return best

    def card_rotation(self, card_rgb: np.ndarray, card_id: str) -> dict | None:
        """Measured, not inferred: how close the flat card is to the confirmed card's own catalogue picture
        as it is, and turned 180 degrees. ``rotated`` is True only when the turned view is clearly closer."""
        row = self.index.row_of.get(card_id)
        if row is None:
            return None
        views = [card_rgb, np.ascontiguousarray(card_rgb[::-1, ::-1])]
        upright_sim, turned_sim = (float(v) for v in self.embedder.embed(views) @ self.index.vectors[row])
        margin = turned_sim - upright_sim
        return {"upright": round(upright_sim, 4), "turned": round(turned_sim, 4), "margin": round(margin, 4),
                "rotated": margin >= ORIENT_MARGIN and turned_sim >= ROTATED_MIN_SIMILARITY}

    def card_similarities(self, cards: list[np.ndarray], card_id: str) -> list[float] | None:
        """Measured: how close each flat card is to the confirmed card's own catalogue picture, the better of the card as it
        is and turned 180 degrees (one batch). None when the confirmed card is not in the index. For the corners check."""
        row = self.index.row_of.get(card_id)
        if row is None or not cards:
            return None
        views = [view for card in cards for view in (card, np.ascontiguousarray(card[::-1, ::-1]))]
        sims = self.embedder.embed(views) @ self.index.vectors[row]
        return [float(max(sims[2 * i], sims[2 * i + 1])) for i in range(len(cards))]

    def _top_hits(self, scores: np.ndarray, top_k: int):
        count = len(scores)
        k = min(top_k, count)
        if count:
            part = np.argpartition(-scores, k - 1)[:k]
            top_rows = part[np.argsort(-scores[part])]
        else:
            top_rows = np.zeros(0, dtype=np.int64)
        card_ids = self.index.card_ids
        return [(card_ids[row], float(scores[row])) for row in top_rows]

    def _text_usable(self, result, name_read) -> tuple[int, int]:
        """How much a reading says: (0 nothing / 1 a number / 2 number and total, 1 when the name read matches a catalogue name)."""
        name_found = 0
        if name_read is not None and name_read.name and self.names is not None and self.names.score_names(name_read.name):
            name_found = 1
        return ocr_module.completeness(result), name_found

    def _read_text(self, card: np.ndarray, picture_flipped: bool, *, use_names: bool, light: bool = False):
        """Read the number strips (and the name line) the right way up.

        When the picture search is sure the card is turned (``picture_flipped``), read it turned. Otherwise
        read upright first and turn the card only when that gave nothing usable and the turned card gives
        something better: a number, or a name that is in the catalogue. Returns
        ``(ocr result, name read or None, flipped, how)`` with ``how`` = picture | text | default.

        ``light`` (a card found only by the guide frame): the short ladder and the lower budget, and the card is read in
        one orientation only, so this read takes no longer than a normal one (it used to run the whole ladder both ways up)."""

        fast = {"fast": True} if (self.fastread or light) else {}  # only passed when on, so a reader without the option still works

        def attempt(flipped: bool):
            result = self.ocr_reader.read(card, read_hp=self.read_hp, flipped=flipped, **fast)
            name_read = self.ocr_reader.read_name(card, flipped=flipped, **fast) if use_names else None
            return result, name_read

        if picture_flipped:
            result, name_read = attempt(True)
            return result, name_read, True, "picture"
        result, name_read = attempt(False)
        if light or any(self._text_usable(result, name_read)):
            return result, name_read, False, "default"
        other_result, other_name = attempt(True)
        if self._text_usable(other_result, other_name) > self._text_usable(result, name_read):
            return other_result, other_name, True, "text"
        return result, name_read, False, "default"

    def _finder_options(self, whole_frame: bool = False) -> dict:
        """Keyword arguments for ``detect_card``: none with ``corners`` off (the version 7 finder). A whole frame (the review
        or full photo) is never judged as a guide crop."""
        if not self.corners:
            return {}
        return {"check": True, "guide": False} if whole_frame else {"check": True, "whole": self.wholepic}

    def _find_card(self, photo_rgb: np.ndarray, full_photo, review_photo=None) -> tuple[object, str | None]:
        """(detection, fallback). When no card is found on the recognition image, the stored whole review photo is tried
        first (the card may be cut by the guide crop, and only the whole frame still holds it; an array, or a function that returns one), then the full photo (the
        sharper guide crop: the same framing as the recognition image, so it only helps an upload without one); failing
        that, the plain guide-frame crop is used, because the trainer lined the card up with the guide. ``fallback`` is
        None for a normal find, ``review_photo``, ``full_photo`` or ``guide_crop`` otherwise."""
        detection = detect_module.detect_card(photo_rgb, **self._finder_options())
        if detection.found:
            return detection, None
        for name, picture in (("review_photo", review_photo), ("full_photo", full_photo)):
            if callable(picture):  # decoded only now, when the card was not found: most scans never need it
                picture = picture()
            if picture is None:
                continue
            other = detect_module.detect_card(picture, **self._finder_options(whole_frame=True))
            if other.found:
                other.corners_space = name  # these corners are in that photo, not in ``photo_rgb``
                return other, name
        return detection, "guide_crop"

    def _text_card(self, detection, upright: np.ndarray, full_photo, flat_card, fallback: str | None = None) -> tuple[np.ndarray, str]:
        """The flat card the text is read from, and where it came from. Text is small, so it is read from the
        sharpest picture there is: a stored high-resolution card (a trace), or the full-resolution photo
        flattened at the detected corners, or this photo's own detail; the matcher's 630x880 card is the last resort."""
        if flat_card is not None and not (self.corners and getattr(detection, "rejected", None)):
            return flat_card, "stored_card"  # (a stored card was flattened at the scan's own corners: with refused corners it is not trusted)
        if fallback in ("full_photo", "review_photo"):
            return (detection.hires if detection.hires is not None else detection.card), fallback
        if full_photo is not None and detection.found:
            other = detect_module.detect_card(full_photo, **self._finder_options(whole_frame=True))
            if other.found and _same_card(other.card, upright):
                return (other.hires if other.hires is not None else other.card), "full_photo"
        if detection.hires is not None:
            return detection.hires, "photo" if detection.found else "guide_crop_sharp"
        return upright, "crop"

    def match(self, photo_rgb: np.ndarray, *, top_k: int = TOP_K, use_ocr: bool = True, full_photo=None, flat_card=None, review_photo=None) -> MatchResult:
        """``photo_rgb`` is what the card is found and embedded from (the recognition image). ``full_photo`` (the
        stored full-resolution photo), ``review_photo`` (the whole stored review photo, tried when the card is not found
        on ``photo_rgb``) or ``flat_card`` (a stored high-resolution flat card) only sharpen the text
        reading; without either the text is read from ``photo_rgb`` itself."""
        config.apply_thread_caps()
        timings: dict[str, float] = {}
        t0 = _timer()
        detection, fallback = self._find_card(photo_rgb, full_photo, review_photo)
        timings["detect"] = (_timer() - t0) * 1000

        t0 = _timer()
        upright = detection.card
        best, top_upright, top_turned = self._main_scores(upright)
        margin = top_turned - top_upright
        picture_flipped = bool(len(best)) and margin >= ORIENT_MARGIN
        art_scores: dict = {}
        scores = self._picture_scores(best, upright, picture_flipped, art_scores)
        timings["embed"] = (_timer() - t0) * 1000

        t0 = _timer()
        count = len(scores)
        hits = self._top_hits(scores, top_k)
        timings["search"] = (_timer() - t0) * 1000

        flipped = picture_flipped
        ocr_info: dict = {}
        ocr_result = None
        name_read = None
        text_card = None
        evidence = None
        if use_ocr and self.ocr_reader is not None:
            t0 = _timer()
            text_card, text_source = self._text_card(detection, upright, full_photo, flat_card, fallback)
            can_read_names = self.names is not None and hasattr(self.ocr_reader, "read_name")
            ocr_result, name_read, flipped, how = self._read_text(text_card, picture_flipped, use_names=can_read_names, light=fallback == "guide_crop")
            timings["ocr"] = (_timer() - t0) * 1000
            if flipped != picture_flipped:  # the text turned the card: the extra views follow the card's real orientation
                t0 = _timer()
                scores = self._picture_scores(best, upright, flipped, art_scores)
                hits = self._top_hits(scores, top_k)
                timings["search"] += (_timer() - t0) * 1000
            ocr_info = {
                "number_local": ocr_result.number_local, "number_total": ocr_result.number_total, "hp": ocr_result.hp,
                "tokens": ocr_result.tokens[:12], "flipped": flipped, "lines": ocr_result.lines[:8],
                "orientation": {"by": how, "picture_margin": round(margin, 4)},
                "text_input": {"source": text_source, "width": int(text_card.shape[1]), "height": int(text_card.shape[0])},
            }
            # Every region OCR read (box, preprocessing, each line's text and confidence): Scanner lab draws them.
            ocr_info["strips"] = list(getattr(ocr_result, "strips", None) or []) + list(getattr(name_read, "strips", None) or [])
            if name_read is not None:
                if name_read.hp and not ocr_info.get("hp"):
                    ocr_info["hp"] = name_read.hp
                ocr_info["name"] = name_read.name
                ocr_info["name_lines"] = name_read.raw[:6]
            if self.use_number or self.use_text:
                t0 = _timer()
                body = [line for line in list(ocr_result.lines) + list(getattr(ocr_result, "body_lines", None) or []) if line]
                evidence = self.lookup.search(
                    body, ocr_result.number_local, ocr_result.number_total, ocr_result.tokens,
                    number=self.use_number, text=self.use_text,
                )
                if not evidence.empty():
                    ocr_info["lookup"] = evidence.trace()
                timings["lookup"] = (_timer() - t0) * 1000
            if name_read is not None or evidence is not None:
                t0 = _timer()
                hits, added = merge_candidates(
                    hits, scores, self.index.row_of, self.names, name_read.name if name_read else None,
                    ocr_result.number_local, ocr_result.number_total, top_k, evidence=evidence,
                    number_once=self.number_once,
                )
                ocr_info["text_candidates_added"] = added
                timings["name"] = (_timer() - t0) * 1000

        t0 = _timer()
        loaded = self.candidate_loader([card_id for card_id, _score in hits])
        name_known = bool(name_read is not None and name_read.name and self.names is not None and self.names.score_names(name_read.name))
        candidates = []
        for position, (card_id, score) in enumerate(hits, start=1):
            row = loaded.get(card_id)
            if row is None:
                continue
            # _rank: where this printing stands among all pictures (1 = closest); _position: in the final list.
            candidate = {**row, "_db_id": card_id, "_similarity": round(float(score), 4),
                         "_rank": 1 + int((scores > score).sum()) if count else position, "_position": position}
            if name_read is not None and self.names is not None:
                candidate["_name_score"] = round(self.names.name_score_of(card_id, name_read.name), 3)
                candidate["_name_known"] = name_known
            if evidence is not None:
                level = evidence.level_of(card_id)
                if level:
                    candidate["_lookup"] = level
                    candidate["_lookup_unique"] = evidence.unique_at_or_above(level) == 1
                text_hit = evidence.text.get(card_id)
                if text_hit:
                    candidate["_text_score"], candidate["_text_cards"] = round(text_hit.score, 3), text_hit.cards
            art = art_scores.get("art")
            row = self.index.row_of.get(card_id)
            if art is not None and row is not None:
                candidate["_art_similarity"] = round(float(art[row]), 4)
            candidates.append(candidate)
        card_info = (
            ocr_result.as_card_info({c.get("set_abbreviation") for c in candidates if c.get("set_abbreviation")})
            if ocr_result else {}
        )
        card_info["language"] = None  # English-only index: language is not evidence
        looked_up = number_from_lookup(card_info, candidates) if evidence is not None else None
        if looked_up:
            ocr_info["number_from_lookup"] = looked_up
        corrected = correct_number(card_info, candidates, ocr_result.lines if ocr_result else [])
        if corrected:
            ocr_info["corrected"] = corrected
        # ``trustrejected`` (an option the comparison measures): a guide crop used because the finder REFUSED its quad is judged
        # like a found card; a scan where the finder saw nothing card-like at all keeps the strict rule.
        trusted = bool(self.trustrejected and fallback == "guide_crop" and getattr(detection, "rejected", None))
        chosen, reason = decide(card_info, candidates, reprint=self.reprint, fallback=fallback is not None and not trusted,
                                number_read=bool(ocr_result and ocr_result.number_local and not looked_up))
        timings["decide"] = (_timer() - t0) * 1000
        timings["total"] = sum(timings.values())

        matches = []
        for c in candidates:
            match = {
                "card_id": c["_db_id"], "tcg_card_id": c["tcg_card_id"], "similarity": c["_similarity"], "rank": c["_position"],
                "name": c.get("name"), "number": c.get("number"), "set": c.get("set"), "printed_total": c.get("printed_total"),
                "picture_rank": c["_rank"],
            }
            if "_name_score" in c:
                match["name_score"] = c["_name_score"]
            if c.get("_lookup"):
                match["lookup"] = c["_lookup"]
            if "_text_score" in c:
                match["text_score"] = c["_text_score"]
            if "_art_similarity" in c:
                match["art_similarity"] = c["_art_similarity"]
            matches.append(match)
        decision = None
        if chosen:
            candidate = chosen["candidate"]
            decision = {
                "card_id": candidate["_db_id"], "tcg_card_id": candidate["tcg_card_id"], "mechanism": chosen["mechanism"],
                "similarity": candidate["_similarity"], "lead": chosen["lead"],
            }
        return MatchResult(
            status="decided" if decision else "unsure", decision=decision, unsure_reason=None if decision else reason,
            matches=matches,
            detection={"found": detection.found and fallback not in ("full_photo", "review_photo"), "confidence": detection.confidence, "method": detection.method,
                       "corners": [[round(x, 1), round(y, 1)] for x, y in detection.corners],
                       # Not found on the recognition image: "review_photo" or "full_photo" (found there, which does not count as a find) or
                       # "guide_crop" (the plain guide-frame crop); None for a normal find. See ``decide``.
                       "fallback": fallback, "corners_space": getattr(detection, "corners_space", "photo"),
                       # A quad the finder saw and refused (version 8): why, and its measurements; None when it refused nothing.
                       "rejected": getattr(detection, "rejected", None)},
            ocr=ocr_info, timings_ms={key: round(value, 1) for key, value in timings.items()}, text_card=text_card, card=upright,
        )


def _same_card(first: np.ndarray, second: np.ndarray, floor: float = 0.6) -> bool:
    """Two flattenings of the same photo region look alike (grey correlation at a small size)."""
    import cv2

    def tiny(picture):
        grey = cv2.cvtColor(cv2.resize(picture, (48, 66), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY).astype(np.float32).ravel()
        return grey - grey.mean()

    a, b = tiny(first), tiny(second)
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    return denom > 0 and float(a @ b) / denom >= floor


def merge_candidates(hits, scores, row_of, names, name: str | None, number: str | None, total: str | None, top_k: int = TOP_K, evidence=None, number_once: bool = False):
    """The picture top list and the text candidates as one ranking of at most ``top_k`` printings.

    Returns ``([(card id, picture similarity)], how many came from the text search only)``. Every printing is
    scored ``picture similarity + name, number and total agreement``; the closest ``PICTURE_KEEP`` pictures
    always stay, so a wrong name read can push other printings down but never the picture's own best guesses.

    A read number is counted twice by default: once by the name search (``NUMBER_WEIGHT`` + ``TOTAL_WEIGHT``) and once by the
    number lookup (its level's boost), up to 0.36 in all, which let a wrong card with the read number outrank the right one
    whose picture was far closer. ``number_once`` counts it once: the larger of the two.
    """
    use_names = names is not None and bool(name)
    use_lookup = evidence is not None and not evidence.empty()
    if not use_names and not use_lookup:
        return hits, 0
    picture_ids = [card_id for card_id, _score in hits]
    pool: dict[str, float] = {card_id: score for card_id, score in hits}
    found = list(names.search(name, number, total)) if use_names else []
    for card_id in (evidence.add_ids() if use_lookup else []):
        row = row_of.get(card_id)
        if row is not None and card_id not in pool:
            pool[card_id] = float(scores[row])
    for hit in found:
        row = row_of.get(hit.card_id)
        if row is not None and hit.card_id not in pool:
            pool[hit.card_id] = float(scores[row])

    def combined(card_id: str) -> float:
        bonus = 0.0
        read_number = 0.0
        if use_names:
            name_score = names.name_score_of(card_id, name)
            agreement = names.agreement(card_id, name_score, number, total)
            bonus = NAME_WEIGHT * max(0.0, (name_score - 0.72) / 0.28)
            read_number = (NUMBER_WEIGHT if agreement.number_ok else 0.0) + (TOTAL_WEIGHT if agreement.total_ok else 0.0)
        if use_lookup:
            if number_once:
                read_number = max(read_number, evidence.number_bonus(card_id))
                bonus += evidence.bonus(card_id, number=False)
            else:
                bonus += evidence.bonus(card_id)
        return pool[card_id] + bonus + read_number

    keep = picture_ids[:min(PICTURE_KEEP, top_k)]
    rest = sorted((card_id for card_id in pool if card_id not in keep), key=lambda card_id: -combined(card_id))
    chosen = keep + rest[:max(0, top_k - len(keep))]
    chosen.sort(key=lambda card_id: -combined(card_id))
    original = set(picture_ids)
    return [(card_id, pool[card_id]) for card_id in chosen], sum(1 for card_id in chosen if card_id not in original)
