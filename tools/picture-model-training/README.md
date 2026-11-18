# Picture model fine-tuning

Fine-tunes DINOv2-small (the model behind the server's picture matcher, `backend/services/card_match/`) on
**catalogue card pictures made to look like phone photos**, and exports an ONNX file that drops into the matcher
unchanged (`pixel_values` float32 `[N,3,224,224]` -> `last_hidden_state` `[N,257,384]`, CLS token first).

Nothing here reads scan photos. The only inputs are public catalogue pictures. Code and docs live in the repo;
data, the virtualenv, checkpoints and outputs live **outside** it (default `ROOT=O:/Libraries/Documents/Projects/Claude/pokecollector-train`).
The scripts import `services.card_match.synthetic` and `detect` from the repo read-only.

## Run it

Needs an NVIDIA GPU (developed on an RTX 2080 8 GB, driver 596, Python 3.10), ~15 GB of disk.

```bash
py -3.10 -m venv $ROOT/venv
$ROOT/venv/Scripts/python -m pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
$ROOT/venv/Scripts/python -m pip install -r requirements.txt

# 1. data: TCGdex English physical cards (TCG Pocket skipped), same-name same-artwork pictures grouped into classes
python download_data.py --data $ROOT/data           # ~20k pictures, 8 parallel requests, UA pokecollector-training/1.0
python prep_clean.py    --data $ROOT/data           # 224x224 clean card + artwork-window arrays

# 2. phone-like views (CPU; synthetic.make_photo -> detect.detect_card -> extra jitter), as JPEG shards
OMP_NUM_THREADS=1 CARD_MATCH_THREADS=1 python gen_views.py --data $ROOT/data --out $ROOT/runs/evalviews --split eval  --workers 10 --limit 200 --seed 99 --shard 50
OMP_NUM_THREADS=1 CARD_MATCH_THREADS=1 python gen_views.py --data $ROOT/data --out $ROOT/runs/bank      --split train --workers 9 --until <epoch seconds> --seed 6

# 3. train on the GPU until a London-time deadline (pauses while another program holds the GPU; resumes from runs/last.pt)
python train.py --root $ROOT --until "2026-11-18 07:10"

# 4. export ONNX, check it, write out/report.md and the sha256
python export.py --root $ROOT
```

### What it does
- **Classes.** Pictures with the same name and an artwork-window perceptual hash within 10 of 64 bits are one class
  (reprints that pictures cannot separate). 1,000 classes are held out for evaluation.
- **Views.** `synthetic.make_photo` (background, tilt, perspective, colour cast, glare, blur, noise, JPEG; made at
  1024x1368 instead of 1536x2048 for speed), then the server's `detect_card` (so the finder's own errors are in the
  data), plus: 10% whole-picture-as-card, +-5% (sometimes 10%) crop offsets, motion/defocus blur, colour cast and noise,
  a finger/shadow patch, heavy JPEG, sleeve shine, low light. Both the flattened card and its `ART_BOX` window.
- **Training.** Last 4 blocks + final norm, fp16, AdamW, cosine schedule over the time budget. ArcFace heads
  (one for the card, one for the artwork window; prototypes start at the original model's embeddings) over
  phone-like and clean pairs, plus a distillation term keeping clean-picture embeddings near the original model.
- **Evaluation.** Phone-like views of held-out classes against all ~19.8k clean pictures embedded by the same model:
  top 1 / 5 / 20 (card and artwork) and how often the first pick is a same-name, different-art printing. This is
  synthetic only; the real test is the server's comparison on real photos.

## Handing the model to the server

`out/dinov2-small-cards-<date>.onnx` and `out/*.sha256` stay on this machine. Upload the `.onnx` through Scanner lab
on the server, rebuild the picture index with it (the index must be built with the same model that embeds the
queries), then compare on the real-photo benchmark.

## Licences and privacy
- DINOv2 (Meta AI) is Apache-2.0; `facebook/dinov2-small` is loaded from Hugging Face.
- Card pictures come from the public TCGdex API and are used privately for training; they are not redistributed.
  Do not publish the trained model or the data.
- No scan photos are used or needed.
