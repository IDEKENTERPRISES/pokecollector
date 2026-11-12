"""Phone speed test (step 2): the POST endpoint is admin-only, numbers only and size-limited."""
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

    import main
    from api.auth import get_current_user
    from models import User
    from services.card_match import phone_speed

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

RUN = {"timings": {"session_wasm_first_ms": 812.5, "embed_wasm_median_ms": 640, "webgpu_session_error": None},
       "device": {"ua": "Mozilla/5.0 (iPhone)", "gpu": True, "crossOriginIsolated": False, "hardwareConcurrency": 6, "crashedBefore": False}}


@skip
class PhoneSpeedEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.dict(os.environ, {"CARD_MATCH_DIR": str(Path(self.tmp.name) / "card-match")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.user = User(username="oak", hashed_password="x", role="admin", is_active=True)
        main.app.dependency_overrides[get_current_user] = lambda: self.user
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    def post(self, body):
        return self.client.post("/api/card-match/phone-speed", content=json.dumps(body), headers={"content-type": "application/json"})

    def test_an_admin_saves_a_run_and_reads_the_last_ten_newest_first(self):
        for number in range(12):
            body = {"timings": {"n": number}, "device": {}}
            self.assertEqual(self.post(body).status_code, 200)
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
        self.assertEqual(self.client.get("/api/card-match/phone-speed").status_code, 403)
        self.assertFalse(phone_speed.path().exists())

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
            [1, 2, 3],
        ]
        for body in bad:
            self.assertEqual(self.post(body).status_code, 422, str(body)[:60])
        self.assertEqual(self.client.post("/api/card-match/phone-speed", content=b"not json").status_code, 422)
        self.assertFalse(phone_speed.path().exists())

    def test_the_body_size_is_limited(self):
        big = {"timings": {"a": 1}, "device": {f"f{i}": "y" * 190 for i in range(24)}}
        big["device"]["extra"] = "z" * 200
        padded = json.dumps(big) + " " * phone_speed.MAX_BODY_BYTES
        response = self.client.post("/api/card-match/phone-speed", content=padded, headers={"content-type": "application/json"})
        self.assertEqual(response.status_code, 413)

    def test_the_file_keeps_only_the_last_runs(self):
        for number in range(phone_speed.KEEP + 5):
            phone_speed.record({"timings": {"n": number}}, "oak", Path(self.tmp.name))
        stored = json.loads((Path(self.tmp.name) / phone_speed.FILE).read_text(encoding="utf-8"))
        self.assertEqual(len(stored), phone_speed.KEEP)
        self.assertEqual(stored[-1]["timings"]["n"], phone_speed.KEEP + 4)


if __name__ == "__main__":
    unittest.main()
