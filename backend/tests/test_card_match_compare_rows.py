"""Choosing which comparison rows to run: label validation, the reference rows that always run, the order, the earlier results shown
for rows not run (with the scan-set fingerprint), and ``pick_winner`` never seeing them. Matching behaviour is unchanged."""
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

if os.name == "nt":  # api.recognize imports fcntl through the auth service; CI is Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

try:
    from services.card_match import benchmark, ocr_check, variants

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")


def metrics(decided=60, wrong=0, top20=95):
    return {"metrics": {"n": 10, "top1_pct": 80, "top5_pct": 90, "top20_pct": top20, "number_exact_pct": 70, "decided_pct": decided,
                        "decided_right_pct": 99, "decided_wrong": wrong}, "timings_ms": {"total": {"median": 100, "p95": 200}}, "memory": {}, "host": {}}


@skip
class ResolveLabelsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)
        patcher = patch.dict(os.environ, {"CARD_MATCH_OPTIONS": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_none_and_empty_mean_every_row_as_before(self):
        for labels in (None, []):
            run, selected, reference = benchmark.resolve_compare_labels("labelled", labels, self.data_dir)
            self.assertEqual(run, list(variants.COMPARE_LABELS))
            self.assertEqual(selected, list(variants.COMPARE_LABELS))
        self.assertEqual(benchmark.resolve_compare_labels("synthetic", None, self.data_dir)[0], list(variants.SYNTHETIC_COMPARE_LABELS))

    def test_unknown_labels_are_refused_and_listed(self):
        with self.assertRaises(ValueError) as caught:
            benchmark.resolve_compare_labels("labelled", ["names", "zzz", "aaa"], self.data_dir)
        self.assertIn("aaa, zzz", str(caught.exception))
        with self.assertRaises(ValueError):  # a labelled-only row is not a synthetic one
            benchmark.resolve_compare_labels("synthetic", [variants.KEPT_LABEL + "+widefirst"], self.data_dir)

    def test_the_label_in_use_and_the_kept_set_always_run_and_the_order_is_the_lists(self):
        run, selected, reference = benchmark.resolve_compare_labels(
            "labelled", [variants.KEPT_LABEL + "+topname", "baseline"], self.data_dir)  # sent out of order
        self.assertEqual(selected, ["baseline", variants.KEPT_LABEL + "+topname"])
        self.assertEqual(reference, [variants.IN_USE, variants.KEPT_LABEL])  # nothing chosen yet: the default is in use
        self.assertEqual(run, ["baseline", variants.IN_USE, variants.KEPT_LABEL, variants.KEPT_LABEL + "+topname"])
        self.assertEqual(run, [label for label in variants.COMPARE_LABELS if label in run])

    def test_the_chosen_label_is_the_reference_when_it_is_a_row(self):
        variants.save_chosen("names+number", "test", self.data_dir)
        _run, _selected, reference = benchmark.resolve_compare_labels("labelled", ["names"], self.data_dir)
        self.assertEqual(reference, ["names+number", variants.KEPT_LABEL])
        with patch.dict(os.environ, {"CARD_MATCH_OPTIONS": variants.IN_USE}):  # the environment wins
            self.assertEqual(benchmark.resolve_compare_labels("labelled", ["names"], self.data_dir)[2], [variants.IN_USE, variants.KEPT_LABEL])

    def test_the_learned_rule_is_parked(self):
        self.assertEqual(variants.parse("names+learned").label, "names")  # an unknown word is ignored
        self.assertFalse(hasattr(variants.Options(), "learned"))
        self.assertFalse([label for label in variants.COMPARE_LABELS if "learned" in label])

    def test_the_prod_pin_is_the_best_set_and_spelled_in_canonical_order(self):
        pin = "names+number+text+art+tta+fastread+numberonce+corners+wholepic+wholeread+widefirst+topname+edgeguard"
        self.assertEqual(variants.parse(pin).label, pin)
        self.assertEqual(pin, variants.NO_STRICT_LABEL + "+widefirst+topname+edgeguard")
        self.assertIn(pin, variants.COMPARE_LABELS)
        compose = Path(__file__).resolve().parents[2] / "docker-compose.portainer.yml"
        if compose.exists():
            self.assertIn("CARD_MATCH_OPTIONS: ${CARD_MATCH_OPTIONS:-" + pin + "}", compose.read_text(encoding="utf-8"))

    def test_titles_and_groups(self):
        groups = {variants.compare_group(label) for label in variants.COMPARE_LABELS}
        self.assertEqual(groups, {"history", "v10 kept", "v12", "v14", "v15", "v16", "custom"})
        self.assertEqual(variants.compare_group(variants.KEPT_LABEL), "v10 kept")
        self.assertEqual(variants.compare_group(variants.KEPT_LABEL + "+custom"), "custom")
        self.assertEqual(variants.compare_title(variants.KEPT_LABEL), "Kept set")
        self.assertEqual(variants.compare_title(variants.KEPT_LABEL + "+widefirst+topname"), "Kept set + widefirst + topname")
        self.assertEqual(variants.compare_title("baseline"), "Baseline (picture only)")
        self.assertTrue(all(variants.compare_title(label) for label in variants.COMPARE_LABELS))


@skip
class PartialComparisonTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)
        for patcher in (
            patch.dict(os.environ, {"CARD_MATCH_OPTIONS": ""}),
            patch.object(variants, "missing_indexes", lambda options, data_dir=None: []),
            patch.object(variants, "build_matcher", lambda options, factory, data_dir=None, ocr_reader=None: SimpleNamespace(label=options.label)),
            patch.object(benchmark, "get_index", lambda name, data_dir=None: SimpleNamespace(card_ids=["c1_en"])),
            patch.object(ocr_check, "labelled_traces", lambda trace_dir, extra_roots=None: [({"ground_truth": "c1", "user_id": 1}, Path("t1.json"))]),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.measured: dict[str, dict] = {}

    def run_compare(self, labels, *, results=None, **kwargs):
        results = results or {}
        calls = []

        def fake_run_labelled(session_factory, matcher, **kw):
            calls.append((matcher.label, kw.get("held_back")))
            return results.get(matcher.label) or metrics()

        with patch.object(benchmark, "run_labelled", fake_run_labelled):
            run, selected, reference = benchmark.resolve_compare_labels("labelled", labels, self.data_dir)
            report = benchmark.run_compare("labelled", lambda: None, run, selected=selected, reference=reference, data_dir=self.data_dir, trace_dir=None, **kwargs)
        return report, calls

    def write_report(self, stamp, rows, fingerprint):
        report = {"kind": "compare-labelled", "created_at": f"2026-11-{stamp}T10:00:00+00:00", "scan_fingerprint": fingerprint, "rows": rows}
        directory = benchmark.reports_dir(self.data_dir)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"benchmark-compare-labelled-2026111{stamp[-1]}-100000.json").write_text(json.dumps(report), encoding="utf-8")

    def ok_row(self, label, decided=50, wrong=0, wrong_scans=0):
        return {"label": label, "status": "ok", "n": 10, "top1": 70, "top5": 80, "top20": 90, "decided": decided, "decided_wrong": wrong,
                "eval_groups": {"tuned": {"n": 5, "decided": 3, "wrong": wrong}}, "wrong_scans": [{"key": i} for i in range(wrong_scans)]}

    def test_only_the_chosen_and_reference_rows_are_run_in_list_order(self):
        report, calls = self.run_compare(["names+number", "names"])
        self.assertEqual([row["label"] for row in report["rows"]], ["names", "names+number", variants.IN_USE, variants.KEPT_LABEL])
        self.assertEqual([label for label, _ in calls[:4]], ["names", "names+number", variants.IN_USE, variants.KEPT_LABEL])
        self.assertEqual({row["label"] for row in report["rows"] if row["reference"]}, {variants.IN_USE, variants.KEPT_LABEL})
        self.assertEqual(report["selected_labels"], ["names", "names+number"])
        self.assertEqual(report["reference_labels"], [variants.IN_USE, variants.KEPT_LABEL])
        self.assertEqual(set(report["not_run"]), set(variants.COMPARE_LABELS) - {row["label"] for row in report["rows"]})
        self.assertTrue(all(row["seconds"] is not None for row in report["rows"]))

    def test_no_labels_run_everything_with_nothing_previous(self):
        report, _calls = self.run_compare(None)
        self.assertEqual([row["label"] for row in report["rows"]], list(variants.COMPARE_LABELS))
        self.assertEqual(report["not_run"], [])
        self.assertEqual(report["previous_rows"], [])

    def test_previous_rows_come_from_the_newest_earlier_measurement_with_same_scans_flag(self):
        # The run's own fingerprint, from the scans patched in above.
        mine = benchmark.scan_fingerprint([({"ground_truth": "c1"}, Path("t1.json"))])
        self.write_report("01", [self.ok_row("names", decided=40), self.ok_row("names+number", decided=41)], "other-scans")
        self.write_report("02", [self.ok_row("names", decided=55, wrong=2, wrong_scans=2), {"label": "names+number", "status": "skipped"}], mine)
        report, _calls = self.run_compare(["baseline"])
        previous = {row["label"]: row for row in report["previous_rows"]}
        self.assertEqual(set(previous), {"names", "names+number"})
        names = previous["names"]
        self.assertEqual((names["status"], names["decided"], names["decided_wrong"], names["wrong_scans_count"], names["n"], names["top20"]), ("previous", 55, 2, 2, 10, 90))
        self.assertEqual(names["date"], "2026-11-02T10:00:00+00:00")
        self.assertIs(names["same_scans"], True)
        self.assertEqual(names["eval_groups"]["tuned"]["wrong"], 2)
        older = previous["names+number"]  # the newer report skipped it, so the older measurement shows, on different scans
        self.assertEqual((older["decided"], older["same_scans"], older["date"]), (41, False, "2026-11-01T10:00:00+00:00"))
        self.assertNotIn("baseline", previous)  # run now

    def test_a_report_with_no_fingerprint_is_unknown_not_the_same(self):
        self.write_report("01", [self.ok_row("names")], None)
        report, _calls = self.run_compare(["baseline"])
        self.assertIsNone(report["previous_rows"][0]["same_scans"])

    def test_previous_rows_never_reach_the_pick(self):
        # An earlier row that would beat everything measured now: it is shown, never picked.
        self.write_report("01", [self.ok_row("names", decided=99, wrong=0)], "x")
        report, _calls = self.run_compare(["baseline"], results={variants.IN_USE: metrics(decided=60), variants.KEPT_LABEL: metrics(decided=70), "baseline": metrics(decided=10)})
        self.assertNotEqual(report["winner"], "names")
        self.assertIn(report["winner"], {row["label"] for row in report["rows"]})
        self.assertEqual(report["winner"], variants.KEPT_LABEL)
        self.assertTrue(any(row["label"] == "names" for row in report["previous_rows"]))
        self.assertNotIn("names", {row["label"] for row in report["rows"]})

    def test_pick_winner_ignores_rows_that_are_not_status_ok(self):
        better = {**self.ok_row("names", decided=99), "status": "previous", "p95_ms": 100}
        measured = {**self.ok_row("baseline", decided=10), "p95_ms": 100}
        self.assertEqual(benchmark.pick_winner([better, measured])["label"], "baseline")
        self.assertIsNone(benchmark.pick_winner([better]))

    def test_the_fingerprint_changes_with_a_correction_or_another_scan_and_not_with_order(self):
        a = ({"ground_truth": "c1"}, Path("a.json"))
        b = ({"ground_truth": "c2"}, Path("b.json"))
        self.assertEqual(benchmark.scan_fingerprint([a, b]), benchmark.scan_fingerprint([b, a]))
        self.assertNotEqual(benchmark.scan_fingerprint([a, b]), benchmark.scan_fingerprint([a]))
        corrected = ({"ground_truth": "c9"}, Path("a.json"))
        self.assertNotEqual(benchmark.scan_fingerprint([a, b]), benchmark.scan_fingerprint([corrected, b]))
        before = benchmark.scan_fingerprint([a, b])
        with patch.object(benchmark, "MATCHER_VERSION", "999"):
            self.assertNotEqual(before, benchmark.scan_fingerprint([a, b]))

    def test_last_row_seconds_reads_the_newest_time(self):
        self.write_report("01", [{**self.ok_row("names"), "seconds": 100.0}], "x")
        self.write_report("02", [{**self.ok_row("names"), "seconds": 120.5}, self.ok_row("names+number")], "x")
        times = benchmark.last_row_seconds("labelled", self.data_dir)
        self.assertEqual(times["names"]["seconds"], 120.5)
        self.assertNotIn("names+number", times)


if __name__ == "__main__":
    unittest.main()
