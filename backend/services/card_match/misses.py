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
from .pipeline import ORIENT_MARGIN

logger = logging.getLogger(__name__)

TAGS = {
    "decided_wrong": "Decided wrong",
    "fallback": "Card not found: read by fallback",
    "not_found": "Card not found or corners off",
    "generic": "Generic card (Basic Energy, common Trainer)",
    "glare": "Sleeve or top-loader glare",
    "holo": "Holo or full art",
    "dark_or_blur": "Low light or blur",
    "upside_down": "Upside down",
    "reprint_art": "Same artwork in another set",
    "other": "No clear cause",
}
PRIORITY = ("decided_wrong", "fallback", "not_found", "upside_down", "generic", "reprint_art", "glare", "dark_or_blur", "holo")
HOLO_WORDS = ("holo", "illustration", "ultra", "secret", "full art", "rainbow", "hyper", "special", "amazing", "radiant", "shiny", "vmax", "vstar")
BASIC_ENERGY = {"grass", "fire", "water", "lightning", "psychic", "fighting", "darkness", "metal", "fairy"}
GLARE_FRACTION = 0.04  # of the flat card's pixels that are blown out to near white
DARK_MEAN = 85  # mean grey level (0..255) of the flat card
BLUR_VARIANCE = 30.0  # variance of the Laplacian of the flat card at 315x440
MAX_ITEMS = 400
PAGE_SIZE = 24
THUMB_PHOTO_SIDE = 420  # the list thumbnails; tapping one opens the full pictures
THUMB_CARD = (210, 293)
THUMB_QUALITY = 82
FULL_QUALITY = 92
FULL_PHOTO_SIDE = 1600  # the photo with the corners drawn, as big as the stored photo is useful


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


def tag_miss(*, found: bool, rotated: bool | None, truth: dict, others: list[dict], stats: dict | None, fallback: str | None = None) -> list[str]:
    """Likely causes of a miss. ``others`` are the matcher's other picks (dicts with a ``name``); ``stats`` are
    the flat card's measurements (``card_stats``) or None when the card was not found. ``rotated`` is a
    measurement (``CardMatcher.card_rotation``: the confirmed card's own picture is clearly closer to the
    photo turned 180 degrees), never the matcher's own choice of orientation: a card the matcher merely
    guessed was turned is not "upside down"."""
    tags: list[str] = []
    if fallback:  # the card was not found on the recognition image: the full photo or the guide-frame crop was used
        tags.append("fallback")
    if not found:
        tags.append("not_found")
    if rotated:
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


def orientation_check(items: list[dict]) -> dict:
    """How the misses split on orientation, so the cause of "Upside down" is visible in the report: how many the
    old rule (the picture's turned view merely scoring higher) would have turned, how many the picture is now
    sure about, and how many are really turned (measured against the confirmed card)."""
    margins = [(item.get("orientation") or {}).get("picture_margin") for item in items]
    known = [m for m in margins if m is not None]
    return {
        "misses": len(items), "with_margin": len(known),
        "old_rule_would_turn": sum(1 for m in known if m > 0),
        "picture_sure_turned": sum(1 for m in known if m >= ORIENT_MARGIN),
        "measured_rotated": sum(1 for item in items if (item.get("rotation") or {}).get("rotated")),
        "measured_upright": sum(1 for item in items if item.get("rotation") and not item["rotation"]["rotated"]),
    }


def count_tags(items: list[dict]) -> dict[str, int]:
    counts = {tag: 0 for tag in TAGS}
    for item in items:
        for tag in item.get("tags", []):
            counts[tag] = counts.get(tag, 0) + 1
    return {tag: count for tag, count in counts.items() if count}


def misses_dir(data_dir: Path | None = None) -> Path:
    return (data_dir or config.data_dir()) / "misses"


def _jpeg(image_rgb, quality: int = THUMB_QUALITY) -> bytes:
    import cv2

    ok, buffer = cv2.imencode(".jpg", cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buffer.tobytes() if ok else b""


def photo_thumb(photo_rgb, corners, *, side: int = THUMB_PHOTO_SIDE, quality: int = THUMB_QUALITY) -> bytes:
    """The photo, shrunk to ``side`` px, with the detected card outline drawn on it."""
    import cv2
    import numpy as np

    h, w = photo_rgb.shape[:2]
    scale = min(1.0, side / max(h, w))
    small = cv2.resize(photo_rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA).copy()
    if corners:
        points = (np.array(corners, dtype=np.float32) * scale).astype(np.int32).reshape(-1, 1, 2)
        thickness = max(2, round(max(small.shape[:2]) / 400))
        cv2.polylines(small, [points], True, (255, 40, 40), thickness, cv2.LINE_AA)
        for x, y in points.reshape(-1, 2):
            cv2.circle(small, (int(x), int(y)), thickness + 2, (40, 255, 40), -1, cv2.LINE_AA)
    return _jpeg(small, quality)


def card_thumb(card_rgb) -> bytes:
    import cv2

    return _jpeg(cv2.resize(card_rgb, THUMB_CARD, interpolation=cv2.INTER_AREA))


def card_full(card_rgb) -> bytes:
    """The flat card at the size it was read from, lightly compressed."""
    return _jpeg(card_rgb, FULL_QUALITY)


class MissCollector:
    """Collects the misses of one labelled run and writes them out at the end."""

    def __init__(self, candidate_loader, data_dir: Path | None = None) -> None:
        self.loader = candidate_loader
        self.root = misses_dir(data_dir)
        self.stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        self.run_dir = self.root / f"run-{self.stamp}"
        self.items: list[dict] = []
        self.scans = 0
        self.fallback_scans = 0  # scans (misses or not) whose card was not found on the recognition image

    def add(self, *, trace: str, photo, outcome, truth_id: str, label: str = "", confirmation: str | None = None, matcher=None) -> None:
        """Record one scan if it is a miss (the right card is not the first pick). ``matcher`` measures whether
        the card is really turned (against the confirmed card's own picture)."""
        from . import detect

        self.scans += 1
        if outcome.detection.get("fallback"):
            self.fallback_scans += 1
        rank = next((m["rank"] for m in outcome.matches if m["card_id"] == truth_id), None)
        decision = outcome.decision
        wrong = bool(decision and decision["card_id"] != truth_id)  # decided, and not the confirmed card: kept even when ranked first
        if (rank == 1 and not wrong) or (len(self.items) >= MAX_ITEMS and not wrong):
            return
        fallback = outcome.detection.get("fallback")
        # The card the matcher embedded (a fallback card may come from the full photo); else find it again.
        card = detect.Detection(card=outcome.card, found=bool(outcome.detection.get("found")), confidence=0.0, method="") \
            if getattr(outcome, "card", None) is not None else detect.detect_card(photo)
        loaded = self.loader([truth_id] + [m["card_id"] for m in outcome.matches[:3]] + ([decision["card_id"]] if wrong else []))
        truth = {"card_id": truth_id, **(loaded.get(truth_id) or {})}
        top3 = outcome.matches[:3]
        rotation = None
        if matcher is not None and card.found:
            try:
                rotation = matcher.card_rotation(card.card, truth_id)
            except Exception:
                logger.exception("Card-match: could not measure the rotation for %s", trace)
        tags = tag_miss(
            found=bool(outcome.detection.get("found")), rotated=bool(rotation and rotation["rotated"]), truth=truth,
            others=outcome.matches, stats=card_stats(card.card) if card.found else None, fallback=fallback,
        )
        if wrong:
            tags = ["decided_wrong"] + [tag for tag in tags if tag != "other"]
        key = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in Path(trace).stem)[:80] or f"scan{self.scans}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        corners = outcome.detection.get("corners") or []
        if outcome.detection.get("corners_space") in ("full_photo", "review_photo"):
            corners = []  # found in the full photo: its corners do not fit this recognition image
        (self.run_dir / f"{key}-photo.jpg").write_bytes(photo_thumb(photo, corners))
        (self.run_dir / f"{key}-card.jpg").write_bytes(card_thumb(card.card))
        (self.run_dir / f"{key}-photo-full.jpg").write_bytes(photo_thumb(photo, corners, side=FULL_PHOTO_SIDE, quality=FULL_QUALITY))
        read_card = outcome.text_card if getattr(outcome, "text_card", None) is not None else card.card
        (self.run_dir / f"{key}-card-full.jpg").write_bytes(card_full(read_card))
        self.items.append({
            "key": key, "trace": trace, "kind": "not_in_top20" if rank is None else "not_top1" if rank != 1 else "decided_wrong", "rank": rank,
            "mechanism": decision["mechanism"] if decision else None,
            "decided_card": self._decided_card(outcome, decision, loaded) if wrong else None,
            "tags": tags, "primary": primary_tag(tags),
            "confirmation": confirmation,  # manual_search / manual_no_result: no scanner offered the card
            "decided": decision is not None, "decided_wrong": wrong,
            "unsure_reason": outcome.unsure_reason,
            "truth": {
                "tcg_card_id": truth.get("tcg_card_id"), "name": truth.get("name"), "number": truth.get("number"),
                "set": truth.get("set"), "rarity": truth.get("rarity"), "image": truth.get("images_small"), "image_large": truth.get("images_large"),
                "printed_total": truth.get("printed_total"),
                "similarity": next((m.get("similarity") for m in outcome.matches if m["card_id"] == truth_id), None),
            },
            "top3": [
                {"tcg_card_id": m["tcg_card_id"], "name": m.get("name"), "number": m.get("number"), "set": m.get("set"),
                 "similarity": m.get("similarity"), "image": (loaded.get(m["card_id"]) or {}).get("images_small")}
                for m in top3
            ],
            "ocr": {
                "number": outcome.ocr.get("number_local"), "total": outcome.ocr.get("number_total"), "name": outcome.ocr.get("name"),
                "hp": outcome.ocr.get("hp"), "lines": (outcome.ocr.get("lines") or [])[:6], "name_lines": (outcome.ocr.get("name_lines") or [])[:4],
                "strips": outcome.ocr.get("strips") or [],  # every region read: box, preprocessing, text and confidence per line
            },
            "detection": {k: outcome.detection.get(k) for k in ("found", "confidence", "method", "fallback")},
            "fallback": fallback,
            "rotation": rotation, "orientation": outcome.ocr.get("orientation"), "text_input": outcome.ocr.get("text_input"),
            "stats": card_stats(card.card) if card.found else None,
        })

    @staticmethod
    def _decided_card(outcome, decision: dict, loaded: dict) -> dict:
        """The card the matcher decided on, with its own number, total and picture similarity, for the "Decided wrong" list."""
        row = next((m for m in outcome.matches if m["card_id"] == decision["card_id"]), {})
        return {
            "tcg_card_id": decision.get("tcg_card_id"), "name": row.get("name"), "number": row.get("number"), "set": row.get("set"),
            "printed_total": row.get("printed_total"), "similarity": decision.get("similarity"), "rank": row.get("rank"), "lead": decision.get("lead"),
            "image": (loaded.get(decision["card_id"]) or {}).get("images_small"),
        }

    def finish(self, label: str = "") -> dict:
        report = {
            "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "matcher_version": MATCHER_VERSION,
            "options": label, "scans": self.scans, "misses": sum(1 for item in self.items if item["kind"] != "decided_wrong"),
            "decided_wrong": sum(1 for item in self.items if item.get("decided_wrong")),
            "fallback_scans": self.fallback_scans, "fallback_misses": sum(1 for item in self.items if item.get("fallback")),
            "tags": {tag: TAGS.get(tag, tag) for tag in TAGS}, "counts": count_tags(self.items),
            "primary_counts": {tag: sum(1 for item in self.items if item["primary"] == tag) for tag in TAGS if any(item["primary"] == tag for item in self.items)},
            "run": self.run_dir.name, "items": self.items, "orientation_check": orientation_check(self.items),
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


def full_image(key: str, kind: str, data_dir: Path | None = None) -> bytes | None:
    """The full-size ``photo`` (corners drawn) or ``card`` (flat card as read) of one miss in the latest run."""
    report = load_latest(data_dir)
    if report is None or kind not in ("photo", "card") or not any(item["key"] == key for item in report["items"]):
        return None
    try:
        return (misses_dir(data_dir) / report["run"] / f"{key}-{kind}-full.jpg").read_bytes()
    except OSError:
        return None


STRIP_IMAGE_WIDTH = 900  # the strips are wide and short; this keeps one inline


def strip_views(key: str, data_dir: Path | None = None) -> list[dict] | None:
    """What OCR saw for one miss: each region read (name line, number areas, bands, whole card) as the exact picture the
    recogniser got, with the raw text and confidence of every line it found. Rendered from the stored flat card and the
    recorded regions, so nothing extra is stored. None when the run or the miss is not there."""
    import cv2

    from . import ocr as ocr_module
    from .images import decode_rgb

    report = load_latest(data_dir)
    item = next((it for it in (report or {}).get("items", []) if it["key"] == key), None)
    if item is None:
        return None
    try:
        card = decode_rgb((misses_dir(data_dir) / report["run"] / f"{key}-card-full.jpg").read_bytes())
    except Exception:
        return None
    views = []
    for strip in (item.get("ocr") or {}).get("strips") or []:
        picture = None
        try:
            picture = ocr_module.render_strip(card, strip)
        except Exception:
            logger.exception("Card-match: could not draw a strip for %s", key)
        image = None
        if picture is not None and picture.size:
            scale = min(1.0, STRIP_IMAGE_WIDTH / picture.shape[1])
            small = cv2.resize(picture, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else picture
            image = "data:image/jpeg;base64," + base64.b64encode(_jpeg(small, 85)).decode("ascii")
        views.append({**strip, "image": image})
    return views


def page(tag: str | None = None, offset: int = 0, limit: int = PAGE_SIZE, data_dir: Path | None = None) -> dict:
    """A page of misses (optionally one tag) with their thumbnails inline, plus the counts per tag."""
    report = load_latest(data_dir)
    if report is None:
        return {"available": False}
    items = [item for item in report["items"] if not tag or tag in item["tags"]]
    run_dir = misses_dir(data_dir) / report["run"]
    window = []
    for item in items[offset:offset + limit]:
        slim = {**item, "ocr": {key: value for key, value in (item.get("ocr") or {}).items() if key != "strips"}}  # the strips load with the full view
        window.append({**slim, "photo": _inline(run_dir / f"{item['key']}-photo.jpg"), "card": _inline(run_dir / f"{item['key']}-card.jpg")})
    return {
        "available": True, "created_at": report["created_at"], "matcher_version": report["matcher_version"], "options": report.get("options"),
        "scans": report["scans"], "misses": report["misses"], "decided_wrong": report.get("decided_wrong", 0), "tags": report["tags"], "counts": report["counts"],
        "primary_counts": report.get("primary_counts", {}),
        "fallback_scans": report.get("fallback_scans"), "fallback_misses": report.get("fallback_misses"), "orientation_check": report.get("orientation_check"), "filter": tag, "offset": offset, "total": len(items), "items": window,
    }
