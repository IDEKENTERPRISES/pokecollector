"""Matcher version 10: where a number was read from (number_source), the wholestrict rules for a whole-picture number, the
wrong decisions kept per comparison row, and the option and row housekeeping. Built from generated data only."""
import os
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch

if os.name == "nt":  # api.recognize imports fcntl through the auth service; CI is Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

try:
    import numpy as np  # noqa: F401

    from services import trace_sources
    from services.card_match import MATCHER_VERSION, benchmark, misses, ocr, pipeline, variants
    from tests import test_card_match_v9 as v9
    from tests import test_trace_sources as sources

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

IN_USE = "names+number+text+art+tta+fastread+numberonce+corners+wholepic"


@skip
class OptionAndRowTests(unittest.TestCase):
    def test_version_default_and_options(self):
        self.assertEqual(MATCHER_VERSION, "11")
        self.assertEqual(variants.DEFAULT_LABEL, IN_USE)
        default = variants.parse(variants.DEFAULT_LABEL)
        self.assertFalse(default.wholeread or default.wholestrict)  # options the server must measure first
        strict = variants.parse(IN_USE + "+wholestrict")
        self.assertTrue(strict.wholestrict and strict.wholeread)  # wholestrict judges the second read's number, so it brings it
        self.assertEqual(strict.label, IN_USE + "+wholeread+wholestrict")
        self.assertNotIn("wholeview", variants.ORDER)
        self.assertEqual(variants.parse("names+wholeview").label, "names")  # an old word is ignored, not an error

    def test_the_comparison_rows(self):
        labels = variants.COMPARE_LABELS
        self.assertLessEqual(len(labels), 15)  # version 11 added the three phone rows, step 2 two more
        self.assertEqual(len(set(labels)), len(labels))
        for wanted in (IN_USE, IN_USE + "+wholeread", IN_USE + "+wholeread+wholestrict"):
            self.assertIn(wanted, labels)
        self.assertFalse([label for label in labels if "wholeview" in label])
        for label in labels:
            self.assertEqual(variants.parse(label).label, label)


@skip
class NumberSourceTests(unittest.TestCase):
    def test_a_number_only_the_second_read_found_is_marked_as_the_whole_picture(self):
        old = ocr.OcrResult(lines=["x"])
        new = ocr.OcrResult(number_local="058", number_total="102", number_confidence=0.9)
        merged = ocr.merge_reads(old, new, "whole_picture", "whole-")
        self.assertEqual(merged.number_source, "whole_picture")

    def test_a_number_the_finders_card_gave_stays_the_finders_even_when_the_second_read_agrees_or_is_weaker(self):
        old = ocr.OcrResult(number_local="058", number_total="102", number_confidence=0.9)
        agree = ocr.merge_reads(old, ocr.OcrResult(number_local="058", number_total="102", number_confidence=0.9), "whole_picture", "whole-")
        self.assertEqual(agree.number_source, "finder_card")
        weaker = ocr.merge_reads(ocr.OcrResult(number_local="058", number_total="102", number_confidence=0.9), ocr.OcrResult(number_local="12"), "whole_picture", "whole-")
        self.assertEqual(weaker.number_source, "finder_card")

    def test_the_last_resort_band_read_from_the_finders_card_is_not_the_whole_picture(self):
        merged = ocr.merge_reads(ocr.OcrResult(), ocr.OcrResult(number_local="058", number_total="102", number_confidence=0.7))
        self.assertEqual(merged.number_source, "finder_card")
        again = ocr.merge_reads(ocr.merge_reads(ocr.OcrResult(), ocr.OcrResult(number_local="1", number_total="2", number_confidence=0.9), "whole_picture", "whole-"), ocr.OcrResult())
        self.assertEqual(again.number_source, "whole_picture")  # a later empty read does not change where the number came from

    def test_no_number_no_source(self):
        self.assertIsNone(ocr.merge_reads(ocr.OcrResult(), ocr.OcrResult(), "whole_picture", "whole-").number_source)


@skip
class WholeSourceMatcherTests(unittest.TestCase):
    """The trace and the match result say where the number came from and how sure the line was."""

    setUp = v9.WholeReadMatcherTests.setUp
    _cache = v9.WholeReadMatcherTests._cache
    build = v9.WholeReadMatcherTests.build
    matcher = v9.WholeReadMatcherTests.matcher
    found = v9.WholeReadMatcherTests.found
    run_match = v9.WholeReadMatcherTests.run_match

    def test_the_ocr_dict_carries_number_source_and_confidence(self):
        outcome = self.run_match(v9.SecondReadReader(), fastread=True, wholeread=True)
        self.assertEqual(outcome.ocr["number_source"], "whole_picture")
        self.assertEqual(outcome.ocr["number_confidence"], 0.9)

    def test_a_number_from_the_finders_card_says_so(self):
        class Complete(v9.SecondReadReader):
            def read(self, card, read_hp=False, flipped=None, **kwargs):
                return ocr.OcrResult(number_local="4", number_total="5", number_confidence=0.8, strips=[])

        outcome = self.run_match(Complete(), fastread=True, wholeread=True)
        self.assertEqual((outcome.ocr["number_source"], outcome.ocr["number_confidence"]), ("finder_card", 0.8))

    def test_no_number_gives_no_source(self):
        class Empty(v9.SecondReadReader):
            def read(self, card, read_hp=False, flipped=None, **kwargs):
                return ocr.OcrResult(strips=[])

        self.assertIsNone(self.run_match(Empty(), fastread=True).ocr["number_source"])


def candidate(name, number, total, similarity, rank, **extra):
    return {"_db_id": f"{name}-{number}_en", "tcg_card_id": f"{name}-{number}", "id": f"{name}-{number}", "name": name, "number": number, "printed_total": total,
            "_similarity": similarity, "_rank": rank, "_position": rank, "set_abbreviation": "TST", "set": "Test Set", **extra}


@skip
class WholeStrictRuleTests(unittest.TestCase):
    """Each rule on its own, from a decision the normal rules take."""

    INFO = {"number_local": "077", "number_total": "128", "language": None}

    def decide(self, cands, info=None, **kwargs):
        info = dict(self.INFO if info is None else info)
        return pipeline.decide(info, cands, whole_strict=True, number_source="whole_picture", number_confidence=0.9, **kwargs)

    def good(self, **extra):
        return [candidate("Comfey", "077", 128, 0.80, 1, **extra), candidate("Other", "001", 128, 0.50, 2)]

    def test_the_normal_rules_decide_the_case_so_each_refusal_below_is_the_new_rule(self):
        chosen, reason = pipeline.decide(dict(self.INFO), self.good())
        self.assertIsNotNone(chosen, reason)
        chosen, reason = self.decide(self.good())
        self.assertIsNotNone(chosen, reason)

    def test_the_total_must_have_been_read_and_fit(self):
        no_total = {"number_local": "077", "number_total": None, "language": None}
        self.assertEqual(self.decide(self.good(), no_total)[1], "whole_number_total_not_confirmed")
        unknown = [candidate("Comfey", "077", None, 0.80, 1), candidate("Other", "001", 128, 0.50, 2)]
        self.assertEqual(self.decide(unknown)[1], "whole_number_total_not_confirmed")  # the card prints no known total: nothing confirms it

    def test_the_card_must_be_the_pictures_first_or_second_pick(self):
        third = [candidate("Other", "001", 128, 0.90, 1), candidate("Another", "002", 128, 0.85, 2), candidate("Comfey", "077", 128, 0.80, 3)]
        self.assertIsNotNone(pipeline.decide(dict(self.INFO), third)[0])  # the normal rules take it (within the top 10)
        self.assertEqual(self.decide(third)[1], "whole_number_picture_too_weak")
        second = [candidate("Other", "001", 128, 0.84, 1), candidate("Comfey", "077", 128, 0.80, 2)]
        self.assertIsNotNone(self.decide(second)[0])

    def test_the_picture_must_clear_the_normal_threshold_plus_the_margin(self):
        floor = pipeline.SIM_MIN_WITH_RULES + pipeline.WHOLE_SIM_MARGIN
        under = [candidate("Comfey", "077", 128, round(floor - 0.01, 4), 1), candidate("Other", "001", 128, 0.40, 2)]
        self.assertIsNotNone(pipeline.decide(dict(self.INFO), under)[0])  # fine for the normal rules (>= 0.55)
        self.assertEqual(self.decide(under)[1], "whole_number_picture_too_weak")
        at = [candidate("Comfey", "077", 128, floor, 1), candidate("Other", "001", 128, 0.40, 2)]
        self.assertIsNotNone(self.decide(at)[0])

    def test_a_known_name_that_is_not_this_cards_refuses(self):
        conflict = self.good(_name_known=True, _name_score=0.0)
        self.assertEqual(self.decide(conflict)[1], "number_lookup_conflicts_with_name" if conflict[0].get("_lookup") else "whole_number_name_conflict")
        agreeing = self.good(_name_known=True, _name_score=1.0)
        self.assertIsNotNone(self.decide(agreeing)[0])
        unknown_name = self.good(_name_known=False, _name_score=0.0)  # a name the catalogue does not know proves nothing
        self.assertIsNotNone(self.decide(unknown_name)[0])

    def test_the_number_line_must_be_read_with_enough_confidence(self):
        cands = self.good()
        for confidence, allowed in ((0.84, False), (pipeline.WHOLE_CONFIDENCE_MIN, True), (None, False)):
            chosen, reason = pipeline.decide(dict(self.INFO), cands, whole_strict=True, number_source="whole_picture", number_confidence=confidence)
            self.assertEqual(chosen is not None, allowed, (confidence, reason))
            if not allowed:
                self.assertEqual(reason, "whole_number_low_confidence")

    def test_a_number_from_the_finders_card_is_never_judged_and_the_option_off_changes_nothing(self):
        weak = [candidate("Comfey", "077", 128, 0.60, 1), candidate("Other", "001", 128, 0.40, 2)]
        info = dict(self.INFO)
        self.assertIsNotNone(pipeline.decide(info, weak, whole_strict=True, number_source="finder_card", number_confidence=0.1)[0])
        self.assertIsNotNone(pipeline.decide(info, weak, whole_strict=False, number_source="whole_picture", number_confidence=0.1)[0])
        self.assertIsNotNone(pipeline.decide(info, weak)[0])

    def test_it_only_ever_refuses(self):
        # A decision the normal rules refuse stays refused with the option on, whatever the evidence.
        wrong_total = [candidate("Comfey", "077", 114, 0.95, 1), candidate("Other", "001", 128, 0.40, 2)]
        self.assertIsNone(pipeline.decide(dict(self.INFO), wrong_total)[0])
        self.assertIsNone(self.decide(wrong_total)[0])

    def test_a_decision_the_picture_took_alone_does_not_rest_on_the_number(self):
        # The number names no printing among the pictures; the strong picture lane decides, as before.
        lone = [candidate("Top", "001", 128, 0.95, 1), candidate("Other", "002", 128, 0.70, 2)]
        info = {"number_local": "999", "number_total": "128", "language": None}
        chosen, reason = self.decide(lone, info)
        self.assertEqual(chosen["mechanism"], "picture_lead_strong", reason)


class WrongOutcome:
    def __init__(self, decided="b", truth="a", **ocr_extra):
        self.decision = {"card_id": f"{decided}_en", "tcg_card_id": decided, "mechanism": "number_and_picture", "similarity": 0.7, "lead": 0.1}
        self.matches = [
            {"card_id": f"{decided}_en", "tcg_card_id": decided, "rank": 1, "picture_rank": 1, "name": "Comfey", "number": "077", "set": "S", "printed_total": 128, "similarity": 0.7},
            {"card_id": f"{truth}_en", "tcg_card_id": truth, "rank": 2, "picture_rank": 2, "name": "Kommo-o", "number": "143", "set": "S", "printed_total": 128, "similarity": 0.44},
        ]
        self.ocr = {"number_local": "077", "number_total": "128", "name": None, "number_source": "whole_picture", "number_confidence": 0.9, "lines": ["077/128"], **ocr_extra}
        self.detection = {"found": False, "confidence": 0.1, "method": "guide", "fallback": "guide_crop", "rejected": {"why": "x"}, "corners": [[1, 2]]}
        self.unsure_reason = None


@skip
class WrongRecordTests(unittest.TestCase):
    def test_a_wrong_decision_keeps_what_misses_keeps_as_text_with_the_number_source_and_reasons(self):
        loaded = {"a_en": {"name": "Kommo-o", "number": "143", "set": "S", "printed_total": 128, "images_small": "u"}, "b_en": {"images_small": "v"}}
        record = misses.wrong_record(trace="t-1.json", source="prod", trace_rel="user-1/2026-11-12/t-1.json", outcome=WrongOutcome(), truth_id="a_en", loaded=loaded)
        self.assertEqual(record["decided_card"]["name"], "Comfey")
        self.assertEqual((record["truth"]["name"], record["truth"]["similarity"], record["truth"]["picture_rank"]), ("Kommo-o", 0.44, 2))
        self.assertEqual((record["ocr"]["number"], record["ocr"]["total"], record["ocr"]["number_source"], record["ocr"]["number_confidence"]), ("077", "128", "whole_picture", 0.9))
        self.assertEqual(record["mechanism"], "number_and_picture")
        self.assertEqual(record["key"], "prod-t-1")
        self.assertEqual(record["rank"], 2)
        for code in ("number_and_picture", "number_from_whole_picture", "fallback_guide_crop", "quad_refused"):
            self.assertIn(code, record["reasons"])
        self.assertNotIn("strips", record["ocr"])  # text only: no regions, no pictures of the photo
        self.assertFalse([key for key in record if key in ("photo", "card")])

    def test_a_truth_outside_the_top_20_is_still_listed(self):
        outcome = WrongOutcome()
        outcome.matches = outcome.matches[:1]
        record = misses.wrong_record(trace="t.json", source="local", trace_rel=None, outcome=outcome, truth_id="a_en", loaded={})
        self.assertIsNone(record["rank"])
        self.assertIsNone(record["truth"]["similarity"])
        self.assertEqual(record["key"], "t")

    def test_the_misses_list_stores_the_same_new_facts_for_a_wrong_decision(self):
        self.assertEqual(misses.wrong_reasons(WrongOutcome(number_total=None), WrongOutcome().decision).count("total_not_read"), 1)

    def test_the_comparison_row_carries_the_list(self):
        report = {"metrics": {"n": 3, "top1_pct": 1, "top5_pct": 1, "top20_pct": 1, "number_exact_pct": 1, "decided_pct": 1, "decided_right_pct": 50, "decided_wrong": 1},
                  "timings_ms": {}, "memory": {}, "wrong_scans": [{"key": "k"}]}
        self.assertEqual(benchmark.compare_row("x", report)["wrong_scans"], [{"key": "k"}])
        report.pop("wrong_scans")
        self.assertEqual(benchmark.compare_row("x", report)["wrong_scans"], [])


class WrongMatcher(sources.FakeMatcher if DEPS_AVAILABLE else object):
    """Decides the first card for every photo, so a scan of the second card is a wrong decision."""

    def __init__(self):
        super().__init__(["swsh1-1", "swsh1-9"])
        self.candidate_loader = lambda ids: {}

    def match(self, photo, flat_card=None, review_photo=None):
        outcome = super().match(photo, flat_card=flat_card, review_photo=review_photo)
        outcome.matches[0]["picture_rank"] = 1
        outcome.ocr = {"number_local": "1", "number_total": "9", "number_source": "finder_card", "number_confidence": 0.9}
        return outcome


@skip
class RunLabelledWrongTests(sources.RunLabelledGroupTests):
    def run_it(self, **kwargs):
        matcher = WrongMatcher()
        with patch.object(benchmark, "index_status", return_value={}), patch.object(benchmark, "rss_mb", return_value=None):
            report = benchmark.run_labelled(lambda: None, matcher, trace_dir=self.local, corners_check=False, **kwargs)
        return report, matcher

    # The inherited tests assume the one-card fake; only the new ones run here.
    test_groups_headline_and_review_photos = None
    test_skip_and_only = None
    test_the_misses_collector_never_gets_a_held_back_scan = None

    def test_every_wrong_decision_of_the_run_is_kept_and_a_held_back_scan_never_is(self):
        report, _ = self.run_it()
        wrong = report["wrong_scans"]
        self.assertEqual(len(wrong), report["metrics"]["decided_wrong"])
        self.assertGreater(len(wrong), 0)
        held = {path.name for data, path in sources.ocr_check.labelled_traces(self.local) if trace_sources.is_held_back(data)}
        self.assertTrue(held)
        self.assertFalse({item["trace"] for item in wrong} & held)
        self.assertTrue(all(item["trace_rel"].count("/") == 2 and item["ocr"]["number_source"] == "finder_card" for item in wrong))

    def test_the_held_back_only_run_keeps_none(self):
        report, _ = self.run_it(held_back="only")
        self.assertEqual(report["wrong_scans"], [])

    def test_the_kept_list_is_capped(self):
        with patch.object(benchmark, "MAX_WRONG_SCANS", 2):
            report, _ = self.run_it()
        self.assertLessEqual(len(report["wrong_scans"]), 2)
        self.assertGreater(report["metrics"]["decided_wrong"], 2)


if __name__ == "__main__":
    unittest.main()
