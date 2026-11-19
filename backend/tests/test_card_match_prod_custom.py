"""Prod's pin on the calibrated custom picture model: the calibration and the model pinned from the environment, ids that are the same on every
server, the two index builds after an upload, a pin that behaves as the old one until the model is there, the warm-up order and the compose files."""
import io
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

    from services.card_match import custom_models, embed, index as index_module, jobs, pipeline, variants, warmup

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

try:
    import onnx  # noqa: F401

    from tests.test_card_match_custom_model import tiny_model

    ONNX_AVAILABLE = True
except (ModuleNotFoundError, ImportError):
    ONNX_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
needs_onnx = unittest.skipUnless(DEPS_AVAILABLE and ONNX_AVAILABLE, "the onnx package is not installed")

ROOT = Path(__file__).resolve().parents[2]
OLD_PIN = "names+number+text+art+tta+fastread+numberonce+corners+wholepic+wholeread+widefirst+topname+edgeguard"
NEW_PIN = OLD_PIN + "+custom+calibrated"
MODEL = "custom-f718bb84"
TABLE = {
    "sim_min_with_rules": 0.30, "sim_min_picture_only": 0.65, "lead_min_picture_only": 0.10, "sim_min_picture_strong": 0.81,
    "lead_min_picture_strong": 0.13, "sim_min_name_picture": 0.65, "lead_min_name_picture": 0.06, "lookup_sim_set": 0.31,
    "lookup_sim_total": 0.37, "whole_sim_min": 0.37, "reprint_art_lead": 0.08, "same_name_picture_margin": 0.10,
}


def entry(model_id=MODEL, uploaded_at="2026-11-19T00:00:00+00:00", calibration=None):
    value = {"id": model_id, "name": "Mine", "sha256": model_id[len("custom-"):] * 8, "uploaded_at": uploaded_at, "uploaded_by": "oak", "size_bytes": 1,
             "dim": 384, "input_size": 224, "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]}
    if calibration:
        value["calibration"] = calibration
    return value


def pinned(model=MODEL, table=None, **extra):
    return json.dumps({"model": model, "thresholds": TABLE if table is None else table, **extra})


class DataDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        env = patch.dict(os.environ, {"CARD_MATCH_DIR": self.tmp.name, "CARD_MATCH_MODEL_DIR": self.tmp.name, "CARD_MATCH_OPTIONS": NEW_PIN,
                                      "CARD_MATCH_CUSTOM_MODEL": "", "CARD_MATCH_CUSTOM_CALIBRATION": ""})
        env.start()
        self.addCleanup(env.stop)
        custom_models._logged_bad.clear()

    def register(self, *entries):
        custom_models._write_registry(list(entries), self.dir)

    def install(self, model_id=MODEL):
        """The model's file and both indexes, so the model is usable."""
        custom_models.models_dir(self.dir).mkdir(parents=True, exist_ok=True)
        custom_models.model_file(model_id, self.dir).write_bytes(b"x")
        for name in custom_models.index_names(model_id).values():
            index_module.save_index(index_module.CardIndex(name, np.eye(3, 384, dtype=np.float32), [(f"c{i}", f"k{i}") for i in range(3)]), self.dir)


@skip
class EnvCalibrationTests(DataDirCase):
    def test_used_when_the_model_in_use_has_no_calibration_of_its_own(self):
        self.register(entry())
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_CALIBRATION": pinned(source="nonprod autorun", at="2026-11-19T06:33:16+00:00", ignored="x")}):
            options = variants.parse(NEW_PIN)
            thresholds = variants.thresholds_for(options, self.dir)
            self.assertEqual(thresholds.as_dict(), TABLE)
            self.assertIsNone(variants.calibration_problem(options, self.dir))
            calibration = custom_models.effective_calibration(custom_models.selected(self.dir))
            self.assertEqual((calibration["origin"], calibration["source"]), ("environment", "nonprod autorun"))

    def test_ignored_for_another_model(self):
        self.register(entry())
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_CALIBRATION": pinned(model="custom-00000000")}):
            self.assertIsNone(variants.thresholds_for(variants.parse(NEW_PIN), self.dir))
            self.assertEqual(variants.calibration_problem(variants.parse(NEW_PIN), self.dir), "calibrate the custom model first")

    def test_the_models_own_calibration_wins(self):
        own = {"at": "2026-11-19T07:00:00+00:00", "thresholds": {**TABLE, "sim_min_picture_only": 0.7}}
        self.register(entry(calibration=own))
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_CALIBRATION": pinned()}):
            self.assertEqual(variants.thresholds_for(variants.parse(NEW_PIN), self.dir).sim_min_picture_only, 0.7)
            self.assertEqual(custom_models.effective_calibration(custom_models.selected(self.dir))["origin"], "model")

    def test_broken_values_mean_no_pinned_calibration_and_are_logged(self):
        self.register(entry())
        bad = ["{not json", "[1, 2]", json.dumps({"thresholds": TABLE}), json.dumps({"model": "nonsense", "thresholds": TABLE}),
               pinned(table={**TABLE, "sim_min_picture_only": "0.65"}), pinned(table={**TABLE, "lookup_sim_set": True}), pinned(table={}),
               json.dumps({"model": MODEL, "thresholds": [0.3]})]
        for value in bad:
            with self.subTest(value=value), patch.dict(os.environ, {"CARD_MATCH_CUSTOM_CALIBRATION": value}):
                with self.assertLogs(custom_models.logger, "WARNING"):
                    self.assertIsNone(custom_models.pinned_calibration())
                self.assertIsNone(variants.thresholds_for(variants.parse(NEW_PIN), self.dir))
                self.assertEqual(variants.calibration_problem(variants.parse(NEW_PIN), self.dir), "calibrate the custom model first")

    def test_without_custom_calibrated_does_nothing(self):
        self.register(entry())
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_CALIBRATION": pinned()}):
            self.assertIsNone(variants.thresholds_for(variants.parse(OLD_PIN + "+calibrated"), self.dir))
            self.assertIsNone(variants.thresholds_for(variants.parse(OLD_PIN + "+custom"), self.dir))

    def test_the_row_signature_changes_with_the_pinned_calibration(self):
        self.register(entry())
        label = variants.V16_LABELS[1]
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_CALIBRATION": pinned(at="2026-11-19T06:33:16+00:00")}):
            self.assertIn("cal=2026-11-19T06:33:16+00:00", variants.row_signature(label, self.dir))


@skip
class CustomModelSelectionTests(DataDirCase):
    def test_newest_when_not_pinned(self):
        self.register(entry("custom-aaaaaaaa", "2026-11-01T00:00:00+00:00"), entry("custom-bbbbbbbb", "2026-11-02T00:00:00+00:00"))
        self.assertEqual(custom_models.selected_name(self.dir), "custom-bbbbbbbb")
        self.assertEqual(variants.model_name(variants.parse(NEW_PIN), self.dir), "custom-bbbbbbbb")

    def test_the_pinned_model_is_used_when_it_is_uploaded_even_if_older(self):
        self.register(entry("custom-aaaaaaaa", "2026-11-01T00:00:00+00:00"), entry("custom-bbbbbbbb", "2026-11-02T00:00:00+00:00"))
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_MODEL": " custom-aaaaaaaa "}):
            self.assertEqual(custom_models.selected_name(self.dir), "custom-aaaaaaaa")
            self.assertEqual(variants.main_index_name(variants.parse(NEW_PIN), self.dir), "custom-aaaaaaaa")
            self.assertEqual(variants.art_index_name(variants.parse(NEW_PIN), self.dir), "custom-aaaaaaaa-art")

    def test_a_pinned_model_that_is_not_uploaded_means_no_custom_model(self):
        self.register(entry("custom-bbbbbbbb"))  # another model is there, but the pin names one that is not
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_MODEL": MODEL}):
            self.assertEqual(custom_models.selected_name(self.dir), custom_models.MISSING_NAME)
            self.assertEqual(variants.usable(variants.parse(NEW_PIN), self.dir), variants.usable(variants.parse(OLD_PIN), self.dir))


@needs_onnx
class StableIdTests(unittest.TestCase):
    def test_the_id_is_the_first_eight_of_the_sha256_on_every_server(self):
        import hashlib

        data = tiny_model()
        sha = hashlib.sha256(data).hexdigest()
        ids = []
        for _ in range(2):  # two "servers": separate data folders, different upload names and users
            with tempfile.TemporaryDirectory() as folder:
                saved = custom_models.save_upload(io.BytesIO(data), f"upload {len(ids)}", f"admin{len(ids)}", data_dir=Path(folder))
                ids.append(saved["id"])
                self.assertEqual(saved["sha256"], sha)
        self.assertEqual(ids, [f"custom-{sha[:8]}"] * 2)
        self.assertTrue(custom_models.is_custom_name(ids[0]))


@skip
class AutoIndexBuildTests(unittest.TestCase):
    def test_the_two_indexes_build_one_after_the_other(self):
        built = []
        summary = jobs.custom_indexes_work(MODEL, build=lambda name: built.append(name) or {"built": name})
        self.assertEqual(built, [MODEL, MODEL + "-art"])
        self.assertEqual(summary["model"], MODEL)

    def test_a_failed_first_build_ends_the_job(self):
        built = []

        def build(name):
            built.append(name)
            raise RuntimeError("boom")

        with self.assertRaises(RuntimeError):
            jobs.custom_indexes_work(MODEL, build=build)
        self.assertEqual(built, [MODEL])

    def test_start_is_one_index_job_and_does_nothing_while_a_job_runs(self):
        fresh = jobs.MatchJobs()
        with patch.object(jobs, "jobs", fresh), patch.object(jobs, "custom_indexes_work", return_value={}) as work:
            started, _ = jobs.start_custom_indexes(MODEL)
            fresh.wait(5)
            self.assertTrue(started)
            work.assert_called_once_with(MODEL)
            self.assertEqual(fresh.status()["kind"], "index")
        busy = jobs.MatchJobs()
        busy._state["running"] = True
        with patch.object(jobs, "jobs", busy), patch.object(jobs, "custom_indexes_work") as work:
            self.assertFalse(jobs.start_custom_indexes(MODEL)[0])
            work.assert_not_called()


@needs_onnx
class UploadRouteTests(unittest.TestCase):
    def test_an_upload_starts_the_index_builds(self):
        from fastapi.testclient import TestClient
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool

        import main
        from api.auth import get_current_user
        from database import Base, get_db
        from models import User

        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        db = Session()
        admin = User(username="oak", hashed_password="x", role="admin", is_active=True)
        db.add(admin)
        db.commit()
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"CARD_MATCH_DIR": folder}):
            main.app.dependency_overrides[get_db] = lambda: db
            main.app.dependency_overrides[get_current_user] = lambda: admin
            try:
                with patch.object(jobs, "start_custom_indexes", return_value=(True, {})) as start:
                    response = TestClient(main.app).post("/api/card-match/models", files={"file": ("a.onnx", io.BytesIO(tiny_model()), "application/octet-stream")}, data={"name": "A"})
                self.assertEqual(response.status_code, 200, response.text)
                start.assert_called_once_with(response.json()["model"]["id"])
            finally:
                main.app.dependency_overrides.clear()


@skip
class PinBeforeTheUploadTests(DataDirCase):
    def test_no_model_behaves_exactly_like_the_old_pin(self):
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_MODEL": MODEL, "CARD_MATCH_CUSTOM_CALIBRATION": pinned()}):
            options = variants.usable(variants.parse(variants.active_label(self.dir)), self.dir)
            self.assertEqual(options, variants.usable(variants.parse(OLD_PIN), self.dir))
            self.assertEqual(options.label, variants.usable(variants.parse(OLD_PIN), self.dir).label)
            self.assertIsNone(variants.thresholds_for(options, self.dir))
            self.assertEqual(variants.model_name(options, self.dir), "dinov2-small")
            self.assertEqual(variants.needed_indexes(options, self.dir), variants.needed_indexes(variants.usable(variants.parse(OLD_PIN), self.dir), self.dir))
            self.assertEqual(warmup.picture_model(), "dinov2-small")

    def test_a_model_without_its_indexes_is_still_the_old_pin(self):
        self.register(entry())
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_MODEL": MODEL, "CARD_MATCH_CUSTOM_CALIBRATION": pinned()}):
            self.assertEqual(variants.usable(variants.parse(NEW_PIN), self.dir), variants.usable(variants.parse(OLD_PIN), self.dir))
        index_module.save_index(index_module.CardIndex(MODEL, np.eye(3, 384, dtype=np.float32), [("c0", "k0"), ("c1", "k1"), ("c2", "k2")]), self.dir)
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_MODEL": MODEL, "CARD_MATCH_CUSTOM_CALIBRATION": pinned()}):
            self.assertEqual(variants.usable(variants.parse(NEW_PIN), self.dir), variants.usable(variants.parse(OLD_PIN), self.dir))  # the art index is still missing

    def test_with_the_model_and_both_indexes_it_runs_custom_calibrated(self):
        self.register(entry())
        self.install()
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_MODEL": MODEL, "CARD_MATCH_CUSTOM_CALIBRATION": pinned()}):
            options = variants.usable(variants.parse(NEW_PIN), self.dir)
            self.assertEqual(options.label, NEW_PIN)
            self.assertEqual(variants.thresholds_for(options, self.dir).as_dict(), TABLE)
            self.assertEqual(variants.needed_indexes(options, self.dir), [MODEL, MODEL + "-art"])


@skip
class WarmUpOrderTests(DataDirCase):
    def run_warm_up(self):
        loaded = []

        class Fake:
            def __init__(self, name):
                self.name = name

            def warm_up(self):
                loaded.append(self.name)
                return 0.1

        with patch.object(embed, "model_available", return_value=True), patch.object(embed, "get_embedder", lambda name="dinov2-small": Fake(name)), \
                patch("services.card_match.ocr.get_reader", lambda: types.SimpleNamespace(warm_up=lambda: 0.1)), \
                patch.object(warmup.device, "gpu_used_mb", return_value=None):
            warmup.warm_up()
        return loaded

    def test_the_custom_model_is_loaded_first_and_dinov2_not_at_all_when_it_is_in_use(self):
        self.register(entry())
        self.install()
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_MODEL": MODEL}):
            self.assertEqual(warmup.picture_model(), MODEL)
            self.assertEqual(self.run_warm_up(), [MODEL])

    def test_dinov2_is_loaded_otherwise(self):
        self.assertEqual(self.run_warm_up(), ["dinov2-small"])  # nothing uploaded
        self.register(entry())
        self.install()
        with patch.dict(os.environ, {"CARD_MATCH_OPTIONS": OLD_PIN}):  # a set without custom
            self.assertEqual(self.run_warm_up(), ["dinov2-small"])

    def test_the_status_names_the_custom_model_as_the_picture_model(self):
        with patch.object(warmup.device, "_status", {"embedder:" + MODEL: {"device": "cuda", "reason": None, "wrappers": []},
                                                      "embedder:dinov2-small": {"device": "cpu", "reason": "GPU memory budget used by other models", "wrappers": []}}):
            self.assertEqual(warmup.device.report(MODEL)["embedder"]["label"].split(" ")[0], "GPU")
            self.assertEqual(warmup.device.report()["embedder"]["label"], "CPU")

    def test_promoting_releases_dinov2s_share_and_reopens_the_custom_model(self):
        self.register(entry())
        self.install()
        calls = []
        default = types.SimpleNamespace(unload=lambda: calls.append("unload-default") or True)
        custom = types.SimpleNamespace(device="cpu", reopen=lambda: calls.append("reopen-custom"))
        threads = embed.config.threads()
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_MODEL": MODEL}), patch.dict(embed._cache, {("dinov2-small", threads): default, (MODEL, threads): custom}, clear=True):
            self.assertEqual(warmup.promote_picture_model(), MODEL)
        self.assertEqual(calls, ["unload-default", "reopen-custom"])


@skip
class ComposeTests(unittest.TestCase):
    def text(self, name):
        path = ROOT / name
        if not path.exists():  # the backend image has no compose files (CI runs the tests inside it)
            self.skipTest(f"{name} is not in this checkout")
        return path.read_text(encoding="utf-8")

    def test_prod_pins_the_calibrated_custom_model(self):
        text = self.text("docker-compose.portainer.yml")
        self.assertIn("CARD_MATCH_OPTIONS: ${CARD_MATCH_OPTIONS:-" + NEW_PIN + "}", text)
        self.assertEqual(variants.parse(NEW_PIN).label, NEW_PIN)
        self.assertEqual(NEW_PIN, variants.PIN_LABEL + "+custom+calibrated")
        self.assertIn("CARD_MATCH_CUSTOM_MODEL: " + MODEL, text)
        line = next(line for line in text.splitlines() if line.strip().startswith("CARD_MATCH_CUSTOM_CALIBRATION:"))
        value = line.split(":", 1)[1].strip()
        self.assertTrue(value.startswith("'") and value.endswith("'"))
        with patch.dict(os.environ, {"CARD_MATCH_CUSTOM_CALIBRATION": value[1:-1]}):
            calibration = custom_models.pinned_calibration()
        self.assertEqual(calibration["model"], MODEL)
        self.assertEqual(calibration["thresholds"], TABLE)
        self.assertEqual(set(calibration["thresholds"]), set(pipeline.THRESHOLD_FIELDS))
        self.assertEqual(calibration["source"], "nonprod autorun 2026-11-19T06:33:16Z, 139 Tuned scans, 129 decided, 0 wrong")

    def test_nonprod_keeps_chosen_json_its_newest_model_and_its_own_calibration(self):
        text = self.text("docker-compose.nonprod.yml")
        for name in ("CARD_MATCH_OPTIONS", "CARD_MATCH_CUSTOM_MODEL", "CARD_MATCH_CUSTOM_CALIBRATION"):
            self.assertIn(f'      {name}: ""', text)
        for word in ("driver: nvidia", "devices:", "capabilities:", "CARD_MATCH_DEVICE", "CARD_MATCH_GPU"):
            self.assertNotIn(word, text, "GPU settings come only from the prod file")

    def test_every_option_word_in_the_pin_is_known(self):
        self.assertEqual(variants.parse(NEW_PIN).label.split("+"), NEW_PIN.split("+"))


if __name__ == "__main__":
    unittest.main()
