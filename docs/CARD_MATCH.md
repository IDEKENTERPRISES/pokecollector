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
  ├─ ocr.py       RapidOCR on the bottom strips (number/total, set code); names.py reads the name line
  │               at the top → close catalogue names → text candidates merged with the picture top 20 (v3)
  └─ pipeline.py  decide with the existing rules in `api/recognize.py` + picture similarity and lead
                  → "decided" (with the mechanism) or "unsure" (with the reason and the top matches)
```

The decision (`pipeline.decide`) reuses `_candidate_rank_key` and `_metadata_decision` from `api/recognize.py` (number, printed total, set code, regulation mark, artist, HP), so the matcher and today's scanner agree on what counts as evidence. On top of that:

- a rules decision is accepted only if the chosen printing is also among the 10 closest pictures and its similarity is at least `CARD_MATCH_SIM_MIN_WITH_RULES` (0.55);
- if the number matches several printings, the picture breaks the tie only with a clear gap (`CARD_MATCH_LEAD_MIN_PICTURE_ONLY`, 0.06);
- with no usable number, the picture alone decides only at similarity ≥ `CARD_MATCH_SIM_MIN_PICTURE_ONLY` (0.80) **and** lead ≥ 0.06;
- a number that was read but names none of the 20 closest printings is first **corrected** (`constrained.py`, below); if that finds nothing, a very clear picture alone may still decide (`picture_lead_strong`: similarity ≥ `CARD_MATCH_SIM_MIN_PICTURE_STRONG` 0.88 **and** lead ≥ `CARD_MATCH_LEAD_MIN_PICTURE_STRONG` 0.10 — a reprint with the same artwork scores almost the same as the card, so its lead is near 0 and it never qualifies);
- the index is English only and the language is not used as evidence.

### Reading the number (matcher version 2)

Free OCR on the bottom line loses digits ("12/13" for "112/113"), reads the slash as a 1 or 7 ("69197") or reads nothing on an upside-down card. Three fixes, cheapest first:

1. **Which way up.** The picture search already knows: the 0° or the 180° view that matches a catalogue picture better says whether the flattened card is upside down, and OCR reads it that way up (`flipped`). Without the hint the reader tries upright first and the turned card when no complete number came out.
2. **A second look at the bottom.** When the tight strips give no number and total, the wider strips (from 90.5% of the card height, to catch e-Card/EX-era numbers printed higher) are read at 3× with sharpening.
3. **Constrained reading** (`constrained.py`, pure): the 20 closest printings have real numbers and printed totals, so the recognised text is compared with each printing's "number/total" (zero-padding either way, slash read as `/`, `1`, `7` or lost, up to two edits for longer patterns, none for the shortest). A printing is accepted only when exactly one printing matches clearly better than the rest, and never when two printings print the same number and total. It only runs when the read number names no candidate, so a real read is never overridden, and the decision rules still need the picture to agree (rank ≤ 10, similarity ≥ 0.55). The change is recorded in the trace as `ocr.corrected`.

Measured on the gaming PC (not the T340) on 300 real TCGdex card scans from 50 sets, made into synthetic phone photos like the benchmark's (so the card finder, flattening and OCR all ran; no picture index locally): number read exactly **80.3% → 91.0%**, plus 2 points from constrained reading against 19 adversarial decoys (8 from the same set) with **0 wrong** → **93.0%**; reader time median 207 → 231 ms, p95 850 → 1082 ms on that machine. The T340 run after the redeploy gives the real "decided" and the reprint-trap group; the Scanner lab report also lists, for each similarity/lead pair, how many photos a picture-only rule would decide and how many of those would be wrong (`picture_only_sweep`), which is where the picture-only thresholds should be tuned from.

### Finding the right card more often (matcher version 3)

On real photos the picture search alone missed the right printing in its top 20 for 28% of scans (matcher v2: 46 / 65 / 72% in the top 1 / 5 / 20 on 132 confirmed photos), while a text search on name and number finds it about 98% of the time. Version 3 adds the text search, two picture options, and a view of the misses.

**1. Name search without a vision model** (`names.py`, on by default: option `names`).

- `ocr.OcrReader.read_name` reads one strip at the top of the flattened card (x 3–100%, y 2–15%, 2× zoom) the same way up as the number. `names.parse_name_lines` picks the name: the tallest plausible line (the name is the biggest type), after taking away the stage label ("BASIC", "Stage 1"), the HP, "Evolves from …", a trailing energy symbol read as a digit, and labels that sit alone on a line ("SUPPORTER", "Pokémon Tool"). "Energy Retrieval" and "Pikachu V" stay whole. The same lines give the HP when it is there, so `ocr.hp` is filled without the slower separate HP strip.
- `names.NameIndex` holds name, number and printed total of every indexed card (one query at startup, rebuilt with the picture index). A read name is compared with every distinct catalogue name. The normalising is the Ollama path's own (`api.recognize._name_search_key`, `_simplify_name`, `_scanner_names_compatible` are imported, not copied: case, accents, hyphens, apostrophes and the "(Giovanni)" qualifier do not matter), then a fuzzy ratio (≥ 0.72, within 0.12 of the best name, at most 8 names), so "Charizrd ex" still finds "Charizard ex". The printings of those names are the **text candidates**; with a number read, the printings that carry it come first.
- `pipeline.merge_candidates` ranks the picture top 20 and the text candidates together: `score = picture similarity + 0.25 × name agreement + 0.12 if the number matches + 0.04 if the printed total matches`. A text candidate's picture similarity comes from the same index (a vector product), so both kinds are on one scale. The 5 closest pictures always stay in the list, so a wrong name read can push other printings down but never the picture's own best guesses. `matches` is that merged list (`rank` is the position in it), so "top 20" now means the merged list.
- **Deciding still needs the picture.** The rules are the same, with two changes. A printing the rules chose may sit as far down as picture rank 40 (was 10) if its name was also read and agrees (≥ 0.9). With no usable number, a card whose name agrees exactly (≥ 0.95) may be decided by the picture at similarity ≥ 0.80 and lead ≥ 0.03 (`name_and_picture`; `CARD_MATCH_SIM_MIN_NAME_PICTURE`, `CARD_MATCH_LEAD_MIN_NAME_PICTURE`). A reprint with the same artwork has a lead near 0, so it still does not qualify.

**2. Better picture matches** (`variants.py`; each is an option, all measured side by side).

| Option | What it does | Cost |
| --- | --- | --- |
| `tta` | two extra views of the card (a 3.5%-tighter crop for corner errors, a brightness / contrast normalised copy for glare and dim light); each card keeps its best view | 2 more embeddings per photo |
| `art` | a second index of the artwork window only (`ART_BOX` in `detect.py`: x 7–93%, y 11.5–54.5% of the flat card), averaged with the whole-card similarity. Reprints share artwork but not the frame, so it mostly helps when glare or a sleeve spoils the frame | one more index (≈ 30 MB) built from the cached pictures; 1 more embedding per photo |
| `base` | DINOv2-base (ViT-B/14, Apache-2.0, 768 numbers; ONNX from `onnx-community/dinov2-base`, pinned commit and sha256 in `model_specs.py`) as a second whole-card index, averaged with the first | model file 347 MB in the image; index ≈ 60 MB; about 3× the small model's time per photo and per picture to build |

An option set is a label, the options joined by `+`: `baseline` (picture only, as in v2), `names`, `names+tta`, `names+art`, `names+art+tta`, `names+base`, `names+art+base`. The one in use is, in order: `CARD_MATCH_OPTIONS`, else `chosen.json` in the card-match folder (written by a real-photo comparison when one set is clearly better), else `names`. Shadow mode and the benchmarks build their matcher from it; an option whose index is not built yet is left out.

**Comparing them.** Scanner lab → **Compare options (real scans)** (and **(synthetic)**) runs the labelled (or synthetic) benchmark once per option set on the same photos and shows one table: top 1, top 20, number read, decided, wrong, p95. The set that is kept: no more wrong decisions than the best other set, 95th percentile under 1.5 s, then the best top 20 / decided; a plainer set is replaced only if another adds at least 0.5 points of either without losing on the other. After a real-photo comparison the winner is written to `chosen.json` and used from then on (shown as **Matching options in use**). Sets that need an index that is not built yet are listed as skipped; build them with the **Build … index** buttons (artwork: about as long as the first index; DINOv2-base: several times longer).

**3. The Misses view** (`misses.py`, Scanner lab → *Misses*). Every real-photo (labelled) run keeps, for each confirmed scan where the right card was not the first pick (or not in the top 20): the photo with the detected corners drawn, the flat card the matcher embedded, the confirmed card's picture, the matcher's top 3, and what OCR read (name, number and total, HP, the text lines). Each is tagged with its likely causes, from measurements of the flat card and what the run saw:

| Tag | Rule |
| --- | --- |
| Card not found or corners off | the finder fell back to the plain guide crop |
| Upside down | the card was read turned 180° |
| Generic card | the confirmed card is an Energy (basic or common) or a common / uncommon Trainer |
| Same artwork in another set | another printing of the same name is among the matcher's picks |
| Sleeve or top-loader glare | ≥ 4% of the flat card is blown out to near white |
| Low light or blur | mean grey < 85, or Laplacian variance < 30, on the flat card |
| Holo or full art | the confirmed card's rarity is a holo / full-art kind |
| No clear cause | none of the above |

A scan can carry several tags; the counts per tag are filter chips. The thresholds are first guesses, and the photos are right there to adjust them. Pictures live under `<card-match dir>/misses/run-<time>/` (small JPEGs; a newer run replaces the older one), `latest.json` has the list, and `GET /api/card-match/misses?tag=&offset=&limit=` pages through it with the pictures inline (admins only).

**After a deploy** (`MATCHER_VERSION` 3): the nonprod autorun builds the missing indexes (the whole-card one if new, then the artwork one), runs the synthetic benchmark and, when at least 100 scans are confirmed, the **real-photo benchmark** (which also writes the Misses view) and the **option comparison**. Nothing needs pressing. The DINOv2-base index is not built by the autorun; press **Build … DINOv2-base index** to include it in the comparison.

**Result shape.** `MatchResult` is unchanged: `status`, `decision`, `unsure_reason`, `matches`, `detection`, `ocr`, `timings_ms`. Fields only added: each `matches` item gets `picture_rank` (where the printing stands among all pictures) and, when names are read, `name_score`; `ocr` gets `name`, `name_lines`, `text_candidates_added` (and `hp` from the name strip); `timings_ms` gets `name`; `decision.mechanism` can also be `name_and_picture`. `rank` keeps its meaning (position in `matches`, 1 = first). A test pins the old key sets.

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
| `…/names.py` | name line parsing (pure), `NameIndex` fuzzy name search, text candidates |
| `…/variants.py` | option sets (`names`, `tta`, `art`, `base`), the one in use, building a matcher for them |
| `…/misses.py` | the Misses view: collecting, tagging (pure), thumbnails, paging |
| `…/pipeline.py` | `CardMatcher`, `decide`, `db_candidate_loader` |
| `…/synthetic.py`, `…/benchmark.py` | phone-style synthetic photos; synthetic and labelled benchmarks; reports |
| `…/jobs.py` | one-at-a-time background jobs, nonprod autorun, after-sync hook |
| `…/shadow.py` | shadow mode: the background worker, and the report the Scanner lab reads back |
| `backend/api/card_match.py` | admin API: `GET /api/card-match/status`, `GET /shadow`, `GET /misses`, `POST /index` (`{name}`: whole card, artwork or DINOv2-base), `POST /benchmark` (`synthetic`, `labelled`, `compare-synthetic`, `compare-labelled`), `POST /stop` |
| `backend/scripts/scan_benchmark.py` | the same build/benchmark from a shell |
| `backend/scripts/fetch_card_match_models.py` | build-time model download with checksum |
| `frontend/src/components/settings/ScannerLabSection.jsx`, `ScannerLabMisses.jsx` | the Scanner lab page and its Misses view |
| `backend/tests/test_card_match.py`, `test_card_match_shadow.py`, `test_card_match_recall.py` | tests with the fake embedder and generated fixture cards (one optional real-model test) |

On disk (`CARD_MATCH_DIR`, default `/app/data/card-match`; mounted in `docker-compose.nonprod.yml`):

- `index/<name>/vectors.npy` + `entries.json` (card id and picture key per row, build time, count); `<name>` is `dinov2-small`, `dinov2-small-art` or `dinov2-base`;
- `misses/latest.json` + `misses/run-<time>/` (the Misses view) and `chosen.json` (the option set a comparison picked);
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
| `SCAN_MATCHER_AUTORUN` | off | **nonprod only**: once per matcher version, after startup, fill the picture cache if needed, build the index and the artwork index, run the synthetic benchmark, and with at least 100 confirmed scans the real-photo benchmark and the option comparison |
| `CARD_MATCH_OPTIONS` | unset | force an option set, e.g. `names+art`; unset = `chosen.json`, else `names` |
| `SCAN_MATCHER_SHADOW` | off | **nonprod only**: shadow mode (below) |
| `SCAN_MATCHER_INDEX_AFTER_SYNC` | off | after `schedule_after_sync` (card sync → picture warm-up), add the new pictures to the index; nonprod sets it |
| `CARD_MATCH_SIM_MIN_WITH_RULES`, `CARD_MATCH_SIM_MIN_PICTURE_ONLY`, `CARD_MATCH_LEAD_MIN_PICTURE_ONLY` | 0.55 / 0.80 / 0.06 | decision thresholds |
| `CARD_MATCH_SIM_MIN_NAME_PICTURE`, `CARD_MATCH_LEAD_MIN_NAME_PICTURE` | 0.80 / 0.03 | picture-only decision when the printed name agrees too |

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
| `ocr` | number, printed total, HP, the first tokens and lines read, `flipped` (read upside down), `corrected` (a damaged number replaced from the closest printings) |
| `input`, `ocr_available`, `index_count` | what the matcher was given (stored bytes, width, height of the photo) and what it had loaded, so a difference from the benchmark is visible |
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

**Same photo as the benchmark.** The scan trace stores the *recognition image* (the guide-frame crop made for the local model, else the stored photo), and the labelled benchmark re-runs that. Shadow mode first read the full stored photo instead, where the card is much smaller and the corner text unreadable, so it recorded "not decided" for scans the benchmark decided. It now reads the same bytes (`scan_storage.read_recognition_image`); a test requires the same pixels and the same decision on both paths.

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

RapidOCR (PP-OCRv4 detection and recognition models, ONNX Runtime) installs cleanly into the slim image when installed with `--no-deps` (its wheel otherwise drags in the full `opencv-python`, which needs system GL libraries and clashes with `opencv-python-headless`). The models ship inside the wheel (about 16 MB), so nothing downloads at runtime. Tesseract would have needed an apt package and a separate binary; it stays the fallback idea if RapidOCR proves too slow on the T340. A tight bottom strip is read first; the wider strip (3× zoom, sharpened) only if no complete number came out, and the turned card only when the picture search gave no orientation. HP is read only when `CardMatcher(read_hp=True)`; it is off by default because the strip is the slowest to read and HP is weak evidence.

## Licences (checked 2026-11-04)

| Part | Licence |
| --- | --- |
| DINOv2 ViT-S/14 weights (Meta AI, `facebook/dinov2-small`) | Apache-2.0 |
| ONNX export `onnx-community/dinov2-small` (commit `8b1f705a`, sha256 `f22797ea…`) | follows the base model, Apache-2.0 |
| DINOv2 ViT-B/14 weights (`facebook/dinov2-base`) and its ONNX export `onnx-community/dinov2-base` (commit `31ef06ca`, sha256 `320d1012…`, 347 MB) | Apache-2.0 |
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
