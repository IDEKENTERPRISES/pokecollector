"""Synthetic flat cards with known printed text, for measuring OCR (no catalogue, no photos needed).

``render_card`` draws a card the way the real ones are laid out (name and HP at the top, artwork, attack text,
the collector number and set code at the bottom, on the left for modern cards and on the right for older ones),
then ``degrade`` makes it look like a phone photo of a glossy card: glare, blur, noise and JPEG, and
``at_resolution`` gives it the two sizes the matcher really reads: the 1024 px crop (a card 880 px tall) and the
full photo (a card up to 1408 px tall). ``measure`` runs a reader over a set of them and counts what it got.
"""

from __future__ import annotations

import io
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE_W, BASE_H = 630, 880
RESOLUTIONS = {"1024": 880, "full": 1408}
NAMES = ["Pikachu", "Mew ex", "Lapras", "Phantump", "Heatran", "Banette", "Slowpoke", "Toucannon", "Misty's Vitality",
         "Dhelmise", "Charizard ex", "Professor's Research", "Boss's Orders", "Iono", "Gardevoir ex", "Mimikyu"]
BODY = ["Once during your turn, you may attach a basic Energy", "This attack does 30 damage to 1 of your opponent's",
        "If this Pokemon is Knocked Out, flip a coin", "You may play only 1 Supporter card during your turn"]
SETS = ["SVI", "PAL", "OBF", "MEW", "TEF", "PRE", "SSP"]
_FONTS = ["arialbd.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf"]
_FONTS_REGULAR = ["arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"]


@dataclass
class Truth:
    name: str
    number: str  # "018"
    total: str  # "091"
    set_code: str
    hp: str


def _font(size: int, bold: bool = True):
    for name in (_FONTS if bold else _FONTS_REGULAR):
        for root in ("C:/Windows/Fonts/", "/usr/share/fonts/truetype/dejavu/", "/usr/share/fonts/truetype/liberation/", ""):
            try:
                return ImageFont.truetype(root + name, size)
            except OSError:
                continue
    return ImageFont.load_default()


def render_card(seed: int) -> tuple[Image.Image, Truth]:
    rnd = random.Random(seed)
    number = f"{rnd.randint(1, 250):03d}"
    truth = Truth(rnd.choice(NAMES), number, f"{rnd.randint(int(number), 300):03d}", rnd.choice(SETS), str(rnd.choice(range(40, 330, 10))))
    modern = rnd.random() < 0.75
    dark = rnd.random() < 0.3
    base = np.zeros((BASE_H, BASE_W, 3), np.float32)
    hue = np.array([rnd.randint(150, 235), rnd.randint(150, 235), rnd.randint(110, 215)], np.float32)
    base[:] = hue * (0.35 if dark else 1.0)
    # artwork window: a noisy gradient, so the detector has busy texture to ignore
    top, bottom = int(BASE_H * 0.1), int(BASE_H * 0.5)
    art = np.linspace(40, 220, BASE_W - 60)[None, :, None] + np.random.default_rng(seed).normal(0, 25, (bottom - top, BASE_W - 60, 3))
    base[top:bottom, 30:-30] = np.clip(art, 0, 255)
    image = Image.fromarray(np.clip(base, 0, 255).astype("uint8"))
    draw = ImageDraw.Draw(image)
    ink = (245, 245, 245) if dark else (20, 20, 20)
    draw.text((44, int(BASE_H * 0.034)), truth.name, font=_font(34), fill=ink)
    draw.text((BASE_W - 150, int(BASE_H * 0.04)), f"HP {truth.hp}", font=_font(26), fill=ink)
    y = int(BASE_H * 0.56)
    for line in rnd.sample(BODY, 3):
        draw.text((44, y), line, font=_font(17, False), fill=ink)
        y += 26
    number_text = f"{truth.number}/{truth.total}"
    small = _font(15, False)
    if modern:
        draw.text((44, int(BASE_H * 0.952)), f"{truth.set_code} EN  {number_text}", font=small, fill=ink)
        draw.text((BASE_W - 250, int(BASE_H * 0.952)), "Illus. Someone Else", font=small, fill=ink)
    else:
        draw.text((44, int(BASE_H * 0.935)), "Illus. Someone Else   (c)2002 Pokemon", font=small, fill=ink)
        draw.text((BASE_W - 100, int(BASE_H * 0.952)), number_text.lstrip("0"), font=small, fill=ink)
    return image, truth


def degrade(card: Image.Image, seed: int, *, glare: bool | None = None) -> Image.Image:
    rnd = random.Random(seed * 7 + 1)
    rng = np.random.default_rng(seed)
    arr = np.asarray(card, np.float32)
    h, w = arr.shape[:2]
    if glare if glare is not None else rnd.random() < 0.6:
        gx, gy = rnd.uniform(0.2, 0.8) * w, rnd.uniform(0.7, 0.98) * h  # sleeves shine over the bottom as often as anywhere
        yy, xx = np.mgrid[0:h, 0:w]
        blob = np.exp(-(((xx - gx) / (0.22 * w)) ** 2 + ((yy - gy) / (0.08 * h)) ** 2))
        arr = arr * (1 - 0.55 * blob[..., None]) + 255 * 0.55 * blob[..., None]
    arr = arr * rnd.uniform(0.8, 1.05) + rng.normal(0, rnd.choice([0, 3, 6]), arr.shape)
    out = Image.fromarray(np.clip(arr, 0, 255).astype("uint8")).filter(ImageFilter.GaussianBlur(rnd.choice([0.5, 0.9, 1.4, 2.0])))
    buffer = io.BytesIO()
    out.save(buffer, "JPEG", quality=rnd.choice([70, 82, 90]))
    return Image.open(io.BytesIO(buffer.getvalue())).convert("RGB")


def at_resolution(card: Image.Image, height: int) -> np.ndarray:
    """The card as an RGB array ``height`` px tall (the 1024 crop is 880, the full photo's card up to 1408)."""
    width = round(height * BASE_W / BASE_H)
    return np.asarray(card.resize((width, height), Image.Resampling.LANCZOS))


def with_margin(flat: np.ndarray, fraction: float) -> np.ndarray:
    """The card flattened with a border of sleeve and table around it (a corner found a little too wide), so the
    printed text sits lower and further in than the fixed fractions expect."""
    import cv2

    pad = int(fraction * flat.shape[0])
    padded = cv2.copyMakeBorder(flat, pad, pad, int(pad * 0.7), int(pad * 0.7), cv2.BORDER_CONSTANT, value=(70, 70, 75))
    return cv2.resize(padded, (flat.shape[1], flat.shape[0]), interpolation=cv2.INTER_AREA)


def make_set(count: int, *, seed: int = 100) -> list[tuple[Image.Image, Truth]]:
    out = []
    for i in range(count):
        card, truth = render_card(seed + i)
        out.append((degrade(card, seed + i), truth))
    return out


def _same_name(read: str | None, truth: str) -> bool:
    import difflib

    if not read:
        return False
    clean = lambda text: "".join(ch for ch in text.casefold() if ch.isalnum())
    return difflib.SequenceMatcher(None, clean(read), clean(truth)).ratio() >= 0.85


def measure(reader, count: int = 24, *, seed: int = 100, resolutions: dict[str, int] | None = None, flipped: bool | None = False, margin: float = 0.0) -> dict:
    """{resolution: {n, name, number, total, set_code, seconds_mean, seconds_p95}} for ``reader`` over ``count`` cards."""
    import time

    cards = make_set(count, seed=seed)
    report = {}
    for label, height in (resolutions or RESOLUTIONS).items():
        got = {"name": 0, "number": 0, "total": 0, "set_code": 0}
        seconds = []
        for picture, truth in cards:
            flat = at_resolution(picture, height)
            if margin:
                flat = with_margin(flat, margin)
            started = time.perf_counter()
            result = reader.read(flat, read_hp=False, flipped=flipped)
            name = reader.read_name(flat).name
            seconds.append(time.perf_counter() - started)
            got["name"] += _same_name(name, truth.name)
            got["number"] += (result.number_local or "").lstrip("0") == truth.number.lstrip("0")
            got["total"] += (result.number_total or "").lstrip("0") == truth.total.lstrip("0")
            got["set_code"] += truth.set_code in result.tokens
        seconds.sort()
        report[label] = {"n": len(cards), **{key: round(100 * value / len(cards), 1) for key, value in got.items()},
                         "seconds_mean": round(sum(seconds) / len(seconds), 2), "seconds_p95": round(seconds[int(0.95 * (len(seconds) - 1))], 2)}
    return report


def save_sample(path: Path, seed: int = 100, height: int = 880) -> None:
    card, _truth = render_card(seed)
    Image.fromarray(at_resolution(degrade(card, seed), height)).save(path)
