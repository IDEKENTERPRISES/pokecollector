# Picture matcher (Scanner Phase 1 prototype)

Status: **prototype; on nonprod it runs in shadow mode (below) and changes nothing for trainers.** Today's scan path (Ollama / Gemini through `scan_queue.py`, `scan_providers.py` and `api/recognize.py`) is unchanged. This is Phase 1 of `docs/SCAN_RESEARCH.md` §3.8: build the matcher, measure it on the T340, and read the numbers in **Settings → Data & sync → Scanner lab** (admins only).

## How it works

```
photo
  ├─ detect.py    find the card (OpenCV contours, largest convex quad near 63:88 inside the guide area),
  │               flatten it to 630×880; no credible quad → plain guide crop (low confidence)
  ├─ embed.py     DINOv2 ViT-S/14 (ONNX Runtime, CPU, 3 threads), 224×224 → 384 numbers, L2-normalised;
  │               the card at 0° and at 180°
  ├─ index.py     numpy cosine search in an in-memory matrix of every English card picture → top 20
  ├─ ocr.py       RapidOCR on the bottom strips (number/total, set code), optionally the HP strip
  └─ pipeline.py  decide with the existing rules in `api/recognize.py` + picture similarity and lead
                  → "decided" (with the mechanism) or "unsure" (with the reason and the top matches)
```

The decision (`pipeline.decide`) reuses `_candidate_rank_key` and `_metadata_decision` from `api/recognize.py` (number, printed total, set code, regulation mark, artist, HP), so the matcher and today's scanner agree on what counts as evidence. On top of that:

- a rules decision is accepted only if the chosen printing is also among the 10 closest pictures and its similarity is at least `CARD_MATCH_SIM_MIN_WITH_RULES` (0.55);
- if the number matches several printings, the picture breaks the tie only with a clear gap (`CARD_MATCH_LEAD_MIN_PICTURE_ONLY`, 0.06);
- with no usable number, the picture alone decides only at similarity ≥ `CARD_MATCH_SIM_MIN_PICTURE_ONLY` (0.80) **and** lead ≥ 0.06;
- the index is English only and the language is not used as evidence.

The thresholds are **provisional**; the benchmark records every photo's features so they can be tuned once the labelled set exists.

The pipeline is pure: it reads the index and, through a `candidate_loader`, the catalogue; it writes nothing.

## Files

| File | Purpose |
| --- | --- |
| `backend/services/card_match/detect.py` | card finder / flattener, confidence |
| `…/embed.py` | `Embedder` interface, `OnnxEmbedder`, `FakeEmbedder` (tests) |
| `…/model_specs.py` | pinned model URL + sha256 (standard library only, read by the Dockerfile) |
| `…/index.py` | build / load / search the index; incremental, checkpointed |
| `…/ocr.py` | RapidOCR strips + regex parsing (`parse_text` is pure) |
| `…/pipeline.py` | `CardMatcher`, `decide`, `db_candidate_loader` |
| `…/synthetic.py`, `…/benchmark.py` | phone-style synthetic photos; synthetic and labelled benchmarks; reports |
| `…/jobs.py` | one-at-a-time background jobs, nonprod autorun, after-sync hook |
| `…/shadow.py` | shadow mode: the background worker, and the report the Scanner lab reads back |
| `backend/api/card_match.py` | admin API: `GET /api/card-match/status`, `GET /shadow`, `POST /index`, `POST /benchmark`, `POST /stop` |
| `backend/scripts/scan_benchmark.py` | the same build/benchmark from a shell |
| `backend/scripts/fetch_card_match_models.py` | build-time model download with checksum |
| `frontend/src/components/settings/ScannerLabSection.jsx` | the Scanner lab page |
| `backend/tests/test_card_match.py`, `test_card_match_shadow.py` | tests with the fake embedder and generated fixture cards (one optional real-model test) |

On disk (`CARD_MATCH_DIR`, default `/app/data/card-match`; mounted in `docker-compose.nonprod.yml`):

- `index/<model>/vectors.npy` + `entries.json` (card id and picture key per row, build time, count);
- `reports/benchmark-<kind>-<timestamp>.json`;
- `hires/` (cached high-resolution TCGdex pictures for the synthetic photos);
- `autorun.json` (marker so the nonprod autorun happens once per matcher version).

## The index

- Source: the server's cached small pictures (`image_cache`, filled by `CardPictureWarmer`); English, physical cards only (digital-only TCG Pocket printings are left out, as the scanner does).
- A row is `(card id, picture key)`. The key comes from `card_picture_packs.card_image_key`, which carries a hash of the picture URL, so a changed picture is re-embedded and an unchanged one is reused. Changing the model builds a new index next to the old one.
- Builds checkpoint every 1,000 vectors, so a restart continues.
- 20,000 cards × 384 × 4 bytes ≈ 31 MB in RAM.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `CARD_MATCH_DIR` | `/app/data/card-match` | index, reports, cached pictures |
| `CARD_MATCH_MODEL_DIR` | `/app/card-match-models` | where the image has the model file |
| `CARD_MATCH_THREADS` | `3` (1–8) | ONNX Runtime and OpenCV thread cap |
| `SCAN_MATCHER_AUTORUN` | off | **nonprod only**: once per matcher version, after startup, fill the picture cache if needed, build the index, run the synthetic benchmark |
| `SCAN_MATCHER_SHADOW` | off | **nonprod only**: shadow mode (below) |
| `SCAN_MATCHER_INDEX_AFTER_SYNC` | off | after `schedule_after_sync` (card sync → picture warm-up), add the new pictures to the index; nonprod sets it |
| `CARD_MATCH_SIM_MIN_WITH_RULES`, `CARD_MATCH_SIM_MIN_PICTURE_ONLY`, `CARD_MATCH_LEAD_MIN_PICTURE_ONLY` | 0.55 / 0.80 / 0.06 | decision thresholds |

Prod sets none of the automatic flags. An admin can still press the buttons on prod, but prod has no `card-match` volume, so results would not survive a container re-create.

Limits: one index build or benchmark at a time (a second request gets `started: false`); jobs run in a thread at `nice 10` where the OS allows it; ONNX Runtime gets 3 intra-op threads and OpenCV 3.

## Shadow mode (Phase 2, nonprod only)

`SCAN_MATCHER_SHADOW=1` (set in `docker-compose.nonprod.yml` only) runs the matcher beside today's path and records what it would have decided. **Nothing changes for trainers**: no screen, no result, no extra wait.

- **When**: right after a scan upload (`POST /api/recognize/jobs`) the stored photos are queued. This does not depend on Ollama, so scans that are waiting for the scanner are covered too.
- **Who**: only trainers who switched on "Share scanner diagnostics" (the same consent and the same `SCAN_TRACE_DIR` as the trace). Without consent nothing is run or written.
- **How**: one worker thread (`card-match-shadow`), one photo at a time, `nice 10`, the usual 3-thread cap. It waits while an index build or benchmark is running, and it runs in its own thread, so recognition never waits for it. Each photo is run once; a restart finds the record on disk and does not repeat it. A burst of more than 500 queued photos drops the extra ones.
- **Not ready**: if the model file, the index or the OCR library is missing, the photo is skipped and the reason is recorded (`model_missing`, `index_not_built`, `ocr_missing`, `model_error`, `photo_unavailable`, `match_failed`). A skipped photo is not retried.
- **Where it is recorded**: `user-N/shadow/jobJ-itemI.shadow` beside the traces (JSON; the `.shadow` suffix keeps it out of the trace listings and counts), and merged into the scan's trace as a `shadow` object when that trace is saved (or, if the trace was saved first, added to it as soon as the matcher finishes). No new tables.

The `shadow` object in the trace:

| Field | Meaning |
| --- | --- |
| `status`, `reason` | `ok`, or `skipped` with why |
| `matcher_version`, `model` | which matcher and which embedding model |
| `outcome`, `decision`, `unsure_reason` | `decided` / `unsure`; the decision (`tcg_card_id`, mechanism, similarity, lead) or the reason |
| `matches` | the top 20 with similarity, rank, name, number, set |
| `ocr` | number, printed total, HP and the first tokens read |
| `detection`, `timings_ms` | card finder result; detect / embed / search / ocr / decide / total |
| `agreement`, `agrees`, `current_selected`, `current_rank_in_matcher` | filled when the current path finishes: `same`, `different` (both decided), `matcher_only`, `current_only`, `neither`; `agrees` is true/false only when both decided |
| `correct`, `ground_truth_rank`, `truth_lang` | filled when the trainer confirms a card in review: whether the matcher's decision was the confirmed card (null when it did not decide), where the confirmed card sat in the matcher's top 20, and its language |

Scanner lab → **Shadow run** shows, from the traces (refreshed every 30 s):

- **Scans compared** and **Agree when both decided** (`same` / both decided);
- **Matcher would decide on its own**: the share of photos where the matcher decided;
- **Median matcher time** (the `total` stage);
- **On the N scans you confirmed (English cards)**: for each path, how often it decided and, of those, how often it was right; and for the scans where both decided differently, how often the matcher, Ollama or neither was right. Non-English confirmations are left out, because the index holds English only;
- **Latest disagreements**: card names only (matcher, Ollama and, when confirmed, the confirmed card and who was right);
- skipped photos with their reasons.

"Run on diagnostics" (the labelled benchmark) reads the same trace fields. Its report adds **Matcher and Ollama side by side**: the matcher as recorded at scan time (the `shadow` object) and the matcher run again just now, each against Ollama's pick on the same confirmed photos, with the number of photos where they decided differently and who was right (`side_by_side` in the report JSON; `scripts/scan_benchmark.py` saves the same report). Traces without shadow data still count in the re-run column.

## Reading the Scanner lab

- **English cards indexed — N of M**: pictures in the index vs. English physical cards with a catalogue picture. A gap means pictures are not cached yet (run "Prepare card pictures" first) or the build is not finished.
- **Build index / Update index**: embeds the pictures that have no vector yet. **Run benchmark (synthetic)**: about 400 English cards, a phone-like photo of each (background, tilt, perspective, colour cast, glare, blur, noise, JPEG, card at 55–65% of the frame, 10% upside down), including 50 reprint traps (a name with at least four printings) and 80 holo / full-art rarities. **Run on diagnostics**: the traces under `SCAN_TRACE_DIR` with a confirmed answer, shown next to what today's Ollama path got on the same photos.
- The report shows the §3.8 pass bar, each row marked ✓ (passes), ✗ (fails) or · (not measured):
  1. right printing in the top 20 ≥ 97%;
  2. decided without a model ≥ 70%, of which right ≥ 98%;
  3. matcher vs. today's Ollama path (read from the labelled report's Ollama block; judged by a person for now);
  4. 95th percentile per photo ≤ 1.5 s and extra memory ≤ 1.5 GB.
- **Synthetic numbers are an upper bound**: the photos are made from the same artwork the index holds. The labelled run is the honest one.
- Memory is read from `/proc` (Linux only), so it is "not measured" on a Windows or macOS host. "Extra" is the peak of the whole backend process minus its size when the job started.

## OCR choice

RapidOCR (PP-OCRv4 detection and recognition models, ONNX Runtime) installs cleanly into the slim image when installed with `--no-deps` (its wheel otherwise drags in the full `opencv-python`, which needs system GL libraries and clashes with `opencv-python-headless`). The models ship inside the wheel (about 16 MB), so nothing downloads at runtime. Tesseract would have needed an apt package and a separate binary; it stays the fallback idea if RapidOCR proves too slow on the T340. A tight bottom strip is read first; the wider strip only if no number came out. HP is read only when `CardMatcher(read_hp=True)`; it is off by default because the strip is the slowest to read and HP is weak evidence.

## Licences (checked 2026-11-04)

| Part | Licence |
| --- | --- |
| DINOv2 ViT-S/14 weights (Meta AI, `facebook/dinov2-small`) | Apache-2.0 |
| ONNX export `onnx-community/dinov2-small` (commit `8b1f705a`, sha256 `f22797ea…`) | follows the base model, Apache-2.0 |
| RapidOCR (`rapidocr-onnxruntime` 1.3.24) and PaddleOCR PP-OCRv4 models | Apache-2.0 |
| OpenCV 4.10 (`opencv-python-headless`) | Apache-2.0 (the wheel bundles FFmpeg libraries under LGPL) |
| ONNX Runtime 1.19.2 | MIT |
| Shapely, pyclipper, six | BSD-3-Clause, MIT, MIT |
| tqdm | MPL-2.0 and MIT |

All permissive; the project itself is AGPL-3.0-only. TCGdex card pictures are fetched from the same CDN the app already uses.

## Models in the image

`backend/Dockerfile` runs `fetch_card_match_models.py` after installing the requirements: it downloads the pinned URL, checks the sha256 and puts the file in `/app/card-match-models`. This layer is cached until `model_specs.py` changes. At runtime `OnnxEmbedder` checks the sha256 again before loading. To add a second model (MobileCLIP, SigLIP) for comparison, add an entry to `MODEL_SPECS`; the index is stored per model name. The phone can later load the same `.onnx` file with `onnxruntime-web`, and the `.npy`/ids format is plain.

## Next steps

1. **Read the T340 numbers** (this PR) and tune the thresholds; fix the stage the report names if the pass bar fails.
2. **Labelled benchmark** once trainers have scanned 300–400 cards with diagnostics on: press "Run on diagnostics".
3. **Shadow mode** on nonprod (built, see above): read the Shadow run block after 300-400 confirmed scans and decide on the thresholds.
4. **Primary mode** with the Ollama fallback only when the gaming PC answers a quick check, and "straight to the inbox" (with the picture top matches) when the scanner is unreachable, as the owner chose.
5. **Phone version** reusing the same model file and index format.
