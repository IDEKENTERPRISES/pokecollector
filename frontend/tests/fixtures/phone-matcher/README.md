# Phone matcher parity fixtures

What the Python picture matcher (`backend/services/card_match/`) answers, step by step, so the JavaScript matcher that will run on the
iPhone can be tested against it in CI. One folder per matcher version (`v11/`); a new matcher version needs a new folder.

| File | Holds |
| --- | --- |
| `pure-functions.json` | input and output of `ocr.parse_text`, `ocr.pick_number_lines`, `ocr.is_name_like`, `names.parse_name_lines`, `names.name_key`/`base_key`/`clean_name_line`, `NameIndex.search`, `constrained.constrain`, `lookup.number_pairs`, `LookupIndex.search`, `pipeline.decide`, the decision thresholds and the int8 quantiser |
| `photos.json` | for each generated photo: the found quad, the flattened size, the model input tensor (checksum, mean, std, first values) and the int8 embedding (first values, scale, norm) |
| `photos/photo-N.jpg` | the generated photos the second file describes (drawn cards on generated backgrounds, 1024 px long side) |

Everything comes from hand-written strings, catalogue-like rows and cards drawn by the test generators. **No trainer's scan, no real scan photo
and no TCGdex card picture is in here, and none may ever be added.**

`photos.json` has `embedder: "fake"` unless it was regenerated with `--real-model`: the fake embedder (a 4x4 colour signature) is
reproducible anywhere, so the quad, the flat card and the tensor are exact checks and the embedding fields only check the int8 quantiser. Compare
pixels with a tolerance (a JPEG decoder in a browser or Node differs from OpenCV's by a few levels): the exact `*_sha256` fields are for the Python
side, `mean`/`std`/`first_values` and the corners (a few pixels) are for the JavaScript side.

## Regenerate

```bash
cd backend
py scripts/phone_parity_fixtures.py            # writes ../frontend/tests/fixtures/phone-matcher/v<MATCHER_VERSION>/
py scripts/phone_parity_fixtures.py --real-model   # embedding fields from the int8 DINOv2-small model, when its file is present
```

Regenerate the JSON and the JPEGs together (the cards are drawn with the fonts of the machine that runs the script). Review the diff of
`pure-functions.json`: a changed answer means the matcher's behaviour changed, which the JavaScript port has to follow.
