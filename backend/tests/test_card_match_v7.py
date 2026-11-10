"""Matcher version 7: the paired reading test and the never-right buckets (OCR check), ``tworeads``, the step table's real
time, the find order with the whole review photo, the light guide-frame read, and the decided-wrong list."""
import os
import sys
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

    from services.card_match import MATCHER_VERSION, detect, misses, ocr, ocr_check, pipeline, variants
    from tests.test_card_match import IndexAndPipelineTests
    from tests.test_card_match_ocr_read import reader_with
    from tests.test_card_match_v6 import FallbackTests

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")


@skip
class OptionAndVersionTests(unittest.TestCase):
    def test_version_default_and_the_new_option(self):
        self.assertEqual(MATCHER_VERSION, "7")
        self.assertEqual(variants.DEFAULT_LABEL, "names+number+text+art+tta+fastread")
        self.assertFalse(variants.parse(variants.DEFAULT_LABEL).tworeads)  # off by default
        label = "names+number+text+art+tta+fastread+numberonce+tworeads"
        self.assertTrue(variants.parse(label).tworeads)
        self.assertEqual(variants.parse(label).label, label)

    def test_the_comparison_has_the_two_new_rows_and_at_most_twelve(self):
        labels = variants.COMPARE_LABELS
        self.assertLessEqual(len(labels), 12)
        self.assertEqual(len(set(labels)), len(labels))
        self.assertIn("names+number+text+art+tta+fastread+numberonce", labels)
        self.assertIn("names+number+text+art+tta+fastread+numberonce+tworeads", labels)
        for label in labels:
            self.assertEqual(variants.parse(label).label, label)  # every row is spelled the way the options print


@skip
class PairedAndNeverRightTests(unittest.TestCase):
    def rights(self, sharp, old, shrunk):
        out = {"sharp": {"number": sharp[0], "name": sharp[1]}, "shrunk": {"number": shrunk[0], "name": shrunk[1]}}
        if old is not None:
            out["recognition"] = {"number": old[0], "name": old[1]}
        return out

    def test_the_paired_table_counts_both_only_the_first_only_the_second_and_neither(self):
        pairs = ocr_check.new_pairs()
        ocr_check.add_pair(pairs, self.rights((True, True), (True, False), (True, True)))
        ocr_check.add_pair(pairs, self.rights((True, True), (False, True), (False, False)))
        ocr_check.add_pair(pairs, self.rights((False, False), (True, True), (False, True)))
        ocr_check.add_pair(pairs, self.rights((False, False), (False, False), (False, False)))
        ocr_check.add_pair(pairs, self.rights((True, True), None, (True, True)))  # no card found in the recognition image
        self.assertEqual(pairs["scans"], 5)
        self.assertEqual(pairs["no_old_card"], 1)
        old = pairs["tests"]["sharp_vs_recognition"]
        self.assertEqual(old["number"], {"both": 1, "only_first": 1, "only_second": 1, "neither": 1})
        self.assertEqual(old["name"], {"both": 1, "only_first": 1, "only_second": 1, "neither": 1})
        shrunk = pairs["tests"]["sharp_vs_shrunk"]  # all five scans have a shrunk reading
        self.assertEqual(sum(shrunk["number"].values()), 5)
        self.assertEqual(shrunk["number"]["both"], 2)

    def test_the_three_sources_are_the_sharp_card_the_old_size_card_and_the_shrunk_card(self):
        import cv2

        card = np.random.default_rng(1).integers(0, 255, (1389, 995, 3), dtype=np.uint8)
        with patch.object(detect, "detect_card", return_value=detect.Detection(card=np.zeros((880, 630, 3), np.uint8), found=True, confidence=0.9, method="contour")), \
                patch("services.card_match.images.decode_rgb", return_value=np.zeros((10, 10, 3), np.uint8)), \
                patch("pathlib.Path.read_bytes", return_value=b"x"):
            from pathlib import Path

            got = ocr_check.paired_pictures(card, Path("/x/trace.json"), {"image_file": "trace.jpg"})
        self.assertEqual(got["recognition"].shape, (880, 630, 3))
        self.assertEqual(got["shrunk"].shape, (880, 630, 3))
        self.assertTrue(np.array_equal(got["shrunk"], cv2.resize(card, (630, 880), interpolation=cv2.INTER_AREA)))

    def test_never_right_is_split_by_what_was_read(self):
        truth = {"number": "018", "printed_total": "091"}
        bucket = ocr_check.number_bucket
        self.assertEqual(bucket([], None, None, truth, ever_right=False), "no_text")
        self.assertEqual(bucket(["[hp] HP 70"], None, None, truth, ever_right=False), "no_text")  # HP lines are not bottom text
        self.assertEqual(bucket(["SVI EN"], None, None, truth, ever_right=False), "no_number_shape")
        self.assertEqual(bucket(["SVI EN 019/091"], "019", "091", truth, ever_right=False), "wrong_number")
        self.assertIsNone(bucket(["018/091"], "018", "091", truth, ever_right=True))
        # the right number with another total than the catalogue prints
        self.assertEqual(bucket(["018/190"], "018", "190", truth, ever_right=True), "total_differs")
        # right at some step, wrong in the end: not a "never right" scan
        self.assertIsNone(bucket(["x"], "019", "091", truth, ever_right=True))

    def test_each_group_keeps_counts_per_cause_and_ten_examples_at_most(self):
        acc = ocr_check.new_never()
        truth = {"name": "Mon", "number": "018", "printed_total": "091", "set_abbreviation": "PBL"}
        for index in range(14):
            result = ocr.OcrResult(number_local=None, lines=["SVI EN", f"line {index}"])
            ocr_check.add_never(acc, "no_number_shape", truth=truth, result=result, name="Mon", trace=f"t{index}")
        ocr_check.add_never(acc, None, truth=truth, result=ocr.OcrResult(), name=None, trace="ok")
        summary = ocr_check.summarise_never(acc)
        row = next(item for item in summary["buckets"] if item["key"] == "no_number_shape")
        self.assertEqual((summary["scans"], row["n"], len(row["examples"])), (15, 14, 10))
        self.assertEqual(row["examples"][0]["truth"], {"number": "018", "total": "091"})
        self.assertEqual(row["examples"][0]["lines"], ["SVI EN", "line 0"])
        self.assertEqual({item["key"] for item in summary["buckets"]}, set(ocr_check.NEVER_BUCKETS))
        self.assertEqual(summary["sets"], [{"set": "PBL", "scans": 15, "wrong": 14}])

    def test_add_steps_says_whether_any_step_was_right(self):
        acc = ocr_check.new_steps()
        strips = [{"label": "a", "variant": "plain", "after": {"number": "1"}}]
        self.assertFalse(ocr_check.add_steps(acc, strips, "number", lambda after: after["number"] == "2"))
        self.assertTrue(ocr_check.add_steps(acc, strips, "number", lambda after: after["number"] == "1"))


@skip
class TwoReadsTests(unittest.TestCase):
    tall = np.full((1389, 995, 3), 180, np.uint8)

    def test_a_tall_card_with_no_complete_number_is_read_again_on_the_880_px_card(self):
        # fast ladder: 2 strips, band, 2 wide strips, local-contrast band = 6 reads, then the tall bottom band (empty), then 3 reads at 880 px
        reader = reader_with([[]] * 6 + [[], [], [("SVI EN 018/091", 0.9, 0, 20)]])
        with patch.object(ocr, "FAST_BUDGET_SECONDS", 60.0):
            result = reader.read(self.tall, read_hp=False, flipped=False, fast=True, two_reads=True)
        self.assertEqual((result.number_local, result.number_total), ("018", "091"))
        second = [strip for strip in result.strips if strip.get("shrunk")]
        self.assertEqual([strip["label"] for strip in second], ["number-left-tight-880", "number-right-tight-880", "bottom-band-880"])
        self.assertEqual(second[-1]["after"], {"number": "018", "total": "091"})

    def test_off_a_short_card_or_a_complete_number_it_does_nothing(self):
        script = [[]] * 6 + [[("SVI EN 018/091", 0.9, 0, 20)]] * 4
        off = reader_with(list(script)).read(self.tall, read_hp=False, flipped=False, fast=True)
        self.assertFalse([s for s in off.strips if s.get("shrunk")])
        short = reader_with(list(script)).read(np.full((880, 630, 3), 180, np.uint8), read_hp=False, flipped=False, fast=True, two_reads=True)
        self.assertFalse([s for s in short.strips if s.get("shrunk")])
        done = reader_with([[("SVI EN 018/091", 0.95, 0, 20)]]).read(self.tall, read_hp=False, flipped=False, fast=True, two_reads=True)
        self.assertEqual([s["label"] for s in done.strips], ["number-left-tight"])

    def test_it_starts_no_step_after_the_time_budget_of_the_first_pass(self):
        reader = reader_with([[]] * 20)
        with patch.object(ocr, "FAST_BUDGET_SECONDS", 0.0):
            result = reader.read(self.tall, read_hp=False, flipped=False, fast=True, two_reads=True)
        self.assertFalse([s for s in result.strips if s.get("shrunk")])

    def test_the_second_look_is_merged_with_the_first_reading(self):
        reader = reader_with([[("018/091", 0.9, 0, 20)]])
        first = ocr.OcrResult(number_local="018", number_total=None, number_confidence=0.5)  # a number but no total
        record: list[dict] = []
        import time

        best, lines, reads = reader._second_look(self.tall, first, record, False, time.monotonic(), 60.0)
        self.assertEqual((best.number_local, best.number_total), ("018", "091"))
        self.assertEqual(reads, 1)
        self.assertEqual(record[0]["label"], "number-left-tight-880")

    def test_the_strip_view_redraws_a_shrunk_region_from_the_shrunk_card(self):
        strip = {"label": "bottom-band-880", "box": ocr.BOTTOM_BAND, "variant": "plain", "zoom": 3.0, "shrunk": True}
        plain = {**strip, "shrunk": False}
        self.assertLess(ocr.render_strip(self.tall, strip).shape[0], ocr.render_strip(self.tall, plain).shape[0])

    def test_the_matcher_passes_it_to_the_number_read_only_and_only_when_on(self):
        seen = []

        class Reader:
            def read(self, card, read_hp=False, flipped=None, **kwargs):
                seen.append(("read", kwargs))
                return ocr.OcrResult(number_local="1", number_total="2")

            def read_name(self, card, flipped=False, **kwargs):
                seen.append(("name", kwargs))
                return types.SimpleNamespace(name="Mon", hp=None, raw=[], strips=[])

        card = np.zeros((880, 630, 3), np.uint8)
        for on in (False, True):
            seen.clear()
            matcher = pipeline.CardMatcher.__new__(pipeline.CardMatcher)
            matcher.ocr_reader, matcher.read_hp, matcher.fastread, matcher.tworeads, matcher.names = Reader(), False, True, on, None
            matcher._text_usable = lambda *a: (1, 1)
            matcher._read_text(card, False, use_names=True)
            self.assertEqual(dict(seen)["read"], {"fast": True, **({"two_reads": True} if on else {})})
            self.assertEqual(dict(seen)["name"], {"fast": True})


@skip
class StepTableTimingTests(unittest.TestCase):
    def test_the_first_tall_band_read_keeps_its_real_time_and_later_reads_are_marked_cached(self):
        reader = reader_with([[("30C | 017/128", 0.8, 100, 130)]])
        card = np.full((880, 630, 3), 180, np.uint8)
        first: list[dict] = []
        with patch("services.card_match.ocr.time.perf_counter", side_effect=[10.0, 10.05]):
            reader._expanded(card, first, False, "bottom")
        self.assertEqual(first[0]["ms"], 50.0)
        self.assertNotIn("cached", first[0])
        later: list[dict] = []
        reader._expanded(card, later, False, "bottom")
        self.assertEqual((later[0]["ms"], later[0]["cached"]), (0.0, True))
        self.assertEqual(reader.engine.calls, 1)
        again: list[dict] = []
        reader._expanded(card, again, False, "bottom")
        self.assertEqual(first[0]["ms"], 50.0)  # the first record is a copy: the cache is not marked
        self.assertEqual(again[0]["cached"], True)


@skip
class FindOrderTests(unittest.TestCase):
    setUp = IndexAndPipelineTests.setUp
    _cache = IndexAndPipelineTests._cache
    build = IndexAndPipelineTests.build
    matcher = FallbackTests.matcher
    card = FallbackTests.card

    def run_match(self, number, total, *, review=None, full=None, recognition_found=False):
        matcher = self.matcher(number, total)
        photo = np.zeros((600, 450, 3), dtype=np.uint8)
        review_photo = np.full((1500, 1100, 3), 5, dtype=np.uint8)
        full_photo = np.full((900, 700, 3), 7, dtype=np.uint8)
        seen = []
        loaded = []

        def fake_detect(picture):
            name = "photo" if picture is photo else "review" if picture is review_photo else "full" if picture is full_photo else "other"
            seen.append(name)
            found = {"photo": recognition_found, "review": bool(review), "full": bool(full)}.get(name, False)
            return self.card(found)

        def lazy():
            loaded.append(1)
            return review_photo

        with patch.object(detect, "detect_card", side_effect=fake_detect):
            outcome = matcher.match(photo, full_photo=full_photo if full is not None else None, review_photo=lazy if review is not None else None)
        return outcome, seen, loaded

    def test_the_whole_review_photo_is_tried_before_the_full_photo_and_the_guide_frame(self):
        outcome, seen, _ = self.run_match("4", "5", review=True, full=True)
        self.assertEqual(seen[:2], ["photo", "review"])
        self.assertNotIn("full", seen)
        self.assertEqual(outcome.detection["fallback"], "review_photo")
        self.assertEqual(outcome.detection["corners_space"], "review_photo")
        self.assertFalse(outcome.detection["found"])  # not a real find on the recognition image
        self.assertEqual(outcome.ocr["text_input"]["source"], "review_photo")

    def test_nothing_found_anywhere_goes_through_both_photos_to_the_guide_frame(self):
        outcome, seen, _ = self.run_match("4", "5", review=False, full=False)
        self.assertEqual(seen[:3], ["photo", "review", "full"])
        self.assertEqual(outcome.detection["fallback"], "guide_crop")

    def test_the_review_photo_is_not_even_read_when_the_card_is_found_normally(self):
        outcome, seen, loaded = self.run_match("4", "5", review=True, recognition_found=True)
        self.assertIsNone(outcome.detection["fallback"])
        self.assertEqual((seen[:1], loaded), (["photo"], []))

    def test_a_card_found_by_the_review_photo_keeps_the_fallback_rule(self):
        none_read, _, _ = self.run_match(None, None, review=True)
        self.assertEqual((none_read.status, none_read.unsure_reason), ("unsure", "card_not_found_no_number_read"))
        right, _, _ = self.run_match("4", "5", review=True)
        self.assertEqual((right.status, right.decision["card_id"]), ("decided", "tst-4_en"))
        wrong, _, _ = self.run_match("2", "5", review=True)  # a number the picture disagrees with
        self.assertIsNone(wrong.decision)

    def test_the_guide_frame_read_is_one_orientation_with_the_short_ladder(self):
        calls = []

        class Reader:
            def read(self, card, read_hp=False, flipped=None, **kwargs):
                calls.append((flipped, kwargs))
                return ocr.OcrResult()  # nothing usable: a normal card would now be tried turned as well

        matcher = pipeline.CardMatcher.__new__(pipeline.CardMatcher)
        matcher.ocr_reader, matcher.read_hp, matcher.fastread, matcher.tworeads, matcher.names = Reader(), False, False, True, None
        card = np.zeros((880, 630, 3), np.uint8)
        matcher._read_text(card, False, use_names=False, light=True)
        self.assertEqual(calls, [(False, {"fast": True})])
        calls.clear()
        matcher._read_text(card, False, use_names=False)
        self.assertEqual([c[0] for c in calls], [False, True])  # a normal read still turns the card


@skip
class DecidedWrongTests(unittest.TestCase):
    def outcome(self, decided_id, ranks):
        matches = [
            {"card_id": cid, "tcg_card_id": cid.removesuffix("_en"), "similarity": sim, "rank": rank, "name": f"Mon {cid}", "number": "7",
             "set": "Set", "printed_total": 91, "picture_rank": rank}
            for cid, rank, sim in ranks
        ]
        decision = {"card_id": decided_id, "tcg_card_id": decided_id.removesuffix("_en"), "mechanism": "number_and_picture", "similarity": 0.83, "lead": 0.07} if decided_id else None
        return types.SimpleNamespace(
            matches=matches, decision=decision, unsure_reason=None, card=np.full((880, 630, 3), 120, np.uint8), text_card=None,
            detection={"found": True, "fallback": None, "corners": [], "confidence": 0.9, "method": "contour"},
            ocr={"number_local": "7", "number_total": "91", "name": "Mon", "lines": ["007/091"], "strips": []}, timings_ms={})

    def collector(self, tmp):
        from pathlib import Path

        def loader(ids):
            return {cid: {"name": cid, "number": "7", "printed_total": 91, "images_small": None, "rarity": "Rare", "set": "Set"} for cid in ids}

        return misses.MissCollector(loader, Path(tmp))

    def add(self, collector, trace, outcome, truth="right_en"):
        with patch.object(misses, "photo_thumb", return_value=b"x"), patch.object(misses, "card_thumb", return_value=b"x"), patch.object(misses, "card_full", return_value=b"x"):
            collector.add(trace=trace, photo=np.zeros((50, 50, 3), np.uint8), outcome=outcome, truth_id=truth)

    def test_a_right_first_pick_that_was_decided_as_another_printing_is_listed_as_decided_wrong(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            collector = self.collector(tmp)
            first_but_wrong = self.outcome("other_en", [("right_en", 1, 0.9), ("other_en", 2, 0.85)])
            decided_right = self.outcome("right_en", [("right_en", 1, 0.9)])
            plain_miss = self.outcome(None, [("other_en", 1, 0.9), ("right_en", 3, 0.5)])
            self.add(collector, "a.json", first_but_wrong)
            self.add(collector, "b.json", decided_right)
            self.add(collector, "c.json", plain_miss)
            report = collector.finish("x")
        self.assertEqual((report["scans"], report["misses"], report["decided_wrong"]), (3, 1, 1))
        wrong = next(item for item in report["items"] if item["trace"] == "a.json")
        self.assertEqual((wrong["kind"], wrong["rank"], wrong["mechanism"], wrong["tags"][0], wrong["primary"]), ("decided_wrong", 1, "number_and_picture", "decided_wrong", "decided_wrong"))
        self.assertEqual((wrong["decided_card"]["tcg_card_id"], wrong["decided_card"]["similarity"], wrong["decided_card"]["number"], wrong["decided_card"]["printed_total"]),
                         ("other", 0.83, "7", 91))
        self.assertEqual((wrong["truth"]["similarity"], wrong["truth"]["printed_total"]), (0.9, 91))
        self.assertEqual((wrong["ocr"]["number"], wrong["ocr"]["total"], wrong["ocr"]["name"]), ("7", "91", "Mon"))
        self.assertEqual(report["counts"]["decided_wrong"], 1)
        self.assertEqual(list(report["tags"])[0], "decided_wrong")  # the first filter
        self.assertNotIn("b.json", [item["trace"] for item in report["items"]])

    def test_a_decided_wrong_scan_that_was_also_a_miss_stays_a_miss_and_is_in_both_groups(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            collector = self.collector(tmp)
            self.add(collector, "d.json", self.outcome("other_en", [("other_en", 1, 0.9), ("right_en", 4, 0.5)]))
            report = collector.finish("x")
            page = misses.page("decided_wrong", data_dir=collector.root.parent)
        self.assertEqual((report["misses"], report["decided_wrong"]), (1, 1))
        self.assertEqual(report["items"][0]["kind"], "not_top1")
        self.assertEqual((page["decided_wrong"], page["total"]), (1, 1))


if DEPS_AVAILABLE:  # imported only to borrow their helpers: do not run them a second time from here
    del IndexAndPipelineTests, FallbackTests


if __name__ == "__main__":
    unittest.main()
