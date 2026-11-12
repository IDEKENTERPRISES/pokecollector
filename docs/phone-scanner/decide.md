# Phone scanner step 3c: catalogue lookups and the decision rules in JavaScript

Folder: `frontend/src/phonescan/decide/`. Server reference: matcher version 11 (`backend/services/card_match/`, `docs/CARD_MATCH.md`).
Everything here is pure JavaScript over plain data (no IndexedDB, DOM or network in the rules), checked in CI against answers the
Python matcher recorded in `frontend/tests/fixtures/phone-matcher/v11/` (`pure-functions.json` from step 1, and `decide/` from
`backend/scripts/phone_parity_decide.py`). Porting `CardMatcher` itself, the card finder (3a) and the text reader (3b) is not part of this step.

## What is ported

| Python | JavaScript | Notes |
| --- | --- | --- |
| `constrained.py` (`constrain`, `pattern_distance`) | `constrained.js` | |
| `lookup.py` (`number_pairs`, `set_code_tokens`, `norm_text`, `card_texts`, `LookupIndex`, `LookupEvidence`) | `lookup.js` | the index is plain data; evidence is a plain object with free functions (`evidenceBonus`, `evidenceTrace` ...) |
| `names.py` (`name_key`, `base_key`, the similarity, `NameIndex`) | `names.js` | `parse_name_lines` and `clean_name_line` read the picture's text: they belong to 3b |
| `difflib.SequenceMatcher` (`autojunk=False`) | `difflib.js` | ported from CPython's algorithm: `find_longest_match`, the queue-based `get_matching_blocks` with its merge of adjacent blocks (the text lane filters blocks by size), `ratio`, `quick_ratio`, `real_quick_ratio`. The server always passes `autojunk=False`, so there is no popular-element pruning to port |
| `pipeline.py`: `merge_candidates` (with `number_once`), `decide`, `_decide_lanes`, `_lookup_near`, `_name_conflict`, `_reprint_choice`, `_total_contradiction`, `_closer_same_name`, `whole_number_problem`, `number_from_lookup`, `correct_number` | `pipeline.js` | |
| `api/recognize.py`: `_candidate_rank_key`, `_metadata_decision`, `_numbers_match`, `_printed_total_signal`, `_normalize_*`, `_name_search_key`, `_scanner_names_compatible`, `_simplify_name` | `rules.js` | |
| thresholds (`pipeline` constants, `phone.decision_settings()`) | `thresholds.js` | defaults equal the server's constants; `thresholdsFromManifest(manifest)` overlays `manifest.thresholds` at runtime |
| the tail of `CardMatcher.match` (scores to decision) | `decideCard.js` | same order: top K, lookup evidence, merge, candidates, `card_info`, `number_from_lookup`, `correct_number`, `decide` |
| `db_candidate_loader`, `build_name_index`, `build_lookup_index` | `catalogue.js` | the catalogue adapter, below |

Python-compatible details that matter for exact parity: `pyRound` (Python's round-half-to-even, used for the 3 and 4 decimal rounding of
similarities and scores), `casefold` and NFKD handling, code-point indexing, stable sorts where Python sorts stably.

## Interface

```js
import { buildDecideIndexes, loadCatalogueRows, createLazyIndexes, decideCard, thresholdsFromManifest } from 'src/phonescan/decide'

const { rows, signature } = await loadCatalogueRows(carddbStore)         // the adapter (reads stored set payloads)
const indexes = buildDecideIndexes(rows, { restrictToIds })               // pure; or buildDecideIndexesAsync(rows) / a worker
const result = decideCard({ pictureScores, read, options, indexes, thresholds: thresholdsFromManifest(manifest) })
```

`decideCard` input:

- `pictureScores: {ids, scores, art}`: the picture side as the server holds it after `_picture_scores`. `ids[row]` is the card id of an
  index row, `scores[row]` every card's picture score (the average of the whole-card and artwork signals when both exist; Float32Array or
  array), `art[row]` the artwork-only similarity (or `null`). **This is what the integration step should pass**: the phone computes every
  dot product anyway, and a text candidate that the picture search did not put in its top 20 still needs its picture similarity, and every
  candidate its picture rank (`1 + number of cards scoring higher`), exactly as the server does.
- `pictureTopK: {whole: [{id, score}], art: [{id, score}]}` is accepted as a short form (`scoresFromTopK`). It is an approximation: a card in one list
  only is scored by that signal alone, a card in neither is unknown (a text candidate outside both lists cannot be ranked), and ranks are
  positions in the union. It is covered by a small test, not by the parity cases.
- `read`: `{number, total, setCode, tokens, hp, lines, bodyLines, name, nameLines, numberSource, numberConfidence}`. `tokens` are the reader's
  tokens (the lookup's set-code candidates; `setCode` alone stands in for `[setCode]`). `name` `undefined` means the name strip was not read;
  `null` means it was read and gave nothing. `numberSource` is `'finder_card'` (the default when a number is present) or `'whole_picture'`.
  `read: null` is a scan without text reading.
- `options`: `{numberOnce, wholeStrict, reprint, fallback, useNames, useNumber, useText, topK}`. `fallback` is the server's
  `fallback is not None and not trusted`: the card was not found by the finder, so only a number the reader itself read may decide. The
  integration step derives it from the finder (`guide_crop`, `full_photo`, `review_photo`, and `trustrejected`). The server's in-use set is
  `numberOnce: true, wholeStrict: true`, names, number and text lanes on, `reprint` off.
- `thresholds`: a thresholds object or the whole bundle manifest; omitted, the defaults.

Output: `{decided, cardId, tcgCardId, mechanism, reason, similarity, lead, candidates: [{id, tcgCardId, score, rank, pictureRank, name, number,
set, printedTotal, evidence: {nameScore, nameKnown, lookup, lookupUnique, textScore, textCards, artSimilarity}}], corrected, numberFromLookup}`
and, with the server's names, `status`, `decision` (`card_id`, `tcg_card_id`, `mechanism`, `similarity`, `lead`), `unsure_reason`,
`matches` (`card_id`, `tcg_card_id`, `similarity`, `rank`, `name`, `number`, `set`, `printed_total`, `picture_rank`, `name_score`, `lookup`,
`text_score`, `art_similarity`), `ocr` (`lookup` trace, `text_candidates_added`, `number_from_lookup`, `corrected`) and `cardInfo`.

## The catalogue adapter and the id mapping

**Ids.** carddb stores the server's own card ids (`sv1-1_en`, the `card.id` column; its payload also carries `tcg_card_id` = `sv1-1`), and the phone
bundle's index files carry the same ids (`phone.pack_index` writes the server index's `entries` ids). So the mapping from carddb ids to the
bundle's index ids is the **identity**; the candidate table is keyed by it, and `decideCard` skips a picture-index id that the catalogue does not
hold (the server's `candidate_loader` does the same). The decision's `tcg_card_id` is `card.tcg_card_id`, else the id without its `_lang` suffix.
`buildDecideIndexes(rows, {restrictToIds})` narrows to exactly the ids in the bundle's index files.

**Which cards.** The server indexes English, physical (not `is_digital`), non-custom cards that have a catalogue picture, and the name and lookup
indexes need a name. `candidateFromRow` applies the same filter (`lang` en, `is_digital` false on the card and its set, `images_small` non-empty,
name non-empty).

**Reading carddb.** `loadCatalogueRows(source)` takes carddb's store (`createCardDbStore()`; it uses the existing `getMeta` and `scanSets`) or an
object whose `.store` is one. It does **not** go through the reader or engine: neither exposes the long texts (attacks, abilities, effects), which only
the stored set payloads hold, and the reader's per-card `card()` would read a whole set payload for every card. `scanSets` visits one stored set at
a time (the same call the engine's own index build uses), so no language is decoded twice. Rows are the card joined with its set:
`{id, tcg_card_id, name, number, set_id, set_name, set_abbreviation, printed_total, rarity, hp, artist, regulation_mark, suffix, supertype,
card_effect, attacks, abilities, lang, is_digital, images_small}`. `signature` is `catalogueSignature(meta)` (the language's catalogue hash and set
count; a prices-only sync does not change it).

**Needed carddb change (not made here): `printed_total`.** The server's number and total rules use the set's *official* printed total
(`Set.printed_total`, TCGdex `cardCount.official`). carddb's set rows (`offline_carddb.SET_FIELDS`) carry only `total` (`cardCount.total`, which counts
secret rares), so `printed_total` is missing on the phone today. The adapter reads `set.printed_total` when it is there and leaves the printed
total **unknown** when it is not: no wrong contradictions, but the `number_total` and `number_total_set` lookups, the total signal in the ranking and
the constrained reading lose their totals, and decisions lean on the picture and the number alone (`stats.printedTotalMissing` counts the
cards). `totalFallback: 'total'` uses the set `total` instead, which is wrong for sets with secret rares (it would refuse correct decisions with
`total_contradicts_read`), so it is off by default. The fix is one word, `"printed_total"`, in `SET_FIELDS` of `backend/services/offline_carddb.py`
(and a carddb sync after it). Until then the integration step should not expect parity with the server for number-and-total decisions.

Set codes: like `build_lookup_index`, the lookup maps each set's `abbreviation` and `tcg_set_id` (upper-case) to its set id, plus the promo codes in
`EXTRA_SET_CODES`. The server also maps codes of sets that exist only in other languages; they point at no English card, so they change nothing
except the `set_codes` trace.

**Lazy, once per catalogue signature, off the UI thread.** `createLazyIndexes({source, restrictToIds})` returns `getIndexes()`; it builds on the first
call, shares concurrent calls and rebuilds only when `catalogueSignature(meta)` changed. The build is pure and the result is plain data
(Maps, Sets and arrays, structured-cloneable: a test clones it and gets the same decisions), so the integration step should run
`loadCatalogueRows` and `buildDecideIndexes` in a worker and transfer the result. Without a worker, `buildDecideIndexesAsync(rows)` feeds rows in
chunks of 1,500 and yields between them.

### Build cost (estimate)

From a generated catalogue of 20,000 rows (invented names, numbers, totals and texts; 11,252 distinct names, 15,017 distinct text segments, 10,805
cards with a text), Node 22 on the desktop PC, `node --expose-gc src/phonescan/decide/buildCost.bench.mjs 20000 3`:

| | |
| --- | --- |
| build, one go | 410 to 650 ms (3 runs, including JIT warm-up) |
| build, chunked | 390 ms; longest slice without yielding 31 ms |
| result held in memory | about 16 MB of heap |
| result as a structured clone (what `postMessage` moves) | 11.8 MB: candidate rows 4.6 MB, name index 2.7 MB, lookup index 4.5 MB |
| one decision on the full catalogue (name, number and text lanes) | about 14 ms |

Not measured on a device. A phone core is several times slower than a desktop core, so plan for a build in the order of 1 to 3 seconds in a
worker, once per card sync, and a decision in the tens of milliseconds. The sizes do not depend on the device.

## Parity coverage

CI runs `src/phonescan/decide/*.test.js` (vitest). Backend: `backend/tests/test_card_match_phone_decide.py` regenerates the fixtures in a temporary folder
and checks they equal the committed ones, so a changed Python answer shows up as a failing test rather than a silent drift.

- `pure-functions.json` (step 1): every case for `name_keys`, `name_search`, `constrain`, `number_pairs`, `lookup_search` (trace), `decide` and
  `thresholds` (the defaults equal the manifest values) passes (`pureFunctions.test.js`). The reader's cases there (`parse_text`, `pick_number_lines`,
  `is_name_like`, `parse_name_lines`) are 3b's.
- `decide/strings.json`: 270 string pairs for `SequenceMatcher` (ratio, quick ratio, real quick ratio and the merged matching blocks, all equal exactly), Python's
  rounding of tie values, `norm_text`, name keys and compatibility, number and total normalising, and name scores (`strings.test.js`).
- `decide/cases.json` with `decide/catalogue.json`: 356 `decide` cases on a hand-written catalogue of 45 English cards plus 4 rows the server leaves out (digital,
  non-English, no picture, no name) and 2 picture-index ids the catalogue does not hold. The catalogue has reprints with the same number in different sets
  (Pikachu #25 and Lapras #17 in three sets), same-name printings, gallery numbers (TG06, GG01, SV28), totals with prefixes, a promo, qualifiers and accents
  ("Boss's Orders (Giovanni)", "Flabébé", "Ho-Oh"), a few card texts and a shared rule sentence. About 56 cases are written by hand for specific mechanisms
  (the Darumaka and Kommo-o numbers of versions 8 and 6, a glued set code, a bar read as a slash, a lost slash, fallback scans, whole-picture numbers at every
  strict-rule threshold, rule-box text) and 300 come from a seeded generator (picture score vectors with chosen similarities, leads and rivals; reads with a
  number, without, damaged, wrong, wrong total; names exact, damaged, wrong, unknown or absent; body text; whole-picture or finder sources; option sets).
  `run_tail` in the script repeats the glue of `CardMatcher.match` around the real `names`, `lookup` and `pipeline` modules. For every case the JavaScript
  must give the same decision, card, mechanism and reason, the same candidate list in the same order with the same ranks and lane facts, the same lookup
  trace, `number_from_lookup` and `corrected`, and scores within 1e-9. All 356 do.
- Mechanisms reached: `number_unique`, `number_metadata`, `number_and_picture`, `picture_lead`, `picture_lead_strong`, `name_and_picture`,
  `text_and_picture`, `reprint_art_lead`. **Not reachable: `artist_hp`.** It needs `card_info.artist`, which `OcrResult.as_card_info` never sets, so no scan
  can produce it; the port keeps the rule inside `metadataDecision`.
- Refusal reasons reached: `no_picture_matches`, `card_not_found_no_number_read`, `number_lookup_conflicts_with_name`, `total_contradicts_read`,
  `closer_printing_of_same_name`, `rules_choice_not_close_in_picture`, `number_not_among_picture_matches`, `number_matches_several_printings`,
  `no_number_and_picture_not_clear`, `whole_number_total_not_confirmed`, `whole_number_picture_too_weak`, `whole_number_name_conflict`,
  `whole_number_low_confidence`. The parity tests fail if one of these stops being reached.
- The generated cases never contain an exact tie in the picture scores (numpy's top-k order is not defined for ties; the port sorts stably by row).

## What is not ported, and differences from the server

- `metadataDecision`'s last branch (`sole_candidate`: a Trainer or Energy found by native language and name) needs `card_info.language` and
  `card_type`, which the picture matcher never sets (`language` is forced to `None`), so it can never fire; it is left out, with a comment in `rules.js`.
  `normalize_tcgdex_language` is not needed for the same reason.
- A picture-index id with no catalogue row is "unknown" in the name agreement (the server would raise `KeyError`; its name index always holds every indexed id).
- Python's `\d`, `\s` and `\b` are Unicode-aware, JavaScript's are mostly ASCII (and JavaScript's `\s` also matches U+FEFF). The strings that reach
  these rules are OCR output and catalogue text; the parity strings include accents, full-width forms, combining marks, `ß` and curly quotes. A differing result would
  need unusual digits or spaces from the reader.
- Python's `set` iteration order (hash dependent) decides ties between text-lane segments with exactly equal votes and the order of equal-scored cards in the
  merge; the port iterates in insertion order. The server's own order is not stable there either, and the fixtures contain no such tie.
- `scoreNames` keeps its last answer (the merge, the "name known" check and the per-card scores ask for the same read name): a cache, no change of result.
- Reading the name line (`parse_name_lines`) and the number strips, `ocr.find_hp`, and the finder decisions that set `options.fallback` belong to 3b, 3a and the integration step.

## For the integration step

1. Build the indexes in a worker from `loadCatalogueRows(createCardDbStore())`, with `restrictToIds` = the ids in the bundle's index files; rebuild when `catalogueSignature` changes.
2. Pass `pictureScores` with the full score vectors (per card the average of the whole-card and artwork scores, and the artwork-only vector), and `read.tokens` from the reader.
3. Map the finder's `fallback` and `rejected` result to `options.fallback` as `CardMatcher.match` does (`fallback is not None and not trusted`).
4. Read `thresholds` from the manifest with `thresholdsFromManifest(manifest)`.
5. Ask for the `printed_total` carddb change above before judging number-and-total decisions against the server.
