"""The Phase 1 benchmark (docs/SCAN_RESEARCH.md section 3.8) for the picture matcher.

Two modes, one report shape:
  - synthetic: about 400 English cards (reprint traps, holo and full-art, the rest random), a
    phone-like photo made from each card's high-resolution TCGdex picture, run through the pipeline;
  - labelled: the diagnostics traces under SCAN_TRACE_DIR that have a confirmed answer, run through the
    same pipeline, with what today's Ollama path got on those traces next to it, and (shadow mode) what the
    matcher itself recorded at scan time; where the two paths decided differently, who was right.
Reports are JSON files under ``<data dir>/reports``. Synthetic photos are made from the same artwork
the index holds, so they are an optimistic upper bound; the labelled run is the honest one.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import random
import statistics
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import MATCHER_VERSION, config, misses as misses_module, shadow as shadow_module
from .index import CardIndex, get_index, index_status, tcg_card_id

logger = logging.getLogger(__name__)

# Phase 1 pass bar (docs/SCAN_RESEARCH.md section 3.8).
BAR_TOP20 = 0.97
BAR_DECIDED = 0.70
BAR_DECIDED_RIGHT = 0.98
BAR_P95_MS = 1500
# ``pick_winner`` lets an option set through up to 10% over the bar: two runs of the same set on the same photos
# differed by 170 ms in version 5, so a 60 ms miss is noise. The displayed pass bar stays at BAR_P95_MS.
P95_PICK_TOLERANCE = 0.10
PICK_MAX_P95_MS = round(BAR_P95_MS * (1 + P95_PICK_TOLERANCE))  # 1650
BAR_EXTRA_RAM_MB = 1536

HOLO_WORDS = ("holo", "illustration", "ultra", "secret", "full art", "rainbow", "hyper", "special", "amazing", "radiant", "shiny")
STAGES = ("detect", "embed", "search", "ocr", "name", "decide", "total")
HIRES_DELAY_SECONDS = 0.2
MAX_WRONG_SCANS = 50  # per run: an option set that decides many wrong is not picked anyway


def reports_dir(data_dir: Path | None = None) -> Path:
    return (data_dir or config.data_dir()) / "reports"


def rss_mb() -> float | None:
    """Resident memory of this process now, in MB (Linux; None elsewhere)."""
    try:
        with open("/proc/self/statm") as handle:
            return int(handle.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1048576
    except (OSError, ValueError, AttributeError):
        return None


def peak_rss_mb() -> float | None:
    try:
        with open("/proc/self/status") as handle:
            for line in handle:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1]) / 1024
    except (OSError, ValueError):
        pass
    try:
        import resource

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except (ImportError, AttributeError):
        return None


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
    return ordered[position]


def timing_summary(rows: list[dict]) -> dict:
    out = {}
    for stage in STAGES:
        values = [row[stage] for row in rows if stage in row]
        if values:
            out[stage] = {"median": round(statistics.median(values), 1), "p95": round(percentile(values, 0.95), 1),
                          "mean": round(statistics.fmean(values), 1), "n": len(values)}
    return out


def pct(part: int, whole: int) -> float | None:
    return round(100 * part / whole, 1) if whole else None


# ── Choosing the synthetic set ────────────────────────────────────────────────

def choose_cards(db, index: CardIndex, count: int = 400, seed: int = 1, traps: int = 50, holo: int = 80) -> list[dict]:
    """Sample indexed English cards: reprint traps (a name with several printings), holo / full-art
    rarities, and the rest random. Each entry: id, tcg id, name, number, rarity, images_large, tags."""
    from models import Card

    rnd = random.Random(seed)
    indexed = set(index.card_ids)
    rows = [
        row for row in db.query(Card.id, Card.tcg_card_id, Card.name, Card.number, Card.rarity, Card.images_large)
        .filter(Card.id.in_(list(indexed)), Card.images_large.isnot(None), Card.images_large != "").all()
    ]
    by_name: dict[str, list] = {}
    for row in rows:
        by_name.setdefault((row.name or "").casefold(), []).append(row)
    chosen: dict[str, dict] = {}

    def add(row, tag: str) -> None:
        entry = chosen.setdefault(row.id, {
            "id": row.id, "tcg_card_id": row.tcg_card_id or tcg_card_id(row.id), "name": row.name, "number": row.number,
            "rarity": row.rarity, "images_large": row.images_large, "tags": [],
        })
        if tag not in entry["tags"]:
            entry["tags"].append(tag)

    trap_names = [name for name, group in by_name.items() if len(group) >= 4]
    rnd.shuffle(trap_names)
    for name in trap_names[:traps]:
        add(rnd.choice(by_name[name]), "trap")
    holo_rows = [row for row in rows if row.rarity and any(word in row.rarity.casefold() for word in HOLO_WORDS)]
    rnd.shuffle(holo_rows)
    for row in holo_rows[:holo]:
        add(row, "holo")
    rest = list(rows)
    rnd.shuffle(rest)
    for row in rest:
        if len(chosen) >= count:
            break
        if row.id not in chosen:
            add(row, "plain")
    return list(chosen.values())[:count]


def fetch_hires(entry: dict, cache_dir: Path, client) -> bytes | None:
    """The card's high-resolution picture, from the disk cache or TCGdex (polite: 5 a second)."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"{entry['id']}.img"
    try:
        return path.read_bytes()
    except OSError:
        pass
    try:
        response = client.get(entry["images_large"])
        response.raise_for_status()
        path.write_bytes(response.content)
        time.sleep(HIRES_DELAY_SECONDS)
        return response.content
    except Exception as exc:
        logger.info("Card-match benchmark: no high picture for %s (%s)", entry["id"], exc)
        return None


# ── Running ──────────────────────────────────────────────────────────────────

def _numbers_equal(left, right) -> bool:
    from api import recognize as rules

    return rules._numbers_match(left, right)


def _totals_equal(read_total, printed_total) -> bool:
    from api import recognize as rules

    left, right = rules._normalize_printed_total(read_total), rules._normalize_printed_total(printed_total)
    return left is not None and left == right


def _finish_report(kind: str, started: float, index: CardIndex, matcher, results: list[dict], extra: dict, rss_before: float | None) -> dict:
    n = len(results)
    found = sum(1 for r in results if r["found"])
    found_ok = sum(1 for r in results if r.get("found_accurate"))
    top1 = sum(1 for r in results if r["rank"] == 1)
    top5 = sum(1 for r in results if r["rank"] and r["rank"] <= 5)
    top20 = sum(1 for r in results if r["rank"])
    number_exact = sum(1 for r in results if r["number_exact"])
    total_exact = sum(1 for r in results if r.get("total_exact"))
    decided = [r for r in results if r["decided"]]
    decided_right = sum(1 for r in decided if r["decided_right"])
    mechanisms = Counter(r["mechanism"] for r in decided)
    mechanism_right = Counter(r["mechanism"] for r in decided if r["decided_right"])
    reasons = Counter(r["unsure_reason"] for r in results if not r["decided"])
    groups = {}
    for tag in ("trap", "holo", "plain"):
        members = [r for r in results if tag in r.get("tags", [])]
        if members:
            dec = [r for r in members if r["decided"]]
            groups[tag] = {
                "n": len(members), "top1": pct(sum(1 for r in members if r["rank"] == 1), len(members)),
                "top20": pct(sum(1 for r in members if r["rank"]), len(members)),
                "number_exact": pct(sum(1 for r in members if r["number_exact"]), len(members)),
                "decided": pct(len(dec), len(members)),
                "decided_right": pct(sum(1 for r in dec if r["decided_right"]), len(dec)),
                "decided_wrong": sum(1 for r in dec if not r["decided_right"]),
            }
    own = [r for r in results if r.get("group", "local") == "local"]  # today's groups stay the owner's own scans
    by_scan_time = batch_groups(own) if kind == "labelled" else None
    undecided_right = undecided_first_right(own) if kind == "labelled" else None
    fallback_group = fallback_summary(own) if kind == "labelled" else None
    timings = timing_summary([r["timings_ms"] for r in results])
    sweep = picture_only_sweep(results)
    peak = peak_rss_mb()
    p95_total = timings.get("total", {}).get("p95")
    extra_ram = round(peak - rss_before, 1) if peak is not None and rss_before is not None else None
    metrics = {
        "n": n, "card_found_pct": pct(found, n), "card_found_accurate_pct": pct(found_ok, n) if kind == "synthetic" else None,
        "top1_pct": pct(top1, n), "top5_pct": pct(top5, n), "top20_pct": pct(top20, n),
        "number_exact_pct": pct(number_exact, n), "total_exact_pct": pct(total_exact, n) if kind == "synthetic" else None,
        "decided_pct": pct(len(decided), n), "decided_right_pct": pct(decided_right, len(decided)),
        "decided_wrong": len(decided) - decided_right,
        "mechanisms": {m: {"used": c, "right": mechanism_right[m]} for m, c in mechanisms.items()},
        "unsure_reasons": dict(reasons),
    }
    bar = [
        {"id": "top20", "label": "Right printing in the top 20", "value": metrics["top20_pct"], "target": f">= {BAR_TOP20 * 100:.0f}%",
         "ok": None if metrics["top20_pct"] is None else metrics["top20_pct"] >= BAR_TOP20 * 100},
        {"id": "decided", "label": "Decided without a model", "value": metrics["decided_pct"], "target": f">= {BAR_DECIDED * 100:.0f}%",
         "ok": None if metrics["decided_pct"] is None else metrics["decided_pct"] >= BAR_DECIDED * 100},
        {"id": "decided_right", "label": "Of those decided, right", "value": metrics["decided_right_pct"], "target": f">= {BAR_DECIDED_RIGHT * 100:.0f}%",
         "ok": None if metrics["decided_right_pct"] is None else metrics["decided_right_pct"] >= BAR_DECIDED_RIGHT * 100},
        {"id": "p95", "label": "Time per photo, 95th percentile (ms)", "value": p95_total, "target": f"<= {BAR_P95_MS} ms",
         "ok": None if p95_total is None else p95_total <= BAR_P95_MS},
        {"id": "ram", "label": "Extra memory (MB)", "value": extra_ram, "target": f"<= {BAR_EXTRA_RAM_MB} MB",
         "ok": None if extra_ram is None else extra_ram <= BAR_EXTRA_RAM_MB},
    ]
    report = {
        "kind": kind, "matcher_version": MATCHER_VERSION, "options": getattr(matcher, "label", "baseline"), "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "duration_seconds": round(time.monotonic() - started, 1), "model": index.model,
        "index": {k: v for k, v in index_status(index.model).items() if k in ("count", "build_seconds", "size_bytes", "built_at", "dim")},
        "host": {"cpu_count": os.cpu_count(), "threads": config.threads(), "platform": platform.platform(), "python": platform.python_version()},
        "memory": {"rss_before_mb": round(rss_before, 1) if rss_before is not None else None,
                   "peak_rss_mb": round(peak, 1) if peak is not None else None, "extra_mb": extra_ram},
        "metrics": metrics, "groups": groups, "by_scan_time": by_scan_time, "undecided_first_right": undecided_right, "fallback": fallback_group, "corners_check": None, "picture_only_sweep": sweep, "timings_ms": timings, "pass_bar": bar,
        "thresholds": thresholds(),
        "failures": [r for r in results if (r["rank"] != 1 or (r["decided"] and not r["decided_right"]))][:25],
        **extra,
    }
    return report


def _group_row(members: list[dict]) -> dict | None:
    if not members:
        return None
    decided = [r for r in members if r["decided"]]
    return {
        "n": len(members), "top1": pct(sum(1 for r in members if r["rank"] == 1), len(members)),
        "top20": pct(sum(1 for r in members if r["rank"]), len(members)), "decided": pct(len(decided), len(members)),
        "decided_right": pct(sum(1 for r in decided if r["decided_right"]), len(decided)),
        "decided_wrong": sum(1 for r in decided if not r["decided_right"]),
    }


# The scans made after this moment were not used for tuning anything: the fair test. (The photo size does not tell them
# apart: a card filling the guide is only about 923 px tall in the stored photo, which the OCR check counts as "1024".)
NEW_SCANS_FROM = "2026-11-05T02:00:00+00:00"


def scan_batch(data: dict) -> str:
    """``new`` for a scan made at or after ``NEW_SCANS_FROM``, else ``tuning``. A trace with no readable time counts as tuning."""
    try:
        made = datetime.fromisoformat(str(data.get("created_at")).replace("Z", "+00:00"))
        if made.tzinfo is None:
            made = made.replace(tzinfo=timezone.utc)
        return "new" if made >= datetime.fromisoformat(NEW_SCANS_FROM) else "tuning"
    except (TypeError, ValueError):
        return "tuning"


def batch_groups(results: list[dict]) -> dict:
    """Real-photo results for the scans used for tuning and the new scans that were not. A group with no scans is None,
    so the lab can say so plainly."""
    return {batch: _group_row([r for r in results if r.get("batch") == batch]) for batch in ("tuning", "new")}


def undecided_first_right(results: list[dict]) -> dict:
    """Scans where the first pick is right but nothing was decided, counted by the reason, for all scans and per group:
    what is holding back "decided". Only counted, no threshold is touched."""

    def count(members: list[dict]) -> dict:
        first = [r for r in members if r["rank"] == 1]
        stuck = [r for r in first if not r["decided"]]
        reasons = Counter(r.get("unsure_reason") or "unknown" for r in stuck)
        return {"scans": len(members), "first_right": len(first), "undecided": len(stuck),
                "reasons": [{"reason": reason, "n": n} for reason, n in reasons.most_common()]}

    return {"all": count(results), **{batch: count([r for r in results if r.get("batch") == batch]) for batch in ("tuning", "new")}}


def fallback_summary(results: list[dict]) -> dict:
    """The scans whose card was not found on the recognition image (``detection.fallback``) next to the rest.
    A fallback card is only ever decided when a number was read from it and the picture agrees."""
    return {
        "scans": sum(1 for r in results if r.get("fallback")),
        "by_kind": {kind: _group_row([r for r in results if r.get("fallback") == kind]) for kind in ("review_photo", "full_photo", "guide_crop")},
        "found_on_photo": _group_row([r for r in results if not r.get("fallback")]),
    }


def picture_only_sweep(results: list[dict]) -> list[dict]:
    """What a picture-only rule would do on these photos at each similarity / lead pair: how many it would
    decide and how many of those would be wrong (top picture is not the card). The thresholds in use are
    picked from this table; a rule is only safe where ``wrong`` is 0, reprint traps included."""
    rows = []
    scored = [r for r in results if r.get("top_similarity") is not None and r.get("top_lead") is not None]
    traps = [r for r in scored if "trap" in r.get("tags", [])]
    for sim in (0.80, 0.85, 0.88, 0.92):
        for lead in (0.04, 0.06, 0.10, 0.15):
            passing = [r for r in scored if r["top_similarity"] >= sim and r["top_lead"] >= lead]
            rows.append({
                "sim_min": sim, "lead_min": lead, "decided": len(passing),
                "wrong": sum(1 for r in passing if r["rank"] != 1),
                "trap_wrong": sum(1 for r in passing if "trap" in r.get("tags", []) and r["rank"] != 1),
                "trap_n": len(traps),
            })
    return rows


def thresholds() -> dict:
    from . import pipeline

    return {"sim_min_with_rules": pipeline.SIM_MIN_WITH_RULES, "sim_min_picture_only": pipeline.SIM_MIN_PICTURE_ONLY,
            "lead_min_picture_only": pipeline.LEAD_MIN_PICTURE_ONLY,
            "sim_min_picture_strong": pipeline.SIM_MIN_PICTURE_STRONG, "lead_min_picture_strong": pipeline.LEAD_MIN_PICTURE_STRONG}


def run_synthetic(
    session_factory, matcher, *, count: int = 400, seed: int = 1, data_dir: Path | None = None,
    progress: Callable[[dict], None] | None = None, should_stop: Callable[[], bool] | None = None,
) -> dict:
    import httpx
    from PIL import Image
    import io

    from . import synthetic
    from .images import decode_rgb

    started = time.monotonic()
    report_progress = progress or (lambda _state: None)
    index = matcher.index
    db = session_factory()
    try:
        sample = choose_cards(db, index, count=count, seed=seed)
    finally:
        db.close()
    rss_before = rss_mb()
    hires_dir = (data_dir or config.data_dir()) / "hires"
    results: list[dict] = []
    skipped = 0
    warmed = False
    with httpx.Client(timeout=20.0, follow_redirects=True) as client:
        for position, entry in enumerate(sample, start=1):
            if should_stop and should_stop():
                break
            report_progress({"phase": "photos", "done": position - 1, "total": len(sample)})
            blob = fetch_hires(entry, hires_dir, client)
            if blob is None:
                skipped += 1
                continue
            card_image = Image.open(io.BytesIO(blob)).convert("RGB")
            jpeg, corners, settings = synthetic.make_photo(card_image, seed * 100_003 + position)
            photo = decode_rgb(jpeg)
            if not warmed:  # the first call loads the OCR models and the rules; keep it out of the timings
                matcher.match(photo)
                warmed = True
            outcome = matcher.match(photo)
            card_width = ((corners[1][0] - corners[0][0]) ** 2 + (corners[1][1] - corners[0][1]) ** 2) ** 0.5
            results.append(_score(outcome, entry, settings, corners, card_width))
    report = _finish_report("synthetic", started, index, matcher, results, {
        "requested": count, "skipped_no_picture": skipped, "seed": seed,
        "note": "Synthetic photos made from the same artwork the index holds: an upper bound, not real-world accuracy.",
    }, rss_before)
    return report


def _score(outcome, entry: dict, settings: dict, corners, card_width: float) -> dict:
    from . import synthetic

    truth = entry["id"]
    rank = next((m["rank"] for m in outcome.matches if m["card_id"] == truth), None)
    decision = outcome.decision
    detected = outcome.detection
    return {
        "card_id": truth, "name": entry["name"], "number": entry["number"], "tags": entry["tags"], "settings": settings,
        "found": detected["found"],
        "found_accurate": bool(detected["found"]) and synthetic.corner_error([tuple(c) for c in detected.get("corners", [])], corners, card_width) <= 0.04,
        "rank": rank, "top_match": outcome.matches[0]["card_id"] if outcome.matches else None,
        "top_similarity": outcome.matches[0]["similarity"] if outcome.matches else None,
        "top_lead": round(outcome.matches[0]["similarity"] - outcome.matches[1]["similarity"], 4) if len(outcome.matches) > 1 else None,
        "ocr_flipped": outcome.ocr.get("flipped"), "number_corrected": bool(outcome.ocr.get("corrected")),
        "number_exact": _numbers_equal(outcome.ocr.get("number_local"), entry["number"]) if outcome.ocr.get("number_local") else False,
        "total_exact": _totals_equal(outcome.ocr.get("number_total"), next((m["printed_total"] for m in outcome.matches if m["card_id"] == truth), None)),
        "decided": decision is not None, "decided_right": bool(decision and decision["card_id"] == truth),
        "mechanism": decision["mechanism"] if decision else None, "unsure_reason": outcome.unsure_reason,
        "timings_ms": outcome.timings_ms,
    }


def load_stored_card(trace_path: Path, data: dict):
    """The high-resolution flat card a scan stored beside its trace (the card the live run read its text from),
    or None for older traces, which are read from the recognition image alone."""
    from services import scan_trace
    from .images import decode_rgb

    stored = scan_trace.stored_card_path(trace_path, data)
    if stored is None:
        return None
    try:
        return decode_rgb(stored.read_bytes())
    except Exception:
        return None


def review_photo_loader(session_factory, data: dict):
    """A function that reads the scan's whole stored review photo (the 2048 px one) for the card finder, or None when the trace
    does not say which scan it is. The photo is read only when the card is not found on the recognition image. Read-only; the
    photo stays on the server (a scan older than the retention period has none, and the finder then goes to the guide frame)."""
    from services import trace_sources

    item_id = data.get("item_id")
    if trace_sources.source_of(data) != trace_sources.LOCAL:
        return None  # another stack's scan: its item id means nothing in this database (it would fetch an unrelated scan)
    if not item_id or session_factory is None:
        return None

    def load():
        from models import ScanJobItem
        from services import scan_storage
        from .images import decode_rgb

        db = session_factory()
        try:
            row = db.get(ScanJobItem, item_id)
            path = row.image_path if row is not None else None
        finally:
            db.close()
        if not path:
            return None
        try:
            return decode_rgb(scan_storage.read_review_photo(path), max_side=2048)
        except Exception:
            return None

    return load


def trace_relpath(path: Path) -> str:
    """Where a trace is under its root (``user-N/<day>/<file>``), so the Misses view can tell later whether it still exists."""
    return f"{path.parent.parent.name}/{path.parent.name}/{path.name}"


def group_rows(results: list[dict]) -> dict:
    """``_group_row`` per group of real scans (``trace_sources.group_of``), with the group's name and how many trainers (a count)."""
    from services import trace_sources

    rows = {}
    for group in sorted({r.get("group", "local") for r in results}):
        members = [r for r in results if r.get("group", "local") == group]
        rows[group] = {**(_group_row(members) or {}), "label": trace_sources.group_label(group), "trainers": len({r.get("user") for r in members})}
    return rows


def corners_module_summary(rows: list[dict]) -> dict | None:
    from . import corners_check as corners_module

    return corners_module.summarise(rows) if rows else None


def run_labelled(
    session_factory, matcher, *, trace_dir: Path, progress: Callable[[dict], None] | None = None,
    should_stop: Callable[[], bool] | None = None, collector=None, corners_check: bool | None = None, held_back: str = "separate",
) -> dict | None:
    """The diagnostics traces with a confirmed answer, through the pipeline, next to today's Ollama path.
    Returns None when there are no usable traces. A ``misses.MissCollector`` gets every scan to keep the misses.
    ``corners_check`` (default: on when there is a collector, i.e. the one real-scan benchmark, never in the option comparison):
    version 8's corners check, see ``corners_check.py``; it adds about half a second a scan.
    Scans from a read-only source (prod) are in groups of their own (``by_group``); ``held_back``: ``separate`` (default: the
    held-back ones are measured and reported in their group but are not in the headline numbers), ``skip`` (not run at all:
    the option comparison, which chooses) or ``only`` (only those: the headline is the held-back scans)."""
    from .images import decode_rgb

    started = time.monotonic()
    report_progress = progress or (lambda _state: None)
    index = matcher.index
    indexed = set(index.card_ids)
    from . import ocr_check

    from services import scan_trace

    from services import trace_sources

    traces = ocr_check.labelled_traces(trace_dir)  # one trace per scan (a scan with several attempts counts once)
    eligible, not_english = [], 0
    for data, path in traces:
        held = trace_sources.is_held_back(data)
        if (held and held_back == "skip") or (not held and held_back == "only"):
            continue
        if f"{data['ground_truth']}_en" in indexed:
            eligible.append((data, path))
        else:
            not_english += 1
    if not eligible:
        return None
    rss_before = rss_mb()
    do_corners = collector is not None if corners_check is None else corners_check
    corner_rows: list[dict] = []
    results: list[dict] = []
    ollama = {"n": 0, "not_run": 0, "decided": 0, "decided_right": 0, "in_candidates": 0, "top1": 0}
    rerun_pairs: list[tuple] = []  # (confirmed card, matcher now, Ollama path then): the matcher re-run on the photo
    recorded_pairs: list[tuple] = []  # same, with the matcher's answer recorded in shadow mode at scan time
    examples: list[dict] = []
    wrong_scans: list[dict] = []  # the scans this run decided wrong (text only), for the comparison's per-row list
    for position, (data, path) in enumerate(eligible, start=1):
        if should_stop and should_stop():
            break
        report_progress({"phase": "traces", "done": position - 1, "total": len(eligible)})
        truth_id = f"{data['ground_truth']}_en"
        try:
            photo = decode_rgb((path.parent / data["image_file"]).read_bytes(), max_side=2048)
        except Exception:
            continue
        stored = load_stored_card(path, data)
        resolution = ocr_check.resolution_of(stored)
        review = review_photo_loader(session_factory, data)
        outcome = matcher.match(photo, flat_card=stored, review_photo=review) if review is not None else matcher.match(photo, flat_card=stored)
        group = trace_sources.group_of(data)
        is_local = group == trace_sources.GROUP_LOCAL
        corner_row = None
        if do_corners and is_local:
            try:
                from . import corners_check as corners_module

                truth_set = ((matcher.candidate_loader([truth_id]) or {}).get(truth_id) or {}).get("set")
                corner_row = corners_module.measure(
                    matcher, photo, truth_id, number_read=bool(outcome.ocr.get("number_local")), refused=outcome.detection.get("rejected"),
                    batch=scan_batch(data), set_name=truth_set,
                )
                if corner_row:
                    corner_rows.append(corner_row)
            except Exception:  # a measurement only: it must never stop the benchmark
                logger.exception("Card-match: could not measure the corners for %s", path.name)
        if collector is not None and not trace_sources.is_held_back(data):  # held-back scans feed nothing that tunes, the Misses view included
            try:
                collector.add(trace=path.name, photo=photo, outcome=outcome, truth_id=truth_id,
                              confirmation=(data.get("confirmation") or {}).get("source"), matcher=matcher, corners=corner_row,
                              source=trace_sources.source_of(data), trace_rel=trace_relpath(path))
            except Exception:  # the misses view must never stop the benchmark
                logger.exception("Card-match: could not record a miss for %s", path.name)
        rank = next((m["rank"] for m in outcome.matches if m["card_id"] == truth_id), None)
        decision = outcome.decision
        if decision and decision["card_id"] != truth_id and not trace_sources.is_held_back(data) and len(wrong_scans) < MAX_WRONG_SCANS:
            try:  # what Misses keeps for a wrong decision, as text; held-back scans feed nothing that tunes, so none is kept
                wrong_scans.append(misses_module.wrong_record(
                    trace=path.name, source=trace_sources.source_of(data), trace_rel=trace_relpath(path), outcome=outcome, truth_id=truth_id,
                    loaded=matcher.candidate_loader([truth_id] + [m["card_id"] for m in outcome.matches[:3]] + [decision["card_id"]])))
            except Exception:  # the list must never stop the benchmark
                logger.exception("Card-match: could not record a wrong decision for %s", path.name)
        number_local = outcome.ocr.get("number_local")
        truth_number = next((m["number"] for m in outcome.matches if m["card_id"] == truth_id), None)
        results.append({
            "card_id": truth_id, "trace": path.name, "group": group, "user": (trace_sources.source_of(data), data.get("user_id")), "tags": [], "found": outcome.detection["found"], "rank": rank,
            "resolution": resolution, "batch": scan_batch(data), "fallback": outcome.detection.get("fallback"),
            "number_exact": bool(number_local and truth_number and _numbers_equal(number_local, truth_number)),
            "decided": decision is not None, "decided_right": bool(decision and decision["card_id"] == truth_id),
            "mechanism": decision["mechanism"] if decision else None, "unsure_reason": outcome.unsure_reason,
            "top_match": outcome.matches[0]["card_id"] if outcome.matches else None, "timings_ms": outcome.timings_ms,
        })
        if not is_local:
            continue  # the Ollama comparison below is about the owner's own scans, as before
        # Ollama's own pick, and only on scans where Ollama ran: "Picture match first" stores its own decision in the same
        # field, which used to be counted as Ollama deciding (and as agreeing with the matcher).
        selected = scan_trace.ollama_selected(data)
        ollama_ran = scan_trace.ollama_ran(data)
        rerun_pairs.append((data["ground_truth"], decision["tcg_card_id"] if decision else None, selected, ollama_ran))
        shadow = data.get("shadow")
        if isinstance(shadow, dict) and shadow.get("status") == "ok":
            recorded = (shadow.get("decision") or {}).get("tcg_card_id")
            recorded_pairs.append((data["ground_truth"], recorded, selected, ollama_ran))
        if decision and selected and decision["tcg_card_id"] != selected and len(examples) < 10:
            candidates = data.get("candidates") or []

            def name_of(tcg):
                return next((c.get("name") for c in candidates if c.get("tcg_card_id") == tcg), None) or tcg

            examples.append({
                "matcher": next((m["name"] for m in outcome.matches if m["tcg_card_id"] == decision["tcg_card_id"]), None) or decision["tcg_card_id"],
                "ollama": name_of(selected), "confirmed": name_of(data["ground_truth"]),
                "right": "matcher" if decision["tcg_card_id"] == data["ground_truth"] else "ollama" if selected == data["ground_truth"] else "neither",
            })
        if not ollama_ran:
            ollama["not_run"] += 1  # the picture matcher decided it (or sent it to the inbox): no Ollama answer to count
            continue
        ollama["n"] += 1
        ollama["in_candidates"] += 1 if data.get("ground_truth_rank") else 0
        if selected:
            ollama["decided"] += 1
            ollama["decided_right"] += 1 if selected == data["ground_truth"] else 0
        ollama["top1"] += 1 if data.get("ground_truth_rank") == 1 else 0
    all_results = results
    results = [r for r in all_results if held_back == "only" or not r["group"].endswith("_held_back")]  # the headline: what tuning may see
    extra = {
        "wrong_scans": [] if held_back == "only" else wrong_scans,
        "labelled": {"scans_with_answer": len(traces), "traces_with_answer": len(traces), "english_in_index": len(eligible), "not_english_or_not_indexed": not_english},
        # Each group apart (the owner's own scans, each read-only source's scans for tuning and held back), with how many trainers.
        "by_group": group_rows(all_results),
        "held_back_note": ("The held-back scans are measured in their own group and are not in the headline numbers." if held_back == "separate"
                           else "Only the held-back scans were run." if held_back == "only" else "The held-back scans were left out of this run."),
        "how_confirmed_by_source": {root.label: shadow_module.how_confirmed(root.path) for root in trace_sources.usable_roots(trace_dir)},
        # How each confirmed card was chosen; a card found by manual search was offered by no scanner, so it is
        # a miss for the matcher and for Ollama in the numbers above (it is a trace with an answer, rank None).
        "how_confirmed": shadow_module.how_confirmed(trace_dir),
        "ollama_today": {
            **ollama, "decided_pct": pct(ollama["decided"], ollama["n"]),
            "decided_right_pct": pct(ollama["decided_right"], ollama["decided"]),
            "in_candidates_pct": pct(ollama["in_candidates"], ollama["n"]), "top1_pct": pct(ollama["top1"], ollama["n"]),
        },
        # The two paths on the same confirmed photos, side by side. "rerun" is the matcher run again just
        # now; "recorded" is what it answered at scan time in shadow mode (only the traces that have it).
        "corners_check": corners_module_summary(corner_rows) if do_corners else None,
        "side_by_side": {
            "rerun": shadow_module.score_pairs(rerun_pairs),
            "recorded": shadow_module.score_pairs(recorded_pairs) if recorded_pairs else None,
            "disagreements": examples,
        },
    }
    if collector is not None and not (should_stop and should_stop()):
        collector.finish(getattr(matcher, "label", ""))
    return _finish_report("labelled", started, index, matcher, results, extra, rss_before)


# ── Comparing the options side by side ───────────────────────────────────────

COMPARE_MIN_GAIN = 0.5  # points of top-20 or decided a challenger must add to replace the plainer option set


def compare_row(label: str, report: dict | None, *, missing: list[str] | None = None) -> dict:
    if report is None:
        return {"label": label, "status": "skipped", "missing_indexes": missing or []}
    m = report["metrics"]
    timings = report.get("timings_ms", {}).get("total", {})
    return {
        "label": label, "status": "ok", "n": m["n"], "top1": m["top1_pct"], "top5": m["top5_pct"], "top20": m["top20_pct"],
        "number_exact": m["number_exact_pct"], "decided": m["decided_pct"], "decided_right": m["decided_right_pct"],
        "decided_wrong": m["decided_wrong"], "median_ms": timings.get("median"), "p95_ms": timings.get("p95"),
        "extra_mb": report.get("memory", {}).get("extra_mb"),
        "wrong_scans": list(report.get("wrong_scans") or []),  # version 10: each wrong decision of this row, as text (see ``misses.wrong_record``)
    }


def pick_winner(rows: list[dict]) -> dict | None:
    """The option set to keep: no more wrong decisions than the plain run, inside the time bar (plus the noise
    tolerance, ``PICK_MAX_P95_MS``), and the best top-20 then decided rate. A plainer option set (earlier in the list) wins unless a later one adds at
    least ``COMPARE_MIN_GAIN`` points of top 1, top 20 or decided, and loses no more than that on top 20 or decided."""
    ok = [row for row in rows if row["status"] == "ok"]
    if not ok:
        return None
    wrong_limit = min(row["decided_wrong"] for row in ok)
    eligible = [row for row in ok if row["decided_wrong"] <= wrong_limit and (row["p95_ms"] is None or row["p95_ms"] <= PICK_MAX_P95_MS)]
    if not eligible:
        return None
    best = eligible[0]
    for row in eligible[1:]:
        gain_top20 = (row["top20"] or 0) - (best["top20"] or 0)
        gain_decided = (row["decided"] or 0) - (best["decided"] or 0)
        gain_top1 = (row.get("top1") or 0) - (best.get("top1") or 0)
        if max(gain_top20, gain_decided, gain_top1) >= COMPARE_MIN_GAIN and gain_top20 >= -0.5 and gain_decided >= -0.5:
            best = row
    return best


def run_compare(
    kind: str, session_factory, labels, *, data_dir: Path | None = None, trace_dir: Path | None = None, ocr_reader=None,
    progress: Callable[[dict], None] | None = None, should_stop: Callable[[], bool] | None = None, count: int = 400,
) -> dict:
    """Run ``labelled`` or ``synthetic`` once per option set and put the results in one table."""
    from . import variants

    started = time.monotonic()
    rows, reports = [], {}
    for position, label in enumerate(labels, start=1):
        if should_stop and should_stop():
            break
        options = variants.parse(label)
        missing = variants.missing_indexes(options, data_dir)
        if missing:
            rows.append(compare_row(label, None, missing=missing))
            continue
        matcher = variants.build_matcher(options, session_factory, data_dir=data_dir, ocr_reader=ocr_reader)

        def step_progress(state: dict, _label=label, _position=position) -> None:
            (progress or (lambda _s: None))({**state, "compare": _label, "compare_step": _position, "compare_total": len(labels)})

        if kind == "labelled":
            # The held-back scans (a read-only source's, see ``trace_sources``) are left out: this run chooses.
            report = run_labelled(session_factory, matcher, trace_dir=trace_dir, progress=step_progress, should_stop=should_stop, held_back="skip")
        else:
            report = run_synthetic(session_factory, matcher, count=count, data_dir=data_dir, progress=step_progress, should_stop=should_stop)
        if report is None:
            raise RuntimeError("No diagnostics traces with a confirmed answer for English cards yet")
        reports[label] = report
        rows.append(compare_row(label, report))
    winner = pick_winner(rows)
    first = next(iter(reports.values()), None)
    held_back_row, groups = None, None
    if kind == "labelled":
        from . import ocr_check

        groups = ocr_check.trainers_by_group(ocr_check.labelled_traces(trace_dir))
        if winner and not (should_stop and should_stop()) and any(group.endswith("_held_back") for group in groups):
            # Measured once, on the chosen option set only; nothing is picked from it.
            options = variants.parse(winner["label"])
            matcher = variants.build_matcher(options, session_factory, data_dir=data_dir, ocr_reader=ocr_reader)
            held = run_labelled(session_factory, matcher, trace_dir=trace_dir, progress=progress, should_stop=should_stop, held_back="only")
            held_back_row = compare_row(winner["label"], held) if held else None
    return {
        "kind": f"compare-{kind}", "matcher_version": MATCHER_VERSION, "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "duration_seconds": round(time.monotonic() - started, 1), "rows": rows, "winner": winner["label"] if winner else None,
        "n": rows[0].get("n") if rows and rows[0]["status"] == "ok" else None,
        "metrics": {"n": rows[0].get("n") if rows and rows[0]["status"] == "ok" else 0},
        "host": first.get("host") if first else None,
        "groups": groups,
        "held_back": held_back_row,
        "held_back_note": ("The rows above are computed on the scans that are not held back (your own and the read-only source's scans for tuning); "
                           "the held-back scans were left out of the pick. The held-back row is the chosen option set measured on them." if groups and any(g.endswith("_held_back") for g in groups) else None),
    }


# ── Reports on disk ──────────────────────────────────────────────────────────

def save_report(report: dict, data_dir: Path | None = None) -> Path:
    directory = reports_dir(data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = directory / f"benchmark-{report['kind']}-{stamp}.json"
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    os.replace(temp, path)
    return path


def latest_reports(data_dir: Path | None = None) -> dict[str, dict]:
    """The newest report of each kind: ``{"synthetic": {...}, "labelled": {...}}``."""
    out: dict[str, dict] = {}
    directory = reports_dir(data_dir)
    for kind in ("synthetic", "labelled", "compare-labelled", "compare-synthetic", "ocr-check"):
        files = sorted(directory.glob(f"benchmark-{kind}-*.json"))
        if files:
            try:
                out[kind] = json.loads(files[-1].read_text(encoding="utf-8"))
                out[kind]["file"] = files[-1].name
            except (OSError, ValueError):
                pass
    return out


def count_labelled_traces(trace_dir: Path | None, *, source: str | None = None) -> int:
    """Confirmed scans: one per scan, grouped as ``run_labelled`` and the OCR check group them (a scan with several
    attempts, each with its own trace file, counts once). Includes the read-only sources (prod's scans) unless
    ``source`` names one (``local`` for the owner's own)."""
    from . import ocr_check
    from services import trace_sources

    if trace_dir is not None and not trace_dir.is_dir():
        trace_dir = None
    traces = ocr_check.labelled_traces(trace_dir)
    if source is not None:
        traces = [item for item in traces if trace_sources.source_of(item[0]) == source]
    return len(traces)
