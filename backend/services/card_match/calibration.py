"""Version 16 test: picture thresholds of their own for a custom picture model (docs/CARD_MATCH.md, "Version 16 test").

The decision rules compare picture similarities and leads to constants set for DINOv2-small's score scale (``pipeline.Thresholds``). A custom
model scores on another scale, so its right first picks can fall under thresholds meant for the other model. This module works out a table for
it from the real scans, on the server (real photos never leave it).

The method does NOT count wrong first picks: there are almost none to learn from, and nearly any threshold gives "0 wrong" on the scans. It keeps
the default model's level of RISK, which every scan measures. For each confirmed scan of the Tuned group and for each model, the same picture
search the matcher uses is run, and the confirmed card and its same-artwork reprints are taken out of the list: what is left are impostors.

- A similarity threshold: the share of scans whose best impostor reaches the default threshold under the default model. The custom threshold is the
  custom model's similarity where its best impostor reaches it on the same share of scans (quantile matching).
- A lead threshold: the same, on the gap between the best and the second-best impostor; the artwork lead on the artwork search's gap.
- Every custom threshold is rounded toward stricter (similarities and leads up, the same-name guard margin down) to 0.01.

Then a safety check: with the table, the full rules must decide nothing wrong on the Tuned group, else nothing is stored.
"""

from __future__ import annotations

import logging
import math
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np

from . import MATCHER_VERSION, benchmark, custom_models, pipeline
from .model_specs import DEFAULT_MODEL

logger = logging.getLogger(__name__)

MIN_SCANS = 100  # scans in the Tuned group below which the calibration refuses
TOP_FOR_IMPOSTORS = 60  # how many of the closest pictures are looked at to find the first two impostors
SIM_FIELDS = ("sim_min_with_rules", "sim_min_picture_only", "sim_min_picture_strong", "sim_min_name_picture", "lookup_sim_set", "lookup_sim_total",
              "whole_sim_min")  # of the picture score; whole_sim_min is SIM_MIN_WITH_RULES + WHOLE_SIM_MARGIN as one number
LEAD_FIELDS = ("lead_min_picture_only", "lead_min_picture_strong", "lead_min_name_picture")  # of the picture score
ART_LEAD_FIELDS = ("reprint_art_lead",)  # of the artwork-only score
GUARD_FIELDS = ("same_name_picture_margin",)  # a guard: smaller is stricter, and never looser than the default


class CalibrationError(Exception):
    """The calibration refuses or fails; the message is shown in Scanner lab. Nothing is stored."""


# ── The pure parts ──────────────────────────────────────────────────────────────────────────────────────────────────

def round_up(value: float) -> float:
    """To 0.01, toward larger (the 1e-6 keeps a value that is 0.80 up to float noise at 0.80)."""
    return round(math.ceil(value * 100 - 1e-6) / 100, 2)


def round_down(value: float) -> float:
    return round(math.floor(value * 100 + 1e-6) / 100, 2)


def _tail_scale(default: np.ndarray, custom: np.ndarray, top: bool) -> float:
    """How much further the custom model's tail runs than the default's (median to the extreme), for a threshold beyond the data."""
    mid = len(default) // 2
    d_span = (default[-1] - default[mid]) if top else (default[mid] - default[0])
    c_span = (custom[-1] - custom[mid]) if top else (custom[mid] - custom[0])
    if d_span <= 1e-9 or c_span <= 1e-9:
        return 1.0
    return float(c_span / d_span)


def quantile_map(default_values, custom_values, x: float) -> float:
    """The custom value at the place ``x`` holds among the default values (same share of scans at or above it). Both lists are the best-impostor
    values of the SAME scans. Inside the data this reads the custom quantile at the default's rank (linear between scans), so the default model
    against itself returns ``x``; beyond the largest (or smallest) value no scan reaches (or every scan reaches) ``x`` and the custom value is
    placed beyond its own largest (smallest) one by the distance scaled with the tails' ratio, so a threshold no impostor reaches stays one."""
    d = np.sort(np.asarray(default_values, dtype=float))
    c = np.sort(np.asarray(custom_values, dtype=float))
    if len(d) != len(c) or len(d) == 0:
        raise ValueError("The two lists must hold the same scans")
    if len(d) == 1:
        return float(c[0] + (x - d[0]))
    ranks = np.arange(len(d), dtype=float)
    if x > d[-1]:
        return float(c[-1] + (x - d[-1]) * _tail_scale(d, c, True))
    if x < d[0]:
        return float(c[0] - (d[0] - x) * _tail_scale(d, c, False))
    return float(np.interp(float(np.interp(x, d, ranks)), ranks, c))


def calibrate_table(default_stats: dict, custom_stats: dict, base: "pipeline.Thresholds | None" = None) -> dict:
    """``{threshold name: custom value}`` from the best-impostor values of the two models. ``*_stats``: ``best`` (best impostor's picture
    score per scan), ``gap`` (best minus second-best impostor), ``art_gap`` (the same on the artwork score), each one value per scan, the
    two models' lists in the same scan order. ``base``: the default table (today's constants)."""
    base = (base or pipeline.default_thresholds()).as_dict()
    out: dict[str, float] = {}
    for name in SIM_FIELDS:
        out[name] = round_up(quantile_map(default_stats["best"], custom_stats["best"], base[name]))
    for name in LEAD_FIELDS:
        out[name] = round_up(quantile_map(default_stats["gap"], custom_stats["gap"], base[name]))
    for name in ART_LEAD_FIELDS:
        out[name] = round_up(quantile_map(default_stats["art_gap"], custom_stats["art_gap"], base[name]))
    for name in GUARD_FIELDS:  # a bigger margin refuses less: never looser than the default
        out[name] = round_down(min(base[name], quantile_map(default_stats["gap"], custom_stats["gap"], base[name])))
    out["whole_sim_min"] = max(out["whole_sim_min"], out["sim_min_with_rules"])  # the whole-picture number rule is never below the normal floor
    return {name: out[name] for name in pipeline.THRESHOLD_FIELDS}


def same_artwork(truth: dict | None, other: dict | None) -> bool:
    """A reprint with the same artwork: the same name and the same known artist. (An unknown artist is not taken for a match: leaving an
    impostor in makes the thresholds stricter, never looser.)"""
    from . import names

    if not truth or not other:
        return False
    key = names.name_key(truth.get("name") or "")
    artist = (truth.get("artist") or "").strip().casefold()
    return bool(key and artist and names.name_key(other.get("name") or "") == key and (other.get("artist") or "").strip().casefold() == artist)


def best_two_impostors(scores: np.ndarray, card_ids: list[str], truth_id: str, info: Callable[[list[str]], dict[str, dict]],
                       top: int = TOP_FOR_IMPOSTORS) -> tuple[float, float]:
    """(best, second-best) score among the closest pictures with the confirmed card and its same-artwork reprints taken out. ``info`` loads
    catalogue rows (name, artist) for card ids. With fewer than two left the missing one is 0."""
    count = len(scores)
    if count == 0:
        return 0.0, 0.0
    k = min(count, top)
    part = np.argpartition(-scores, k - 1)[:k]
    order = part[np.argsort(-scores[part])]
    ids = [card_ids[row] for row in order]
    rows = info(list(dict.fromkeys(ids + [truth_id])))
    truth = rows.get(truth_id)
    kept = [float(scores[row]) for row, card_id in zip(order, ids) if card_id != truth_id and not same_artwork(truth, rows.get(card_id))]
    return (kept[0] if kept else 0.0), (kept[1] if len(kept) > 1 else 0.0)


# ── Reading the scans ───────────────────────────────────────────────────────────────────────────────────────────────

def tuned_traces(default_ids, custom_ids, trace_dir: Path | None) -> list[tuple[dict, Path]]:
    """The confirmed scans of the Tuned group (not held back; the owner's scans before ``NEW_SCANS_FROM`` and a read-only source's scans for
    tuning) whose card both models index."""
    from . import ocr_check
    from services import trace_sources

    indexed = set(default_ids) & set(custom_ids)
    out = []
    for data, path in ocr_check.labelled_traces(trace_dir):
        if trace_sources.is_held_back(data):
            continue
        if benchmark.eval_group(trace_sources.group_of(data), benchmark.scan_batch(data)) != "tuned":
            continue
        if f"{data['ground_truth']}_en" in indexed:
            out.append((data, path))
    return out


def scoring_matchers(session_factory, *, model_id: str, data_dir: Path | None = None):
    """(default matcher, custom matcher): the set in use's picture search (test-time views, the artwork index, the card finder) with the default
    model and with the custom one. Only their picture-search methods are used: no text is read."""
    from . import variants

    base = replace(variants.parse(variants.PIN_LABEL), names=False, number=False, text=False, custom=False, calibrated=False)
    default = variants._build_matcher(base, session_factory, data_dir=data_dir, ocr_reader=object())
    custom = variants._build_matcher(replace(base, custom=True, art=True), session_factory, data_dir=data_dir, ocr_reader=object(), custom_name=model_id)
    return default, custom


def _scan_values(matcher, card, truth_id: str, info) -> dict:
    """The matcher's own picture search on the flat card (its orientation from the picture alone), as impostor values."""
    best, top_upright, top_turned = matcher._main_scores(card)
    flipped = bool(len(best)) and top_turned - top_upright >= pipeline.ORIENT_MARGIN
    art: dict = {}
    scores = matcher._picture_scores(best, card, flipped, art)
    ids = matcher.index.card_ids
    first, second = best_two_impostors(scores, ids, truth_id, info)
    out = {"best": first, "gap": first - second}
    if "art" in art:
        art_first, art_second = best_two_impostors(np.asarray(art["art"]), ids, truth_id, info)
        out["art_gap"] = art_first - art_second
    return out


def collect_stats(session_factory, default_matcher, custom_matcher, scans, *, progress=None, should_stop=None) -> tuple[dict, dict]:
    """Impostor values of every scan for both models: ``(default stats, custom stats)``, each ``{best, gap, art_gap}`` lists in scan order."""
    from .images import decode_rgb

    info_cache: dict[str, dict] = {}
    loader = default_matcher.candidate_loader

    def info(ids: list[str]) -> dict[str, dict]:
        missing = [card_id for card_id in ids if card_id not in info_cache]
        if missing:
            info_cache.update(loader(missing) or {})
            for card_id in missing:
                info_cache.setdefault(card_id, {})
        return {card_id: info_cache[card_id] for card_id in ids}

    stats = ({"best": [], "gap": [], "art_gap": []}, {"best": [], "gap": [], "art_gap": []})
    for position, (data, path) in enumerate(scans, start=1):
        if should_stop and should_stop():
            raise CalibrationError("Stopped")
        if progress:
            progress({"phase": "impostors", "done": position - 1, "total": len(scans)})
        truth_id = f"{data['ground_truth']}_en"
        try:
            photo = decode_rgb((path.parent / data["image_file"]).read_bytes(), max_side=2048)
        except Exception:
            raise CalibrationError(f"Could not read the photo of scan {path.name}")
        review = benchmark.review_photo_loader(session_factory, data)
        detection, _fallback = default_matcher._find_card(photo, None, review)
        for matcher, bucket in ((default_matcher, stats[0]), (custom_matcher, stats[1])):
            values = _scan_values(matcher, detection.card, truth_id, info)
            for key in ("best", "gap", "art_gap"):
                bucket[key].append(values.get(key, 0.0))
    return stats


def check_ready(model_id: str, data_dir: Path | None = None) -> dict:
    """The registry entry, or ``CalibrationError`` saying what is missing: the model's two indexes and the default model's two."""
    from . import index as index_module, variants

    entry = custom_models.get_model(model_id, data_dir)
    if entry is None:
        raise CalibrationError("Unknown model")
    missing = [name for name in (*custom_models.index_names(model_id).values(), DEFAULT_MODEL, variants.ART_INDEX)
               if not (index_module.index_status(name, data_dir).get("built") and index_module.index_status(name, data_dir).get("count"))]
    if missing:
        raise CalibrationError(f"Build the indexes first (missing: {', '.join(missing)})")
    return entry


def safety_check(session_factory, model_id: str, table: dict, *, data_dir: Path | None, trace_dir: Path | None, progress=None, should_stop=None) -> dict:
    """The full rules (picture, text and all) with ``table`` on the Tuned group: ``{n, decided, wrong}``."""
    from . import variants
    from .ocr import get_reader

    options = variants.parse(variants.V16_LABELS[1])
    matcher = variants._build_matcher(options, session_factory, data_dir=data_dir, ocr_reader=get_reader(), custom_name=model_id,
                                      thresholds=pipeline.Thresholds.from_dict(table))
    report = benchmark.run_labelled(session_factory, matcher, trace_dir=trace_dir, progress=progress, should_stop=should_stop, held_back="skip")
    if report is None:
        raise CalibrationError("No confirmed scans to check the thresholds on")
    return dict((report.get("eval_groups") or {}).get("tuned") or {"n": 0, "decided": 0, "wrong": 0})


def run_calibration(model_id: str, session_factory, *, data_dir: Path | None = None, trace_dir: Path | None = None,
                    progress: Callable[[dict], None] | None = None, should_stop: Callable[[], bool] | None = None) -> dict:
    """Calibrate one custom model and store the result in its registry entry. Raises ``CalibrationError`` (nothing stored) when it refuses
    (indexes not built, fewer than ``MIN_SCANS`` Tuned scans), is stopped, or the safety check finds a wrong decision. Returns the stored calibration."""
    from . import index as index_module

    entry = check_ready(model_id, data_dir)
    default_index = index_module.get_index(DEFAULT_MODEL, data_dir)
    custom_index = index_module.get_index(model_id, data_dir)
    if default_index is None or custom_index is None:
        raise CalibrationError("Build the indexes first")
    scans = tuned_traces(default_index.card_ids, custom_index.card_ids, trace_dir)
    if len(scans) < MIN_SCANS:
        raise CalibrationError(f"Only {len(scans)} confirmed scans in the Tuned group: at least {MIN_SCANS} are needed to calibrate")
    default_matcher, custom_matcher = scoring_matchers(session_factory, model_id=model_id, data_dir=data_dir)
    default_stats, custom_stats = collect_stats(session_factory, default_matcher, custom_matcher, scans, progress=progress, should_stop=should_stop)
    table = calibrate_table(default_stats, custom_stats)
    checked = safety_check(session_factory, model_id, table, data_dir=data_dir, trace_dir=trace_dir, progress=progress, should_stop=should_stop)
    if should_stop and should_stop():
        raise CalibrationError("Stopped")
    if checked.get("wrong"):
        raise CalibrationError(
            f"The calibrated thresholds decided {checked['wrong']} scan(s) wrong on the Tuned group ({checked.get('n')} scans), so they were not stored")
    default = pipeline.default_thresholds().as_dict()
    calibration = {
        "at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "scans": len(scans), "matcher_version": MATCHER_VERSION,
        "thresholds": table, "default": {name: round(value, 4) for name, value in default.items()},
        "tuned_decided": checked.get("decided"), "tuned_wrong": checked.get("wrong", 0),
    }
    custom_models.store_calibration(entry["id"], calibration, data_dir)
    return calibration
