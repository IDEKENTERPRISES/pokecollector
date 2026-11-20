"""The nonprod autorun (services/card_match/autorun.py): the plan fingerprint, which rows and steps run, a failing step, the switch and the
button, and prod (the environment variable off). Fakes stand in for every job; nothing heavy runs."""
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api import card_match as card_match_api
    from database import Base
    from models import AuditLog, User
    from services.card_match import MATCHER_VERSION, autorun, benchmark, custom_models, variants
    from services.card_match import index as index_module

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

MODEL_ID = "custom-aaaaaaaa"


def write_registry(directory, *, model_id=MODEL_ID, uploaded_at="2026-11-18T10:00:00+00:00", calibration=None):
    entry = {"id": model_id, "uploaded_at": uploaded_at, "name": "m"}
    if calibration:
        entry["calibration"] = calibration
    path = custom_models.registry_path(Path(directory))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([entry]), encoding="utf-8")


def build_index(directory, name, built_at="2026-11-18T09:00:00+00:00"):
    folder = index_module.index_dir(name, Path(directory))
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "entries.json").write_text(json.dumps({"count": 5, "built_at": built_at, "dim": 4}), encoding="utf-8")


def build_all_indexes(directory, with_custom=True):
    names = [variants.DEFAULT_MODEL if hasattr(variants, "DEFAULT_MODEL") else "dinov2-small", variants.ART_INDEX]
    if with_custom:
        names += list(custom_models.index_names(MODEL_ID).values())
    for name in names:
        build_index(directory, name)


def row(label, signature, **extra):
    return {"label": label, "status": "ok", "n": 100, "top1": 50, "top5": 60, "top20": 70, "number_exact": 40, "decided": 30, "decided_right": 30,
            "decided_wrong": 0, "signature": signature, **extra}


def save_compare(directory, rows, fingerprint="scans-1", kind="labelled"):
    benchmark.save_report({"kind": f"compare-{kind}", "created_at": "2026-11-18T12:00:00+00:00", "scan_fingerprint": fingerprint, "rows": rows}, Path(directory))


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class PlanFingerprintTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        write_registry(self.dir)
        build_all_indexes(self.dir)

    def tearDown(self):
        self.tmp.cleanup()

    def fp(self, scans="scans-1"):
        return autorun.plan_fingerprint(scans, self.dir)

    def test_it_is_stable_and_changes_for_each_input(self):
        base = self.fp()
        self.assertEqual(base, self.fp())  # nothing changed: the same
        self.assertNotEqual(base, self.fp("scans-2"))  # the scan set
        with patch.object(autorun, "_version", return_value="999"), patch("services.card_match.MATCHER_VERSION", "999"):
            self.assertNotEqual(base, self.fp())  # the matcher version
        with patch.dict(variants.OPTION_VERSIONS, {"edgeguard": 2}):
            self.assertNotEqual(base, self.fp())  # a row's option word changed
        with patch.object(variants, "COMPARE_LABELS", (*variants.COMPARE_LABELS, "names+tta")):
            self.assertNotEqual(base, self.fp())  # a new row
        build_index(self.dir, variants.ART_INDEX, built_at="2026-11-19T01:00:00+00:00")
        self.assertNotEqual(base, self.fp())  # an index was rebuilt
        build_index(self.dir, variants.ART_INDEX)
        self.assertEqual(base, self.fp())
        write_registry(self.dir, calibration={"at": "2026-11-18T11:00:00+00:00", "thresholds": {"a": 1}})
        calibrated = self.fp()
        self.assertNotEqual(base, calibrated)  # a calibration appeared
        write_registry(self.dir, calibration={"at": "2026-11-19T11:00:00+00:00", "thresholds": {"a": 1}})
        self.assertNotEqual(calibrated, self.fp())  # recalibrated
        write_registry(self.dir, model_id="custom-bbbbbbbb")
        self.assertNotEqual(base, self.fp())  # a new custom model

    def test_a_missing_marker_or_one_without_a_fingerprint_is_due(self):
        with patch.dict(os.environ, {"CARD_MATCH_DIR": str(self.dir)}), patch.object(autorun, "scan_set_fingerprint", return_value="scans-1"):
            self.assertTrue(autorun.autorun_due())
            autorun.marker_path().write_text(json.dumps({"matcher_version": MATCHER_VERSION}), encoding="utf-8")
            self.assertTrue(autorun.autorun_due())
            autorun.marker_path().write_text(json.dumps({"plan_fingerprint": self.fp()}), encoding="utf-8")
            self.assertFalse(autorun.autorun_due())
            autorun.marker_path().write_text(json.dumps({"plan_fingerprint": self.fp("scans-2")}), encoding="utf-8")
            self.assertTrue(autorun.autorun_due())


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class RowSelectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        write_registry(self.dir)
        self.labels = list(variants.COMPARE_LABELS)
        self.reference = set(variants.compare_reference_labels(self.labels, self.dir))
        self.others = [label for label in self.labels if label not in self.reference]

    def tearDown(self):
        self.tmp.cleanup()

    def current(self, label):
        return variants.row_signature(label, self.dir)

    def test_signatures_hold_the_matcher_version_the_words_the_model_and_the_calibration(self):
        plain = variants.row_signature("names+number", self.dir)
        self.assertIn(f"v{MATCHER_VERSION}", plain)
        self.assertIn("names1+number1", plain)
        self.assertNotIn("model=", plain)
        self.assertIn(f"model={MODEL_ID}", variants.row_signature(variants.V16_LABELS[0], self.dir))
        self.assertIn("cal=none", variants.row_signature(variants.V16_LABELS[1], self.dir))
        self.assertNotIn("cal=", variants.row_signature(variants.V16_LABELS[0], self.dir))
        with patch.dict(variants.OPTION_VERSIONS, {"names": 2}):
            self.assertIn("names2", variants.row_signature("names", self.dir))
        self.assertEqual(set(variants.OPTION_VERSIONS), {"names", "number", "text", "art", "reprint", "base", "tta", "fastread", "numberonce", "corners",
                                                         "wholepic", "trustrejected", "wholeread", "wholestrict", "widefirst", "topname", "edgeguard",
                                                         "serverocr", "custom", "calibrated"})
        self.assertTrue(all(value >= 1 for value in variants.OPTION_VERSIONS.values()))

    def test_with_no_earlier_report_every_row_is_new_except_the_reference_rows(self):
        plan = benchmark.plan_rows("labelled", "scans-1", self.dir)
        self.assertEqual(list(plan), self.labels)  # the order of the full list
        self.assertEqual({label for label, why in plan.items() if why == "reference"}, self.reference)
        self.assertTrue(all(plan[label] == "new" for label in self.others))

    def test_new_changed_no_signature_scans_changed_and_reference(self):
        fresh, changed, unsigned, new = self.others[0], self.others[1], self.others[2], self.others[3]
        rows = [row(label, self.current(label)) for label in self.labels if label != new]
        rows = [row(label, "old-signature") if label == changed else row(label, None) if label == unsigned else r for r, label in zip(rows, [r["label"] for r in rows])]
        save_compare(self.dir, rows, fingerprint="scans-1")
        plan = benchmark.plan_rows("labelled", "scans-1", self.dir)
        self.assertEqual(plan[new], "new")
        self.assertEqual(plan[changed], "changed")
        self.assertEqual(plan[unsigned], "changed")  # a previous result with no signature
        self.assertNotIn(fresh, plan)  # same signature, same scans: left out
        for label in self.reference:
            self.assertEqual(plan[label], "reference")  # always runs, even with a current result
        # the same results on another scan set: every row that is not new or changed runs again, so the table stays comparable
        again = benchmark.plan_rows("labelled", "scans-2", self.dir)
        self.assertEqual(again[fresh], "scans changed")
        self.assertEqual(again[changed], "changed")
        self.assertEqual(again[new], "new")
        self.assertEqual(set(again), set(self.labels))
        # a custom model recalibrated since: the calibrated row's signature changed
        write_registry(self.dir, calibration={"at": "2026-11-19T00:00:00+00:00", "thresholds": {"a": 1}})
        calibrated = variants.V16_LABELS[1]
        self.assertEqual(benchmark.plan_rows("labelled", "scans-1", self.dir)[calibrated], "changed")

    def test_the_planned_rows_and_reasons_are_saved_on_the_rows_of_the_report(self):
        with patch.object(variants, "build_matcher", return_value=object()), \
                patch.object(benchmark, "run_labelled", return_value={"metrics": {"n": 1, "top1_pct": 1, "top5_pct": 1, "top20_pct": 1, "number_exact_pct": 1,
                                                                                  "decided_pct": 1, "decided_right_pct": 1, "decided_wrong": 0}}):
            report = benchmark.run_compare("labelled", None, ["baseline"], data_dir=self.dir, trace_dir=self.dir, why={"baseline": "new"})
        self.assertEqual(report["rows"][0]["signature"], self.current("baseline"))
        self.assertEqual(report["rows"][0]["why"], "new")
        save_compare(self.dir, report["rows"])
        self.assertEqual(benchmark.previous_rows("labelled", ["baseline"], None, self.dir)[0]["signature"], self.current("baseline"))


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class StepSelectionTests(unittest.TestCase):
    def steps(self, **changes):
        args = dict(missing=[], calibrate=False, version_changed=False, scans_changed=False, enough_real=True)
        args.update(changes)
        return autorun.choose_steps(**args)

    def test_a_new_row_only_runs_the_benchmark_and_the_compare(self):
        self.assertEqual(self.steps(), ["labelled", "compare-labelled"])

    def test_new_scans_add_the_ocr_check(self):
        self.assertEqual(self.steps(scans_changed=True), ["ocr-check", "labelled", "compare-labelled"])

    def test_a_new_matcher_version_adds_the_ocr_check_and_the_synthetic_runs(self):
        self.assertEqual(self.steps(version_changed=True), ["ocr-check", "labelled", "compare-labelled", "synthetic", "compare-synthetic"])

    def test_missing_indexes_come_first_then_the_calibration(self):
        self.assertEqual(self.steps(missing=["custom-index", "custom-art-index"], calibrate=True),
                         ["warm-up", "custom-index", "custom-art-index", "calibrate", "labelled", "compare-labelled"])
        self.assertEqual(self.steps(missing=["art-index", "index"])[:3], ["warm-up", "index", "art-index"])

    def test_a_calibration_alone(self):
        self.assertEqual(self.steps(calibrate=True), ["calibrate", "labelled", "compare-labelled"])

    def test_too_few_confirmed_scans_leave_out_the_real_photo_steps(self):
        self.assertEqual(self.steps(enough_real=False, version_changed=True), ["synthetic", "compare-synthetic"])
        self.assertEqual(self.steps(enough_real=False), [])

    def test_force_runs_everything(self):
        self.assertEqual(self.steps(force=True), ["calibrate", "ocr-check", "labelled", "compare-labelled", "synthetic", "compare-synthetic"])

    def test_calibration_is_due_without_one_or_when_older_than_the_model_the_version_or_the_scans(self):
        model = {"id": MODEL_ID, "uploaded_at": "2026-11-18T10:00:00+00:00"}
        good = {"at": "2026-11-18T11:00:00+00:00", "thresholds": {"a": 1}, "matcher_version": str(MATCHER_VERSION), "scan_fingerprint": "t1"}
        self.assertFalse(autorun.calibration_due(None, "t1"))
        self.assertTrue(autorun.calibration_due(model, "t1"))
        self.assertFalse(autorun.calibration_due({**model, "calibration": good}, "t1"))
        self.assertTrue(autorun.calibration_due({**model, "calibration": {**good, "at": "2026-11-18T09:00:00+00:00"}}, "t1"))  # older than the model
        self.assertTrue(autorun.calibration_due({**model, "calibration": {**good, "matcher_version": "0"}}, "t1"))
        self.assertTrue(autorun.calibration_due({**model, "calibration": good}, "t2"))  # the Tuned scans changed
        self.assertFalse(autorun.calibration_due({**model, "calibration": good}, None))  # indexes not built: cannot tell, keep it


class FakeJobs:
    """Stands in for the job runner: records what starts, and fails the kinds named in ``errors``."""

    def __init__(self, errors=None):
        self.errors = errors or {}
        self.started = []
        self.error = None
        self.stop = threading.Event()

    def start(self, kind, labels=None, why=None):
        self.started.append((kind, list(labels) if labels else None, dict(why) if why else None))
        self.error = self.errors.get(kind)
        return True, {}


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class ChainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {"CARD_MATCH_DIR": self.tmp.name, "SCAN_MATCHER_AUTORUN": "1"})
        self.env.start()
        write_registry(self.dir)
        autorun._set_state(running=False, step=None)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def run_chain(self, fake, *, enough=150, scans="scans-1", force=False, trigger="deploy", marker=None):
        if marker is not None:
            autorun.marker_path().write_text(json.dumps(marker), encoding="utf-8")

        def start_index(name):
            return fake.start(f"index:{name}")

        with patch.object(autorun, "scan_set_fingerprint", return_value=scans), patch.object(autorun, "tuned_fingerprint", return_value="t1"), \
                patch.object(autorun, "start_index", side_effect=start_index), \
                patch.object(autorun, "start_benchmark", side_effect=lambda kind, model, labels=None, why=None: fake.start(f"benchmark-{kind}", labels, why)), \
                patch.object(autorun, "start_calibration", side_effect=lambda model_id, on_stored=None: fake.start("calibrate")), \
                patch.object(autorun.jobs, "wait"), patch.object(autorun.jobs, "status", side_effect=lambda: {"error": fake.error}), \
                patch.object(benchmark, "count_labelled_traces", return_value=enough):
            return autorun.run_chain(trigger=trigger, force=force)

    def test_the_first_run_after_a_deploy_calibrates_then_compares_and_records_every_row_with_its_reason(self):
        build_all_indexes(self.dir)
        fake = FakeJobs()
        log = self.run_chain(fake)
        kinds = [kind for kind, _labels, _why in fake.started]
        self.assertEqual(kinds, ["calibrate", "benchmark-ocr-check", "benchmark-labelled", "benchmark-compare-labelled",
                                 "benchmark-synthetic", "benchmark-compare-synthetic"])
        compare = next(item for item in fake.started if item[0] == "benchmark-compare-labelled")
        self.assertEqual(compare[1], list(variants.COMPARE_LABELS))  # nothing measured before: every row runs
        self.assertEqual(set(compare[2].values()), {"new", "reference"})
        step = next(item for item in log["steps"] if item["step"] == "compare-labelled")
        self.assertEqual(len(step["rows"]), len(variants.COMPARE_LABELS))
        self.assertTrue(json.loads(autorun.log_path().read_text(encoding="utf-8"))["steps"])
        self.assertTrue(json.loads(autorun.marker_path().read_text(encoding="utf-8"))["plan_fingerprint"])

    def test_a_failing_calibration_does_not_stop_the_compare(self):
        build_all_indexes(self.dir)
        fake = FakeJobs(errors={"calibrate": "Only 40 confirmed scans in the Tuned group"})
        log = self.run_chain(fake)
        kinds = [kind for kind, _labels, _why in fake.started]
        self.assertIn("benchmark-compare-labelled", kinds)
        self.assertIn("benchmark-compare-synthetic", kinds)
        calibrate = next(item for item in log["steps"] if item["step"] == "calibrate")
        self.assertIn("Only 40", calibrate["error"])
        self.assertTrue(autorun.marker_path().exists())

    def test_a_failed_index_build_skips_the_steps_that_need_it_but_not_the_other_index_builds(self):
        fake = FakeJobs(errors={f"index:{variants.DEFAULT_MODEL if hasattr(variants, 'DEFAULT_MODEL') else 'dinov2-small'}": "no pictures"})
        log = self.run_chain(fake)
        by_step = {item["step"]: item for item in log["steps"]}
        self.assertIn("no pictures", by_step["index"]["error"])
        self.assertIn("art-index", by_step)  # still built
        self.assertNotIn("error", {k: v for k, v in by_step["art-index"].items() if v})
        for name in ("calibrate", "ocr-check", "labelled", "compare-labelled", "synthetic", "compare-synthetic"):
            self.assertIn("skipped", by_step[name])
        self.assertNotIn("benchmark-compare-labelled", [kind for kind, _l, _w in fake.started])

    def test_a_failed_custom_index_skips_only_the_calibration(self):
        build_all_indexes(self.dir, with_custom=False)
        whole = custom_models.index_names(MODEL_ID)["whole"]
        fake = FakeJobs(errors={f"index:{whole}": "boom"})
        log = self.run_chain(fake)
        by_step = {item["step"]: item for item in log["steps"]}
        self.assertIn("skipped", by_step["calibrate"])
        self.assertNotIn("skipped", by_step["compare-labelled"])

    def test_unchanged_since_the_last_run_runs_nothing_and_a_second_run_only_runs_what_changed(self):
        build_all_indexes(self.dir)
        write_registry(self.dir, calibration={"at": "2026-11-18T11:00:00+00:00", "thresholds": {"a": 1}, "matcher_version": str(MATCHER_VERSION), "scan_fingerprint": "t1"})
        with patch.object(autorun, "scan_set_fingerprint", return_value="scans-1"):
            self.run_chain(FakeJobs())
            self.assertFalse(autorun.autorun_due())
            with patch.dict(variants.OPTION_VERSIONS, {"serverocr": 2}):
                self.assertTrue(autorun.autorun_due())
        # the compare of a later run: only the row whose word changed (plus the reference rows) runs
        labels = list(variants.COMPARE_LABELS)
        save_compare(self.dir, [row(label, variants.row_signature(label, self.dir)) for label in labels])
        fake = FakeJobs()
        with patch.dict(variants.OPTION_VERSIONS, {"serverocr": 2}):
            self.run_chain(fake, marker={"matcher_version": str(MATCHER_VERSION), "scan_fingerprint": "scans-1", "plan_fingerprint": "old"})
        kinds = [kind for kind, _l, _w in fake.started]
        self.assertEqual(kinds, ["benchmark-labelled", "benchmark-compare-labelled"])  # no OCR check, no synthetic: version and scans are the same
        why = next(item for item in fake.started if item[0] == "benchmark-compare-labelled")[2]
        self.assertEqual(sorted(label for label, reason in why.items() if reason == "changed"), sorted(label for label in labels if "serverocr" in label))

    def test_force_runs_every_row_and_every_step(self):
        build_all_indexes(self.dir)
        fake = FakeJobs()
        self.run_chain(fake, force=True, trigger="manual", marker={"matcher_version": str(MATCHER_VERSION), "scan_fingerprint": "scans-1", "plan_fingerprint": "x"})
        compare = next(item for item in fake.started if item[0] == "benchmark-compare-labelled")
        self.assertEqual(compare[1], list(variants.COMPARE_LABELS))
        self.assertEqual(set(compare[2].values()), {"forced"})
        self.assertIn("calibrate", [kind for kind, _l, _w in fake.started])
        self.assertIn("benchmark-synthetic", [kind for kind, _l, _w in fake.started])

    def test_with_the_switch_off_nothing_runs(self):
        fake = FakeJobs()
        with patch.object(autorun, "switch_on", return_value=False), patch.object(autorun, "run_chain") as chain, patch.object(autorun, "autorun_due", return_value=True):
            self.assertTrue(autorun.autorun_once(None, delay_seconds=0))
            for thread in threading.enumerate():
                if thread.name == "card-match-autorun":
                    thread.join(10)
        chain.assert_not_called()
        self.assertEqual(fake.started, [])

    def test_with_the_switch_on_it_runs_only_when_due(self):
        for due, expected in ((True, 1), (False, 0)):
            with patch.object(autorun, "switch_on", return_value=True), patch.object(autorun, "run_chain") as chain, patch.object(autorun, "autorun_due", return_value=due):
                self.assertTrue(autorun.autorun_once(None, delay_seconds=0))
                for thread in threading.enumerate():
                    if thread.name == "card-match-autorun":
                        thread.join(10)
            self.assertEqual(chain.call_count, expected)

    def test_run_all_now_is_refused_while_a_job_runs_and_starts_otherwise(self):
        with patch.object(autorun.jobs, "is_running", return_value=True), patch.object(autorun, "run_chain") as chain:
            started, refusal = autorun.start_run_all(None)
        self.assertFalse(started)
        self.assertIn("running", refusal)
        chain.assert_not_called()
        with patch.object(autorun.jobs, "is_running", return_value=False), patch.object(autorun, "run_chain", side_effect=lambda **kw: autorun._set_state(running=False)) as chain:
            started, refusal = autorun.start_run_all(None)
            for thread in threading.enumerate():
                if thread.name == "card-match-autorun-manual":
                    thread.join(10)
        self.assertTrue(started)
        chain.assert_called_once()
        self.assertTrue(chain.call_args.kwargs["force"])  # ignores the fingerprint
        autorun._set_state(running=True)  # the chain itself is running: a second press is refused too
        self.assertFalse(autorun.start_run_all(None)[0])
        autorun._set_state(running=False)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class SwitchAndProdTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.admin = User(username="boss", hashed_password="x", role="admin")
        self.friend = User(username="friend", hashed_password="x", role="user")
        self.db.add_all([self.admin, self.friend])
        self.db.commit()
        autorun._set_state(running=False, step=None)

    def tearDown(self):
        self.db.close()

    def test_the_switch_defaults_to_the_environment_and_a_stored_choice_wins_and_is_audited(self):
        with patch.dict(os.environ, {"SCAN_MATCHER_AUTORUN": "1"}):
            self.assertTrue(autorun.switch_on(self.db))
            autorun.set_switch(self.db, False, self.admin)
            self.assertFalse(autorun.switch_on(self.db))
            autorun.set_switch(self.db, False, self.admin)  # unchanged: no second entry
            self.assertEqual(self.db.query(AuditLog).filter(AuditLog.action == "scanner.matcher_autorun.updated").count(), 1)
            autorun.set_switch(self.db, True, self.admin)
            self.assertTrue(autorun.switch_on(self.db))
            self.assertEqual(self.db.query(AuditLog).filter(AuditLog.action == "scanner.matcher_autorun.updated").count(), 2)

    def test_on_prod_the_switch_the_button_and_the_api_are_refused_and_nothing_is_shown(self):
        with patch.dict(os.environ, {"SCAN_MATCHER_AUTORUN": ""}):
            self.assertFalse(autorun.available())
            self.assertFalse(autorun.switch_on(self.db))
            self.assertEqual(autorun.info(), {"available": False})
            with self.assertRaises(PermissionError):
                autorun.set_switch(self.db, True, self.admin)
            with self.assertRaises(PermissionError):
                autorun.start_run_all(None)
            self.assertFalse(autorun.autorun_once(None, delay_seconds=0))
            body = card_match_api.AutorunSwitchRequest(enabled=True)
            with self.assertRaises(HTTPException) as refused:
                card_match_api.set_autorun_switch(body, None, self.db, self.admin)
            self.assertEqual(refused.exception.status_code, 409)
            with self.assertRaises(HTTPException) as refused:
                card_match_api.run_all_tests_now(self.admin)
            self.assertEqual(refused.exception.status_code, 409)

    def test_only_an_admin_can_use_the_api_and_a_running_job_refuses_run_all(self):
        with patch.dict(os.environ, {"SCAN_MATCHER_AUTORUN": "1"}):
            with self.assertRaises(HTTPException) as refused:
                card_match_api.run_all_tests_now(self.friend)
            self.assertEqual(refused.exception.status_code, 403)
            with patch.object(autorun.jobs, "is_running", return_value=True):
                with self.assertRaises(HTTPException) as refused:
                    card_match_api.run_all_tests_now(self.admin)
            self.assertEqual(refused.exception.status_code, 409)
            result = card_match_api.set_autorun_switch(card_match_api.AutorunSwitchRequest(enabled=False), None, self.db, self.admin)
            self.assertFalse(result["autorun_info"]["enabled"])


if __name__ == "__main__":
    unittest.main()
