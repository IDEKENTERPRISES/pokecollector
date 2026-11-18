"""Download English physical card pictures from the TCGdex API and group same-artwork reprints into classes.

Usage: python download_data.py --data DIR [--holdout 1000]
Writes DIR/images/<card id>_en.webp, DIR/cards.json (id, name, set, file, class) and DIR/split.json.
Skips digital sets (series 'tcgp', TCG Pocket), like the app's catalogue.
"""
import argparse, json, random, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

API = "https://api.tcgdex.net/v2/en"
UA = {"User-Agent": "pokecollector-training/1.0"}
ART_BOX = (0.07, 0.115, 0.93, 0.545)  # same as backend detect.ART_BOX


def get(url, binary=False, tries=5):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                data = r.read()
            return data if binary else json.loads(data)
        except Exception as exc:
            if attempt == tries - 1:
                print("FAILED", url, exc, file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))


def phash(gray):
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    dct = cv2.dct(small)[:8, :8]
    bits = (dct > np.median(dct)).flatten()
    return np.packbits(bits)  # 8 bytes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--holdout", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    root = Path(args.data); (root / "images").mkdir(parents=True, exist_ok=True)

    sets = get(f"{API}/sets")
    def set_info(s):
        return get(f"{API}/sets/{s['id']}")
    with ThreadPoolExecutor(6) as ex:
        details = list(ex.map(set_info, sets))
    cards = []
    for d in details:
        if not d: continue
        if (d.get("serie") or {}).get("id", "").lower() == "tcgp":
            continue
        for c in d.get("cards", []):
            if c.get("image"):
                cards.append({"id": c["id"] + "_en", "name": c.get("name", ""), "set": d["id"], "url": c["image"] + "/high.webp"})
    print(len(cards), "cards with pictures from", len(details), "sets")

    def fetch(c):
        path = root / "images" / (c["id"] + ".webp")
        if not path.exists() or path.stat().st_size == 0:
            data = get(c["url"], binary=True)
            if data is None: return False
            path.write_bytes(data)
        return True
    with ThreadPoolExecutor(8) as ex:
        ok = list(ex.map(fetch, cards))
    cards = [c for c, k in zip(cards, ok) if k]
    print(len(cards), "downloaded")

    hashes = []
    for c in cards:
        c["file"] = "images/" + c["id"] + ".webp"
        img = np.asarray(Image.open(root / c["file"]).convert("L"))
        h, w = img.shape
        x0, y0, x1, y1 = ART_BOX
        hashes.append(phash(img[int(y0*h):int(y1*h), int(x0*w):int(x1*w)]))
    H = np.unpackbits(np.stack(hashes), axis=1).astype(np.int16)
    # classes: same name and artwork perceptual hash within 10 of 64 bits (union-find)
    parent = list(range(len(cards)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    by_name = {}
    for i, c in enumerate(cards): by_name.setdefault(c["name"], []).append(i)
    for idx in by_name.values():
        for a in range(len(idx)):
            for b in range(a + 1, len(idx)):
                if int(np.abs(H[idx[a]] - H[idx[b]]).sum()) <= 10:
                    parent[find(idx[a])] = find(idx[b])
    roots = {}
    for i, c in enumerate(cards):
        c["class"] = roots.setdefault(find(i), len(roots))
    n_classes = len(roots)
    rnd = random.Random(args.seed)
    ids = list(range(n_classes)); rnd.shuffle(ids)
    split = {"eval": sorted(ids[:args.holdout]), "train": sorted(ids[args.holdout:])}
    json.dump(cards, open(root / "cards.json", "w"))
    json.dump(split, open(root / "split.json", "w"))
    print(f"{len(cards)} pictures, {n_classes} classes ({len(split['train'])} train, {len(split['eval'])} eval)")


if __name__ == "__main__":
    main()
