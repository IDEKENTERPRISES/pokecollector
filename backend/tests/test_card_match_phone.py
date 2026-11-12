"""Matcher version 11: the phone option words, the int8 index, the phone bundle and its endpoints, and the parity fixtures script.
Built from generated data only; the fake embedder stands in for the model."""
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
    from fastapi.testclient import TestClient

    import main
    from api.auth import get_current_user
    from models import User
    from services.card_match import MATCHER_VERSION, benchmark, index as index_module, jobs, phone, variants
    from services.card_match.model_specs import MODEL_SPECS

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

IN_USE = "names+number+text+art+tta+fastread+numberonce+corners+wholepic"


def ok_row(label, top1=50.0, top20=90.0, decided=60.0, wrong=0, p95=1000.0):
    return {"label": label, "status": "ok", "n": 100, "top1": top1, "top5": 80.0, "top20": top20, "number_exact": 70.0, "decided": decided,
            "decided_right": 100.0, "decided_wrong": wrong, "p95_ms": p95}


@skip
class PhoneOptionTests(unittest.TestCase):
    def test_version_and_phone_words(self):
        self.assertEqual(MATCHER_VERSION, "11")
        options = variants.parse(IN_USE + "+phone8+index8")
        self.assertTrue(options.phone8 and options.index8 and not options.fp16)
        self.assertEqual(options.label, IN_USE + "+phone8+index8")
        self.assertEqual(variants.parse("names+fp16+index8").label, "names+fp16+index8")
        self.assertEqual(variants.parse("names+fp16+phone8").label, "names+phone8")  # one model at a time: the 8-bit one
        self.assertFalse(variants.parse(variants.DEFAULT_LABEL).phone8)

    def test_models_and_indexes_of_the_phone_words(self):
        plain, phone8 = variants.parse(IN_USE), variants.parse(IN_USE + "+phone8")
        self.assertEqual((variants.model_name(plain), variants.main_index_name(plain), variants.art_index_name(plain)), ("dinov2-small", "dinov2-small", "dinov2-small-art"))
        self.assertEqual((variants.model_name(phone8), variants.main_index_name(phone8), variants.art_index_name(phone8)),
                         ("dinov2-small-int8", "dinov2-small-int8", "dinov2-small-int8-art"))
        self.assertEqual(variants.needed_indexes(phone8), ["dinov2-small-int8", "dinov2-small-int8-art"])
        self.assertEqual(variants.needed_indexes(variants.parse("names+art+fp16+index8")), ["dinov2-small-art"])  # fp16 searches the fp32 indexes
        self.assertEqual(variants.model_name(variants.parse("names+fp16")), "dinov2-small-fp16")
        specs = variants.index_specs()
        self.assertEqual(specs["dinov2-small-int8"], {"model": "dinov2-small-int8", "crop": "full", "label": specs["dinov2-small-int8"]["label"]})
        self.assertEqual(specs["dinov2-small-int8-art"]["crop"], "art")

    def test_the_model_pins(self):
        self.assertTrue(MODEL_SPECS["dinov2-small-int8"]["url"].endswith("/onnx/model_quantized.onnx"))  # uint8 weights: model_int8.onnx (signed) fails on the CPU provider
        self.assertEqual(MODEL_SPECS["dinov2-small-int8"]["sha256"], "c179f8f7f592449c4c1bca4cd124a7538021428c5ffb89afde9503935b197efb")
        for name, size in (("dinov2-small-int8", 24446700), ("dinov2-small-fp16", 44420939)):
            spec = MODEL_SPECS[name]
            self.assertEqual(spec["size_bytes"], size)
            self.assertEqual(len(spec["sha256"]), 64)
            self.assertIn("8b1f705a3a7f6f062f6bdd21986c1583d3ef105d", spec["url"])  # the same pinned commit as the fp32 model
            self.assertEqual(spec["dim"], 384)

    def test_the_comparison_rows(self):
        labels = variants.COMPARE_LABELS
        self.assertEqual(len(set(labels)), len(labels))
        self.assertIn(IN_USE + "+phone8+index8", labels)
        self.assertIn("names+number+art+fastread+numberonce+corners+wholepic+phone8+index8", labels)
        self.assertIn(IN_USE + "+fp16+index8", labels)
        self.assertIn(IN_USE + "+wholeread+wholestrict+phone8+index8", labels)  # step 2: the kept set with the whole-picture read, phone settings
        whole = variants.parse(variants.PHONE_LITE_WHOLE_LABEL)
        self.assertTrue(whole.wholeread and whole.wholestrict and whole.phone8 and not whole.tta and not whole.text)
        self.assertEqual(variants.parse(variants.PHONE_KEPT_LABEL).label, variants.PHONE_KEPT_LABEL)
        self.assertIn(IN_USE, labels)  # the existing rows stay
        for label in labels:
            self.assertEqual(variants.parse(label).label, label)  # every label is already in canonical order
        lite = variants.parse(variants.PHONE_LITE_LABEL)
        self.assertFalse(lite.tta or lite.text or lite.wholeread or lite.wholestrict)

    def test_is_phone_label_looks_at_the_words_only(self):
        self.assertFalse(variants.is_phone_label("plain"))
        self.assertFalse(variants.is_phone_label(None))
        self.assertFalse(variants.is_phone_label(IN_USE))
        self.assertTrue(variants.is_phone_label(variants.PHONE_LABEL))
        self.assertTrue(variants.is_phone_label("other+fp16"))

    def test_phone_rows_are_never_picked_even_when_they_look_best(self):
        rows = [ok_row("names", top20=90, decided=60), ok_row(IN_USE, top20=95, decided=70), ok_row(IN_USE + "+phone8+index8", top20=99, decided=90, wrong=0),
                ok_row(IN_USE + "+fp16+index8", top20=99.5, decided=95)]
        self.assertEqual(benchmark.pick_winner(rows)["label"], IN_USE)
        only_phone = [ok_row(IN_USE + "+phone8+index8")]
        self.assertIsNone(benchmark.pick_winner(only_phone))

    def test_a_phone_row_does_not_set_the_wrong_decision_bar(self):
        rows = [ok_row(IN_USE, wrong=1), ok_row(IN_USE + "+phone8+index8", wrong=0)]
        self.assertEqual(benchmark.pick_winner(rows)["label"], IN_USE)  # the phone row's 0 would otherwise disqualify the server's set

    def test_chosen_json_never_holds_a_phone_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            with self.assertRaises(ValueError):
                variants.save_chosen(IN_USE + "+phone8+index8", "x", data_dir)
            self.assertFalse(variants.chosen_path(data_dir).exists())
            variants.chosen_path(data_dir).write_text(json.dumps({"label": IN_USE + "+index8", "matcher_version": MATCHER_VERSION}), encoding="utf-8")
            with patch.dict(os.environ, {"CARD_MATCH_OPTIONS": ""}):
                self.assertEqual(variants.active_label(data_dir), variants.parse(variants.DEFAULT_LABEL).label)

    def test_a_missing_phone_index_skips_the_row_and_leaves_art_out_of_a_partial_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            options = variants.parse(variants.PHONE_LABEL)
            self.assertEqual(variants.missing_indexes(options, Path(tmp)), ["dinov2-small-int8", "dinov2-small-int8-art"])

    def test_the_autorun_builds_the_phone_indexes_before_the_comparison_and_the_bundle_after(self):
        plan = jobs.autorun_plan(indexes_ready=True, enough_real=True, phone=True, phone_ready=False)
        self.assertEqual(plan, ["ocr-check", "labelled", "int8-index", "int8-art-index", "compare-labelled", "warm-up", "index", "art-index", "phone-bundle", "synthetic", "compare-synthetic"])
        self.assertEqual(jobs.autorun_plan(indexes_ready=True, enough_real=True, phone=True, phone_ready=True)[2], "compare-labelled")
        fresh = jobs.autorun_plan(indexes_ready=False, enough_real=True, phone=True)
        self.assertLess(fresh.index("int8-art-index"), fresh.index("compare-labelled"))
        self.assertLess(fresh.index("int8-art-index"), fresh.index("phone-bundle"))
        # the plan without the phone steps is the old one
        self.assertEqual(jobs.autorun_plan(indexes_ready=True, enough_real=True), ["ocr-check", "labelled", "compare-labelled", "warm-up", "index", "art-index", "synthetic", "compare-synthetic"])


@skip
class AutorunPhoneFailureTests(unittest.TestCase):
    def run_autorun(self, fail_on):
        """Run the autorun with every step faked; ``fail_on`` is the step name whose job fails. Returns (steps started, marker dict or None)."""
        import threading

        started, state = [], {"error": None}

        def record(label, failing):
            def start(*args):
                name = f"{label}:{args[0]}" if args else label
                started.append(name)
                state["error"] = "boom" if name in failing else None
                return True, {}
            return start

        failing = {fail_on}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"SCAN_MATCHER_AUTORUN": "1", "CARD_MATCH_DIR": tmp}),                 patch.object(jobs, "start_index", side_effect=record("index", failing)),                 patch.object(jobs, "start_benchmark", side_effect=record("bench", failing)),                 patch.object(jobs, "start_phone_bundle", side_effect=record("bundle", failing)),                 patch.object(jobs.jobs, "wait"), patch.object(jobs.jobs, "status", side_effect=lambda: {"error": state["error"]}),                 patch.object(benchmark, "count_labelled_traces", return_value=150):
            self.assertTrue(jobs.autorun_once(None, delay_seconds=0))
            for thread in threading.enumerate():
                if thread.name == "card-match-autorun":
                    thread.join(20)
            marker = jobs._autorun_marker()
            data = json.loads(marker.read_text(encoding="utf-8")) if marker.is_file() else None
            log = json.loads((Path(tmp) / "autorun-log.json").read_text(encoding="utf-8"))
            self.assertEqual(jobs.phone_error(), log["phone_error"])
        return started, data, log

    def test_a_failing_int8_index_skips_the_other_phone_steps_and_the_real_comparison_still_runs(self):
        started, marker, log = self.run_autorun("index:dinov2-small-int8")
        self.assertIn("bench:compare-labelled", started)
        self.assertIn("bench:compare-synthetic", started)
        self.assertNotIn("index:dinov2-small-int8-art", started)
        self.assertNotIn("bundle", started)
        self.assertEqual(marker["phone_error"], "int8-index: boom")
        self.assertEqual(log["phone_error"], "int8-index: boom")
        self.assertEqual([step["step"] for step in marker["steps"] if step.get("skipped")], ["int8-art-index", "phone-bundle"])

    def test_a_failing_bundle_is_a_phone_error_too(self):
        started, marker, _log = self.run_autorun("bundle")
        self.assertEqual(marker["phone_error"], "phone-bundle: boom")
        self.assertIn("bench:compare-synthetic", started)

    def test_the_servers_own_failures_still_stop_the_autorun(self):
        started, marker, log = self.run_autorun("bench:compare-labelled")
        self.assertIsNone(marker)  # no marker: it reruns
        self.assertNotIn("bench:compare-synthetic", started)
        self.assertNotIn("bundle", started)
        self.assertIsNone(log["phone_error"])
        started, marker, _log = self.run_autorun("index:dinov2-small")
        self.assertIsNone(marker)
        self.assertEqual(started[-1], "index:dinov2-small")


def unit_rows(count, dim, seed):
    rng = np.random.default_rng(seed)
    matrix = rng.standard_normal((count, dim)).astype(np.float32)
    return matrix / np.linalg.norm(matrix, axis=1, keepdims=True)


@skip
class Index8Tests(unittest.TestCase):
    def test_round_trip_is_close_and_bounded(self):
        vectors = unit_rows(50, 384, 1)
        quantised, scales = phone.quantise_rows(vectors)
        self.assertEqual(quantised.dtype, np.int8)
        self.assertLessEqual(int(np.abs(quantised).max()), 127)
        self.assertTrue(np.all(np.abs(quantised).max(axis=1) == 127))  # every row uses the full range
        back = phone.dequantise_rows(quantised, scales)
        self.assertLessEqual(float(np.abs(back - vectors).max()), float(scales.max()) / 2 + 1e-7)  # half a step
        cosine = (vectors * back).sum(axis=1) / (np.linalg.norm(vectors, axis=1) * np.linalg.norm(back, axis=1))
        self.assertGreater(float(cosine.min()), 0.9995)
        self.assertGreater(phone.int8_error(vectors)["min_cosine"], 0.9995)

    def test_a_zero_row_stays_zero(self):
        vectors = np.zeros((2, 8), dtype=np.float32)
        vectors[1, 3] = 1.0
        quantised, scales = phone.quantise_rows(vectors)
        back = phone.dequantise_rows(quantised, scales)
        self.assertTrue(np.all(back[0] == 0))
        self.assertAlmostEqual(float(back[1, 3]), 1.0, places=5)

    def test_the_int8_view_searches_like_the_float_index(self):
        vectors = unit_rows(200, 64, 2)
        entries = [(f"set{i // 20}-{i}_en", f"k{i}") for i in range(200)]
        full = index_module.CardIndex("m", vectors, entries)
        view = phone.int8_view(full)
        self.assertIs(phone.int8_view(full), view)  # cached on the index
        self.assertEqual(len(view), 200)
        queries = vectors[[3, 77, 150]] + 0.02 * unit_rows(3, 64, 9)
        for exact, approx in zip(full.search(queries, 5), view.search(queries, 5)):
            self.assertEqual(exact[0][0], approx[0][0])
            self.assertAlmostEqual(exact[0][1], approx[0][1], places=2)

    def test_pack_and_unpack_a_set_file(self):
        vectors = unit_rows(5, 16, 3)
        quantised, scales = phone.quantise_rows(vectors)
        ids = [f"x-{i}_en" for i in range(5)]
        data = phone.pack_index(ids, quantised, scales)
        self.assertEqual(data[:4], b"PCI8")
        self.assertEqual((8 + int.from_bytes(data[4:8], "little")) % 4, 0)
        got_ids, got_q, got_scales = phone.unpack_index(data)
        self.assertEqual(got_ids, ids)
        np.testing.assert_array_equal(got_q, quantised)
        np.testing.assert_array_equal(got_scales, scales)
        with self.assertRaises(ValueError):
            phone.unpack_index(b"nope" + data[4:])

    def test_set_of(self):
        self.assertEqual(phone.set_of("sv1-1_en"), "sv1")
        self.assertEqual(phone.set_of("swsh12tg-TG01_en"), "swsh12tg")
        self.assertEqual(phone.set_of("base1-102_en"), "base1")
        self.assertEqual(phone.set_of("loner_en"), "loner")


def make_bundle_data(tmp: Path, *, sets=("sv1", "sv2", "base1"), per_set=4, dim=384):
    """Two fake int8 indexes (whole and art) and a fake model file and OCR files; returns the data dir and the bundle inputs."""
    data_dir = tmp / "card-match"
    for number, name in enumerate((variants.PHONE_INDEX, variants.PHONE_ART_INDEX)):
        entries = [(f"{set_id}-{i}_en", f"key-{set_id}-{i}") for set_id in sets for i in range(1, per_set + 1)]
        index_module.save_index(index_module.CardIndex(name, unit_rows(len(entries), dim, 10 + number), entries), data_dir)
    model = tmp / "model.onnx"
    model.write_bytes(b"fake int8 model " * 100)
    det, rec = tmp / "det.onnx", tmp / "rec.onnx"
    det.write_bytes(b"det" * 50)
    rec.write_bytes(b"rec" * 70)
    return data_dir, model, {"det": det, "rec": rec, "characters": "a\nb\nc\n"}


@skip
class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir, self.model, self.ocr = make_bundle_data(Path(self.tmp.name))

    def build(self):
        return phone.build_bundle(self.data_dir, model_file=self.model, verify_model=False, ocr_files=self.ocr)

    def test_the_bundle_has_the_model_the_ocr_files_and_one_index_file_per_set_and_kind(self):
        manifest = self.build()
        paths = [item["path"] for item in manifest["files"]]
        self.assertIn("model/dinov2-small-int8.onnx", paths)
        self.assertEqual([p for p in paths if p.startswith("ocr/")], ["ocr/characters.txt", "ocr/det.onnx", "ocr/rec.onnx"])
        self.assertEqual(sorted(p for p in paths if p.startswith("index/whole/")), ["index/whole/base1.bin", "index/whole/sv1.bin", "index/whole/sv2.bin"])
        self.assertEqual(len([p for p in paths if p.startswith("index/art/")]), 3)
        self.assertEqual(manifest["matcher_version"], MATCHER_VERSION)
        self.assertEqual(manifest["option_set"], variants.PHONE_LABEL)
        self.assertTrue(manifest["options"]["phone8"] and manifest["options"]["index8"])
        self.assertFalse(variants.parse(manifest["lite_option_set"]).tta)
        self.assertEqual(manifest["thresholds"]["sim_min_with_rules"], 0.55)
        self.assertEqual(manifest["model"]["input_size"], 224)
        self.assertIn("ConvInteger (uint8)", manifest["model"]["operators"])
        self.assertIn("MatMulInteger (uint8)", manifest["model"]["operators"])
        self.assertEqual(manifest["model"]["webgpu_candidate"]["name"], "dinov2-small-fp16")
        self.assertFalse(manifest["model"]["webgpu_candidate"]["in_bundle"])  # no fp16 file in this test
        self.assertEqual(manifest["index"]["whole_count"], 12)
        self.assertEqual(manifest["index"]["sets"]["sv1"], {"whole": 4, "art": 4})
        self.assertEqual(manifest["totals"]["files"], len(paths))
        self.assertEqual(manifest["totals"]["bytes"], sum(item["size"] for item in manifest["files"]))

    def test_the_fp16_file_is_an_optional_webgpu_extra_outside_the_core_total(self):
        fp16 = Path(self.tmp.name) / "fp16.onnx"
        fp16.write_bytes(b"half" * 200)
        manifest = phone.build_bundle(self.data_dir, model_file=self.model, verify_model=False, ocr_files=self.ocr, fp16_model_file=fp16)
        item = next(i for i in manifest["files"] if i["path"] == "model/dinov2-small-fp16.onnx")
        self.assertTrue(item["optional"])
        self.assertTrue(manifest["model"]["webgpu_candidate"]["in_bundle"])
        self.assertEqual(manifest["totals"]["optional_bytes"], 800)
        self.assertEqual(manifest["totals"]["bytes"], sum(i["size"] for i in manifest["files"]) - 800)

    def test_every_file_matches_its_manifest_entry_and_index_files_read_back(self):
        import hashlib

        manifest = self.build()
        root = phone.bundle_dir(self.data_dir)
        for item in manifest["files"]:
            data = (root / item["path"]).read_bytes()
            self.assertEqual(len(data), item["size"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), item["sha256"])
        ids, quantised, scales = phone.unpack_index((root / "index/whole/sv1.bin").read_bytes())
        self.assertEqual(ids, [f"sv1-{i}_en" for i in range(1, 5)])
        self.assertEqual(quantised.shape, (4, 384))
        original = index_module.load_index(variants.PHONE_INDEX, self.data_dir)
        np.testing.assert_allclose(phone.dequantise_rows(quantised, scales), original.vectors[:4], atol=0.01)
        self.assertEqual((root / "ocr/characters.txt").read_text(encoding="utf-8"), "a\nb\nc\n")
        self.assertEqual(phone.bundle_status(self.data_dir)["total_bytes"], manifest["totals"]["bytes"])

    def test_a_rebuild_replaces_the_folder_and_leaves_no_temporary_one(self):
        self.build()
        self.build()
        self.assertEqual([p.name for p in phone.bundle_root(self.data_dir).iterdir()], [f"v{MATCHER_VERSION}"])

    def test_it_refuses_without_the_indexes_the_model_or_with_the_wrong_checksum(self):
        with tempfile.TemporaryDirectory() as empty:
            with self.assertRaises(RuntimeError):
                phone.build_bundle(Path(empty), model_file=self.model, verify_model=False, ocr_files=self.ocr)
        with self.assertRaises(RuntimeError):
            phone.build_bundle(self.data_dir, model_file=Path(self.tmp.name) / "missing.onnx", verify_model=False, ocr_files=self.ocr)
        with self.assertRaises(RuntimeError):
            phone.build_bundle(self.data_dir, model_file=self.model, verify_model=True, ocr_files=self.ocr)  # the fake file is not the pinned model

    def test_sets_with_odd_names_get_safe_file_names(self):
        data_dir, model, ocr = make_bundle_data(Path(self.tmp.name) / "odd", sets=("sv1", "SV1", "a b/c"))
        manifest = phone.build_bundle(data_dir, model_file=model, verify_model=False, ocr_files=ocr)
        names = [item["path"] for item in manifest["files"] if item["path"].startswith("index/whole/")]
        self.assertEqual(len(names), 3)
        self.assertTrue(all("/" not in n[len("index/whole/"):] and " " not in n for n in names))


@skip
class BundleEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.dict(os.environ, {"CARD_MATCH_DIR": str(Path(self.tmp.name) / "card-match")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.data_dir, model, ocr = make_bundle_data(Path(self.tmp.name))
        self.manifest = phone.build_bundle(self.data_dir, model_file=model, verify_model=False, ocr_files=ocr)
        (phone.bundle_dir(self.data_dir) / "secret.txt").write_text("not in the manifest", encoding="utf-8")
        (Path(self.tmp.name) / "outside.txt").write_text("outside", encoding="utf-8")
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        main.app.dependency_overrides[get_current_user] = lambda: self.user
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    def test_any_signed_in_user_reads_the_manifest_with_an_etag(self):
        response = self.client.get("/api/card-match/phone-bundle/manifest")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["matcher_version"], MATCHER_VERSION)
        self.assertEqual(response.json()["totals"], self.manifest["totals"])
        etag = response.headers["etag"]
        self.assertIn("max-age", response.headers["cache-control"])
        again = self.client.get("/api/card-match/phone-bundle/manifest", headers={"If-None-Match": etag})
        self.assertEqual(again.status_code, 304)

    def test_a_file_comes_with_its_sha256_as_etag_and_answers_304(self):
        entry = next(item for item in self.manifest["files"] if item["path"] == "index/whole/sv1.bin")
        response = self.client.get("/api/card-match/phone-bundle/files/index/whole/sv1.bin")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["etag"], f'"{entry["sha256"]}"')
        self.assertEqual(len(response.content), entry["size"])
        self.assertEqual(self.client.get("/api/card-match/phone-bundle/files/index/whole/sv1.bin", headers={"If-None-Match": f'"{entry["sha256"]}"'}).status_code, 304)
        self.assertEqual(self.client.get("/api/card-match/phone-bundle/files/ocr/characters.txt").content, b"a\nb\nc\n")

    def test_nothing_outside_the_manifest_is_served(self):
        for path in ("secret.txt", "manifest.json", "../outside.txt", "..%2foutside.txt", "%2e%2e/outside.txt", "index/whole/../../secret.txt",
                     "index/whole", "index/whole/nope.bin", "/etc/passwd", "..\\outside.txt"):
            self.assertEqual(self.client.get(f"/api/card-match/phone-bundle/files/{path}").status_code, 404, path)
        self.assertIsNone(phone.resolve_file("../outside.txt", self.data_dir))

    def test_it_needs_a_signed_in_user_and_the_bundle_must_exist(self):
        wanted = {"/api/card-match/phone-bundle/manifest", "/api/card-match/phone-bundle/files/{path:path}"}
        found = 0
        for route in main.app.routes:
            if getattr(route, "path", None) in wanted:
                found += 1
                self.assertIn(get_current_user, [dependency.call for dependency in route.dependant.dependencies], route.path)
                self.assertEqual(route.methods, {"GET"})  # read-only
        self.assertEqual(found, 2)
        import shutil

        shutil.rmtree(phone.bundle_root(self.data_dir))
        self.assertEqual(self.client.get("/api/card-match/phone-bundle/manifest").status_code, 404)
        self.assertEqual(self.client.get("/api/card-match/phone-bundle/files/ocr/det.onnx").status_code, 404)

    def test_building_is_for_admins_and_needs_the_model_and_indexes(self):
        self.assertEqual(self.client.post("/api/card-match/phone-bundle/build").status_code, 403)
        self.user = User(username="oak", hashed_password="x", role="admin", is_active=True)
        self.assertEqual(self.client.post("/api/card-match/phone-bundle/build").status_code, 409)  # no model file here


@skip
class ParityFixtureScriptTests(unittest.TestCase):
    def test_the_script_writes_fixtures_from_generated_cards(self):
        from scripts import phone_parity_fixtures

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "fixtures"
            self.assertEqual(phone_parity_fixtures.main([str(out), "--photos", "1"]), 0)
            pure = json.loads((out / "pure-functions.json").read_text(encoding="utf-8"))
            photos = json.loads((out / "photos.json").read_text(encoding="utf-8"))
            self.assertEqual(pure["matcher_version"], MATCHER_VERSION)
            for key in ("parse_text", "pick_number_lines", "parse_name_lines", "name_search", "constrain", "lookup_search", "decide", "thresholds", "quantise_rows"):
                self.assertTrue(pure[key], key)
            first = pure["parse_text"][0]
            self.assertEqual(first["output"]["number_local"], "018")
            self.assertEqual(first["output"]["number_total"], "091")
            self.assertTrue(any(case["output"]["mechanism"] for case in pure["decide"]) and any(case["output"]["reason"] for case in pure["decide"]))
            case = photos["cases"][0]
            self.assertEqual(case["detection"]["flat_size"], [630, 880])
            self.assertEqual(len(case["detection"]["corners"]), 4)
            self.assertEqual(case["tensor"]["shape"], [3, 224, 224])
            self.assertEqual(len(case["tensor"]["sha256"]), 64)
            self.assertEqual(len(case["embedding"]["int8_first_values"]), 12)
            self.assertTrue((out / case["photo"]).is_file())
            self.assertEqual(photos["embedder"], "fake")  # no model file is used by default

    def test_the_committed_fixtures_are_for_this_matcher_version(self):
        folder = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures" / "phone-matcher" / f"v{MATCHER_VERSION}"
        if not folder.is_dir():
            self.skipTest("the frontend fixtures are not in this checkout (the backend CI image holds only backend/); a frontend unit test guards the version")
        self.assertTrue((folder / "pure-functions.json").is_file(), "run backend/scripts/phone_parity_fixtures.py")
        self.assertEqual(json.loads((folder / "pure-functions.json").read_text(encoding="utf-8"))["matcher_version"], MATCHER_VERSION)
        self.assertEqual(json.loads((folder / "photos.json").read_text(encoding="utf-8"))["matcher_version"], MATCHER_VERSION)

    def test_the_committed_pure_function_answers_still_hold(self):
        """A changed matcher answer means the JavaScript port must follow: regenerate the fixtures on purpose, not by accident."""
        from services.card_match import ocr

        folder = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures" / "phone-matcher" / f"v{MATCHER_VERSION}"
        if not folder.is_dir():
            self.skipTest("the frontend fixtures are not in this checkout (the backend CI image holds only backend/); a frontend unit test guards the version")
        pure = json.loads((folder / "pure-functions.json").read_text(encoding="utf-8"))
        for case in pure["parse_text"]:
            got = ocr.parse_text(list(case["input"]))
            self.assertEqual((got.number_local, got.number_total, got.hp, list(got.tokens)), (case["output"]["number_local"], case["output"]["number_total"], case["output"]["hp"], case["output"]["tokens"]))


if __name__ == "__main__":
    unittest.main()
