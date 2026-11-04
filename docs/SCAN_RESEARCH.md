# Scanning cards without an LLM: research

Status: research only, nothing built. Written 2026-11-04 against `nonprod` at `f78b2d5`.

## Summary for the owner

**The answer.** Yes. There is a faster and more dependable way, and it is how most dedicated card scanners work: match the *picture* of the card against the pictures of every card we already have from TCGdex, then read the small printed number to make sure. A vision LLM is then only needed for the hard cases.

**Why today's scanner is slow and shaky.** Every photo goes to Gemini (or another vision AI) to *read* the card's name and number. That's one or two AI calls per card, each taking seconds. Our own rate limiter allows only 6 calls a minute per key, and that quota is shared with prod. Then the server *searches by name*. So one misread letter, a lost "TG" prefix or a translated name sends the search the wrong way. Most scanner fixes this year were for exactly that. The picture check the server already has hashes the *whole photo*, background included. In a small test I ran, that step picked the wrong card more often than the right one. Hashing just the flattened card got 106 of 108 right.

**What I recommend.** Rebuild recognition as **find the card → match its picture → read the number → AI only if still unsure**:

1. Find the card in the photo and flatten it. The trainer already lines it up with the yellow guide.
2. Compare the flattened card with a "picture index" of every card in the catalogue. This is a small list of numbers per card, made once from the pictures the server already caches.
3. Read the collector number (e.g. "125/197"), and the set code where there is one, from the bottom of the card.
4. If the picture and the number agree on one printing, it's done. If not, today's AI step runs as before, with better candidates. Without an AI key, the trainer picks from the top matches in the Scan inbox, as today.

It all runs on the home server. No GPU, no new paid service, no change for trainers: same camera, queue, offline outbox, inbox and review.

**Expected gain.** These are estimates until the benchmark below is run on our own photos:

- **Speed:** about 1–2 seconds per card on the server, instead of tens of seconds to minutes. A batch of 20 should be ready in under a minute.
- **AI use:** roughly 70–85% fewer AI calls. Quota waits and rate-limit countdowns become rare.
- **Accuracy:** at least as good as today's when the number is readable, because picture and number check each other. Mostly better on cards whose names the AI misreads or translates.
- **Variants:** holo / reverse holo / 1st Edition stay a choice in the Add sheet, as today. Today's AI doesn't detect them either, and no method does that reliably from one photo. Smarter pre-filling is possible (see §2.4).
- **Cost:** no per-scan fees; one-off build work. The AI's money cost is already small. The real gains are speed, reliability and fewer photos sent to Google.

**What it needs from you:** a set of real scans with confirmed answers to test on, the home server's specs, and a few decisions (§3.11). The first step is a benchmark script that changes nothing in the app (§3.8).

**Confidence:** medium-high that this will be much faster and need far fewer AI calls. Medium on the exact accuracy numbers, because no one has published a solid test on photos like ours. A benchmark on about 300 of our trainers' own scans would settle it.

---

## Contents

1. [How scanning works today](#1-how-scanning-works-today)
2. [The alternatives](#2-the-alternatives)
3. [Recommendation](#3-recommendation)
4. [Sources](#4-sources)

## 1. How scanning works today

### 1.1 The pipeline, end to end

| Step | What happens | Where |
| --- | --- | --- |
| Camera | Full-screen live camera (`getUserMedia`, back camera, asks for 3840×2160). A yellow 63:88 guide frame is drawn, but the **whole frame** is captured as a JPEG (quality 0.92). The trainer can also pick photos from the library. Up to 50 photos per batch, each toggled "individual" or allowed to group. | `frontend/src/components/BatchCameraCapture.jsx`, `UnifiedCardScanner.jsx`, `scanCamera.js` |
| Outbox | Photos are saved to IndexedDB first, then sent only when the server is known to be reachable, waiting at most 5 s ("persist-then-send"). Otherwise they wait offline and replay later with an idempotency key. | `frontend/src/offline/ops/scanSubmit.js`, `offline/outbox/*`, `offline/outbox/ops/scanUpload.js` |
| Upload | `POST /api/cards/recognize/jobs` (multipart). Each photo is decoded, rotated by EXIF, resized to at most 2048 px, stripped of metadata and saved as JPEG for 14 days. A background drain starts at once; a scheduler job also drains every minute. | `backend/api/scan_jobs.py`, `backend/services/scan_storage.py`, `backend/services/scheduler.py` |
| Queue | Fair per-user claiming with leases. At most 3 scans are processed at once. Photos allowed to group are combined 2–4 at a time into one labelled composite image, so one AI call reads several cards. Retries: 2/10/30 s for recognition errors, 30 s up to 6 h for transient ones, and the provider's own reset time for rate limits. | `backend/services/scan_queue.py`, `backend/services/card_composite.py` |
| AI read | One call with `RECOGNIZE_PROMPT`: name (printed and English), number and total, set code, regulation mark, type, HP, language, artist, returned as JSON. Composites use `COMPOSITE_PROMPT`. | `backend/api/recognize.py` (`_recognize_with_provider`, `recognize_composite_card_info`) |
| Providers and keys | Gemini (default) or any OpenAI-compatible server (OpenAI, Ollama…). Per-user keys, or one admin key for everyone (`SCANNER_GLOBAL_CONFIG=true`). There is a capability test (two images in one request), an opt-in Gemini fallback when an OpenAI-compatible provider is unsure, and per-key pacing: `GEMINI_RATE_PER_MIN` defaults to 6 with a burst of 3. A daily-quota 429 blocks the key for 1 h, then 6 h. | `backend/services/scan_providers.py`, `gemini_rate_limit.py`, `provider_rate_limit.py`, `docs/scanner-providers.md` |
| Match | The **name** is searched in the local card table, across separator and qualifier variants, plus an English fallback using the AI's translation. If nothing local has the read number, live TCGdex is searched instead (at most 12 requests or 30 s per scan). Digital (TCG Pocket) printings are excluded. Candidates are ranked by number → language → printed total → set code → regulation mark → artist → HP. A decision is made only when this metadata isolates one printing. | `recognize.py` (`_search_and_rank_candidates`, `_candidate_rank_key`, `_metadata_decision`) |
| Picture check | If still undecided: download up to 8 candidate pictures **from the TCGdex CDN**, and compare a 64-bit pHash of the **whole photo** with each (accepted when the distance is ≤ 20 and the lead is ≥ 5). If that fails, a second AI call shows the photo plus about 12 candidate pictures and asks for a number (visual verification). | `recognize.py` (`_phash_best_match`, `match_card_info`) |
| Inbox and review | Results land in the Scan inbox: matches as a grid with a "printed total doesn't match" badge, and a linked zoom comparison. The trainer picks a candidate. The Add sheet sets variant (pre-filled from the catalogue's available variants), language (pre-filled from the AI's guess), condition and so on. `resolve-and-add` adds the card atomically, deletes the photo and records the confirmed card as ground truth. | `frontend/src/pages/ScanQueue.jsx`, `components/ScanReview.jsx`, `components/CardScanner.jsx` (`ScanAddModal`), `scan_jobs.py` |
| Diagnostics | Opt-in per user, and only when the server sets `SCAN_TRACE_DIR`. One JSON per attempt: the sanitized photo, AI output, candidates, pHash outcome, decision, and later the confirmed answer and its rank. `backend/scripts/analyse_scan_traces.py` prints top-1 accuracy, decision mechanism and null rates. **This is a ready-made benchmark dataset** if diagnostics are switched on. | `backend/services/scan_trace.py`, `backend/scripts/analyse_scan_traces.py` |

### 1.2 Where the time goes

Roughly in order of size:

1. **AI calls and their pacing.** Each card needs one AI read. An undecided card needs a second call carrying about 13 images; with Gemini 3's default image size that is roughly 1,120 tokens per image ([media resolution](https://ai.google.dev/gemini-api/docs/media-resolution)). The Gemini fallback can repeat both calls. The limiter allows 6 calls a minute per key with a burst of 3. A batch of 10 cards that needs 10–20 calls therefore spends 1–3 minutes on pacing alone, before Google's own limits, which prod shares. A provider's 429 adds countdowns, up to 6 h for a daily quota.
2. **The AI response itself.** It typically takes several seconds per call. That's my estimate: the traces record the responses but not their timing. Local models (Ollama) are slower; the settings allow up to 180 s per response.
3. **Network lookups during matching.** Live TCGdex searches when the local catalogue lacks the number (up to 30 s). TCGdex detail fetches for missing totals or artists (8 s timeout). Candidate pictures downloaded from the CDN (5 s each, in parallel), even though the server already caches small pictures of every card (`backend/services/card_picture_packs.py`).
4. **Queue mechanics.** Three scans at a time, plus backoffs after errors.

### 1.3 Where it fails

From the code, the git log and the PR history:

- **Wrong card from a misread or mistranslated name.** Search starts from the name the AI read. Generic Energy names ("Basic Energy"), hyphens and spaces ("Ho-Oh"), qualifiers ("Boss's Orders (Giovanni)"), vintage and non-English names have each needed fixes. See upstream [#378](https://github.com/Git-Romer/pokecollector/pull/378), [#421](https://github.com/Git-Romer/pokecollector/pull/421) and [#324](https://github.com/Git-Romer/pokecollector/pull/324). The English fallback uses the AI's *translation*, which can add noise (`ENGLISH_FALLBACK_*` in `recognize.py`).
- **Wrong set or number.** The small print gets misread or dropped: gallery prefixes like TG/GG/SV ([#419](https://github.com/Git-Romer/pokecollector/pull/419), issue [#335](https://github.com/Git-Romer/pokecollector/issues/335)), "No. 0094" Pokédex numbers taken as the collector number (now a prompt rule), totals printed with a prefix. Reprints sharing a number need the set code or total, which the AI often returns as null.
- **Wrong picture pick.** Visual verification once trusted picks of candidates the model never saw ([#422](https://github.com/Git-Romer/pokecollector/pull/422)). An upstream contributor measured that Gemini's visual pick decided **0 of 290** recorded scans (closed PR [#324](https://github.com/Git-Romer/pokecollector/pull/324), August 2026; the code has changed since).
- **The pHash step hashes the whole photo.** See §1.5: in a synthetic test it chose wrong more often than right. It only rejects a pick that contradicts the read metadata, and it runs exactly when the metadata was too thin to decide.
- **Digital cards offered for a photo:** fixed in [#420](https://github.com/Git-Romer/pokecollector/pull/420).
- **Variant:** not detected at all. The prompt doesn't ask for it, and the Add sheet defaults to Normal when the catalogue says a Normal print exists (`frontend/src/utils/cardVariants.js`).
- **Language:** the AI guesses an ISO code. Only the languages the server syncs are searched (`TCGDEX_SYNC_LANGUAGES`, default `en,de`).
- **Several cards:** handled by combining separate photos into a composite. A single photo with several cards isn't supported; the prompt reads "this card".
- **Rotation:** an upside-down card returned an empty name, and the model couldn't report orientation: 0 of 18 in upstream #324's tests.
- **Provider trouble:** 429s and daily quotas, 503 overloads, models renamed or removed (issue [#282](https://github.com/Git-Romer/pokecollector/issues/282)), image tests too small for some providers (issue [#425](https://github.com/Git-Romer/pokecollector/issues/425)), TCGdex outages ([#389](https://github.com/Git-Romer/pokecollector/issues/389), [#390](https://github.com/Git-Romer/pokecollector/issues/390)). On this fork, F8/F9 ([#58](https://github.com/IDEKENTERPRISES/pokecollector/pull/58), [#60](https://github.com/IDEKENTERPRISES/pokecollector/pull/60)) came from the owner's iPhone tests of the global scanner setup.

### 1.4 Costs and quotas today

- **Money.** Gemini Flash is listed at $0.75 per million input tokens and $3.75 per million output tokens until 31 Dec 2026, then $1.50 and $7.50, with a free tier ([pricing](https://aistudio.google.com/docs/pricing)). One read is about 1–2k input tokens. Visual verification with about 13 images at Gemini 3's default size is about 15k. A scan costs roughly $0.001–0.03, so 1,000 scans a month is a few dollars to about $30. These are my estimates; thinking tokens, if enabled, add to them.
- **Quota.** Free-tier limits are per Google project and shown only in AI Studio ([rate limits](https://aistudio.google.com/docs/rate-limits)). Third-party sources disagree on current numbers, so treat them as unverified. In global mode, all trainers, and prod, draw on one admin key.
- **Privacy.** Every photo, plus about 12 candidate pictures per undecided card, goes to the provider.

### 1.5 A tiny proof: the pHash step as it is today

To settle one question cheaply (does hashing the whole photo ever work?), I wrote a script that builds phone-style photos from nine Pikachu printings. Each photo has a background, a slight tilt, a colour cast, sometimes a glare spot, blur and JPEG compression. The card covers 55–65% of the frame width, roughly what filling the yellow guide gives on an iPhone. I then ran the backend's own pHash and thresholds against all nine pictures. Script and how to run it: [`docs/scan-research/phash_whole_photo_proof.py`](scan-research/phash_whole_photo_proof.py).

108 synthetic photos over 4 random seeds:

| What gets hashed | Right | Wrong | No decision |
| --- | --- | --- | --- |
| Whole photo (today) | 2 | **9** | 97 |
| Crop to the guide frame (no detection) | 11 | 4 | 93 |
| Card found and flattened (known corners) | **106** | 0 | 2 |

The photos are synthetic and the flattened case had perfect corners, so this says nothing about real-world accuracy. It does show two things. The background dominates a whole-photo hash, so today's step is mostly noise and occasionally harmful. And once the card is found and flattened, even a crude 64-bit hash separates same-name printings. A separate project saw the same effect with learned embeddings: without card detection, the background dominated and recognition didn't work ([jeffreygoodgood/pokemon-card-scanner](https://github.com/jeffreygoodgood/pokemon-card-scanner)).

## 2. The alternatives

### 2.1 Finding and flattening the card

Every method below works far better on a flattened card than on a raw photo. Options:

- **Edges and contours** (OpenCV): threshold or edge-detect, find the largest four-sided shape, then a perspective warp. This is what tmikonen's MTG detector ([write-up](https://tmikonen.github.io/quantitatively/2020-01-01-magic-card-detector)), rhizonymph's Pokémon scanner ([repo](https://github.com/rhizonymph/pokemon-card-scanner)) and the PokVault paper ([paper](https://didierrlopes.github.io/pokemon-card-scanner-paper)) do. PokVault combines several fallbacks: contours, Hough lines, a saturation mask and a manual crop. Reported weak spots: overlapping cards, hard lighting, too much or too little border. Sleeves and top-loaders add their own edges. Our yellow guide helps here: we know roughly where the card is and how big it is, so the search can be limited to that area.
- **A small trained detector** (YOLO-style with oriented boxes or segmentation), trained on synthetic composites of card pictures over random backgrounds. 1vcian's scanner reports box mAP50 of 98.5% on its synthetic validation set ([repo](https://github.com/1vcian/Pokemon-TCGP-Card-Scanner)). jeffreygoodgood trained one on 4,500 synthetic images; Pokescope uses YOLOv8 ([blog](https://pokescope.app/blog/how-i-built-pokemon-card-scanner-ai-50000-users/)). Licence note: Ultralytics YOLO is AGPL-3.0. That fits this project, which is also AGPL-3.0, but it is worth knowing.
- **Orientation:** a flattened card is portrait, which leaves only upright versus upside down. Embedding both rotations, or a tiny classifier as in TCG-AR ([arXiv 2607.02090](https://arxiv.org/html/2607.02090v1)), settles it cheaply.
- **Several cards in one photo:** a detector or contour pass returns every card. Each is then flattened and matched separately. This would replace the composite trick, which exists only to save AI calls. Each card would need its own inbox item, a small queue change.
- **Apple's Vision rectangle and text detection** isn't available to a web app. Safari doesn't expose it to JavaScript, and the Shape Detection API's text detector isn't shipped in Safari (unverified; it is still listed as in progress in [Chrome's docs](https://developer.chrome.com/docs/capabilities/shape-detection)).

### 2.2 Matching the picture against the catalogue

About 30k cards across the synced languages; TCGdex pictures are 245×337 ("low") or 600×825 ("high") ([TCGdex assets](https://tcgdex.dev/assets)).

| Method | Real phone photos (evidence) | Index size, ~30k cards | CPU per photo | Reprints, languages, promos |
| --- | --- | --- | --- | --- |
| **Perceptual hashes** (pHash, dHash, colour hash) on the flattened card | Good on clean, flat crops; brittle with glare, foil and sleeves (PokVault's view; Moss Machine and mtg-detector note lighting sensitivity). Collisions grow with the catalogue: jslok needed longer, combined hashes at ~20k cards ([repo](https://github.com/jslok/card-scanner), as summarised by search; the README is now offline). Upstream #324 measured a phash + dhash + colour-hash mix at **96.9%** when choosing among a few same-name candidates (64 real cards). | ~0.5–1 MB | < 5 ms, search < 1 ms | Same artwork gives the same hash: can't separate reprints or same-art languages; promo stamps are too small. |
| **Local features** (ORB/SIFT keypoints plus a homography check) | Robust to angle and partial cover. Best as a checker for a handful of candidates: upstream #324 measured SIFT at **98.4%** against 96.9% for hashes on the same 64 cards. Searching all cards this way needs extra machinery (visual words). | ~500 keypoints × 32 B per card ≈ 0.5 GB for all cards | 10–50 ms per candidate pair (estimate) | Partly: at full resolution it can see differing text, symbols and stamps. |
| **Learned embeddings** (DINOv2, CLIP, SigLIP, MobileCLIP, or a fine-tuned CNN) plus nearest-neighbour search | The best evidence for searching the whole catalogue. TCG-AR: about 20k Pokémon cards, 636 real crops, ResNet-50 trained with ArcFace on synthetic augmentations: **85.1% top-1, 96.2% top-5**, and 96.4% top-1 when limited to 631 deck cards. Most errors were near-identical prints. Tao2k's scanner: flattened card, small DINOv2/DINOv3 model, plus a pixel check of the top 8: **90–94% top-1** on 400 synthetic phone photos, against 69% before flattening ([PR #29](https://github.com/Tao2k/cardscanner/pull/29)). Off-the-shelf larger models scored worse in that test, so model choice must be benchmarked. Without detection: unusable (jeffreygoodgood). | 384 numbers per card: 23 MB at 16-bit, 12 MB at 8-bit. PokVault stores CLIP at 516 B per card: 9.2 MB for 17,531 cards. | ViT-S ≈ 10–40 ms, ViT-B ≈ 35–150 ms. ViT-B/16 runs 36–70 ms on desktop i9/i7 CPUs with ONNX Runtime ([OpenCV DNN benchmarks](https://github.com/opencv/opencv/wiki/OpenCV-5-DNN-Benchmarks/6fa56ddf498791a95451451d0daa5e2a233b0313)). Search: one matrix multiply, < 10 ms. | Weak: same art gives near-identical vectors, and same-art languages can't be told apart reliably. Needs the number check below. |

What this means for us: picture matching should *propose* a short list (top 20) from the whole catalogue, and the printed number should *confirm* one of them. Embeddings are the right search tool at 30k cards. Hashes and keypoints are fine as cheap extra checks on the short list. DINOv2 is generally stronger than CLIP for exact-instance retrieval ([DINOv2 paper](https://arxiv.org/abs/2304.07193)), but the Tao2k results show it has to be measured on our photos. No vector database is needed: 30k × 384 numbers fit in memory, and Postgres here is the plain `postgres:18-alpine` image without pgvector.

Licences: DINOv2 is Apache-2.0, SigLIP Apache-2.0, OpenAI CLIP MIT. DINOv3 and Apple's MobileCLIP have their own licences, which need checking before use (unverified).

### 2.3 Reading the printed identifiers (OCR)

- **What to read:** the collector number and total ("125/197", "TG06/TG30", "SWSH001"). On modern cards, also the set code and the language code printed beside the number (e.g. "SVI EN"; verify on real cards), and the regulation mark. "HP" or "KP" (German) is a language hint. The number sits bottom-left on recent cards and bottom-right on older ones, so read both corners of the flattened card. Crop them from the full-resolution photo rather than the 600 px flattened card: the text is only a millimetre or two high.
- **Engines:**
  - **PaddleOCR PP-OCRv5 mobile:** detector 4.8 MB, recogniser about 7.5–16 MB depending on version and language. About 21 ms per text line on CPU in the official tables ([docs](https://www.paddleocr.ai/v3.3.1/en/version3.x/module_usage/text_recognition.html); [sizes](https://wikidocs.net/441124)). It runs on ONNX Runtime through community exports.
  - **Tesseract:** Apache-2.0, about 2–10 MB of English data ([tesseract.js](https://github.com/naptha/tesseract.js/releases/tag/v5.0.0)). Weak on card text in mtgscan's tests, where cloud OCR did better ([write-up](https://fortierq.github.io/mtgscan-ocr-azure-flask-celery-socketio)).
  - **Apple's Vision OCR:** not reachable from a web app.
- **Fuzzy matching:** mtgscan matches OCR text to the card list by edit distance (SymSpell) and reports about a 10% error rate per decklist image. For us the number is better than the name: a small regular pattern checked against the 20 picture candidates, not the whole catalogue. The existing ranker and decision rules (`_candidate_rank_key`, `_metadata_decision`) already do this from the AI's fields. They can take OCR's fields instead.
- **No published accuracy** for reading Pokémon collector numbers from phone photos was found. Benchmark it.

### 2.4 Variants, languages, reprints and promos

- **Holo / reverse holo / 1st Edition.** TCGdex lists which variants a card exists in (`variants.normal / reverse / holo / firstEdition`, [card reference](https://tcgdex.dev/reference/card)) but has one picture per card. So no picture method can learn the difference from our references.
  - *Today:* the AI isn't asked; the trainer chooses in the Add sheet.
  - *Elsewhere:* TCGplayer asks sellers to batch cards by foiling ([help](https://help.tcgplayer.com/hc/en-us/articles/27303183354007-How-Quicklist-IdentificationTechnology-Works)), Dex asks users to pick the variant per batch ([help](https://dextcg.com/help/collection/scanning-your-cards)), and Grimoria takes finish and language from scan defaults ([help](https://grimoria.app/help/scanner/mobile-app-scanner)). Ximilar returns a Foil/Holo tag but documents nothing for reverse holo or 1st Edition ([docs](https://docs.ximilar.com/collectibles/recognition)). Pokescope claims its model tells editions apart, without evidence. No measured holo-detection accuracy was found anywhere.
  - *What's realistic:*
    - pre-fill from TCGdex's variant list: when only one variant exists, that's the answer;
    - a 1st Edition stamp check, since the stamp sits in a fixed spot on WotC-era cards (a small template match on the flattened card);
    - a "this batch is reverse holo" toggle at capture;
    - later, a foil classifier trained on our own confirmed scans.
- **Languages.** Same-art cards in English and German differ only in text, and some languages reuse another language's pictures (`image_source_lang` in the card table). So the picture finds the *printing* and the text decides the language: OCR's language code, KP/HP or script, then the trainer's default language. Limit the search to synced languages.
- **Reprints and promos.** Same artwork in several sets (gallery subsets, anniversary reprints, promo stamps) is where picture methods fail (TCG-AR's error analysis). The number, total and set code separate them. When the number can't be read, the inbox shows the close candidates, as today.

### 2.5 Running it on the iPhone (PWA)

- **Runtimes.** ONNX Runtime Web (WebAssembly with SIMD, or WebGPU) and TensorFlow.js both run in Safari. WebGPU is on by default from Safari 26 on iOS 26 ([web.dev](https://web.dev/blog/webgpu-supported-major-browsers); [WebKit bug](https://bugs.webkit.org/show_bug.cgi?id=299237)). Multi-threaded WebAssembly needs cross-origin isolation (COOP/COEP headers), which may affect other cross-origin loads. One SDK skips threads on iOS over memory crashes ([Dynamsoft](https://www.dynamsoft.com/faq/barcode-reader/web/capabilities/adaptive-wasm-loading.html)).
- **Download size** for offline use, cached once:
  - ONNX Runtime's WebAssembly file is about 11–12 MB ([manifest](https://huggingface.co/janitr/experiments/blob/main/runtime/onnxruntime-web/RUNTIME_INFO.json)).
  - A small embedding model is about 20–25 MB at 8-bit. Tao2k's in-browser models are 21–23 MB. MobileCLIP-S0's image encoder has 11.4M parameters, about 1.5 ms on an iPhone 12 Pro Max in Apple's tests ([paper](https://arxiv.org/html/2311.17049v2)).
  - The index is about 12 MB per 30k cards at 8-bit.
  - OCR adds about 5–20 MB.
  - About 50–70 MB in all, well below the card picture packs trainers can already download.
- **Speed and limits.** Not measured on our phones: a small model should take a fraction of a second, but older iPhones without iOS 26 fall back to WebAssembly. The index must be shipped from the server. Building it on the phone would take most of an hour, so it would be delivered per set, like picture packs.
- **Verdict.** Realistic, and it would give instant answers offline. It means a second code path to build and test on real iPhones. Do it after the server version has proven the model and thresholds, reusing the same model and index files (§3.7).

### 2.6 Existing projects, services and apps

**Documented** means the method is described by its authors. **Measured** means a number from a stated test. Everything else is a claim.

| Project | Method (documented) | Results |
| --- | --- | --- |
| [TCG-AR](https://arxiv.org/html/2607.02090v1) (preprint, 2026) | Detector; ResNet-50 embedding trained with ArcFace on synthetic crops of 20,360 Pokémon cards; nearest-neighbour search | **Measured:** 85.1% top-1 / 96.2% top-5 on 636 real crops; 96.4% top-1 when limited to the deck list. Errors mostly near-identical prints. Board camera at a distance, harder than our close-ups. |
| [Tao2k/cardscanner PR #29](https://github.com/Tao2k/cardscanner/pull/29) | Flatten the card; DINOv3-S (21 MB, quantised); pixel check of the top 8 | **Measured on synthetic photos:** 94% top-1; DINOv2-S 90%, SigLIP-B 95%; 69% before flattening. The author warns the synthetic set is optimistic. |
| [jeffreygoodgood/pokemon-card-scanner](https://github.com/jeffreygoodgood/pokemon-card-scanner) | YOLO11n with oriented boxes; EfficientNet-B0 triplet embedding; 558 cards from TCGdex | **Measured, small:** 21 of 22 phone photos right; about 200 ms. The one miss was holo glare. Without detection it failed. |
| [PokVault Rev](https://didierrlopes.github.io/pokemon-card-scanner-paper) | Classic edge/Hough detection, homography; CLIP ViT-B/16 in the browser (Transformers.js, ONNX Runtime Web); 9.2 MB index for 17,531 cards | No accuracy reported. Says variants come back together in the top results. |
| [Rarebox v1.4.1](https://github.com/novaoc/rarebox/releases/tag/v1.4.1) | On-device flattening; pHash + dHash against 30k+ pictures; OCR fallback (English and Japanese); about 840 KB of index | Thresholds tuned on synthetic photos to avoid wrong suggestions; no accuracy figure. |
| [1vcian TCGP scanner](https://github.com/1vcian/Pokemon-TCGP-Card-Scanner) | YOLO11n with oriented boxes (TensorFlow.js); 24-bit colour pHash in IndexedDB | Detector metrics only (synthetic validation). TCG Pocket cards. |
| [cardexx](https://github.com/LMilazzo/cardexx) | YOLOv8 crop; CLIP ViT-B/16; 19k cards | No accuracy figure. |
| MTG: [magic_card_detector](https://tmikonen.github.io/quantitatively/2020-01-01-magic-card-detector), [mtgscan](https://fortierq.github.io/mtgscan-ocr-azure-flask-celery-socketio) | Contours, perspective and pHash; cloud OCR with fuzzy names | Qualitative "works nicely" on about 100 images; mtgscan reports about 10% error and about 10 s per image. |
| Upstream [PR #324](https://github.com/Git-Romer/pokecollector/pull/324) (closed, not merged) | Hash mix and SIFT for choosing among candidates | **Measured:** 96.9% (hashes) / 98.4% (SIFT) on 64 cards; the Gemini visual pick decided 0 of 290 scans. |
| [Ximilar](https://docs.ximilar.com/collectibles/recognition) (paid API) | Card identification endpoint; Foil/Holo tag; language with an OCR option; all cards in an image | 10 credits per card ([pricing](https://www.ximilar.com/pricing/)). The endpoint needs the Business 100K plan, €59 / $69 a month, about 10,000 cards. Free tier 1,000 credits. No accuracy published. Photos go to a third party. |
| TCGplayer Scan & Identify ("Roca Vision") | Undocumented image matching | Claims 98%+ over hundreds of millions of cards ([help](https://help.tcgplayer.com/hc/en-us/articles/27303183354007-How-Quicklist-IdentificationTechnology-Works)). Asks for batches sorted by foiling. |
| [Pokescope](https://pokescope.app/blog/how-i-built-pokemon-card-scanner-ai-50000-users/) | YOLOv8, fine-tuned CLIP, and Tesseract on the number to separate look-alikes | Claims 60% → 95%+; no test described. The same hybrid shape as recommended here. |
| Grimoria, Dex, Delver Lens, Collectr | Grimoria: hash database downloaded, matched on the device. Others undocumented. | Variant and language chosen by the user or by batch defaults (Grimoria, Dex). Collectr's holo handling is a common complaint (third-party summary, unverified). |

The pattern across the field: **detect and flatten → picture search → read the number to break ties → user confirms variant**. Nobody serious relies on a general chat model to read each card.

## 3. Recommendation

### 3.1 The pipeline

```
photo (as today: outbox → upload → queue)
  │
  ├─ 1. find & flatten the card (OpenCV contours inside the guide area; later a small detector if needed)
  │      └─ no card found ──────────────────────────────┐
  ├─ 2. picture search: embed the flat card (0° and 180°) │
  │      → top 20 printings from the in-memory index     │
  ├─ 3. OCR both bottom corners at full resolution        │
  │      → number/total, set code, language code, KP/HP  │
  ├─ 4. decide with the existing rules on those 20        │
  │      + picture similarity and lead                    │
  │      ├─ one printing agrees → done (no AI call)       │
  │      └─ unsure ─────────────────────────────────────┤
  └─ 5. today's AI path (unchanged), with the picture top 20 added as candidates
         └─ no AI configured → inbox shows the top candidates for the trainer to pick
```

Then, as today: the inbox, the review grid, the Add sheet (variant and language pre-filled better, see §2.4), and ground truth recorded on add.

Build it as a separate module (for example `backend/services/card_match/`) and a scanner mode, so `recognize.py` changes little and upstream merges stay easy.

### 3.2 Expected accuracy and speed

These are estimates from §2's evidence, and the benchmark replaces them:

- **Right printing among the top 20 picture matches:** about 95–99% for cards that have a TCGdex picture. TCG-AR's top-5 was 96% from distant board crops; ours are close-ups.
- **Decided without AI:** about 70–85% of scans, with ≥ 98% of those right. The bar is set when the thresholds are picked.
- **The rest** go to the AI or to the reviewer, as today.
- **Time per photo on the server:** about 0.5–2 s of CPU. Results appear seconds after upload. Today it is often a minute or more under quota pacing.

### 3.3 Server needs

Assumed: a modest x86 home server with 4+ cores and 8–16 GB RAM, shared with prod.

- **CPU:** about 1 CPU-second per scan, with the existing cap of 3 at once.
- **RAM:** about 0.5–1 GB more at peak: model, OCR, and an index of tens of MB.
- **Disk:** about 300–600 MB more in the backend image or a volume: ONNX Runtime, OpenCV headless, models, index.
- **Index build:** 15–60 min of CPU once, in the background at low priority. A new set takes about a minute.
- **With a GPU:** about 0.1 s per scan, room for larger models, and a local vision model (Ollama with `qwen3-vl:8b` is already supported) could replace Gemini as the fallback. That would make scanning fully local.

### 3.4 Building and updating the picture index

- **Pictures:** use the small pictures the server already caches for every card (`CardPictureWarmer` in `card_picture_packs.py`, cache key includes the picture URL hash).
- **Index:** a new indexer embeds every cached picture that has no vector for the current model yet. Store one row per card: card id, language, model id, picture key, vector. Keep the whole matrix in memory and reload it when it changes.
- **Updates:** run the indexer right after the warmer, which already runs after each TCGdex sync (`schedule_after_sync`). New sets get indexed when TCGdex adds their pictures. A changed picture gets a new key and is re-embedded. Changing the model rebuilds everything.
- **Gaps:** cards without a picture (common for brand-new sets and some languages) aren't in the index. They fall to the OCR and AI path, and the admin page can show coverage ("29,140 of 29,800 cards indexed").

### 3.5 Offline, queue, inbox and review

- **Offline:** photos still save offline and upload on reconnect. Recognition then takes seconds instead of minutes. On-device (§3.7) is what would give answers while still offline.
- **Queue:** the same jobs, leases and retries. Composites aren't needed for picture matching; keep them only for the AI fallback. Rate-limit countdowns should become rare.
- **Inbox and review:** unchanged, with the same `recognized` and `matches` shape. Optionally add a "matched by picture and number" note in the trace and the UI.
- **Diagnostics:** traces gain the picture top 20 with scores and the OCR text, so every reviewed scan improves the benchmark.

### 3.6 Running cost versus the LLM

- **Picture matching:** no fees; a little electricity; one-off build work; occasional maintenance when a model or threshold changes.
- **AI:** calls drop by about 70–85% (estimate). Today's AI money cost is small (§1.4), so the gains are speed, quota headroom, fewer failures and fewer photos sent to Google.
- **Ximilar:** at least €59 / $69 a month for about 10,000 cards. That isn't better for 5–7 trainers.

### 3.7 On the phone versus on the server

| | Server (recommended first) | On the iPhone (later, optional) |
| --- | --- | --- |
| Speed | Seconds after upload | Instant, also offline |
| Offline | Queued until reconnect (as today) | Works offline |
| Build and test effort | One place, Python, testable in CI | Second code path; needs real-iPhone testing; older iPhones slower |
| Downloads | None on the phone | About 50–70 MB once, plus index updates per set |
| Server load | About 1 CPU-second per scan | None |

The server version comes first. It proves the model, thresholds and index format, which the phone version can then reuse.

### 3.8 Phased plan

**Phase 0 — data and quick wins (days).**

- Switch on scanner diagnostics on nonprod (`SCAN_TRACE_DIR`). Two or three consenting trainers scan about 300–400 cards with the normal scanner and confirm each in review; every confirmed scan stores photo and answer.
- Quick wins that help today, each a small PR:
  1. Stop hashing the whole photo, or crop to the guide first, since §1.5 shows it can pick wrong cards.
  2. Load candidate pictures from the server's own picture cache instead of the TCGdex CDN.
  3. Try Gemini's low or medium image resolution for candidate pictures in visual verification, which cuts tokens and time. Check accuracy on the traces.

**Phase 1 — prototype and benchmark (about 3–5 days, no app change).**

- A script, `backend/scripts/scan_benchmark.py`, runs the §3.1 pipeline offline on the trace photos.
- Run it on the home server, or on the build PC only at a time you approve. About 400 photos at 1–2 s, plus a one-off index build of 15–60 min.
- **Photo mix:**
  - modern English about 40%, German about 20%;
  - vintage WotC / e-series about 15%;
  - holo / reverse holo / full art about 15%;
  - at least 30 sleeved and at least 20 in top-loaders;
  - at least 20 at an angle or in poor light;
  - at least 20 "reprint traps" (same art in several sets);
  - 10 photos with several cards, for later.
- **Compared:**
  - contours versus a plain guide crop;
  - DINOv2 ViT-S/14 and ViT-B/14, SigLIP-B/16, CLIP ViT-B/16, and MobileCLIP for the phone;
  - PaddleOCR (ONNX) versus Tesseract;
  - and today's AI results on the same photos, read from the traces.
- **Measured:**
  - card found and flattened (%);
  - right printing in the top 1 / 5 / 20;
  - number read exactly (%);
  - share decided without AI, and how often those are right;
  - language right (%);
  - time per stage (median and 95th percentile);
  - peak memory.
- **Pass bar to go on to Phase 2:**
  1. Right printing in the top 20 for ≥ 97% of photos whose card has a TCGdex picture.
  2. Decided without AI for ≥ 70% of photos, with ≥ 98% of those right.
  3. The new pipeline with AI fallback is at least as accurate overall as today's AI on the same photos.
  4. ≤ 3 s per photo at the 95th percentile on the home server CPU, and ≤ 1 GB extra memory.
- **If it fails:** the report says which stage failed. Options then are fine-tuning (TCG-AR-style training on synthetic variations, a few GPU hours on the gaming PC at agreed times), or staying with the AI plus the Phase 0 fixes.

**Phase 2 — server-side scanner on nonprod (about 1–2 weeks).**

- A server setting turns on "picture match".
- **Shadow mode first:** it runs alongside the AI, records agreement in the traces and changes nothing the trainers see.
- **Then primary**, with the AI as fallback.
- Hook the indexer after picture warm-up. Show index coverage on the admin page. Unit tests, plus a few fixture photos in CI.

**Phase 3 — prod, with your OK.** Tune the thresholds from the trainers' review choices. The confirmed answers keep accumulating.

**Phase 4 — optional.**

- On-device instant matching (§3.7).
- Several cards per photo.
- Variant hints: the TCGdex variant list, a 1st Edition stamp check, a batch foil toggle.
- A model fine-tuned on our own confirmed scans.

### 3.9 Risks

1. **Clean pictures versus real photos** (sleeves, top-loader glare, holo sparkle, worn cards). Measured in Phase 1; flattening and fine-tuning are the remedies.
2. **Near-identical printings** (reprints, promo stamps, gallery cards). The picture can't tell them apart. This relies on reading the number; otherwise the trainer picks, as today.
3. **Cards with no TCGdex picture yet** can't be matched by picture and fall back to OCR and the AI.
4. **OCR on tiny, glossy or foil text.** Older cards have no set code, and some promos have no total.
5. **CPU contention** on the shared home server. Keep the concurrency cap and build the index at night.
6. **Bigger backend image and slower CI** (ONNX Runtime, OpenCV, models). Bake the models in with checksums rather than downloading them at runtime.
7. **Licences.** DINOv2, SigLIP and PaddleOCR are permissive. DINOv3 and MobileCLIP need checking. YOLO is AGPL, the same as this project.
8. **Upstream drift.** Git-Romer actively changes the scanner, so keep the new code in its own module.
9. **Synthetic tests flatter methods.** Use only real photos for the go/no-go call.

### 3.10 Quick answers to the brief's questions

- **More efficient?** Yes: seconds of local CPU instead of paced cloud calls.
- **More reliable?** Yes where the picture and number agree. On the cases that are hard for everyone (unreadable number, identical art), it is no worse than today, because those still go to the AI or the trainer.
- **Can recognition run on the iPhone offline?** Realistic with iOS 26 and about 50–70 MB of downloads, but second.
- **Does the AI detect variants today?** No. Nothing reliable does from one photo.

### 3.11 What I need from you

1. **Photos with answers.** OK to switch on scanner diagnostics on nonprod, and which trainers will scan the mix above (about 300–400 cards) and confirm them? If diagnostics are already on in prod and trainers agree, those traces can be used too.
2. **The home server's specs:** CPU model and cores, RAM, free disk, GPU or not. And where the benchmark may run: the home server, or the build PC at a time you choose.
3. **Languages:** which languages the server syncs (`TCGDEX_SYNC_LANGUAGES`), and whether Japanese cards matter.
4. **The AI fallback:** keep it (Gemini key), or go fully local, with trainers picking from the top matches when unsure?
5. **Variants:** is automatic holo / reverse holo detection a must, or are better defaults plus a batch toggle enough?
6. **The phone version:** interested in on-device recognition later (Phase 4)?

## 4. Sources

Code and history in this repository: `backend/api/recognize.py`, `backend/api/scan_jobs.py`, `backend/services/scan_queue.py`, `scan_providers.py`, `gemini_rate_limit.py`, `scan_storage.py`, `scan_trace.py`, `card_picture_packs.py`, `frontend/src/components/BatchCameraCapture.jsx`, `UnifiedCardScanner.jsx`, `ScanReview.jsx`, `CardScanner.jsx`, `frontend/src/offline/ops/scanSubmit.js`, `docs/scanner-providers.md`, and `git log` for the scanner files.

Upstream and fork PRs and issues:
- Git-Romer/pokecollector: [#324](https://github.com/Git-Romer/pokecollector/pull/324), [#342](https://github.com/Git-Romer/pokecollector/issues/342), [#378](https://github.com/Git-Romer/pokecollector/pull/378), [#419](https://github.com/Git-Romer/pokecollector/pull/419), [#420](https://github.com/Git-Romer/pokecollector/pull/420), [#421](https://github.com/Git-Romer/pokecollector/pull/421), [#422](https://github.com/Git-Romer/pokecollector/pull/422), [#335](https://github.com/Git-Romer/pokecollector/issues/335), [#282](https://github.com/Git-Romer/pokecollector/issues/282), [#389](https://github.com/Git-Romer/pokecollector/issues/389), [#390](https://github.com/Git-Romer/pokecollector/issues/390), [#425](https://github.com/Git-Romer/pokecollector/issues/425)
- IDEKENTERPRISES/pokecollector: [#58](https://github.com/IDEKENTERPRISES/pokecollector/pull/58), [#60](https://github.com/IDEKENTERPRISES/pokecollector/pull/60)

Papers and projects:
- TCG-AR, real-time multi-view AR for trading card games: <https://arxiv.org/html/2607.02090v1>
- PokVault Rev, on-device visual search for trading cards: <https://didierrlopes.github.io/pokemon-card-scanner-paper>
- Tao2k/cardscanner PR #29 (DINOv3, flattening, pixel check): <https://github.com/Tao2k/cardscanner/pull/29>
- jeffreygoodgood/pokemon-card-scanner: <https://github.com/jeffreygoodgood/pokemon-card-scanner>
- Rarebox v1.4.1: <https://github.com/novaoc/rarebox/releases/tag/v1.4.1>
- 1vcian Pokemon-TCGP-Card-Scanner: <https://github.com/1vcian/Pokemon-TCGP-Card-Scanner>
- LMilazzo/cardexx: <https://github.com/LMilazzo/cardexx>
- rhizonymph/pokemon-card-scanner: <https://github.com/rhizonymph/pokemon-card-scanner>
- jslok/card-scanner (README no longer reachable; known from search summaries): <https://github.com/jslok/card-scanner>
- tmikonen, MTG card detector: <https://tmikonen.github.io/quantitatively/2020-01-01-magic-card-detector>
- mtgscan, OCR plus fuzzy matching: <https://fortierq.github.io/mtgscan-ocr-azure-flask-celery-socketio>
- DINOv2 paper: <https://arxiv.org/abs/2304.07193>
- MobileCLIP paper: <https://arxiv.org/html/2311.17049v2>
- OpenCV 5 DNN CPU benchmarks: <https://github.com/opencv/opencv/wiki/OpenCV-5-DNN-Benchmarks/6fa56ddf498791a95451451d0daa5e2a233b0313>
- PaddleOCR text recognition (sizes, CPU times): <https://www.paddleocr.ai/v3.3.1/en/version3.x/module_usage/text_recognition.html>; PP-OCRv5 benchmark notes: <https://wikidocs.net/441124>
- tesseract.js v5 notes: <https://github.com/naptha/tesseract.js/releases/tag/v5.0.0>

Platforms and services:
- TCGdex image sizes: <https://tcgdex.dev/assets>; card fields and variants: <https://tcgdex.dev/reference/card>
- Gemini pricing: <https://aistudio.google.com/docs/pricing>; rate limits: <https://aistudio.google.com/docs/rate-limits>; image tokens: <https://ai.google.dev/gemini-api/docs/media-resolution>
- Ximilar pricing: <https://www.ximilar.com/pricing/>; recognition docs: <https://docs.ximilar.com/collectibles/recognition>, <https://docs.ximilar.com/services/collectibles_recognition>
- TCGplayer Scan & Identify: <https://help.tcgplayer.com/hc/en-us/articles/27303183354007-How-Quicklist-IdentificationTechnology-Works>
- Pokescope: <https://pokescope.app/blog/how-i-built-pokemon-card-scanner-ai-50000-users/>
- Grimoria scanner: <https://grimoria.app/help/scanner/mobile-app-scanner>
- Dex scanning: <https://dextcg.com/help/collection/scanning-your-cards>
- WebGPU in Safari 26: <https://web.dev/blog/webgpu-supported-major-browsers>, <https://bugs.webkit.org/show_bug.cgi?id=299237>
- ONNX Runtime Web deployment: <https://onnxruntime.ai/docs/tutorials/web/deploy.html>; WebAssembly file size: <https://huggingface.co/janitr/experiments/blob/main/runtime/onnxruntime-web/RUNTIME_INFO.json>; iOS thread caution: <https://www.dynamsoft.com/faq/barcode-reader/web/capabilities/adaptive-wasm-loading.html>
- Shape Detection API: <https://developer.chrome.com/docs/capabilities/shape-detection>
