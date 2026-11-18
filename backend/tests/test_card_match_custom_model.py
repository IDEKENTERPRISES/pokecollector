"""Custom picture models: upload (admin only, validated), the registry, loading with a checksum check, the ``custom`` option word
and its two indexes, comparison rows that miss their indexes, and delete. A tiny ONNX model is generated with the ``onnx`` helper;
no real model is downloaded."""
import io
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
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from api.auth import get_current_user
    from database import Base, get_db
    from models import AuditLog, User
    from services.card_match import benchmark, custom_models, embed, index as index_module, jobs, variants

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

try:
    import onnx  # noqa: F401
    from onnx import TensorProto, helper, numpy_helper

    ONNX_AVAILABLE = True
except ModuleNotFoundError:
    ONNX_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
needs_onnx = unittest.skipUnless(DEPS_AVAILABLE and ONNX_AVAILABLE, "the onnx package is not installed (it builds the tiny test model)")

KEPT = variants.KEPT_LABEL if DEPS_AVAILABLE else ""
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]


def tiny_model(dim: int = 384, seed: int = 0, rank: int = 3) -> bytes:
    """pixel_values [B,3,224,224] -> last_hidden_state [B,1,dim] (rank 3) or [B,dim] (rank 2): mean colour times a fixed matrix."""
    rng = np.random.default_rng(seed)
    weights = numpy_helper.from_array(rng.normal(size=(3, dim)).astype(np.float32), "w")
    axes = numpy_helper.from_array(np.array([1], dtype=np.int64), "axes")
    nodes = [
        helper.make_node("ReduceMean", ["pixel_values"], ["mean"], axes=[2, 3], keepdims=0),
        helper.make_node("MatMul", ["mean", "w"], ["flat"]),
    ]
    if rank == 3:
        nodes.append(helper.make_node("Unsqueeze", ["flat", "axes"], ["last_hidden_state"]))
        out = helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, ["b", 1, dim])
    else:
        nodes.append(helper.make_node("Identity", ["flat"], ["last_hidden_state"]))
        out = helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, ["b", dim])
    graph = helper.make_graph(
        nodes, "tiny", [helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, ["b", 3, 224, 224])], [out], initializer=[weights, axes],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    return model.SerializeToString()


class CustomModelTestCase(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.admin = User(username="oak", hashed_password="x", role="admin", is_active=True)
        self.db.add_all([self.user, self.admin])
        self.db.commit()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        patcher = patch.dict(os.environ, {"CARD_MATCH_DIR": self.tmp.name, "CARD_MATCH_MODEL_DIR": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.current = self.admin

        def override_db():
            session = self.Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_db
        main.app.dependency_overrides[get_current_user] = lambda: self.current
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    def upload(self, data: bytes, filename="trained.onnx", name="Trained v1"):
        return self.client.post("/api/card-match/models", files={"file": (filename, io.BytesIO(data), "application/octet-stream")}, data={"name": name})

    def stored(self):
        self.assertEqual(self.upload(tiny_model()).status_code, 200)
        return custom_models.list_models(self.dir)[0]

    def fake_index(self, name: str, count: int = 3):
        vectors = np.eye(count, 384, dtype=np.float32)
        index_module.save_index(index_module.CardIndex(name, vectors, [(f"c{i}", f"k{i}") for i in range(count)]), self.dir)


@skip
class OptionWordTests(CustomModelTestCase):
    def test_labels_are_in_canonical_order_and_the_two_rows_are_listed(self):
        self.assertIn(KEPT + "+custom", variants.COMPARE_LABELS)
        self.assertIn(variants.IN_USE + "+wholeread+custom", variants.COMPARE_LABELS)
        for label in variants.COMPARE_LABELS:
            self.assertEqual(variants.parse(label).label, label)

    def test_custom_turns_on_art_and_names_follow_the_newest_model(self):
        options = variants.parse("names+custom")
        self.assertTrue(options.art)
        self.assertEqual(variants.main_index_name(options, self.dir), custom_models.MISSING_NAME)
        self.assertEqual(variants.art_index_name(variants.parse("names+art"), self.dir), variants.ART_INDEX)

    def test_a_custom_row_without_a_model_shows_the_indexes_as_missing(self):
        options = variants.parse(KEPT + "+custom")
        missing = variants.missing_indexes(options, self.dir)
        self.assertEqual(missing, [custom_models.MISSING_NAME, "custom-none-art"])
        row = benchmark.compare_row(KEPT + "+custom", None, missing=missing)
        self.assertEqual(row["status"], "skipped")
        self.assertEqual(row["missing_indexes"], missing)

    def test_missing_custom_indexes_name_the_newest_model_and_usable_falls_back(self):
        base = {"dim": 384, "input_size": 224, "mean": MEAN, "std": STD}
        custom_models._write_registry([
            {"id": "custom-aaaaaaaa", "name": "old", "sha256": "a" * 64, "uploaded_at": "2026-11-01T00:00:00+00:00", **base},
            {"id": "custom-bbbbbbbb", "name": "new", "sha256": "b" * 64, "uploaded_at": "2026-11-02T00:00:00+00:00", **base},
        ], self.dir)
        options = variants.parse("names+custom")
        self.assertEqual(variants.missing_indexes(options, self.dir), ["custom-bbbbbbbb", "custom-bbbbbbbb-art"])
        self.fake_index("custom-bbbbbbbb")
        self.assertEqual(variants.missing_indexes(options, self.dir), ["custom-bbbbbbbb-art"])
        self.assertFalse(variants.usable(options, self.dir).custom)
        self.fake_index("custom-bbbbbbbb-art")
        self.assertEqual(variants.missing_indexes(options, self.dir), [])
        self.assertTrue(variants.usable(options, self.dir).custom)

    def test_index_naming(self):
        self.assertEqual(custom_models.index_names("custom-1234abcd"), {"whole": "custom-1234abcd", "art": "custom-1234abcd-art"})
        self.assertTrue(custom_models.is_custom_name("custom-1234abcd"))
        for bad in ("custom-1234abc", "custom-1234abcd-art", "dinov2-small", "../custom-1234abcd"):
            self.assertFalse(custom_models.is_custom_name(bad))


@needs_onnx
class UploadTests(CustomModelTestCase):
    def test_only_admins_can_use_the_routes(self):
        self.current = self.user
        self.assertEqual(self.upload(tiny_model()).status_code, 403)
        self.assertEqual(self.client.get("/api/card-match/models").status_code, 403)
        self.assertEqual(self.client.delete("/api/card-match/models/custom-12345678").status_code, 403)
        self.assertEqual(custom_models.list_models(self.dir), [])

    def test_a_good_model_is_stored_registered_listed_and_audited(self):
        response = self.upload(tiny_model())
        self.assertEqual(response.status_code, 200, response.text)
        entry = custom_models.list_models(self.dir)[0]
        self.assertEqual(entry["name"], "Trained v1")
        self.assertEqual(entry["uploaded_by"], "oak")
        self.assertEqual(entry["id"], "custom-" + entry["sha256"][:8])
        self.assertEqual((entry["dim"], entry["input_size"]), (384, 224))
        self.assertTrue((self.dir / "models" / f"{entry['id']}.onnx").is_file())
        self.assertEqual(entry["size_bytes"], len(tiny_model()))
        self.assertEqual(list((self.dir / "models").glob(".upload-*")), [])
        listing = self.client.get("/api/card-match/models").json()["models"]
        self.assertEqual([m["id"] for m in listing], [entry["id"]])
        self.assertEqual(listing[0]["indexes"]["art"]["name"], entry["id"] + "-art")
        self.assertFalse(listing[0]["indexes"]["whole"]["built"])
        rows = self.Session().query(AuditLog).filter(AuditLog.action == "card_match.model_uploaded").all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].target_id, entry["id"])
        status = self.client.get("/api/card-match/status").json()
        self.assertEqual(status["custom_models"][0]["id"], entry["id"])
        self.assertNotIn(entry["id"], status["extra_indexes"])

    def test_uploading_the_same_file_twice_is_refused(self):
        self.assertEqual(self.upload(tiny_model()).status_code, 200)
        self.assertEqual(self.upload(tiny_model(), name="again").status_code, 409)
        self.assertEqual(len(custom_models.list_models(self.dir)), 1)

    def test_wrong_files_are_refused_and_leave_nothing_behind(self):
        for response in (
            self.upload(b"this is not a model"),                       # not ONNX
            self.upload(tiny_model(), filename="model.bin"),           # not .onnx
            self.upload(tiny_model(rank=2)),                           # output [B, 384], not [1, N, 384]
            self.upload(tiny_model(dim=16)),                           # not the default model's 384
            self.upload(b""),                                          # empty
        ):
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(custom_models.list_models(self.dir), [])
        leftovers = [p.name for p in (self.dir / "models").iterdir()] if (self.dir / "models").exists() else []
        self.assertEqual(leftovers, [])

    def test_a_blank_name_falls_back_to_the_file_name(self):
        self.assertEqual(self.upload(tiny_model(), name="").status_code, 200)
        self.assertEqual(custom_models.list_models(self.dir)[0]["name"], "trained")

    def test_too_big_files_are_refused_while_streaming(self):
        with patch.object(custom_models, "MAX_BYTES", 1000):
            response = self.upload(tiny_model())
        self.assertEqual(response.status_code, 413)
        self.assertEqual(custom_models.list_models(self.dir), [])
        self.assertEqual(list((self.dir / "models").glob(".upload-*")), [])

    def test_the_limit_is_400_megabytes(self):
        self.assertEqual(custom_models.MAX_BYTES, 400 * 1024 * 1024)


@needs_onnx
class LoadTests(CustomModelTestCase):
    def test_the_embedder_loads_a_registry_model_and_embeds(self):
        entry = self.stored()
        self.assertTrue(embed.model_available(entry["id"]))
        embedder = embed.OnnxEmbedder(entry["id"])
        vectors = embedder.embed([np.full((300, 200, 3), 120, np.uint8), np.full((300, 200, 3), 30, np.uint8)])
        self.assertEqual(vectors.shape, (2, 384))
        np.testing.assert_allclose(np.linalg.norm(vectors, axis=1), 1.0, rtol=1e-4)
        self.assertIs(embed.get_embedder(entry["id"]), embed.get_embedder(entry["id"]))

    def test_a_changed_file_fails_the_checksum_on_load(self):
        entry = self.stored()
        path = embed.model_path(entry["id"])
        path.write_bytes(path.read_bytes() + b"x")
        with self.assertRaises(ValueError):
            embed.OnnxEmbedder(entry["id"])

    def test_unknown_custom_names_do_not_load(self):
        self.assertFalse(embed.model_available("custom-deadbeef"))
        with self.assertRaises(ValueError):
            embed.OnnxEmbedder("custom-deadbeef")

    def test_pinned_models_still_resolve_as_before(self):
        self.assertEqual(embed.model_path("dinov2-small").name, "dinov2-small.onnx")
        self.assertEqual(embed.model_spec("dinov2-base")["dim"], 768)

    def test_the_custom_row_builds_its_matcher_on_the_custom_model_and_indexes(self):
        entry = self.stored()
        self.fake_index(entry["id"])
        self.fake_index(entry["id"] + "-art")
        options = variants.parse("names+custom")
        self.assertEqual(variants.missing_indexes(options, self.dir), [])
        self.assertEqual(variants.model_name(options, self.dir), entry["id"])
        matcher = variants._build_matcher(options, self.Session, data_dir=self.dir, ocr_reader=object())
        self.assertEqual(matcher.embedder.name, entry["id"])
        self.assertEqual(matcher.index.model, entry["id"])


@needs_onnx
class IndexAndDeleteTests(CustomModelTestCase):
    def test_build_buttons_start_the_two_index_jobs(self):
        entry = self.stored()
        self.assertEqual(variants.index_specs()[entry["id"]]["crop"], "full")
        self.assertEqual(variants.index_specs()[entry["id"] + "-art"]["crop"], "art")
        for name in (entry["id"], entry["id"] + "-art"):
            with patch.object(jobs, "start_index", return_value=(True, {"running": True})) as start:
                response = self.client.post("/api/card-match/index", json={"name": name})
            self.assertEqual(response.status_code, 200, response.text)
            start.assert_called_once_with(name)

    def test_delete_removes_the_file_the_entry_and_both_indexes(self):
        entry = self.stored()
        self.fake_index(entry["id"])
        self.fake_index(entry["id"] + "-art")
        embed.get_embedder(entry["id"])
        self.assertIsNotNone(index_module.get_index(entry["id"], self.dir))
        response = self.client.delete(f"/api/card-match/models/{entry['id']}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(custom_models.list_models(self.dir), [])
        self.assertFalse((self.dir / "models" / f"{entry['id']}.onnx").exists())
        self.assertFalse(index_module.index_dir(entry["id"], self.dir).exists())
        self.assertFalse(index_module.index_dir(entry["id"] + "-art", self.dir).exists())
        self.assertIsNone(index_module.get_index(entry["id"], self.dir))
        self.assertEqual(self.client.get("/api/card-match/models").json()["models"], [])
        self.assertEqual(self.Session().query(AuditLog).filter(AuditLog.action == "card_match.model_deleted").count(), 1)
        self.assertEqual(self.client.delete(f"/api/card-match/models/{entry['id']}").status_code, 404)

    def test_delete_waits_while_a_job_runs(self):
        entry = self.stored()
        with patch.object(jobs.jobs, "is_running", return_value=True):
            self.assertEqual(self.client.delete(f"/api/card-match/models/{entry['id']}").status_code, 409)
        self.assertEqual(len(custom_models.list_models(self.dir)), 1)


if __name__ == "__main__":
    unittest.main()
