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
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from . import config, constrained, detect as detect_module
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


@dataclass
class MatchResult:
    status: str  # "decided" | "unsure"
    decision: dict | None  # {"card_id", "tcg_card_id", "mechanism", "similarity", "lead"} when decided
    unsure_reason: str | None
    matches: list[dict]  # top picture matches, best first: card_id, tcg_card_id, similarity, rank, name, number, ...
    detection: dict
    ocr: dict
    timings_ms: dict = field(default_factory=dict)

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
                    "_lang": card.lang or "en", "images_small": card.images_small, "rarity": card.rarity,
                }
            return out
        finally:
            db.close()

    return load


def _timer() -> float:
    return time.perf_counter()


def decide(card_info: dict, candidates: list[dict]) -> tuple[dict | None, str | None]:
    """(chosen candidate + mechanism, or None + reason) from OCR'd identifiers and picture scores.

    Each candidate carries ``_similarity``, ``_rank`` (1 = closest picture) and ``_lead`` for the top one.
    """
    from api import recognize as rules  # the existing rules; imported here so this package imports cheaply

    if not candidates:
        return None, "no_picture_matches"
    by_similarity = sorted(candidates, key=lambda card: card["_rank"])
    top_picture = by_similarity[0]
    lead = top_picture["_similarity"] - (by_similarity[1]["_similarity"] if len(by_similarity) > 1 else 0.0)
    if card_info.get("number_local"):
        number_hits = [c for c in candidates if rules._numbers_match(card_info["number_local"], c.get("number"))]
        decided, mechanism = rules._metadata_decision(card_info, candidates)
        if decided:
            chosen = sorted(candidates, key=lambda card: rules._candidate_rank_key(card_info, card))[0]
            near = chosen["_rank"] <= RANK_MAX_WITH_RULES or (chosen.get("_name_score", 0.0) >= 0.9 and chosen["_rank"] <= RANK_MAX_WITH_NAME)
            if chosen["_similarity"] >= SIM_MIN_WITH_RULES and near:
                return {"candidate": chosen, "mechanism": mechanism, "lead": round(lead, 4)}, None
            return None, "rules_choice_not_close_in_picture"
        if not number_hits:
            if top_picture["_similarity"] >= SIM_MIN_PICTURE_STRONG and lead >= LEAD_MIN_PICTURE_STRONG:
                return {"candidate": top_picture, "mechanism": "picture_lead_strong", "lead": round(lead, 4)}, None
            return None, "number_not_among_picture_matches"
        # The number matches several printings: the picture breaks the tie only when it is clear.
        if len(number_hits) > 1:
            number_hits.sort(key=lambda card: card["_rank"])
            gap = number_hits[0]["_similarity"] - number_hits[1]["_similarity"]
            if gap >= LEAD_MIN_PICTURE_ONLY and number_hits[0]["_similarity"] >= SIM_MIN_WITH_RULES:
                return {"candidate": number_hits[0], "mechanism": "number_and_picture", "lead": round(gap, 4)}, None
        return None, "number_matches_several_printings"
    if top_picture["_similarity"] >= SIM_MIN_PICTURE_ONLY and lead >= LEAD_MIN_PICTURE_ONLY:
        return {"candidate": top_picture, "mechanism": "picture_lead", "lead": round(lead, 4)}, None
    if (top_picture.get("_name_score", 0.0) >= NAME_AGREES and top_picture["_similarity"] >= SIM_MIN_NAME_PICTURE
            and lead >= LEAD_MIN_NAME_PICTURE):
        return {"candidate": top_picture, "mechanism": "name_and_picture", "lead": round(lead, 4)}, None
    return None, "no_number_and_picture_not_clear"


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
        self._row_maps: dict[int, np.ndarray] = {}

    def _rows_in_primary(self, signal: Signal) -> np.ndarray:
        """For each row of the main index, the row of the same card in another index (-1: not there)."""
        cached = self._row_maps.get(id(signal.index))
        if cached is None or len(cached) != len(self.index):
            other = signal.index.row_of
            cached = np.array([other.get(card_id, -1) for card_id in self.index.card_ids], dtype=np.int64)
            self._row_maps[id(signal.index)] = cached
        return cached

    def _picture_scores(self, upright: np.ndarray) -> tuple[np.ndarray, bool]:
        """(every indexed card's picture similarity, whether the card is upside down).

        The main index is searched with the card at 0 and 180 degrees; the view that matches better says
        which way up it is. Test-time augmentation adds views of the oriented card, and each extra index
        (artwork only, a second model) adds its own similarity: the result is their average per card."""
        views = [upright, np.ascontiguousarray(upright[::-1, ::-1])]
        raw = self.embedder.embed(views) @ self.index.vectors.T if len(self.index) else np.zeros((2, 0), dtype=np.float32)
        best = raw.max(axis=0) if raw.shape[1] else np.zeros(0, dtype=np.float32)
        flipped = bool(raw.shape[1]) and float(raw[1].max()) > float(raw[0].max())
        oriented = views[1] if flipped else views[0]
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
                total += np.where(rows >= 0, other[np.maximum(rows, 0)], best) if len(other) else best
            best = total / (1 + len(self.extra_signals))
        return best, flipped

    def match(self, photo_rgb: np.ndarray, *, top_k: int = TOP_K, use_ocr: bool = True) -> MatchResult:
        config.apply_thread_caps()
        timings: dict[str, float] = {}
        t0 = _timer()
        detection = detect_module.detect_card(photo_rgb)
        timings["detect"] = (_timer() - t0) * 1000

        t0 = _timer()
        upright = detection.card
        scores, flipped = self._picture_scores(upright)
        timings["embed"] = (_timer() - t0) * 1000

        t0 = _timer()
        count = len(scores)
        k = min(top_k, count)
        if count:
            part = np.argpartition(-scores, k - 1)[:k]
            top_rows = part[np.argsort(-scores[part])]
        else:
            top_rows = np.zeros(0, dtype=np.int64)
        card_ids = self.index.card_ids
        hits = [(card_ids[row], float(scores[row])) for row in top_rows]
        timings["search"] = (_timer() - t0) * 1000

        ocr_info: dict = {}
        ocr_result = None
        if use_ocr and self.ocr_reader is not None:
            t0 = _timer()
            ocr_result = self.ocr_reader.read(upright, read_hp=self.read_hp, flipped=flipped)
            timings["ocr"] = (_timer() - t0) * 1000
            ocr_info = {
                "number_local": ocr_result.number_local, "number_total": ocr_result.number_total, "hp": ocr_result.hp,
                "tokens": ocr_result.tokens[:12], "flipped": ocr_result.flipped, "lines": ocr_result.lines[:8],
            }

        name_read = None
        if use_ocr and self.names is not None and hasattr(self.ocr_reader, "read_name"):
            t0 = _timer()
            name_read = self.ocr_reader.read_name(upright, flipped=flipped)
            if name_read.hp and not ocr_info.get("hp"):
                ocr_info["hp"] = name_read.hp
            ocr_info["name"] = name_read.name
            ocr_info["name_lines"] = name_read.raw[:6]
            hits, added = merge_candidates(
                hits, scores, self.index.row_of, self.names, name_read.name,
                ocr_result.number_local if ocr_result else None, ocr_result.number_total if ocr_result else None, top_k,
            )
            ocr_info["text_candidates_added"] = added
            timings["name"] = (_timer() - t0) * 1000

        t0 = _timer()
        loaded = self.candidate_loader([card_id for card_id, _score in hits])
        candidates = []
        for position, (card_id, score) in enumerate(hits, start=1):
            row = loaded.get(card_id)
            if row is None:
                continue
            # _rank: where this printing stands among all pictures (1 = closest); _position: in the final list.
            candidate = {**row, "_db_id": card_id, "_similarity": round(float(score), 4),
                         "_rank": 1 + int((scores > score).sum()) if count else position, "_position": position}
            if name_read is not None:
                candidate["_name_score"] = round(self.names.name_score_of(card_id, name_read.name), 3)
            candidates.append(candidate)
        card_info = (
            ocr_result.as_card_info({c.get("set_abbreviation") for c in candidates if c.get("set_abbreviation")})
            if ocr_result else {}
        )
        card_info["language"] = None  # English-only index: language is not evidence
        corrected = correct_number(card_info, candidates, ocr_result.lines if ocr_result else [])
        if corrected:
            ocr_info["corrected"] = corrected
        chosen, reason = decide(card_info, candidates)
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
            detection={"found": detection.found, "confidence": detection.confidence, "method": detection.method,
                       "corners": [[round(x, 1), round(y, 1)] for x, y in detection.corners]},
            ocr=ocr_info, timings_ms={key: round(value, 1) for key, value in timings.items()},
        )


def merge_candidates(hits, scores, row_of, names, name: str | None, number: str | None, total: str | None, top_k: int = TOP_K):
    """The picture top list and the text candidates as one ranking of at most ``top_k`` printings.

    Returns ``([(card id, picture similarity)], how many came from the text search only)``. Every printing is
    scored ``picture similarity + name, number and total agreement``; the closest ``PICTURE_KEEP`` pictures
    always stay, so a wrong name read can push other printings down but never the picture's own best guesses.
    """
    if names is None or not name:
        return hits, 0
    picture_ids = [card_id for card_id, _score in hits]
    pool: dict[str, float] = {card_id: score for card_id, score in hits}
    for hit in names.search(name, number, total):
        row = row_of.get(hit.card_id)
        if row is not None and hit.card_id not in pool:
            pool[hit.card_id] = float(scores[row])

    def combined(card_id: str) -> float:
        name_score = names.name_score_of(card_id, name)
        agreement = names.agreement(card_id, name_score, number, total)
        bonus = NAME_WEIGHT * max(0.0, (name_score - 0.72) / 0.28)
        bonus += NUMBER_WEIGHT if agreement.number_ok else 0.0
        bonus += TOTAL_WEIGHT if agreement.total_ok else 0.0
        return pool[card_id] + bonus

    keep = picture_ids[:PICTURE_KEEP]
    rest = sorted((card_id for card_id in pool if card_id not in keep), key=lambda card_id: -combined(card_id))
    chosen = keep + rest[:max(0, top_k - len(keep))]
    chosen.sort(key=lambda card_id: -combined(card_id))
    original = set(picture_ids)
    return [(card_id, pool[card_id]) for card_id in chosen], sum(1 for card_id in chosen if card_id not in original)
