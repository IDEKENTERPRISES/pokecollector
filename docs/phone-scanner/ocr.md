# Phone scanner, step 3b: the text reader (JavaScript port)

Status: built and checked against the Python reader (matcher version 11). Code: `frontend/src/phonescan/ocr/`. Fixtures: `frontend/tests/fixtures/phone-matcher/v11/ocr/`, written by `backend/scripts/phone_parity_ocr.py`. Not wired into the scanner yet: the integration step joins it to the finder (3a) and the decision rules (3c).

The reader finds the collector number, set total, set code, HP and card name by reading the printed text of a flat card picture, the way the server does with RapidOCR (PP-OCRv4 detection and recognition, `use_cls=False`). Everything here is pure JavaScript over plain data; the two ONNX sessions are passed in.

## Interface

```js
import { readCard, readName, readWhole, secondRead, mergeReads, characterTable } from 'frontend/src/phonescan/ocr'

const sessions = { detect(tensor) -> map, recognise(tensor) -> logits, characters }   // characters = characterTable(characters.txt)
const card = { data: RGBA bytes, width, height }                                        // the flat card

await readCard(sessions, card, { fast: true })  // -> { number, total, setCode, hp, lines:[{text, score, box}], complete, source, confidence, tokens, flipped, attempts, strips, seconds }
await readName(sessions, card, { fast: true })  // -> { name, lines, confidence, hp, raw, strips }
await readWhole(sessions, wholeImage, { fast: true })   // the whole-picture read: the same shape as readCard
await secondRead(sessions, { first, wholeImage, textCard })   // the pipeline's whole second read, merged -> { reading, info }
mergeReads(first, second, 'whole_picture', 'whole-')
```

- Tensors are `{data: Float32Array, dims}`. `detect` returns the detector's probability map (`{data, dims: [1, 1, H, W]}` or `{data, width, height}`); `recognise` returns `{data, dims: [n, steps, classes]}` (probabilities, as the model gives them) or the compact `{steps, indices, values}` (best class and probability per step), which is what the fixtures replay. Both may be synchronous or return promises, so tests stub them with recorded outputs.
- The model input order matches RapidOCR: pictures are **BGR** for both models (the server hands RapidOCR a BGR array and RapidOCR does not flip it); the detector is normalised with the ImageNet mean and std as they are, the recogniser with (x/255 - 0.5)/0.5.
- `number` / `total` are Python's `number_local` / `number_total`; `source` is `number_source` (`finder_card` or `whole_picture`), `confidence` is `number_confidence` (the recogniser score of the line the number came from; `wholestrict` in 3c checks both). `setCode` is filled only when the caller passes `setCodes` (a Set of known codes), as `as_card_info` does; `tokens` always holds the candidates.
- `readCard` options: `flipped` (`false` default: upright; `true`: the card is turned 180 degrees first; `null`: upright, then turned when no complete number came out), `readHp` (default true), `stage` (`all`, `first` = no last-resort band, `quick` = the first three steps, `last` = the last-resort band alone), `budget`, `now`, `setCodes`.
- `readName`'s `confidence` is the recogniser score of the line the name was taken from (null without a name).

## What is ported

| Python | JavaScript |
|---|---|
| `ocr.py`: `parse_text`, `find_hp`, `_clean_number_part`, `_glued_number`, `completeness`, `is_complete`, `pick_number_lines`, `better_read`, `merge_reads`, `is_name_like` | `parse.js` |
| `names.py`: `clean_name_line`, `parse_name_lines` (the reading half; the catalogue search is 3c's) | `parse.js` |
| `ocr.py`: `prepare` (`plain`, `sharp`, `clahe`), the zoom, `render_strip`'s resize | `image.js` |
| RapidOCR 1.3.24 detection: letterbox, size limit and rounding, bilinear resize, DB post-processing, box filter and order | `detect.js` |
| RapidOCR recognition: crops (perspective warp, quarter turn), batches of six, resize and padding, CTC decode, mean score | `image.js` (`warpBox`), `recognise.js` |
| `OcrReader`: `NUMBER_LADDER_FAST`, `NAME_LADDER_FAST`, the last-resort bands, `_read_card`, `read`, `read_name`, `_scan`, the HP strip | `reader.js` |
| `pipeline._second_read` (the `wholeread` option) | `reader.js` (`readWhole`, `secondRead`) |

Not ported: the slow ladder steps and variants (`binary`, `deglare`, glare mask), `mode == "fixed"`, `_strip_items`, `render_strip`'s lab use. The in-use options are `fastread`, `numberonce`, `wholeread`, `wholestrict`; the card names are matched against the catalogue in 3c.

### The ladders (fast)

Number: `number-left-tight` (plain, zoom 2), `number-right-tight` (plain, 2), `bottom-band` (plain, 3, low thresholds), `number-left-wide` (sharp, 3), `number-right-wide` (sharp, 3), `bottom-band` (clahe, 2.5, low). Each step stops the ladder early once a complete number with confidence >= 0.85 is held. After it, when the number is still incomplete, the last-resort `bottom-wide` band (clahe, 2, low). The HP strip (plain, 2) is read after the number. Name: `name-line` (plain, 2), then `name-band` (clahe, 2.5, low), then the last-resort `top-wide` band. Strips cut with `int()` truncation, zoom `max(1, zoom * 880 / height)` for cards taller than 880. "Low" means detector `box_thresh` 0.35 and text score 0.4 instead of 0.5 and 0.5. Detection side: `min(960, max(480, longest side))`, limit type `max`.

The whole-picture second read (`wholeread`): when the finder's card gave no complete number, `readWhole` reads the whole photo (the sharper copy if there is one) treated as the card with the first three steps only, no HP, then `mergeReads(first, second, 'whole_picture', 'whole-')` keeps the more complete / more confident number (`better_read`; agreement raises the confidence by 0.1) and labels the second reading's regions `whole-...` with `source: 'whole_picture'`. A number that only the second reading gave carries `source: 'whole_picture'` and its confidence; `wholestrict` in 3c checks both. If the number is still incomplete and time is left, the last-resort band the first read held back runs on the finder's card and is merged without a source. `secondRead` does all of that.

## Time budget

The server stops a ladder after `FAST_BUDGET_SECONDS` = 0.9 s (a last-resort band may start until 1.5 x that; the second read may spend up to 0.45 s and is skipped when under 0.15 s is left of 1.5 x the budget). Here `budget` is a parameter in seconds, `null` = no limit (the default), and the clock is injectable (`now`). The parity tests all run with no budget, so nothing depends on how fast the machine is.

**What the phone should use:** start with the server's numbers, `budget: 0.9` for the number ladder and 0.9 for the name ladder (each is its own call), `secondRead` with the same 0.9 (allowance 1.35 s, quick read up to 0.45 s). They are wall-clock seconds, and a ladder always finishes the step it is in, so the real time can run one detector pass over. The whole card (model, views, text) has to fit the step 2 gate of about 1.5 s, so the integration step should measure the iPhone cost of one detector call and one recognition on WebAssembly and lower the budgets to fit: the first tight strip is one detector call and one recogniser call and reads most cards, which is why a lower budget costs little.

## Parity

All against what the Python reader (`OcrReader` and `pipeline._second_read`, rapidocr-onnxruntime 1.3.24, OpenCV 4.11) produced on generated cards, with no time budget. CI cannot fetch the OCR models, so the model outputs are recorded and replayed.

1. **Pure functions** (`parse.test.js`): `parse_text`, `pick_number_lines`, `better_read`, `merge_reads`, `is_name_like`, `clean_name_line`, `parse_name_lines`, `find_hp`: the step 1 `pure-functions.json` cases and 43 + 10 + 10 + 40 + 40 + 8 + 8 added ones (`ocr-pure.json`, hand-written strings, outputs from Python). Exact match, 0 differences.
2. **Picture operations** (`image.test.js`, `ocr-ops.json`): the OpenCV calls, on small pictures cut from a generated card. Mean absolute difference per channel (0-255) and the largest single difference: bicubic zoom 2, 2.5, 3: 0.00 to 0.001, max 1; unsharp mask: 0.17, max 1; bilinear resize: 0.006 to 0.03, max 1; perspective crop (a turned box and a tall box with the quarter turn): 0.001, max 1; rotate 180: exact; CLAHE (LAB in floating point instead of OpenCV's 8-bit tables): 0.7 to 0.9, max 4. The tests allow 0.05 / 1 for the resizes and crop, 0.5 / 2 for the unsharp mask, 1.5 / 6 for CLAHE. OpenCV's CLAHE pads with a whole extra tile step when one side is already a multiple of the grid; this port does the same.
3. **Post-processing** (`detect.test.js`, `ocr-post.json`): hand-drawn detection maps (three lines, a turned line, tiny and touching boxes, a faint line at box thresholds 0.5 and 0.35) through RapidOCR's DB post-processing, 8-bit maps. Same number of boxes in all 8 cases; corners within **2 px** allowed (the test), scores within 0.02.
4. **End to end without models** (`reader.test.js`, `ocr-cases.json`): 12 generated cards (varied fonts and sizes: `125/197`, `TG06/TG30`, `SWSH001`, `PAL EN 018/091`, an old right-hand `58/102`, a dark card, a 1100 px card, glare and blur, a turned card, a card with no number, two whole-picture second reads) read by the real Python reader with a recording around both ONNX sessions: 22 reads, 56 detector calls, 38 recogniser batches (47 crops). The detection map is kept as 8-bit probabilities, the recogniser as (best class, probability to four decimals), and the Python reader runs on exactly these values. The JS reader replays them in order and must make the same calls and reach the same result: number, total, HP, tokens, every line's text, the confidence (within 0.001), `source`, the number of regions read, the label, variant, zoom and thresholds of each, what the number was after each step, and the name. **Result: all 22 identical.** Of the 56 detector calls the JS boxes were identical to Python's in 49 and one pixel off in 7 (a box one pixel lower or wider; pyclipper truncates OpenCV's float32 box corners, which this port reproduces only up to float rounding). The detector input must have exactly the recorded shape (all 56 do) and the mean of the tensor within 0.02; a recogniser batch must have the same count and height and its padded width within max(6 columns, 3%): the widths of 3 batches differed by 2 to 7 columns because of those one-pixel boxes. The decoded text and scores of the recorded crops are unaffected.
5. **With the real models** (`models.test.js`, skipped in CI): onnxruntime-web 1.31.1 (WebAssembly, in Node) with the real detector and recogniser of the wheel, on the same cards: number, total, HP and name equal Python's in all 20 cases (also the one the models misread, "Iono" read as "lono", on both sides). Run with `frontend/src/phonescan/ocr/run-models-test.sh <folder with det.onnx and rec.onnx>` (the bundle's `ocr/` folder or the wheel's `models/`).

Limits of the recordings, stated plainly: the recogniser's full probability tensors are not stored (6625 classes x 80 steps per crop is about 1 MB each); the compact best-class form is, and the CTC decode is checked on it. Fixtures use fonts of the machine that ran the script; the PNGs and the JSON are regenerated together (`python backend/scripts/phone_parity_ocr.py`, needs `rapidocr-onnxruntime==1.3.24`, `opencv-python-headless`, `Pillow`; add `--no-models` for the pure fixtures only). All inputs are generated cards and hand-written strings: no trainer's scan and no catalogue picture.

## Known differences from the server

- Contours: OpenCV `findContours` also returns the contours of holes inside a region; this port takes each 8-connected region only. A hole's box has a low score and is dropped by the box threshold in practice (no case differs).
- `minAreaRect` and the pyclipper round-join offset are re-implemented (rotating calipers; the offset as the hull of arc points around the truncated corners): boxes agree to one pixel.
- Image operations run in floating point where OpenCV uses fixed point (one level at most; CLAHE up to four levels through LAB).
- The last-resort band cache is a `WeakMap` per card object instead of a hash of sampled bytes.
- The detector's own size rounding uses Python's round-half-even (`roundHalfEven`): 144 / 32 = 4.5 becomes 4.
