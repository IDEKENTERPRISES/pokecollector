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
HIRES_W, HIRES_H = 1008, 1408  # the most detail kept for reading text (same 63:88 shape); never above the photo's own pixels
CARD_RATIO = 63 / 88
DETECT_MAX_SIDE = 900
# The camera screen's yellow guide: centred, 70% of the photo width, card-shaped (matches the proof script).
GUIDE_WIDTH_FRACTION = 0.70
MIN_CARD_AREA_FRACTION = 0.12  # of the photo
MIN_CONFIDENCE = 0.45
FALLBACK_CONFIDENCE = 0.2

# Version 8: a finder that distrusts itself. Every constant below comes from geometry, not from the real photos.
# The recognition image is the photo cropped to the camera's guide box, so it is itself card-shaped (63:88). A picture
# counts as a guide crop when its sides are within this fraction of that shape.
GUIDE_PICTURE_TOLERANCE = 0.03  # a 3:4 phone photo (0.75) is 4.7% off and is not one
# In a guide crop a well-aimed card fills most of the picture (the guide is drawn the card's size). A card at 45% of the
# frame is already a poor aim, and the parts of a card that show up as a "card" on their own (the artwork window is about
# 40% of the card, a lower corner is less) stay under it. Shapes below it are not taken for the card.
GUIDE_MIN_COVERAGE = 0.45
# A quad has to be close to a rectangle: its area against the convex outline it came from (1 = the same) and the
# widest an inner angle may stray from 90 degrees (perspective bends the angles of a flat card by up to about 25).
MIN_RECTANGULARITY = 0.80
MAX_ANGLE_DEVIATION = 35.0
# A quad wider than tall by more than this, in a picture that is taller than wide: the guide is portrait and a card held
# sideways could only fill about half of it, the size of the artwork window, which has the same 88:63 look turned.
SIDEWAYS_RATIO = 1.1


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
    hires: np.ndarray | None = None  # the same card flattened at the photo's own detail (up to HIRES_W x HIRES_H); None when no sharper than ``card``
    rejected: dict | None = None  # a quad the finder saw and refused as implausible: why, and its measurements (see ``quad_measures``)


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


def is_guide_picture(photo_rgb: np.ndarray) -> bool:
    """The picture is card-shaped, as the guide crop is: taller than wide, and its short side over its long side is
    within ``GUIDE_PICTURE_TOLERANCE`` of 63:88."""
    h, w = photo_rgb.shape[:2]
    return h > w and abs(w / h - CARD_RATIO) / CARD_RATIO <= GUIDE_PICTURE_TOLERANCE


def _angle_deviation(quad: np.ndarray) -> float:
    """The widest an inner angle of the quad strays from 90 degrees."""
    worst = 0.0
    for i in range(4):
        a, b, c = quad[i - 1], quad[i], quad[(i + 1) % 4]
        u, v = a - b, c - b
        denom = float(np.linalg.norm(u) * np.linalg.norm(v))
        if denom <= 0:
            return 90.0
        angle = float(np.degrees(np.arccos(np.clip(float(u @ v) / denom, -1.0, 1.0))))
        worst = max(worst, abs(angle - 90.0))
    return worst


def quad_measures(quad: np.ndarray, hull_area: float, image_area: float) -> dict:
    """Plain measurements of a candidate quad: the share of the picture it covers, how far its shape is from 63:88,
    how close it is to a rectangle (area against its convex outline, widest angle off 90), and how wide against tall."""
    top, right, bottom, left = _side_lengths(quad)
    width, height = (top + bottom) / 2, (left + right) / 2
    area = float(cv2.contourArea(quad.astype(np.float32)))
    ratio = min(width, height) / max(width, height) if max(width, height) > 0 else 0.0
    return {
        "coverage": round(area / image_area, 3) if image_area else 0.0,
        "ratio_error": round(abs(ratio - CARD_RATIO) / CARD_RATIO, 3),
        "rectangularity": round(min(area, hull_area) / max(area, hull_area), 3) if area > 0 and hull_area > 0 else 0.0,
        "angle_deviation": round(_angle_deviation(quad), 1),
        "wide_over_tall": round(width / height, 3) if height > 0 else 0.0,
    }


def plausibility_problem(measures: dict, guide_input: bool) -> str | None:
    """Why a quad is not a card, or None. Anything card-shaped may be a card in a full photo; in a guide crop
    (``guide_input``) the card has to fill most of the picture, upright, and look like a rectangle."""
    if measures["rectangularity"] < MIN_RECTANGULARITY:
        return "not_rectangular"
    if measures["angle_deviation"] > MAX_ANGLE_DEVIATION:
        return "bad_angles"
    if not guide_input:
        return None
    if measures["wide_over_tall"] > SIDEWAYS_RATIO:
        return "sideways"
    if measures["coverage"] < GUIDE_MIN_COVERAGE:
        return "too_small"
    return None


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


def _find_quad(small_bgr: np.ndarray, guide: tuple, *, check: bool = False, guide_input: bool = False,
               rejections: list | None = None) -> tuple[np.ndarray, float] | None:
    """The best card-like quad. ``check`` judges every candidate with ``plausibility_problem`` (``guide_input``: the picture
    is a guide crop); a candidate that fails is left out and, when ``rejections`` is a list, recorded in it with its
    reason, score and measurements."""
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
            if score is not None and check:
                measures = quad_measures(ordered, float(cv2.contourArea(hull)), image_area)
                problem = plausibility_problem(measures, guide_input)
                if problem:
                    if rejections is not None:
                        rejections.append({"reason": problem, **measures, "score": round(score, 3), "corners": ordered.tolist()})
                    continue
            if score is not None and (best is None or score > best[1]):
                best = (ordered, score)
    return best


def warp_card(photo_rgb: np.ndarray, corners: np.ndarray, size: tuple[int, int] = (CARD_W, CARD_H)) -> np.ndarray:
    """Flatten the quad (tl, tr, br, bl) to an upright picture of ``size`` (width, height)."""
    width, height = size
    top, right, bottom, left = _side_lengths(corners)
    if (top + bottom) > (left + right):  # lying on its side: turn the corner order a quarter
        corners = np.array([corners[3], corners[0], corners[1], corners[2]], dtype=np.float32)
    target = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(corners.astype(np.float32), target)
    return cv2.warpPerspective(photo_rgb, matrix, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def hires_size(corners: np.ndarray) -> tuple[int, int] | None:
    """The flat size that keeps the photo's own detail (capped), or None when that is no bigger than the
    matcher's usual CARD_W x CARD_H."""
    top, right, bottom, left = _side_lengths(corners)
    long_side = max((left + right) / 2, (top + bottom) / 2)
    if long_side < 1.1 * CARD_H:
        return None
    height = int(min(HIRES_H, round(long_side)))
    return int(round(height * CARD_RATIO)), height


def guide_crop(photo_rgb: np.ndarray) -> np.ndarray:
    h, w = photo_rgb.shape[:2]
    x0, y0, x1, y1 = (int(round(v)) for v in guide_rect(w, h))
    crop = photo_rgb[max(0, y0):min(h, y1), max(0, x0):min(w, x1)]
    return cv2.resize(crop, (CARD_W, CARD_H), interpolation=cv2.INTER_AREA)


def whole_picture(photo_rgb: np.ndarray) -> np.ndarray:
    """The whole picture as the card (a card that fills a guide crop, edges at or past the border)."""
    return cv2.resize(photo_rgb, (CARD_W, CARD_H), interpolation=cv2.INTER_AREA)


def _sharper_copy(photo_rgb: np.ndarray, rect: tuple[float, float, float, float]) -> np.ndarray | None:
    """The same region as a fallback card, at the photo's own detail (capped like ``hires_size``); None when no sharper."""
    h, w = photo_rgb.shape[:2]
    x0, y0, x1, y1 = (int(round(v)) for v in rect)
    crop = photo_rgb[max(0, y0):min(h, y1), max(0, x0):min(w, x1)]
    if crop.size == 0 or crop.shape[0] < 1.1 * CARD_H:
        return None
    height = int(min(HIRES_H, crop.shape[0]))
    return cv2.resize(crop, (int(round(height * CARD_RATIO)), height), interpolation=cv2.INTER_AREA)


def detect_card(photo_rgb: np.ndarray, *, check: bool = False, whole: bool = False, guide: bool | None = None) -> Detection:
    """Find and flatten the card in an RGB photo; fall back to the guide crop.

    ``check`` (version 8): every candidate quad is judged for plausibility; in a card-shaped picture (a guide crop) the
    card has to fill most of it. When nothing plausible is left the fallback is used and ``Detection.rejected`` says why
    the best refused quad was refused. ``whole``: that fallback is the whole picture instead of the centre guide crop (a
    card that fills the crop has its edges at the picture border; the centre 70% would cut them off). ``guide``: whether
    the picture is a guide crop; None = judge by its shape (``is_guide_picture``)."""
    config.apply_thread_caps()
    h, w = photo_rgb.shape[:2]
    scale = min(1.0, DETECT_MAX_SIDE / max(h, w))
    small = cv2.resize(photo_rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else photo_rgb
    small_bgr = cv2.cvtColor(small, cv2.COLOR_RGB2BGR)
    guide_box = guide_rect(small.shape[1], small.shape[0])
    guide_input = check and (is_guide_picture(photo_rgb) if guide is None else guide)
    rejections: list[dict] = []
    found = _find_quad(small_bgr, guide_box, check=check, guide_input=guide_input, rejections=rejections)
    if found is not None and found[1] >= MIN_CONFIDENCE:
        quad = found[0] / scale  # back to full-resolution coordinates
        size = hires_size(quad)
        return Detection(
            card=warp_card(photo_rgb, quad), found=True, confidence=round(found[1], 3), method="contour",
            corners=[(float(x), float(y)) for x, y in quad], hires=warp_card(photo_rgb, quad, size) if size else None,
        )
    rejected = None
    if rejections:
        best = max(rejections, key=lambda item: item["score"])
        rejected = {**best, "corners": [[round(x / scale, 1), round(y / scale, 1)] for x, y in best["corners"]], "guide_picture": guide_input}
    if whole and guide_input:
        return Detection(card=whole_picture(photo_rgb), found=False, confidence=FALLBACK_CONFIDENCE, method="whole_picture",
                         hires=_sharper_copy(photo_rgb, (0, 0, w, h)), rejected=rejected)
    return Detection(card=guide_crop(photo_rgb), found=False, confidence=FALLBACK_CONFIDENCE, method="guide_crop",
                     hires=_sharper_copy(photo_rgb, guide_rect(w, h)) if rejected else None, rejected=rejected)
