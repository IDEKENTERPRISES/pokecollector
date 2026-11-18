"""Matcher version 13 test: the learned decision rule (``learned.py``), its comparison rows, the three honest groups and the
``pick_winner`` guard. Built from generated data only; the version stays 11 and nothing is on by default."""
import json
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

    from services import trace_sources
    from services.card_match import MATCHER_VERSION, benchmark, learned, pipeline, variants
    from tests import test_card_match_v10 as v10
    from tests import test_card_match_v9 as v9
    from tests import test_trace_sources as sources

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

KEPT = variants.KEPT_LABEL if DEPS_AVAILABLE else ""


def cand(name, number, total, similarity, rank, **extra):
    return v10.candidate(name, number, total, similarity, rank, **extra)


@skip
class FeatureTests(unittest.TestCase):
    INFO = {"number_local": "077", "number_total": "128", "set_code": "TST"}

    def extract(self, cands, info=None, ocr_info=None, fallback=None, reason=None):
        return learned.extract(cands, dict(self.INFO if info is None else info), ocr_info or {}, {"found": True, "confidence": 0.9},
                               fallback=fallback, reason=reason)

    def test_nothing_to_judge_without_a_candidate(self):
        self.assertIsNone(self.extract([]))

    def test_the_first_candidate_exact_number_and_total(self):
        cands = [cand("Comfey", "077", 128, 0.80, 1, _art_similarity=0.7, _name_score=1.0, _name_known=True),
                 cand("Other", "001", 128, 0.50, 2, _art_similarity=0.6)]
        got = self.extract(cands, ocr_info={"number_source": "finder_card", "number_confidence": 0.9, "name": "Comfey"}, reason="number_matches_several_printings")
        values = got["values"]
        self.assertEqual(set(values), set(learned.FEATURES))
        self.assertEqual(got["card_id"], "Comfey-077_en")
        self.assertTrue(got["eligible"])
        self.assertAlmostEqual(values["similarity"], 0.80)
        self.assertAlmostEqual(values["lead"], 0.30)  # 0.80 against 0.50
        self.assertAlmostEqual(values["art_lead"], 0.1)
        self.assertEqual(values["number_names_one"], 1.0)
        self.assertEqual((values["number_names_several"], values["number_names_none"]), (0.0, 0.0))
        self.assertEqual((values["first_number_match"], values["first_total_match"], values["first_total_contradicts"]), (1.0, 1.0, 0.0))
        self.assertEqual((values["number_source_finder"], values["number_source_whole"], values["number_confidence"]), (1.0, 0.0, 0.9))
        self.assertEqual((values["name_read"], values["name_score"], values["name_known"], values["name_conflict"]), (1.0, 1.0, 1.0, 0.0))
        self.assertEqual(values["set_code_match"], 1.0)
        self.assertEqual(values["reason_number_matches_several_printings"], 1.0)
        self.assertEqual(values["reason_no_number_and_picture_not_clear"], 0.0)

    def test_the_number_names_several_or_none(self):
        several = self.extract([cand("A", "077", 128, 0.7, 1), cand("B", "077", 128, 0.6, 2)])["values"]
        self.assertEqual((several["number_names_one"], several["number_names_several"]), (0.0, 1.0))
        none = self.extract([cand("A", "001", 128, 0.7, 1), cand("B", "002", 128, 0.6, 2)])["values"]
        self.assertEqual((none["number_names_none"], none["first_number_match"]), (1.0, 0.0))

    def test_no_number_and_a_contradicting_total_and_a_corrected_number(self):
        silent = self.extract([cand("A", "001", 128, 0.7, 1)], info={})["values"]
        self.assertEqual((silent["number_read"], silent["number_names_none"], silent["total_read"], silent["first_total_match"]), (0.0, 0.0, 0.0, 0.0))
        contra = self.extract([cand("A", "077", 114, 0.7, 1)], ocr_info={"corrected": {"x": 1}})["values"]
        self.assertEqual((contra["first_total_contradicts"], contra["first_total_match"], contra["number_corrected"]), (1.0, 0.0, 1.0))

    def test_a_card_the_finder_did_not_find_is_not_eligible_and_a_lost_art_index_is_zero(self):
        got = self.extract([cand("A", "077", 128, 0.7, 1)], fallback="guide_crop")
        self.assertFalse(got["eligible"])
        self.assertEqual((got["values"]["has_art"], got["values"]["art_similarity"], got["values"]["fallback"]), (0.0, 0.0, 1.0))

    def test_a_known_name_that_is_not_this_cards_is_a_conflict(self):
        values = self.extract([cand("A", "077", 128, 0.7, 1, _name_score=0.0, _name_known=True)])["values"]
        self.assertEqual(values["name_conflict"], 1.0)


def synthetic_rows(n_right=60, n_wrong=8, seed=3):
    """A separable set: the right first picks have a clearly higher similarity and lead than the wrong ones."""
    rng = np.random.default_rng(seed)
    rows = []
    for _ in range(n_right):
        rows.append({"values": {"similarity": float(rng.uniform(0.65, 0.95)), "lead": float(rng.uniform(0.05, 0.3)), "first_number_match": 1.0}, "right": True})
    for _ in range(n_wrong):
        rows.append({"values": {"similarity": float(rng.uniform(0.3, 0.55)), "lead": float(rng.uniform(-0.1, 0.02)), "first_number_match": float(rng.integers(0, 2))}, "right": False})
    return rows


@skip
class TrainingTests(unittest.TestCase):
    def test_a_separable_set_gives_a_threshold_with_no_wrong_decision_in_cross_validation(self):
        rows = synthetic_rows()
        document = learned.train(rows)
        cv = document["cross_validation"]
        self.assertEqual(cv["decided_wrong"], 0)
        self.assertGreater(cv["decided_right"], 40)  # the rule decides most of the right ones
        self.assertTrue(document["usable"])
        self.assertEqual(document["counts"], {"scans": 68, "eligible": 68, "unsure": 68, "first_right": 60, "first_wrong": 8})
        # the threshold is the lowest 0-wrong one plus the margin, and the stored model reproduces it
        x = np.array([learned.vector(r["values"]) for r in rows])
        y = np.array([1.0 if r["right"] else 0.0 for r in rows])
        assignment = np.array([document["fold_of"][f"row-{i}"] for i in range(len(rows))])
        out_of_fold = learned.cross_validate(x, y, cv["l2"], learned.FOLDS, assignment)
        self.assertAlmostEqual(document["threshold"], learned.zero_wrong_threshold(out_of_fold, y), places=5)
        self.assertGreaterEqual(document["threshold"], float(out_of_fold[y == 0].max()) + learned.SAFETY_MARGIN)

    def test_folds_are_stable_and_spread_the_wrong_picks(self):
        rows = [{**r, "trace": f"trace-{i}.json"} for i, r in enumerate(synthetic_rows())]
        y = np.array([1.0 if r["right"] else 0.0 for r in rows])
        names = [r["trace"] for r in rows]
        first = learned.assign_folds(names, y, learned.FOLDS)
        self.assertTrue((first == learned.assign_folds(list(names), y, learned.FOLDS)).all())  # the same names, the same folds
        wrong_per_fold = [int(((first == f) & (y == 0)).sum()) for f in range(5)]
        self.assertLessEqual(max(wrong_per_fold) - min(wrong_per_fold), 1)
        right = [i for i in range(len(rows)) if y[i] == 1]  # a right scan's fold is the hash of its own name, whatever the other scans are
        self.assertTrue(all(first[i] == learned.stable_fold(names[i], 5) for i in right))

    def test_the_document_keeps_a_model_per_fold_and_a_name_to_fold_map_only(self):
        rows = [{**r, "trace": f"trace-{i}.json", "unsure": i % 2 == 0} for i, r in enumerate(synthetic_rows())]
        document = learned.train(rows)
        self.assertEqual(len(document["fold_models"]), document["cross_validation"]["folds"])
        self.assertEqual(set(document["fold_of"]), {r["trace"] for r in rows})
        self.assertEqual(document["counts"]["eligible"], 68)
        self.assertEqual(document["counts"]["unsure"], 34)
        self.assertEqual(document["cross_validation"]["of"], 34)  # only the scans the rules left unsure could be decided
        self.assertEqual(document["cross_validation"]["decided_wrong"], 0)

    def test_the_final_model_decides_right_cards_and_refuses_wrong_ones(self):
        document = learned.train(synthetic_rows())
        rule = learned.LearnedRule(document)
        good = {"values": {"similarity": 0.9, "lead": 0.25, "first_number_match": 1.0}, "eligible": True}
        bad = {"values": {"similarity": 0.4, "lead": -0.05, "first_number_match": 0.0}, "eligible": True}
        self.assertIsNotNone(rule.decides(good))
        self.assertIsNone(rule.decides(bad))
        self.assertIsNone(rule.decides({**good, "eligible": False}))  # never for a scan the finder lost

    def test_too_little_data_or_no_wrong_example_is_refused(self):
        with self.assertRaises(ValueError):
            learned.train(synthetic_rows(5, 2))
        with self.assertRaises(ValueError):
            learned.train(synthetic_rows(40, 0))

    def test_a_set_where_the_wrong_ones_look_right_gets_no_safe_threshold(self):
        rows = synthetic_rows()
        rows += [{"values": {"similarity": 0.95, "lead": 0.3, "first_number_match": 1.0}, "right": False}] * 3  # indistinguishable from the best right ones
        document = learned.train(rows)
        self.assertEqual(document["cross_validation"]["decided_wrong"], 0)
        rule = learned.LearnedRule({**document, "threshold": 1.0})
        self.assertFalse(rule.usable)  # an impossible threshold: the rule is kept but never decides

    def test_a_training_scan_uses_its_fold_model_and_any_other_scan_the_full_model(self):
        rows = [{**r, "trace": f"trace-{i}.json"} for i, r in enumerate(synthetic_rows())]
        document = learned.train(rows)
        rule = learned.LearnedRule(document)
        self.assertIs(rule.model_for("trace-3.json"), rule.fold_models[document["fold_of"]["trace-3.json"]])
        self.assertIs(rule.model_for("a-held-back-or-new-scan.json"), rule.model)
        self.assertIs(rule.model_for(None), rule.model)  # a live scan
        self.assertIsNot(rule.model_for("trace-3.json"), rule.model)
        values = rows[0]["values"]
        fold_model = rule.fold_models[document["fold_of"]["trace-0.json"]]
        self.assertEqual(rule.probability(values, "trace-0.json"), float(learned.predict(fold_model, learned.vector(values))[0]))
        self.assertEqual(rule.probability(values), float(learned.predict(rule.model, learned.vector(values))[0]))

    def named_rows(self, outlier=False):
        rows = [{**r, "trace": f"trace-{i}.json"} for i, r in enumerate(synthetic_rows())]
        if outlier:  # one wrong first pick that looks exactly like a good one
            rows.append({"values": {"similarity": 0.9, "lead": 0.25, "first_number_match": 1.0}, "right": False, "trace": "outlier.json"})
        return rows

    def test_fold_thresholds_are_chosen_without_their_own_fold(self):
        rows = self.named_rows()
        document = learned.train(rows)
        x = np.array([learned.vector(r["values"]) for r in rows])
        y = np.array([1.0 if r["right"] else 0.0 for r in rows])
        names = [r["trace"] for r in rows]
        fold_of = np.array([document["fold_of"][n] for n in names])
        self.assertEqual(len(document["fold_thresholds"]), len(document["fold_models"]))
        for fold, threshold in enumerate(document["fold_thresholds"]):
            keep = fold_of != fold
            l2, expected, _ = learned._choose(x[keep], y[keep], [n for n, k in zip(names, keep) if k], np.ones(int(keep.sum()), dtype=bool), learned.SAFETY_MARGIN, learned.FOLDS)
            self.assertEqual(threshold, expected)
            self.assertEqual(document["fold_models"][fold], learned.fit(x[keep], y[keep], document["cross_validation"]["fold_l2"][fold]))
            self.assertEqual(document["cross_validation"]["fold_l2"][fold], l2)

    def test_a_wrong_training_scan_can_be_decided_and_is_counted_wrong(self):
        rows = self.named_rows(outlier=True)
        document = learned.train(rows)
        rule = learned.LearnedRule(document)
        self.assertGreaterEqual(document["cross_validation"]["decided_wrong"], 1)  # no longer 0 by construction
        decided_wrong = 0
        for row in rows:
            p = rule.decides({"values": row["values"], "eligible": True}, row["trace"])
            decided_wrong += 1 if p is not None and not row["right"] else 0
        self.assertEqual(decided_wrong, document["cross_validation"]["decided_wrong"])  # the comparison sees what the summary says
        self.assertIsNotNone(rule.decides({"values": rows[-1]["values"], "eligible": True}, "outlier.json"))

    def test_new_and_live_scans_use_the_full_model_and_threshold(self):
        document = learned.train(self.named_rows())
        rule = learned.LearnedRule(document)
        self.assertEqual(rule.threshold_for(None), document["threshold"])
        self.assertEqual(rule.threshold_for("never-seen.json"), document["threshold"])
        self.assertEqual(rule.threshold_for("trace-3.json"), document["fold_thresholds"][document["fold_of"]["trace-3.json"]])

    def test_a_fold_with_too_few_wrong_picks_never_decides(self):
        rows = synthetic_rows(40, 2)
        rows = [{**r, "trace": f"t-{i}.json"} for i, r in enumerate(rows)]
        document = learned.train(rows)
        self.assertGreaterEqual(document["cross_validation"]["folds_never_deciding"], 1)
        self.assertIn(1.0, document["fold_thresholds"])
        rule = learned.LearnedRule(document)
        good = {"values": {"similarity": 0.9, "lead": 0.25, "first_number_match": 1.0}, "eligible": True}
        never = next(n for n, f in document["fold_of"].items() if document["fold_thresholds"][f] == 1.0)
        self.assertIsNone(rule.decides(good, never))

    def test_saved_and_loaded_without_weights_in_the_summary(self):
        document = learned.train(synthetic_rows())
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(learned.load(Path(tmp)))
            self.assertIsNone(learned.summary(Path(tmp)))
            path = learned.save(document, Path(tmp), trained_with="x")
            self.assertEqual(path.name, "learned-decision.json")
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual((saved["threshold"], saved["trained_with"], saved["features"]), (document["threshold"], "x", list(learned.FEATURES)))
            self.assertIn("trained_at", saved)
            self.assertIsNotNone(learned.load(Path(tmp)))
            summary = learned.summary(Path(tmp))
            self.assertNotIn("model", summary)
            self.assertNotIn("fold_models", summary)
            self.assertNotIn("fold_of", summary)
            self.assertEqual(summary["counts"]["eligible"], 68)
            self.assertEqual(summary["counts"]["first_wrong"], 8)
            self.assertEqual(summary["cross_validation"]["decided_wrong"], 0)
            self.assertIn("folds", summary["cross_validation"])
            self.assertEqual(summary["cross_fitted_scans"], 68)


class AlwaysYes:
    """A learned rule that would decide every scan with certainty: it shows what the rules keep."""

    usable = True

    def __init__(self):
        self.traces = []

    def decides(self, extracted, trace=None):
        self.traces.append(trace)
        return 0.99 if extracted and extracted.get("eligible") else None


@skip
class NeverOverturnTests(unittest.TestCase):
    """The matcher with a learned rule that always says yes (the picture and number are those of the test index)."""

    setUp = v9.WholeReadMatcherTests.setUp
    _cache = v9.WholeReadMatcherTests._cache
    build = v9.WholeReadMatcherTests.build
    matcher = v9.WholeReadMatcherTests.matcher
    found = v9.WholeReadMatcherTests.found
    run_match = v9.WholeReadMatcherTests.run_match

    def test_a_rules_decision_is_never_overturned(self):
        reader = v9.SecondReadReader()
        plain = self.run_match(reader, fastread=True, wholeread=True)
        with_rule = self.run_match(v9.SecondReadReader(), fastread=True, wholeread=True, learned=AlwaysYes())
        self.assertIsNotNone(plain.decision)  # the rules decide this scan
        self.assertEqual(with_rule.decision, plain.decision)
        self.assertNotEqual(with_rule.decision["mechanism"], learned.MECHANISM)
        self.assertTrue(with_rule.features["rules_decided"])
        self.assertIsNone(with_rule.features["probability"])  # it was not even asked to decide

    def test_when_the_rules_are_unsure_it_decides_the_first_candidate_only(self):
        with patch.object(pipeline, "decide", return_value=(None, "no_number_and_picture_not_clear")):
            outcome = self.run_match(v9.SecondReadReader(), fastread=True, wholeread=True, learned=AlwaysYes())
            plain = self.run_match(v9.SecondReadReader(), fastread=True, wholeread=True)
        self.assertIsNone(plain.decision)
        self.assertEqual(outcome.decision["mechanism"], learned.MECHANISM)
        self.assertEqual(outcome.decision["card_id"], outcome.matches[0]["card_id"])  # the first candidate, not another
        self.assertEqual(outcome.features["probability"], 0.99)
        self.assertFalse(outcome.features["rules_decided"])
        self.assertEqual(outcome.features["values"]["reason_no_number_and_picture_not_clear"], 1.0)

    def test_the_trace_name_reaches_the_rule_and_changes_nothing_else(self):
        rule = AlwaysYes()
        with patch.object(pipeline, "decide", return_value=(None, "x")):
            named = self.run_match(v9.SecondReadReader(), fastread=True, wholeread=True, learned=rule)
            self.assertEqual(rule.traces, [None])  # a live scan: no trace name, the full model
            plain = self.run_match(v9.SecondReadReader(), fastread=True, wholeread=True)
        self.assertEqual(named.decision["card_id"], plain.matches[0]["card_id"])
        self.assertIn("trace_name", pipeline.CardMatcher.match.__code__.co_varnames)

    def test_without_a_rule_nothing_changes_and_features_are_recorded(self):
        with patch.object(pipeline, "decide", return_value=(None, "x")):
            outcome = self.run_match(v9.SecondReadReader(), fastread=True, wholeread=True)
        self.assertEqual(outcome.status, "unsure")
        self.assertEqual(outcome.features["card_id"], outcome.matches[0]["card_id"])
        self.assertNotIn("features", outcome.as_dict())  # the result's public shape is unchanged

    def test_a_card_the_finder_lost_is_never_decided_by_the_learned_rule(self):
        with patch.object(pipeline, "decide", return_value=(None, "card_not_found_no_number_read")):
            outcome = self.run_match(v9.SecondReadReader(), method="fallback", fastread=True, wholeread=True, learned=AlwaysYes())
        if outcome.detection.get("fallback"):
            self.assertIsNone(outcome.decision)


@skip
class OptionAndRowTests(unittest.TestCase):
    def test_version_and_default_do_not_move(self):
        self.assertEqual(str(MATCHER_VERSION), "11")
        self.assertFalse(variants.parse(variants.DEFAULT_LABEL).learned)
        self.assertNotIn("learned", variants.DEFAULT_LABEL)

    def test_the_four_new_rows(self):
        no_strict = variants.NO_STRICT_LABEL
        self.assertEqual(no_strict, variants.IN_USE + "+wholeread")
        self.assertFalse(variants.parse(no_strict).wholestrict)
        for label in (no_strict + "+topname", no_strict + "+widefirst+topname", variants.BEST_EXISTING_LABEL + "+learned", no_strict + "+topname+learned"):
            self.assertIn(label, variants.COMPARE_LABELS)
        self.assertEqual(variants.BEST_EXISTING_LABEL, KEPT + "+widefirst")
        self.assertEqual(len(variants.COMPARE_LABELS), len(set(variants.COMPARE_LABELS)))
        for label in variants.COMPARE_LABELS:
            self.assertEqual(variants.parse(label).label, label)
        self.assertTrue(variants.parse(variants.BEST_EXISTING_LABEL + "+learned").learned)

    def test_a_learned_set_needs_training_until_the_file_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            options = variants.parse(variants.NO_STRICT_LABEL + "+topname+learned")
            self.assertTrue(variants.needs_training(options, Path(tmp)))
            self.assertFalse(variants.needs_training(variants.parse(variants.NO_STRICT_LABEL), Path(tmp)))
            learned.save(learned.train(synthetic_rows()), Path(tmp))
            self.assertFalse(variants.needs_training(options, Path(tmp)))

    def test_the_comparison_shows_train_first_for_a_learned_row(self):
        def fake_run_labelled(session_factory, matcher, **kwargs):
            return {"metrics": {"n": 10, "top1_pct": 80, "top5_pct": 90, "top20_pct": 95, "number_exact_pct": 70, "decided_pct": 60,
                                "decided_right_pct": 99, "decided_wrong": 0}, "timings_ms": {}, "memory": {}, "host": {}}

        with tempfile.TemporaryDirectory() as tmp, \
                patch("services.card_match.variants.missing_indexes", lambda o, d: []), \
                patch("services.card_match.variants.build_matcher", lambda o, f, data_dir=None, ocr_reader=None: types.SimpleNamespace(label=o.label)), \
                patch.object(benchmark, "run_labelled", fake_run_labelled), \
                patch.object(sources.ocr_check, "labelled_traces", return_value=[({"user_id": 1}, Path("a"))]):
            report = benchmark.run_compare("labelled", lambda: None, ["names", "names+learned"], data_dir=Path(tmp), trace_dir=None)
        self.assertEqual(report["rows"][0]["status"], "ok")
        self.assertEqual(report["rows"][1]["status"], "skipped")
        self.assertTrue(report["rows"][1]["train_first"])


@skip
class GroupSplitTests(unittest.TestCase):
    def data(self, group, created):
        data = {"user_id": 1, "job_id": 1, "item_id": 1, "created_at": created}
        if group != "local":
            data[trace_sources.SOURCE_KEY] = "prod"
            data[trace_sources.HELD_BACK_KEY] = group == "held_back"
        return data

    def test_the_tuning_group_is_older_own_scans_and_prod_scans_not_held_back(self):
        self.assertTrue(learned.is_tuning(self.data("local", "2026-11-05T01:59:59+00:00")))
        self.assertFalse(learned.is_tuning(self.data("local", "2026-11-05T02:00:00+00:00")))  # the owner's newer scans
        self.assertFalse(learned.is_tuning(self.data("local", "2026-11-12T10:00:00+00:00")))
        self.assertTrue(learned.is_tuning(self.data("tuning", "2026-11-12T10:00:00+00:00")))
        self.assertFalse(learned.is_tuning(self.data("held_back", "2026-10-01T10:00:00+00:00")))
        self.assertTrue(learned.is_tuning({"user_id": 1}))  # no readable time counts as tuning, as ``scan_batch`` says

    def test_training_reads_every_scan_except_held_back_ones(self):
        self.assertTrue(learned.is_training(self.data("local", "2026-10-01T00:00:00+00:00")))
        self.assertTrue(learned.is_training(self.data("local", "2026-11-12T10:00:00+00:00")))  # the owner's newer scans too
        self.assertTrue(learned.is_training(self.data("tuning", "2026-11-12T10:00:00+00:00")))
        self.assertFalse(learned.is_training(self.data("held_back", "2026-10-01T10:00:00+00:00")))
        self.assertFalse(learned.is_training(self.data("held_back", "2026-11-12T10:00:00+00:00")))

    def test_the_three_report_groups_match_the_training_split(self):
        for group, created, expected in (("local", "2026-10-01T00:00:00+00:00", "tuned"), ("local", "2026-11-06T00:00:00+00:00", "new"),
                                         ("tuning", "2026-11-12T00:00:00+00:00", "tuned"), ("held_back", "2026-10-01T00:00:00+00:00", "held_back")):
            data = self.data(group, created)
            name = benchmark.eval_group(trace_sources.group_of(data), benchmark.scan_batch(data))
            self.assertEqual(name, expected)
            self.assertEqual(learned.is_tuning(data), expected == "tuned")  # training reads exactly the tuned group

    def test_group_rows_count_decided_and_wrong_apart(self):
        results = [
            {"group": "local", "batch": "tuning", "decided": True, "decided_right": True, "mechanism": "number"},
            {"group": "local", "batch": "tuning", "decided": False, "decided_right": False, "mechanism": None},
            {"group": "local", "batch": "new", "decided": True, "decided_right": False, "mechanism": "learned"},
            {"group": "prod_held_back", "batch": "tuning", "decided": True, "decided_right": True, "mechanism": "learned"},
            {"group": "prod_tuning", "batch": "tuning", "decided": True, "decided_right": True, "mechanism": "number"},
        ]
        rows = benchmark.eval_group_rows(results)
        self.assertEqual(rows["tuned"], {"n": 3, "decided": 2, "wrong": 0, "learned": 0})
        self.assertEqual(rows["new"], {"n": 1, "decided": 1, "wrong": 1, "learned": 1})
        self.assertEqual(rows["held_back"], {"n": 1, "decided": 1, "wrong": 0, "learned": 1})


@skip
class TrainingReadsOnlyTheTuningGroup(sources.RunLabelledGroupTests):
    """``run_labelled(only=learned.is_tuning)`` never runs the matcher on a held-back or newer scan, and every row carries the groups."""

    # The inherited tests assume the whole run; only the new ones run here.
    test_groups_headline_and_review_photos = None
    test_skip_and_only = None
    test_the_misses_collector_never_gets_a_held_back_scan = None

    def test_only_the_tuning_scans_are_run_and_feed_the_sink(self):
        everything, _ = self.run_it()
        sink = []
        report, matcher = self.run_it(only=learned.is_tuning, feature_sink=sink)
        groups = report["by_group"]
        self.assertNotIn("prod_held_back", groups)
        self.assertEqual(groups["prod_tuning"]["n"], everything["by_group"]["prod_tuning"]["n"])
        self.assertNotIn("local", groups)  # the local scan is dated 2026-11-12 by ``make_trace``'s default: a "new" scan, not trained on
        self.assertEqual(len(matcher.calls), groups["prod_tuning"]["n"])

    def test_training_runs_the_owners_newer_scans_too(self):
        report, _ = self.run_it(only=learned.is_training)
        self.assertNotIn("prod_held_back", report["by_group"])
        self.assertEqual(report["eval_groups"]["new"]["n"], 1)  # the owner's newer scan is read for training now

    def test_a_scan_before_the_new_date_is_trained_on_and_a_later_one_is_not(self):
        sources.make_trace(self.local, 1, "2026-10-01", "old", job=7, item=7, truth="swsh1-1", created="2026-10-01T10:00:00+00:00")
        report, _ = self.run_it(only=learned.is_tuning)
        self.assertEqual(report["by_group"]["local"]["n"], 1)  # "old" only; "mine" (made 2026-11-12) is a new scan and is left out
        self.assertEqual(report["eval_groups"]["new"]["n"], 0)

    def test_the_report_carries_the_three_groups(self):
        report, _ = self.run_it()
        groups = report["eval_groups"]
        self.assertEqual(set(groups), {"tuned", "new", "held_back"})
        self.assertEqual(groups["new"]["n"], 1)
        self.assertEqual(groups["held_back"]["n"], report["by_group"]["prod_held_back"]["n"])
        self.assertEqual(groups["tuned"]["n"], report["by_group"]["prod_tuning"]["n"])
        row = benchmark.compare_row("x", report)
        self.assertEqual(row["eval_groups"], groups)


@skip
class PickWinnerGuardTests(unittest.TestCase):
    def row(self, label, decided, held_new=(20, 0), held_back=(10, 0), top20=99, wrong=0, tuned=(100, 0)):
        return {"label": label, "status": "ok", "top1": 70, "top20": top20, "decided": decided, "decided_wrong": wrong, "p95_ms": 1400,
                "eval_groups": {"tuned": {"n": tuned[0], "decided": 70, "wrong": tuned[1]}, "new": {"n": held_new[0], "decided": 10, "wrong": held_new[1]},
                                "held_back": {"n": held_back[0], "decided": 5, "wrong": held_back[1]}}}

    def test_a_learned_row_with_no_wrong_decision_in_the_held_out_groups_can_win(self):
        rows = [self.row(KEPT, 72.0), self.row(KEPT + "+learned", 78.0)]
        self.assertEqual(benchmark.pick_winner(rows)["label"], KEPT + "+learned")
        self.assertIsNone(benchmark.learned_refused(rows[1]))

    def test_a_wrong_decision_on_either_held_out_group_refuses_it(self):
        for held_new, held_back in (((20, 1), (10, 0)), ((20, 0), (10, 1))):
            rows = [self.row(KEPT, 72.0), self.row(KEPT + "+learned", 80.0, held_new=held_new, held_back=held_back)]
            self.assertEqual(benchmark.learned_refused(rows[1]), "wrong_on_held_out_scans")
            self.assertEqual(benchmark.pick_winner(rows)["label"], KEPT)

    def test_a_wrong_decision_on_a_cross_fitted_scan_refuses_it(self):
        rows = [self.row(KEPT, 72.0), self.row(KEPT + "+learned", 80.0, tuned=(100, 1))]
        self.assertEqual(benchmark.learned_refused(rows[1]), "wrong_on_held_out_scans")
        self.assertEqual(benchmark.pick_winner(rows)["label"], KEPT)

    def test_fewer_than_twenty_scans_measured_refuses_it(self):
        rows = [self.row(KEPT, 72.0), self.row(KEPT + "+learned", 80.0, held_new=(5, 0), held_back=(5, 0), tuned=(9, 0))]
        self.assertEqual(benchmark.learned_refused(rows[0]), None)
        self.assertEqual(benchmark.learned_refused(rows[1]), "too_few_held_out_scans")
        self.assertEqual(benchmark.pick_winner(rows)["label"], KEPT)
        rows[1]["eval_groups"]["held_back"]["n"] = 11  # 9 + 5 + 11 = 25: enough
        self.assertEqual(benchmark.pick_winner(rows)["label"], KEPT + "+learned")

    def test_a_row_without_group_numbers_is_refused_and_does_not_set_the_wrong_bar(self):
        old = self.row(KEPT + "+learned", 90.0)
        old["eval_groups"] = None
        self.assertEqual(benchmark.learned_refused(old), "too_few_held_out_scans")
        # a refused learned row with 0 wrong must not lower the bar for the rows that stay: the others decide 1 wrong, which is the lowest left
        rows = [self.row(KEPT, 72.0, wrong=1), old]
        self.assertEqual(benchmark.pick_winner(rows)["label"], KEPT)

    def test_a_row_that_is_not_learned_is_never_judged_by_the_guard(self):
        plain = self.row(KEPT, 72.0, held_new=(0, 0), held_back=(0, 0), tuned=(0, 0))
        self.assertIsNone(benchmark.learned_refused(plain))
        self.assertEqual(benchmark.pick_winner([plain])["label"], KEPT)


if __name__ == "__main__":
    unittest.main()
