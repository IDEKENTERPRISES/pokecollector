"""Fine-tune the last blocks of DINOv2-small on catalogue pictures + phone-like views (ArcFace heads for the
card and the artwork window, plus a distillation term to the original model). Time-budgeted; pauses when
another program takes the GPU. Run: python train.py --root TRAINROOT --until "2026-11-18 07:30"
"""
import argparse, glob, json, math, pickle, random, subprocess, time, datetime as dt
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import torch, torch.nn.functional as F
from transformers import Dinov2Model

import common

dev = "cuda"
MEAN = torch.tensor(common.MEAN.reshape(1, 3, 1, 1)).to(dev)
STD = torch.tensor(common.STD.reshape(1, 3, 1, 1)).to(dev)


def norm_in(u8):  # (B,224,224,3) uint8 cuda -> normalised float (B,3,224,224)
    return (u8.permute(0, 3, 1, 2).float() / 255.0 - MEAN) / STD


class Net(torch.nn.Module):
    def __init__(self, train_blocks):
        super().__init__()
        self.m = Dinov2Model.from_pretrained("facebook/dinov2-small")
        self.nb = len(self.m.encoder.layer)
        self.first_train = self.nb - train_blocks
        for p in self.m.parameters():
            p.requires_grad = False
        for layer in self.m.encoder.layer[self.first_train:]:
            for p in layer.parameters():
                p.requires_grad = True
        for p in self.m.layernorm.parameters():
            p.requires_grad = True

    def forward(self, x, grad=True):
        with torch.no_grad():
            h = self.m.embeddings(x)
            for layer in self.m.encoder.layer[:self.first_train]:
                h = layer(h)
                h = h[0] if isinstance(h, tuple) else h
        with torch.set_grad_enabled(grad):
            for layer in self.m.encoder.layer[self.first_train:]:
                h = layer(h)
                h = h[0] if isinstance(h, tuple) else h
            h = self.m.layernorm(h)
        return h[:, 0]  # CLS (what the server takes)


@torch.no_grad()
def embed_all(net, arr, bs=256):
    net.eval()
    out = []
    for i in range(0, len(arr), bs):
        x = norm_in(torch.from_numpy(np.ascontiguousarray(arr[i:i + bs])).to(dev))
        with torch.autocast("cuda", dtype=torch.float16):
            out.append(F.normalize(net(x, grad=False).float(), dim=1).cpu())
    return torch.cat(out)


def load_eval_views(path):
    items = []
    for f in sorted(glob.glob(str(Path(path) / "*.pkl"))):
        items += pickle.load(open(f, "rb"))
    return items


@torch.no_grad()
def evaluate(net, gal_card, gal_art, cls_arr, names, ev):
    """ev: eval views (row, class, card jpg, art jpg). top1/5/20 for whole card and art, and how often the
    first pick is a same-name, different-art printing."""
    res = {}
    for kind, gal, idx in (("card", gal_card, 2), ("art", gal_art, 3)):
        imgs = np.stack([common.from_jpg(v[idx]) for v in ev])
        q = embed_all(net, imgs).to(dev)
        sims = q @ gal.to(dev).T
        top = sims.topk(20, dim=1).indices.cpu().numpy()
        tgt = np.array([v[1] for v in ev])
        hit = cls_arr[top] == tgt[:, None]
        res[f"{kind}_top1"] = float(hit[:, 0].mean())
        res[f"{kind}_top5"] = float(hit[:, :5].any(1).mean())
        res[f"{kind}_top20"] = float(hit.any(1).mean())
        tname = np.array([names[v[0]] for v in ev])
        top1name = np.array([names[i] for i in top[:, 0]])
        res[f"{kind}_samename_wrong_top1"] = float((~hit[:, 0] & (top1name == tname)).mean())
    res["views"] = len(ev)
    return res


def gpu_busy(reserved_bytes):
    try:
        used = int(subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True).split()[0])
    except Exception:
        return False
    others = used - reserved_bytes / 2**20 - 500
    return others > 2800  # the desktop alone is ~1.4 GB; a game is much more


class Bank(torch.utils.data.IterableDataset):
    """Streams phone-like views from the shard files (each loader worker takes every n-th shard, shuffles a
    buffer of a few shards). The clean pictures are read from the memmaps inside the worker."""

    def __init__(self, files, data_dir, seed):
        self.files, self.data_dir, self.seed = files, str(data_dir), seed

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        wid, nw = (info.id, info.num_workers) if info else (0, 1)
        rnd = random.Random(self.seed * 100 + wid)
        cc = np.load(Path(self.data_dir) / "clean_card.npy", mmap_mode="r")
        ca = np.load(Path(self.data_dir) / "clean_art.npy", mmap_mode="r")
        mine = self.files[wid::nw]
        rnd.shuffle(mine)
        for k in range(0, len(mine), 3):
            buf = []
            for f in mine[k:k + 3]:
                buf += pickle.load(open(f, "rb"))
            rnd.shuffle(buf)
            for row, cls, cj, aj in buf:
                yield (torch.from_numpy(common.from_jpg(cj).copy()), torch.from_numpy(common.from_jpg(aj).copy()),
                       torch.from_numpy(np.array(cc[row])), torch.from_numpy(np.array(ca[row])), cls)


def count_views(files, cache={}):
    n = 0
    for f in files:
        if f not in cache:
            cache[f] = len(pickle.load(open(f, "rb")))
        n += cache[f]
    return n


def arcface(emb, protos, target, s, m):
    cos = (F.normalize(emb, dim=1) @ F.normalize(protos, dim=1).T).clamp(-1 + 1e-6, 1 - 1e-6)
    theta = torch.acos(cos.gather(1, target[:, None]))
    cos = cos.scatter(1, target[:, None], torch.cos(theta + m))
    return F.cross_entropy(s * cos, target)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--until", required=True, help="London local time, e.g. '2026-11-18 07:30'")
    ap.add_argument("--blocks", type=int, default=4)
    ap.add_argument("--bs", type=int, default=48)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--proto_lr", type=float, default=1e-3)
    ap.add_argument("--scale", type=float, default=30.0)
    ap.add_argument("--margin", type=float, default=0.15)
    ap.add_argument("--distill", type=float, default=0.5)
    ap.add_argument("--eval_every_min", type=float, default=25)
    ap.add_argument("--min_views", type=int, default=8000)
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    root = Path(a.root)
    data = root / "data"
    runs = root / "runs"
    deadline = dt.datetime.strptime(a.until, "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo("Europe/London")).timestamp()
    cards = json.load(open(data / "cards.json"))
    split = json.load(open(data / "split.json"))
    cls_arr = np.array([c["class"] for c in cards])
    names = [c["name"] for c in cards]
    cc = np.load(data / "clean_card.npy", mmap_mode="r")
    ca = np.load(data / "clean_art.npy", mmap_mode="r")
    n_cls = int(cls_arr.max()) + 1
    log = open(runs / "train.log", "a")

    def P(*s):
        msg = f"[{dt.datetime.now():%m-%d %H:%M:%S}] " + " ".join(str(x) for x in s)
        print(msg, flush=True)
        log.write(msg + "\n")
        log.flush()

    torch.manual_seed(0)
    random.seed(0)
    teacher = Net(a.blocks).to(dev).eval()
    net = Net(a.blocks).to(dev)
    P("embedding the clean gallery with the original model")
    tg_card = embed_all(teacher, cc)
    tg_art = embed_all(teacher, ca)
    protos = {}
    for kind, g in (("card", tg_card), ("art", tg_art)):  # class prototypes start at the original embeddings
        pr = torch.zeros(n_cls, 384).index_add_(0, torch.from_numpy(cls_arr), g)
        protos[kind] = torch.nn.Parameter(F.normalize(pr, dim=1).to(dev))
    ev = load_eval_views(runs / "evalviews")
    P("eval views", len(ev))
    base = evaluate(teacher, tg_card, tg_art, cls_arr, names, ev)
    P("BASELINE (original model)", json.dumps(base))
    json.dump(base, open(root / "out" / "baseline.json", "w"))

    params = [p for p in net.parameters() if p.requires_grad]
    opt = torch.optim.AdamW([{"params": params, "lr": a.lr, "weight_decay": 0.05},
                             {"params": list(protos.values()), "lr": a.proto_lr, "weight_decay": 0}])
    scaler = torch.amp.GradScaler()
    ckpt_path = runs / "last.pt"
    best_path = runs / "best.pt"
    state = {"best": -1.0, "step": 0, "elapsed": 0.0}
    if ckpt_path.exists():
        ck = torch.load(ckpt_path, map_location=dev)
        net.load_state_dict(ck["net"])
        opt.load_state_dict(ck["opt"])
        state = ck["state"]
        for k in protos:
            protos[k].data = ck["protos"][k].to(dev)
        P("resumed", state)
    t_start = time.time()
    t0_elapsed = state["elapsed"]
    paused = 0.0
    last_eval = time.time()
    total_budget = deadline - t_start + t0_elapsed  # training seconds allowed in all
    base_lrs = [g["lr"] for g in opt.param_groups]

    def save(path):
        torch.save({"net": net.state_dict(), "opt": opt.state_dict(), "state": state,
                    "protos": {k: v.data for k, v in protos.items()}}, path)

    def do_eval(tag):
        gc, ga = embed_all(net, cc), embed_all(net, ca)
        r = evaluate(net, gc, ga, cls_arr, names, ev)
        net.train()
        score = r["card_top1"] + r["art_top1"] + 0.5 * (r["card_top20"] + r["art_top20"])
        P("EVAL", tag, "step", state["step"], json.dumps(r))
        if score > state["best"]:
            state["best"] = score
            torch.save({"net": net.state_dict(), "eval": r, "step": state["step"]}, best_path)
            P("new best", round(score, 4))
        return r

    done = False
    while not done and time.time() < deadline:
        files = sorted(glob.glob(str(runs / "bank" / "*.pkl")))
        nviews = count_views(files)
        if nviews < a.min_views:
            P("waiting for views", nviews)
            time.sleep(60)
            continue
        P("epoch over", nviews, "views")
        ds = Bank(files, data, state["step"])
        dl = torch.utils.data.DataLoader(ds, batch_size=a.bs, num_workers=a.workers, drop_last=True)
        net.train()
        tl = []
        for cu, au, ccl, cal, cls in dl:
            if gpu_busy(torch.cuda.memory_reserved()):
                P("GPU in use by another program; pausing")
                tp = time.time()
                while gpu_busy(torch.cuda.memory_reserved()) and time.time() < deadline:
                    time.sleep(60)
                paused += time.time() - tp
                P("resuming")
            if time.time() >= deadline:
                done = True
                break
            now_el = t0_elapsed + (time.time() - t_start - paused)
            state["elapsed"] = now_el
            prog = min(1.0, now_el / max(1.0, total_budget))
            f = prog / 0.02 if prog < 0.02 else 0.03 + 0.97 * 0.5 * (1 + math.cos(math.pi * prog))
            for g, b in zip(opt.param_groups, base_lrs):
                g["lr"] = b * f
            cls = cls.to(dev)
            cu, au, ccl, cal = (t.to(dev, non_blocking=True) for t in (cu, au, ccl, cal))
            x_card = norm_in(torch.cat([cu, ccl]))
            x_art = norm_in(torch.cat([au, cal]))
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
                tc = F.normalize(teacher(norm_in(ccl), grad=False).float(), dim=1)
                ta = F.normalize(teacher(norm_in(cal), grad=False).float(), dim=1)
            with torch.autocast("cuda", dtype=torch.float16):
                ec = net(x_card).float()
                ea = net(x_art).float()
            tgt2 = torch.cat([cls, cls])
            loss_arc = arcface(ec, protos["card"], tgt2, a.scale, a.margin) + arcface(ea, protos["art"], tgt2, a.scale, a.margin)
            B = len(cls)
            loss_kd = (1 - (F.normalize(ec[B:], dim=1) * tc).sum(1)).mean() + (1 - (F.normalize(ea[B:], dim=1) * ta).sum(1)).mean()
            loss = loss_arc + a.distill * loss_kd
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            scaler.step(opt)
            scaler.update()
            state["step"] += 1
            tl.append((loss_arc.item(), loss_kd.item()))
            if state["step"] % 50 == 0:
                m = np.mean(tl[-50:], 0)
                P(f"step {state['step']} arc {m[0]:.3f} kd {m[1]:.4f} lr_f {f:.3f} elapsed {now_el / 3600:.2f}h of {total_budget / 3600:.2f}h")
            if state["step"] % 500 == 0:
                save(ckpt_path)
            if time.time() - last_eval > a.eval_every_min * 60:
                save(ckpt_path)
                do_eval("periodic")
                last_eval = time.time()
    save(ckpt_path)
    do_eval("final")
    P("training finished", state)


if __name__ == "__main__":
    main()
