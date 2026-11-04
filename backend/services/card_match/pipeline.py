"""photo -> find the card -> embed (0 and 180 degrees) -> top 20 pictures -> read the corners -> decide.

Pure: it reads the index and the catalogue (through ``candidate_loader``) and writes nothing.
The decision reuses the ranking rules in ``api.recognize`` (``_candidate_rank_key`` and
``_metadata_decision``: number, printed total, set code, regulation mark, artist, HP), and adds the
picture evidence on top: a rule decision is only accepted when its printing is also among the
closest pictures; with no usable number, a picture-only decision needs a high similarity and a
clear lead. The thresholds are provisional until the benchmark fixes them.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from . import config, detect as detect_module
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
                    "_lang": card.lang or "en", "images_small": card.images_small,
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
            if chosen["_similarity"] >= SIM_MIN_WITH_RULES and chosen["_rank"] <= RANK_MAX_WITH_RULES:
                return {"candidate": chosen, "mechanism": mechanism, "lead": round(lead, 4)}, None
            return None, "rules_choice_not_close_in_picture"
        if not number_hits:
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
    return None, "no_number_and_picture_not_clear"


class CardMatcher:
    def __init__(self, index: CardIndex, embedder, candidate_loader: CandidateLoader, ocr_reader=None, *, read_hp: bool = False) -> None:
        self.index = index
        self.embedder = embedder
        self.candidate_loader = candidate_loader
        self.ocr_reader = ocr_reader
        self.read_hp = read_hp

    def match(self, photo_rgb: np.ndarray, *, top_k: int = TOP_K, use_ocr: bool = True) -> MatchResult:
        config.apply_thread_caps()
        timings: dict[str, float] = {}
        t0 = _timer()
        detection = detect_module.detect_card(photo_rgb)
        timings["detect"] = (_timer() - t0) * 1000

        t0 = _timer()
        upright = detection.card
        views = [upright, np.ascontiguousarray(upright[::-1, ::-1])]  # 0 and 180 degrees
        vectors = self.embedder.embed(views)
        timings["embed"] = (_timer() - t0) * 1000

        t0 = _timer()
        hits = self.index.search_merged(vectors, top_k)
        timings["search"] = (_timer() - t0) * 1000

        ocr_info: dict = {}
        ocr_result = None
        if use_ocr and self.ocr_reader is not None:
            t0 = _timer()
            ocr_result = self.ocr_reader.read(upright, read_hp=self.read_hp)
            timings["ocr"] = (_timer() - t0) * 1000
            ocr_info = {
                "number_local": ocr_result.number_local, "number_total": ocr_result.number_total, "hp": ocr_result.hp,
                "tokens": ocr_result.tokens[:12],
            }

        t0 = _timer()
        loaded = self.candidate_loader([card_id for card_id, _score in hits])
        candidates = []
        for rank, (card_id, score) in enumerate(hits, start=1):
            row = loaded.get(card_id)
            if row is None:
                continue
            candidates.append({**row, "_db_id": card_id, "_similarity": round(float(score), 4), "_rank": rank})
        card_info = (
            ocr_result.as_card_info({c.get("set_abbreviation") for c in candidates if c.get("set_abbreviation")})
            if ocr_result else {}
        )
        card_info["language"] = None  # English-only index: language is not evidence
        chosen, reason = decide(card_info, candidates)
        timings["decide"] = (_timer() - t0) * 1000
        timings["total"] = sum(timings.values())

        matches = [
            {
                "card_id": c["_db_id"], "tcg_card_id": c["tcg_card_id"], "similarity": c["_similarity"], "rank": c["_rank"],
                "name": c.get("name"), "number": c.get("number"), "set": c.get("set"), "printed_total": c.get("printed_total"),
            }
            for c in candidates
        ]
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
