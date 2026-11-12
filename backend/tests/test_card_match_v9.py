"""Matcher version 9: the whole-picture second read (wholeread) and third view (wholeview), the capture-quality measurement, the
comparison rows and the corners-check wording data."""
import os
import sys
import threading
import types
import unittest
from unittest.mock import patch

if os.name == "nt":  # api.recognize imports fcntl through the auth service; CI is Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

try:
    import numpy as np

    from services.card_match import MATCHER_VERSION, corners_check, detect, index, ocr, ocr_check, pipeline, variants
    from tests import test_card_match as base_tests

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

BEST = "names+number+text+art+tta+fastread+corners+wholepic"


@skip
class OptionAndComparisonTests(unittest.TestCase):
    def test_the_wholeread_option_and_its_label_order(self):
        self.assertFalse(variants.parse(variants.DEFAULT_LABEL).wholeread)  # an option the server must measure first
        self.assertEqual(variants.parse(BEST + "+wholeread").label, BEST + "+wholeread")
        self.assertEqual(variants.needed_indexes(variants.parse(BEST + "+wholeread")), [variants.ART_INDEX])
        self.assertNotIn("wholeview", variants.ORDER)  # removed in version 10


class StageReader(ocr.OcrReader if DEPS_AVAILABLE else object):
    """A reader whose recogniser sees nothing: only which regions the stages ask for matters."""

    def __init__(self):
        self._lock = threading.Lock()
        self._whole = {}
        self.mode = "detect"

    def _run(self, picture, *, low=False):
        return []


@skip
class ReaderStageTests(unittest.TestCase):
    def labels(self, stage, **kw):
        result = StageReader().read(np.full((880, 630, 3), 120, dtype=np.uint8), read_hp=False, flipped=False, fast=True, stage=stage, **kw)
        return [strip["label"] for strip in result.strips]

    def test_quick_reads_only_the_first_three_steps_and_no_last_resort(self):
        self.assertEqual(self.labels("quick", budget=5.0), ["number-left-tight", "number-right-tight", "bottom-band"])

    def test_first_is_the_ladder_without_the_last_resort_band_and_last_is_that_band_alone(self):
        first, last = self.labels("first"), self.labels("last")
        self.assertNotIn("bottom-wide", first)
        self.assertIn("number-left-tight", first)
        self.assertEqual(last, ["bottom-wide"])
        self.assertIn("bottom-wide", self.labels("all"))  # unchanged default

    def test_a_tiny_budget_still_reads_one_step_and_stops(self):
        self.assertEqual(self.labels("quick", budget=-1.0), ["number-left-tight"])

    def test_merge_keeps_every_line_and_region_and_tags_the_second_readings_regions(self):
        old = ocr.OcrResult(lines=["a"], strips=[{"label": "bottom-band"}], seconds=0.5, attempts=2, flipped=True, hp="70")
        new = ocr.OcrResult(number_local="058", number_total="102", number_confidence=0.9, lines=["058/102"], strips=[{"label": "number-left-tight"}], seconds=0.2, attempts=1)
        merged = ocr.merge_reads(old, new, "whole_picture", "whole-")
        self.assertEqual((merged.number_local, merged.number_total), ("058", "102"))
        self.assertEqual(merged.lines, ["a", "058/102"])
        self.assertEqual([s["label"] for s in merged.strips], ["bottom-band", "whole-number-left-tight"])
        self.assertEqual(merged.strips[1]["source"], "whole_picture")
        self.assertEqual((merged.seconds, merged.attempts, merged.flipped, merged.hp), (0.7, 3, True, "70"))

    def test_merge_does_not_replace_a_complete_number_with_a_less_complete_one(self):
        old = ocr.OcrResult(number_local="058", number_total="102", number_confidence=0.9)
        merged = ocr.merge_reads(old, ocr.OcrResult(number_local="12", number_confidence=0.99), "whole_picture", "whole-")
        self.assertEqual((merged.number_local, merged.number_total), ("058", "102"))


class SecondReadReader:
    """Reads nothing from the finder's card; reads 4/5 from the whole picture. Records every call."""

    def __init__(self, first_seconds=0.0, quick_number=("4", "5")):
        self.calls = []
        self.first_seconds = first_seconds
        self.quick_number = quick_number

    def read(self, card, read_hp=False, flipped=None, **kwargs):
        self.calls.append(kwargs)
        stage = kwargs.get("stage")
        if stage == "quick":
            number, total = self.quick_number
            return ocr.OcrResult(number_local=number, number_total=total, number_confidence=0.9, tokens=["TST"], seconds=0.2,
                                 strips=[{"label": "number-left-tight", "flipped": False, "after": {"number": number, "total": total}}])
        if stage == "last":
            return ocr.OcrResult(seconds=0.3, strips=[{"label": "bottom-wide", "flipped": False, "after": {"number": None, "total": None}}])
        # a number without its total: usable (so the matcher does not also read the card turned), but not complete
        return ocr.OcrResult(number_local="4", number_confidence=0.5, seconds=self.first_seconds,
                             strips=[{"label": "number-left-tight", "flipped": False, "after": {"number": "4", "total": None}}])


@skip
class WholeReadMatcherTests(unittest.TestCase):
    setUp = base_tests.IndexAndPipelineTests.setUp
    _cache = base_tests.IndexAndPipelineTests._cache
    build = base_tests.IndexAndPipelineTests.build

    def matcher(self, reader, **options):
        self.build()
        loaded = index.load_index(self.embedder.name, self.data_dir)
        return pipeline.CardMatcher(loaded, self.embedder, pipeline.db_candidate_loader(self.Session), reader, **options)

    def found(self, method="contour"):
        flat = np.asarray(self.pictures["c4"].resize((detect.CARD_W, detect.CARD_H)))
        return detect.Detection(card=flat, found=method == "contour", confidence=0.9, method=method,
                                corners=[(0.0, 0.0), (9.0, 0.0), (9.0, 9.0), (0.0, 9.0)])

    def run_match(self, reader, *, photo=None, method="contour", **options):
        matcher = self.matcher(reader, **options)
        photo = np.zeros((628, 450, 3), np.uint8) if photo is None else photo  # 450 x 628: a guide picture
        with patch.object(detect, "detect_card", return_value=self.found(method)):
            return matcher.match(photo)

    def test_the_whole_picture_completes_a_number_the_finders_card_did_not_give(self):
        reader = SecondReadReader()
        outcome = self.run_match(reader, fastread=True, wholeread=True)
        self.assertEqual((outcome.ocr["number_local"], outcome.ocr["number_total"]), ("4", "5"))
        self.assertEqual(outcome.ocr["wholeread"]["tried"], True)
        self.assertEqual(outcome.ocr["wholeread"]["rescued"], True)
        self.assertIsNone(outcome.ocr["wholeread"]["skipped"])
        labels = [strip["label"] for strip in outcome.ocr["strips"]]
        self.assertEqual(labels, ["number-left-tight", "whole-number-left-tight"])  # the table can tell what the extra regions rescued
        self.assertEqual([s.get("stage") for s in reader.calls], ["first", "quick"])  # the last-resort band is not needed: the number is complete
        self.assertEqual(reader.calls[1]["budget"], pipeline.WHOLEREAD_MAX_SECONDS)
        self.assertTrue(all(call.get("fast") for call in reader.calls))

    def test_the_last_resort_band_runs_after_the_second_read_only_when_a_number_is_still_missing(self):
        reader = SecondReadReader(quick_number=(None, None))
        outcome = self.run_match(reader, fastread=True, wholeread=True)
        self.assertEqual([c.get("stage") for c in reader.calls], ["first", "quick", "last"])
        self.assertFalse(outcome.ocr["wholeread"]["rescued"])
        self.assertEqual(outcome.ocr["wholeread"]["last_resort"], "read")

    def test_no_time_left_skips_the_second_read_and_says_so_and_never_runs_over_the_budget(self):
        reader = SecondReadReader(first_seconds=pipeline.WHOLEREAD_TOTAL * ocr.FAST_BUDGET_SECONDS - 0.05)
        outcome = self.run_match(reader, fastread=True, wholeread=True)
        self.assertEqual(outcome.ocr["wholeread"]["skipped"], "budget")
        self.assertFalse(outcome.ocr["wholeread"]["tried"])
        self.assertEqual([c.get("stage") for c in reader.calls], ["first", "last"])  # only the band the old ladder would have run
        over = SecondReadReader(first_seconds=pipeline.WHOLEREAD_TOTAL * ocr.FAST_BUDGET_SECONDS + 0.5)
        outcome = self.run_match(over, fastread=True, wholeread=True)
        self.assertEqual([c.get("stage") for c in over.calls], ["first"])  # the old ladder would not have started its band either
        self.assertEqual(outcome.ocr["wholeread"]["last_resort"], "skipped")

    def test_never_for_a_scan_that_already_used_the_whole_picture_a_complete_number_or_a_picture_that_is_not_a_guide_crop(self):
        reader = SecondReadReader()
        outcome = self.run_match(reader, fastread=True, wholeread=True, method="whole_picture")
        self.assertNotIn("wholeread", outcome.ocr)
        self.assertNotIn("quick", [c.get("stage") for c in reader.calls])
        self.assertNotIn("first", [c.get("stage") for c in reader.calls])  # an ordinary full ladder
        wide = SecondReadReader()
        outcome = self.run_match(wide, fastread=True, wholeread=True, photo=np.zeros((600, 450, 3), np.uint8))  # 3:4, not card-shaped
        self.assertNotIn("wholeread", outcome.ocr)
        self.assertNotIn("quick", [c.get("stage") for c in wide.calls])

        class Complete(SecondReadReader):
            def read(self, card, read_hp=False, flipped=None, **kwargs):
                self.calls.append(kwargs)
                return ocr.OcrResult(number_local="4", number_total="5", number_confidence=0.9, strips=[])

        done = Complete()
        outcome = self.run_match(done, fastread=True, wholeread=True)
        self.assertNotIn("wholeread", outcome.ocr)
        self.assertEqual(len(done.calls), 1)

    def test_with_the_option_off_the_reader_is_called_exactly_as_before(self):
        reader = SecondReadReader()
        outcome = self.run_match(reader, fastread=True)
        self.assertEqual(reader.calls, [{"fast": True}])
        self.assertNotIn("wholeread", outcome.ocr)

    def test_a_reader_that_does_not_know_stages_is_untouched_when_the_option_is_off(self):
        class Old:
            def read(self, card, read_hp=False, flipped=None):
                return ocr.OcrResult(number_local="4", number_total="5", seconds=0.0)

        self.assertEqual(self.run_match(Old()).ocr["number_local"], "4")


@skip
class CaptureQualityTests(unittest.TestCase):
    def stats(self, sharp, mean=120.0, glare=0.01):
        return {"sharpness": sharp, "mean": mean, "glare": glare}

    def test_medians_split_by_number_read_and_per_set_with_the_low_light_or_blur_share(self):
        acc = ocr_check.new_capture()
        for sharp in (40, 41, 42):
            ocr_check.add_capture(acc, "Black Bolt", self.stats(sharp), True)
        for sharp, mean in ((18, 120), (20, 60), (60, 120)):  # two of the three misses are under the blur or the dark threshold
            ocr_check.add_capture(acc, "Black Bolt", self.stats(sharp, mean), False)
        for _ in range(5):
            ocr_check.add_capture(acc, "Pitch Black", self.stats(55), True)
        ocr_check.add_capture(acc, "Tiny Set", self.stats(10), False)  # one scan: not listed
        ocr_check.add_capture(acc, "Black Bolt", None, False)  # nothing measured: ignored
        summary = ocr_check.summarise_capture(acc)
        black = next(item for item in summary["sets"] if item["set"] == "Black Bolt")
        self.assertEqual((black["read"]["n"], black["read"]["sharpness"]), (3, 41))
        self.assertEqual((black["missed"]["n"], black["missed"]["sharpness"]), (3, 20))
        self.assertEqual(black["missed_low_light_or_blur_pct"], 66.7)
        self.assertEqual(black["read_low_light_or_blur_pct"], 0.0)
        self.assertEqual(black["read"]["blown_pct"], 1.0)
        self.assertEqual(summary["sets"][0]["set"], "Black Bolt")  # the set with misses first
        self.assertNotIn("Tiny Set", [item["set"] for item in summary["sets"]])
        self.assertEqual(summary["read"]["n"], 8)
        self.assertEqual(summary["missed"]["n"], 4)  # the whole group counts every measured scan, small sets included
        self.assertEqual(summary["thresholds"], {"brightness": 85, "sharpness": 30.0})

    def test_an_empty_group_has_no_numbers_instead_of_failing(self):
        summary = ocr_check.summarise_capture(ocr_check.new_capture())
        self.assertEqual((summary["scans"], summary["sets"], summary["read"]["sharpness"], summary["missed_low_light_or_blur_pct"]), (0, [], None, None))

    def test_the_stats_come_from_the_flat_card_the_misses_list_already_measures(self):
        from services.card_match import misses

        sharp = np.zeros((880, 630, 3), np.uint8)
        sharp[::8] = 255
        flat = np.full((880, 630, 3), 128, np.uint8)
        a, b = misses.card_stats(sharp), misses.card_stats(flat)
        self.assertGreater(a["sharpness"], b["sharpness"])
        self.assertEqual(set(a), {"glare", "mean", "sharpness"})


@skip
class WholeReadCheckTests(unittest.TestCase):
    class Reader:
        mode = "detect"

        def __init__(self):
            self.calls = []

        def read(self, card, read_hp=False, flipped=None, **kwargs):
            self.calls.append((card.shape, flipped, kwargs))
            return ocr.OcrResult(number_local="58", number_total="102", number_confidence=0.9, seconds=0.2,
                                 strips=[{"label": "number-left-tight", "flipped": False, "after": {"number": "58", "total": "102"}}])

    def test_a_missing_number_on_a_guide_picture_is_read_again_and_the_first_read_is_left_alone(self):
        first = ocr.OcrResult(strips=[{"label": "bottom-band", "flipped": False, "after": {"number": None}}], lines=["x"])
        reader = self.Reader()
        merged, tried = ocr_check.whole_second_read(reader, lambda: np.zeros((628, 450, 3), np.uint8), first)
        self.assertTrue(tried)
        self.assertEqual(merged.number_local, "58")
        self.assertIsNone(first.number_local)
        self.assertEqual(len(first.strips), 1)
        self.assertEqual([s["label"] for s in merged.strips], ["bottom-band", "whole-number-left-tight"])
        self.assertEqual(reader.calls[0][2]["stage"], "quick")

    def test_no_second_read_for_a_complete_number_or_a_picture_that_is_not_a_guide_crop(self):
        reader = self.Reader()
        done = ocr.OcrResult(number_local="1", number_total="2")
        self.assertEqual(ocr_check.whole_second_read(reader, lambda: np.zeros((628, 450, 3), np.uint8), done), (done, False))
        empty = ocr.OcrResult()
        self.assertEqual(ocr_check.whole_second_read(reader, np.zeros((600, 450, 3), np.uint8), empty), (empty, False))
        self.assertEqual(ocr_check.whole_second_read(reader, None, empty), (empty, False))
        self.assertEqual(reader.calls, [])

    def test_the_step_table_shows_the_whole_picture_steps_as_their_own_rows(self):
        acc = ocr_check.new_steps()
        acc["scans"] = 1
        merged_strips = [{"label": "bottom-band", "variant": "plain", "ms": 100.0, "flipped": False, "after": {"number": None}},
                         {"label": "whole-number-left-tight", "variant": "plain", "ms": 80.0, "flipped": False, "after": {"number": "58"}, "source": "whole_picture"}]
        ocr_check.add_steps(acc, merged_strips, "number", lambda after: after.get("number") == "58", flipped=False)
        rows = {row["label"]: row for row in ocr_check.summarise_steps(acc)["number"]}
        self.assertEqual(rows["whole-number-left-tight"]["first_right"], 1)
        self.assertEqual(rows["bottom-band"]["first_right"], 0)


@skip
class CornersWordingDataTests(unittest.TestCase):
    def test_the_group_says_how_often_the_number_was_missed_in_it_and_overall(self):
        def row(guide, quad, number_read):
            return {"batch": "new", "set": "S", "guide": guide, "whole": guide, "quad": quad, "number_read": number_read, "refused": None,
                    "coverage": 0.8, "ratio_error": 0.0, "angle_deviation": 1.0, "wide_over_tall": 0.7}

        rows = [row(0.9, 0.5, False), row(0.9, 0.5, True), row(0.9, 0.5, True), row(0.9, 0.5, True),  # four spoiled, one missed: 25%
                row(0.9, 0.9, False), row(0.9, 0.9, True), row(0.9, 0.9, True), row(0.9, 0.9, True)]  # the rest: 25% too
        summary = corners_check.summarise(rows)["all"]
        self.assertEqual(summary["spoiled_no_number_pct"], 25.0)
        self.assertEqual(summary["no_number_all_pct"], 25.0)
        none = corners_check.summarise([])["all"]
        self.assertIsNone(none["spoiled_no_number_pct"])
        self.assertIsNone(none["no_number_all_pct"])


if __name__ == "__main__":
    unittest.main()
