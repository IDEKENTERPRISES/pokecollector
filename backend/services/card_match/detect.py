"""Find the card in a phone photo and flatten it.

Steps: shrink the photo, find edges, take the contours, and keep the largest convex four-sided shape
whose sides are about 63:88 (a Pokémon card) and which sits in the guide area the camera screen shows.
Warp it to a fixed upright size. If nothing credible turns up, fall back to the plain guide crop.

Every candidate gets a confidence between 0 and 1 (how much of the guide it fills, how close the
shape is to 63:88, how rectangular it is). The fallback crop reports a low fixed confidence.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from . import config

CARD_W, CARD_H = 630, 880  # output size (the TCGdex high picture is 600x825; same 63:88 shape)
CARD_RATIO = 63 / 88
DETECT_MAX_SIDE = 900
# The camera screen's yellow guide: centred, 70% of the photo width, card-shaped (matches the proof script).
GUIDE_WIDTH_FRACTION = 0.70
MIN_CARD_AREA_FRACTION = 0.12  # of the photo
MIN_CONFIDENCE = 0.45
FALLBACK_CONFIDENCE = 0.2


# The artwork window of a flattened card (fractions of the picture): the same place on every normal card,
# and the one part that stays identical across reprints of a name, so it is embedded on its own as well.
ART_BOX = (0.07, 0.115, 0.93, 0.545)


def art_crop(card: np.ndarray) -> np.ndarray:
    """The artwork window of an upright flat card."""
    h, w = card.shape[:2]
    x0, y0, x1, y1 = ART_BOX
    return np.ascontiguousarray(card[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)])


def augmented_views(card: np.ndarray) -> list[np.ndarray]:
    """Two extra views of an upright flat card for test-time augmentation: a slightly tighter centre crop
    (corner and border errors from the finder), and a brightness / contrast normalised copy (glare, dim light)."""
    h, w = card.shape[:2]
    mx, my = int(0.035 * w), int(0.035 * h)
    tight = cv2.resize(np.ascontiguousarray(card[my:h - my, mx:w - mx]), (w, h), interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(card, cv2.COLOR_RGB2LAB)
    lab[:, :, 0] = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4)).apply(lab[:, :, 0])
    return [tight, cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)]


@dataclass
class Detection:
    card: np.ndarray  # RGB uint8, CARD_H x CARD_W, upright
    found: bool  # False = plain guide crop
    confidence: float
    method: str  # "contour" | "guide_crop"
    corners: list[tuple[float, float]] = field(default_factory=list)  # in the original photo, tl,tr,br,bl


def guide_rect(width: int, height: int) -> tuple[float, float, float, float]:
    """x0, y0, x1, y1 of the guide area in a photo of this size."""
    guide_w = GUIDE_WIDTH_FRACTION * width
    guide_h = guide_w * 88 / 63
    if guide_h > 0.96 * height:  # very wide photo: height-limited
        guide_h = 0.96 * height
        guide_w = guide_h * CARD_RATIO
    cx, cy = width / 2, height / 2
    return cx - guide_w / 2, cy - guide_h / 2, cx + guide_w / 2, cy + guide_h / 2


def order_corners(points: np.ndarray) -> np.ndarray:
    """Order four points as top-left, top-right, bottom-right, bottom-left."""
    pts = np.asarray(points, dtype=np.float32).reshape(4, 2)
    sums = pts.sum(axis=1)
    diffs = np.diff(pts, axis=1).ravel()  # y - x
    return np.array([pts[np.argmin(sums)], pts[np.argmin(diffs)], pts[np.argmax(sums)], pts[np.argmax(diffs)]], dtype=np.float32)


def _side_lengths(quad: np.ndarray) -> tuple[float, float, float, float]:
    tl, tr, br, bl = quad
    return (
        float(np.linalg.norm(tr - tl)), float(np.linalg.norm(br - tr)),
        float(np.linalg.norm(br - bl)), float(np.linalg.norm(bl - tl)),
    )


def _quad_score(quad: np.ndarray, contour_area: float, quad_area: float, image_area: float, guide: tuple) -> float | None:
    """Confidence 0..1 for a candidate quad, or None when it cannot be a card."""
    top, right, bottom, left = _side_lengths(quad)
    if min(top, right, bottom, left) < 20:
        return None
    width, height = (top + bottom) / 2, (left + right) / 2
    ratio = min(width, height) / max(width, height)
    ratio_error = abs(ratio - CARD_RATIO) / CARD_RATIO
    if ratio_error > 0.22:
        return None
    # Opposite sides of a flat card seen at an angle differ, but not by 2x.
    if max(top, bottom) / min(top, bottom) > 1.8 or max(left, right) / min(left, right) > 1.8:
        return None
    area_fraction = quad_area / image_area
    if area_fraction < MIN_CARD_AREA_FRACTION or area_fraction > 0.97:
        return None
    centre = quad.mean(axis=0)
    gx0, gy0, gx1, gy1 = guide
    gcx, gcy = (gx0 + gx1) / 2, (gy0 + gy1) / 2
    gw, gh = gx1 - gx0, gy1 - gy0
    # The card should be about where the guide is. Allow a generous drift.
    drift = max(abs(centre[0] - gcx) / gw, abs(centre[1] - gcy) / gh)
    if drift > 0.6:
        return None
    rectangularity = min(1.0, contour_area / quad_area) if quad_area > 0 else 0.0
    guide_area = gw * gh
    fill = min(quad_area / guide_area, guide_area / quad_area)  # 1 when the card is as big as the guide
    score = 0.35 * (1 - min(1.0, ratio_error / 0.22)) + 0.3 * rectangularity + 0.2 * fill + 0.15 * (1 - min(1.0, drift / 0.6))
    return float(score)


def _edge_maps(small_bgr: np.ndarray) -> list[np.ndarray]:
    gray = cv2.cvtColor(small_bgr, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    median = float(np.median(blurred))
    low, high = int(max(0, 0.66 * median)), int(min(255, 1.33 * median + 20))
    canny = cv2.Canny(blurred, low, max(high, low + 30))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    canny = cv2.morphologyEx(canny, cv2.MORPH_CLOSE, kernel, iterations=2)
    # Colour distance from the photo's border colour (the surface the card lies on) as a second opinion.
    lab = cv2.cvtColor(small_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    h, w = lab.shape[:2]
    border = np.concatenate([lab[:6].reshape(-1, 3), lab[-6:].reshape(-1, 3), lab[:, :6].reshape(-1, 3), lab[:, -6:].reshape(-1, 3)])
    distance = np.linalg.norm(lab - np.median(border, axis=0), axis=2)
    distance = cv2.GaussianBlur(distance, (7, 7), 0)
    _, mask = cv2.threshold(np.clip(distance * 4, 0, 255).astype(np.uint8), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    return [canny, mask]


def _find_quad(small_bgr: np.ndarray, guide: tuple) -> tuple[np.ndarray, float] | None:
    h, w = small_bgr.shape[:2]
    image_area = float(h * w)
    best: tuple[np.ndarray, float] | None = None
    for edges in _edge_maps(small_bgr):
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
            area = cv2.contourArea(contour)
            if area < MIN_CARD_AREA_FRACTION * image_area * 0.7:
                break
            hull = cv2.convexHull(contour)
            perimeter = cv2.arcLength(hull, True)
            quad = None
            for epsilon in (0.02, 0.03, 0.045, 0.06):
                approx = cv2.approxPolyDP(hull, epsilon * perimeter, True)
                if len(approx) == 4:
                    quad = approx.reshape(4, 2).astype(np.float32)
                    break
            if quad is None:  # rounded corners and glare: the tightest rotated rectangle
                quad = cv2.boxPoints(cv2.minAreaRect(hull)).astype(np.float32)
            ordered = order_corners(quad)
            quad_area = float(cv2.contourArea(ordered))
            score = _quad_score(ordered, float(cv2.contourArea(hull)), quad_area, image_area, guide)
            if score is not None and (best is None or score > best[1]):
                best = (ordered, score)
    return best


def warp_card(photo_rgb: np.ndarray, corners: np.ndarray) -> np.ndarray:
    """Flatten the quad (tl, tr, br, bl) to an upright CARD_W x CARD_H picture."""
    top, right, bottom, left = _side_lengths(corners)
    if (top + bottom) > (left + right):  # lying on its side: turn the corner order a quarter
        corners = np.array([corners[3], corners[0], corners[1], corners[2]], dtype=np.float32)
    target = np.array([[0, 0], [CARD_W - 1, 0], [CARD_W - 1, CARD_H - 1], [0, CARD_H - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(corners.astype(np.float32), target)
    return cv2.warpPerspective(photo_rgb, matrix, (CARD_W, CARD_H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def guide_crop(photo_rgb: np.ndarray) -> np.ndarray:
    h, w = photo_rgb.shape[:2]
    x0, y0, x1, y1 = (int(round(v)) for v in guide_rect(w, h))
    crop = photo_rgb[max(0, y0):min(h, y1), max(0, x0):min(w, x1)]
    return cv2.resize(crop, (CARD_W, CARD_H), interpolation=cv2.INTER_AREA)


def detect_card(photo_rgb: np.ndarray) -> Detection:
    """Find and flatten the card in an RGB photo; fall back to the guide crop."""
    config.apply_thread_caps()
    h, w = photo_rgb.shape[:2]
    scale = min(1.0, DETECT_MAX_SIDE / max(h, w))
    small = cv2.resize(photo_rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else photo_rgb
    small_bgr = cv2.cvtColor(small, cv2.COLOR_RGB2BGR)
    guide = guide_rect(small.shape[1], small.shape[0])
    found = _find_quad(small_bgr, guide)
    if found is not None and found[1] >= MIN_CONFIDENCE:
        quad = found[0] / scale  # back to full-resolution coordinates
        return Detection(
            card=warp_card(photo_rgb, quad), found=True, confidence=round(found[1], 3), method="contour",
            corners=[(float(x), float(y)) for x, y in quad],
        )
    return Detection(card=guide_crop(photo_rgb), found=False, confidence=FALLBACK_CONFIDENCE, method="guide_crop")
