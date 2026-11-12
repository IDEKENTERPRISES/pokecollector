"""Phone speed test (step 2): the POST endpoint is admin-only, numbers only and size-limited; a photo taken on the page is
validated like a scan upload and kept with the run (admin-only, retention, delete); the built-in sample uploads nothing."""
import datetime
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
    from fastapi.testclient import TestClient
    from PIL import Image

    import main
    from api.auth import get_current_user
    from models import User
    from services.card_match import phone_speed, variants

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

RUN = {"timings": {"session_wasm_first_ms": 812.5, "embed_wasm_median_ms": 640, "webgpu_session_error": None},
       "device": {"ua": "Mozilla/5.0 (iPhone)", "gpu": True, "crossOriginIsolated": False, "hardwareConcurrency": 6, "crashedBefore": False}}
ANSWER = {"topk": {"wasm": {"whole": [["sv1-1_en", 0.91], ["sv1-2_en", 0.5]], "art": [["sv1-1_en", 0.8]]}}, "ocr_lines": ["Slowpoke", "149/287"]}
FAKE_ID = "20260101T000000000000-abcd1234"


def jpeg_bytes(size=(64, 90), colour=(200, 30, 30), fmt="JPEG"):
    out = io.BytesIO()
    Image.new("RGB", size, colour).save(out, format=fmt)
    return out.getvalue()


@skip
class PhoneSpeedEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "card-match"
        patcher = patch.dict(os.environ, {"CARD_MATCH_DIR": str(self.data)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.compare = patch.object(phone_speed, "start_compare")  # the server comparison has its own tests
        self.compare_mock = self.compare.start()
        self.addCleanup(self.compare.stop)
        self.user = User(username="oak", hashed_password="x", role="admin", is_active=True)
        main.app.dependency_overrides[get_current_user] = lambda: self.user
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    def post(self, body):
        return self.client.post("/api/card-match/phone-speed", content=json.dumps(body), headers={"content-type": "application/json"})

    def post_photo(self, photo, body=None, name="photo.jpg", content_type="image/jpeg"):
        files = {"photo": (name, photo, content_type)} if photo is not None else None
        return self.client.post("/api/card-match/phone-speed", data={"data": json.dumps(body or RUN)}, files=files)

    def test_an_admin_saves_a_run_and_reads_the_last_ten_newest_first(self):
        for number in range(12):
            self.assertEqual(self.post({"timings": {"n": number}, "device": {}}).status_code, 200)
        runs = self.client.get("/api/card-match/phone-speed").json()["runs"]
        self.assertEqual(len(runs), 10)
        self.assertEqual([run["timings"]["n"] for run in runs][:2], [11, 10])
        self.assertEqual(runs[0]["by"], "oak")
        saved = self.post(RUN).json()["run"]
        self.assertEqual(saved["device"]["hardwareConcurrency"], 6)
        self.assertIsNone(saved["timings"]["webgpu_session_error"])

    def test_only_admins(self):
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.assertEqual(self.post(RUN).status_code, 403)
        self.assertEqual(self.post_photo(jpeg_bytes()).status_code, 403)
        self.assertEqual(self.client.get("/api/card-match/phone-speed").status_code, 403)
        self.assertEqual(self.client.get(f"/api/card-match/phone-speed/{FAKE_ID}/photo").status_code, 403)
        self.assertEqual(self.client.delete(f"/api/card-match/phone-speed/{FAKE_ID}").status_code, 403)
        self.assertFalse(phone_speed.root().exists())

    def test_numbers_and_short_device_facts_only(self):
        bad = [
            {"timings": {"a": "fast"}, "device": {}},
            {"timings": {"a": True}, "device": {}},
            {"timings": {"a": 1e12}, "device": {}},
            {"timings": {"a": [1, 2]}, "device": {}},
            {"timings": {"bad name!": 1}, "device": {}},
            {"timings": {}, "device": {}},
            {"timings": {"a": 1}, "device": {"ua": "x" * 500}},
            {"timings": {"a": 1}, "device": {"nested": {"photo": "data:image/jpeg;base64,AAAA"}}},
            {"timings": {"a": 1}, "device": {}, "image": "data:image/jpeg;base64,AAAA"},
            {"timings": {f"k{i}": 1 for i in range(100)}, "device": {}},
            {"timings": {"a": 1}, "answer": {"topk": {"wasm": {"whole": [["../etc/passwd", 0.5]]}}}},
            {"timings": {"a": 1}, "answer": {"topk": {"wasm": {"whole": [["sv1-1_en", 0.5]] * 21}}}},
            {"timings": {"a": 1}, "answer": {"topk": {"wasm": {"pixels": []}}}},
            {"timings": {"a": 1}, "answer": {"ocr_lines": ["x" * 500]}},
            {"timings": {"a": 1}, "answer": {"image": "AAAA"}},
            [1, 2, 3],
        ]
        for body in bad:
            self.assertEqual(self.post(body).status_code, 422, str(body)[:60])
        self.assertEqual(self.client.post("/api/card-match/phone-speed", content=b"not json").status_code, 422)
        self.assertEqual(phone_speed.latest(), [])

    def test_a_crash_is_a_result_even_with_no_finished_step(self):
        crashed = {"timings": {}, "device": {"ios": "26.6", "ios_raw": "18.7", "gpu": True, "crashedBefore": True}, "crashed_step": "card_webgpu_uint8"}
        run = self.post(crashed).json()["run"]
        self.assertEqual(run["crashed_step"], "card_webgpu_uint8")
        self.assertFalse(run["has_photo"])
        partial = self.post({"timings": {"embed_wasm_median_ms": 400.5}, "device": {}, "crashed_step": "session_webgpu_fp16"}).json()["run"]
        self.assertEqual(partial["timings"], {"embed_wasm_median_ms": 400.5})
        listed = self.client.get("/api/card-match/phone-speed").json()["runs"]
        self.assertEqual([item.get("crashed_step") for item in listed][:2], ["session_webgpu_fp16", "card_webgpu_uint8"])
        self.assertEqual(self.post({"timings": {}, "device": {}}).status_code, 422)  # no crash and no timings: nothing to keep
        for bad in (5, "bad name!", ["x"], "x" * 80):
            self.assertEqual(self.post({"timings": {}, "device": {}, "crashed_step": bad}).status_code, 422, str(bad))

    def test_the_json_size_is_limited(self):
        big = json.dumps(RUN) + " " * phone_speed.MAX_JSON_BYTES
        response = self.client.post("/api/card-match/phone-speed", content=big, headers={"content-type": "application/json"})
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.client.post("/api/card-match/phone-speed", data={"data": big}).status_code, 413)

    def test_a_photo_is_stored_sanitised_with_the_run_and_the_phones_answer_and_a_comparison_starts(self):
        response = self.post_photo(jpeg_bytes((3000, 4000)), {**RUN, "answer": ANSWER})
        self.assertEqual(response.status_code, 200)
        run = response.json()["run"]
        self.assertTrue(run["has_photo"])
        folder = phone_speed.root() / run["id"]
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["photo.jpg", "result.json"])
        with Image.open(folder / "photo.jpg") as stored:
            self.assertEqual(stored.format, "JPEG")
            self.assertEqual(max(stored.size), 2048)  # the scanner's size cap, like every scan upload
        stored_json = json.loads((folder / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(stored_json["answer"]["topk"]["wasm"]["whole"][0], ["sv1-1_en", 0.91])
        self.assertEqual(stored_json["answer"]["ocr_lines"], ["Slowpoke", "149/287"])
        self.compare_mock.assert_called_once_with(run["id"])

    def test_the_photo_is_checked_like_a_scan_upload(self):
        self.assertEqual(self.post_photo(b"GIF89a not a real picture", name="x.gif", content_type="image/gif").status_code, 422)
        self.assertEqual(self.post_photo(b"", name="x.jpg").status_code, 422)
        self.assertEqual(self.post_photo(jpeg_bytes(fmt="BMP"), name="x.bmp", content_type="image/bmp").status_code, 422)  # not an allowed type
        self.assertEqual(self.post_photo(b"x" * (16 * 1024 * 1024)).status_code, 413)  # over the 15 MB cap (refused by size before reading)
        self.assertEqual(phone_speed.latest(), [])
        self.compare_mock.assert_not_called()
        self.assertEqual(self.post_photo(jpeg_bytes(fmt="PNG"), name="x.png", content_type="image/png").status_code, 200)  # PNG is allowed, stored as JPEG

    def test_the_built_in_sample_run_uploads_no_image(self):
        run = self.post(RUN).json()["run"]  # JSON only: what the page sends for the sample
        self.assertFalse(run["has_photo"])
        self.assertEqual([p.name for p in (phone_speed.root() / run["id"]).iterdir()], ["result.json"])
        self.assertEqual(run["server"], {"status": "no_photo"})
        self.compare_mock.assert_not_called()
        self.assertEqual(self.client.get(f"/api/card-match/phone-speed/{run['id']}/photo").status_code, 404)

    def test_the_photo_is_served_to_admins_inline_and_never_cached_or_by_path(self):
        run = self.post_photo(jpeg_bytes((800, 1000))).json()["run"]
        thumb = self.client.get(f"/api/card-match/phone-speed/{run['id']}/photo")
        self.assertEqual(thumb.status_code, 200)
        self.assertEqual(thumb.headers["content-type"], "image/jpeg")
        self.assertEqual(thumb.headers["cache-control"], "private, no-store")
        self.assertEqual(thumb.headers["content-disposition"], "inline")
        with Image.open(io.BytesIO(thumb.content)) as image:
            self.assertLessEqual(max(image.size), 160)
        with Image.open(io.BytesIO(self.client.get(f"/api/card-match/phone-speed/{run['id']}/photo?size=full").content)) as image:
            self.assertEqual(image.size, (800, 1000))
        for bad in ("..", "../card-match", FAKE_ID.upper(), "x"):
            self.assertEqual(self.client.get(f"/api/card-match/phone-speed/{bad}/photo").status_code, 404, bad)
        self.assertEqual(self.client.get(f"/api/card-match/phone-bundle/files/phone-speed/{run['id']}/photo.jpg").status_code, 404)

    def test_delete_removes_the_photo_and_the_json(self):
        run = self.post_photo(jpeg_bytes()).json()["run"]
        keep = self.post(RUN).json()["run"]
        self.assertEqual(self.client.delete(f"/api/card-match/phone-speed/{run['id']}").status_code, 200)
        self.assertFalse((phone_speed.root() / run["id"]).exists())
        self.assertEqual([item["id"] for item in phone_speed.latest()], [keep["id"]])
        self.assertEqual(self.client.delete(f"/api/card-match/phone-speed/{run['id']}").status_code, 404)
        self.assertEqual(self.client.delete("/api/card-match/phone-speed/..").status_code, 404)
        self.assertTrue((phone_speed.root() / keep["id"]).exists())


@skip
class PhoneSpeedStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def make(self, when, photo=True):
        return phone_speed.record({"timings": {"n": 1}}, "oak", self.dir, now=when, photo=jpeg_bytes() if photo else None)

    def test_retention_follows_scan_trace_keep_days_and_does_nothing_when_unset(self):
        now = datetime.datetime(2026, 11, 20, 12, 0, tzinfo=datetime.timezone.utc)
        old = self.make(now - datetime.timedelta(days=400))
        recent = self.make(now - datetime.timedelta(days=30))
        with patch.dict(os.environ, {"SCAN_TRACE_KEEP_DAYS": ""}):
            self.assertEqual(phone_speed.purge_old(now=now, data_dir=self.dir), 0)
        self.assertTrue((self.dir / "phone-speed" / old["id"]).exists())
        with patch.dict(os.environ, {"SCAN_TRACE_KEEP_DAYS": "365"}):
            self.assertEqual(phone_speed.purge_old(now=now, data_dir=self.dir), 1)
            self.assertEqual(phone_speed.purge_old(now=now, data_dir=self.dir), 0)  # safe to run twice
        self.assertFalse((self.dir / "phone-speed" / old["id"]).exists())
        self.assertTrue((self.dir / "phone-speed" / recent["id"] / "photo.jpg").exists())

    def test_the_scheduler_cleanup_also_purges_the_runs(self):
        from services import scheduler

        with patch.object(phone_speed, "purge_old") as purge, patch("services.scan_trace.purge_old_traces"):
            scheduler.run_scan_trace_cleanup()
        purge.assert_called_once()

    def test_a_safety_cap_keeps_the_newest_runs(self):
        base = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
        for number in range(phone_speed.KEEP + 3):
            self.make(base + datetime.timedelta(minutes=number), photo=False)
        self.assertEqual(len(phone_speed.latest(1000, self.dir)), phone_speed.KEEP)

    def test_the_server_answer_is_stored_next_to_the_phones_and_the_agreement_is_worked_out(self):
        run = phone_speed.record({"timings": {"n": 1}, "answer": ANSWER}, "oak", self.dir, photo=jpeg_bytes((300, 420)))

        class Outcome:
            status = "decided"
            unsure_reason = None
            decision = {"tcg_card_id": "sv1-1", "mechanism": "number", "similarity": 0.93}
            matches = [{"tcg_card_id": "sv1-1", "similarity": 0.93}, {"tcg_card_id": "sv1-9", "similarity": 0.5}]

        class Matcher:
            def match(self, photo):
                return Outcome()

        labels = []

        def factory(label):
            labels.append(label)
            if "phone8" in label:
                raise RuntimeError("index not built: dinov2-small-int8")
            return Matcher()

        result = phone_speed.compare_server(run["id"], self.dir, matcher_factory=factory)
        self.assertEqual(labels, [variants.active_label(), variants.PHONE_KEPT_LABEL])
        self.assertEqual(result["in_use"]["decision"], {"id": "sv1-1", "mechanism": "number", "similarity": 0.93})
        self.assertEqual(result["phone8"]["status"], "error")  # a missing index is a stored result, not a crash
        stored = phone_speed.latest(1, self.dir)[0]
        self.assertEqual(stored["server"]["in_use"]["top20"][0]["id"], "sv1-1")
        agree = stored["compare"]["in_use"]["wasm"]
        self.assertTrue(agree["top1_agree"])  # sv1-1_en (phone) and sv1-1 (server) are the same printing
        self.assertEqual(agree["overlap"], 1)
        self.assertNotIn("phone8", stored["compare"])

    def test_a_run_deleted_while_the_server_compares_is_not_brought_back(self):
        run = phone_speed.record({"timings": {"n": 1}}, "oak", self.dir, photo=jpeg_bytes())

        folder = self.dir

        class Matcher:
            def match(self, photo):
                phone_speed.delete(run["id"], folder)
                raise RuntimeError("stopped")

        phone_speed.compare_server(run["id"], self.dir, matcher_factory=lambda label: Matcher())
        self.assertFalse((self.dir / "phone-speed" / run["id"]).exists())


@skip
class PhoneWayTests(unittest.TestCase):
    def test_the_guide_box_maths_equals_the_javascript_reference(self):
        """frontend/src/phonespeed/views.test.js checks guideCardBox against the same file."""
        folder = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures" / "phone-matcher" / "v11"
        reference = folder / "guide-box-reference.json"
        if not reference.is_file():
            self.skipTest("the frontend fixtures are not in this checkout (the backend CI image holds only backend/)")
        for case in json.loads(reference.read_text(encoding="utf-8"))["cases"]:
            got = phone_speed.phone_guide_box(case["width"], case["height"])
            for a, b in zip(got, case["box"]):
                self.assertAlmostEqual(a, b, places=9, msg=str(case))

    def test_the_crop_is_the_centre_card_resized_to_630_by_880(self):
        import numpy as np

        photo = np.zeros((1920, 1440, 3), dtype=np.uint8)
        photo[:, :, 0] = 255
        card = phone_speed.phone_crop(photo)
        self.assertEqual(card.shape, (880, 630, 3))
        x0, y0, x1, y1 = phone_speed.phone_guide_box(1440, 1920)
        self.assertAlmostEqual((y1 - y0) * 1920, 0.9 * 1920, places=6)
        self.assertAlmostEqual((x1 - x0) * 1440 / ((y1 - y0) * 1920), 63 / 88, places=6)
        wide = phone_speed.phone_guide_box(500, 300)  # width-limited photos use 96% of the width
        self.assertLessEqual(wide[2] - wide[0], 0.96 + 1e-9)

    def test_the_server_does_what_the_phone_did_and_the_art_list_comes_from_the_art_crop(self):
        import numpy as np

        from services.card_match import detect, index as index_module

        seen = []

        class Embedder:
            def embed(self, images):
                seen.extend(images)
                rows = []
                for image in images:  # a stand-in: the first value tells which picture it was (whole card or artwork window)
                    vector = np.zeros(4, dtype=np.float32)
                    vector[0 if image.shape[0] == 880 else 1] = 1.0
                    rows.append(vector)
                return np.stack(rows)

        entries = [(f"sv1-{i}_en", f"k{i}") for i in range(4)]
        whole = index_module.CardIndex("w", np.eye(4, dtype=np.float32), entries)
        art = index_module.CardIndex("a", np.eye(4, dtype=np.float32)[::-1].copy(), entries)  # art row 0 is axis 3, row 2 is axis 1
        photo = np.full((1920, 1440, 3), 120, dtype=np.uint8)
        answer = phone_speed.phone_way_answer(photo, embedder=Embedder(), whole_index=whole, art_index=art)
        self.assertEqual(len(seen), 2)  # one whole card at 0 degrees and its artwork window: two embeddings
        self.assertEqual(seen[0].shape, (880, 630, 3))
        self.assertEqual(seen[1].shape, detect.art_crop(seen[0]).shape)
        self.assertEqual(answer["whole20"][0]["id"], "sv1-0_en")
        self.assertEqual(answer["art20"][0]["id"], "sv1-2_en")  # searched with the ART crop's embedding, not the whole card's
        self.assertEqual(answer["photo_size"], [1440, 1920])
        with self.assertRaises(RuntimeError):
            phone_speed.phone_way_answer(photo, embedder=Embedder(), whole_index=index_module.CardIndex("w", np.zeros((0, 4), dtype=np.float32), []), art_index=art)


@skip
class PhoneWayComparisonTests(unittest.TestCase):
    def test_shared_counts_for_the_whole_and_art_lists_and_the_orientation(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        directory = Path(tmp.name)
        answer = {"topk": {"wasm": {"whole": [[f"sv1-{i}_en", 0.9 - i / 100] for i in range(20)], "art": [[f"sv1-{i}_en", 0.8] for i in range(10, 30)]}}}
        run = phone_speed.record({"timings": {"n": 1}, "answer": answer, "device": {"photoWidth": 1440, "photoHeight": 1920}}, "oak", directory, photo=jpeg_bytes((300, 420)))

        class Outcome:
            status, unsure_reason, decision, matches = "unsure", None, None, []

        class Matcher:
            def match(self, photo):
                return Outcome()

        way = {"status": "ok", "photo_size": [300, 420], "whole20": [{"id": f"sv1-{i}", "similarity": 0.9} for i in range(20)],
               "art20": [{"id": f"sv1-{i}_en", "similarity": 0.8} for i in range(15, 35)]}
        phone_speed.compare_server(run["id"], directory, matcher_factory=lambda label: Matcher(), phone_way_factory=lambda photo: way)
        stored = phone_speed.latest(1, directory)[0]
        compare = stored["compare"]["phone_way"]
        self.assertEqual(compare["backends"]["wasm"]["whole"], {"top1_agree": True, "overlap": 20})  # ids with and without _en are the same printing
        self.assertEqual(compare["backends"]["wasm"]["art"], {"top1_agree": False, "overlap": 15})
        self.assertTrue(compare["orientation_agree"])
        phone_speed.compare_server(run["id"], directory, matcher_factory=lambda label: Matcher(), phone_way_factory=lambda photo: (_ for _ in ()).throw(RuntimeError("the int8 indexes are not built")))
        self.assertEqual(phone_speed.get(run["id"], directory)["server"]["phone_way"]["status"], "error")


@skip
class IdempotentPostTests(PhoneSpeedEndpointTests):
    def test_the_same_client_id_is_stored_once_and_starts_one_comparison(self):
        body = {**RUN, "client_id": "run-abc123456789"}
        first = self.post_photo(jpeg_bytes(), body).json()
        second = self.post_photo(jpeg_bytes(), body).json()
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(first["run"]["id"], second["run"]["id"])
        self.assertEqual(len(phone_speed.latest()), 1)
        self.compare_mock.assert_called_once()
        self.assertEqual(len([p for p in phone_speed.root().iterdir()]), 1)
        self.assertEqual(self.post({**RUN, "client_id": "other-run-0001"}).json()["duplicate"], False)
        self.assertEqual(len(phone_speed.latest()), 2)

    def test_a_crash_post_and_the_final_post_of_one_run_are_one_run(self):
        self.assertFalse(self.post({"timings": {}, "device": {}, "crashed_step": "search_art", "client_id": "run-crash-00001"}).json()["duplicate"])
        self.assertTrue(self.post({**RUN, "client_id": "run-crash-00001"}).json()["duplicate"])
        self.assertEqual(len(phone_speed.latest()), 1)

    def test_a_bad_client_id_is_refused(self):
        for bad in ("short", "has space in it", "x" * 80, 12345678, ["abcdefgh"]):
            self.assertEqual(self.post({**RUN, "client_id": bad}).status_code, 422, str(bad))



MATCHER = {
    "version": 11, "backend": "fp16 on WebGPU (worker)", "mode": "auto", "runs": 3, "stable": True, "decided": True, "card": "sv1-1", "mechanism": "number_unique",
    "reason": None, "similarity": 0.9312, "picture_only": False,
    "top20": [["sv1-1", 0.9312], ["sv1-9_en", 0.51], ["sv2-4", 0.4]],
    "read": {"number": "001", "total": "198", "name": "Pikachu", "source": "finder_card"},
    "orientation": {"by": "default", "flipped": False}, "detection": {"source": "quad", "found": True},
    "wholeread": None, "catalogue": {"present": True, "cards": 19659}, "photo": {"width": 1536, "height": 2048, "bytes": 412345},
    "timings": {"finder": [610.2, 590.1], "embed": [820.0, 790.5], "total": [2210.4, 2100.0]},
    "variant": "restart=1 overlap=0 ocr=wasm ladder=server runs=3",
    "ocr": {"ocr_number": {"det_calls": 3, "det_ms": 420.5, "rec_calls": 4, "rec_ms": 130}, "name": {"det_calls": 1, "det_ms": 90, "rec_calls": 1, "rec_ms": 30}},
    "ladder": {"stopped": "accepted", "attempts": 2, "seconds": 0.62, "budget": 0.9},
}
MATCHER_RUN = {"timings": {"matcher_total_first_ms": 2210.4, "matcher_total_median_ms": 2100.0}, "device": {"gpu": True}, "matcher": MATCHER}


@skip
class MatcherBlockTests(unittest.TestCase):
    """Step 3d: the phone's full-matcher answer is stored with the run and compared with the server's kept set on the phone's model and index."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_the_matcher_block_is_stored_and_cleaned(self):
        run = phone_speed.record(MATCHER_RUN, "oak", self.dir)
        self.assertEqual(run["matcher"]["card"], "sv1-1")
        self.assertEqual(run["matcher"]["timings"]["total"], [2210.4, 2100.0])
        self.assertEqual(run["matcher"]["ocr"]["ocr_number"]["det_calls"], 3)
        self.assertEqual(run["matcher"]["ladder"]["stopped"], "accepted")
        self.assertIn("restart=1", run["matcher"]["variant"])
        self.assertEqual(phone_speed.get(run["id"], self.dir)["matcher"]["top20"][0], ["sv1-1", 0.9312])

    def test_only_a_small_set_of_numbers_and_short_texts_is_accepted(self):
        bad = [
            {**MATCHER, "image": "data:image/jpeg;base64,AAAA"},
            {**MATCHER, "top20": [["../etc/passwd", 0.5]]},
            {**MATCHER, "top20": [["sv1-1", 0.5]] * 21},
            {**MATCHER, "card": "x" * 200},
            {**MATCHER, "decided": "yes"},
            {**MATCHER, "timings": {"mystery": [1, 2]}},
            {**MATCHER, "timings": {"total": [1]}},
            {**MATCHER, "read": {"number": "001", "pixels": "AAAA"}},
            {**MATCHER, "read": {"name": "x" * 500}},
            {**MATCHER, "photo": {"width": "wide"}},
            {**MATCHER, "ocr": {"hp": {"det_calls": 1}}},
            {**MATCHER, "ocr": {"name": {"det_calls": "many"}}},
            {**MATCHER, "ladder": {"stopped": "x" * 200}},
            {**MATCHER, "variant": "x" * 300},
            "not an object",
        ]
        for matcher in bad:
            with self.assertRaises(phone_speed.SpeedRunError, msg=str(matcher)[:60]):
                phone_speed.clean({**MATCHER_RUN, "matcher": matcher})

    def _compare(self, matcher, server_entry):
        run = {"matcher": matcher, "server": {"status": "done", "phone8": server_entry} if server_entry is not None else {"status": "pending"}}
        return phone_speed.compare_matcher(run)

    def entry(self, card="sv1-1", mechanism="number_unique", top=("sv1-1", "sv1-9", "sv3-3")):
        decision = {"id": card, "mechanism": mechanism, "similarity": 0.93} if card else None
        return {"status": "ok", "outcome": "decided" if card else "unsure", "unsure_reason": None if card else "no_number_and_picture_not_clear",
                "decision": decision, "top20": [{"id": item, "similarity": 0.5} for item in top]}

    def test_the_same_card_the_same_mechanism_and_the_shared_top_20(self):
        out = self._compare(MATCHER, self.entry())
        self.assertEqual((out["status"], out["agree"], out["same_mechanism"], out["overlap"]), ("compared", True, True, 2))  # sv1-1 and sv1-9 (the _en suffix is ignored)
        self.assertEqual((out["phone"], out["server"]), ("sv1-1", "sv1-1"))

    def test_a_different_mechanism_still_agrees_on_the_card_but_is_reported(self):
        out = self._compare(MATCHER, self.entry(mechanism="number_and_picture"))
        self.assertTrue(out["agree"])
        self.assertFalse(out["same_mechanism"])

    def test_a_different_card_or_one_side_unsure_is_a_disagreement(self):
        self.assertFalse(self._compare(MATCHER, self.entry(card="sv9-9"))["agree"])
        out = self._compare(MATCHER, self.entry(card=None))
        self.assertEqual((out["agree"], out["same_decided"], out["server"]), (False, False, None))
        unsure = {**MATCHER, "decided": False, "card": None, "mechanism": None, "reason": "number_not_among_picture_matches"}
        self.assertFalse(self._compare(unsure, self.entry())["agree"])

    def test_both_unsure_agree(self):
        unsure = {**MATCHER, "decided": False, "card": None, "mechanism": None, "reason": "number_not_among_picture_matches"}
        out = self._compare(unsure, self.entry(card=None))
        self.assertEqual((out["agree"], out["same_decided"], out["phone"], out["server"]), (True, True, None, None))

    def test_without_the_servers_answer_yet_the_comparison_is_pending_and_an_error_is_not_a_comparison(self):
        self.assertEqual(self._compare(MATCHER, None)["status"], "pending")
        self.assertEqual(self._compare(MATCHER, {"status": "error", "error": "index not built"})["status"], "done")

    def test_a_run_without_a_matcher_block_has_no_matcher_comparison(self):
        self.assertIsNone(phone_speed.compare_matcher({"server": {"phone8": self.entry()}}))

    def test_latest_carries_the_matcher_comparison(self):
        run = phone_speed.record(MATCHER_RUN, "oak", self.dir, photo=jpeg_bytes((300, 420)))

        class Outcome:
            status = "decided"
            unsure_reason = None
            decision = {"tcg_card_id": "sv1-1", "mechanism": "number_unique", "similarity": 0.93}
            matches = [{"tcg_card_id": "sv1-1", "similarity": 0.93}, {"tcg_card_id": "sv2-4", "similarity": 0.5}]

        class Matcher:
            def match(self, photo):
                return Outcome()

        phone_speed.compare_server(run["id"], self.dir, matcher_factory=lambda label: Matcher(), phone_way_factory=lambda photo: {"status": "error", "error": "skipped"})
        stored = phone_speed.latest(1, self.dir)[0]
        self.assertEqual(stored["matcher_compare"]["agree"], True)
        self.assertEqual(stored["matcher_compare"]["overlap"], 2)
        self.assertTrue(stored["matcher_compare"]["same_mechanism"])


if __name__ == "__main__":
    unittest.main()
