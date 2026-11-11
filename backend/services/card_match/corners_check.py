"""The "corners check" of the real-scan benchmark: for each confirmed scan, which cut-out is closer to the catalogue picture, the finder's
quad or the plain guide frame. (Version 9 renamed what the lab shows: the count of scans where the guide frame wins is a ranking signal,
not a count of broken corners; those scans missed the number as often as all scans did.)

For a confirmed scan the index already holds the confirmed card's own picture. This embeds three flat cards made from the
same photo, the one from the finder's quad (the version 7 finder, no plausibility check, so the number does not depend on the
finder being tested), the plain guide crop, and the whole picture, and measures how close each one is to the confirmed card's
own picture (the better of the card as it is and turned 180 degrees). A scan is *spoiled* when the guide crop is closer than
the quad by ``CLEAR_MARGIN`` or more: the finder reported a card, and a card that is not even the guide crop's picture of it.

Benchmark-only, read-only, nothing leaves the server: it adds one finder run and six embeddings per scan to the labelled
benchmark that Scanner lab shows (about half a second a scan on the server's CPU, so a few minutes for ~300 scans). It is
not run for the option comparison and never at scan time.
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict

import numpy as np

CLEAR_MARGIN = 0.05  # a cosine similarity to the confirmed card's picture; the same scan's views differ by about 0.01 to 0.02 between runs of the same crop


def measure(matcher, photo_rgb, truth_id: str, *, number_read: bool, refused: dict | None, batch: str | None, set_name: str | None) -> dict | None:
    """One scan's row, or None when the confirmed card is not in the index. The quad's measurements are plain geometry
    (share of the picture, shape against 63:88, widest corner angle off 90, wide over tall)."""
    import cv2

    from . import detect

    h, w = photo_rgb.shape[:2]
    legacy = detect.detect_card(photo_rgb)  # the version 7 finder: no check
    pictures = [detect.guide_crop(photo_rgb), detect.whole_picture(photo_rgb)] + ([legacy.card] if legacy.found else [])
    sims = matcher.card_similarities(pictures, truth_id)
    if sims is None:
        return None
    row = {
        "batch": batch, "set": set_name, "guide": round(sims[0], 4), "whole": round(sims[1], 4),
        "quad": round(sims[2], 4) if legacy.found else None, "number_read": bool(number_read),
        "refused": refused.get("reason") if refused else None,
    }
    if legacy.found:
        corners = np.array(legacy.corners, dtype=np.float32)
        measures = detect.quad_measures(corners, float(cv2.contourArea(corners)), float(h * w))
        row.update({k: measures[k] for k in ("coverage", "ratio_error", "angle_deviation", "wide_over_tall")})
    return row


def spoiled(row: dict) -> bool:
    return row.get("quad") is not None and row["guide"] - row["quad"] >= CLEAR_MARGIN


def _spread(values: list[float]) -> dict | None:
    if not values:
        return None
    return {"min": round(min(values), 3), "median": round(statistics.median(values), 3), "max": round(max(values), 3)}


def group_summary(rows: list[dict]) -> dict:
    with_quad = [r for r in rows if r.get("quad") is not None]
    bad = [r for r in with_quad if spoiled(r)]
    return {
        "scans": len(rows), "no_quad": len(rows) - len(with_quad), "spoiled": len(bad),
        "whole_better": sum(1 for r in with_quad if r["whole"] - r["quad"] >= CLEAR_MARGIN),
        "spoiled_no_number": sum(1 for r in bad if not r["number_read"]),
        "no_number_all": sum(1 for r in with_quad if not r["number_read"]),
        # Version 9: how often the number was missed in the "closer" group against all scans with a quad (it is the same, about 35%:
        # the group does not predict number misses).
        "spoiled_no_number_pct": round(100 * sum(1 for r in bad if not r["number_read"]) / len(bad), 1) if bad else None,
        "no_number_all_pct": round(100 * sum(1 for r in with_quad if not r["number_read"]) / len(with_quad), 1) if with_quad else None,
        "refused_now": sum(1 for r in rows if r.get("refused")),
        "refused_among_spoiled": sum(1 for r in bad if r.get("refused")),
        "coverage": _spread([r["coverage"] for r in bad]), "ratio_error": _spread([r["ratio_error"] for r in bad]),
        "angle_deviation": _spread([r["angle_deviation"] for r in bad]),
        "coverage_of_the_rest": _spread([r["coverage"] for r in with_quad if not spoiled(r)]),
        "mean_gain": round(statistics.fmean(r["guide"] - r["quad"] for r in bad), 3) if bad else None,
    }


def summarise(rows: list[dict]) -> dict:
    """The report block: all scans, the tuning and new groups, and per set (sets with a spoiled scan first)."""
    by_set: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_set[r.get("set") or "unknown"].append(r)
    sets = [{"set": name, "scans": len(members), "spoiled": sum(1 for r in members if spoiled(r)),
             "spoiled_no_number": sum(1 for r in members if spoiled(r) and not r["number_read"])} for name, members in by_set.items()]
    sets.sort(key=lambda item: (-item["spoiled"], -item["scans"], item["set"]))
    return {
        "margin": CLEAR_MARGIN,
        "all": group_summary(rows),
        "tuning": group_summary([r for r in rows if r.get("batch") == "tuning"]),
        "new": group_summary([r for r in rows if r.get("batch") == "new"]),
        "sets": sets[:12],
        "refused_reasons": dict(Counter(r["refused"] for r in rows if r.get("refused"))),
    }


def miss_note(row: dict | None) -> dict | None:
    """What the Misses list keeps for a scan: the three similarities and the quad's measurements."""
    if not row:
        return None
    keep = ("quad", "guide", "whole", "coverage", "ratio_error", "angle_deviation", "wide_over_tall", "refused")
    return {"margin": CLEAR_MARGIN, "spoiled": spoiled(row), **{k: row.get(k) for k in keep}}
