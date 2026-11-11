"""Matcher version 6: the winner rule, the new default, fastread, the per-step table, the resolution groups,
the fallback when the card is not found, and the autorun order."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    import numpy as np

    from services.card_match import MATCHER_VERSION, benchmark, detect, embed, images, index, jobs, misses, ocr, ocr_check, pipeline, variants
    from tests.test_card_match import IndexAndPipelineTests, card_picture

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def row(label, top20, decided, p95, wrong=0):
    return {"label": label, "status": "ok", "top20": top20, "decided": decided, "decided_wrong": wrong, "p95_ms": p95}


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class WinnerAndDefaultTests(unittest.TestCase):
    def test_a_set_a_little_over_the_bar_is_not_thrown_out_by_noise_and_the_real_rows_pick_the_tta_set(self):
        rows = [
            row("names+number+text+art", 96.4, 67.6, 1346.6),
            row("names+number+text+art+tta", 97.1, 71.2, 1559.6),
            row("names+number+text+art+base", 97.8, 69.1, 1554.9),
        ]
        self.assertEqual(benchmark.pick_winner(rows)["label"], "names+number+text+art+tta")
        self.assertEqual(benchmark.PICK_MAX_P95_MS, 1650)
        self.assertEqual(benchmark.BAR_P95_MS, 1500)  # the displayed bar is unchanged
        # Over 10%: still out. Wrong decisions: still decide first.
        rows[1] = row("names+number+text+art+tta", 97.1, 71.2, 1651)
        self.assertEqual(benchmark.pick_winner(rows[:2])["label"], "names+number+text+art")
        rows[1] = row("names+number+text+art+tta", 97.1, 71.2, 1560, wrong=1)
        self.assertEqual(benchmark.pick_winner(rows[:2])["label"], "names+number+text+art")

    def test_an_old_chosen_file_cannot_hold_back_the_new_default_but_a_current_one_still_counts(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"CARD_MATCH_OPTIONS": ""}):
            data_dir = Path(tmp)
            (data_dir / "chosen.json").write_text(json.dumps({"label": "names", "matcher_version": "5"}), encoding="utf-8")
            self.assertEqual(variants.active_label(data_dir), variants.DEFAULT_LABEL)
            (data_dir / "chosen.json").write_text(json.dumps({"label": "names"}), encoding="utf-8")  # no version at all
            self.assertEqual(variants.active_label(data_dir), variants.DEFAULT_LABEL)
            variants.save_chosen("names+art", "test", data_dir)
            self.assertEqual(variants.active_label(data_dir), "names+art")

    def test_the_default_uses_artwork_and_extra_views_and_stays_safe_without_the_indexes(self):
        self.assertEqual(variants.DEFAULT_LABEL, "names+number+text+art+tta+fastread+corners")
        self.assertEqual(MATCHER_VERSION, "8")
        options = variants.parse(variants.DEFAULT_LABEL)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(variants.missing_indexes(options, Path(tmp)), [variants.ART_INDEX])
            usable = variants.usable(options, Path(tmp))
            # only the artwork part is left out; the name, number, text and extra-view options stay
            self.assertEqual((usable.art, usable.tta, usable.names, usable.number, usable.text), (False, True, True, True, True))

    def test_fastread_is_an_option_and_a_comparison_row_after_the_set_it_speeds_up(self):
        label = "names+number+text+art+tta+fastread"
        self.assertTrue(variants.parse(label).fastread)
        self.assertEqual(variants.parse(label).label, label)
        self.assertTrue(variants.parse(variants.DEFAULT_LABEL).fastread)  # version 7: measured as accurate and 144 ms faster
        self.assertIn(label, variants.COMPARE_LABELS)
        self.assertNotIn("names+number+text+art+tta", variants.COMPARE_LABELS)  # its fastread twin replaced it
        self.assertEqual(variants.needed_indexes(variants.parse(label)), [variants.ART_INDEX])
        self.assertLessEqual(len(variants.SYNTHETIC_COMPARE_LABELS) * variants.SYNTHETIC_COMPARE_COUNT, 600)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class FastReadTests(unittest.TestCase):
    def test_the_fast_ladders_leave_out_black_and_white_and_glare_removal_and_use_a_lower_budget(self):
        slow = {"binary", "deglare"}
        self.assertTrue(slow & {step[2] for step in ocr.NUMBER_LADDER})
        self.assertTrue(slow & {step[2] for step in ocr.NAME_LADDER})
        self.assertFalse(slow & {step[2] for step in ocr.NUMBER_LADDER_FAST})
        self.assertFalse(slow & {step[2] for step in ocr.NAME_LADDER_FAST})
        # nothing else is lost: the early steps are the same, in the same order
        self.assertEqual(ocr.NUMBER_LADDER_FAST, tuple(s for s in ocr.NUMBER_LADDER if s[2] not in slow))
        self.assertEqual(ocr.FAST_BUDGET_SECONDS, 0.9)
        self.assertLess(ocr.FAST_BUDGET_SECONDS, ocr.BUDGET_SECONDS)

    def test_the_matcher_asks_the_reader_for_the_short_ladder_only_when_fastread_is_on(self):
        seen = []

        class Reader:
            def read(self, card, read_hp=False, flipped=None, **kwargs):
                seen.append(("read", kwargs))
                return ocr.OcrResult(number_local="4", number_total="5")

            def read_name(self, card, flipped=False, **kwargs):
                seen.append(("name", kwargs))
                return type("N", (), {"name": None, "raw": [], "strips": [], "hp": None})()

        card = np.zeros((880, 630, 3), dtype=np.uint8)
        for fast in (False, True):
            seen.clear()
            matcher = pipeline.CardMatcher(None, None, None, Reader(), names=object(), fastread=fast)
            matcher._text_usable = lambda *_a: (2, 0)
            matcher._read_text(card, False, use_names=True)
            self.assertEqual(seen, [("read", {"fast": True}), ("name", {"fast": True})] if fast else [("read", {}), ("name", {})])


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class StepTableTests(unittest.TestCase):
    def strips(self, *steps):
        return [{"label": label, "variant": variant, "ms": ms, "flipped": False, "after": after} for label, variant, ms, after in steps]

    def test_each_scan_is_counted_at_the_first_step_that_had_the_right_number_with_the_time_used(self):
        acc = ocr_check.new_steps()
        right = lambda after: after.get("number") == "58"  # noqa: E731
        first = self.strips(("number-left-tight", "plain", 100.0, {"number": None}), ("bottom-band", "plain", 300.0, {"number": "58"}),
                            ("bottom-band", "binary", 500.0, {"number": "58"}))
        late = self.strips(("number-left-tight", "plain", 100.0, {"number": "5"}), ("bottom-band", "plain", 300.0, {"number": "5"}),
                           ("bottom-band", "binary", 500.0, {"number": "58"}))
        never = self.strips(("number-left-tight", "plain", 100.0, {"number": "7"}))
        for strips in (first, late, never):
            acc["scans"] += 1
            ocr_check.add_steps(acc, strips, "number", right)
        table = {r["step"]: r for r in ocr_check.summarise_steps(acc)["number"]}
        self.assertEqual(table["number-left-tight / plain"]["first_right"], 0)
        self.assertEqual(table["bottom-band / plain"]["first_right"], 1)
        self.assertEqual(table["bottom-band / binary"]["first_right"], 1)  # only the scan that needed it
        self.assertEqual(table["bottom-band / binary"]["run"], 2)
        self.assertEqual(table["bottom-band / binary"]["mean_ms"], 500.0)
        self.assertEqual(ocr_check.summarise_steps(acc)["never_number"], 1)
        self.assertEqual([r["step"] for r in ocr_check.summarise_steps(acc)["number"]][0], "number-left-tight / plain")

    def test_only_the_steps_of_the_reading_that_was_kept_are_counted(self):
        acc = ocr_check.new_steps()
        mixed = self.strips(("number-left-tight", "plain", 100.0, {"number": None}))
        mixed.append({"label": "number-left-tight", "variant": "plain", "ms": 90.0, "flipped": True, "after": {"number": "58"}})
        ocr_check.add_steps(acc, mixed, "number", lambda a: a.get("number") == "58", flipped=False)
        self.assertEqual(ocr_check.summarise_steps(acc)["never_number"], 1)

    def test_the_reader_records_the_time_and_the_result_after_each_step(self):
        class Reader(ocr.OcrReader):
            def __init__(self):
                self._lock = __import__("threading").Lock()
                self._whole = {}
                self.mode = "detect"

            def _run(self, picture, *, low=False):
                return [ocr.Line("58/102", 0.95, 0, 0, 100, 20)]

        result = Reader().read(np.full((880, 630, 3), 120, dtype=np.uint8), read_hp=False, flipped=False)
        steps = [s for s in result.strips if "after" in s]
        self.assertTrue(steps)
        self.assertEqual(steps[-1]["after"]["number"], "58")
        self.assertTrue(all("ms" in s for s in result.strips))

    def test_the_resolution_test_is_the_one_the_ocr_check_uses(self):
        self.assertEqual(ocr_check.resolution_of(None), "1024")
        self.assertEqual(ocr_check.resolution_of(np.zeros((880, 630, 3), dtype=np.uint8)), "1024")
        self.assertEqual(ocr_check.resolution_of(np.zeros((1408, 1008, 3), dtype=np.uint8)), "full")


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class GroupTests(unittest.TestCase):

    def test_confirmed_scans_are_counted_once_per_scan_as_the_benchmarks_group_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / "user-1" / "2026-11-01"
            folder.mkdir(parents=True)
            (folder / "p.jpg").write_bytes(b"x")
            for name, job, item in (("a.json", 5, 1), ("b.json", 5, 1), ("c.json", 5, 2)):  # a and b: two attempts of one scan
                (folder / name).write_text(json.dumps({"user_id": 1, "job_id": job, "item_id": item, "ground_truth": "x-1", "image_file": "p.jpg"}), encoding="utf-8")
            (folder / "d.json").write_text(json.dumps({"user_id": 1, "job_id": 6, "item_id": 1, "ground_truth": "x-2", "image_file": "gone.jpg"}), encoding="utf-8")
            self.assertEqual(benchmark.count_labelled_traces(root), 2)
            self.assertEqual(len(ocr_check.labelled_traces(root)), 2)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class FallbackTests(unittest.TestCase):
    setUp = IndexAndPipelineTests.setUp
    _cache = IndexAndPipelineTests._cache
    build = IndexAndPipelineTests.build

    def matcher(self, number, total):
        self.build()
        loaded = index.load_index(self.embedder.name, self.data_dir)

        class Reader:
            def read(self_inner, card, read_hp=False, flipped=None, **_kw):
                return ocr.OcrResult(number_local=number, number_total=total, tokens=["TST"])

        return pipeline.CardMatcher(loaded, self.embedder, pipeline.db_candidate_loader(self.Session), Reader())

    def card(self, found):
        flat = np.asarray(self.pictures["c4"].resize((detect.CARD_W, detect.CARD_H)))
        return detect.Detection(card=flat, found=found, confidence=0.9 if found else 0.2, method="contour" if found else "guide_crop",
                                corners=[(0.0, 0.0), (9.0, 0.0), (9.0, 9.0), (0.0, 9.0)] if found else [])

    def run_match(self, number, total, *, recognition_found, full_found=None):
        matcher = self.matcher(number, total)
        photo = np.zeros((600, 450, 3), dtype=np.uint8)
        calls = []

        def fake_detect(picture):
            calls.append(picture is photo)
            return self.card(recognition_found if picture is photo else bool(full_found))

        with patch.object(detect, "detect_card", side_effect=fake_detect):
            return matcher.match(photo, full_photo=None if full_found is None else np.ones((900, 700, 3), dtype=np.uint8)), calls

    def test_a_normal_find_has_no_fallback_and_can_be_decided_by_the_picture_alone(self):
        outcome, calls = self.run_match(None, None, recognition_found=True)
        self.assertIsNone(outcome.detection["fallback"])
        self.assertTrue(outcome.detection["found"])
        self.assertEqual(outcome.status, "decided")  # control: the same card, found, no number -> the picture decides
        self.assertEqual(calls, [True])

    def test_no_card_on_the_recognition_image_and_none_on_the_full_photo_reads_the_guide_crop_and_never_counts_as_found(self):
        outcome, calls = self.run_match(None, None, recognition_found=False, full_found=False)
        self.assertEqual(outcome.detection["fallback"], "guide_crop")
        self.assertFalse(outcome.detection["found"])
        self.assertEqual(calls, [True, False])  # the full photo was tried first
        self.assertTrue(outcome.matches)  # the fallback card still adds and ranks candidates
        # the picture matches this card exactly, yet with no number read it must not decide
        self.assertEqual((outcome.status, outcome.unsure_reason), ("unsure", "card_not_found_no_number_read"))

    def test_a_fallback_read_must_not_decide_without_a_number_but_may_with_a_number_the_picture_agrees_with(self):
        for recognition, full in ((False, False), (False, True)):
            none_read, _ = self.run_match(None, None, recognition_found=recognition, full_found=full)
            self.assertIsNone(none_read.decision)
            read, _ = self.run_match("4", "5", recognition_found=recognition, full_found=full)
            self.assertEqual(read.status, "decided")
            self.assertEqual(read.decision["card_id"], "tst-4_en")
            wrong, _ = self.run_match("2", "5", recognition_found=recognition, full_found=full)  # a number the picture disagrees with
            self.assertIsNone(wrong.decision)

    def test_the_full_photo_is_the_first_fallback_and_is_not_a_real_find(self):
        outcome, calls = self.run_match("4", "5", recognition_found=False, full_found=True)
        self.assertEqual(outcome.detection["fallback"], "full_photo")
        self.assertEqual(outcome.detection["corners_space"], "full_photo")
        self.assertFalse(outcome.detection["found"])  # "Card found" counts real finds on the recognition image only
        self.assertEqual(outcome.ocr["text_input"]["source"], "full_photo")

    def test_decide_blocks_every_picture_only_lane_for_a_fallback_card(self):
        top = {"_rank": 1, "_similarity": 0.95, "number": "4", "name": "Mon", "_db_id": "a"}
        other = {"_rank": 2, "_similarity": 0.50, "number": "9", "name": "Other", "_db_id": "b"}
        chosen, _ = pipeline.decide({"number_local": None}, [top, other])
        self.assertEqual(chosen["mechanism"], "picture_lead")
        self.assertEqual(pipeline.decide({"number_local": None}, [top, other], fallback=True), (None, "card_not_found_no_number_read"))
        # a number read that names nothing among the candidates: a very clear picture may decide a normal card, not a fallback one
        chosen, _ = pipeline.decide({"number_local": "77"}, [top, other])
        self.assertEqual(chosen["mechanism"], "picture_lead_strong")
        self.assertIsNone(pipeline.decide({"number_local": "77"}, [top, other], fallback=True)[0])
        # the number was filled in from a lookup, not read from the card
        self.assertIsNone(pipeline.decide({"number_local": "4"}, [top, other], fallback=True, number_read=False)[0])

    def test_misses_tag_and_list_fallback_scans_first(self):
        tags = misses.tag_miss(found=False, rotated=False, truth={"card_id": "x"}, others=[], stats=None, fallback="guide_crop")
        self.assertEqual(tags[:2], ["fallback", "not_found"])
        self.assertEqual(misses.primary_tag(tags), "fallback")
        self.assertIn("fallback", misses.TAGS)
        full = misses.tag_miss(found=False, rotated=False, truth={"card_id": "x"}, others=[], stats=None, fallback="full_photo")
        self.assertIn("fallback", full)
        self.assertNotIn("fallback", misses.tag_miss(found=True, rotated=False, truth={"card_id": "x"}, others=[], stats=None))


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class AutorunOrderTests(unittest.TestCase):
    def test_real_photo_steps_come_before_the_synthetic_ones_and_before_the_builds_when_the_indexes_exist(self):
        plan = jobs.autorun_plan(indexes_ready=True, enough_real=True)
        self.assertEqual(plan, ["ocr-check", "labelled", "compare-labelled", "warm-up", "index", "art-index", "synthetic", "compare-synthetic"])

    def test_on_a_first_run_the_indexes_are_built_first_but_real_photos_still_beat_synthetic(self):
        plan = jobs.autorun_plan(indexes_ready=False, enough_real=True)
        self.assertEqual(plan, ["warm-up", "index", "art-index", "ocr-check", "labelled", "compare-labelled", "synthetic", "compare-synthetic"])
        self.assertEqual(jobs.autorun_plan(indexes_ready=True, enough_real=False), ["warm-up", "index", "art-index", "synthetic", "compare-synthetic"])


if __name__ == "__main__":
    unittest.main()
