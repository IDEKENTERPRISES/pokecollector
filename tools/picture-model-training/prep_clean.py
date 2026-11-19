"""Resize every clean catalogue picture (card, and its artwork window) to the model's 224x224 input and
store them as uint8 memmaps (the evaluation gallery, the teacher prototypes and the clean training pairs)."""
import argparse, json
from multiprocessing import Pool
from pathlib import Path
import numpy as np
import common

def work(args):
    root, i, rel = args
    card = common.load_card(Path(root) / rel)
    return i, common.resize224(card), common.resize224(common.art_of(card))

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--procs", type=int, default=10)
    a = ap.parse_args(); root = Path(a.data)
    cards = json.load(open(root / "cards.json")); n = len(cards)
    cc = np.lib.format.open_memmap(root / "clean_card.npy", "w+", np.uint8, (n, 224, 224, 3))
    ca = np.lib.format.open_memmap(root / "clean_art.npy", "w+", np.uint8, (n, 224, 224, 3))
    with Pool(a.procs) as p:
        for k, (i, c, art) in enumerate(p.imap_unordered(work, [(str(root), i, c["file"]) for i, c in enumerate(cards)], chunksize=16)):
            cc[i] = c; ca[i] = art
            if k % 2000 == 0: print(k, n, flush=True)
    cc.flush(); ca.flush(); print("done", n)
