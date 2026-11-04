"""Finding and reading the name and number on real photos (services/card_match/ocr.py, ocr_check.py).

Pure parts (glued numbers, name picking, preprocessing, merging) need no OCR engine; the reader ladder runs against a
scripted engine so the order of regions, early stops and the whole-card fallback are checked without models.
"""
import os
import sys
import types
import unittest

if os.name == "nt":  # api.recognize imports fcntl through the auth service; CI is Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

try:
    import numpy as np

    from services.card_match import misses, ocr, ocr_check, ocr_synthetic

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def line(text, score=0.9, x0=0, y0=0, x1=100, y1=20):
    return ocr.Line(text, score, x0, y0, x1, y1)


@unittest.skipUnless(DEPS_AVAILABLE, "numpy / opencv not installed")
class ParsingTests(unittest.TestCase):
    def test_a_lost_slash_still_gives_number_and_total(self):
        result = ocr.parse_text(["MEWEN072189"])
        self.assertEqual((result.number_local, result.number_total), ("072", "189"))
        result = ocr.parse_text(["183275"])
        self.assertEqual((result.number_local, result.number_total), ("183", "275"))
        result = ocr.parse_text(["PREEN O62148"])  # a letter O for the zero
        self.assertEqual((result.number_local, result.number_total), ("062", "148"))

    def test_five_glued_digits_split_two_and_three(self):
        result = ocr.parse_text(["58102"])
        self.assertEqual((result.number_local, result.number_total), ("58", "102"))

    def test_the_language_code_is_not_part_of_the_number(self):
        result = ocr.parse_text(["SSP EN 038/270"])
        self.assertEqual((result.number_local, result.number_total), ("038", "270"))
        self.assertIn("SSP", result.tokens)
        glued = ocr.parse_text(["SVIEN018/091"])
        self.assertIn("SVI", glued.tokens)

    def test_a_printed_bar_is_not_a_slash_but_a_bar_without_spaces_is(self):
        result = ocr.parse_text(["30C | 017/128"])  # 30th Celebration mark, a divider, then the number
        self.assertEqual((result.number_local, result.number_total), ("017", "128"))
        bar = ocr.parse_text(["018|091"])
        self.assertEqual((bar.number_local, bar.number_total), ("018", "091"))

    def test_gallery_prefixes_and_promos_survive(self):
        self.assertEqual(ocr.parse_text(["TG06/TG30"]).number_local, "TG06")
        self.assertEqual(ocr.parse_text(["SWSH062"]).number_local, "SWSH062")

    def test_text_that_is_not_a_number_is_left_alone(self):
        for text in ("NintendoICreatures/GAMEFREAK", "You may play only 1 Supporter card during your turn", "HP 120", "2024 Pokemon"):
            self.assertIsNone(ocr.parse_text([text]).number_total, text)

    def test_the_most_confident_whole_line_wins_over_stitched_neighbours(self):
        lines = [line("12", 0.99), line("034/231", 0.7), line("SSP EN 099/270", 0.95)]
        result, confidence = ocr.pick_number_lines(lines)
        self.assertEqual((result.number_local, result.number_total), ("099", "270"))
        self.assertEqual(confidence, 0.95)

    def test_a_slash_line_beats_a_glued_one(self):
        result, _ = ocr.pick_number_lines([line("MEWEN072180", 0.99), line("MEW EN 072/189", 0.8)])
        self.assertEqual((result.number_local, result.number_total), ("072", "189"))

    def test_two_views_that_agree_raise_the_confidence_and_disagreement_keeps_the_more_complete(self):
        first = ocr.parse_text(["018/091"])
        first.number_confidence = 0.6
        second = ocr.parse_text(["018/091"])
        second.number_confidence = 0.7
        self.assertGreater(ocr.better_read(first, second).number_confidence, 0.7)
        partial = ocr.OcrResult(number_local="12", number_confidence=0.99)
        full = ocr.parse_text(["018/091"])
        full.number_confidence = 0.5
        self.assertEqual(ocr.better_read(partial, full).number_total, "091")


@unittest.skipUnless(DEPS_AVAILABLE, "numpy / opencv not installed")
class NamePickingTests(unittest.TestCase):
    def test_names_pass(self):
        for name in ("Pikachu", "Mew ex", "Misty's Vitality", "Professor's Research", "Ho-Oh", "Boss's Orders", "Mr. Mime", "Iono", "Pikachu HP 70"):
            self.assertTrue(ocr.is_name_like(name), name)

    def test_body_text_copyright_and_numbers_do_not(self):
        for text in (
            "Pokemonex | nocked Out, y | nexrule", "You may play only 1 Supporter card during your turn",
            "NintendoICreatures/GAMEFREAK", "Illus. Someone Else", "30C | 017/128", "This attack does 30 damage to 1 of your opponent's",
            "", "ex",
        ):
            self.assertFalse(ocr.is_name_like(text), text)


@unittest.skipUnless(DEPS_AVAILABLE, "numpy / opencv not installed")
class PreprocessingTests(unittest.TestCase):
    def strip(self, glare=False):
        rng = np.random.default_rng(1)
        picture = np.full((60, 400, 3), 190, np.uint8) + rng.integers(0, 20, (60, 400, 3), dtype=np.uint8)
        picture[20:40, 50:300] = 30
        if glare:
            picture[:, 300:380] = 255
        return picture

    def test_every_variant_keeps_the_size_and_three_channels(self):
        for variant in ("plain", "sharp", "clahe", "binary"):
            out = ocr.prepare(self.strip(), variant)
            self.assertEqual(out.shape, (60, 400, 3), variant)
            self.assertEqual(out.dtype, np.uint8)

    def test_binary_is_black_and_white_with_dark_text_even_on_a_dark_card(self):
        out = ocr.prepare(self.strip(), "binary")
        self.assertEqual(set(np.unique(out)), {0, 255})
        dark = 255 - self.strip()  # light text on a dark card
        flipped = ocr.prepare(dark, "binary")
        self.assertGreater(float(flipped.mean()), 128)  # mostly white paper, text is the dark mark

    def test_deglare_only_acts_when_there_is_glare(self):
        self.assertIsNone(ocr.prepare(self.strip(), "deglare"))
        out = ocr.prepare(self.strip(glare=True), "deglare")
        self.assertIsNotNone(out)
        self.assertLess(float(ocr.glare_mask(out).mean()), float(ocr.glare_mask(self.strip(glare=True)).mean()))

    def test_a_card_that_is_all_glare_is_not_worth_repairing(self):
        self.assertIsNone(ocr.prepare(np.full((60, 400, 3), 255, np.uint8), "deglare"))

    def test_unknown_variant_is_an_error(self):
        with self.assertRaises(ValueError):
            ocr.prepare(self.strip(), "nope")

    def test_render_strip_is_the_picture_the_reader_got(self):
        card = np.random.default_rng(2).integers(0, 255, (880, 630, 3), dtype=np.uint8)
        record = {"box": [0.0, 0.885, 1.0, 1.0], "variant": "clahe", "zoom": 2.0, "flipped": False}
        out = ocr.render_strip(card, record)
        self.assertEqual(out.shape[1], 1260)
        turned = ocr.render_strip(card, {**record, "flipped": True})
        self.assertFalse(np.array_equal(out, turned))


class ScriptedEngine:
    """A stand-in for RapidOCR: answers each call from a script of lists of (text, score, y0, y1)."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = 0
        self.text_det = type("Det", (), {"preprocess_op": type("Pre", (), {"limit_side_len": 480})()})()

    def __call__(self, picture, **kwargs):
        self.calls += 1
        items = self.script.pop(0) if self.script else []
        return [[[[0, y0], [100, y0], [100, y1], [0, y1]], text, score] for text, score, y0, y1 in items] or None, None


def reader_with(script):
    reader = ocr.OcrReader.__new__(ocr.OcrReader)
    import threading

    reader.engine = ScriptedEngine(script)
    reader._lock = threading.Lock()
    reader._whole = {}
    reader.mode = "detect"
    return reader


@unittest.skipUnless(DEPS_AVAILABLE, "numpy / opencv not installed")
class LadderTests(unittest.TestCase):
    card = np.full((880, 630, 3), 180, np.uint8)

    def test_a_confident_complete_number_in_the_fast_strip_stops_there(self):
        reader = reader_with([[("SVI EN 018/091", 0.95, 0, 20)]])
        result = reader.read(self.card, read_hp=False, flipped=False)
        self.assertEqual((result.number_local, result.number_total), ("018", "091"))
        self.assertEqual(reader.engine.calls, 1)
        self.assertEqual([s["label"] for s in result.strips], ["number-left-tight"])
        self.assertEqual(result.strips[0]["lines"][0]["score"], 0.95)

    def test_a_shaky_read_is_confirmed_by_a_second_view_and_the_agreement_counts(self):
        reader = reader_with([[("018/091", 0.6, 0, 20)], [], [("SVI EN 018/091", 0.8, 0, 20)]])
        result = reader.read(self.card, read_hp=False, flipped=False)
        self.assertEqual(result.number_local, "018")
        self.assertGreater(result.number_confidence, 0.7)
        self.assertEqual([s["label"] for s in result.strips], ["number-left-tight", "number-right-tight", "bottom-band"])

    def test_nothing_in_the_strips_goes_to_the_band_variants_then_the_tall_band(self):
        reader = reader_with([[]] * 7 + [[("30C | 017/128", 0.8, 100, 130)]])
        result = reader.read(self.card, read_hp=False, flipped=False)
        labels = [s["label"] for s in result.strips]
        self.assertEqual(labels[:2], ["number-left-tight", "number-right-tight"])
        self.assertIn("bottom-band", labels)
        self.assertEqual(labels[-1], "bottom-wide")
        self.assertEqual((result.number_local, result.number_total), ("017", "128"))

    def test_the_tall_bands_are_read_once_and_shared_between_the_number_and_the_name(self):
        # number ladder: 2 strips, band, 2 wide strips, 2 more bands (deglare skipped: no glare) = 7 reads, then the tall bottom band; name: 3 strips, then the tall top band
        reader = reader_with([[]] * 7 + [[("30C | 017/128", 0.8, 100, 130)]] + [[]] * 3 + [[("Lapras", 0.99, 30, 80)]])
        result = reader.read(self.card, read_hp=False, flipped=False)
        read = reader.read_name(self.card)
        self.assertEqual(result.number_local, "017")
        self.assertEqual(read.name, "Lapras")
        again = reader.read(self.card, read_hp=False, flipped=False)  # the same card again: both tall bands come from the cache
        self.assertEqual(again.number_local, "017")
        self.assertEqual(reader.engine.calls, 7 + 1 + 3 + 1 + 7)
        self.assertEqual(read.strips[-1]["label"], "top-wide")

    def test_body_text_at_the_top_is_not_taken_for_the_name(self):
        reader = reader_with([[("Pokemonex | nocked Out, y | nexrule", 0.8, 0, 20)]] + [[("You may play only 1 Supporter card during your turn", 0.9, 0, 20)]] * 3 + [[]])
        read = reader.read_name(self.card)
        self.assertIsNone(read.name)
        self.assertTrue(read.raw)

    def test_the_name_comes_from_the_tallest_name_like_line(self):
        reader = reader_with([[("Mew ex", 0.99, 0, 50), ("Basic", 0.9, 0, 12)]])
        read = reader.read_name(self.card)
        self.assertEqual(read.name, "Mew ex")
        self.assertEqual(len(read.strips), 1)

    def test_fixed_mode_reads_only_the_version_4_strips(self):
        reader = reader_with([[]] * 10)
        reader.mode = "fixed"
        result = reader.read(self.card, read_hp=False, flipped=False)
        self.assertEqual({s["label"] for s in result.strips}, {"number-left-tight", "number-right-tight", "number-left-wide", "number-right-wide"})
        self.assertEqual(reader.engine.script.__len__(), 6)

    def test_unknown_orientation_tries_the_turned_card(self):
        reader = reader_with([[]] * 8 + [[("SVI EN 018/091", 0.95, 0, 20)]])
        result = reader.read(self.card, read_hp=False, flipped=None)
        self.assertTrue(result.flipped)
        self.assertEqual(result.number_local, "018")
        self.assertTrue(any(s["flipped"] for s in result.strips))


@unittest.skipUnless(DEPS_AVAILABLE, "numpy / opencv not installed")
class CheckTests(unittest.TestCase):
    def test_names_match_tolerates_a_misread_letter_but_not_another_card(self):
        self.assertTrue(ocr_check.names_match("Charizrd ex", "Charizard ex"))
        self.assertTrue(ocr_check.names_match("Misty's Vitality", "Misty’s Vitality"))
        self.assertFalse(ocr_check.names_match("Pikachu", "Raichu"))
        self.assertFalse(ocr_check.names_match(None, "Pikachu"))

    def test_scores_split_into_buckets_and_summarise(self):
        bucket = ocr_check.new_bucket()
        truth = {"name": "Lapras", "number": "017", "printed_total": 128, "set_abbreviation": "MEE"}
        right = ocr_check.score_read(bucket, truth=truth, name="Lapras", result=ocr.parse_text(["MEE EN 017/128"]), seconds=0.2)
        self.assertEqual(right, {"name": True, "number": True, "total": True, "set_code": True})
        wrong = ocr_check.score_read(bucket, truth=truth, name=None, result=ocr.OcrResult(), seconds=0.6)
        self.assertEqual(sum(wrong.values()), 0)
        summary = ocr_check.summarise(bucket)
        self.assertEqual((summary["n"], summary["number"], summary["number_pct"], summary["name_pct"]), (2, 1, 50.0, 50.0))
        self.assertEqual(summary["seconds_p95"], 0.6)

    def test_variant_read_reports_none_when_it_would_change_nothing(self):
        reader = reader_with([])
        self.assertIsNone(ocr_check.read_variant(reader, np.full((880, 630, 3), 120, np.uint8), "deglare"))


@unittest.skipUnless(DEPS_AVAILABLE, "numpy / opencv not installed")
class MissStripTests(unittest.TestCase):
    def test_strips_are_kept_out_of_the_list_and_drawn_for_the_full_view(self):
        import tempfile
        import json
        from pathlib import Path

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / "misses" / "run-1"
            run.mkdir(parents=True)
            card = (np.random.default_rng(3).integers(0, 255, (880, 630, 3))).astype("uint8")
            (run / "a-card-full.jpg").write_bytes(misses.card_full(card))
            (run / "a-photo.jpg").write_bytes(b"x")
            (run / "a-card.jpg").write_bytes(b"x")
            strip = {"label": "bottom-band", "box": [0, 0.885, 1, 1], "variant": "plain", "zoom": 2.0, "flipped": False, "lines": [{"text": "018/091", "score": 0.9}]}
            item = {"key": "a", "tags": ["other"], "ocr": {"strips": [strip], "name": None}}
            (root / "misses" / "latest.json").write_text(json.dumps({"run": "run-1", "created_at": "t", "matcher_version": "5", "scans": 1, "misses": 1, "tags": {}, "counts": {}, "items": [item]}))
            listing = misses.page(data_dir=root)
            self.assertNotIn("strips", listing["items"][0]["ocr"])
            views = misses.strip_views("a", root)
            self.assertEqual(len(views), 1)
            self.assertTrue(views[0]["image"].startswith("data:image/jpeg;base64,"))
            self.assertEqual(views[0]["lines"][0]["text"], "018/091")
            self.assertIsNone(misses.strip_views("missing", root))


@unittest.skipUnless(DEPS_AVAILABLE, "numpy / opencv not installed")
class RealEngineTests(unittest.TestCase):
    """The real recogniser on synthetic cards at both stored resolutions (skipped when RapidOCR is not installed)."""

    @classmethod
    def setUpClass(cls):
        try:
            cls.reader = ocr.OcrReader(threads=2)
        except Exception as error:  # the library is optional in some environments
            raise unittest.SkipTest(f"RapidOCR unavailable: {error}")

    def test_it_reads_most_numbers_and_names_at_both_resolutions(self):
        report = ocr_synthetic.measure(self.reader, 12, seed=300)
        for resolution, row in report.items():
            self.assertGreaterEqual(row["number"], 60, resolution)
            self.assertGreaterEqual(row["name"], 75, resolution)

    def test_the_new_way_is_not_worse_than_the_fixed_strips_when_the_card_is_framed_loosely(self):
        scores = {}
        for mode in ("fixed", "detect"):
            self.reader.mode = mode
            report = ocr_synthetic.measure(self.reader, 24, seed=700, margin=0.05, resolutions={"1024": 880})
            scores[mode] = report["1024"]["number"] + report["1024"]["name"]
        self.reader.mode = "detect"
        self.assertGreaterEqual(scores["detect"], scores["fixed"])


if __name__ == "__main__":
    unittest.main()
