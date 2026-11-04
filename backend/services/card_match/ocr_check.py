"""The "OCR check" of Scanner lab: how well the text reader reads the confirmed real photos, on its own.

The labelled benchmark measures the whole matcher; when a card is missed it cannot say whether the regions were
wrong, the reading was wrong, or the lookup was. This runs only the reader over every confirmed trace and
compares what it read with the confirmed card's printed name, number, total and set code. Results are split by
the resolution the text was read from: ``1024`` (older traces: the 1024 px recognition crop, a card 880 px tall)
and ``full`` (traces that stored the full-resolution flat card). Each trace is read three ways, so the cause of a
miss is visible:

  fixed    version 4's fixed strips only (the wide strips only when the tight ones found no complete number);
  detect   the full ladder: fast strips, then the whole bottom band under preprocessing variants, then the whole card;
  <variant> one read of the whole bottom band (and of the name band) under one preprocessing variant, so which
           preprocessing helps on real photos is measured, not assumed.

Everything here is read-only; the report lands next to the other benchmark reports.
"""

from __future__ import annotations

import difflib
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import MATCHER_VERSION, ocr as ocr_module

logger = logging.getLogger(__name__)

MAX_FAILURES = 40


def _clean(text) -> str:
    return "".join(ch for ch in str(text or "").casefold() if ch.isalnum())


def names_match(read: str | None, truth: str | None) -> bool:
    """The read name is the printed name (a stray symbol or a dropped letter is fine)."""
    left, right = _clean(read), _clean(truth)
    if not left or not right:
        return False
    return difflib.SequenceMatcher(None, left, right).ratio() >= 0.85


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(fraction * (len(ordered) - 1) + 0.5))], 3)


def labelled_traces(trace_dir: Path) -> list[tuple[dict, Path]]:
    """The traces with a confirmed answer and a stored photo, one per scan (as the labelled benchmark takes them)."""
    traces: dict[tuple, tuple[dict, Path]] = {}
    for path in sorted(trace_dir.glob("user-*/*/*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        image_name = data.get("image_file")
        if not data.get("ground_truth") or not image_name or not (path.parent / image_name).is_file():
            continue
        traces[(data.get("user_id"), data.get("job_id"), data.get("item_id"), path.name if data.get("job_id") is None else "")] = (data, path)
    return list(traces.values())


def new_bucket() -> dict:
    return {"n": 0, "name": 0, "number": 0, "total": 0, "set_code": 0, "seconds": []}


def score_read(bucket: dict, *, truth: dict, name: str | None, result, seconds: float) -> dict:
    """Count one trace's reading into ``bucket``; returns what was right, for the failure list."""
    from .benchmark import _numbers_equal, _totals_equal

    abbreviation = truth.get("set_abbreviation")
    info = result.as_card_info({abbreviation} if abbreviation else None)
    right = {
        "name": names_match(name, truth.get("name")),
        "number": bool(result.number_local and _numbers_equal(result.number_local, truth.get("number"))),
        "total": bool(result.number_total and truth.get("printed_total") and _totals_equal(result.number_total, truth.get("printed_total"))),
        "set_code": bool(abbreviation and info.get("set_code") == str(abbreviation).upper()),
    }
    bucket["n"] += 1
    for key, ok in right.items():
        bucket[key] += 1 if ok else 0
    bucket["seconds"].append(seconds)
    return right


def summarise(bucket: dict) -> dict:
    n = bucket["n"]
    out = {"n": n}
    for key in ("name", "number", "total", "set_code"):
        out[key] = bucket[key]
        out[f"{key}_pct"] = round(100 * bucket[key] / n, 1) if n else None
    out["seconds_mean"] = round(sum(bucket["seconds"]) / n, 3) if n else None
    out["seconds_p95"] = _percentile(bucket["seconds"], 0.95)
    return out


def read_both(reader, card, mode: str):
    """(ocr result, name, seconds) for one card in one reader mode. The turned card is tried too when the
    upright one gave no number (the live matcher knows the orientation from the picture; the check does not)."""
    previous, reader.mode = reader.mode, mode
    try:
        started = time.perf_counter()
        result = reader.read(card, read_hp=False, flipped=None)
        name = reader.read_name(card, flipped=result.flipped).name
        if not name and not result.flipped:
            name = reader.read_name(card, flipped=True).name
        return result, name, time.perf_counter() - started
    finally:
        reader.mode = previous


def read_variant(reader, card, variant: str):
    """One read of the bottom band and of the name band under one preprocessing variant (None: it changes nothing here)."""
    from . import names

    previous, reader.mode = reader.mode, "detect"
    try:
        started = time.perf_counter()
        spec = {"plain": 3.0, "sharp": 3.0, "clahe": 2.5, "binary": 3.0, "deglare": 2.5}[variant]
        bottom = reader._scan(card, "bottom-band", ocr_module.BOTTOM_BAND, variant, spec, True, [], False)
        top = reader._scan(card, "name-band", ocr_module.NAME_BAND, variant, spec, True, [], False)
        if bottom is None and top is None:
            return None
        result, confidence = ocr_module.pick_number_lines(bottom or [])
        result.number_confidence = confidence
        found = [line for line in (top or []) if ocr_module.is_name_like(line.text)]
        name = names.parse_name_lines([(line.text, line.height) for line in found]).name
        return result, name, time.perf_counter() - started
    finally:
        reader.mode = previous


def run_ocr_check(
    session_factory, reader, *, trace_dir: Path, progress: Callable[[dict], None] | None = None, should_stop: Callable[[], bool] | None = None,
) -> dict | None:
    """Read every confirmed real trace and report what was read right, by resolution. None without usable traces."""
    from . import detect
    from .benchmark import load_stored_card
    from .images import decode_rgb
    from .pipeline import db_candidate_loader

    started = time.monotonic()
    report_progress = progress or (lambda _state: None)
    loader = db_candidate_loader(session_factory)
    traces = labelled_traces(trace_dir)
    if not traces:
        return None
    modes = ("fixed", "detect")
    variants = ocr_module.VARIANTS
    buckets: dict[str, dict] = {}
    failures: list[dict] = []
    skipped = 0

    def bucket_for(resolution: str, key: str) -> dict:
        return buckets.setdefault(resolution, {}).setdefault(key, new_bucket())

    for position, (data, path) in enumerate(traces, start=1):
        if should_stop and should_stop():
            break
        report_progress({"phase": "ocr-check", "done": position - 1, "total": len(traces)})
        truth_id = f"{data['ground_truth']}_en"
        truth = (loader([truth_id]) or {}).get(truth_id)
        if truth is None:
            skipped += 1
            continue
        try:
            card = load_stored_card(path, data)
            resolution = "full"
            if card is None:
                found = detect.detect_card(decode_rgb((path.parent / data["image_file"]).read_bytes(), max_side=1024))
                if not found.found:
                    skipped += 1
                    continue
                card, resolution = found.card, "1024"
            if card is not None and card.shape[0] <= detect.CARD_H * 1.05 and resolution == "full":
                resolution = "1024"  # a stored card no sharper than the crop reads like one
        except Exception:
            logger.exception("OCR check: could not load %s", path.name)
            skipped += 1
            continue
        rights: dict[str, dict] = {}
        for mode in modes:
            result, name, seconds = read_both(reader, card, mode)
            for res in (resolution, "all"):
                rights[mode] = score_read(bucket_for(res, mode), truth=truth, name=name, result=result, seconds=seconds)
            if mode == "detect" and not (rights[mode]["name"] and rights[mode]["number"]) and len(failures) < MAX_FAILURES:
                failures.append({
                    "trace": path.name, "resolution": resolution, "height": int(card.shape[0]),
                    "truth": {"name": truth.get("name"), "number": truth.get("number"), "total": truth.get("printed_total"), "set": truth.get("set_abbreviation")},
                    "read": {"name": name, "number": result.number_local, "total": result.number_total, "confidence": result.number_confidence},
                    "right": rights[mode], "lines": result.lines[:8],
                })
        for variant in variants:
            got = read_variant(reader, card, variant)
            if got is None:
                continue
            result, name, seconds = got
            for res in (resolution, "all"):
                score_read(bucket_for(res, f"variant:{variant}"), truth=truth, name=name, result=result, seconds=seconds)
    report = {
        "kind": "ocr-check", "matcher_version": MATCHER_VERSION, "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "traces": len(traces), "skipped": skipped,
        "by_resolution": {
            res: {key: summarise(bucket) for key, bucket in rows.items()} for res, rows in sorted(buckets.items())
        },
        "modes": {"fixed": "version 4's fixed strips", "detect": "fast strips, then bottom band under preprocessing variants, then the whole card",
                  "variant:<name>": "one read of the bottom band and the name band under one preprocessing variant"},
        "failures": failures,
        "duration_seconds": round(time.monotonic() - started, 1),
    }
    return report
