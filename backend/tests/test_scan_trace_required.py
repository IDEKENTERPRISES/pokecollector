"""Required scanner diagnostics (prod), the admin delete, retention, and the complete per-scan record."""

import datetime
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.auth import delete_user_scan_diagnostics
    from api.settings import _get_user_settings, delete_scan_diagnostics, set_setting, update_settings
    from models import AuditLog, Base, User, UserSetting
    from services import picture_first, scan_trace
    from services.scan_trace import SCAN_DIAGNOSTICS_SETTING_KEY, purge_old_traces, user_trace_enabled

    DEPS_AVAILABLE = True
except ImportError:
    DEPS_AVAILABLE = False

TODAY = datetime.date(2026, 11, 10)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class RequiredBase(unittest.TestCase):
    required = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        env = {"SCAN_TRACE_DIR": str(self.root), "SCAN_TRACE_STORAGE_DIR": str(self.root)}
        if self.required:
            env["SCAN_TRACE_REQUIRED"] = "1"
        patcher = patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("SCAN_TRACE_DEFAULT_ON", None) if not self.required else None
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.addCleanup(engine.dispose)  # cleanups run last-in first-out: the session closes first
        self.addCleanup(self.db.close)
        self.admin = User(username="owner", hashed_password="x", role="admin")
        self.friend = User(username="friend", hashed_password="x", role="trainer")
        self.db.add_all([self.admin, self.friend])
        self.db.commit()

    def store_scan(self, user, day, name="job1-item1-abc", image=True):
        folder = self.root / f"user-{user.id}" / day
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{name}.json").write_text("{}")
        if image:
            (folder / f"{name}.jpg").write_bytes(b"x")
        return folder

    def off(self, user):
        self.db.add(UserSetting(user_id=user.id, key=SCAN_DIAGNOSTICS_SETTING_KEY, value="false"))
        self.db.commit()


class RequiredModeTests(RequiredBase):
    def test_every_trainer_is_traced_whatever_they_stored_or_revoked(self):
        self.off(self.friend)
        scan_trace.revoke_user_traces(self.friend.id)  # an old marker
        self.assertTrue(user_trace_enabled(self.db, self.friend.id))
        self.assertFalse(scan_trace._is_revoked(self.friend.id))  # cleared, so saving works again

    def test_admin_keeps_their_own_switch(self):
        self.assertFalse(user_trace_enabled(self.db, self.admin.id))
        update_settings({SCAN_DIAGNOSTICS_SETTING_KEY: True}, db=self.db, current_user=self.admin)
        self.assertTrue(user_trace_enabled(self.db, self.admin.id))
        update_settings({SCAN_DIAGNOSTICS_SETTING_KEY: False}, db=self.db, current_user=self.admin)
        self.assertFalse(user_trace_enabled(self.db, self.admin.id))

    def test_read_tells_a_trainer_it_is_locked_and_on(self):
        self.off(self.friend)
        with patch.dict(os.environ, {"SCAN_TRACE_KEEP_DAYS": "365"}):
            seen = _get_user_settings(self.db, self.friend.id)
        self.assertEqual(seen["scan_diagnostics_locked"], "true")
        self.assertEqual(seen[SCAN_DIAGNOSTICS_SETTING_KEY], "true")
        self.assertEqual(seen["scan_diagnostics_keep_days"], "365")
        self.assertEqual(_get_user_settings(self.db, self.admin.id)["scan_diagnostics_locked"], "false")

    def test_trainer_cannot_change_or_delete(self):
        with self.assertRaises(HTTPException) as put:
            update_settings({SCAN_DIAGNOSTICS_SETTING_KEY: False}, db=self.db, current_user=self.friend)
        self.assertEqual(put.exception.status_code, 403)
        with self.assertRaises(HTTPException) as post:
            set_setting(SCAN_DIAGNOSTICS_SETTING_KEY, {"value": "false"}, db=self.db, current_user=self.friend)
        self.assertEqual(post.exception.status_code, 403)
        folder = self.store_scan(self.friend, "2026-11-01")
        with self.assertRaises(HTTPException) as delete:
            delete_scan_diagnostics(db=self.db, current_user=self.friend)
        self.assertEqual(delete.exception.status_code, 403)
        self.assertTrue(folder.exists())

    def test_admin_still_deletes_their_own(self):
        folder = self.store_scan(self.admin, "2026-11-01")
        delete_scan_diagnostics(db=self.db, current_user=self.admin)
        self.assertFalse(folder.exists())

    def test_admin_deletes_another_trainers_diagnostics_and_it_is_audited(self):
        folder = self.store_scan(self.friend, "2026-11-01")
        kept = self.store_scan(self.admin, "2026-11-01")
        result = delete_user_scan_diagnostics(self.friend.id, request=None, current_user=self.admin, db=self.db)
        self.assertEqual(result["deleted"], {"traces": 1, "images": 1})
        self.assertFalse(folder.exists())
        self.assertTrue(kept.exists())
        entry = self.db.query(AuditLog).filter(AuditLog.action == "scan_diagnostics.deleted").one()
        self.assertEqual(entry.target_id, str(self.friend.id))

    def test_a_trainer_cannot_use_the_admin_delete(self):
        with self.assertRaises(HTTPException) as refused:
            delete_user_scan_diagnostics(self.admin.id, request=None, current_user=self.friend, db=self.db)
        self.assertEqual(refused.exception.status_code, 403)
        with self.assertRaises(HTTPException) as missing:
            delete_user_scan_diagnostics(999, request=None, current_user=self.admin, db=self.db)
        self.assertEqual(missing.exception.status_code, 404)

    def test_required_does_nothing_without_a_trace_folder(self):
        with patch.dict(os.environ, {"SCAN_TRACE_DIR": ""}):
            self.assertFalse(user_trace_enabled(self.db, self.friend.id))
            self.assertEqual(_get_user_settings(self.db, self.friend.id)["scan_diagnostics_locked"], "false")


class RequiredOffTests(RequiredBase):
    required = False

    def test_behaves_as_before(self):
        self.assertFalse(user_trace_enabled(self.db, self.friend.id))  # off until they switch it on
        update_settings({SCAN_DIAGNOSTICS_SETTING_KEY: True}, db=self.db, current_user=self.friend)
        self.assertTrue(user_trace_enabled(self.db, self.friend.id))
        update_settings({SCAN_DIAGNOSTICS_SETTING_KEY: False}, db=self.db, current_user=self.friend)
        self.assertFalse(user_trace_enabled(self.db, self.friend.id))
        seen = _get_user_settings(self.db, self.friend.id)
        self.assertEqual(seen["scan_diagnostics_locked"], "false")
        folder = self.store_scan(self.friend, "2026-11-01")
        delete_scan_diagnostics(db=self.db, current_user=self.friend)
        self.assertFalse(folder.exists())

    def test_an_old_revocation_still_stops_collection(self):
        scan_trace.revoke_user_traces(self.friend.id)
        update_settings({SCAN_DIAGNOSTICS_SETTING_KEY: True}, db=self.db, current_user=self.friend)
        self.assertTrue(scan_trace._is_revoked(self.friend.id))


class RetentionTests(RequiredBase):
    required = False

    def test_old_scans_go_and_newer_ones_survive(self):
        old = self.store_scan(self.friend, "2025-11-01")
        edge = self.store_scan(self.friend, "2025-11-10")  # exactly 365 days: kept
        new = self.store_scan(self.friend, "2026-11-09")
        other_new = self.store_scan(self.admin, "2026-11-08")
        other_old = self.store_scan(self.admin, "2025-01-01", name="job2-item2-def")
        shadow = self.root / f"user-{self.friend.id}" / "shadow"
        shadow.mkdir()
        old_file, new_file = shadow / "job1-item1.shadow", shadow / "job9-item9.shadow"
        old_card = shadow / "job1-item1.card.jpg"
        for path in (old_file, new_file, old_card):
            path.write_text("{}")
        stale = datetime.datetime(2025, 6, 1).timestamp()
        os.utime(old_file, (stale, stale))
        os.utime(old_card, (stale, stale))

        removed = purge_old_traces(365, today=TODAY)

        self.assertEqual(removed, {"scans": 2, "shadow_files": 2})
        self.assertFalse(old.exists())
        self.assertFalse(other_old.exists())
        for survivor in (edge, new, other_new, new_file):
            self.assertTrue(survivor.exists())
        self.assertFalse(old_file.exists())
        self.assertFalse(old_card.exists())
        # Safe to run twice.
        self.assertEqual(purge_old_traces(365, today=TODAY), {"scans": 0, "shadow_files": 0})
        self.assertTrue(new.exists())

    def test_empty_shadow_folder_and_unrelated_files_are_handled(self):
        shadow = self.root / f"user-{self.friend.id}" / "shadow"
        shadow.mkdir(parents=True)
        only = shadow / "job1-item1.shadow"
        only.write_text("{}")
        os.utime(only, (1, 1))
        (self.root / "notes.txt").write_text("keep")
        (self.root / "user-abc").mkdir()
        (self.root / "user-abc" / "2020-01-01").mkdir()
        purge_old_traces(30, today=TODAY)
        self.assertFalse(shadow.exists())
        self.assertTrue((self.root / "notes.txt").exists())
        self.assertTrue((self.root / "user-abc" / "2020-01-01").exists())  # not a trainer folder

    def test_unset_or_zero_keeps_everything(self):
        old = self.store_scan(self.friend, "2020-01-01")
        for value in ("", "0", "soon"):
            with patch.dict(os.environ, {"SCAN_TRACE_KEEP_DAYS": value}):
                self.assertEqual(purge_old_traces(today=TODAY), {"scans": 0, "shadow_files": 0})
        self.assertTrue(old.exists())

    def test_reads_the_configured_days(self):
        old = self.store_scan(self.friend, "2026-10-01")
        with patch.dict(os.environ, {"SCAN_TRACE_KEEP_DAYS": "30"}):
            self.assertEqual(purge_old_traces(today=TODAY)["scans"], 1)
        self.assertFalse(old.exists())


class CompleteRecordTests(unittest.TestCase):
    """The matcher's own record and flat card are stored with the diagnostics, shadow mode or not."""

    def run_it(self, enabled, shadow_env):
        trace = MagicMock(enabled=enabled)
        run = SimpleNamespace(result=object(), input_info={"a": 1}, matcher=None)
        env = {"SCAN_MATCHER_SHADOW": shadow_env}
        with patch.dict(os.environ, env), \
                patch("services.scan_trace.has_shadow", return_value=False), \
                patch("services.scan_trace.record_shadow") as record, \
                patch("services.card_match.shadow._shadow_payload", return_value={"status": "ok"}), \
                patch("services.card_match.shadow.store_text_card") as card:
            picture_first.record_in_trace(trace, 1, 5, 6, run, {"path": "picture"}, "tst-1")
        return record, card

    @unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
    def test_stored_without_shadow_mode(self):
        record, card = self.run_it(True, "0")
        record.assert_called_once()
        card.assert_called_once()

    @unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
    def test_not_stored_without_the_trainers_diagnostics(self):
        record, card = self.run_it(False, "1")
        record.assert_not_called()
        card.assert_not_called()

    @unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
    def test_same_photo_is_not_recorded_twice(self):
        trace = MagicMock(enabled=True)
        run = SimpleNamespace(result=object(), input_info=None, matcher=None)
        with patch("services.scan_trace.has_shadow", return_value=True), \
                patch("services.scan_trace.record_shadow") as record:
            picture_first.record_in_trace(trace, 1, 5, 6, run, {"path": "picture"})
        record.assert_not_called()


if __name__ == "__main__":
    unittest.main()
