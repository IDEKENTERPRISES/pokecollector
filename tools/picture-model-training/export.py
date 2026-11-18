"""Export the best checkpoint to ONNX with the original interface (pixel_values [N,3,224,224] -> last_hidden_state
[N,257,384]), check it against PyTorch and against the server's OnnxEmbedder, write the sha256 and report.md.
Run: python export.py --root TRAINROOT
"""
import argparse, datetime as dt, hashlib, json, re, sys
from pathlib import Path

import numpy as np
import torch
import onnx, onnxruntime as ort
from transformers import Dinov2Model

import common


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--ckpt", default="best.pt")
    ap.add_argument("--hours", default="", help="training time text for the report")
    a = ap.parse_args()
    root = Path(a.root)
    out = root / "out"
    ck = torch.load(root / "runs" / a.ckpt, map_location="cpu")
    model = Dinov2Model.from_pretrained("facebook/dinov2-small", attn_implementation="eager")
    sd = {k[2:]: v for k, v in ck["net"].items() if k.startswith("m.")}
    print(model.load_state_dict(sd, strict=False))
    model.eval()

    class Wrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            return self.m(pixel_values=pixel_values).last_hidden_state

    stamp = dt.date.today().isoformat()
    path = out / f"dinov2-small-cards-{stamp}.onnx"
    dummy = torch.randn(2, 3, 224, 224)
    torch.onnx.export(Wrap(model), (dummy,), str(path), input_names=["pixel_values"], output_names=["last_hidden_state"],
                      dynamic_axes={"pixel_values": {0: "batch"}, "last_hidden_state": {0: "batch"}}, opset_version=17, do_constant_folding=True)
    onnx.checker.check_model(onnx.load(str(path)))
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    (out / (path.name + ".sha256")).write_text(f"{sha}  {path.name}\n")
    print("sha256", sha, "size", path.stat().st_size)

    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    i, o = sess.get_inputs()[0], sess.get_outputs()[0]
    print("interface:", i.name, i.type, i.shape, "->", o.name, o.type, o.shape)
    cc = np.load(root / "data" / "clean_card.npy", mmap_mode="r")
    sample = np.stack([np.array(cc[k]) for k in (0, 500, 5000, 12000, 19000) if k < len(cc)])
    pixels = np.stack([common.to_tensor_array(s) for s in sample])
    ref = model(pixel_values=torch.from_numpy(pixels)).last_hidden_state.detach().numpy()
    got = sess.run(None, {"pixel_values": pixels})[0]
    maxdiff = float(np.abs(ref - got).max())
    # batch of 1 works too (dynamic batch)
    one = sess.run(None, {"pixel_values": pixels[:1]})[0]
    print("max abs diff vs PyTorch:", maxdiff, "shape", got.shape, "batch-1 shape", one.shape)

    # the server's own embedder code (checksum check off: it is not the pinned original)
    sys.path.insert(0, str(common.REPO / "backend"))
    from services.card_match.embed import OnnxEmbedder
    emb = OnnxEmbedder("dinov2-small", path=path, verify=False)
    vecs = emb.embed(list(sample))
    cls_ref = ref[:, 0, :] / np.linalg.norm(ref[:, 0, :], axis=1, keepdims=True)
    cosines = (vecs * cls_ref).sum(1)
    print("OnnxEmbedder vs PyTorch CLS cosine:", cosines.round(6).tolist(), "dim", vecs.shape)

    base = json.load(open(out / "baseline.json"))
    best = ck_eval = torch.load(root / "runs" / "best.pt", map_location="cpu")
    fin = best["eval"]
    log = (root / "runs" / "train.log").read_text()
    first = re.search(r"\[(\d\d-\d\d \d\d:\d\d:\d\d)\] embedding the clean", log)
    last = re.findall(r"\[(\d\d-\d\d \d\d:\d\d:\d\d)\]", log)[-1]
    cards = json.load(open(root / "data" / "cards.json"))
    split = json.load(open(root / "data" / "split.json"))

    def row(k):
        return f"| {k} | {base[k] * 100:.1f}% | {fin[k] * 100:.1f}% |"
    lines = [
        "# Picture model fine-tune report", "",
        "**Offline, synthetic only.** These numbers come from phone-like views *made from catalogue pictures* of 1,000 held-out "
        "classes, searched against all clean catalogue pictures. The real test is the server's comparison on real photos "
        "(the ~280-photo set), which this machine does not have.", "",
        f"Model: `{path.name}` sha256 `{sha}`", "",
        "## Held-out results (original DINOv2-small vs fine-tuned)", "",
        "| metric | original | fine-tuned |", "|---|---|---|",
        *[row(k) for k in ("card_top1", "card_top5", "card_top20", "art_top1", "art_top5", "art_top20",
                           "card_samename_wrong_top1", "art_samename_wrong_top1")], "",
        f"Evaluation views: {fin['views']} (card and artwork window of each). `samename_wrong_top1` = first pick is a printing of "
        "the same name but a different artwork class.", "",
        "## Data", "",
        f"- {len(cards)} English physical card pictures (TCGdex, TCG Pocket skipped), {len(split['train']) + len(split['eval'])} classes "
        f"after grouping same-name same-artwork pictures by perceptual hash; {len(split['train'])} train / {len(split['eval'])} held out.",
        "- Training views: `synthetic.make_photo` + `detect.detect_card` (the server's finder), crop jitter +-5%, 10% whole-picture-as-card, "
        "25% sleeve shine, 20% low light. Both the flattened card and its ART_BOX window.", "",
        "## Settings and time", "",
        "- Last 4 transformer blocks + final norm trained (fp16 autocast), AdamW; ArcFace heads (s=30, m=0.15) for card and artwork, "
        "initialised from the original embeddings, plus 0.5 x distillation to the original model on clean pictures.",
        f"- Best checkpoint at step {best['step']}. Training log window: {first.group(1) if first else '?'} to {last} (local). {a.hours}", "",
        "## Export", "",
        f"- Interface: `{i.name}` {i.type} {i.shape} -> `{o.name}` {o.shape}, opset 17.",
        f"- Max abs diff onnxruntime vs PyTorch on 5 pictures: {maxdiff:.2e}; server `OnnxEmbedder` CLS cosine to PyTorch: min {cosines.min():.6f}.", ""]
    (out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print("wrote report.md")


if __name__ == "__main__":
    main()
