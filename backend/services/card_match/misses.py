"""The "Misses" view of Scanner lab: confirmed real scans where the right card was not the matcher's first
pick, with a likely cause for each.

The labelled benchmark (``benchmark.run_labelled``) hands every such scan to a ``MissCollector``: it keeps
two small pictures (the photo with the detected corners drawn, and the flat card the matcher embedded), the
confirmed card, the matcher's top 3 and the OCR text, and tags the scan with likely causes. The tags are
plain measurements of the flat card (glare, brightness, sharpness) plus what the run itself saw (card not
found, upside down, same artwork under another set), so ``tag_miss`` is pure and tested without a photo.
Everything lands under ``<data dir>/misses/run-<stamp>/``; ``latest.json`` points at the newest run, and the
admin API pages through it, sending the thumbnails inline (the lab page cannot load images that need a
bearer token).
"""

from __future__ import annotations

import base64
import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path

from . import MATCHER_VERSION, config

logger = logging.getLogger(__name__)

TAGS = {
    "not_found": "Card not found or corners off",
    "generic": "Generic card (Basic Energy, common Trainer)",
    "glare": "Sleeve or top-loader glare",
    "holo": "Holo or full art",
    "dark_or_blur": "Low light or blur",
    "upside_down": "Upside down",
    "reprint_art": "Same artwork in another set",
    "other": "No clear cause",
}
PRIORITY = ("not_found", "upside_down", "generic", "reprint_art", "glare", "dark_or_blur", "holo")
HOLO_WORDS = ("holo", "illustration", "ultra", "secret", "full art", "rainbow", "hyper", "special", "amazing", "radiant", "shiny", "vmax", "vstar")
BASIC_ENERGY = {"grass", "fire", "water", "lightning", "psychic", "fighting", "darkness", "metal", "fairy"}
GLARE_FRACTION = 0.04  # of the flat card's pixels that are blown out to near white
DARK_MEAN = 85  # mean grey level (0..255) of the flat card
BLUR_VARIANCE = 30.0  # variance of the Laplacian of the flat card at 315x440
MAX_ITEMS = 400
PAGE_SIZE = 24
THUMB_PHOTO_SIDE = 300
THUMB_CARD = (126, 176)


def _norm(value) -> str:
    return " ".join(str(value or "").casefold().split())


def is_generic(truth: dict) -> bool:
    name = _norm(truth.get("name"))
    kind = _norm(truth.get("card_type"))
    rarity = _norm(truth.get("rarity"))
    if kind == "energy" and (rarity in ("", "common") or name.removeprefix("basic ").removesuffix(" energy") in BASIC_ENERGY):
        return True
    return kind == "trainer" and rarity in ("common", "uncommon")


def is_holo(truth: dict) -> bool:
    rarity = _norm(truth.get("rarity"))
    return any(word in rarity for word in HOLO_WORDS)


def tag_miss(*, found: bool, flipped: bool | None, truth: dict, others: list[dict], stats: dict | None) -> list[str]:
    """Likely causes of a miss. ``others`` are the matcher's other picks (dicts with a ``name``); ``stats`` are
    the flat card's measurements (``card_stats``) or None when the card was not found."""
    tags: list[str] = []
    if not found:
        tags.append("not_found")
    if flipped:
        tags.append("upside_down")
    if is_generic(truth):
        tags.append("generic")
    truth_name = _norm(truth.get("name"))
    if truth_name and any(_norm(other.get("name")) == truth_name and other.get("card_id") != truth.get("card_id") for other in others):
        tags.append("reprint_art")
    if stats:
        if stats.get("glare", 0.0) >= GLARE_FRACTION:
            tags.append("glare")
        if stats.get("mean", 255) < DARK_MEAN or stats.get("sharpness", 1e9) < BLUR_VARIANCE:
            tags.append("dark_or_blur")
    if is_holo(truth):
        tags.append("holo")
    return tags or ["other"]


def primary_tag(tags: list[str]) -> str:
    for tag in PRIORITY:
        if tag in tags:
            return tag
    return "other"


def card_stats(card_rgb) -> dict:
    """Glare, brightness and sharpness of an upright flat card picture."""
    import cv2

    small = cv2.resize(card_rgb, (315, 440), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    hsv = cv2.cvtColor(small, cv2.COLOR_RGB2HSV)
    blown = (hsv[:, :, 2] >= 240) & (hsv[:, :, 1] <= 50)
    return {
        "glare": round(float(blown.mean()), 4), "mean": round(float(gray.mean()), 1),
        "sharpness": round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 1),
    }


def count_tags(items: list[dict]) -> dict[str, int]:
    counts = {tag: 0 for tag in TAGS}
    for item in items:
        for tag in item.get("tags", []):
            counts[tag] = counts.get(tag, 0) + 1
    return {tag: count for tag, count in counts.items() if count}


def misses_dir(data_dir: Path | None = None) -> Path:
    return (data_dir or config.data_dir()) / "misses"


def _jpeg(image_rgb, quality: int = 60) -> bytes:
    import cv2

    ok, buffer = cv2.imencode(".jpg", cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buffer.tobytes() if ok else b""


def photo_thumb(photo_rgb, corners) -> bytes:
    """The photo, shrunk, with the detected card outline drawn on it."""
    import cv2
    import numpy as np

    h, w = photo_rgb.shape[:2]
    scale = min(1.0, THUMB_PHOTO_SIDE / max(h, w))
    small = cv2.resize(photo_rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA).copy()
    if corners:
        points = (np.array(corners, dtype=np.float32) * scale).astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(small, [points], True, (255, 40, 40), 2, cv2.LINE_AA)
        for x, y in points.reshape(-1, 2):
            cv2.circle(small, (int(x), int(y)), 4, (40, 255, 40), -1, cv2.LINE_AA)
    return _jpeg(small)


def card_thumb(card_rgb) -> bytes:
    import cv2

    return _jpeg(cv2.resize(card_rgb, THUMB_CARD, interpolation=cv2.INTER_AREA))


class MissCollector:
    """Collects the misses of one labelled run and writes them out at the end."""

    def __init__(self, candidate_loader, data_dir: Path | None = None) -> None:
        self.loader = candidate_loader
        self.root = misses_dir(data_dir)
        self.stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        self.run_dir = self.root / f"run-{self.stamp}"
        self.items: list[dict] = []
        self.scans = 0

    def add(self, *, trace: str, photo, outcome, truth_id: str, label: str = "", confirmation: str | None = None) -> None:
        """Record one scan if it is a miss (the right card is not the first pick)."""
        from . import detect

        self.scans += 1
        rank = next((m["rank"] for m in outcome.matches if m["card_id"] == truth_id), None)
        if rank == 1 or len(self.items) >= MAX_ITEMS:
            return
        card = detect.detect_card(photo)
        loaded = self.loader([truth_id] + [m["card_id"] for m in outcome.matches[:3]])
        truth = {"card_id": truth_id, **(loaded.get(truth_id) or {})}
        top3 = outcome.matches[:3]
        tags = tag_miss(
            found=bool(outcome.detection.get("found")), flipped=outcome.ocr.get("flipped"), truth=truth,
            others=outcome.matches, stats=card_stats(card.card) if card.found else None,
        )
        key = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in Path(trace).stem)[:80] or f"scan{self.scans}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        (self.run_dir / f"{key}-photo.jpg").write_bytes(photo_thumb(photo, outcome.detection.get("corners") or []))
        (self.run_dir / f"{key}-card.jpg").write_bytes(card_thumb(card.card))
        decision = outcome.decision
        self.items.append({
            "key": key, "trace": trace, "kind": "not_in_top20" if rank is None else "not_top1", "rank": rank,
            "tags": tags, "primary": primary_tag(tags),
            "confirmation": confirmation,  # manual_search / manual_no_result: no scanner offered the card
            "decided": decision is not None, "decided_wrong": bool(decision and decision["card_id"] != truth_id),
            "unsure_reason": outcome.unsure_reason,
            "truth": {
                "tcg_card_id": truth.get("tcg_card_id"), "name": truth.get("name"), "number": truth.get("number"),
                "set": truth.get("set"), "rarity": truth.get("rarity"), "image": truth.get("images_small"),
            },
            "top3": [
                {"tcg_card_id": m["tcg_card_id"], "name": m.get("name"), "number": m.get("number"), "set": m.get("set"),
                 "similarity": m.get("similarity"), "image": (loaded.get(m["card_id"]) or {}).get("images_small")}
                for m in top3
            ],
            "ocr": {
                "number": outcome.ocr.get("number_local"), "total": outcome.ocr.get("number_total"), "name": outcome.ocr.get("name"),
                "hp": outcome.ocr.get("hp"), "lines": (outcome.ocr.get("lines") or [])[:6], "name_lines": (outcome.ocr.get("name_lines") or [])[:4],
            },
            "detection": {k: outcome.detection.get(k) for k in ("found", "confidence", "method")},
            "stats": card_stats(card.card) if card.found else None,
        })

    def finish(self, label: str = "") -> dict:
        report = {
            "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "matcher_version": MATCHER_VERSION,
            "options": label, "scans": self.scans, "misses": len(self.items),
            "tags": {tag: TAGS.get(tag, tag) for tag in TAGS}, "counts": count_tags(self.items),
            "primary_counts": {tag: sum(1 for item in self.items if item["primary"] == tag) for tag in TAGS if any(item["primary"] == tag for item in self.items)},
            "run": self.run_dir.name, "items": self.items,
        }
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.root.mkdir(parents=True, exist_ok=True)
        temp = self.root / "latest.tmp"
        temp.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
        temp.replace(self.root / "latest.json")
        for old in self.root.glob("run-*"):  # older runs are replaced
            if old.name != self.run_dir.name and old.is_dir():
                shutil.rmtree(old, ignore_errors=True)
        return report


def load_latest(data_dir: Path | None = None) -> dict | None:
    try:
        return json.loads((misses_dir(data_dir) / "latest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _inline(path: Path) -> str | None:
    try:
        return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    except OSError:
        return None


def page(tag: str | None = None, offset: int = 0, limit: int = PAGE_SIZE, data_dir: Path | None = None) -> dict:
    """A page of misses (optionally one tag) with their thumbnails inline, plus the counts per tag."""
    report = load_latest(data_dir)
    if report is None:
        return {"available": False}
    items = [item for item in report["items"] if not tag or tag in item["tags"]]
    run_dir = misses_dir(data_dir) / report["run"]
    window = []
    for item in items[offset:offset + limit]:
        window.append({**item, "photo": _inline(run_dir / f"{item['key']}-photo.jpg"), "card": _inline(run_dir / f"{item['key']}-card.jpg")})
    return {
        "available": True, "created_at": report["created_at"], "matcher_version": report["matcher_version"], "options": report.get("options"),
        "scans": report["scans"], "misses": report["misses"], "tags": report["tags"], "counts": report["counts"],
        "primary_counts": report.get("primary_counts", {}), "filter": tag, "offset": offset, "total": len(items), "items": window,
    }
