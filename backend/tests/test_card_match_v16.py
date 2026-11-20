"""Matcher version 16 test: per-model picture thresholds for a custom picture model (``calibration.py``, option word ``calibrated``)."""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

if os.name == "nt":  # api.recognize imports fcntl through the auth service; CI is Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

try:
    import numpy as np

    from services.card_match import benchmark, calibration, custom_models, pipeline, variants

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

SIM_NAMES = calibration.SIM_FIELDS if DEPS_AVAILABLE else ()
CURRENT = {  # today's constants, written out
    "sim_min_with_rules": 0.55, "sim_min_picture_only": 0.80, "lead_min_picture_only": 0.06, "sim_min_picture_strong": 0.88,
    "lead_min_picture_strong": 0.10, "sim_min_name_picture": 0.80, "lead_min_name_picture": 0.03, "lookup_sim_set": 0.60,
    "lookup_sim_total": 0.65, "whole_sim_min": 0.65, "reprint_art_lead": 0.04, "same_name_picture_margin": 0.10,
}


def stats(n=400, seed=1):
    """Best-impostor values of n scans: the picture score over the whole range of the constants, the gaps over theirs."""
    rng = np.random.default_rng(seed)
    return {"best": rng.uniform(0.30, 0.95, n), "gap": rng.uniform(0.0, 0.30, n), "art_gap": rng.uniform(0.0, 0.20, n)}


def cand(card_id, name, similarity, rank, **extra):
    return {"_db_id": card_id, "tcg_card_id": card_id, "id": card_id, "name": name, "number": rank, "printed_total": 10,
            "_similarity": similarity, "_rank": rank, "_position": rank, **extra}


@skip
class DefaultTableTests(unittest.TestCase):
    def test_the_default_table_is_todays_constants(self):
        table = pipeline.default_thresholds().as_dict()
        self.assertEqual(set(table), set(CURRENT))
        self.assertEqual(set(table), set(pipeline.THRESHOLD_FIELDS))
        for name, value in CURRENT.items():
            self.assertAlmostEqual(table[name], value, places=9, msg=name)
        self.assertEqual(table["whole_sim_min"], pipeline.SIM_MIN_WITH_RULES + pipeline.WHOLE_SIM_MARGIN)  # the same float as before

    def test_a_patched_constant_is_still_honoured(self):
        with patch.object(pipeline, "SIM_MIN_PICTURE_STRONG", 2.0):
            self.assertEqual(pipeline.default_thresholds().sim_min_picture_strong, 2.0)
            strong = [cand("a", "A", 0.95, 1), cand("b", "B", 0.70, 2)]
            self.assertIsNone(pipeline.decide({"number_local": "77", "number_total": "5"}, strong)[0])

    def test_calibrating_the_default_model_against_itself_is_the_identity(self):
        same = stats()
        self.assertEqual(calibration.calibrate_table(same, same), CURRENT)

    def test_the_identity_holds_when_the_data_does_not_reach_a_threshold(self):
        narrow = {"best": np.linspace(0.2, 0.7, 150), "gap": np.linspace(0.0, 0.05, 150), "art_gap": np.linspace(0.0, 0.03, 150)}
        self.assertEqual(calibration.calibrate_table(narrow, narrow), CURRENT)


@skip
class QuantileTests(unittest.TestCase):
    def test_a_monotone_transform_maps_through_the_same_transform_rounded_stricter(self):
        default = stats()
        custom = {"best": 0.5 * default["best"] + 0.4, "gap": 0.5 * default["gap"], "art_gap": 0.5 * default["art_gap"]}
        table = calibration.calibrate_table(default, custom)
        for name in calibration.SIM_FIELDS:
            exact = 0.5 * CURRENT[name] + 0.4
            self.assertGreaterEqual(table[name], round(exact, 6) - 1e-9, name)  # never looser than the exact mapping
            self.assertLess(table[name] - exact, 0.0101, name)  # and at most one step above it
        for name in calibration.LEAD_FIELDS + calibration.ART_LEAD_FIELDS:
            exact = 0.5 * CURRENT[name]
            self.assertGreaterEqual(table[name], exact - 1e-9, name)
            self.assertLess(table[name] - exact, 0.0101, name)
        self.assertEqual(table["whole_sim_min"], 0.73)  # 0.5 * 0.65 + 0.4 = 0.725, rounded up

    def test_the_same_name_guard_is_never_looser_and_rounds_down(self):
        default = stats()
        wider = {"best": default["best"], "gap": 2 * default["gap"], "art_gap": default["art_gap"]}
        self.assertEqual(calibration.calibrate_table(default, wider)["same_name_picture_margin"], 0.10)
        tighter = {"best": default["best"], "gap": 0.5 * default["gap"], "art_gap": default["art_gap"]}
        self.assertEqual(calibration.calibrate_table(default, tighter)["same_name_picture_margin"], 0.05)

    def test_a_threshold_no_impostor_reaches_stays_above_every_custom_impostor(self):
        default = {"best": np.linspace(0.2, 0.7, 120), "gap": np.linspace(0, 0.05, 120), "art_gap": np.linspace(0, 0.03, 120)}
        custom = {"best": np.linspace(0.5, 0.9, 120), "gap": np.linspace(0, 0.08, 120), "art_gap": np.linspace(0, 0.05, 120)}
        table = calibration.calibrate_table(default, custom)
        self.assertGreater(table["sim_min_picture_only"], 0.9)  # 0.80 is above every default impostor, so the custom value is above every custom one
        self.assertGreater(table["lead_min_picture_only"], 0.08)

    def test_rounding_goes_toward_stricter_and_keeps_float_noise(self):
        self.assertEqual(calibration.round_up(0.7301), 0.74)
        self.assertEqual(calibration.round_up(0.80000000000000004), 0.80)
        self.assertEqual(calibration.round_down(0.0999), 0.09)
        self.assertEqual(calibration.round_down(0.10000000000000002), 0.10)

    def test_the_whole_picture_rule_is_never_below_the_normal_floor(self):
        default = stats()
        custom = {"best": default["best"], "gap": default["gap"], "art_gap": default["art_gap"]}
        with patch.object(pipeline, "WHOLE_SIM_MARGIN", 0.0):
            table = calibration.calibrate_table(default, custom, pipeline.default_thresholds())
        self.assertGreaterEqual(table["whole_sim_min"], table["sim_min_with_rules"])


@skip
class ImpostorTests(unittest.TestCase):
    ROWS = {
        "truth": {"name": "Pikachu", "artist": "Mitsuhiro Arita"},
        "reprint": {"name": "Pikachu", "artist": "mitsuhiro arita"},  # same name, same artist: the same artwork
        "other_art": {"name": "Pikachu", "artist": "Atsuko Nishida"},
        "unknown_artist": {"name": "Pikachu", "artist": None},
        "stranger": {"name": "Eevee", "artist": "Atsuko Nishida"},
    }

    def run_impostors(self, scores, ids):
        return calibration.best_two_impostors(np.array(scores), ids, "truth", lambda wanted: {i: self.ROWS.get(i, {}) for i in wanted})

    def test_the_card_and_its_same_artwork_reprints_are_not_impostors(self):
        ids = ["truth", "reprint", "other_art", "stranger"]
        best, second = self.run_impostors([0.99, 0.97, 0.80, 0.60], ids)
        self.assertEqual((best, second), (0.80, 0.60))  # not 0.99 (the card) and not 0.97 (its reprint)

    def test_a_reprint_with_an_unknown_artist_stays_an_impostor(self):
        best, _second = self.run_impostors([0.99, 0.90, 0.80, 0.60], ["truth", "unknown_artist", "other_art", "stranger"])
        self.assertEqual(best, 0.90)  # leaving it in makes the thresholds stricter, never looser

    def test_fewer_than_two_left(self):
        self.assertEqual(self.run_impostors([0.9, 0.8], ["truth", "reprint"]), (0.0, 0.0))
        self.assertEqual(self.run_impostors([0.9, 0.8, 0.7], ["truth", "reprint", "stranger"]), (0.7, 0.0))


class FakeIndex:
    card_ids = ["x_en"]


@skip
class JobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.entry = {"id": "custom-abcd1234", "name": "Mine", "sha256": "a" * 64, "uploaded_at": "2026-11-19T00:00:00+00:00", "uploaded_by": "t",
                      "size_bytes": 1, "dim": 384, "input_size": 224, "mean": [0, 0, 0], "std": [1, 1, 1]}
        custom_models._write_registry([self.entry], self.data_dir)

    def run_job(self, scans, checked, *, table=None):
        stat = stats(len(scans) or 1)
        patches = [
            patch.object(calibration, "check_ready", return_value=self.entry),
            patch("services.card_match.index.get_index", return_value=FakeIndex()),
            patch.object(calibration, "tuned_traces", return_value=scans),
            patch.object(calibration, "scoring_matchers", return_value=(object(), object())),
            patch.object(calibration, "collect_stats", return_value=(stat, stat)),
            patch.object(calibration, "safety_check", return_value=checked),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        return calibration.run_calibration("custom-abcd1234", lambda: None, data_dir=self.data_dir, trace_dir=None)

    def test_it_refuses_under_100_tuned_scans_and_says_why(self):
        with self.assertRaises(calibration.CalibrationError) as caught:
            self.run_job([({}, Path("t.json"))] * 99, {"n": 99, "decided": 50, "wrong": 0})
        self.assertIn("99", str(caught.exception))
        self.assertIn("100", str(caught.exception))
        self.assertIsNone(custom_models.get_model("custom-abcd1234", self.data_dir).get("calibration"))

    def test_a_wrong_decision_in_the_safety_check_stores_nothing(self):
        with self.assertRaises(calibration.CalibrationError) as caught:
            self.run_job([({}, Path("t.json"))] * 120, {"n": 120, "decided": 90, "wrong": 1})
        self.assertIn("not stored", str(caught.exception))
        self.assertIsNone(custom_models.get_model("custom-abcd1234", self.data_dir).get("calibration"))

    def test_a_clean_check_stores_the_table_and_deleting_the_model_removes_it(self):
        stored = self.run_job([({}, Path("t.json"))] * 120, {"n": 120, "decided": 90, "wrong": 0})
        entry = custom_models.get_model("custom-abcd1234", self.data_dir)
        self.assertEqual(entry["calibration"], stored)
        self.assertEqual(stored["scans"], 120)
        self.assertEqual(stored["thresholds"], CURRENT)  # the two models were given the same numbers
        self.assertEqual(stored["default"]["sim_min_picture_only"], 0.8)
        self.assertEqual(custom_models.calibrated_thresholds(entry), CURRENT)
        custom_models.delete_model("custom-abcd1234", self.data_dir)
        self.assertEqual(custom_models.list_models(self.data_dir), [])
        self.assertIsNone(custom_models.calibrated_thresholds(custom_models.get_model("custom-abcd1234", self.data_dir)))

    def test_it_refuses_when_an_index_is_missing(self):
        with self.assertRaises(calibration.CalibrationError) as caught:
            calibration.check_ready("custom-abcd1234", self.data_dir)  # nothing is built in this folder
        self.assertIn("Build the indexes", str(caught.exception))


@skip
class OptionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.entry = {"id": "custom-abcd1234", "name": "Mine", "sha256": "a" * 64, "uploaded_at": "2026-11-19T00:00:00+00:00", "uploaded_by": "t",
                      "size_bytes": 1, "dim": 384, "input_size": 224, "mean": [0, 0, 0], "std": [1, 1, 1]}

    def test_the_two_rows_are_on_the_set_in_use_and_in_their_own_group(self):
        plain, calibrated = variants.V16_LABELS
        self.assertEqual(plain, variants.NO_STRICT_LABEL + "+widefirst+topname+edgeguard+custom")
        self.assertEqual(calibrated, variants.NO_STRICT_LABEL + "+widefirst+topname+edgeguard+custom+calibrated")
        self.assertEqual(variants.PIN_LABEL, variants.NO_STRICT_LABEL + "+widefirst+topname+edgeguard")
        for label in (plain, calibrated):
            self.assertIn(label, variants.COMPARE_LABELS)
            self.assertEqual(variants.parse(label).label, label)  # the words round-trip in this order
            self.assertEqual(variants.compare_group(label), "v16")
        self.assertEqual(sum(1 for label in variants.COMPARE_LABELS if variants.compare_group(label) == "v16"), 2)
        self.assertEqual(variants.compare_title(plain), "Set in use + custom model, default thresholds")
        self.assertEqual(variants.compare_title(calibrated), "Set in use + custom model, calibrated thresholds")
        self.assertNotIn(variants.IN_USE + "+custom+calibrated", variants.COMPARE_LABELS)  # not the v9 set

    def test_calibrated_does_nothing_without_custom(self):
        options = variants.parse("names+number+calibrated")
        self.assertTrue(options.calibrated and not options.custom)
        self.assertIsNone(variants.thresholds_for(options, self.data_dir))
        self.assertIsNone(variants.calibration_problem(options, self.data_dir))
        custom_models._write_registry([{**self.entry, "calibration": {"at": "x", "scans": 120, "thresholds": {**CURRENT, "sim_min_picture_only": 0.9}}}], self.data_dir)
        self.assertIsNone(variants.thresholds_for(options, self.data_dir))  # still the default table
        self.assertIsNone(variants.thresholds_for(variants.parse(variants.V16_LABELS[0]), self.data_dir))  # custom without calibrated

    def test_custom_and_calibrated_use_the_newest_models_table(self):
        options = variants.parse(variants.V16_LABELS[1])
        custom_models._write_registry([self.entry], self.data_dir)
        self.assertEqual(variants.calibration_problem(options, self.data_dir), "calibrate the custom model first")
        self.assertIsNone(variants.thresholds_for(options, self.data_dir))
        custom_models._write_registry([{**self.entry, "calibration": {"at": "x", "scans": 120, "thresholds": {**CURRENT, "sim_min_picture_only": 0.9}}}], self.data_dir)
        self.assertIsNone(variants.calibration_problem(options, self.data_dir))
        table = variants.thresholds_for(options, self.data_dir)
        self.assertEqual(table.sim_min_picture_only, 0.9)
        self.assertEqual(table.lead_min_picture_only, 0.06)

    def test_no_model_at_all_is_also_not_calibrated(self):
        self.assertEqual(variants.calibration_problem(variants.parse(variants.V16_LABELS[1]), self.data_dir), "calibrate the custom model first")

    def test_the_row_is_listed_as_skipped_with_the_reason(self):
        row = benchmark.compare_row(variants.V16_LABELS[1], None, reason="calibrate the custom model first")
        self.assertEqual((row["status"], row["reason"], row["missing_indexes"]), ("skipped", "calibrate the custom model first", []))
        with patch.object(variants, "missing_indexes", return_value=[]), patch.object(benchmark, "last_row_seconds", return_value={}):
            report = benchmark.run_compare("labelled", lambda: None, [variants.V16_LABELS[1]], data_dir=self.data_dir, trace_dir=None, selected=[variants.V16_LABELS[1]])
        self.assertEqual([(r["status"], r["reason"]) for r in report["rows"]], [("skipped", "calibrate the custom model first")])

    def test_an_unbuilt_index_is_still_reported_as_missing_first(self):
        row = benchmark.compare_row(variants.V16_LABELS[1], None, missing=["custom-none"])
        self.assertEqual((row["status"], row["missing_indexes"], row["reason"]), ("skipped", ["custom-none"], None))

    def test_the_matcher_keeps_the_table_it_is_given(self):
        table = pipeline.Thresholds.from_dict({"sim_min_picture_only": 0.9})
        matcher = pipeline.CardMatcher(FakeIndex(), object(), lambda ids: {}, thresholds=table)
        self.assertIs(matcher.thresholds, table)
        self.assertIsNone(pipeline.CardMatcher(FakeIndex(), object(), lambda ids: {}).thresholds)


@skip
class DecisionTests(unittest.TestCase):
    """With the default table (the option off) every decision is the one the constants give; a model's own table changes only what it names."""

    def grid(self):
        for sim in (0.40, 0.50, 0.56, 0.62, 0.66, 0.70, 0.79, 0.81, 0.86, 0.89, 0.95):
            for lead in (0.0, 0.02, 0.04, 0.07, 0.11, 0.2):
                second = sim - lead
                for info in ({}, {"number_local": "1", "number_total": "10"}, {"number_local": "9", "number_total": "10"}):
                    yield info, [cand("a", "A", sim, 1, _name_score=1.0), cand("b", "B", second, 2)]

    def test_default_table_and_no_table_decide_identically(self):
        count = 0
        for info, cands in self.grid():
            self.assertEqual(pipeline.decide(dict(info), cands), pipeline.decide(dict(info), cands, th=pipeline.default_thresholds()))
            count += 1
        self.assertGreater(count, 100)

    def test_known_decisions_are_the_constants_decisions(self):
        sure = [cand("a", "A", 0.95, 1), cand("b", "B", 0.7, 2)]
        self.assertEqual(pipeline.decide({}, sure)[0]["mechanism"], "picture_lead")
        close = [cand("a", "A", 0.95, 1), cand("b", "B", 0.94, 2)]
        self.assertEqual(pipeline.decide({}, close)[1], "no_number_and_picture_not_clear")
        middling = [cand("a", "A", 0.79, 1), cand("b", "B", 0.50, 2)]
        self.assertEqual(pipeline.decide({}, middling)[1], "no_number_and_picture_not_clear")

    def test_a_models_own_table_moves_exactly_the_rules_it_names(self):
        middling = [cand("a", "A", 0.79, 1), cand("b", "B", 0.50, 2)]
        own = pipeline.Thresholds.from_dict({"sim_min_picture_only": 0.75})
        self.assertEqual(pipeline.decide({}, middling, th=own)[0]["mechanism"], "picture_lead")
        stricter = pipeline.Thresholds.from_dict({"lead_min_picture_only": 0.40})
        sure = [cand("a", "A", 0.95, 1), cand("b", "B", 0.7, 2)]
        self.assertEqual(pipeline.decide({}, sure, th=stricter)[1], "no_number_and_picture_not_clear")
        info = {"number_local": "1", "number_total": "10"}
        chosen_default = pipeline.decide(dict(info), [cand("a", "A", 0.60, 1), cand("b", "B", 0.3, 2)])
        floor = pipeline.Thresholds.from_dict({"sim_min_with_rules": 0.7})
        self.assertIsNotNone(chosen_default[0])
        self.assertEqual(pipeline.decide(dict(info), [cand("a", "A", 0.60, 1), cand("b", "B", 0.3, 2)], th=floor)[1], "rules_choice_not_close_in_picture")

    def test_the_whole_picture_rule_and_the_same_name_guard_read_the_table(self):
        info = {"number_local": "1", "number_total": "10", "language": None}
        cands = [cand("a", "A", 0.62, 1, set_abbreviation="TST"), cand("b", "B", 0.2, 2)]
        kwargs = dict(whole_strict=True, number_source="whole_picture", number_confidence=0.9)
        self.assertEqual(pipeline.decide(dict(info), cands, **kwargs)[1], "whole_number_picture_too_weak")  # 0.62 < 0.65
        loose = pipeline.Thresholds.from_dict({"whole_sim_min": 0.60})
        self.assertIsNone(pipeline.decide(dict(info), cands, th=loose, **kwargs)[1])
        rival = [cand("a", "A", 0.70, 1), {**cand("c", "A", 0.78, 2), "number": 7}]
        self.assertEqual(pipeline.decide({"number_local": "1", "number_total": "10"}, rival)[0]["candidate"]["_db_id"], "a")  # 0.08 closer: under 0.10
        guard = pipeline.Thresholds.from_dict({"same_name_picture_margin": 0.05})
        self.assertEqual(pipeline.decide({"number_local": "1", "number_total": "10"}, rival, th=guard)[1], "closer_printing_of_same_name")


if __name__ == "__main__":
    unittest.main()
