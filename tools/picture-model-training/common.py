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
# a 1024x1368 photo instead of 1536x2048: ~2.3x cheaper to make, and the finder shrinks photos to 900 px anyway
synthetic.PHOTO_W, synthetic.PHOTO_H = 1024, 1368


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


def hard_extras(img, rnd):
    """Extra real-photo trouble on top of the synthetic photo: motion blur, defocus, bigger framing errors,
    colour cast + noise, a finger/shadow patch over part of the card, heavy JPEG."""
    h, w = img.shape[:2]
    if rnd.random() < 0.25:
        k = rnd.choice([7, 11, 15])
        ker = np.zeros((k, k), np.float32)
        ker[k // 2, :] = 1.0 / k
        rot = cv2.getRotationMatrix2D((k / 2 - 0.5, k / 2 - 0.5), rnd.uniform(0, 180), 1)
        ker = cv2.warpAffine(ker, rot, (k, k)); ker /= max(ker.sum(), 1e-6)
        img = cv2.filter2D(img, -1, ker)
    if rnd.random() < 0.15:
        img = cv2.GaussianBlur(img, (0, 0), rnd.uniform(2.0, 4.0))
    if rnd.random() < 0.2:
        img = crop_jitter(img, rnd, 0.10)
    if rnd.random() < 0.3:
        f = img.astype(np.float32) * np.array([rnd.uniform(0.8, 1.2) for _ in range(3)], np.float32)
        f += np.random.default_rng(rnd.randrange(1 << 30)).standard_normal(img.shape) * rnd.uniform(4, 14)
        img = np.clip(f, 0, 255).astype(np.uint8)
    if rnd.random() < 0.1:
        patch = img.copy()
        cx, cy = rnd.randrange(w), rnd.randrange(h)
        cv2.ellipse(patch, (cx, cy), (rnd.randrange(w // 12, w // 5), rnd.randrange(h // 14, h // 6)), rnd.uniform(0, 180), 0, 360,
                    rnd.choice([(200, 160, 140), (60, 50, 50), (120, 120, 125)]), -1)
        img = cv2.addWeighted(patch, 0.8, img, 0.2, 0)
    if rnd.random() < 0.15:
        ok, enc = cv2.imencode(".jpg", img[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, rnd.choice([25, 35, 50])])
        img = cv2.imdecode(enc, 1)[..., ::-1].copy()
    return img


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
    flat = hard_extras(flat, rnd)
    if rnd.random() < 0.25:
        flat = sleeve_shine(flat, rnd)
    if rnd.random() < 0.2:
        flat = low_light(flat, rnd)
    return flat, art_of(flat)


def resize224(img):
    """Exactly the resize step of the server's embed.preprocess (uint8 in, uint8 out)."""
    return cv2.resize(img, (SIZE, SIZE), interpolation=cv2.INTER_AREA if min(img.shape[:2]) > SIZE else cv2.INTER_CUBIC)


def to_jpg(img, q=95):
    return cv2.imencode(".jpg", img[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes()


def from_jpg(b):
    return cv2.imdecode(np.frombuffer(b, np.uint8), 1)[..., ::-1]
