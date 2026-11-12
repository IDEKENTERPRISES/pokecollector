# Phone scanner, step 3a: the card finder in JavaScript

`frontend/src/phonescan/finder/` is `backend/services/card_match/detect.py` (matcher version 11) ported to plain JavaScript:
pure functions over `{data: Uint8ClampedArray RGBA, width, height}`, no canvas, no OpenCV.js.

## What it exposes (`index.js`)

| Function | Server counterpart | Result |
| --- | --- | --- |
| `findCard(photo, {guideInput, hires})` | `detect_card(check=True, whole=True)` | `{card, source: 'quad' / 'guide' / 'whole', quad or null, refused: {reason, quad, ...} or null, confidence, hires or null}`; `card` is 630x880 |
| `cardViews(card)` | `_main_scores` + `augmented_views` | `[{kind: 'card'}, {kind: 'card180'}, {kind: 'tight'}, {kind: 'clahe'}]`, each `{kind, image}` |
| `artCrop(image)` | `art_crop` | the artwork window of a flat card or of either augmented view |
| `wholeCard(photo)` | `whole_detection` (the picture the second read uses) | the sharper whole-picture copy when the photo has one, else the 630x880 card |

- `guideInput`: `null` or omitted judges by the picture's shape (`isGuidePicture`, as the server does); `false` is a whole camera
  frame (the review or full photo path); `true` forces the guide-crop rules.
- `hires: true` also builds the sharper flat copy (up to 1008x1408) the text is read from; it costs a second warp, so it is off by
  default. `wholeDetection(photo)` returns both `{card, hires}`.
- The in-use option set embeds these pictures (pipeline `_main_scores` and `_picture_scores`): the card and its 180 degree turn
  first; then, from the card the right way up, the tight crop and the CLAHE view; with `art`, the artwork crop of the card and of
  both extra views. `cardViews` builds the four from the card as given. When the turned view scored clearly higher, the server
  builds the two augmented views from the turned card, so the integration step calls `augmentedViews(rotate180(card))` then.
- Also exported for the other parts: `warpCard`, `guideRect`, `orderCorners`, `quadMeasures`, `plausibilityProblem`,
  `roundHalfEven` (`finder.js`), and the OpenCV-equivalent routines in `cv.js` and `color.js`.

## OpenCV.js or hand-written: hand-written

OpenCV.js would run the same algorithms, but it is a large download: the official `opencv.js` 4.x build is about 10 MB (the wasm is
embedded in it), and a custom minimal build needs Emscripten and a build recipe we would have to keep reproducible. The finder only
uses about a dozen routines, and every one of them has a short, deterministic definition in OpenCV 4.10's source (the version the
server pins, `opencv-python-headless==4.10.0.84`). So each routine was ported from that source instead of from its description:

- exact ports (same integer arithmetic, same order, same tie-breaking): grey conversion, 5x5 Gaussian, Canny (Sobel, L1 gradient,
  non-maximum suppression with OpenCV's fixed-point slopes, hysteresis), rectangular close, Otsu, `findContours`
  (`RETR_LIST`, `CHAIN_APPROX_SIMPLE`: the Suzuki border follower of `contours_new.cpp`, including contour order), `convexHull`
  (Sklansky with its cyclic re-shift, so the hull starts where OpenCV's does), `approxPolyDP`, `contourArea`, `arcLength`, CLAHE
  (tile padding, clip, redistribution and interpolation in float32);
- rounded the same way but not bit for bit: `minAreaRect` (the smallest rectangle with a side on a hull edge, the same rectangle as
  the rotating calipers), `getPerspectiveTransform` (Gaussian elimination), `warpPerspective` (cubic weights at 1/32-pixel
  positions; OpenCV uses 15-bit fixed-point weights), and the Lab conversion (a float formula; OpenCV's is a fixed-point table);
- resizing (`INTER_AREA`, `INTER_CUBIC`) comes from `frontend/src/phonespeed/preprocess.js` (step 2).

Size: no new dependency and no new download. The finder is about 50 KB of source (unminified); it ships in the app bundle like any
other module, so there is nothing to add to the service-worker exclusion list. `package.json` and the lock file are unchanged.

Speed (desktop Node, one run each, 768x1024 and 1050x1400 photos): `findCard` about 0.5 to 0.7 s, `cardViews` about 0.4 s (the Lab
conversion and CLAHE dominate). A phone is slower; measuring it and moving the work into a worker belongs to the integration step.
The obvious saving, if needed, is a Lab lookup table.

## Parity

`backend/scripts/phone_parity_finder.py` writes `frontend/tests/fixtures/phone-matcher/v11/finder/` (about 1.5 MB: 19 JPEGs of at
most 1024 px, plus `finder.json`). Everything is generated: cards by `ocr_synthetic.render_card`, photos by `synthetic.make_photo`
(four backgrounds, tilt, perspective jitter, glare, noise, blur), then cropped to guide pictures, rotated, left empty, or redrawn as
a small, sideways or sheared card to give the refusals. No trainer scan and no catalogue picture is used.

Run it with the server's OpenCV for exact expected values:

```bash
py -m pip install --target /tmp/cv410 opencv-python-headless==4.10.0.84
PYTHONPATH=/tmp/cv410 py backend/scripts/phone_parity_finder.py
```

The generator decodes each JPEG with the same decoder the JS tests use (jpeg-js, through Node) because decoders round a little
differently (jpeg-js is about 0.8 of a level darker than libjpeg on average) and the finder's thresholds amplify that on noisy
pictures. The first run, with Pillow-decoded expectations, disagreed on the noise-only pictures for that reason alone, and agreed
once both sides saw the same pixels. Regenerate the JPEGs and `finder.json` together.

Per photo it records the option used, which source won, the refusal reason and the refused quad, the quad, the confidence, and for
the flattened card, the 180 degree view, tight, CLAHE, the three artwork crops, the sharper copy and the whole-picture picture: size,
mean and standard deviation per channel and an 8x11 area-averaged grid. It also records the pieces on their own (blur, Canny, close,
Otsu, every contour with its hull, approximations and rectangle, CLAHE, Lab, the warp, `order_corners`, `quad_measures`,
`plausibility_problem`, `guide_rect`, `is_guide_picture`, `hires_size`).

Results of `frontend/src/phonescan/finder/finder.test.js` (19 photos, 29 tests, all passing):

| What | Result | Tolerance in the test |
| --- | --- | --- |
| Source (quad / guide / whole) | identical on 19 of 19 | exact |
| Refusal reason (`not_rectangular`, `too_small`, `sideways`, `bad_angles`, none) | identical on 19 of 19 | exact |
| Contours, hulls, polygon approximations, edge maps, Otsu, CLAHE plane | identical in every case | exact |
| Quad corners | worst 0.004 px | 0.05 px (float32 against float64) |
| Confidence | identical to the 3rd decimal | 0.002 |
| Flat card, 180 degree view, tight view, art crop (grid of averages) | worst 1 level of 255 | 1 level (cubic weights: 15-bit fixed point there, float here) |
| CLAHE view and its art crop | worst 4 levels | 5 levels (Lab rounding, stretched by CLAHE) |
| Per-channel mean and std of the above | within 0.5 | 0.5 (CLAHE views: 1.5 and 2.0) |

No photo fails parity.

## Not covered, on purpose

- Real photos (the owner's rule: none in the repo). A real photo's JPEG is decoded by Safari, not by jpeg-js or libjpeg; the finder
  is deterministic on the pixels it is given, so the right check on a device is the speed-test style comparison of the quad.
- A photo whose strongest contours tie in area could order them differently from OpenCV; none of the generated photos does.
