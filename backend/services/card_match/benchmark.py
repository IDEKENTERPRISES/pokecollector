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

from . import MATCHER_VERSION, config, shadow as shadow_module
from .index import CardIndex, get_index, index_status, tcg_card_id

logger = logging.getLogger(__name__)

# Phase 1 pass bar (docs/SCAN_RESEARCH.md section 3.8).
BAR_TOP20 = 0.97
BAR_DECIDED = 0.70
BAR_DECIDED_RIGHT = 0.98
BAR_P95_MS = 1500
BAR_EXTRA_RAM_MB = 1536

HOLO_WORDS = ("holo", "illustration", "ultra", "secret", "full art", "rainbow", "hyper", "special", "amazing", "radiant", "shiny")
STAGES = ("detect", "embed", "search", "ocr", "decide", "total")
HIRES_DELAY_SECONDS = 0.2


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
        "kind": kind, "matcher_version": MATCHER_VERSION, "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "duration_seconds": round(time.monotonic() - started, 1), "model": index.model,
        "index": {k: v for k, v in index_status(index.model).items() if k in ("count", "build_seconds", "size_bytes", "built_at", "dim")},
        "host": {"cpu_count": os.cpu_count(), "threads": config.threads(), "platform": platform.platform(), "python": platform.python_version()},
        "memory": {"rss_before_mb": round(rss_before, 1) if rss_before is not None else None,
                   "peak_rss_mb": round(peak, 1) if peak is not None else None, "extra_mb": extra_ram},
        "metrics": metrics, "groups": groups, "picture_only_sweep": sweep, "timings_ms": timings, "pass_bar": bar,
        "thresholds": thresholds(),
        "failures": [r for r in results if (r["rank"] != 1 or (r["decided"] and not r["decided_right"]))][:25],
        **extra,
    }
    return report


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


def run_labelled(
    session_factory, matcher, *, trace_dir: Path, progress: Callable[[dict], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> dict | None:
    """The diagnostics traces with a confirmed answer, through the pipeline, next to today's Ollama path.
    Returns None when there are no usable traces."""
    from .images import decode_rgb

    started = time.monotonic()
    report_progress = progress or (lambda _state: None)
    index = matcher.index
    indexed = set(index.card_ids)
    traces: dict[tuple, tuple[dict, Path]] = {}
    for path in sorted(trace_dir.glob("user-*/*/*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        truth = data.get("ground_truth")
        image_name = data.get("image_file")
        if not truth or not image_name or not (path.parent / image_name).is_file():
            continue
        traces[(data.get("user_id"), data.get("job_id"), data.get("item_id"), path.name if data.get("job_id") is None else "")] = (data, path)
    eligible, not_english = [], 0
    for data, path in traces.values():
        if f"{data['ground_truth']}_en" in indexed:
            eligible.append((data, path))
        else:
            not_english += 1
    if not eligible:
        return None
    rss_before = rss_mb()
    results: list[dict] = []
    ollama = {"n": 0, "decided": 0, "decided_right": 0, "in_candidates": 0, "top1": 0}
    rerun_pairs: list[tuple] = []  # (confirmed card, matcher now, Ollama path then): the matcher re-run on the photo
    recorded_pairs: list[tuple] = []  # same, with the matcher's answer recorded in shadow mode at scan time
    examples: list[dict] = []
    for position, (data, path) in enumerate(eligible, start=1):
        if should_stop and should_stop():
            break
        report_progress({"phase": "traces", "done": position - 1, "total": len(eligible)})
        truth_id = f"{data['ground_truth']}_en"
        try:
            photo = decode_rgb((path.parent / data["image_file"]).read_bytes(), max_side=2048)
        except Exception:
            continue
        outcome = matcher.match(photo)
        rank = next((m["rank"] for m in outcome.matches if m["card_id"] == truth_id), None)
        decision = outcome.decision
        number_local = outcome.ocr.get("number_local")
        truth_number = next((m["number"] for m in outcome.matches if m["card_id"] == truth_id), None)
        results.append({
            "card_id": truth_id, "trace": path.name, "tags": [], "found": outcome.detection["found"], "rank": rank,
            "number_exact": bool(number_local and truth_number and _numbers_equal(number_local, truth_number)),
            "decided": decision is not None, "decided_right": bool(decision and decision["card_id"] == truth_id),
            "mechanism": decision["mechanism"] if decision else None, "unsure_reason": outcome.unsure_reason,
            "top_match": outcome.matches[0]["card_id"] if outcome.matches else None, "timings_ms": outcome.timings_ms,
        })
        selected = (data.get("decision") or {}).get("selected")
        rerun_pairs.append((data["ground_truth"], decision["tcg_card_id"] if decision else None, selected))
        shadow = data.get("shadow")
        if isinstance(shadow, dict) and shadow.get("status") == "ok":
            recorded = (shadow.get("decision") or {}).get("tcg_card_id")
            recorded_pairs.append((data["ground_truth"], recorded, selected))
        if decision and selected and decision["tcg_card_id"] != selected and len(examples) < 10:
            candidates = data.get("candidates") or []

            def name_of(tcg):
                return next((c.get("name") for c in candidates if c.get("tcg_card_id") == tcg), None) or tcg

            examples.append({
                "matcher": next((m["name"] for m in outcome.matches if m["tcg_card_id"] == decision["tcg_card_id"]), None) or decision["tcg_card_id"],
                "ollama": name_of(selected), "confirmed": name_of(data["ground_truth"]),
                "right": "matcher" if decision["tcg_card_id"] == data["ground_truth"] else "ollama" if selected == data["ground_truth"] else "neither",
            })
        ollama["n"] += 1
        ollama["in_candidates"] += 1 if data.get("ground_truth_rank") else 0
        if selected:
            ollama["decided"] += 1
            ollama["decided_right"] += 1 if selected == data["ground_truth"] else 0
        ollama["top1"] += 1 if data.get("ground_truth_rank") == 1 else 0
    extra = {
        "labelled": {"traces_with_answer": len(traces), "english_in_index": len(eligible), "not_english_or_not_indexed": not_english},
        "ollama_today": {
            **ollama, "decided_pct": pct(ollama["decided"], ollama["n"]),
            "decided_right_pct": pct(ollama["decided_right"], ollama["decided"]),
            "in_candidates_pct": pct(ollama["in_candidates"], ollama["n"]), "top1_pct": pct(ollama["top1"], ollama["n"]),
        },
        # The two paths on the same confirmed photos, side by side. "rerun" is the matcher run again just
        # now; "recorded" is what it answered at scan time in shadow mode (only the traces that have it).
        "side_by_side": {
            "rerun": shadow_module.score_pairs(rerun_pairs),
            "recorded": shadow_module.score_pairs(recorded_pairs) if recorded_pairs else None,
            "disagreements": examples,
        },
    }
    return _finish_report("labelled", started, index, matcher, results, extra, rss_before)


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
    for kind in ("synthetic", "labelled"):
        files = sorted(directory.glob(f"benchmark-{kind}-*.json"))
        if files:
            try:
                out[kind] = json.loads(files[-1].read_text(encoding="utf-8"))
                out[kind]["file"] = files[-1].name
            except (OSError, ValueError):
                pass
    return out


def count_labelled_traces(trace_dir: Path | None) -> int:
    if trace_dir is None or not trace_dir.is_dir():
        return 0
    total = 0
    for path in trace_dir.glob("user-*/*/*.json"):
        try:
            if json.loads(path.read_text(encoding="utf-8")).get("ground_truth"):
                total += 1
        except (OSError, ValueError):
            continue
    return total
