"""Matcher version 13 test: a learned decision rule (option ``learned``, off by default, comparison rows only).

The hand-set rules in ``pipeline.decide`` refuse many first picks that are right (the first pick is right ~98% of the time but only
72-77% of scans are decided). This module learns, from the scans used for tuning, how likely the *first* candidate is right, from
features the matcher already measures. It is small on purpose: logistic regression with L2 in numpy, standardised features, and a
probability threshold chosen by cross-validation as the lowest one with 0 wrong decisions across all folds, plus a margin.

Rules still come first: the learned rule only looks at a scan the rules left unsure, only at its first candidate, and it never
overturns a rules decision (see ``pipeline.CardMatcher.match``). Nothing here touches a photo: a scan is reduced to ~30 numbers.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import config

MODEL_FILE = "learned-decision.json"
MECHANISM = "learned"
SAFETY_MARGIN = 0.02  # added to the lowest 0-wrong threshold: the cross-validation saw only a handful of wrong first picks
MAX_THRESHOLD = 0.9999  # a threshold above this means no safe threshold was found: the rule is saved but never decides
FOLDS = 5
L2_GRID = (0.3, 1.0, 3.0, 10.0)
MIN_SCANS = 20
MIN_WRONG = 2  # with fewer wrong first picks there is nothing to learn a "no" from, and no threshold can be checked

REASONS = (
    "number_matches_several_printings", "number_not_among_picture_matches", "rules_choice_not_close_in_picture",
    "no_number_and_picture_not_clear", "closer_printing_of_same_name",
)
LOOKUP_LEVELS = {"number_total_set": 3.0, "number_total": 2.0, "number_set": 1.0, "number": 0.5}

FEATURES = (
    "similarity", "picture_rank", "lead", "art_similarity", "has_art", "art_lead",
    "number_read", "number_names_one", "number_names_several", "number_names_none",
    "first_number_match", "total_read", "first_total_match", "first_total_contradicts", "number_corrected",
    "number_source_finder", "number_source_whole", "number_confidence",
    "name_read", "name_score", "name_known", "name_conflict", "set_code_match",
    "finder_confidence", "finder_found", "fallback", "lookup_level", "lookup_unique", "text_score",
) + tuple(f"reason_{reason}" for reason in REASONS)


def _flag(value) -> float:
    return 1.0 if value else 0.0


def extract(candidates: list[dict], card_info: dict, ocr_info: dict, detection: dict, *, fallback: str | None,
            reason: str | None) -> dict | None:
    """The numbers about the *first* candidate (the merged ranking's top one) a learned rule judges, or None when there is no candidate.
    ``eligible`` says whether the learned rule may decide this scan at all (a card the finder did not find never is)."""
    from api import recognize as rules

    if not candidates:
        return None
    first = candidates[0]
    others = candidates[1:]
    best_other = max((c["_similarity"] for c in others), default=0.0)
    art_others = [c.get("_art_similarity") for c in others if c.get("_art_similarity") is not None]
    art = first.get("_art_similarity")
    number = card_info.get("number_local")
    hits = [c for c in candidates if rules._numbers_match(number, c.get("number"))] if number else []
    total = card_info.get("number_total")
    signal = rules._printed_total_signal(total, first.get("printed_total")) if total else 1
    source = (ocr_info or {}).get("number_source")
    set_code, first_set = card_info.get("set_code"), first.get("set_abbreviation")
    values = {
        "similarity": float(first["_similarity"]),
        "picture_rank": min(int(first.get("_rank", 1)), 40) / 40.0,
        "lead": max(-0.3, min(0.3, float(first["_similarity"]) - best_other)),
        "art_similarity": float(art) if art is not None else 0.0,
        "has_art": _flag(art is not None),
        "art_lead": max(-0.3, min(0.3, float(art) - max(art_others))) if art is not None and art_others else 0.0,
        "number_read": _flag(number),
        "number_names_one": _flag(number and len(hits) == 1),
        "number_names_several": _flag(number and len(hits) > 1),
        "number_names_none": _flag(number and not hits),
        "first_number_match": _flag(number and rules._numbers_match(number, first.get("number"))),
        "total_read": _flag(total),
        "first_total_match": _flag(total and signal == 0),
        "first_total_contradicts": _flag(total and signal == 2),
        "number_corrected": _flag((ocr_info or {}).get("corrected") or (ocr_info or {}).get("number_from_lookup")),
        "number_source_finder": _flag(number and source == "finder_card"),
        "number_source_whole": _flag(number and source == "whole_picture"),
        "number_confidence": float((ocr_info or {}).get("number_confidence") or 0.0) if number else 0.0,
        "name_read": _flag((ocr_info or {}).get("name")),
        "name_score": float(first.get("_name_score", 0.0)),
        "name_known": _flag(first.get("_name_known")),
        "name_conflict": _flag(first.get("_name_known") and first.get("_name_score", 0.0) <= 0.0),
        "set_code_match": _flag(set_code and first_set and str(set_code).upper() == str(first_set).upper()),
        "finder_confidence": float((detection or {}).get("confidence") or 0.0),
        "finder_found": _flag((detection or {}).get("found")),
        "fallback": _flag(fallback),
        "lookup_level": LOOKUP_LEVELS.get(first.get("_lookup"), 0.0),
        "lookup_unique": _flag(first.get("_lookup_unique")),
        "text_score": float(first.get("_text_score", 0.0)),
    }
    for name in REASONS:
        values[f"reason_{name}"] = _flag(reason == name)
    return {"values": values, "card_id": first["_db_id"], "eligible": fallback is None}


def vector(values: dict, features=FEATURES) -> np.ndarray:
    return np.array([float(values.get(name, 0.0)) for name in features], dtype=float)


# ── The model ────────────────────────────────────────────────────────────────

def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35.0, 35.0)))


def fit(x: np.ndarray, y: np.ndarray, l2: float, iterations: int = 60) -> dict:
    """Logistic regression with an L2 penalty (the bias is not penalised), by Newton steps on standardised features."""
    mean = x.mean(axis=0)
    std = x.std(axis=0)
    std[std < 1e-9] = 1.0
    z = (x - mean) / std
    design = np.hstack([z, np.ones((len(z), 1))])
    weights = np.zeros(design.shape[1])
    penalty = np.eye(design.shape[1]) * l2
    penalty[-1, -1] = 0.0
    for _ in range(iterations):
        p = _sigmoid(design @ weights)
        gradient = design.T @ (p - y) + penalty @ weights
        hessian = (design * (p * (1 - p))[:, None]).T @ design + penalty + np.eye(design.shape[1]) * 1e-8
        step = np.linalg.solve(hessian, gradient)
        weights = weights - step
        if float(np.abs(step).max()) < 1e-8:
            break
    return {"weights": weights[:-1].tolist(), "bias": float(weights[-1]), "mean": mean.tolist(), "std": std.tolist(), "l2": l2}


def predict(model: dict, x: np.ndarray) -> np.ndarray:
    x = np.atleast_2d(x)
    z = (x - np.array(model["mean"])) / np.array(model["std"])
    return _sigmoid(z @ np.array(model["weights"]) + model["bias"])


def folds_of(y: np.ndarray, k: int) -> list[np.ndarray]:
    """Deterministic folds with the wrong first picks spread over them (round robin within each class)."""
    k = max(2, min(k, int((y == 0).sum()) or 2))
    assignment = np.zeros(len(y), dtype=int)
    for label in (0, 1):
        for turn, index in enumerate(np.flatnonzero(y == label)):
            assignment[index] = (turn + (label * 2)) % k
    return [np.flatnonzero(assignment == fold) for fold in range(k)]


def zero_wrong_threshold(probabilities: np.ndarray, y: np.ndarray, margin: float = SAFETY_MARGIN) -> float:
    """The lowest probability at which no wrong first pick is decided (just above the highest wrong one), plus the margin."""
    wrong = probabilities[y == 0]
    base = float(wrong.max()) if len(wrong) else 0.0
    return round(min(1.0, base + 1e-6 + margin), 6)


def cross_validate(x: np.ndarray, y: np.ndarray, l2: float, k: int = FOLDS) -> np.ndarray:
    """Every scan's probability from a model that never saw it."""
    out = np.zeros(len(y))
    for held in folds_of(y, k):
        train = np.ones(len(y), dtype=bool)
        train[held] = False
        out[held] = predict(fit(x[train], y[train], l2), x[held])
    return out


def train(rows: list[dict], *, features=FEATURES, margin: float = SAFETY_MARGIN, folds: int = FOLDS) -> dict:
    """``rows``: ``{"values": {...}, "right": bool}`` for the tuning scans the rules left unsure and the learned rule may judge.
    Returns the model document (see ``save``). Raises ValueError when there is too little to learn from or to check a threshold on."""
    if len(rows) < MIN_SCANS:
        raise ValueError(f"Only {len(rows)} scans to train on; at least {MIN_SCANS} are needed")
    x = np.array([vector(r["values"], features) for r in rows])
    y = np.array([1.0 if r["right"] else 0.0 for r in rows])
    wrong = int((y == 0).sum())
    if wrong < MIN_WRONG:
        raise ValueError(f"Only {wrong} wrong first picks among {len(rows)} scans: a threshold cannot be checked with fewer than {MIN_WRONG}")
    best = None
    for l2 in L2_GRID:
        probabilities = cross_validate(x, y, l2, folds)
        threshold = zero_wrong_threshold(probabilities, y, margin)
        decided = int(((probabilities >= threshold) & (y == 1)).sum())
        if best is None or decided > best[0] or (decided == best[0] and l2 > best[1]):
            best = (decided, l2, threshold, probabilities)
    decided, l2, threshold, probabilities = best
    usable = threshold <= MAX_THRESHOLD
    return {
        "version": 1, "features": list(features), "model": fit(x, y, l2), "threshold": threshold, "usable": usable, "margin": margin,
        "cross_validation": {
            "folds": len(folds_of(y, folds)), "l2": l2, "decided_right": decided, "decided_wrong": int(((probabilities >= threshold) & (y == 0)).sum()),
            "of": len(rows),
        },
        "counts": {"scans": len(rows), "first_right": int(y.sum()), "first_wrong": wrong},
        "trained_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }


# ── Where it lives, and using it ────────────────────────────────────────────

def model_path(data_dir: Path | None = None) -> Path:
    return (data_dir or config.data_dir()) / MODEL_FILE


def save(document: dict, data_dir: Path | None = None, **info) -> Path:
    from . import MATCHER_VERSION

    path = model_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps({**document, **info, "matcher_version": MATCHER_VERSION}, indent=1), encoding="utf-8")
    temp.replace(path)
    return path


def load_document(data_dir: Path | None = None) -> dict | None:
    try:
        document = json.loads(model_path(data_dir).read_text(encoding="utf-8"))
        return document if isinstance(document, dict) and document.get("model") and document.get("features") else None
    except (OSError, ValueError):
        return None


def summary(data_dir: Path | None = None) -> dict | None:
    """What the lab shows (no weights): when it was trained, on how many scans, the threshold, and the cross-validation result."""
    document = load_document(data_dir)
    if document is None:
        return None
    keys = ("trained_at", "threshold", "usable", "margin", "cross_validation", "counts", "matcher_version", "trained_with")
    return {key: document.get(key) for key in keys}


class LearnedRule:
    def __init__(self, document: dict) -> None:
        self.features = tuple(document["features"])
        self.model = document["model"]
        self.threshold = float(document["threshold"])
        self.usable = bool(document.get("usable", True)) and self.threshold <= MAX_THRESHOLD

    def probability(self, values: dict) -> float:
        return float(predict(self.model, vector(values, self.features))[0])

    def decides(self, extracted: dict | None) -> float | None:
        """The probability when this rule would decide the scan (usable, eligible, at or above the threshold), else None."""
        if not self.usable or not extracted or not extracted.get("eligible"):
            return None
        p = self.probability(extracted["values"])
        return p if p >= self.threshold and not math.isnan(p) else None


def load(data_dir: Path | None = None) -> LearnedRule | None:
    document = load_document(data_dir)
    return LearnedRule(document) if document else None


# ── Which scans are used for training ───────────────────────────────────────

def is_tuning(data: dict) -> bool:
    """The group training may use: the owner's own scans made before ``benchmark.NEW_SCANS_FROM`` and a read-only source's scans that are
    not held back. The owner's newer scans and every held-back scan are never trained on (they are the honest test)."""
    from services import trace_sources

    from . import benchmark

    group = trace_sources.group_of(data)
    if group == trace_sources.GROUP_LOCAL:
        return benchmark.scan_batch(data) == "tuning"
    return not group.endswith("_held_back")
