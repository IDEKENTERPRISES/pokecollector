# Phone scanner step 3d: the whole phone matcher, in a worker, measured against the server

Code: `frontend/src/phonescan/matcher/`. Server reference: matcher version 11 (`backend/services/card_match/pipeline.py`, `CardMatcher.match`),
the kept set `names+number+text+art+tta+fastread+numberonce+corners+wholepic+wholeread+wholestrict` (no `reprint`, no `trustrejected`).
It joins the three ports (finder `finder.md`, reader `ocr.md`, decision `decide.md`). **It is not in the trainers' scanner yet** (step 4):
the only caller is the admin speed-test page.

## The flow (`matcher.js`, `createPhoneMatcher(deps).match(photo)`)

Order and branches are `CardMatcher.match`'s. Stage names in brackets are the timings the page shows.

1. **Card** [finder]: `findCard(photo, {hires: true})`. `source: 'quad'` is "found"; `'whole'` and `'guide'` are the server's `found = False`, which
   is `fallback = 'guide_crop'` (no `trustrejected`, so the strict fallback rules apply). The text is read from the sharper copy (`hires`) when there is one.
2. **Orientation** [views, embed, search]: embed the card and its 180° turn, search the whole-card index; the picture says "turned" when the turned view's
   best score beats the upright one by `orient_margin` (0.10, from the manifest).
3. **Views and scores** [views, embed, search]: from the oriented card, the tight and CLAHE views and the three artwork windows (card, tight, CLAHE); five more
   embeddings. Whole-card `best` = the best over the two orientation views and the two extra views; `own` = the best over the three artwork views against the
   artwork index (a card the artwork index lacks uses `best`); `score = (best + own) / 2`, `art = own`. All ~19.7k rows are scored (a cheap int8 dot product), because
   `decideCard` needs full vectors (a text candidate outside the picture's top 20 still needs its similarity and rank).
4. **Text** [ocr_number, name]: picture said turned → read turned only. Otherwise read upright first; if that gave nothing usable, **and the card was found**, read
   turned too and keep the better one (completeness, then "the name is in the catalogue"). A card not found is read in one orientation only (`light`).
   When a second read applies the first read holds back its last-resort band (`stage: 'first'`).
5. **Second read** [second_read] (`wholeread`): only for a card the finder cut out (`source != 'whole'`) of a guide-shaped picture, when the number is not complete:
   `secondRead` reads the whole picture once more, merges (`source: 'whole_picture'`, its confidence), then the held-back band. `wholestrict` in the decision uses that
   source and confidence.
6. **Orientation again**: when the text turned the card, steps 3's views are made again for the real orientation.
7. **Decision** [decide]: `decideCard` with the full score vectors, the read, the kept options (`numberOnce`, `wholeStrict`, names, number and text lanes on, `reprint` off,
   `fallback` = the card was not found) and the manifest's thresholds.

The result is `MatchResult`-like: `decided`, `cardId`, `tcgCardId`, `mechanism`, `reason` / `unsure_reason`, `matches` (top 20 with names), `candidates`, `read`, `detection`,
`orientation`, `wholeread`, `timings_ms` per stage and `total`, `backend`, `pictureOnly`, `notes`, `stages` (the stages in the order they ran) and `catalogue`.

## Version guard (`guard.js`)

The code is written for `matcher_version` 11. `checkManifest(manifest)` refuses another version (and an incomplete bundle) with `code: 'matcher_version'` and a message
"Phone matcher needs updating"; the host refuses before reading a single file, and the page shows that state instead of a run button. Thresholds come from the manifest
(`thresholdsFromManifest`), so a changed server constant reaches the phone without a code change; a changed *algorithm* needs a new matcher version and an app update.

## Backend choice and the worker (`host.js`, `client.js`, `worker.js`, `ort.js`, `embedder.js`)

- **fp16 on WebGPU** when WebGPU works, else **uint8 on WebAssembly**. The OCR sessions are always WebAssembly. **uint8 is never run on WebGPU** (it crashes Safari on iOS 26.6): the
  8-bit model is not even read when a WebGPU model is chosen, and one embedding model is held at a time (a second `init` releases the first before loading the next).
- **"Works"** means `navigator.gpu.requestAdapter()` returns an adapter, tried in the **worker** (`probeWebGpu`, reported as "probe worker WebGPU" in the page's *Tried* line).
  Order for `auto`: fp16 in the worker → fp16 on the main thread (the model there, everything else in the worker) → uint8 on WebAssembly. A WebGPU session that fails to start falls through
  to the next, and the page shows what was tried. The page's *Model backend* select forces a choice (it still ends on WebAssembly if WebGPU is missing).
- **Is WebGPU available in a worker on Safari 26?** I could not establish it from outside a device: WebKit's Safari 26 notes confirm WebGPU on iOS 26 for windows, and I found nothing either way for
  dedicated workers. So the code does not assume: the worker probes, and the main-thread route exists for the case where it says no. The main-thread route is a small RPC: the worker pre-processes
  (the same pixels either way) and sends the tensors, the main thread runs the fp16 session and sends the unit vectors back (`rpc` messages `load-model`, `embed`, `release-model`). The first
  iPhone run will say which route `auto` took (the backend line reads "fp16 on WebGPU (worker)" or "(main thread)").
- **Protocol** (client → host): `init {manifest, mode, mainGpu, budgets}`, `match {photo, options}` (the pixel buffer is transferred), `release`, `rpc-result`. Host → client: `ready {info}`, `progress {stage}`,
  `result`, `error {code, message}`, `released`, `rpc`. Matches run one at a time, in order. Everything loads once in the worker: ORT sessions, the index files (parsed as views over the cached
  buffers), the catalogue indexes. `release` frees the sessions; leaving the page terminates the worker.
- **Memory**: the model bytes are dropped once the session holds them; the page keeps no second copy of the photo (each run gets a fresh copy, the worker takes the buffer); the speed-test crash
  markers (`matcher_init`, `matcher_run`) are set, so a page that dies reports the step, and the page then preselects "uint8 on WebAssembly only".
- Vite: `worker: { format: 'es' }` in `vite.config.js` (the worker imports ORT dynamically, which the default IIFE worker format cannot). The worker chunk is ~96 KB; the ORT chunks and wasm files
  stay out of the precache (`build-sw.mjs` `NOT_PRECACHED`).

## Budgets

`DEFAULT_BUDGETS = {number: 0.9, name: 0.9, secondRead: 0.9}` seconds, the server's `FAST_BUDGET_SECONDS` (the docs/ocr.md recommendation); each is configurable through
`createPhoneMatcher({budgets})` / the `init` message. They are wall-clock and a ladder finishes the step it is in. Lower them only after the iPhone numbers say so: the first tight strip reads most cards.

## Finder profile (Node, desktop CPU; `finder/profile.bench.test.js`, `PHONE_PROFILE=1`)

The JS port already does what the server does: the quad is searched on a copy whose long side is at most 900 px (`DETECT_MAX_SIDE`) and the 630×880 card is warped from the **full-size** photo.
Measured on a generated photo enlarged to 1536×2048 (the stored size), 5 runs, median:

| Step | ms |
| --- | --- |
| shrink to the 900 px detection copy (area) | 74 |
| find the quad on that copy (edge maps, contours, scoring) | 327 |
| warp the 630×880 card from the full photo | 70 |
| `findCard`, no sharper copy | 444 |
| `findCard` with the sharper copy (`hires`, what the matcher uses) | 617 |
| tight + CLAHE views | 301 |
| whole-picture copy for the second read | 162 |

**Before / after.** Nothing changed by default: the quad search stays on 900. I added `findCard(photo, {detectMaxSide})` and measured 720 / 640 / 480 on six generated photos: the search gets
faster (about 450 → 310 → 270 → 200 ms for `findCard`) but the corners move (a few px on a clean photo, 20–45 px on another, 200+ px on a third, and one photo changes source), so the
3a parity result would no longer hold. Decision: keep 900 until an iPhone measurement says the finder stage is too slow, then choose a side with the parity fixtures re-run
(`createPhoneMatcher({detectMaxSide})` passes it through). The enlarged fixtures are blurrier than a real photo, so only the shape of the numbers is meaningful.

## Catalogue on the phone

- `backend/services/offline_carddb.py` `SET_FIELDS` now carries `printed_total`. Every set payload's content hash changes with it, so an existing device sees every set hash differ from its manifest on the
  next sync, fetches the sets again, and `loadCatalogueRows` then reads `set.printed_total` (tests: `backend/tests/test_offline_carddb.py`, `frontend/src/offline/carddb/printedTotalSync.test.js`:
  old hashes → all sets re-fetched → totals present, signature changed, up to date afterwards). The sync is the app's normal one (Wi-Fi/idle rules unchanged); until a device has synced,
  `stats.printedTotalMissing` is non-zero and number-and-total decisions lean on the picture.
- The decide indexes are built **in the worker, lazily, once per catalogue signature** (`createLazyIndexes`, restricted to the ids of the bundle's index files). A card sync changes the signature and the next match rebuilds.
- **No card database on the device**: the host says so (`info.cardDb: false`, `catalogue: {present: false}`), the page says "not downloaded: the run is picture-only", the matcher does not read the text at all and
  returns the closest pictures by id with `pictureOnly: true`, `reason: 'no_card_database'` and no decision.

## The speed-test page: "Full phone matcher" (`/settings/phone-speed`, section 4)

Runs the whole matcher on the photo three times; shows the first run and the median of the next two for **finder, views, embeddings, search, OCR number, name, second read, decide and the total**, the backend
(and what was tried), the decision with card, mechanism and reason, what was read, and the **top 5 with names from the card database**. Posts one run to `POST /api/card-match/phone-speed` with flat timings
(`matcher_<stage>_first_ms` / `_median_ms`) and a `matcher` block (version, backend, mode, runs, stable, decided, card, mechanism, reason, similarity, picture_only, top20, read, orientation, detection,
wholeread, catalogue, photo, timings), validated by `phone_speed._clean_matcher` (numbers and short texts only).

**Same pixels for phone and server (decision: the phone prepares the photo the way the server stores it, and uploads that photo).** `phonespeed/matchPhoto.js` applies EXIF orientation, limits the long side to
2048 px and encodes a JPEG (quality 0.92); the matcher runs on the pixels **decoded from that JPEG**, and the same JPEG is uploaded. The server stores `sanitize_image_bytes` of it (EXIF applied, ≤2048 so no resize,
re-encoded once at quality 90) and `compare_server` decodes that at max 2048. What can still differ is small and named: the server's extra JPEG generation, and Safari's JPEG decoder against Pillow's.
I did not change what the server keeps (it keeps its sanitised copy, as before).

**Comparison** (`phone_speed.compare_matcher`, in `latest()` as `matcher_compare`): the phone's full decision against the server's kept set on the phone's model and index (`server.phone8`): same decided /
undecided, same card, same mechanism, and the overlap of the two top 20s (`_en` suffixes ignored). Scanner lab shows
`full matcher: phone <card or unsure> / server <card or unsure> · agree yes/no · N/20` (and a mechanism note when the card agrees but the mechanism does not), then the backend and stage times.
"Agree" means same decided/undecided and, when decided, the same card (both unsure agree).

## Tests

`matcher.test.js` (stage order; embeddings per stage; orientation by picture and by text; wholeread only for an incomplete number from a guide picture; budgets; scores; picture-only; replay on the step 1 generated
photos with the real finder, views and decision rules and fake embeddings/reading), `host.test.js` (version guard, backend choice, protocol, memory, worker failure), `pictureIndex.test.js`,
`phonespeed/matcherRun.test.js`, the page tests, `backend/tests/test_card_match_phone_speed.py` (storage, validation, comparison). No real scan photo is used anywhere. Not covered by CI: ORT with the real models in
a browser, and WebGPU; that is what the iPhone run is for.
