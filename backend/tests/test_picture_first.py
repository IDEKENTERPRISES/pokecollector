"""Picture match first (services/picture_first.py + the scan queue): every branch of the routing.

The matcher is a stand-in (it returns a ready-made MatchResult), so no model, index or OCR is needed.
"""
import asyncio
import datetime
import io
import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

try:
    from PIL import Image
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import Card, ScanJob, ScanJobItem, ScanQueueUserState, Setting, User
    from services import picture_first, scan_queue, scanner_reachability
    from services.card_match.pipeline import MatchResult
    from services.scan_providers import OPENAI, ScanProvider
    from services.scan_queue import claim_next_scan_item, release_waiting_scans

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def jpeg() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (300, 420), (120, 80, 40)).save(buffer, "JPEG")
    return buffer.getvalue()


def match_row(n: int, similarity: float) -> dict:
    return {"card_id": f"tst-{n}_en", "tcg_card_id": f"tst-{n}", "similarity": similarity, "rank": n,
            "name": f"Mon {n}", "number": str(n), "set": None, "printed_total": None}


def decided_result(n: int = 2) -> "MatchResult":
    matches = [match_row(1, 0.9), match_row(2, 0.85), match_row(3, 0.5)]
    return MatchResult(
        status="decided",
        decision={"card_id": f"tst-{n}_en", "tcg_card_id": f"tst-{n}", "mechanism": "number_and_picture", "similarity": 0.85, "lead": 0.2},
        unsure_reason=None, matches=matches, detection={}, ocr={}, timings_ms={"total": 300.0},
    )


def unsure_result() -> "MatchResult":
    return MatchResult(
        status="unsure", decision=None, unsure_reason="no_number_and_picture_not_clear",
        matches=[match_row(1, 0.7), match_row(2, 0.65), match_row(3, 0.5)], detection={}, ocr={}, timings_ms={"total": 300.0},
    )


class FakeMatcher:
    def __init__(self, result=None, error=None, delay=0.0):
        self.result, self.error, self.delay, self.calls = result, error, delay, 0
        self.index, self.ocr_reader = [1, 2, 3], None

    def match(self, photo, **kwargs):
        self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        if self.error:
            raise self.error
        return self.result


def scanner_result(confident=False):
    return {
        "recognized": {"name": "Mon 9", "number": "9"},
        "matches": [{"id": "tst-3_en", "tcg_card_id": "tst-3", "name": "Mon 3", "number": "3"}],
        "_identity_confident": confident,
    }


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed")
class PictureFirstTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"SCAN_UPLOAD_DIR": self.temp_dir.name, "SCAN_PICTURE_FIRST": "1", "OPENAI_BASE_URL": "http://scanner.test/v1"})
        self.env.start()
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(username="trainer", hashed_password="x", role="admin")
        self.db.add(self.user)
        for n in (1, 2, 3):
            self.db.add(Card(id=f"tst-{n}_en", tcg_card_id=f"tst-{n}", name=f"Mon {n}", set_id="tst", number=str(n), lang="en",
                             is_custom=False, is_digital=False, images_small=f"https://img.example/{n}.webp"))
        self.db.commit()
        scanner_reachability.reset_reachability()
        self.provider = ScanProvider(OPENAI, "qwen")
        self.reachable = AsyncMock(return_value=True)
        self.recognize = AsyncMock(return_value=scanner_result())
        self.patches = [
            patch("services.scan_providers.get_provider", return_value=self.provider),
            patch("services.scan_providers.require_scanner_capability_mode", return_value="full"),
            patch("services.scan_queue.endpoint_reachable", new=self.reachable),
            patch("api.recognize.recognize_sanitized_card", new=self.recognize),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        picture_first.matcher_factory = picture_first._default_factory
        scanner_reachability.reset_reachability()
        self.db.close()
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    def use(self, matcher=None, reason="index_not_built"):
        picture_first.matcher_factory = (lambda: (matcher, None)) if matcher else (lambda: (None, reason))

    def scan(self, **kwargs):
        return asyncio.run(scan_queue.default_scan_processor(self.db, self.user.id, jpeg(), "image/jpeg", **kwargs))

    # -- the branches ---------------------------------------------------------------------------

    def test_decided_skips_the_scanner_and_puts_the_card_first(self):
        matcher = FakeMatcher(decided_result(2))
        self.use(matcher)
        result = self.scan()
        self.recognize.assert_not_called()
        self.assertEqual([m["tcg_card_id"] for m in result["matches"]], ["tst-2", "tst-1", "tst-3"])
        self.assertEqual(result["recognized"]["name"], "Mon 2")
        picture = result["recognized"]["_picture"]
        self.assertEqual((picture["path"], picture["decided_card"], picture["mechanism"]), ("decided", "tst-2", "number_and_picture"))
        self.assertTrue(result["matches"][0]["image"])

    def test_unsure_with_the_scanner_up_calls_ollama_with_the_picture_matches_added(self):
        self.use(FakeMatcher(unsure_result()))
        result = self.scan()
        self.recognize.assert_awaited_once()
        ids = [m["tcg_card_id"] for m in result["matches"]]
        self.assertEqual(ids[0], "tst-3")  # the scanner's own candidates stay first
        self.assertEqual(set(ids), {"tst-1", "tst-2", "tst-3"})
        self.assertEqual(result["recognized"]["_picture"]["path"], "unsure_ollama")

    def test_confident_scanner_result_keeps_its_own_candidates(self):
        self.recognize.return_value = scanner_result(confident=True)
        self.use(FakeMatcher(unsure_result()))
        result = self.scan()
        self.assertEqual([m["tcg_card_id"] for m in result["matches"]], ["tst-3"])

    def test_unsure_with_the_scanner_down_goes_to_the_inbox(self):
        self.reachable.return_value = False
        self.use(FakeMatcher(unsure_result()))
        result = self.scan()
        self.recognize.assert_not_called()
        self.assertEqual([m["tcg_card_id"] for m in result["matches"]], ["tst-1", "tst-2", "tst-3"])
        self.assertEqual(result["recognized"]["_picture"]["path"], "unsure_inbox")
        self.assertNotIn("name", result["recognized"])

    def test_wait_for_the_scanner_parks_the_scan_and_it_is_not_sent_to_the_inbox_again(self):
        self.reachable.return_value = False
        self.use(FakeMatcher(unsure_result()))
        now = datetime.datetime.utcnow()
        job = ScanJob(user_id=self.user.id, status="done", created_at=now, updated_at=now, expires_at=now + datetime.timedelta(days=14))
        self.db.add(job)
        self.db.flush()
        self.db.add(ScanQueueUserState(user_id=self.user.id))
        path = os.path.join(self.temp_dir.name, str(job.id))
        os.makedirs(path)
        with open(os.path.join(path, "0.jpg"), "wb") as handle:
            handle.write(jpeg())
        item = ScanJobItem(job_id=job.id, user_id=self.user.id, position=0, image_path=f"{job.id}/0.jpg", content_type="image/jpeg",
                           byte_size=4, status="done", resolved=False, attempts=0, transient_failures=0, created_at=now, updated_at=now)
        self.db.add(item)
        self.db.commit()
        item_id = item.id
        result = self.scan(item_id=item_id)
        item.recognized, item.matches = result["recognized"], result["matches"]
        self.db.commit()
        self.assertTrue(picture_first.can_wait(item))

        picture_first.put_back_to_wait(self.db, item)
        self.db.expire_all()
        item = self.db.get(ScanJobItem, item_id)
        self.assertEqual((item.status, item.retry_reason), ("retrying", "scanner_unreachable"))
        self.assertIsNone(claim_next_scan_item(self.db))  # only released once the scanner answers
        self.assertFalse(picture_first.can_wait(item))

        # Still down when it is picked up again: it must wait, not come back to the inbox.
        with self.assertRaises(scan_queue.ScannerWaitingError):
            self.scan(item_id=item_id)
        self.recognize.assert_not_called()

        # The scanner answers: released, recognised by Ollama, and still counted as an inbox scan.
        self.assertEqual(release_waiting_scans(self.db), 1)
        self.reachable.return_value = True
        result = self.scan(item_id=item_id)
        self.recognize.assert_awaited_once()
        self.assertEqual(result["recognized"]["_picture"]["path"], "unsure_ollama")
        self.assertTrue(result["recognized"]["_picture"]["was_inbox"])

    def test_switch_off_behaves_as_today(self):
        matcher = FakeMatcher(decided_result())
        self.use(matcher)
        self.db.add(Setting(key="scan_picture_first", value="false"))
        self.db.commit()
        result = self.scan()
        self.assertEqual(matcher.calls, 0)
        self.recognize.assert_awaited_once()
        self.assertNotIn("_picture", result["recognized"])

    def test_switch_defaults_to_the_environment_and_the_admin_setting_wins(self):
        self.assertTrue(picture_first.enabled(self.db))
        with patch.dict(os.environ, {"SCAN_PICTURE_FIRST": ""}):
            self.assertFalse(picture_first.enabled(self.db))
            self.db.add(Setting(key="scan_picture_first", value="true"))
            self.db.commit()
            self.assertTrue(picture_first.enabled(self.db))

    def test_not_ready_behaves_as_today(self):
        self.use(None, "index_not_built")
        result = self.scan()
        self.recognize.assert_awaited_once()
        self.assertNotIn("_picture", result["recognized"])

    def test_not_ready_and_scanner_down_still_waits_as_today(self):
        self.reachable.return_value = False
        self.use(None, "model_missing")
        with self.assertRaises(scan_queue.ScannerWaitingError):
            self.scan()

    def test_matcher_error_behaves_as_today(self):
        self.use(FakeMatcher(error=RuntimeError("boom")))
        result = self.scan()
        self.recognize.assert_awaited_once()
        self.assertNotIn("_picture", result["recognized"])

    def test_matcher_that_takes_too_long_never_blocks_the_scan(self):
        self.use(FakeMatcher(decided_result(), delay=1.5))
        with patch.dict(os.environ, {"SCAN_PICTURE_FIRST_TIMEOUT_SECONDS": "0.5"}):
            started = time.monotonic()
            result = self.scan()
        self.assertLess(time.monotonic() - started, 1.4)
        self.recognize.assert_awaited_once()
        self.assertNotIn("_picture", result["recognized"])
        time.sleep(1.2)  # let the single matcher thread finish before the next test

    def test_decision_for_a_card_missing_from_the_catalogue_falls_through(self):
        self.db.query(Card).filter(Card.id == "tst-2_en").delete()
        self.db.commit()
        self.use(FakeMatcher(decided_result(2)))
        self.scan()
        self.recognize.assert_awaited_once()

    # -- lab counts -------------------------------------------------------------------------------

    def test_lab_counts_and_the_real_world_error_rate(self):
        now = datetime.datetime.utcnow()
        job = ScanJob(user_id=self.user.id, status="done", created_at=now, updated_at=now, expires_at=now + datetime.timedelta(days=14))
        self.db.add(job)
        self.db.flush()

        def add(picture, created=now):
            position = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).count()
            self.db.add(ScanJobItem(job_id=job.id, user_id=self.user.id, position=position, content_type="image/jpeg", byte_size=1, status="done",
                                    recognized={"_picture": picture} if picture else {"name": "x"}, created_at=created, updated_at=created))
            self.db.flush()

        add({"path": "decided", "decided_card": "tst-1", "confirmed": "tst-1"})
        add({"path": "decided", "decided_card": "tst-1", "confirmed": "tst-2"})
        add({"path": "decided", "decided_card": "tst-1"})
        add({"path": "unsure_ollama"})
        add({"path": "unsure_ollama", "was_inbox": True})
        add({"path": "unsure_inbox"})
        add(None)
        add({"path": "decided", "decided_card": "tst-1", "confirmed": "tst-2"}, created=now - datetime.timedelta(days=9))
        self.db.commit()
        counts = picture_first.lab_counts(self.db)
        self.assertEqual((counts["decided"], counts["ollama"], counts["inbox"]), (3, 2, 2))
        self.assertEqual((counts["decided_confirmed"], counts["picked_different"], counts["error_pct"]), (2, 1, 50.0))

    def test_confirming_a_card_is_remembered_next_to_the_decision(self):
        item = SimpleNamespace(recognized={"name": "Mon 2", "_picture": {"path": "decided", "decided_card": "tst-2"}})
        picture_first.record_confirmation(item, "tst-1")
        self.assertEqual(item.recognized["_picture"]["confirmed"], "tst-1")

    def test_settings_show_the_switch_to_admins_only(self):
        from api.settings import _get_user_settings

        self.assertEqual(_get_user_settings(self.db, self.user.id)["scan_picture_first"], "true")
        other = User(username="friend", hashed_password="x", role="user")
        self.db.add(other)
        self.db.commit()
        self.assertNotIn("scan_picture_first", _get_user_settings(self.db, other.id))


if __name__ == "__main__":
    unittest.main()
