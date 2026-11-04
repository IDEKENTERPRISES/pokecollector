"""Synthetic phone-style photos of a card picture, for the benchmark (adapted from
docs/scan-research/phash_whole_photo_proof.py): background, in-plane tilt, perspective, colour cast,
glare, blur, sensor noise and JPEG compression, with the card at 55-65% of the frame width.
The true corners are returned so the benchmark can check the card finder."""

from __future__ import annotations

import io
import math
import random

import numpy as np
from PIL import Image, ImageFilter

PHOTO_W, PHOTO_H = 1536, 2048


def _coeffs(src_pts, dst_pts):
    """PIL PERSPECTIVE coefficients mapping output points to input points."""
    a, b = [], []
    for (x, y), (u, v) in zip(dst_pts, src_pts):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    return np.linalg.solve(np.array(a, float), np.array(b, float)).tolist()


def _background(rng: np.random.Generator, kind: str) -> Image.Image:
    w, h = PHOTO_W, PHOTO_H
    if kind == "wood":
        x = np.linspace(0, 40, w)[None, :] + rng.standard_normal((h, 1)) * 0.3
        grain = (np.sin(x + np.linspace(0, 6, h)[:, None]) + 1) / 2
        base = np.stack([120 + 60 * grain, 80 + 40 * grain, 40 + 20 * grain], -1)
    elif kind == "mat":
        base = np.full((h, w, 3), 45.0)
    elif kind == "carpet":
        base = np.full((h, w, 3), (70.0, 80.0, 95.0)) + rng.standard_normal((h // 8, w // 8, 1)).repeat(8, 0).repeat(8, 1) * 14
    else:  # paper
        g = np.linspace(235, 205, h)[:, None, None]
        base = np.repeat(np.repeat(g, w, 1), 3, 2)
    base = base + rng.standard_normal((h, w, 3)) * 6
    return Image.fromarray(np.clip(base, 0, 255).astype("uint8"), "RGB")


def make_photo(card: Image.Image, seed: int) -> tuple[bytes, list[tuple[float, float]], dict]:
    """JPEG bytes of a photo of ``card``, its true corners (tl, tr, br, bl) and the settings used."""
    rnd = random.Random(seed)
    rng = np.random.default_rng(seed)
    kind = rnd.choice(["paper", "wood", "mat", "carpet"])
    width_frac = rnd.uniform(0.55, 0.65)
    jitter = rnd.uniform(0.01, 0.06)
    glare = rnd.random() < 0.45
    tilt = rnd.uniform(-10, 10)
    upside_down = rnd.random() < 0.1
    blur = rnd.choice([0.5, 0.8, 1.2, 1.8])
    quality = rnd.choice([70, 80, 88])
    cw = PHOTO_W * width_frac
    ch = cw * 88 / 63
    cx = PHOTO_W / 2 + rnd.uniform(-0.05, 0.05) * PHOTO_W
    cy = PHOTO_H / 2 + rnd.uniform(-0.05, 0.05) * PHOTO_H
    base = [(-cw / 2, -ch / 2), (cw / 2, -ch / 2), (cw / 2, ch / 2), (-cw / 2, ch / 2)]
    angle = math.radians(tilt + (180 if upside_down else 0))
    corners = []
    for x, y in base:
        rx, ry = x * math.cos(angle) - y * math.sin(angle), x * math.sin(angle) + y * math.cos(angle)
        corners.append((cx + rx + rnd.uniform(-jitter, jitter) * cw, cy + ry + rnd.uniform(-jitter, jitter) * cw))
    big = card.convert("RGBA").resize((630, 880), Image.Resampling.LANCZOS)
    src = [(0, 0), (630, 0), (630, 880), (0, 880)]
    warped = big.transform((PHOTO_W, PHOTO_H), Image.Transform.PERSPECTIVE, _coeffs(src, corners), Image.Resampling.BICUBIC)
    photo = _background(rng, kind).convert("RGBA")
    photo.alpha_composite(warped)
    arr = np.asarray(photo.convert("RGB"), float)
    arr = arr * rnd.uniform(0.75, 1.1) * np.array([rnd.uniform(0.92, 1.08) for _ in range(3)])
    if glare:
        gx, gy = cx + rnd.uniform(-0.3, 0.3) * cw, cy + rnd.uniform(-0.3, 0.3) * ch
        yy, xx = np.mgrid[0:PHOTO_H, 0:PHOTO_W]
        blob = np.exp(-(((xx - gx) / (0.25 * cw)) ** 2 + ((yy - gy) / (0.15 * ch)) ** 2))
        arr = arr * (1 - 0.6 * blob[..., None]) + 255 * 0.6 * blob[..., None]
    arr = arr + rng.standard_normal(arr.shape) * rnd.choice([0, 3, 6])
    image = Image.fromarray(np.clip(arr, 0, 255).astype("uint8")).filter(ImageFilter.GaussianBlur(blur))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=quality)
    settings = {"background": kind, "width_frac": round(width_frac, 3), "tilt": round(tilt, 1), "glare": glare,
                "upside_down": upside_down, "blur": blur, "jpeg_quality": quality}
    return buffer.getvalue(), corners, settings


def corner_error(found: list[tuple[float, float]], truth: list[tuple[float, float]], card_width: float) -> float:
    """Mean distance between matching corners as a fraction of the card width; the 180-degree-turned
    ordering counts too (an upside-down card has the same four corners)."""
    if len(found) != 4:
        return 1.0
    found_a, truth_a = np.array(found), np.array(truth)
    best = min(
        float(np.mean(np.linalg.norm(np.roll(found_a, shift, axis=0) - truth_a, axis=1)))
        for shift in range(4)
    )
    return best / card_width
