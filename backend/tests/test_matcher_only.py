"""Matcher only (no AI): the admin switch (services/matcher_only.py).

The matcher is a stand-in (a ready-made MatchResult), the HTTP layer is patched to fail loudly, so these prove that
no request leaves the server while the switch is on, and that the scan still gets the matcher's answer.
"""
import asyncio
import datetime
import io
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

try:
    import httpx
    from fastapi import BackgroundTasks, HTTPException
    from PIL import Image
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import AuditLog, Card, ScanJob, ScanJobItem, ScanQueueUserState, Setting, User
    from services import matcher_only, picture_first, scan_queue, scanner_reachability
    from services.card_match.pipeline import MatchResult
    from services.scan_providers import OPENAI, ScanProvider

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
    return MatchResult(
        status="decided",
        decision={"card_id": f"tst-{n}_en", "tcg_card_id": f"tst-{n}", "mechanism": "number_and_picture", "similarity": 0.85, "lead": 0.2},
        unsure_reason=None, matches=[match_row(1, 0.9), match_row(2, 0.85), match_row(3, 0.5)], detection={}, ocr={}, timings_ms={"total": 300.0},
    )


def unsure_result(count: int = 7) -> "MatchResult":
    return MatchResult(
        status="unsure", decision=None, unsure_reason="no_number_and_picture_not_clear",
        matches=[match_row(n, 0.7 - n / 100) for n in range(1, count + 1)], detection={}, ocr={}, timings_ms={"total": 300.0},
    )


class FakeMatcher:
    def __init__(self, result):
        self.result, self.calls = result, 0
        self.index, self.ocr_reader = [1, 2, 3], None

    def match(self, photo, **kwargs):
        self.calls += 1
        return self.result


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed")
class MatcherOnlyTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"SCAN_UPLOAD_DIR": self.temp_dir.name, "OPENAI_BASE_URL": "http://scanner.test/v1"})
        self.env.start()
        os.environ.pop("SCAN_MATCHER_ONLY", None)
        matcher_only.reset()
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.admin = User(username="boss", hashed_password="x", role="admin")
        self.friend = User(username="friend", hashed_password="x", role="user")
        self.db.add_all([self.admin, self.friend])
        for n in range(1, 8):
            self.db.add(Card(id=f"tst-{n}_en", tcg_card_id=f"tst-{n}", name=f"Mon {n}", set_id="tst", number=str(n), lang="en",
                             is_custom=False, is_digital=False, images_small=f"https://img.example/{n}.webp"))
        self.db.commit()
        scanner_reachability.reset_reachability()
        self.provider = ScanProvider(OPENAI, "qwen")
        self.reachable = AsyncMock(return_value=True)
        self.recognize = AsyncMock(return_value={"recognized": {"name": "Mon 9"}, "matches": [{"id": "tst-3_en", "tcg_card_id": "tst-3"}]})
        # Any real request would reach one of these.
        self.http_post = AsyncMock(side_effect=AssertionError("a provider request was sent"))
        self.http_get = AsyncMock(side_effect=AssertionError("a provider request was sent"))
        self.patches = [
            patch("services.scan_providers.get_provider", return_value=self.provider),
            patch("services.scan_providers.require_scanner_capability_mode", return_value="full"),
            patch("services.scan_queue.endpoint_reachable", new=self.reachable),
            patch("api.recognize.recognize_sanitized_card", new=self.recognize),
            patch.object(httpx.AsyncClient, "post", new=self.http_post),
            patch.object(httpx.AsyncClient, "get", new=self.http_get),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        picture_first.matcher_factory = picture_first._default_factory
        matcher_only.reset()
        scanner_reachability.reset_reachability()
        self.db.close()
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    def switch(self, on: bool):
        row = self.db.query(Setting).filter(Setting.key == matcher_only.SETTING_KEY).first()
        if row is None:
            self.db.add(Setting(key=matcher_only.SETTING_KEY, value="true" if on else "false"))
        else:
            row.value = "true" if on else "false"
        self.db.commit()
        matcher_only.enabled(self.db)

    def use(self, matcher=None, reason="index_not_built"):
        picture_first.matcher_factory = (lambda: (matcher, None)) if matcher else (lambda: (None, reason))

    def scan(self, user=None, **kwargs):
        return asyncio.run(scan_queue.default_scan_processor(self.db, (user or self.admin).id, jpeg(), "image/jpeg", **kwargs))

    def make_item(self, **fields):
        now = datetime.datetime.utcnow()
        job = ScanJob(user_id=self.admin.id, status="done", created_at=now, updated_at=now, expires_at=now + datetime.timedelta(days=14))
        self.db.add(job)
        self.db.flush()
        self.db.add(ScanQueueUserState(user_id=self.admin.id))
        path = os.path.join(self.temp_dir.name, str(job.id))
        os.makedirs(path)
        with open(os.path.join(path, "0.jpg"), "wb") as handle:
            handle.write(jpeg())
        values = dict(job_id=job.id, user_id=self.admin.id, position=0, image_path=f"{job.id}/0.jpg", content_type="image/jpeg", byte_size=4,
                      status="done", resolved=False, attempts=0, transient_failures=0, created_at=now, updated_at=now)
        values.update(fields)
        item = ScanJobItem(**values)
        self.db.add(item)
        self.db.commit()
        return job, item

    # -- the setting ------------------------------------------------------------------------------

    def test_defaults_to_the_environment_and_the_stored_setting_wins(self):
        self.assertFalse(matcher_only.enabled(self.db))
        with patch.dict(os.environ, {"SCAN_MATCHER_ONLY": "1"}):
            self.assertTrue(matcher_only.enabled(self.db))
            self.switch(False)
            self.assertFalse(matcher_only.enabled(self.db))

    def test_only_an_admin_can_change_it_and_the_change_is_audited_without_touching_scanner_settings(self):
        from api import settings

        with self.assertRaises(HTTPException) as refused:
            settings.set_setting("scan_matcher_only", {"value": "true"}, self.db, self.friend, None)
        self.assertEqual(refused.exception.status_code, 403)
        self.assertFalse(matcher_only.enabled(self.db))

        settings.update_settings({"scan_matcher_only": "true"}, self.db, self.friend, None)  # silently ignored for non-admins
        self.assertFalse(matcher_only.enabled(self.db))

        from models import UserSetting
        self.db.add(UserSetting(user_id=self.admin.id, key="scanner_provider", value="openai"))
        self.db.commit()
        settings.set_setting("scan_matcher_only", {"value": "true"}, self.db, self.admin, None)
        self.assertTrue(matcher_only.enabled(self.db))
        self.assertTrue(matcher_only.active())
        entry = self.db.query(AuditLog).filter(AuditLog.action == "scanner.matcher_only.updated").one()
        self.assertIn('"after": true', entry.details)
        settings.set_setting("scan_matcher_only", {"value": "true"}, self.db, self.admin, None)  # unchanged: no second entry
        self.assertEqual(self.db.query(AuditLog).filter(AuditLog.action == "scanner.matcher_only.updated").count(), 1)
        settings.set_setting("scan_matcher_only", {"value": "false"}, self.db, self.admin, None)
        self.assertFalse(matcher_only.active())
        self.assertEqual(self.db.query(AuditLog).filter(AuditLog.action == "scanner.matcher_only.updated").count(), 2)
        self.assertEqual(self.db.query(UserSetting).filter(UserSetting.key == "scanner_provider").one().value, "openai")

        self.switch(True)
        self.assertEqual(settings._get_user_settings(self.db, self.friend.id)["scan_matcher_only"], "true")  # everyone sees it
        self.assertEqual(settings._get_user_settings(self.db, self.admin.id)["scan_matcher_only"], "true")

    # -- no provider traffic ----------------------------------------------------------------------

    def test_the_lowest_layer_refuses_every_provider_request(self):
        from api.recognize import post_gemini_generate
        from services.scan_providers import post_openai_chat

        self.switch(True)
        client = httpx.AsyncClient()
        for call in (
            lambda: post_openai_chat(client, "http://scanner.test/v1/chat/completions", "", {}, max_attempts=1),
            lambda: post_gemini_generate(client, "https://gemini.test/x", "key", {}, max_attempts=1),
            lambda: self.provider.generate_text(client, "", []),
            lambda: ScanProvider("gemini", "m").generate_text(client, "key", []),
            lambda: scanner_reachability.endpoint_reachable("http://scanner.test/v1", force=True),
        ):
            with self.assertRaises(matcher_only.MatcherOnlyError) as raised:
                asyncio.run(call())
            self.assertIn("Matcher only is on", str(raised.exception))
        self.http_post.assert_not_called()
        self.http_get.assert_not_called()

    def test_a_single_scan_never_reaches_a_provider(self):
        self.switch(True)
        self.use(FakeMatcher(unsure_result()))
        self.scan()
        self.recognize.assert_not_called()
        self.reachable.assert_not_called()
        self.http_post.assert_not_called()
        self.http_get.assert_not_called()

    def test_a_user_without_any_scanner_config_still_scans(self):
        self.switch(True)
        self.use(FakeMatcher(unsure_result()))
        with patch("services.scan_providers.get_provider", side_effect=AssertionError("provider looked at")):
            result = self.scan(user=self.friend)
        self.assertTrue(result["matches"])

    def test_a_batch_job_and_a_grouped_job_never_reach_a_provider(self):
        self.switch(True)
        self.use(FakeMatcher(unsure_result()))
        composite = asyncio.run(scan_queue.default_composite_processor(self.db, self.admin.id, [jpeg(), jpeg()], ["image/jpeg"] * 2))
        self.assertEqual(composite, [None, None])  # each photo is scanned on its own
        _job, item = self.make_item()
        result = self.scan(item_id=item.id, job_id=item.job_id)
        self.assertEqual(result["recognized"]["_picture"]["path"], "forced")
        self.recognize.assert_not_called()
        self.reachable.assert_not_called()
        self.http_post.assert_not_called()
        self.http_get.assert_not_called()

    def test_the_scanner_test_says_ai_scanning_is_off_and_sends_nothing(self):
        from api import settings

        self.switch(True)
        data = settings.ScannerConfigurationUpdate(provider="openai", model="qwen", openai_api_key="k")
        with self.assertRaises(HTTPException) as refused:
            asyncio.run(settings.test_scanner_configuration(data, self.db, self.admin, None))
        self.assertEqual(refused.exception.detail, "Matcher only is on: AI scanning is switched off")
        self.http_post.assert_not_called()
        self.http_get.assert_not_called()

    def test_retry_and_wait_do_not_probe_or_queue_for_a_scanner(self):
        from api import scan_jobs

        self.switch(True)
        _job, item = self.make_item(status="retrying", retry_reason="scanner_unreachable")
        with patch("api.scan_jobs.endpoint_reachable", new=self.reachable):
            payload = asyncio.run(scan_jobs.retry_scan_job_item(item.job_id, item.id, BackgroundTasks(), self.db, self.admin))
        self.reachable.assert_not_called()
        self.assertEqual(payload["status"], "pending")
        with self.assertRaises(HTTPException) as refused:
            scan_jobs.wait_for_scanner(item.job_id, item.id, self.db, self.admin)
        self.assertEqual(refused.exception.status_code, 409)
        self.http_get.assert_not_called()

    # -- what the scan returns --------------------------------------------------------------------

    def test_an_unsure_scan_returns_the_first_candidate_and_four_alternatives_marked_forced(self):
        self.switch(True)
        self.use(FakeMatcher(unsure_result(7)))
        result = self.scan()
        self.assertEqual([m["tcg_card_id"] for m in result["matches"]], ["tst-1", "tst-2", "tst-3", "tst-4", "tst-5"])
        picture = result["recognized"]["_picture"]
        self.assertEqual(picture["path"], "forced")  # never "decided": Scanner lab's numbers stay honest
        self.assertTrue(picture["matcher_only"] and picture["forced_pick"])
        self.assertFalse(picture["rules_decided"])
        self.assertEqual((picture["forced_card"], picture["unsure_reason"]), ("tst-1", "no_number_and_picture_not_clear"))
        self.assertIsNone(picture["mechanism"])
        self.assertTrue(result["matches"][0]["image"])

    def test_a_decided_scan_looks_as_today(self):
        self.switch(True)
        self.use(FakeMatcher(decided_result(2)))
        result = self.scan()
        self.assertEqual([m["tcg_card_id"] for m in result["matches"]][:2], ["tst-2", "tst-1"])
        self.assertEqual(result["recognized"]["name"], "Mon 2")
        picture = result["recognized"]["_picture"]
        self.assertEqual((picture["path"], picture["decided_card"]), ("decided", "tst-2"))
        self.assertTrue(picture["matcher_only"])
        self.assertFalse(picture["forced_pick"])

    def test_a_matcher_with_no_candidate_gives_no_matches_so_the_search_shows(self):
        self.switch(True)
        self.use(FakeMatcher(unsure_result(0)))
        result = self.scan()
        self.assertEqual(result["matches"], [])
        self.assertFalse(result["recognized"]["_picture"]["forced_pick"])
        self.assertEqual(result["recognized"]["_picture"]["path"], "no_candidate")

    def test_matcher_only_works_with_picture_first_off(self):
        self.switch(True)
        self.db.add(Setting(key="scan_picture_first", value="false"))
        self.db.commit()
        self.use(FakeMatcher(unsure_result()))
        self.assertEqual(self.scan()["recognized"]["_picture"]["path"], "forced")

    def test_the_index_not_being_ready_is_a_clear_message_and_never_a_fallback(self):
        self.switch(True)
        self.use(None, reason="index_not_built")
        with self.assertRaises(scan_queue.PermanentScanError) as friend_error:
            self.scan(user=self.friend)
        self.assertEqual(str(friend_error.exception), "The picture index isn't ready yet")
        with self.assertRaises(scan_queue.PermanentScanError) as admin_error:
            self.scan()
        self.assertIn("Scanner lab", str(admin_error.exception))
        self.recognize.assert_not_called()
        self.reachable.assert_not_called()

    def test_waiting_items_are_released_when_the_switch_is_on(self):
        _job, item = self.make_item(status="retrying", retry_reason="scanner_unreachable")
        self.reachable.return_value = False  # the scanner is off, as it often is
        self.assertEqual(asyncio.run(scan_queue.release_waiting_scans_if_reachable(self.db)), 0)
        self.switch(True)
        self.reachable.reset_mock()
        self.assertEqual(asyncio.run(scan_queue.release_waiting_scans_if_reachable(self.db)), 1)
        self.reachable.assert_not_called()
        self.db.expire_all()
        released = self.db.get(ScanJobItem, item.id)
        self.assertEqual((released.status, released.retry_reason), ("pending", None))

    def test_a_poll_releases_waiting_items_too(self):
        from api import scan_jobs

        _job, item = self.make_item(status="retrying", retry_reason="scanner_unreachable")
        self.switch(True)
        tasks = BackgroundTasks()
        payload = scan_jobs.list_scan_queue(tasks, None, 0, self.db, self.admin)
        self.assertEqual(payload["counts"]["waiting"], 0)
        self.assertEqual(len(tasks.tasks), 1)

    def test_the_lab_endpoint_says_whether_matcher_only_is_on(self):
        from api import card_match

        self.assertFalse(card_match.card_match_picture_first(self.db, self.admin)["matcher_only"])
        self.switch(True)
        self.assertTrue(card_match.card_match_picture_first(self.db, self.admin)["matcher_only"])

    # -- switching off ----------------------------------------------------------------------------

    def test_switching_off_restores_the_scanner_path_unchanged(self):
        self.switch(True)
        self.use(FakeMatcher(unsure_result(3)))
        self.assertEqual(self.scan()["recognized"]["_picture"]["path"], "forced")
        self.switch(False)
        matcher_only.assert_provider_allowed()  # no longer raises
        self.db.add(Setting(key="scan_picture_first", value="true"))
        self.db.commit()
        result = self.scan()
        self.recognize.assert_awaited_once()  # unsure and the scanner is up: Ollama runs as before
        self.assertEqual(result["recognized"]["_picture"]["path"], "unsure_ollama")

    # -- diagnostics ------------------------------------------------------------------------------

    def test_confirming_records_whether_the_forced_pick_was_kept(self):
        kept = SimpleNamespace(recognized={"_picture": {"path": "forced", "forced_pick": True, "forced_card": "tst-1"}})
        picture_first.record_confirmation(kept, "tst-1")
        self.assertTrue(kept.recognized["_picture"]["forced_kept"])
        changed = SimpleNamespace(recognized={"_picture": {"path": "forced", "forced_pick": True, "forced_card": "tst-1"}})
        picture_first.record_confirmation(changed, "tst-4")
        self.assertFalse(changed.recognized["_picture"]["forced_kept"])
        decided = SimpleNamespace(recognized={"_picture": {"path": "decided", "decided_card": "tst-2"}})
        picture_first.record_confirmation(decided, "tst-2")
        self.assertNotIn("forced_kept", decided.recognized["_picture"])

    def test_forced_picks_are_counted_apart_and_do_not_change_the_decided_counts(self):
        now = datetime.datetime.utcnow()
        job = ScanJob(user_id=self.admin.id, status="done", created_at=now, updated_at=now, expires_at=now + datetime.timedelta(days=14))
        self.db.add(job)
        self.db.flush()
        pictures = [
            {"path": "decided", "decided_card": "tst-2", "confirmed": "tst-2"},
            {"path": "forced", "forced_pick": True, "forced_card": "tst-1", "confirmed": "tst-1", "forced_kept": True},
            {"path": "forced", "forced_pick": True, "forced_card": "tst-1", "confirmed": "tst-4", "forced_kept": False},
            {"path": "forced", "forced_pick": True, "forced_card": "tst-1"},
        ]
        for position, picture in enumerate(pictures):
            self.db.add(ScanJobItem(job_id=job.id, user_id=self.admin.id, position=position, image_path=None, content_type="image/jpeg", byte_size=1,
                                    status="done", resolved=False, attempts=0, transient_failures=0, created_at=now, updated_at=now,
                                    recognized={"_picture": picture}))
        self.db.commit()
        counts = picture_first.lab_counts(self.db)
        self.assertEqual((counts["decided"], counts["decided_confirmed"], counts["picked_different"]), (1, 1, 0))
        self.assertEqual((counts["forced_shown"], counts["forced_kept"]), (3, 1))


if __name__ == "__main__":
    unittest.main()
