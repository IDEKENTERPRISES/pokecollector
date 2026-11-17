"""Admin correction of a scan's confirmed card ("The scanner was right"): services/trace_correction.py and its API.

Correct and undo, read-only refusal, unknown card, admin only, audit entries, traversal attempts, the benchmark scoring the corrected
trace as right. Everything runs on temporary folders."""
import json
import os
import stat
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
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from api.auth import get_current_user
    from database import Base, get_db
    from models import AuditLog, Card, Set, User
    from services import scan_trace, trace_correction
    from services.card_match import benchmark, ocr_check
    from tests import test_trace_sources as sources

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")


@skip
class CorrectionApiTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()
        self.trainer = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.admin = User(username="oak", hashed_password="x", role="admin", is_active=True)
        self.db.add_all([self.trainer, self.admin, Set(id="tst_en", tcg_set_id="tst", name="Test", series="X", lang="en", total=9, printed_total=9, abbreviation="TST")])
        for card_id, kw in (("swsh1-1", {}), ("swsh1-9", {}), ("dig-1", {"is_digital": True})):
            self.db.add(Card(id=f"{card_id}_en", tcg_card_id=card_id, name=card_id, set_id="tst", number="1", lang="en", is_custom=False,
                             images_small="https://img.example/x.webp", **({"is_digital": False} | kw)))
        self.db.add(Card(id="swsh1-5_de", tcg_card_id="swsh1-5", name="de", set_id="tst", number="5", lang="de", is_custom=False, is_digital=False,
                         images_small="https://img.example/y.webp"))
        self.db.commit()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.local, self.prod = Path(self.tmp.name) / "local", Path(self.tmp.name) / "prod"
        self.local.mkdir()
        self.prod.mkdir()
        self.mine = sources.make_trace(self.local, 7, "2026-11-12", "job3-item4-abc", job=3, item=4, truth="swsh1-9")
        self.second = sources.make_trace(self.local, 7, "2026-11-12", "job3-item4-def", job=3, item=4, truth="swsh1-9")
        self.theirs = sources.make_trace(self.prod, 2, "2026-11-12", "job1-item1-xyz", job=1, item=1, truth="swsh1-9")
        env = sources.Env(SCAN_TRACE_DIR=str(self.local), SCAN_TRACE_STORAGE_DIR=str(self.local), SCAN_TRACE_READONLY_DIRS=f"prod={self.prod}")
        env.__enter__()
        self.addCleanup(env.__exit__)
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

    def audit(self):
        session = self.Session()
        try:
            return [(row.action, json.loads(row.details), row.target_id) for row in session.query(AuditLog).order_by(AuditLog.id)]
        finally:
            session.close()

    def post(self, key, card="swsh1-1", reason="scanner was right"):
        return self.client.post(f"/api/card-match/traces/{key}/correct", json={"card_id": card, "reason": reason})

    def test_correct_and_undo(self):
        snapshot_before = json.loads(self.mine.read_text())
        response = self.post("job3-item4-abc")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.json()["from"], response.json()["to"], response.json()["attempts"]), ("swsh1-9", "swsh1-1", 2))
        for path in (self.mine, self.second):  # every attempt of the scan
            data = json.loads(path.read_text())
            self.assertEqual(data["ground_truth"], "swsh1-1")
            self.assertEqual(data["confirmation"]["card_id"], "swsh1-1")
            entry = data["ground_truth_corrections"][-1]
            self.assertEqual((entry["from"], entry["to"], entry["by_user_id"], entry["reason"]), ("swsh1-9", "swsh1-1", self.admin.id, "scanner was right"))
            self.assertTrue(entry["at"])
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.mine.stat().st_mode), 0o600)
        self.assertEqual(list(self.local.rglob(".*.tmp")), [])
        overview = self.client.get("/api/card-match/traces/corrections").json()
        self.assertEqual(overview["scans"], 1)
        self.assertEqual(overview["by_key"]["job3-item4-abc"]["by_username"], "oak")
        undone = self.client.post("/api/card-match/traces/job3-item4-abc/undo-correct")
        self.assertEqual(undone.status_code, 200, undone.text)
        restored = json.loads(self.mine.read_text())
        self.assertEqual(restored["ground_truth"], "swsh1-9")
        self.assertNotIn("ground_truth_corrections", restored)
        self.assertEqual(restored.get("confirmation"), snapshot_before.get("confirmation"))
        self.assertEqual(self.client.get("/api/card-match/traces/corrections").json()["scans"], 0)
        self.assertEqual(self.client.post("/api/card-match/traces/job3-item4-abc/undo-correct").status_code, 409)

    def test_the_audit_log_names_the_old_and_new_card(self):
        self.post("job3-item4-abc")
        self.client.post("/api/card-match/traces/job3-item4-abc/undo-correct")
        entries = self.audit()
        self.assertEqual([e[0] for e in entries], ["scan_trace.ground_truth_corrected", "scan_trace.ground_truth_restored"])
        self.assertEqual((entries[0][1]["from_card_id"], entries[0][1]["to_card_id"]), ("swsh1-9", "swsh1-1"))
        self.assertEqual((entries[1][1]["from_card_id"], entries[1][1]["to_card_id"]), ("swsh1-1", "swsh1-9"))
        self.assertEqual(entries[0][2], "job3-item4-abc")

    def test_a_read_only_source_is_refused_with_the_reason_and_not_touched(self):
        before = sources.snapshot(self.prod)
        response = self.post("prod-job1-item1-xyz")
        self.assertEqual(response.status_code, 409)
        self.assertIn("read-only", response.json()["detail"])
        self.assertEqual(self.client.post("/api/card-match/traces/prod-job1-item1-xyz/undo-correct").status_code, 409)
        self.assertEqual(sources.snapshot(self.prod), before)
        self.assertEqual(self.audit(), [])

    def test_unknown_digital_and_non_english_cards_are_refused(self):
        for card in ("nope-1", "dig-1", "swsh1-5", ""):
            self.assertEqual(self.post("job3-item4-abc", card).status_code, 422, card)
        self.assertEqual(json.loads(self.mine.read_text())["ground_truth"], "swsh1-9")
        self.assertEqual(self.audit(), [])

    def test_the_same_card_and_unconfirmed_scans_change_nothing(self):
        self.assertEqual(self.post("job3-item4-abc", "swsh1-9").status_code, 409)
        sources.make_trace(self.local, 7, "2026-11-12", "job8-item8-aaa", job=8, item=8, confirmed=False)
        self.assertEqual(self.post("job8-item8-aaa").status_code, 409)

    def test_only_admins(self):
        self.current = self.trainer
        self.assertEqual(self.post("job3-item4-abc").status_code, 403)
        self.assertEqual(self.client.post("/api/card-match/traces/job3-item4-abc/undo-correct").status_code, 403)
        self.assertEqual(self.client.get("/api/card-match/traces/corrections").status_code, 403)
        self.assertEqual(json.loads(self.mine.read_text())["ground_truth"], "swsh1-9")

    def test_traversal_and_odd_keys_find_nothing(self):
        outside = Path(self.tmp.name) / "secret.json"
        outside.write_text(json.dumps({"ground_truth": "swsh1-9", "user_id": 1}))
        for key in ("..%2F..%2Fsecret", "%2e%2e", "user-7%2F2026-11-12%2Fjob3-item4-abc", "job3-item4-*", "job3-item4-ab%00c", "a" * 81, "job3-item4-abc.json", "nothing-here"):
            response = self.post(key)
            self.assertIn(response.status_code, (404, 422), key)
        self.assertEqual(json.loads(outside.read_text())["ground_truth"], "swsh1-9")
        for stem in ("../x", "a/b", "*", "", "a.b"):
            with self.assertRaises(trace_correction.TraceNotFound):
                trace_correction.find_trace(stem)

    def test_the_corrected_scan_is_scored_as_right(self):
        self.theirs.unlink()  # only the local scan in this run
        matcher = sources.FakeMatcher(["swsh1-1", "swsh1-9"])  # decides swsh1-1 for every photo

        def run():
            with patch.object(benchmark, "index_status", return_value={}), patch.object(benchmark, "rss_mb", return_value=None):
                return benchmark.run_labelled(lambda: None, matcher, trace_dir=self.local, corners_check=False)

        before = run()
        self.assertEqual((before["metrics"]["decided_wrong"], before["metrics"]["decided_right_pct"]), (1, 0.0))
        self.post("job3-item4-abc")
        self.assertEqual([data["ground_truth"] for data, _ in ocr_check.labelled_traces(self.local, extra_roots=[])], ["swsh1-1"])
        after = run()
        self.assertEqual(after["metrics"]["decided_wrong"], 0)
        self.assertEqual(after["metrics"]["decided_right_pct"], 100.0)
        self.assertEqual(after["wrong_scans"], [])

    def test_the_status_counts_corrected_labels(self):
        self.assertEqual(self.client.get("/api/card-match/status").json()["corrected_labels"], 0)
        self.post("job3-item4-abc")
        self.assertEqual(self.client.get("/api/card-match/status").json()["corrected_labels"], 1)


@skip
class RescoreTests(unittest.TestCase):
    def test_rescore_updates_the_scored_fields(self):
        data = {"ground_truth": "a", "decision": {"selected": "a"}, "candidates": [{"tcg_card_id": "b"}, {"tcg_card_id": "a"}],
                "shadow": {"status": "ok", "decision": {"tcg_card_id": "a"}, "matches": [{"tcg_card_id": "a"}]}}
        scan_trace.rescore_label(data, "a")
        self.assertEqual((data["correct"], data["ground_truth_rank"], data["shadow"]["correct"], data["shadow"]["ground_truth_rank"]), (True, 2, True, 1))
        data["ground_truth"] = "b"
        scan_trace.rescore_label(data, "b")
        self.assertEqual((data["correct"], data["ground_truth_rank"], data["shadow"]["correct"], data["shadow"]["ground_truth_rank"]), (False, 1, False, None))


if __name__ == "__main__":
    unittest.main()
