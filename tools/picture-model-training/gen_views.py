"""Generate phone-like views of training (or eval) classes into shards of JPEG bytes, until --until (epoch
seconds) or a STOP file in --out. Each view: class id, card row, 224 flat card, 224 artwork window."""
import argparse, json, os, pickle, random, time
from multiprocessing import Process
from pathlib import Path
import common

def worker(wid, a):
    root, out = Path(a.data), Path(a.out)
    cards = json.load(open(root / "cards.json")); split = json.load(open(root / "split.json"))
    ids = set(split[a.split]); rows = [i for i, c in enumerate(cards) if c["class"] in ids]
    rnd = random.Random(a.seed * 1000 + wid)
    buf, shard = [], 0
    count = 0
    while True:
        if a.limit and count >= a.limit: break
        if (out / "STOP").exists() or (a.until and time.time() > a.until): break
        row = rnd.choice(rows)
        seed = rnd.randrange(1 << 30)
        flat, art = common.phone_view(common.load_card(root / cards[row]["file"]), seed)
        buf.append((row, cards[row]["class"], common.to_jpg(common.resize224(flat)), common.to_jpg(common.resize224(art))))
        count += 1
        if len(buf) >= a.shard:
            tmp = out / f"s{a.seed}_w{wid}_{shard:05d}.tmp"; pickle.dump(buf, open(tmp, "wb")); os.replace(tmp, out / f"s{a.seed}_w{wid}_{shard:05d}.pkl")
            buf, shard = [], shard + 1
    if buf:
        tmp = out / f"s{a.seed}_w{wid}_{shard:05d}.tmp"; pickle.dump(buf, open(tmp, "wb")); os.replace(tmp, out / f"s{a.seed}_w{wid}_{shard:05d}.pkl")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--split", default="train"); ap.add_argument("--workers", type=int, default=9)
    ap.add_argument("--until", type=float, default=0); ap.add_argument("--shard", type=int, default=200)
    ap.add_argument("--limit", type=int, default=0); ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--per_class", action="store_true")
    a = ap.parse_args(); Path(a.out).mkdir(parents=True, exist_ok=True)
    ps = [Process(target=worker, args=(w, a)) for w in range(a.workers)]
    [p.start() for p in ps]; [p.join() for p in ps]
