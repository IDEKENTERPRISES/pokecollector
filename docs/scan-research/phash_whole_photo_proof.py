"""Tiny proof: can today's pHash step (whole photo vs candidate pictures) ever decide a scan?

Builds synthetic phone-style photos of 9 same-name cards (Pikachu printings), then compares
the backend's pHash (same algorithm as backend/api/recognize.py::_perceptual_hash) of
  1. the whole photo (what the backend hashes today),
  2. a crop to the on-screen guide frame (no detection),
  3. an ideal perspective rectification from the known corners (what a detector would give)
against all 9 reference pictures, with the backend's thresholds (distance <= 20, margin >= 5).
Synthetic, so it says nothing about real-world accuracy; it only shows what dominates the hash.

Usage (needs Pillow and NumPy; about 30 seconds per run):
    mkdir refs && cd refs
    for id_path in base/basep/1 sv/sv04.5/018 tcgp/P-A/026 me/30th/032 me/30th/041 \
                   swsh/swsh7/49 sm/sm11/56 neo/neo1/70 sv/svp/101; do
      curl -sf "https://assets.tcgdex.net/en/$id_path/low.png" -o "$(echo $id_path | tr / _).png"
    done
    cd .. && python phash_whole_photo_proof.py refs 7      # the last argument is the random seed

Results on 2026-11-04 (seeds 7, 1, 2, 3; 27 photos each, 108 in total):
    whole photo   right 2, wrong 9, abstained 97
    guide crop    right 11, wrong 4, abstained 93
    rectified     right 106, wrong 0, abstained 2
"""
import glob
import io
import os
import random
import sys

import numpy as np
from PIL import Image, ImageFilter

REF_DIR = sys.argv[1]
SEED = int(sys.argv[2]) if len(sys.argv) > 2 else 7
random.seed(SEED)
np.random.seed(SEED)

PHASH_MAX_DISTANCE = 20
PHASH_MIN_MARGIN = 5


def dct_matrix(size=32):
    positions = np.arange(size)
    frequencies = np.arange(size)[:, None]
    return 2 * np.cos(np.pi * frequencies * (2 * positions + 1) / (2 * size))


DCT = dct_matrix()


def phash(img):
    pixels = np.asarray(img.convert("L").resize((32, 32), Image.Resampling.LANCZOS), dtype=float)
    low = (DCT @ pixels @ DCT.T)[:8, :8]
    return (low > np.median(low)).flatten()


def coeffs(src_pts, dst_pts):
    """PIL PERSPECTIVE coefficients mapping output (dst) points to input (src) points."""
    a, b = [], []
    for (x, y), (u, v) in zip(dst_pts, src_pts):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    return np.linalg.solve(np.array(a, float), np.array(b, float)).tolist()


def background(w, h, kind):
    if kind == "wood":
        x = np.linspace(0, 40, w)[None, :] + np.random.randn(h, 1) * 0.3
        grain = (np.sin(x + np.linspace(0, 6, h)[:, None]) + 1) / 2
        base = np.stack([120 + 60 * grain, 80 + 40 * grain, 40 + 20 * grain], -1)
    elif kind == "mat":
        base = np.full((h, w, 3), 45.0)
    else:  # paper
        g = np.linspace(235, 205, h)[:, None, None]
        base = np.repeat(np.repeat(g, w, 1), 3, 2)
    base = base + np.random.randn(h, w, 3) * 6
    return Image.fromarray(np.clip(base, 0, 255).astype("uint8"), "RGB")


def make_photo(card, kind, width_frac, jitter, glare):
    W, H = 1536, 2048
    bg = background(W, H, kind)
    cw = W * width_frac
    ch = cw * 88 / 63
    cx, cy = W / 2 + random.uniform(-0.05, 0.05) * W, H / 2 + random.uniform(-0.05, 0.05) * H
    corners = [(cx - cw / 2, cy - ch / 2), (cx + cw / 2, cy - ch / 2), (cx + cw / 2, cy + ch / 2), (cx - cw / 2, cy + ch / 2)]
    corners = [(x + random.uniform(-jitter, jitter) * cw, y + random.uniform(-jitter, jitter) * cw) for x, y in corners]
    big = card.convert("RGBA").resize((630, 880), Image.Resampling.LANCZOS)
    src = [(0, 0), (630, 0), (630, 880), (0, 880)]
    warped = big.transform((W, H), Image.Transform.PERSPECTIVE, coeffs(src, corners), Image.Resampling.BICUBIC)
    photo = bg.convert("RGBA")
    photo.alpha_composite(warped)
    photo = photo.convert("RGB")
    arr = np.asarray(photo, float)
    arr = arr * random.uniform(0.75, 1.1) * np.array([random.uniform(0.92, 1.08) for _ in range(3)])
    if glare:
        gx, gy = cx + random.uniform(-0.3, 0.3) * cw, cy + random.uniform(-0.3, 0.3) * ch
        yy, xx = np.mgrid[0:H, 0:W]
        blob = np.exp(-(((xx - gx) / (0.25 * cw)) ** 2 + ((yy - gy) / (0.15 * ch)) ** 2))
        arr = arr * (1 - 0.6 * blob[..., None]) + 255 * 0.6 * blob[..., None]
    photo = Image.fromarray(np.clip(arr, 0, 255).astype("uint8")).filter(ImageFilter.GaussianBlur(1.0))
    buf = io.BytesIO(); photo.save(buf, "JPEG", quality=85); buf.seek(0)
    return Image.open(buf).convert("RGB"), corners


def guide_crop(photo):
    W, H = photo.size
    gw = 0.7 * W; gh = gw * 88 / 63
    return photo.crop((int(W / 2 - gw / 2), int(H / 2 - gh / 2), int(W / 2 + gw / 2), int(H / 2 + gh / 2)))


def rectify(photo, corners):
    dst = [(0, 0), (245, 0), (245, 337), (0, 337)]
    return photo.transform((245, 337), Image.Transform.PERSPECTIVE, coeffs(corners, dst), Image.Resampling.BICUBIC)


refs = {os.path.basename(p)[:-4]: Image.open(p) for p in sorted(glob.glob(os.path.join(REF_DIR, "*.png")))}
ref_hash = {k: phash(v) for k, v in refs.items()}
print(f"{len(refs)} references")
pairwise = [int((ref_hash[a] != ref_hash[b]).sum()) for a in refs for b in refs if a < b]
print(f"reference-to-reference pHash distance: min {min(pairwise)}, median {int(np.median(pairwise))}")

conditions = [("paper", 0.55, 0.03, False), ("wood", 0.65, 0.05, False), ("mat", 0.6, 0.04, True)]
stats = {m: {"accepted_right": 0, "accepted_wrong": 0, "abstained": 0, "true_d": [], "best_wrong_d": []} for m in ("whole photo", "guide crop", "rectified")}
for name, card in refs.items():
    for kind, frac, jitter, glare in conditions:
        photo, corners = make_photo(card, kind, frac, jitter, glare)
        for mode, img in (("whole photo", photo), ("guide crop", guide_crop(photo)), ("rectified", rectify(photo, corners))):
            h = phash(img)
            dist = sorted(((int((h != ref_hash[k]).sum()), k) for k in refs))
            true_d = next(d for d, k in dist if k == name)
            wrong_d = min(d for d, k in dist if k != name)
            best_d, best_k = dist[0]
            margin = dist[1][0] - best_d
            s = stats[mode]
            s["true_d"].append(true_d); s["best_wrong_d"].append(wrong_d)
            if best_d <= PHASH_MAX_DISTANCE and margin >= PHASH_MIN_MARGIN:
                s["accepted_right" if best_k == name else "accepted_wrong"] += 1
            else:
                s["abstained"] += 1

n = len(refs) * len(conditions)
print(f"{n} synthetic photos per mode; backend thresholds: distance <= {PHASH_MAX_DISTANCE}, margin >= {PHASH_MIN_MARGIN}")
for mode, s in stats.items():
    print(
        f"{mode:<12} decided right {s['accepted_right']:>2}/{n}  wrong {s['accepted_wrong']:>2}  abstained {s['abstained']:>2}  "
        f"| distance to true card median {int(np.median(s['true_d']))} (max {max(s['true_d'])}), "
        f"nearest wrong card median {int(np.median(s['best_wrong_d']))}"
    )
