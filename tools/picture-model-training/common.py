"""Shared pieces: server-code shim, phone-like view generation, model wrapper."""
import io, math, os, random, sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))
# Import the server's matcher modules read-only (services/__init__ may pull heavy deps, so load the
# card_match package modules by name; services.card_match.* is what the server itself imports).
from services.card_match import detect, synthetic  # noqa: E402
from services.card_match.embed import preprocess  # noqa: E402

MEAN = np.array((0.485, 0.456, 0.406), dtype=np.float32).reshape(1, 1, 3)
STD = np.array((0.229, 0.224, 0.225), dtype=np.float32).reshape(1, 1, 3)
SIZE = 224


def to_tensor_array(img_rgb):
    """RGB uint8 (any size) -> float32 (3,224,224), exactly the server's preprocess."""
    return preprocess(img_rgb, SIZE, MEAN, STD)


def load_card(path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB").resize((detect.CARD_W, detect.CARD_H), Image.Resampling.LANCZOS))


def art_of(card):
    return detect.art_crop(card)


def sleeve_shine(img, rnd):
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ang = rnd.uniform(0, math.pi)
    d = (xx - w / 2) * math.cos(ang) + (yy - h / 2) * math.sin(ang)
    centre = rnd.uniform(-0.4, 0.4) * max(h, w)
    width = rnd.uniform(0.05, 0.2) * max(h, w)
    band = np.exp(-((d - centre) / width) ** 2) * rnd.uniform(0.15, 0.5)
    return np.clip(img.astype(np.float32) * (1 - band[..., None]) + 255 * band[..., None], 0, 255).astype(np.uint8)


def low_light(img, rnd):
    f = rnd.uniform(0.35, 0.7)
    out = (img.astype(np.float32) / 255.0) ** rnd.uniform(1.2, 1.8) * f * 255
    out += np.random.default_rng(rnd.randrange(1 << 30)).standard_normal(img.shape) * rnd.uniform(3, 9)
    return np.clip(out, 0, 255).astype(np.uint8)


def crop_jitter(card, rnd, amount=0.05):
    h, w = card.shape[:2]
    x0, x1 = rnd.uniform(-amount, amount), rnd.uniform(-amount, amount)
    y0, y1 = rnd.uniform(-amount, amount), rnd.uniform(-amount, amount)
    src = np.float32([[x0 * w, y0 * h], [w + x1 * w, y0 * h], [w + x1 * w, h + y1 * h], [x0 * w, h + y1 * h]])
    dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    m = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(card, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def degrade_flat(card, rnd):
    """Cheap phone-ish degradation of an already flat card (the 'whole picture as the card' case)."""
    img = card.astype(np.float32) * rnd.uniform(0.8, 1.1) * np.array([rnd.uniform(0.93, 1.07) for _ in range(3)], np.float32)
    img = np.clip(img, 0, 255).astype(np.uint8)
    k = rnd.choice([0, 3, 5])
    if k:
        img = cv2.GaussianBlur(img, (k, k), 0)
    ok, enc = cv2.imencode(".jpg", img[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, rnd.choice([60, 75, 88])])
    return cv2.imdecode(enc, 1)[..., ::-1].copy()


def phone_view(card_rgb: np.ndarray, seed: int):
    """One phone-like training view of a clean 630x880 card: returns (flat card 630x880 RGB, art window)."""
    rnd = random.Random(seed)
    if rnd.random() < 0.10:  # the finder gave up / the picture is the card
        flat = degrade_flat(card_rgb, rnd)
    else:
        jpg, _corners, _ = synthetic.make_photo(Image.fromarray(card_rgb), seed)
        photo = np.asarray(Image.open(io.BytesIO(jpg)).convert("RGB"))
        det = detect.detect_card(photo, check=True, whole=True)
        flat = det.card
    if rnd.random() < 0.7:
        flat = crop_jitter(flat, rnd, 0.05)
    if rnd.random() < 0.25:
        flat = sleeve_shine(flat, rnd)
    if rnd.random() < 0.2:
        flat = low_light(flat, rnd)
    return flat, art_of(flat)
