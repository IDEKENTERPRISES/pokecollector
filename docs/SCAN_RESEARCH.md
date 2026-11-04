# Scanning cards without an LLM: research

Status: research only, nothing built. Written 2026-11-04 against `nonprod` at `f78b2d5`. Revised the same day for the owner's real setup:

- the app runs on the always-on **home lab server**: a Dell PowerEdge T340 with a Xeon E-2126G (6 cores), 32 GB RAM, no GPU, and no disk limit;
- scans are read by **Ollama with `qwen3-vl:4b-instruct` on the gaming PC**, which isn't always on.

## Summary for the owner

**The answer.** Yes. There is a faster and more dependable way, and it is how most dedicated card scanners work: match the *picture* of the card against the pictures of every card we already have from TCGdex, then read the small printed number to make sure. That can run on the home lab server 24/7 on an ordinary CPU, so scanning no longer depends on the gaming PC being on.

**Why today's scanner is slow and shaky.**

- **When the gaming PC is off, nothing gets recognised.** Scans retry, waiting longer each time, up to 6 hours between tries. A scan taken while the PC was off can sit for hours *after* the PC is back on. The trainer only sees "Retrying in 5h 40m", and photos never recognised are deleted after 14 days (§1.3).
- **When it is on, each card costs one or two runs of a 4-billion-parameter vision model on the full ~2048 px photo.** That photo alone is about 2,300–3,100 of the model's image tokens. The backend sends up to three scans at once, but Ollama works on one at a time by default, and the default wait is 30 s, so queued scans time out and start over. When the read isn't clear, a second run checks it with about 13 images, which can overflow Ollama's default 4,096-token context (§1.2).
- **A small vision model is weakest exactly where cards need precision.** Tiny collector numbers, set symbols, holo variants. A 2026 study that probed this very model family found general vision models tend to "fix" short, imperfect text into something plausible, where classic OCR copies it faithfully (§1.5).
- **The server searches by the name the model read.** One misread letter or a translated name sends it the wrong way. Most scanner fixes this year were for that.
- **The picture check the server already has hashes the whole photo**, background included. In a small test it picked the wrong card more often than the right one; hashing the flattened card got 106 of 108 right.

**What I recommend.** On the home lab server: **find the card → match its picture → read the number → Ollama only if still unsure, and only if the gaming PC is reachable**:

1. Find the card in the photo and flatten it. The trainer already lines it up with the yellow guide.
2. Compare it with a "picture index" of every card, made once from the pictures the server already caches.
3. Read the collector number (e.g. "125/197"), and the set code where there is one.
4. If picture and number agree on one printing, it's done. If not, and the gaming PC answers, Ollama gets one look at the flattened card. If the PC is off, the scan goes straight to the Scan inbox with the best picture matches for the trainer to pick, instead of waiting for hours.

No GPU, no paid service, no change for trainers: same camera, queue, offline outbox, inbox and review. Separately, cheap fixes to today's Ollama path are worth doing first (§3.8, Phase 0), because Ollama stays the fallback.

**Expected gain.** These are estimates until the benchmark below is run on our own photos:

- **Availability:** recognition works whenever the home lab server is up, not only when the gaming PC is.
- **Speed:** about 0.25–0.9 seconds per card on the home lab server's Xeon E-2126G using half its cores (extrapolated, §3.3). Today it's seconds to minutes when the PC is on, and hours when it's off.
- **Ollama use:** roughly 70–85% fewer calls, and those few on a small flattened card instead of the full photo.
- **Accuracy:** at least as good where the number is readable, because picture and number check each other. Mostly better on cards whose names the model misreads or translates.
- **Variants:** holo / reverse holo / 1st Edition stay a choice in the Add sheet, as today. The model doesn't detect them now, and nothing does that reliably from one photo. Smarter pre-filling is possible (§2.4).
- **Machine load:** on the PowerEdge T340, at most 3 of its 6 cores for under a second per card, and about 0.5–1.3 GB of RAM per stack out of 32 GB. That replaces GPU time on a PC that has to be switched on. Disk isn't a concern.

**Later, on the iPhone:** the same matcher could run on the phone itself (iOS 26, about 50–70 MB to download once). That would need neither machine and would work offline. It's worth doing second, reusing the server's model and index (§3.7).

**What it needs from you:** a set of real scans with confirmed answers to test on, how busy the home lab server gets, a few facts about the gaming PC's Ollama, and a few decisions (§3.11). The server's specs are in; the sizing is in §3.3. The first step is a benchmark script that changes nothing in the app (§3.8).

**Confidence:** high that a home-lab matcher removes the dependence on the gaming PC and is much faster. Medium-high that it needs far fewer model calls. Medium on the exact accuracy numbers, because no one has published a solid test on photos like ours. A benchmark on about 300 of our trainers' own scans would settle it, and it compares today's Ollama path, a tuned Ollama path and the new matcher on the same photos.

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
| Queue | Fair per-user claiming with leases. At most 3 scans are processed at once. Photos allowed to group are combined 2–4 at a time into one labelled composite image, so one model call reads several cards. Retries: 2/10/30 s for recognition errors, 30 s up to 6 h for transient ones (an unreachable endpoint counts as transient), and the provider's own reset time for rate limits. | `backend/services/scan_queue.py`, `backend/services/card_composite.py` |
| Model read | One call with `RECOGNIZE_PROMPT`: name (printed and English), number and total, set code, regulation mark, type, HP, language, artist, returned as JSON. Composites use `COMPOSITE_PROMPT`. | `backend/api/recognize.py` (`_recognize_with_provider`, `recognize_composite_card_info`) |
| Providers | Gemini, or any OpenAI-compatible server. **This deploy uses Ollama** through that path (§1.2). Per-user settings, or one admin setup for everyone (`SCANNER_GLOBAL_CONFIG=true`). There is a capability test (two images in one request) and an opt-in Gemini fallback for unsure answers. Gemini-only pacing: `GEMINI_RATE_PER_MIN` defaults to 6. | `backend/services/scan_providers.py`, `gemini_rate_limit.py`, `provider_rate_limit.py`, `docs/scanner-providers.md` |
| Match | The **name** is searched in the local card table, across separator and qualifier variants, plus an English fallback using the model's translation. If nothing local has the read number, live TCGdex is searched instead (at most 12 requests or 30 s per scan). Digital (TCG Pocket) printings are excluded. Candidates are ranked by number → language → printed total → set code → regulation mark → artist → HP. A decision is made only when this metadata isolates one printing. | `recognize.py` (`_search_and_rank_candidates`, `_candidate_rank_key`, `_metadata_decision`) |
| Picture check | If still undecided: download up to 8 candidate pictures **from the TCGdex CDN**, and compare a 64-bit pHash of the **whole photo** with each (accepted when the distance is ≤ 20 and the lead is ≥ 5). If that fails, a second model call shows the photo plus about 12 candidate pictures and asks for a number (visual verification). | `recognize.py` (`_phash_best_match`, `match_card_info`) |
| Inbox and review | Results land in the Scan inbox: matches as a grid with a "printed total doesn't match" badge, and a linked zoom comparison. The trainer picks a candidate. The Add sheet sets variant (pre-filled from the catalogue's available variants), language (pre-filled from the model's guess), condition and so on. `resolve-and-add` adds the card atomically, deletes the photo and records the confirmed card as ground truth. | `frontend/src/pages/ScanQueue.jsx`, `components/ScanReview.jsx`, `components/CardScanner.jsx` (`ScanAddModal`), `scan_jobs.py` |
| Diagnostics | Opt-in per user, and only when the server sets `SCAN_TRACE_DIR`. One JSON per attempt: the sanitized photo, model output, candidates, pHash outcome, decision, and later the confirmed answer and its rank. `backend/scripts/analyse_scan_traces.py` prints top-1 accuracy, decision mechanism and null rates. **This is a ready-made benchmark dataset** if diagnostics are switched on. | `backend/services/scan_trace.py`, `backend/scripts/analyse_scan_traces.py` |

### 1.2 This deploy: Ollama with qwen3-vl:4b on the gaming PC

How the code drives it (`backend/services/scan_providers.py`, `ScanProvider.generate_text` and `post_openai_chat`):

- **Request.** `POST <OPENAI_BASE_URL>/chat/completions` with only `model` and `messages`. That's the prompt text plus the photo as a base64 data URL. No `temperature`, `max_tokens` or `response_format`, so Ollama's model defaults apply. The JSON is pulled out of free text with a regex; a malformed answer becomes "Erkennung fehlgeschlagen" and a recognition retry. Ollama's compatible endpoint does accept `response_format`, `temperature`, `max_tokens` and `seed`, but not `num_ctx` ([Ollama docs](https://docs.ollama.com/api/openai-compatibility)).
- **Image size.** The full photo, at up to 2048 px on the long side, is sent as is. Qwen3-VL turns every 32×32-pixel block into one image token ([processor source](https://docs.rs/crate/llm-multimodal/1.7.0/source/src/vision/processors/qwen3_vl.rs)). Ollama's default cap is 16.7 megapixels ([Ollama source](https://github.com/ollama/ollama/blob/main/compatmigrate/qwen3vl.go)), so nothing is shrunk. A 1152×2048 or 1536×2048 photo is about **2,300–3,100 image tokens**, plus about 650 prompt tokens. The card itself fills only about a quarter to a third of that area.
- **Context.** Ollama's default context is 4,096 tokens ([FAQ](https://docs.ollama.com/faq)). One read fits, just. Visual verification adds up to about 12 candidate pictures at roughly 90 tokens each, about 3,700–4,500 tokens in total. That's at or over the limit before the answer is written. I didn't verify whether Ollama then truncates or errors; either way that answer is unreliable. The context can only be raised server-side (`OLLAMA_CONTEXT_LENGTH`) or in a Modelfile.
- **Timeouts and retries.** A per-provider response timeout of 30 (default), 60, 120 or 180 s. Within one try, 3 attempts with 1 s and 2 s pauses on connection errors and 5xx. Then the queue's transient backoff: 30 s, 2 min, 10 min, 30 min, 1 h, then every 6 h. Recognition errors (bad JSON) get 2/10/30 s, then the scan fails. Non-Gemini providers have no pacing, only a shared block after a 429.
- **Concurrency.** The backend runs up to 3 scans at once (`MAX_CONCURRENT_SCAN_PROCESSING`). Ollama runs **1 request per model at a time** by default and queues the rest (`OLLAMA_NUM_PARALLEL`, [FAQ](https://docs.ollama.com/faq)). The second and third scans therefore spend their 30 s waiting in Ollama's queue. When a read takes more than 10–15 s, they time out and start over. That's likely part of the "a minute per card".
- **Warm-up.** Ollama unloads a model after 5 idle minutes by default (`OLLAMA_KEEP_ALIVE`). The first scan after a pause also waits for the 3.3 GB model to load ([tags](https://ollama.com/library/qwen3-vl/tags)).
- **Composites.** If the capability test passed with two images, grouped photos are shrunk into 640×896 cells of one image. A card then spans only about 350–400 px, so its collector number is under 10 px tall, well under one image token (my estimate from the layout). The model often returns no number, the group falls back to one call per photo, and the composite was wasted work.
- **Fallback.** The opt-in Gemini fallback runs only after an *unsure answer*, never when Ollama can't be reached.
- **Where it runs, CPU or GPU.** The code has no hints. `OPENAI_BASE_URL` and the model are set in the Portainer stack, not the repo, and the code doesn't care what hardware answers. A gaming PC suggests a GPU, but Ollama falls back to the CPU, fully or partly, when the GPU's memory is taken, for example by a running game. `ollama ps` shows which (`PROCESSOR` column). See the questions in §3.11.

### 1.3 When the gaming PC is off

From `post_openai_chat`, `scan_queue.py` and `ScanReview.jsx`:

1. **Each try.** The backend tries to connect three times. That takes a few seconds if the network answers "host unreachable", and up to about 1.5 minutes if connections just hang until the 30 s timeout. All the while it holds one of the 3 processing slots.
2. **After the try fails.** The scan is marked *retrying* with "The scanner endpoint could not be reached", counted as transient. It is retried after 30 s, 2 min, 10 min, 30 min and 1 h, then **every 6 hours**. A scan uploaded while the PC was off reaches the 6-hour step after about 1 h 45 min. If the PC then comes on, the scan still waits up to 6 hours for its next try.
3. **What the trainer sees.** A spinner with "Retrying in 5h 40m", without the reason; the error text only shows once a scan has failed. There's no "Try now" button for a retrying scan: the Retry button and `POST …/retry` only work on done or failed scans.
4. **Nothing else steps in.** Every photo goes through the same chain on its own, since no shared "endpoint down" state exists for connection errors. The Gemini fallback doesn't help either, because it only runs after an answer.
5. **After 14 days.** Jobs are deleted with their photos at `expires_at`, so scans the PC never saw in that time are lost. That's an edge case, but silent.

### 1.4 Where the time goes

Roughly in order of size:

1. **Waiting for the gaming PC** when it's off or asleep (§1.3). That's hours.
2. **Model time per call.** I estimate a few seconds to tens of seconds per read on a gaming GPU, and minutes on a CPU; not measured, because the traces don't record call times. Most of it is turning about 3,000 image tokens of a 3-megapixel photo into features. On a CPU that step alone can take tens of seconds for models of this kind ([llama.cpp issue](https://github.com/ggml-org/llama.cpp/issues/22582)). The visual-verification call adds another long call with 13 images.
3. **Self-inflicted timeouts:** three scans in flight against an Ollama that serves one, with a 30 s default timeout (§1.2). Plus model reloads after 5 idle minutes.
4. **Network lookups during matching.** Live TCGdex searches when the local catalogue lacks the number (up to 30 s). TCGdex detail fetches for missing totals or artists (8 s timeout). Candidate pictures downloaded from the CDN (5 s each, in parallel), even though the server already caches small pictures of every card (`backend/services/card_picture_packs.py`).

### 1.5 Where it fails, and what a 4B vision model gets wrong

From the code, the git log and the PR history:

- **Wrong card from a misread or mistranslated name.** Search starts from the name the model read. Generic Energy names ("Basic Energy"), hyphens and spaces ("Ho-Oh"), qualifiers ("Boss's Orders (Giovanni)"), vintage and non-English names have each needed fixes. See upstream [#378](https://github.com/Git-Romer/pokecollector/pull/378), [#421](https://github.com/Git-Romer/pokecollector/pull/421) and [#324](https://github.com/Git-Romer/pokecollector/pull/324). The English fallback uses the model's *translation*.
- **Wrong set or number.** The small print gets misread or dropped: gallery prefixes like TG/GG/SV ([#419](https://github.com/Git-Romer/pokecollector/pull/419), issue [#335](https://github.com/Git-Romer/pokecollector/issues/335)), "No. 0094" Pokédex numbers taken as the collector number (now a prompt rule), totals printed with a prefix. Reprints sharing a number need the set code or total, which often comes back null.
- **Wrong picture pick.** Visual verification once trusted picks of candidates the model never saw ([#422](https://github.com/Git-Romer/pokecollector/pull/422)). An upstream contributor measured that Gemini's visual pick decided **0 of 290** recorded scans (closed PR [#324](https://github.com/Git-Romer/pokecollector/pull/324), August 2026; the code has changed since).
- **The pHash step hashes the whole photo.** See §1.7: in a synthetic test it chose wrong more often than right. It only rejects a pick that contradicts the read metadata, and it runs exactly when the metadata was too thin to decide.
- **Digital cards offered for a photo:** fixed in [#420](https://github.com/Git-Romer/pokecollector/pull/420).
- **Several cards:** handled by combining separate photos into a composite. A single photo with several cards isn't supported; the prompt reads "this card".
- **Rotation:** an upside-down card returned an empty name, and the model couldn't report orientation: 0 of 18 in upstream #324's tests.
- **Provider trouble:** an unreachable endpoint (§1.3), models renamed or removed (issue [#282](https://github.com/Git-Romer/pokecollector/issues/282)), capability tests with images too small for some providers (issue [#425](https://github.com/Git-Romer/pokecollector/issues/425)), TCGdex outages ([#389](https://github.com/Git-Romer/pokecollector/issues/389), [#390](https://github.com/Git-Romer/pokecollector/issues/390)). On this fork, F8 ([#58](https://github.com/IDEKENTERPRISES/pokecollector/pull/58)) added the global scanner setup, and F9 ([#60](https://github.com/IDEKENTERPRISES/pokecollector/pull/60)) fixed issues the owner found when testing it on the iPhone.

**What a 4B vision model is likely to get wrong on card photos, and why:**

- **The collector number and other small print.** On a card that fills the guide in a 2048 px photo, the card is about 650–875 px wide, roughly 10–14 px per millimetre. So the number is roughly 15–25 px tall, less than one row of Qwen3-VL's 32 px image tokens. "125/197" is squeezed into a handful of tokens, before any glare, blur, foil or sleeve shine. In a composite it is smaller than a token (§1.2).
- **It rewrites what it can't read.** General vision models tend to "fix" imperfect short text into something plausible instead of copying it, and short words were rewritten most ([Do VLMs Read or Rewrite?, 2026](https://arxiv.org/abs/2607.21617)). That study probed Qwen3-VL-4B itself. Traditional OCR stayed almost unaffected by the same distortions. So for a collector number, a small model risks a confident, plausible, wrong digit ("128" for "125"), and the prompt's "return null if unclear" can't help when the model doesn't know it guessed. A wrong number is worse than none: the ranker then puts a wrong printing first.
- **Benchmarks don't capture this.** Qwen3-VL-4B scores well on document benchmarks: about 873/1000 on OCRBench and about 95 on DocVQA in one independent evaluation ([Qianfan-OCR](https://arxiv.org/abs/2603.13398)). The 8B model is a few points higher in third-party comparisons ([Codersera](https://codersera.com/blog/qwen3-vl-4b-vs-qwen3-vl-8b-benchmarks-vram-guide/), unverified). Those tests use flat, sharp documents, not 1.5 mm print on a glossy card photographed at an angle. The default `qwen3-vl:4b-instruct` tag is 4-bit quantised (3.3 GB); I found no measurement of what that costs in reading accuracy.
- **Set symbols.** Older cards show only a small icon, no set code. Matching about 150 icons to sets is specialist knowledge, and the prompt rightly forbids guessing. So on older cards there's no set code to break ties between reprints.
- **Names in other languages.** The model must also produce an English translation (`name_en`) for the fallback search. A mistranslated German or Japanese name searches for the wrong card.
- **Japanese cards.** Qwen models are generally strong in CJK scripts. The bigger problem is the catalogue: Japanese cards can only be matched if the server syncs `ja` (the default is `en,de`). Japanese cards also print rarity codes next to the number (verify on real cards), so the number pattern differs.
- **Variants.** The model isn't asked, and couldn't reliably tell from one photo anyway: foil often barely shows under room light. No scanner I found claims a measured holo or reverse-holo detection rate (§2.4).
- **Inconsistency.** No `temperature` is sent, so Ollama's model defaults apply. A retry of the same photo can give a different answer. That's an inference; the Modelfile defaults weren't checked.

### 1.6 Costs and machine load in this deploy

- **No per-scan fee.** The cost is machine time and waiting:
  - **The gaming PC must be on**, with about 3.3 GB of model weights plus context and vision buffers in GPU memory: roughly 4–5 GB VRAM while the model stays loaded (estimate). Tens of GPU-seconds or CPU-minutes per card, up to twice per card.
  - **The home lab server** does only the light work today: uploads, the queue, the database search.
- **If Gemini is used instead** (other installs): Flash is listed at $0.75 per million input tokens until 31 Dec 2026, then $1.50 ([pricing](https://aistudio.google.com/docs/pricing)). That's roughly $0.001–0.03 per scan (estimate), with per-project quotas shown only in AI Studio ([rate limits](https://aistudio.google.com/docs/rate-limits)), and photos go to Google.

### 1.7 A tiny proof: the pHash step as it is today

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

Every method below works far better on a flattened card than on a raw photo. That includes the vision model (§2.7). Options:

- **Edges and contours** (OpenCV): threshold or edge-detect, find the largest four-sided shape, then a perspective warp. This is what tmikonen's MTG detector ([write-up](https://tmikonen.github.io/quantitatively/2020-01-01-magic-card-detector)), rhizonymph's Pokémon scanner ([repo](https://github.com/rhizonymph/pokemon-card-scanner)) and the PokVault paper ([paper](https://didierrlopes.github.io/pokemon-card-scanner-paper)) do. PokVault combines several fallbacks: contours, Hough lines, a saturation mask and a manual crop. Reported weak spots: overlapping cards, hard lighting, too much or too little border. Sleeves and top-loaders add their own edges. Our yellow guide helps here: we know roughly where the card is and how big it is, so the search can be limited to that area.
- **A small trained detector** (YOLO-style with oriented boxes or segmentation), trained on synthetic composites of card pictures over random backgrounds. 1vcian's scanner reports box mAP50 of 98.5% on its synthetic validation set ([repo](https://github.com/1vcian/Pokemon-TCGP-Card-Scanner)). jeffreygoodgood trained one on 4,500 synthetic images; Pokescope uses YOLOv8 ([blog](https://pokescope.app/blog/how-i-built-pokemon-card-scanner-ai-50000-users/)). Licence note: Ultralytics YOLO is AGPL-3.0. That fits this project, which is also AGPL-3.0, but it is worth knowing.
- **Orientation:** a flattened card is portrait, which leaves only upright versus upside down. Embedding both rotations, or a tiny classifier as in TCG-AR ([arXiv 2607.02090](https://arxiv.org/html/2607.02090v1)), settles it cheaply.
- **Several cards in one photo:** a detector or contour pass returns every card. Each is then flattened and matched separately. This would replace the composite trick, which exists only to save model calls. Each card would need its own inbox item, a small queue change.
- **Apple's Vision rectangle and text detection** isn't available to a web app. Safari doesn't expose it to JavaScript, and the Shape Detection API's text detector isn't shipped in Safari (unverified; it is still listed as in progress in [Chrome's docs](https://developer.chrome.com/docs/capabilities/shape-detection)).

### 2.2 Matching the picture against the catalogue

About 30k cards across the synced languages; TCGdex pictures are 245×337 ("low") or 600×825 ("high") ([TCGdex assets](https://tcgdex.dev/assets)).

| Method | Real phone photos (evidence) | Index size, ~30k cards | CPU per photo | Reprints, languages, promos |
| --- | --- | --- | --- | --- |
| **Perceptual hashes** (pHash, dHash, colour hash) on the flattened card | Good on clean, flat crops; brittle with glare, foil and sleeves (PokVault's view; Moss Machine and mtg-detector note lighting sensitivity). Collisions grow with the catalogue: jslok needed longer, combined hashes at ~20k cards ([repo](https://github.com/jslok/card-scanner), as summarised by search; the README is now offline). Upstream #324 measured a phash + dhash + colour-hash mix at **96.9%** when choosing among a few same-name candidates (64 real cards). | ~0.5–1 MB | < 5 ms, search < 1 ms | Same artwork gives the same hash: can't separate reprints or same-art languages; promo stamps are too small. |
| **Local features** (ORB/SIFT keypoints plus a homography check) | Robust to angle and partial cover. Best as a checker for a handful of candidates: upstream #324 measured SIFT at **98.4%** against 96.9% for hashes on the same 64 cards. Searching all cards this way needs extra machinery (visual words). | ~500 keypoints × 32 B per card ≈ 0.5 GB for all cards | 10–50 ms per candidate pair (estimate) | Partly: at full resolution it can see differing text, symbols and stamps. |
| **Learned embeddings** (DINOv2, CLIP, SigLIP, MobileCLIP, or a fine-tuned CNN) plus nearest-neighbour search | The best evidence for searching the whole catalogue. TCG-AR: about 20k Pokémon cards, 636 real crops, ResNet-50 trained with ArcFace on synthetic augmentations: **85.1% top-1, 96.2% top-5**, and 96.4% top-1 when limited to 631 deck cards. Most errors were near-identical prints. Tao2k's scanner: flattened card, small DINOv2/DINOv3 model, plus a pixel check of the top 8: **90–94% top-1** on 400 synthetic phone photos, against 69% before flattening ([PR #29](https://github.com/Tao2k/cardscanner/pull/29)). Off-the-shelf larger models scored worse in that test, so model choice must be benchmarked. Without detection: unusable (jeffreygoodgood). | 384 numbers per card: 23 MB at 16-bit, 12 MB at 8-bit. PokVault stores CLIP at 516 B per card: 9.2 MB for 17,531 cards. | ViT-S ≈ 10–40 ms, ViT-B ≈ 35–150 ms on a desktop CPU; ViT-B/16 runs 36–70 ms on i9/i7 CPUs with ONNX Runtime ([OpenCV DNN benchmarks](https://github.com/opencv/opencv/wiki/OpenCV-5-DNN-Benchmarks/6fa56ddf498791a95451451d0daa5e2a233b0313)). On the home lab server's Xeon E-2126G with 3 threads, the embedding takes about 40–250 ms (extrapolated, §3.3). Search: one matrix multiply, < 10 ms. | Weak: same art gives near-identical vectors, and same-art languages can't be told apart reliably. Needs the number check below. |

What this means for us: picture matching should *propose* a short list (top 20) from the whole catalogue, and the printed number should *confirm* one of them. Embeddings are the right search tool at 30k cards. Hashes and keypoints are fine as cheap extra checks on the short list. DINOv2 is generally stronger than CLIP for exact-instance retrieval ([DINOv2 paper](https://arxiv.org/abs/2304.07193)), but the Tao2k results show it has to be measured on our photos. No vector database is needed: 30k × 384 numbers fit in memory, and Postgres here is the plain `postgres:18-alpine` image without pgvector.

Licences: DINOv2 is Apache-2.0, SigLIP Apache-2.0, OpenAI CLIP MIT. DINOv3 and Apple's MobileCLIP have their own licences, which need checking before use (unverified).

### 2.3 Reading the printed identifiers (OCR)

- **What to read:** the collector number and total ("125/197", "TG06/TG30", "SWSH001"). On modern cards, also the set code and the language code printed beside the number (e.g. "SVI EN"; verify on real cards), and the regulation mark. "HP" or "KP" (German) is a language hint. The number sits bottom-left on recent cards and bottom-right on older ones, so read both corners of the flattened card. Flatten those strips at the photo's own scale, about 10–14 px per millimetre after the server's 2048 px resize, not from a small flattened card: the text is only a millimetre or two high. If OCR struggles, keep more resolution for scan photos; the server currently shrinks them to 2048 px (`MAX_IMAGE_EDGE` in `scan_storage.py`).
- **Engines:**
  - **PaddleOCR PP-OCRv5 mobile:** detector 4.8 MB, recogniser about 7.5–16 MB depending on version and language. About 21 ms per text line on CPU in the official tables ([docs](https://www.paddleocr.ai/v3.3.1/en/version3.x/module_usage/text_recognition.html); [sizes](https://wikidocs.net/441124)). It runs on ONNX Runtime through community exports.
  - **Tesseract:** Apache-2.0, about 2–10 MB of English data ([tesseract.js](https://github.com/naptha/tesseract.js/releases/tag/v5.0.0)). Weak on card text in mtgscan's tests, where cloud OCR did better ([write-up](https://fortierq.github.io/mtgscan-ocr-azure-flask-celery-socketio)).
  - **Apple's Vision OCR:** not reachable from a web app.
- **Why classic OCR here, not the vision model.** A dedicated OCR model transcribes what it sees instead of "fixing" it (the rewrite study in §1.5). And we check its output against 20 known candidates, so a misread digit doesn't silently pick a wrong card.
- **Fuzzy matching:** mtgscan matches OCR text to the card list by edit distance (SymSpell) and reports about a 10% error rate per decklist image. For us the number is better than the name: a small regular pattern checked against the 20 picture candidates, not the whole catalogue. The existing ranker and decision rules (`_candidate_rank_key`, `_metadata_decision`) already do this from the model's fields. They can take OCR's fields instead.
- **No published accuracy** for reading Pokémon collector numbers from phone photos was found. Benchmark it.

### 2.4 Variants, languages, reprints and promos

- **Holo / reverse holo / 1st Edition.** TCGdex lists which variants a card exists in (`variants.normal / reverse / holo / firstEdition`, [card reference](https://tcgdex.dev/reference/card)) but has one picture per card. So no picture method can learn the difference from our references.
  - *Today:* the model isn't asked; the trainer chooses in the Add sheet.
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
- **Verdict.** Realistic. It's the only option that works with both the home lab server and the gaming PC out of reach, and while the phone is offline. It means a second code path to build and test on real iPhones. The fair comparison is in §3.7.

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
| [Roboflow tutorial](https://blog.roboflow.com/trading-card-inventory-management/) | A detector crops the card first, then a vision model reads it and the result is checked against a database | Detector metrics only. It shows the "crop before the model reads" idea in §2.7. |
| Grimoria, Dex, Delver Lens, Collectr | Grimoria: hash database downloaded, matched on the device. Others undocumented. | Variant and language chosen by the user or by batch defaults (Grimoria, Dex). Collectr's holo handling is a common complaint (third-party summary, unverified). |

The pattern across the field: **detect and flatten → picture search → read the number to break ties → user confirms variant**. Nobody serious relies on a general chat model to read each card.

### 2.7 Or tune the Ollama path instead?

The cheapest alternative is to keep the model as the reader and fix how it's used. The options, and what each buys:

| Option | Speed per card | Works when the gaming PC is off | Accuracy effect | Machine cost |
| --- | --- | --- | --- | --- |
| **Today** (4B, full photo, visual verification, 3 at once) | GPU: several s to tens of s; CPU: minutes; plus timeouts (estimates) | **No.** Waits up to 6 h per retry. | Baseline | Gaming PC on; ~4–5 GB VRAM while loaded |
| **Preprocess:** crop to the flattened card, about 1024 px long side (~1,000 image tokens instead of ~3,000), plus the number strip as a second small, sharp image | About 2–4× less image work per call (estimate) | No | Likely better number reads: the text is bigger relative to the image, and everything fits the 4k context | Less GPU time |
| **Structured output:** `response_format` JSON schema, `temperature` 0, `max_tokens`; ask only the deciding fields (name, number, total, set code, language) | Fewer output tokens: about 1–2 s saved on GPU, more on CPU (estimate) | No | No more broken JSON or answers that change between retries; reading accuracy unchanged | None |
| **Stop visual verification on the local model**, or cap it at 4–6 candidates; use local picture checks instead | Removes the slowest call | No | Removes a step that decided 0 of 290 scans upstream and likely overflows the context | Less GPU time |
| **Match Ollama's capacity:** 1 scan at a time for a local endpoint (or `OLLAMA_NUM_PARALLEL=3` if VRAM allows), a 60–120 s timeout, longer `OLLAMA_KEEP_ALIVE`, `OLLAMA_CONTEXT_LENGTH=8192` | Ends self-inflicted timeouts and reloads | No | None directly | A little more VRAM held |
| **Bigger model:** `qwen3-vl:8b` (6.2 GB) or `30b-a3b` (20 GB) ([tags](https://ollama.com/library/qwen3-vl/tags)) | 8B about 1.5–2× slower than 4B (estimate); 30B needs a 24 GB-class GPU | No | A few points better on document benchmarks; the rewrite habit remains | ~7–9 GB VRAM for 8B; may not fit while gaming |
| **The same VLM on the home lab CPU** (Xeon E-2126G) instead of the gaming PC | About 30–60 s per cropped card, 1–3 min for the full photo (extrapolated) | Yes | Same weaknesses as today | All 6 cores busy for that time on the box that also serves prod; ~5–6 GB RAM |
| **Recommended: picture match + OCR on the home lab server** | About 0.25–0.9 s on the E-2126G with 3 threads (extrapolated, §3.3) | **Yes, 24/7** | Picture and number cross-check; same-name printings separated without reading the name; OCR doesn't rewrite | Half the cores for under a second; 0.5–1.3 GB RAM per stack; no GPU |

**Which wins.** The home-lab matcher wins outright on the thing that hurts most, **availability**: it works whenever the server is up, while every Ollama option still fails when the gaming PC is off.

- **Speed:** with the PC on, it's about 3–10× faster than a well-tuned GPU Ollama, about 10–40× faster than today's GPU path, and over 100× faster than running the VLM on the T340's CPU (all estimates).
- **Machine cost:** half the T340's cores for under a second, against GPU time on a PC that must be switched on.
- **Accuracy:** unknown until measured. The benchmark (§3.8) runs today's path, the tuned Ollama path and the new matcher on the same photos.

**Tuning Ollama is still worth doing, and first.** It costs days, not weeks; it fixes today's timeouts, broken JSON and context overflow; and Ollama stays the fallback for the cards the matcher can't settle. The cropped photo it needs comes from the same card finder.

## 3. Recommendation

### 3.1 The pipeline

All on the home lab server:

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
  │      ├─ one printing agrees → done (no model call)    │
  │      └─ unsure ─────────────────────────────────────┤
  └─ 5. Ollama fallback, only if the gaming PC answers a quick check (about 2 s, cached for a minute):
         ├─ reachable → one tuned call on the flattened card + number strip (§2.7);
         │              its fields go through the same rules, with the picture top 20 as candidates
         └─ not reachable → no hours of retrying: the scan lands in the inbox now with the
                            picture top matches ("pick the card"); optionally an automatic
                            second opinion runs once the PC is back, if the trainer hasn't picked yet
```

Then, as today: the inbox, the review grid, the Add sheet (variant and language pre-filled better, see §2.4), and ground truth recorded on add.

Build it as a separate module (for example `backend/services/card_match/`) and a scanner mode, so `recognize.py` changes little and upstream merges stay easy.

### 3.2 Expected accuracy and speed

These are estimates from §2's evidence, and the benchmark replaces them:

- **Right printing among the top 20 picture matches:** about 95–99% for cards that have a TCGdex picture. TCG-AR's top-5 was 96% from distant board crops; ours are close-ups.
- **Decided without a model:** about 70–85% of scans, with ≥ 98% of those right. The bar is set when the thresholds are picked.
- **The rest** go to Ollama when the PC is on, or to the trainer.
- **Time per photo** on the home lab server's Xeon E-2126G with 3 threads (extrapolated; §3.3 has the breakdown):
  - about 0.25–0.5 s with a small model, about 0.4–0.9 s with a base model;
  - results appear seconds after upload, day and night;
  - fallback calls add Ollama's time, but on a card-sized image.

### 3.3 Sized for the home lab server (Dell PowerEdge T340)

**The machine:** Xeon E-2126G (Coffee Lake, 6 cores / 6 threads, 3.3 GHz base, AVX2, no AVX-512), 32 GB RAM, no dedicated GPU, disk not a constraint. It already runs the PokéCollector prod stack, the nonprod stack and other home lab services. So the matcher should take **at most 3 of the 6 cores**, ONNX Runtime and OpenCV limited to 3 threads, and **about 1.5–2 GB of RAM per stack**.

**Per-card time on this CPU**, with 3 threads.

> These are extrapolated, not measured: from model sizes, published CPU benchmarks (ViT-B/16 at 36–70 ms on desktop i9/i7 CPUs with ONNX Runtime and all cores, [OpenCV DNN benchmarks](https://github.com/opencv/opencv/wiki/OpenCV-5-DNN-Benchmarks/6fa56ddf498791a95451451d0daa5e2a233b0313); PaddleOCR's mobile recogniser at about 21 ms per text line, [docs](https://www.paddleocr.ai/v3.3.1/en/version3.x/module_usage/text_recognition.html)), and the E-2126G's speed. Phase 1 measures the real numbers.

| Stage | Small model (DINOv2 ViT-S/14, MobileCLIP) | Base model (DINOv2 ViT-B/14, SigLIP-B/16, CLIP ViT-B/16) |
| --- | --- | --- |
| Decode the photo, find and flatten the card (OpenCV) | 40–80 ms | 40–80 ms |
| Embed the flat card (0° and 180°) | 80–150 ms | 250–500 ms |
| Search the index (30k cards; even 150k) | < 10 ms | < 20 ms |
| Pixel check of the top 8 | 10–30 ms | 10–30 ms |
| OCR of the two bottom strips (PaddleOCR mobile) | 100–250 ms | 100–250 ms |
| **Total per card** | **about 0.25–0.5 s** | **about 0.4–0.9 s** |
| A batch of 20 cards, 3 at a time | about 2–4 s | about 3–7 s |

Embedding only the upright side, once the OCR strip shows which way up the card is, saves about half of the embed time.

**RAM (resident, per stack):**

| Item | Small model | Base model |
| --- | --- | --- |
| ONNX Runtime plus embedding model (32-bit) | 150–250 MB | 400–700 MB |
| OCR models (PaddleOCR mobile) | 100–200 MB | 100–200 MB |
| OpenCV and image buffers for 3 scans at once | 150–300 MB | 150–300 MB |
| Picture index, ~30k cards (en, de), 32-bit | 46 MB (384 numbers per card) | 92 MB (768 numbers per card) |
| Each further ~30k cards (more languages) | +46 MB | +92 MB |
| **Peak extra** | **about 0.5–0.8 GB** | **about 0.8–1.3 GB** |

Even every TCGdex language would only add some hundreds of MB of index (the total card count is unverified), and pictures shared across languages (`image_source_lang`) need embedding only once. With 32 GB, running a matcher in both prod and nonprod, about 1–2.5 GB together, is comfortable.

**Disk (unconstrained, so be generous):**

- keep several models side by side, about 0.1–1 GB each, for A/B tests and quick rollback;
- keep one index per model, tens to hundreds of MB;
- cache the **high-resolution** TCGdex pictures (600×825) for every synced language, roughly 2–3 GB per 30k cards (estimate). That gives better pixel checks and room to try larger input sizes.

**Index build on this CPU** (3 threads, at night, at low priority):

- a small model: about 15–30 min per 30k pictures;
- a base model: about 1–2 hours;
- a new set (about 200 cards): under a minute;
- syncing more languages multiplies these one-off times, not the per-scan time.

**Where it runs:**

- **Start:** inside the backend container, with thread caps.
- **If CPU contention shows up:** move it to a small sidecar container per stack, with Compose `cpus: "3"` and `mem_limit: 2g`. That also keeps ONNX Runtime and OpenCV out of the main backend image.

**The integrated graphics (UHD P630) won't help:**

- Dell documents the T340's video as a Matrox G200 on iDRAC9 ([tech guide](https://cdn.shopify.com/s/files/1/0593/9249/1689/files/dell-emc-poweredge-t340-tech-guide.pdf)).
- A user report says the board has no support for the CPU's own graphics ([Dell community](https://www.dell.com/community/en/conversations/poweredge-hardware-general/t340-graphic-card-update/647f8ee5f4ccf8a8defdcf37)), so it's probably disabled (unverified; `ls /dev/dri` on the host would show it).
- Even if it were usable, OpenVINO supports this generation ([GPU plugin](https://docs.openvino.ai/latest/openvino_docs_OV_UG_supported_plugins_GPU.html)), but a small integrated GPU wouldn't beat 3–6 AVX2 cores by enough to be worth the passthrough. Plan on the CPU only.

**Not recommended on this box: running the vision model here as an always-on fallback.**

- `qwen3-vl:4b` (q4, 3.3 GB) would need about 5–6 GB of RAM, which is affordable.
- But on 6 AVX2 cores I'd expect about 30–60 s per call on a cropped card, and 1–3 min on today's full photo, with all cores busy (extrapolated from CPU image-encoding reports such as the [llama.cpp issue](https://github.com/ggml-org/llama.cpp/issues/22582); not measured).
- At most, it could be a "night shift" option for the few unsure scans while the gaming PC is off.

**With a GPU in the home lab box** (not needed): about 0.05 s per card, room for bigger models, and Ollama could move there as an always-on fallback.

### 3.4 Building and updating the picture index

- **Pictures:** use the small pictures the server already caches for every card (`CardPictureWarmer` in `card_picture_packs.py`, cache key includes the picture URL hash).
- **Index:** a new indexer embeds every cached picture that has no vector for the current model yet. Store one row per card: card id, language, model id, picture key, vector. Keep the whole matrix in memory and reload it when it changes.
- **Updates:** run the indexer right after the warmer, which already runs after each TCGdex sync (`schedule_after_sync`). New sets get indexed when TCGdex adds their pictures. A changed picture gets a new key and is re-embedded. Changing the model rebuilds everything.
- **Gaps:** cards without a picture (common for brand-new sets and some languages) aren't in the index. They fall to the OCR and Ollama path, and the admin page can show coverage ("29,140 of 29,800 cards indexed").

### 3.5 Offline, queue, inbox and review

- **Phone offline:** photos still save offline and upload on reconnect, then come back in seconds. On-device matching (§3.7) is what would give answers while the phone itself is offline.
- **Gaming PC off:** most scans don't notice. Only unsure ones lose the model's second opinion, and they go to the inbox now instead of waiting.
- **Queue:**
  - the same jobs, leases and retries;
  - composites aren't needed for picture matching, so turn them off for local models;
  - an unreachable fallback endpoint should never put a scan on the 6-hour ladder.
- **Inbox and review:** unchanged, with the same `recognized` and `matches` shape. Optionally add a "matched by picture and number" note in the trace and the UI.
- **Diagnostics:** traces gain the picture top 20 with scores, the OCR text and per-stage timings, so every reviewed scan improves the benchmark.

### 3.6 Running cost versus the LLM

- **Picture matching:** under a second of 3 cores per card on the always-on T340, and 0.5–1.3 GB of RAM per stack. Also a little electricity, one-off build work, and occasional maintenance when a model or threshold changes.
- **Ollama:** 70–85% fewer calls (estimate), each on a small image. The gaming PC no longer has to be on for scanning.
- **Ximilar** (for comparison): at least €59 / $69 a month for about 10,000 cards, and photos leave the house. It isn't better for 5–7 trainers.

### 3.7 On the phone versus on the server

| | Home lab server (recommended first) | On the iPhone (recommended second) |
| --- | --- | --- |
| Works when the gaming PC is off | Yes | Yes |
| Works when the phone is offline | Photos wait in the outbox, results seconds after reconnect | Yes, instant |
| Works when the home lab server is down | No (photos wait in the outbox) | Identifies the card; adding still waits for sync |
| Speed | Seconds after upload | Instant at capture (not measured; a fraction of a second expected on iOS 26) |
| Old iPhones | Same for everyone | Slower without WebGPU (before iOS 26) |
| Build and test effort | One place, Python, testable in CI | Second code path; real-iPhone testing; index shipped per set |
| Downloads | None on the phone | About 50–70 MB once, plus per-set index updates |
| Load | Under a second of 3 cores per card on the T340 | Phone battery and heat, briefly |
| Unsure cards | Ollama fallback when reachable, else the inbox | Hands them to the server (and on to Ollama or the inbox) |

**Verdict.** The phone version is now more valuable than it first looked, because it depends on neither machine. But the home lab server is always on, so the server version already removes the gaming-PC problem for every trainer and every iPhone, with one implementation that CI can test. It also builds and proves the model, thresholds and index format the phone version needs. So: server first, then the phone version as the next phase, reusing the same model and index files.

### 3.8 Phased plan

**Phase 0 — data and quick fixes to today's Ollama path (days).**

- **Data:** switch on scanner diagnostics on nonprod (`SCAN_TRACE_DIR`). Two or three consenting trainers scan about 300–400 cards with the normal scanner and confirm each in review; every confirmed scan stores photo and answer.
- **Quick fixes**, each a small PR:
  1. **Gaming PC off:**
     - don't put an unreachable endpoint on the 6-hour ladder: check it every few minutes and release waiting scans as soon as it answers;
     - show "Waiting for the scanner computer" instead of a bare countdown, and allow "Try now" for a retrying scan;
     - warn before the 14-day expiry deletes unrecognised scans.
  2. **Local-model requests:** send a guide-frame crop at about 1024 px instead of the full 2048 px photo; JSON schema, `temperature` 0 and `max_tokens`; one scan at a time for a single local endpoint; a longer timeout.
  3. **Visual verification:** turn it off for local models, or cap it at 4–6 candidates.
  4. **pHash:** stop hashing the whole photo (§1.7).
  5. **Candidate pictures:** load them from the server's own picture cache instead of the TCGdex CDN.
- **On the gaming PC** (owner, minutes): check `ollama ps`, and consider `OLLAMA_CONTEXT_LENGTH=8192` and a longer `OLLAMA_KEEP_ALIVE`.

**Phase 1 — prototype and benchmark (about 3–5 days, no app change).**

- A script, `backend/scripts/scan_benchmark.py`, runs the §3.1 pipeline offline on the trace photos.
- **Where it runs:** on the home lab server itself (PowerEdge T340), limited to 3 threads at a quiet time, so the timings are real. The build PC is used only at a time you approve. About 400 photos at under a second each per model, plus a one-off index build of about 15 min to 2 h per model.
- **Photo mix:**
  - modern English about 40%, German about 20%;
  - vintage WotC / e-series about 15%;
  - holo / reverse holo / full art about 15%;
  - at least 30 sleeved and at least 20 in top-loaders;
  - at least 20 at an angle or in poor light;
  - at least 20 "reprint traps" (same art in several sets);
  - 10 photos with several cards, for later.
- **Compared on the same photos:**
  - today's Ollama path (from the traces);
  - a tuned Ollama path (cropped card, number strip, JSON schema), run once when the gaming PC is on;
  - the picture + OCR matcher: contours versus a plain guide crop; DINOv2 ViT-S/14 and ViT-B/14, SigLIP-B/16 and CLIP ViT-B/16, plus MobileCLIP for the phone; PaddleOCR (ONNX) versus Tesseract;
  - the matcher with the tuned Ollama fallback.
- **Measured:**
  - card found and flattened (%);
  - right printing in the top 1 / 5 / 20;
  - number read exactly (%);
  - share decided without a model, and how often those are right;
  - language right (%);
  - time per stage (median and 95th percentile) on the home lab CPU;
  - peak memory.
- **Pass bar to go on to Phase 2:**
  1. Right printing in the top 20 for ≥ 97% of photos whose card has a TCGdex picture.
  2. Decided without a model for ≥ 70% of photos, with ≥ 98% of those right.
  3. Matcher plus fallback is at least as accurate overall as today's Ollama path, and the matcher alone at least as accurate as today's path for the cards it decides.
  4. ≤ 1.5 s per photo at the 95th percentile on the T340 with 3 threads, and ≤ 1.5 GB extra memory per stack.
- **If it fails:** the report says which stage failed. Options then are fine-tuning (TCG-AR-style training on synthetic variations, a few GPU hours on the gaming PC at agreed times), or the tuned Ollama path from Phase 0 with the PC-off fixes.

**Phase 2 — the matcher on nonprod (about 1–2 weeks).**

- A server setting turns on "picture match".
- **Shadow mode first:** it runs alongside Ollama, records agreement in the traces and changes nothing the trainers see.
- **Then primary**, with the reachable-only Ollama fallback and the "straight to the inbox" path when the PC is off.
- Hook the indexer after picture warm-up. Show index coverage and fallback reachability on the admin page. Unit tests, plus a few fixture photos in CI.

**Phase 3 — prod, with your OK.** Tune the thresholds from the trainers' review choices. The confirmed answers keep accumulating.

**Phase 4 — the phone version, then extras.**

- On-device instant matching (§3.7).
- Then several cards per photo.
- Variant hints: the TCGdex variant list, a 1st Edition stamp check, a batch foil toggle.
- A model fine-tuned on our own confirmed scans.

### 3.9 Risks

1. **Clean pictures versus real photos** (sleeves, top-loader glare, holo sparkle, worn cards). Measured in Phase 1; flattening and fine-tuning are the remedies.
2. **Near-identical printings** (reprints, promo stamps, gallery cards). The picture can't tell them apart. This relies on reading the number; otherwise Ollama or the trainer decides, as today.
3. **Cards with no TCGdex picture yet** can't be matched by picture and fall back to OCR and Ollama.
4. **OCR on tiny, glossy or foil text.** Older cards have no set code, and some promos have no total.
5. **CPU contention** on the T340, which also runs prod, nonprod and other services. Cap the matcher at 3 threads (or a 3-CPU sidecar), keep the concurrency cap of 3 scans, and build indexes at night.
6. **Bigger backend image and slower CI** (ONNX Runtime, OpenCV, models). Bake the models in with checksums rather than downloading them at runtime.
7. **Licences.** DINOv2, SigLIP and PaddleOCR are permissive. DINOv3 and MobileCLIP need checking. YOLO is AGPL, the same as this project.
8. **Upstream drift.** Git-Romer actively changes the scanner, so keep the new code in its own module.
9. **Synthetic tests flatter methods.** Use only real photos for the go/no-go call.

### 3.10 Quick answers to the brief's questions

- **More efficient?** Yes: under a second on half of the always-on T340's cores, instead of GPU time on a PC that has to be on.
- **More reliable?** Yes:
  - it no longer stops when the gaming PC is off;
  - where picture and number agree, they check each other;
  - the cases that are hard for everyone (unreadable number, identical art) are no worse than today, because those still go to Ollama or the trainer.
- **Can recognition run on the iPhone offline?** Realistic with iOS 26 and about 50–70 MB of downloads. It's the recommended second step.
- **Does the model detect variants today?** No. Nothing reliable does from one photo.

### 3.11 What I need from you

1. **Photos with answers.** OK to switch on scanner diagnostics on nonprod, and which trainers will scan the mix above (about 300–400 cards) and confirm them? If diagnostics are already on in prod and trainers agree, those traces can be used too.
2. **The home lab server** (PowerEdge T340, Xeon E-2126G, 32 GB; disk unconstrained):
   - roughly how busy it gets: CPU and RAM in use at peak, and anything CPU-heavy that runs on it, such as media transcoding or backups;
   - OK to run the Phase 1 benchmark there at a quiet time, limited to 3 threads?
3. **The gaming PC's Ollama:**
   - GPU model and VRAM;
   - what `ollama ps` shows under PROCESSOR while a scan runs;
   - native Windows install or Docker/WSL;
   - any `OLLAMA_*` settings;
   - which timeout is chosen in Scanner Settings;
   - whether visual verification shows as automatic;
   - roughly when the PC is usually on.
4. **Languages:** which languages the server syncs (`TCGDEX_SYNC_LANGUAGES`), and whether Japanese cards matter.
5. **The fallback:** keep Ollama as the optional fallback? When the PC is off, should unsure scans go straight to the inbox (recommended), or wait for the PC up to some limit?
6. **Variants:** is automatic holo / reverse holo detection a must, or are better defaults plus a batch toggle enough?
7. **The phone version:** go ahead with it as the step after the server version?

## 4. Sources

Code and history in this repository: `backend/api/recognize.py`, `backend/api/scan_jobs.py`, `backend/services/scan_queue.py`, `scan_providers.py`, `gemini_rate_limit.py`, `provider_rate_limit.py`, `scan_storage.py`, `scan_trace.py`, `card_composite.py`, `card_picture_packs.py`, `frontend/src/components/BatchCameraCapture.jsx`, `UnifiedCardScanner.jsx`, `ScanReview.jsx`, `CardScanner.jsx`, `frontend/src/utils/retryCountdown.js`, `frontend/src/offline/ops/scanSubmit.js`, `docs/scanner-providers.md`, and `git log` for the scanner files.

Upstream and fork PRs and issues:
- Git-Romer/pokecollector: [#324](https://github.com/Git-Romer/pokecollector/pull/324), [#342](https://github.com/Git-Romer/pokecollector/issues/342), [#378](https://github.com/Git-Romer/pokecollector/pull/378), [#419](https://github.com/Git-Romer/pokecollector/pull/419), [#420](https://github.com/Git-Romer/pokecollector/pull/420), [#421](https://github.com/Git-Romer/pokecollector/pull/421), [#422](https://github.com/Git-Romer/pokecollector/pull/422), [#335](https://github.com/Git-Romer/pokecollector/issues/335), [#282](https://github.com/Git-Romer/pokecollector/issues/282), [#389](https://github.com/Git-Romer/pokecollector/issues/389), [#390](https://github.com/Git-Romer/pokecollector/issues/390), [#425](https://github.com/Git-Romer/pokecollector/issues/425)
- IDEKENTERPRISES/pokecollector: [#58](https://github.com/IDEKENTERPRISES/pokecollector/pull/58), [#60](https://github.com/IDEKENTERPRISES/pokecollector/pull/60)

Ollama and Qwen3-VL:
- Ollama FAQ (context length, parallel requests, keep-alive, `ollama ps`): <https://docs.ollama.com/faq>
- Ollama OpenAI compatibility: <https://docs.ollama.com/api/openai-compatibility>
- qwen3-vl tags and sizes: <https://ollama.com/library/qwen3-vl/tags>
- Ollama's Qwen3-VL image limits (default max pixels): <https://github.com/ollama/ollama/blob/main/compatmigrate/qwen3vl.go>
- Qwen3-VL image token maths (32 px blocks): <https://docs.rs/crate/llm-multimodal/1.7.0/source/src/vision/processors/qwen3_vl.rs>
- Do VLMs Read or Rewrite? On transcription faithfulness: <https://arxiv.org/abs/2607.21617>
- Qianfan-OCR (independent Qwen3-VL-4B OCRBench and DocVQA numbers): <https://arxiv.org/abs/2603.13398>
- Codersera, Qwen3-VL 4B versus 8B (third-party, unverified): <https://codersera.com/blog/qwen3-vl-4b-vs-qwen3-vl-8b-benchmarks-vram-guide/>
- llama.cpp issue on slow vision encoding on CPU: <https://github.com/ggml-org/llama.cpp/issues/22582>

Home lab hardware:
- Dell PowerEdge T340 technical guide (video: Matrox G200 with iDRAC9): <https://cdn.shopify.com/s/files/1/0593/9249/1689/files/dell-emc-poweredge-t340-tech-guide.pdf>
- Dell community thread on T340 graphics (user report): <https://www.dell.com/community/en/conversations/poweredge-hardware-general/t340-graphic-card-update/647f8ee5f4ccf8a8defdcf37>
- OpenVINO GPU plugin (supported Intel graphics): <https://docs.openvino.ai/latest/openvino_docs_OV_UG_supported_plugins_GPU.html>

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
- Roboflow, detector plus vision-model card pipeline: <https://blog.roboflow.com/trading-card-inventory-management/>
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
