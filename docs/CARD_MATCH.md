# Picture matcher (Scanner Phase 1 prototype)

Status: **prototype; on nonprod it runs in shadow mode and, with the "Picture match first" switch on, decides scans before Ollama (both below).** Today's scan path (Ollama / Gemini through `scan_queue.py`, `scan_providers.py` and `api/recognize.py`) is unchanged. This is Phase 1 of `docs/SCAN_RESEARCH.md` §3.8: build the matcher, measure it on the T340, and read the numbers in **Settings → Data & sync → Scanner lab** (admins only).

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

1. **Which way up** (rewritten in version 4, see below). Version 2 let the picture search decide: the 0° or the 180° view that matched a catalogue picture better said whether the card was upside down. When the right card is not in the index's top results, that comparison is a coin toss, and it flipped upright cards.
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

An option set is a label, the options joined by `+`: `baseline` (picture only, as in v2), `names`, `names+tta`, `names+art`, `names+art+tta`, `names+base`, `names+art+base`. The one in use is, in order: `CARD_MATCH_OPTIONS`, else `chosen.json` in the card-match folder (written by a real-photo comparison when one set is clearly better), else `names+number+text+art+tta` (v6; v5 `names+number+text`, v3 `names`). A `chosen.json` written by an older matcher version is ignored. Shadow mode and the benchmarks build their matcher from it; an option whose index is not built yet is left out.

**Comparing them.** Scanner lab → **Compare options (real scans)** (and **(synthetic)**) runs the labelled (or synthetic) benchmark once per option set on the same photos and shows one table: top 1, top 20, number read, decided, wrong, p95. The set that is kept: no more wrong decisions than the best other set, 95th percentile under 1.5 s, then the best top 20 / decided; a plainer set is replaced only if another adds at least 0.5 points of either without losing on the other. After a real-photo comparison the winner is written to `chosen.json` and used from then on (shown as **Matching options in use**). Sets that need an index that is not built yet are listed as skipped; build them with the **Build … index** buttons (artwork: about as long as the first index; DINOv2-base: several times longer).

**3. The Misses view** (`misses.py`, Scanner lab → *Misses*). Every real-photo (labelled) run keeps, for each confirmed scan where the right card was not the first pick (or not in the top 20): the photo with the detected corners drawn, the flat card the matcher embedded, the confirmed card's picture, the matcher's top 3, and what OCR read (name, number and total, HP, the text lines). Each is tagged with its likely causes, from measurements of the flat card and what the run saw:

| Tag | Rule |
| --- | --- |
| Card not found or corners off | the finder fell back to the plain guide crop |
| Upside down | the card really is turned 180°: **measured** against the confirmed card (its own catalogue picture is clearly closer to the flat card turned 180° than as it is: margin ≥ `CARD_MATCH_ORIENT_MARGIN` and similarity ≥ 0.45). Never taken from the matcher's own choice of orientation |
| Generic card | the confirmed card is an Energy (basic or common) or a common / uncommon Trainer |
| Same artwork in another set | another printing of the same name is among the matcher's picks |
| Sleeve or top-loader glare | ≥ 4% of the flat card is blown out to near white |
| Low light or blur | mean grey < 85, or Laplacian variance < 30, on the flat card |
| Holo or full art | the confirmed card's rarity is a holo / full-art kind |
| No clear cause | none of the above |

A scan can carry several tags; the counts per tag are filter chips. The thresholds are first guesses, and the photos are right there to adjust them. Pictures live under `<card-match dir>/misses/run-<time>/` (a newer run replaces the older one), `latest.json` has the list, and `GET /api/card-match/misses?tag=&offset=&limit=` pages through it with the list thumbnails inline (admins only). Tap any picture to open the full-size view (`GET /api/card-match/misses/{key}/full`): the photo with the corners drawn, the flat card as it was read at its real size (scrolls instead of shrinking; the pixel size is shown), and the confirmed card's large picture. Thumbnails are 420 px / 210×293 at JPEG quality 82 (they were 300 px / 126×176 at 60); the full-size pictures are quality 92.

### Which way up, and text at full resolution (matcher version 4)

**The finding.** In the 49 misses of the last real-photo run, 33 were tagged "Upside down", yet the owner's example (Illumise, 30th Celebration #004) is upright in the photo and in the matcher's crop. The tag was set from `ocr.flipped`, which was only the picture search's guess: `raw[1].max() > raw[0].max()`, i.e. "the turned view has the closest catalogue picture". For a card whose picture is not close to anything in the index (a miss by definition: holo glare, promo art, another printing), the two views score about the same, so which one is higher is noise, not orientation. The pipeline then read the *turned* strips, found no name or number, and the tag called the card upside down. That the tag was inferred and not measured is certain from the code; how often the guess was wrong on real photos can only be seen on the T340 (the picture model is not on the build PC; with the toy test embedder only about 3% of upright photos of cards left out of the index flipped, which says nothing about DINOv2). So the Misses report now carries an **orientation check**: of the misses, how many the old rule would have turned, how many the picture is now sure about, and how many are measured as really turned.

**The rule now** (`pipeline.CardMatcher._read_text`):

1. Upright is the default (the camera guide is portrait and trainers hold cards upright).
2. The picture search may say "turned" only when the turned view beats the upright one by at least `CARD_MATCH_ORIENT_MARGIN` (0.10; a card that is in the index scores far higher in its own orientation). Then the card is read turned, as before.
3. Otherwise OCR decides: read upright (the number strips and the name line); only if that gives nothing usable (no number, and no name that is in the catalogue) is the turned card read too, and it is kept only if it gives something better. Both nothing: upright.

`ocr.orientation` records `by` (`picture`, `text` or `default`) and the picture margin; `ocr.flipped` is the final answer. The picture search itself is unchanged (each card still keeps the better of its two views); only the extra views (tta, artwork) follow the final orientation.

**The tag is measured.** `CardMatcher.card_rotation` embeds the flat card as it is and turned, and compares both with the *confirmed* card's own vector in the index. The Misses view shows the two similarities. A confirmed card that is not in the index cannot be measured and is not tagged.

**Text is read from the sharpest picture.** The strips are about 20 px tall on a 630×880 card, and the recognition image (the guide-frame crop, 1024 px long side) is already about that size. The full stored photo (up to 2048 px) has about 1.5× more detail on the card. `match(photo, full_photo=…)`: the card is found and embedded from the recognition image exactly as before; the card is *also* found on the full photo and flattened at its own detail (`Detection.hires`, up to 1008×1408, never upscaled), and OCR (number strips, name line, HP) reads that. The full-photo flattening is used only if the card is found in it and looks like the same card as the one found in the recognition image (grey correlation ≥ 0.6); otherwise the text is read from the recognition image's own card, as in version 3. Strip zoom is scaled by 880 / card height so a sharper card is not upscaled again and reading costs about the same. `ocr.text_input` records the source (`full_photo`, `stored_card`, `photo`, `crop`) and size.

**Everything reads the same input.** Shadow mode (`ShadowRunner._run_one`) and picture-first (`picture_first.run_matcher`, `scan_queue._full_photo_for_item`) pass the recognition image and the full photo. Both store the flat card the text was read from as `user-N/shadow/job<J>-item<I>.card.jpg` (JPEG 90, about 1000 px wide, same consent as the shadow record). The labelled benchmark passes that stored card as `flat_card=` for traces that have one, so a re-run reads the very pixels the live run read. Older traces have no stored card and keep being read from their 1024 px recognition image. A test requires that the live read and the stored-card replay give the same text input and the same decision.

### A sharper crop kept on upload (np-p19h)

**The finding.** A card that fills the guide is about 1,730 px tall on a 4K frame, but the stored review photo is the *whole* frame shrunk to 2048 px, so the card is only about 923 px tall there: no sharper than the 1024 px recognition crop, and under the 968 px where `detect.hires_size` keeps extra detail. On a 1080p stream it is about 867 px. So "full resolution" reading mostly did not apply.

**What is stored now.** When an upload's file name carries a guide box (`-g<x>_<y>_<w>_<h>`), `scan_storage.sanitize_image_bytes(raw, box)` cuts that box from the *original decoded image* before it is shrunk, caps the long side at 1,600 px (`SHARP_CROP_LONG_SIDE`) and saves a sanitized JPEG (quality 90, EXIF-free, mode 0600) as `<photo>.crop.jpg` beside the photo, plus `<photo>.frame.json` (`{"frame": [w, h], "crop": [w, h]}`: the camera frame and crop sizes). They live in the job directory next to the photo and the `.rec.jpg` recognition image, so every existing clean-up covers them: `delete_scan_image`, `delete_job_directory`, the 14-day expiry (`purge_expired_scan_jobs`), orphan purge, and the DB-only backups never contain scan photos. The 2048 px review photo and the 1024 px recognition image are byte-for-byte what they were; what Ollama receives does not change. Uploads without a guide box (gallery, system camera, the single-card scanner) get no crop and behave as before.

**What reads it.** `scan_storage.read_text_photo` returns the crop, or the stored photo when there is none; `scan_queue._full_photo_for_item` and `shadow._read_full_photo` use it as `full_photo`. The crop is about the same framing as the recognition image (guide box plus the 4% margin), so `detect_card` finds the card in it and `_same_card` holds (a test covers a tight 4K-derived crop). Detail is still capped at `HIRES_H` (1408 px), the crop is never decoded smaller than 2048 px, and the strip zoom (`REFERENCE_HEIGHT / card height`) means a sharper card is not upscaled twice, so reading stays inside the picture-first time budget.

**Measured, not assumed.** The shadow record's `input` gets `frame`, `crop`, `text_height` and `text_source` (and the picture-match trace entry a `camera` block) for scans stored with a crop. Scanner lab, *Shadow run*, shows "Camera and reading detail": the typical camera frame, the typical crop, and the typical card height the text was read from for new scans against older ones. If the median frame's long side is 2,100 px or less (1080p class) the lab says plainly that the sharper crop cannot help and a better camera stream is needed. Only a real iPhone can answer which it is.

**Capture paths** (audited, nothing shrinks the frame): `BatchCameraCapture` asks for 3840x2160, draws the frame at `video.videoWidth x videoHeight` and `toBlob`s it as JPEG 0.92 with the guide box in the name; `UnifiedCardScanner` stages the `File` untouched; the offline outbox (`scanSubmit`, `store`, `scanUpload`) stores and replays the bytes and name unchanged; `prepareUploadPart` only re-wraps the bytes; the service worker does not touch scan uploads; nginx allows 205 MB. The server's 15 MB per-file cap is the only limit. Paths with no guide box: the system-camera and gallery inputs in `UnifiedCardScanner`/`CardScanner`, and the single-card `/cards/recognize` endpoint.


**What reruns after the deploy** (`MATCHER_VERSION` 4): the nonprod autorun runs the synthetic benchmark and the real-photo benchmark and option comparison again, and the Misses view is rebuilt: the "Upside down" count should fall from 33 to the cards that are really turned, and "Same artwork in another set" / "No clear cause" should grow by the rest. The real-photo number reading only gains from full resolution on scans made after this deploy (older traces only hold the 1024 px crop); the orientation fix applies to all of them.

**After a deploy** (`MATCHER_VERSION` 4 now): the nonprod autorun builds the missing indexes (the whole-card one if new, then the artwork one), runs the synthetic benchmark and, when at least 100 scans are confirmed, the **real-photo benchmark** (which also writes the Misses view) and the **option comparison**. Nothing needs pressing. The DINOv2-base index is not built by the autorun; press **Build … DINOv2-base index** to include it in the comparison.

**Result shape.** `MatchResult` is unchanged: `status`, `decision`, `unsure_reason`, `matches`, `detection`, `ocr`, `timings_ms`. Fields only added: each `matches` item gets `picture_rank` (where the printing stands among all pictures) and, when names are read, `name_score`; `ocr` gets `name`, `name_lines`, `text_candidates_added` (and `hp` from the name strip); `timings_ms` gets `name`; `decision.mechanism` can also be `name_and_picture`. `rank` keeps its meaning (position in `matches`, 1 = first). A test pins the old key sets.

### Finding and reading the name and number on real photos (matcher version 5)

**The problem.** On the owner's 139 confirmed real scans the number was read exactly only 57.6% of the time, and on most of the 13 misses OCR read no name and no number at all (`Read: name "–", number –`) on upright, found cards. Three causes are visible in the code and reproduce on generated cards; which one dominates on the real photos is what the new OCR check (below) will say on the T340.

1. **The slash is lost.** The thin "/" of "018/091" is often read as nothing, so a clean line comes out as `MEWEN072189` or `183275`. The number regex needed a separator and found no number at all. On the synthetic set this alone explains most of the gap (number read 67% → 92%).
2. **A printed bar is not a slash.** The regex also took "|" as a slash, so the 30th Celebration line `30C | 017/128` (Lapras: name not read, number *was* read) parsed as number `30C`, total `017`. And a language code was glued into the number (`EN038`).
3. **Fixed strips assume where the text is.** A card flattened with a margin (corners found a little wide), a sleeve, or text printed in an unusual place falls outside the fixed fractions. The name strip then holds whatever is nearby: rules text ("Pokemonex | nocked Out…", "You may play only 1 Supporter card…") or the copyright line ("NintendoICreatures/GAMEFREAK"), and the old picker took the tallest plausible line as the name. Also, every strip was read with the detector held to 480 px, which shrinks a wide band before it looks for text.

**What changed (`ocr.py`).**

- *Parsing.* `parse_text` reads a line that ends in five or six digit-like characters as a number glued to its total (3+3, or 2+3 for old sets: `58102`), fixes O/I/S/Z look-alikes, drops a language code, and takes "|" as a slash only with no spaces around it. `pick_number_lines` prefers one line that holds a whole number over digits stitched from neighbouring lines, and records that line's recogniser confidence (`number_confidence`).
- *Finding the name by pattern.* `is_name_like` rejects rules text, copyright and number lines (length, word count, sentence words, lower-case words) before `names.parse_name_lines` picks the tallest remaining line. Body text is no longer taken for a name; "no name" is now an honest answer.
- *Regions and ladder.* Each step runs only when the one before did not give a complete, confident (≥ 0.85) number and total; the time spent on one card is capped (`BUDGET_SECONDS`, 1.2 s).
  - Number: the two tight strips (the fast first try, as before) → the whole bottom band (0.885–1.0, full width, so a number on the left, the right, or lower than expected is in it) → the two wide strips → the band under local contrast → glare removed → black and white → a much taller band at the top and bottom (`EXPANDED`, 0–0.24 and 0.72–1.0) for a card flattened with a margin. The number is chosen across readings by agreement: two views that read the same digits raise the confidence.
  - Name: the name strip → the name band (0.015–0.115, HP excluded) under local contrast, black and white, glare removed → the tall top band. The tall bands are cached per card, so the number read and the name read of one scan share them.
  - The detector's size limit follows the strip width (480–960 px) and the thresholds are lowered (`box_thresh` 0.35, `text_score` 0.4) after the first try, so fainter text on glossy cards counts.
- *Preprocessing* (`ocr.prepare`, pure): `plain`, `sharp` (unsharp mask), `clahe` (local contrast on the lightness channel), `binary` (adaptive threshold, polarity chosen from the strip so the text is the dark mark), `deglare` (blown-out pixels filled in from their surroundings, then local contrast; skipped when the strip has no glare or is nearly all glare). Strips are upscaled 2–3×; a sharper card needs less (zoom follows the card's height).
- *Diagnostics.* Every region read is recorded in the result (`OcrResult.strips`, `NameRead.strips`) with its box (fractions of the card), variant, zoom, and each line's raw text and confidence. `pipeline` adds them to the `ocr` dict as `ocr.strips` (a field added, nothing renamed).

**Not done: a second recogniser.** PaddleOCR's server recognition model (ONNX) and Tesseract were considered. Neither was added: the synthetic set cannot show whether either helps on real photos (the failures there are a lost slash and digit confusions, and those are parsing and consistency problems), the T340 has no spare CPU budget (p95 must stay under 1.5 s), and a new model needs a pinned download in the Dockerfile that CI does not build. The OCR check now measures each preprocessing variant on the real photos, so the next step can be chosen from data.

**What the lab shows (admin).**

- *Misses → open a scan → "What OCR read"*: every region as the exact picture the recogniser got (drawn from the stored flat card and the recorded box, variant and zoom; nothing extra is stored), with each line's raw text and confidence. Empty or wrong text on a clear strip means the reading failed; a strip that does not contain the number means the region is wrong.
- *OCR check* (button, and automatic in the nonprod autorun before the real-photo benchmark): reads every confirmed trace with the reader alone and compares with the confirmed card: **name read**, **number read exactly**, **total read** and **set code read**, split by the resolution the text came from: *1024* (older traces: the 1024 px recognition crop, a card 880 px tall) and *full* (traces that stored the full-resolution flat card), plus *all*. Each trace is read the old way (fixed strips), the new way (the ladder above) and with one preprocessing variant at a time on the bottom and name bands, so the table shows which preprocessing helps on real photos. The first 40 traces where the name or number was not read are listed with the raw text. The report is `benchmark-ocr-check-<time>.json`; `POST /api/card-match/benchmark` takes `kind: "ocr-check"`.

**Measured on the build PC (gaming PC, synthetic cards, not the real photos).** `py -3 backend/scripts/ocr_synthetic_bench.py 24 [margin]` draws cards with a name, HP, rules text, number and set code (modern layout 75%, old layout 25%), then glare (60%), blur, noise and JPEG, at the two stored resolutions (card 880 px and 1408 px tall). Same 24 cards before and after:

| | 1024 crop: name / number / total / set code / p95 | full: name / number / total / set code / p95 |
| --- | --- | --- |
| version 4 (fixed strips) | 95.8 / 66.7 / 79.2 / 20.8 / 0.25 s | 95.8 / 50.0 / 79.2 / 29.2 / 0.24 s |
| version 5 | 95.8 / 91.7 / 95.8 / 66.7 / 0.39 s | 95.8 / 87.5 / 95.8 / 62.5 / 0.65 s |
| version 5, card flattened with a 5% margin | 95.8 / 95.8 / 95.8 / 70.8 / 0.65 s | 95.8 / 91.7 / 95.8 / 70.8 / 0.57 s |

On the margin set the fixed strips alone read the number 87.5% (1024) and 79.2% (full) with the version 5 parser, so the lost-slash parser accounts for most of the gain and the ladder for the rest. The synthetic names are easy (the text is clean and the layout fixed); the real name failures (rules text taken for a name) are covered by the pattern tests instead. These are *synthetic* numbers on a fast CPU: they say the change fits the time budget and that the parser works, not what the real-photo rates will be. The OCR check on the T340 gives those.

**What reruns after the deploy** (`MATCHER_VERSION` 5): the nonprod autorun builds anything missing, runs the synthetic benchmark, the **OCR check**, the real-photo benchmark (which rewrites Misses with the new strip view) and the option comparison. Compare the *decided on its own* and *number read exactly* figures with the 63.3% and 57.6% of version 4; the OCR check's 1024/full split says whether the older traces (crop only) gain less than the newer ones.

The thresholds are **provisional**; the benchmark records every photo's features so they can be tuned once the labelled set exists.

The pipeline is pure: it reads the index and, through a `candidate_loader`, the catalogue; it writes nothing.

### Number, set-code and card-text lookups (matcher version 5)

Version 4 left 13 of 139 real photos wrong-ranked or undecided. Some had a number and total read but the printing sat at picture rank 11 behind reprints; some read only body text. `lookup.py` turns whatever text OCR reads into candidates. It is two options in `variants.py`, so Scanner lab's comparison shows each as its own row: `names` → `names+number` → `names+number+text`, then `+art+reprint`. Neither lane decides alone; `pipeline.decide` still needs the picture to agree.

**Number lane** (option `number`). OCR's own number parse can be fooled by text beside the number ("30C | 017/128" parses as 30C over 017), so the lane scans every recognised line for `number/total` pairs itself (a `|` read for the slash is accepted too) and also uses OCR's own pair. Each pair is looked up in the card table: cards with that number whose set's printed total matches, narrowed by a set code when a recognised word maps to a set. Codes come from `sets.abbreviation` and `sets.tcg_set_id` (both are in the sets table); `lookup.EXTRA_SET_CODES` adds only the promo prefixes (SVP, SWSH, SMP, XYP, BWP, MEP, PRSV…), because the table's contents on the server are not checked from the build PC. Levels: `number_total_set`, `number_total`, `number_set`, `number`. The first two (up to 30 cards per pair) join the candidates even when the picture search missed them, and rank above others by +0.20 / +0.14 / +0.10 on top of picture similarity; a bare number never adds cards (it would add hundreds) and only keeps the boost it already has.

- **Deciding.** A printing found this way may be chosen when it is the *only* card at its level, the rules (number, total, set code) already isolate it, and the picture agrees: number + total + set code → similarity ≥ 0.60 and picture rank ≤ 60; number + total → similarity ≥ 0.65 and rank ≤ 30 (was: rank ≤ 10). If a name was read, is in the catalogue and is not this card's name, the scan stays unsure (`number_lookup_conflicts_with_name`). When OCR's own number names none of the candidates, the looked-up printing's number and total are used instead (`ocr.number_from_lookup` in the trace).
- Variables: `CARD_MATCH_LOOKUP_SIM_SET` (0.60), `CARD_MATCH_LOOKUP_SIM_TOTAL` (0.65), `CARD_MATCH_LOOKUP_RANK_MAX` (60), `CARD_MATCH_LOOKUP_RANK_MAX_TOTAL` (30).

**Card-text lane** (option `text`). The card table already stores each card's `attacks` and `abilities` (name and effect) and the trainer `card_effect` (TCGdex), so nothing was added to the sync. The index splits them into sentences and attack / ability names (about the size of the English card text, kept in memory, built once per index build with the name index). A recognised line is matched against the sentences that share its rarer words, and counts when ≥ 80% of the shorter of line and sentence is shared. A sentence printed on many cards ("You may play only 1 Supporter card during your turn") proves little: up to 12 cards it adds those cards, beyond that nobody, and its boost shrinks with the number of cards. Boost: +0.15 × match. A text-only decision (`text_and_picture`) needs a sentence at most 3 cards print, similarity ≥ 0.80 and a lead ≥ 0.03, and no contradicting name.
- Rule-box wording ("Pokémon ex rule", "When your Pokémon ex is Knocked Out, your opponent takes … Prize cards") is not stored anywhere in the card data; it only gives +0.04 to the ex / GX / V cards (by the name's suffix) the picture already found.
- The OCR lines it reads are `ocr.lines` plus `ocr.body_lines` when the OCR reader supplies that field.

**Reprint tie-break** (option `reprint`, which needs and turns on `art`). When the closest pictures include several printings of one name and nothing printed separates them, the printing whose artwork-only similarity is ahead of the others by ≥ 0.04 (`CARD_MATCH_REPRINT_ART_LEAD`) is chosen, if it is within the top 5 pictures, similarity ≥ 0.80, and the group leads every other name by ≥ 0.06. Anything closer stays unsure. Not in the default option set until a real-photo comparison shows it adds without a wrong decision.

The default option set is now `names+number+text`.

### Matcher version 6: a steadier winner, a faster reading option, and what the lab shows

Version 5 on 139 real photos: 67.6% decided with 0 wrong, 96.4% top 20 (targets 70% and 97%). The comparison row `names+number+text+art+tta` reached 71.2% decided, 97.1% top 20 and 0 wrong, but `pick_winner` rejected it at 1,560 ms against 1,500. The same set measured 1,347 and 1,520 ms in two runs on the same photos, so 60 ms is noise. Version 6:

- **The winner rule tolerates noise.** `pick_winner` lets an option set through up to 10% over the bar (`benchmark.PICK_MAX_P95_MS`, 1,650 ms). The pass bar shown in the report stays at 1,500 ms and every other rule is as before (no more wrong than the best other set; a plainer set is replaced only by a gain of at least 0.5 points of top 20 or decided without losing more than 0.5 on the other). With the version 5 rows, `names+number+text+art` (96.4 / 67.6 / 1,346.6 ms) loses to `…+art+tta` (97.1 / 71.2 / 1,559.6 ms), and `…+art+base` (97.8 / 69.1 / 1,554.9 ms) does not replace it (it loses 2.1 points of decided). A test pins these rows.
- **Artwork and extra views by default.** `variants.DEFAULT_LABEL` is `names+number+text+art+tta`. `chosen.json` carries the matcher version that wrote it; `active_label` ignores one from another version, so the version 5 file (which kept `names+number+text`) cannot hold back the new default. If the artwork index is not built, `variants.usable` leaves out only that part (artwork, and the reprint tie-break that needs it); names, number, text and the extra views still run. Shadow mode uses the same rule (it used to fall back to `names+tta` and lose the number and text lanes).
- **`fastread`** (option, last in the label): the same reading ladders without the late black-and-white and glare-removal steps (`ocr.NUMBER_LADDER_FAST`, `NAME_LADDER_FAST`) and a lower budget (`ocr.FAST_BUDGET_SECONDS`, 0.9 s; the usual `BUDGET_SECONDS` is 1.2 s, and OCR's 95th percentile of 1.19 s probably set the whole 1.52 s). It is a comparison row, `names+number+text+art+tta+fastread`, not the default: those steps stay for everyone unless the T340's comparison picks the fast row through the normal `pick_winner` rule.
- **What each reading step rescues** (OCR check). Every region the reader reads now records its time and what the ladder had after it (`ocr.strips[*].ms`, `.after`: the number and total so far, or the name so far). The OCR check adds, for the full ladder and for each photo size, a table: each step in order, how many scans it ran on, how many scans **first** had the right number (name) at that step, the mean time and the total time, and how many never got it right. That table, not the single-variant rows, decides which steps to drop for good (a step whose "first right" is 0 or tiny and whose time is large). Report: `steps` in `benchmark-ocr-check-*.json`. It only needs what the T340 records, so it appears with the next OCR check.
- **Real-photo results by scan time** (not by photo size). The labelled report has `by_scan_time`: `tuning` (scans made before 2026-11-05 02:00 UTC, `benchmark.NEW_SCANS_FROM`) and `new` (made at or after it, not used for tuning anything), each with scans, top 1, top 20, decided and right; the lab calls them "Used for tuning" and "New scans, not used for tuning". Photo size cannot tell them apart: a card that fills the guide is only about 923 px tall in the stored photo, which the OCR check's sharpness test (`ocr_check.resolution_of`, a card over `CARD_H * 1.05` = 924 px) counts as `1024`, so 23 of the 30 new scans landed in that bucket. The OCR check keeps its sharpness tables. With no new scans the lab says so. The new scans must not be used to tune anything.
- **A set code glued to the number** ("PBL039/084", Dhelmise, Pitch Black #039): the number was read right but `PBL39` is not the catalogue key `39`. Letters of three or more in front of a number that are not a real number prefix (`lookup.NUMBER_PREFIXES`: TG, GG, SV, RC, SWSH, SVP, SM, XY, BW, HGSS, MEP, H, ...) are now a set code: the reader drops them from the number (`039`; the code stays a token), the number lane looks up the bare number first and then the prefixed one, and `set_code_tokens` adds the letters (`PBL`). `TG06/TG30`, `GG01/GG70`, `SV28/SV94` and `SWSH020` are unchanged (tests).
- **A read number counted twice** (option `numberonce`, comparison row `names+number+text+art+tta+numberonce`). `merge_candidates` added `NUMBER_WEIGHT + TOTAL_WEIGHT` (0.16, from the name search) and the number lookup's level boost (0.14 to 0.20), up to 0.36, so a wrong card carrying the read number could outrank a right card with a much closer picture. With the option, the larger of the two counts. Kommo-o #143 (picture 0.634) read 077/128: Comfey #077 (0.4243) scored 0.7243 and now scores 0.5843, so Kommo-o is first. Dhelmise #039 (0.6547) read 023/084: Electrike #023 (0.5287) still scores 0.6887 with one count, which is above 0.6547, so a single count is **not enough for Dhelmise** and no special case was added (the glued-code fix above is what could help the real Dhelmise scan, which read the number right). Lapras `30C | 017/128` still comes into the list through the lookup (tests). `pick_winner` also counts a gain of at least 0.5 points of top 1, with the same no-loss rule on top 20 and decided.
- **Ollama's figures no longer include picture-first decisions.** `picture_first.record_in_trace` stores its own decision in `decision.selected` (mechanism `picture_match`); the labelled report, the shadow report and the agreement stored in each trace read that as Ollama's pick. That is why Ollama's decided rate rose from 15.1% to 24.9% and "both decided" and "agree" each rose by exactly the 20 picture decisions. `scan_trace.ollama_ran` (no picture-first record, or path `unsure_ollama`) and `scan_trace.ollama_selected` now decide what is Ollama's; the report counts Ollama only on scans where it ran (`ollama_today.n`, with `not_run` shown) and `score_pairs` carries `current.n`. The shadow report recomputes the stored agreement. One limit: on `unsure_ollama` scans the candidate list may also hold up to 6 of the matcher's picks, so "right card among its candidates" is slightly generous there.
- **Misses was stale.** The list was fetched once and never reloaded when a newer run finished (the page only reloads the status while a job runs). Its query key now includes the latest run's time from the status, so a new run reloads it.
- **What holds back "decided".** The labelled report has `undecided_first_right`: scans whose first pick is right but nothing was decided, counted by `unsure_reason`, for all scans and for each scan-time group. Only counted; no threshold was changed.
- **When the card is not found** (10 of 139 real photos). Before: the finder fell back to the plain guide-frame crop of the recognition image, and the full photo was used only when the card *was* found. Now (`CardMatcher._find_card`): when no card is found on the recognition image, the finder tries the full photo (when there is one: live scans, not the replay of a trace); if that fails too, the guide-frame crop is used, because the trainer lined the card up with the guide. `detection.fallback` is `full_photo`, `guide_crop` or `null`, and `detection.corners_space` says where the corners are (corners found in the full photo are not drawn on the recognition image). `detection.found` and so "Card found" count only finds on the recognition image. The OCR check no longer skips such scans: it reads the guide-frame crop and reports them as their own group (`guide_crop`, left out of `all` so that figure stays comparable with version 5).
  - **Deciding.** A fallback card may add and rank candidates like any other, but `pipeline.decide(fallback=True)` only decides when the reader itself read a number from it (not one filled in from a lookup) and the picture agrees. Every picture-only lane (`picture_lead`, `name_and_picture`, `text_and_picture`, `picture_lead_strong`, the reprint tie-break) is closed for it: reason `card_not_found_no_number_read`. Tests: a fallback read with no number does not decide even when the picture is an exact match; a number the picture disagrees with does not decide.
  - **Misses.** These scans carry the tag **Card not found: read by fallback** (first in priority, with their photos and flat card like any miss), and the report lists `fallback_scans` / `fallback_misses`. The labelled report has a `fallback` block (scans found on the full photo, scans read from the guide frame, and the rest).
- **A shorter autorun.** The order is now (`jobs.autorun_plan`): OCR check, real-photo benchmark and real-photo comparison first; then the picture warm-up and the index updates; then the synthetic benchmark and a short synthetic comparison. When the indexes are not built yet (a first run) they are built before the real-photo steps, but the synthetic runs are still last. The synthetic comparison runs 4 option sets (`variants.SYNTHETIC_COMPARE_LABELS`) on 100 photos (`SYNTHETIC_COMPARE_COUNT`) instead of 10 sets on 400, since it chooses nothing. `autorun-log.json` in the card-match folder records when each step started and how long it took (also kept in `autorun.json`), so the next slow rerun can be explained from the file. Why version 5 took about two hours before its first report: from the code, the autorun began with the picture warm-up (waits for the warmer, up to 4 hours), then the index updates, then the synthetic benchmark, and only then the OCR check; the warm-up and index steps are the part nobody on the build PC can time, which is why the log was added.
- **Scan counts.** The buttons showed "229 confirmed", the number of trace files (a scan with several attempts has one file per attempt). `benchmark.count_labelled_traces` now counts one per scan, grouped exactly as `run_labelled` and the OCR check group them (`ocr_check.labelled_traces`; which also needs the stored photo), and the buttons say "N scans".

**What reruns after the deploy** (`MATCHER_VERSION` 6): the whole autorun, in the order above. Expected: the OCR check, labelled benchmark and comparison first (the comparison is now 12 rows on the real photos); synthetic runs last. Nothing measured on the build PC is a real-photo result.

## Files

| File | Purpose |
| --- | --- |
| `backend/services/card_match/detect.py` | card finder / flattener, confidence |
| `…/embed.py` | `Embedder` interface, `OnnxEmbedder`, `FakeEmbedder` (tests) |
| `…/model_specs.py` | pinned model URL + sha256 (standard library only, read by the Dockerfile) |
| `…/index.py` | build / load / search the index; incremental, checkpointed |
| `…/ocr.py` | RapidOCR: find and read the number and name by pattern, preprocessing, regex parsing (`parse_text`, `pick_number_lines`, `is_name_like`, `prepare` are pure) |
| `…/ocr_check.py`, `…/ocr_synthetic.py` | the OCR check on real traces (by stored resolution, per-step table); one-per-scan trace grouping; synthetic cards for measuring OCR |
| `…/lookup.py` | number / set-code lookup and card-text matching (pure; `build_lookup_index` reads the card table) |
| `…/names.py` | name line parsing (pure), `NameIndex` fuzzy name search, text candidates |
| `…/variants.py` | option sets (`names`, `tta`, `art`, `base`), the one in use, building a matcher for them |
| `…/misses.py` | the Misses view: collecting, tagging (pure), thumbnails, paging |
| `…/pipeline.py` | `CardMatcher`, `decide`, `db_candidate_loader` |
| `…/synthetic.py`, `…/benchmark.py` | phone-style synthetic photos; synthetic and labelled benchmarks; reports |
| `…/jobs.py` | one-at-a-time background jobs, nonprod autorun, after-sync hook |
| `…/shadow.py` | shadow mode: the background worker, and the report the Scanner lab reads back |
| `backend/api/card_match.py` | admin API: `GET /api/card-match/status`, `GET /shadow`, `GET /misses`, `POST /index` (`{name}`: whole card, artwork or DINOv2-base), `POST /benchmark` (`synthetic`, `labelled`, `compare-synthetic`, `compare-labelled`, `ocr-check`), `POST /stop` |
| `backend/scripts/scan_benchmark.py` | the same build/benchmark from a shell |
| `backend/scripts/fetch_card_match_models.py` | build-time model download with checksum |
| `frontend/src/components/settings/ScannerLabSection.jsx`, `ScannerLabMisses.jsx` | the Scanner lab page and its Misses view |
| `backend/tests/test_card_match.py`, `test_card_match_shadow.py`, `test_card_match_recall.py`, `test_card_match_ocr_read.py`, `test_card_match_v6.py` | tests with the fake embedder and generated fixture cards (one optional real-model test) |

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
| `CARD_MATCH_OPTIONS` | unset | force an option set, e.g. `names+art`; unset = `chosen.json` of this matcher version, else `names+number+text+art+tta` |
| `SCAN_MATCHER_SHADOW` | off | **nonprod only**: shadow mode (below) |
| `SCAN_PICTURE_FIRST` | off | default for the admin switch "Picture match first" (below); nonprod sets it to on |
| `SCAN_PICTURE_FIRST_TIMEOUT_SECONDS` | `5` (0.5–30) | longest a scan waits for the matcher before the old path takes over |
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
| `ocr` | number, printed total, HP, the first tokens and lines read, `flipped` (read upside down), `orientation` (`by`: picture / text / default, and the picture margin), `text_input` (what the text was read from and its size), `corrected` (a damaged number replaced from the closest printings) |
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

**Same photo as the benchmark** (version 4 adds the full photo for reading text, and the stored flat card the benchmark re-reads; see above). The scan trace stores the *recognition image* (the guide-frame crop made for the local model, else the stored photo), and the labelled benchmark re-runs that. Shadow mode first read the full stored photo instead, where the card is much smaller and the corner text unreadable, so it recorded "not decided" for scans the benchmark decided. It now reads the same bytes (`scan_storage.read_recognition_image`); a test requires the same pixels and the same decision on both paths.

## Picture match first (nonprod switch)

An admin switch, **Settings › Scanner › Picture match first**. Its default comes from `SCAN_PICTURE_FIRST` (on in `docker-compose.nonprod.yml`, unset, so off, everywhere else); once an admin has touched the toggle, the stored choice (`scan_picture_first` in the `settings` table) wins. **With it off, scans behave exactly as before.** Code: `services/picture_first.py`, called from `default_scan_processor` in `services/scan_queue.py`. The matcher is used only through `pipeline.CardMatcher.match()` and its `MatchResult`; nothing in this package changed.

With it on, each single (non-batch) scan runs the matcher on the recognition image first (the same crop shadow mode and the benchmark use):

| Matcher says | Scanner | What happens | `_picture.path` |
| --- | --- | --- | --- |
| decided | not called | done in about a second; inbox gets the decided card first, then the other close matches, in the usual `recognized` / `matches` shape | `decided` |
| unsure | reachable | Ollama runs as before; the matcher's top matches it did not list are appended (up to 6, only when Ollama is not itself confident) | `unsure_ollama` |
| unsure | unreachable | the scan goes to the inbox now with the matcher's top 12 and the line "Not sure which card this is. Pick it below, or wait for the scanner."; **Wait for the scanner** puts it back in the waiting state (`scanner_unreachable`), released when the scanner answers, and it is not sent to the inbox again | `unsure_inbox` |
| model/index/OCR not ready, error, timeout | any | exactly today's behaviour (a scan whose scanner is down waits as before) | none |

Gemini users have no "unreachable" state, so an unsure scan always goes on to Gemini. Batch grids (several photos in one request) are unchanged and still go straight to the scanner.

Safety: one matcher run at a time per process (a single worker thread; the matcher keeps its own 3-thread cap), at most `SCAN_PICTURE_FIRST_TIMEOUT_SECONDS` of waiting, and any exception, missing model or missing catalogue card falls through to the old path. A run that timed out is not cancelled, but a queued one that is late is skipped. Shadow mode keeps recording: when picture-first has already run the matcher it writes the shadow record itself (same payload) so the same photo is not run twice.

Where it is recorded: `recognized._picture` on the scan (path, mechanism, similarity, reason, milliseconds, the decided card, later the card the trainer confirmed) and `picture_match` in the diagnostics trace. The scan review shows "Matched by picture" under the card name to **admins only**; trainers see nothing new except the unsure line and the Wait button.

To turn it off if anything looks wrong: Settings › Scanner › **Picture match first** off (takes effect on the next scan, no restart), or remove `SCAN_PICTURE_FIRST` from the compose file and redeploy. Scans already in the inbox keep their results.

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

The **Picture match first** block in the lab counts the last 7 days from the scans themselves (they live 14 days): decided by picture, sent to Ollama, sent to the inbox while the scanner was unreachable, and how many of the decided scans the trainer then added as a *different* card than the picture decided. That last figure, as a share of decided scans the trainer confirmed, is the real-world error rate.

### How each confirmed card was chosen (manual step)

Every confirmed card records `confirmation.source` in its trace: `scanner_decision` (the scanner's own pick accepted), `matcher_candidate` or `ollama_candidate` (picked from that path's candidates), `manual_search` (found by search, no scanner offered it) or `manual_no_result` (found by search on a scan that had nothing). The lab shows the counts under the shadow run (`how_confirmed` in `/api/card-match/shadow` and in the labelled report). A manual pick is a miss for the matcher and for Ollama by definition (the card was in nobody's candidates, rank none), is kept as ground truth with its photo, and is included in the confirmed-scans scores and the labelled benchmark (English cards only, like every other pick). Traces written before this change have no source and are counted as `unlabelled`.

## OCR choice

RapidOCR (PP-OCRv4 detection and recognition models, ONNX Runtime) installs cleanly into the slim image when installed with `--no-deps` (its wheel otherwise drags in the full `opencv-python`, which needs system GL libraries and clashes with `opencv-python-headless`). The models ship inside the wheel (about 16 MB), so nothing downloads at runtime. Tesseract would have needed an apt package and a separate binary; it stays the fallback idea if RapidOCR proves too slow on the T340. A tight bottom strip is read first, then the ladder described under matcher version 5, and the turned card only when the picture search gave no orientation. HP is read only when `CardMatcher(read_hp=True)`; it is off by default because the strip is the slowest to read and HP is weak evidence.

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
