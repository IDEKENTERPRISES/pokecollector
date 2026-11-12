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


if __name__ == "__main__":
    unittest.main()
