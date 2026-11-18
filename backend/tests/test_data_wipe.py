import asyncio
import hashlib
import io
import json
import os
import re
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api import data_wipe as wipe_api
    from api.auth import get_current_user
    from database import Base
    from models import (
        AuditLog,
        Card,
        CollectionItem,
        PriceHistory,
        ScanJob,
        ScanJobItem,
        Set,
        Setting,
        User,
        UserSession,
        UserSetting,
        UserXpLedger,
    )
    import numpy as np
    from PIL import Image

    from services import data_wipe, scan_providers, trace_photos
    from services.card_match import benchmark
    from services.auth import create_access_token, hash_password, verify_password

    DEPS = True
except ModuleNotFoundError:
    DEPS = False

ENV = {"ADMIN_USERNAME": "boss", "ADMIN_PASSWORD": "env-secret-pw"}
SCANNER = {
    "scanner_provider": "openai",
    "scanner_model_openai": "qwen3-vl:4b",
    "scanner_custom_model_openai": "qwen3-vl:4b",
    "scanner_request_timeout_openai": "120",
    "scanner_capability_openai": '{"version":1}',
    "scanner_gemini_fallback": "true",
    "openai_api_key": "sk-keep-me",
    "gemini_api_key": "gem-keep-me",
}


def jpeg(color):
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), color).save(buffer, "JPEG")
    return buffer.getvalue()


def snapshot(folder):
    """{relative path: sha256} of every file under a folder."""
    out = {}
    for path in sorted(Path(folder).rglob("*")):
        if path.is_file():
            out[path.relative_to(folder).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def fake_backup(name="pre-wipe-20261118T000000Z.sql"):
    def run():
        return Path(name)

    return run


@unittest.skipUnless(DEPS, "Backend dependencies are not installed in this lightweight test environment")
class DataWipeTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()
        self.admin = User(username="oldadmin", hashed_password=hash_password("old-pw"), role="admin", is_active=True)
        self.trainer = User(username="ash", hashed_password=hash_password("ash-pw"), role="trainer", is_active=True)
        self.db.add_all([self.admin, self.trainer])
        self.db.commit()
        self.db.add_all([UserSetting(user_id=self.admin.id, key=k, value=v) for k, v in SCANNER.items()])
        self.db.add_all([
            UserSetting(user_id=self.admin.id, key="language", value="de"),
            UserSetting(user_id=self.trainer.id, key="currency", value="USD"),
            Setting(key="scan_picture_first", value="true"),
            Setting(key="price_sync_hours", value="6"),
            Setting(key="scanner_global.scanner_provider", value="gemini"),
            Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet"),
            Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1", lang="en", is_custom=False),
            Card(id="custom-1", name="Mine", is_custom=True, custom_owner_id=self.trainer.id),
            CollectionItem(card_id="sv1-1_en", user_id=self.trainer.id, quantity=2),
            CollectionItem(card_id="custom-1", user_id=self.trainer.id, quantity=1),
            PriceHistory(card_id="sv1-1_en", date=datetime(2026, 1, 1).date()),
            PriceHistory(card_id="custom-1", date=datetime(2026, 1, 1).date()),
            UserXpLedger(user_id=self.trainer.id, source="x", source_key="a", amount=10),
            AuditLog(actor_user_id=self.admin.id, action="user.create", details=json.dumps({"actor": "oldadmin"})),
        ])
        self.session = UserSession(id="sid-old", user_id=self.trainer.id, expires_at=datetime.utcnow() + timedelta(days=1))
        self.db.add(self.session)
        self.db.commit()
        self.old_epoch = data_wipe.get_data_epoch(self.db)
        self.admin_id = self.admin.id
        self.trainer_id = self.trainer.id
        self.token = create_access_token({"sub": str(self.trainer_id), "sid": "sid-old"})
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "uploads").mkdir()
        (self.root / "uploads" / "job-1.jpg").write_bytes(jpeg("red"))
        job = ScanJob(user_id=self.trainer_id, status="done", expires_at=datetime.utcnow() + timedelta(days=1))
        self.db.add(job)
        self.db.commit()
        item = ScanJobItem(job_id=job.id, user_id=self.trainer_id, position=0, image_path="job-1.jpg", byte_size=1, status="done")
        gone = ScanJobItem(job_id=job.id, user_id=self.trainer_id, position=1, image_path="missing.jpg", byte_size=1, status="done")
        self.db.add_all([item, gone])
        self.db.commit()
        self.job_id, self.item_id, self.gone_id = job.id, item.id, gone.id
        day = self.root / "traces" / "user-7" / "2026-11-01"
        day.mkdir(parents=True)
        self.trace_a = day / f"job{self.job_id}-item{self.item_id}-aaa.json"
        self.trace_a.write_text(json.dumps({"trace_id": "aaa", "job_id": self.job_id, "item_id": self.item_id, "ground_truth": "sv1-1", "image_file": "a.jpg"}, indent=2))
        self.trace_b = day / f"job{self.job_id}-item{self.gone_id}-bbb.json"
        self.trace_b.write_text(json.dumps({"trace_id": "bbb", "job_id": self.job_id, "item_id": self.gone_id, "image_file": "b.jpg"}, indent=2))
        (day / "a.jpg").write_bytes(b"trace photo a")
        (day / "b.jpg").write_bytes(b"trace photo b")
        (self.root / "traces" / "user-7" / "shadow").mkdir()
        (self.root / "traces" / "user-7" / "shadow" / "job1-item1.shadow.json").write_text("{}")
        (self.root / "traces" / ".revoked-user-3").write_text("")
        (self.root / "traces" / "keep-me").mkdir()
        (self.root / "traces" / "keep-me" / "note.txt").write_text("keep")
        (self.root / "card-match" / "misses").mkdir(parents=True)
        (self.root / "card-match" / "misses" / "run.json").write_text("{}")
        (self.root / "card-match" / "index.bin").write_bytes(b"\x00\x01")
        self.env_patch = patch.dict(os.environ, {"SCAN_UPLOAD_DIR": str(self.root / "uploads"), "SCAN_TRACE_DIR": str(self.root / "traces")})
        self.env_patch.start()
        self.busy = patch.object(data_wipe, "busy_reason", return_value=None)
        self.busy.start()

    def tearDown(self):
        self.busy.stop()
        self.env_patch.stop()
        self.db.close()
        self.tmp.cleanup()

    def wipe(self, **kwargs):
        kwargs.setdefault("env", ENV)
        kwargs.setdefault("backup", fake_backup())
        return data_wipe.wipe_all_user_data(self.db, self.admin, **kwargs)

    # --- classification ---------------------------------------------------------------------

    def test_every_table_is_classified_exactly_once(self):
        self.assertEqual(data_wipe.unclassified_tables(), set(), "classify new tables in services/data_wipe.py")
        self.assertEqual(data_wipe.doubly_classified_tables(), set())
        self.assertEqual(data_wipe.unknown_listed_tables(), set(), "a listed table no longer exists")

    def test_every_tablename_in_models_py_is_classified(self):
        source = (Path(__file__).resolve().parent.parent / "models.py").read_text(encoding="utf-8")
        names = set(re.findall(r'__tablename__\s*=\s*"([^"]+)"', source))
        names |= set(re.findall(r'Table\(\s*"([^"]+)"', source))
        self.assertGreaterEqual(len(names), 48)
        for name in names:
            self.assertEqual((name in data_wipe.WIPE_TABLES) + (name in data_wipe.KEEP_TABLES), 1, name)

    def test_server_and_catalogue_tables_are_kept(self):
        for name in ("settings", "sets", "cards", "price_history", "image_cache", "sync_log", "audit_log"):
            self.assertIn(name, data_wipe.KEEP_TABLES)
        for name in ("users", "user_settings", "printing_detail_tags", "challenge_weeks", "custom_card_matches"):
            self.assertIn(name, data_wipe.WIPE_TABLES)

    def test_scanner_key_list_covers_the_scanner_modules(self):
        from api.settings import MANAGED_SCANNER_KEYS, PER_USER_KEYS

        for key in MANAGED_SCANNER_KEYS | {k for k in PER_USER_KEYS if "scan" in k or "api_key" in k}:
            self.assertTrue(data_wipe.is_scanner_key(key), key)
        self.assertFalse(data_wipe.is_scanner_key("language"))
        self.assertFalse(data_wipe.is_scanner_key("telegram_bot_token"))

    # --- the wipe -----------------------------------------------------------------------------

    def test_user_data_goes_and_settings_and_catalogue_stay(self):
        report = self.wipe()
        self.assertEqual(self.db.query(User).count(), 1)
        self.assertEqual(self.db.query(CollectionItem).count(), 0)
        self.assertEqual(self.db.query(UserXpLedger).count(), 0)
        self.assertEqual(self.db.query(UserSession).count(), 0)
        self.assertEqual(self.db.query(UserSetting).filter(UserSetting.key == "language").count(), 0)
        self.assertEqual(self.db.query(UserSetting).filter(UserSetting.key == "currency").count(), 0)
        # catalogue and server settings untouched; the custom (user-made) card and its prices are gone
        self.assertEqual([c.id for c in self.db.query(Card).all()], ["sv1-1_en"])
        self.assertEqual(self.db.query(Set).count(), 1)
        self.assertEqual(self.db.query(PriceHistory).filter(PriceHistory.card_id == "sv1-1_en").count(), 1)
        self.assertEqual(self.db.query(PriceHistory).filter(PriceHistory.card_id == "custom-1").count(), 0)
        for key, value in (("scan_picture_first", "true"), ("price_sync_hours", "6"), ("scanner_global.scanner_provider", "gemini")):
            self.assertEqual(self.db.get(Setting, key).value, value)
        self.assertEqual(report["deleted_rows"]["collection"], 2)
        self.assertEqual(report["deleted_rows"]["cards (custom cards)"], 1)

    def test_rows_are_deleted_not_truncated_so_id_sequences_keep_counting(self):
        # SQLite (these tests) reuses rowids; PostgreSQL sequences only restart on TRUNCATE ... RESTART IDENTITY.
        source = Path(data_wipe.__file__).read_text(encoding="utf-8")
        self.assertNotIn("TRUNCATE", source.upper())
        self.assertNotIn("RESTART IDENTITY", source.upper())

    def test_env_admin_is_recreated_and_can_log_in(self):
        report = self.wipe()
        admin = self.db.query(User).one()
        self.assertEqual((admin.username, admin.role, admin.is_active, admin.must_change_password), ("boss", "admin", True, False))
        self.assertTrue(verify_password("env-secret-pw", admin.hashed_password))
        self.assertFalse(verify_password("old-pw", admin.hashed_password))
        self.assertEqual(report["admin_username"], "boss")

    def test_scanner_settings_are_carried_to_the_new_admin(self):
        old = {key: scan_providers.scanner_setting_value(self.db, self.admin_id, key) for key in SCANNER}
        report = self.wipe()
        new_id = self.db.query(User).one().id
        for key, value in old.items():
            self.assertEqual(scan_providers.scanner_setting_value(self.db, new_id, key), value, key)
        self.assertEqual(sorted(SCANNER), report["scanner_settings_carried"])
        # personal preferences are not carried
        self.assertEqual(scan_providers.scanner_setting_value(self.db, new_id, "language"), "")

    def test_environment_gemini_key_seeds_the_account_only_when_nothing_was_carried(self):
        self.db.query(UserSetting).filter(UserSetting.user_id == self.admin_id).delete()
        self.db.commit()
        self.wipe(env={**ENV, "GEMINI_API_KEY": "env-gem"})
        new_id = self.db.query(User).one().id
        self.assertEqual(scan_providers.scanner_setting_value(self.db, new_id, "gemini_api_key"), "env-gem")

    def test_carried_settings_win_over_the_environment_key(self):
        self.wipe(env={**ENV, "GEMINI_API_KEY": "env-gem"})
        new_id = self.db.query(User).one().id
        self.assertEqual(scan_providers.scanner_setting_value(self.db, new_id, "gemini_api_key"), "gem-keep-me")

    def test_refused_without_the_environment_password_and_nothing_is_deleted(self):
        for env in ({}, {"ADMIN_USERNAME": "boss"}, {"ADMIN_USERNAME": "boss", "ADMIN_PASSWORD": "  "}, {"ADMIN_PASSWORD": "x"}):
            with self.assertRaises(data_wipe.WipeRefused) as ctx:
                self.wipe(env=env)
            self.assertEqual(ctx.exception.code, "env_admin_missing")
        self.assertEqual(self.db.query(User).count(), 2)
        self.assertEqual(data_wipe.get_data_epoch(self.db), self.old_epoch)

    def test_backup_failure_aborts_with_nothing_deleted(self):
        def broken():
            raise data_wipe.WipeBackupFailed("no dump")

        with self.assertRaises(data_wipe.WipeBackupFailed):
            self.wipe(backup=broken)
        self.assertEqual(self.db.query(User).count(), 2)
        self.assertEqual(self.db.query(CollectionItem).count(), 2)
        self.assertEqual(self.db.query(UserSession).count(), 1)
        self.assertEqual(data_wipe.get_data_epoch(self.db), self.old_epoch)
        self.assertTrue((self.root / "uploads" / "job-1.jpg").exists())
        self.assertEqual(self.db.query(AuditLog).filter(AuditLog.action == "data.wipe").count(), 0)

    def test_a_failure_inside_the_transaction_rolls_everything_back(self):
        with patch.object(data_wipe, "write_scanner_settings", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.wipe()
        self.assertEqual(self.db.query(User).count(), 2)
        self.assertEqual(self.db.query(CollectionItem).count(), 2)
        self.assertEqual(self.db.query(Card).count(), 2)
        self.assertEqual(data_wipe.get_data_epoch(self.db), self.old_epoch)
        self.assertTrue((self.root / "uploads" / "job-1.jpg").exists())

    def test_busy_refuses(self):
        self.busy.stop()
        try:
            with patch.object(data_wipe, "busy_reason", return_value="A scan job is still running."):
                with self.assertRaises(data_wipe.WipeRefused) as ctx:
                    self.wipe()
            self.assertEqual(ctx.exception.code, "busy")
        finally:
            self.busy.start()
        self.assertEqual(self.db.query(User).count(), 2)

    def test_busy_reason_sees_a_pending_scan_job(self):
        self.busy.stop()
        try:
            self.assertIsNone(data_wipe.busy_reason(self.db))
            self.db.add(ScanJob(user_id=self.trainer_id, status="running", expires_at=datetime.utcnow() + timedelta(days=1)))
            self.db.commit()
            self.assertIn("scan job", data_wipe.busy_reason(self.db))
        finally:
            self.busy.start()

    def test_epoch_changes_and_an_old_token_is_rejected(self):
        self.assertEqual(get_current_user(token=self.token, db=self.db, request=None).id, self.trainer_id)
        report = self.wipe()
        self.assertNotEqual(report["data_epoch"], self.old_epoch)
        self.assertEqual(data_wipe.get_data_epoch(self.db), report["data_epoch"])
        with self.assertRaises(HTTPException) as ctx:
            get_current_user(token=self.token, db=self.db, request=None)
        self.assertEqual(ctx.exception.status_code, 401)
        # even a token that names the new admin's id is useless without a live session row
        forged = create_access_token({"sub": str(report["admin_id"]), "sid": "sid-old"})
        with self.assertRaises(HTTPException):
            get_current_user(token=forged, db=self.db, request=None)

    def test_data_epoch_is_created_once_on_first_use(self):
        self.db.query(Setting).filter(Setting.key == data_wipe.DATA_EPOCH_SETTING).delete()
        self.db.commit()
        first = data_wipe.get_data_epoch(self.db)
        self.assertTrue(first)
        self.assertEqual(data_wipe.get_data_epoch(self.db), first)

    def test_scan_uploads_go(self):
        report = self.wipe()
        self.assertFalse((self.root / "uploads" / "job-1.jpg").exists())
        self.assertGreaterEqual(report["files"]["scan_uploads"], 1)

    def test_traces_and_card_match_are_never_deleted_or_changed_except_for_the_detach(self):
        before_traces = snapshot(self.root / "traces")
        before_match = snapshot(self.root / "card-match")
        report = self.wipe()
        # the matcher's data: byte for byte unchanged
        self.assertEqual(snapshot(self.root / "card-match"), before_match)
        after = snapshot(self.root / "traces")
        added = set(after) - set(before_traces)
        self.assertEqual(added, {f"user-7/2026-11-01/{self.trace_a.stem}.review.jpg"})
        self.assertEqual(set(before_traces) - set(after), set())
        changed = {name for name in before_traces if after[name] != before_traces[name]}
        self.assertEqual(changed, {f"user-7/2026-11-01/{self.trace_a.name}", f"user-7/2026-11-01/{self.trace_b.name}"})
        # the two trace files only gained the review photo path and the epoch stamp; everything else is as it was
        for path, keep_photo in ((self.trace_a, True), (self.trace_b, False)):
            data = json.loads(path.read_text())
            self.assertEqual(data["data_epoch"], self.old_epoch)
            self.assertEqual("review_photo_file" in data, keep_photo)
        data_a = json.loads(self.trace_a.read_text())
        self.assertEqual((data_a["ground_truth"], data_a["image_file"]), ("sv1-1", "a.jpg"))
        self.assertEqual((self.root / "traces" / data_a["review_photo_file"]).read_bytes(), jpeg("red"))
        self.assertTrue((self.root / "traces" / ".revoked-user-3").exists())
        self.assertEqual(report["trace_photos_detached"]["copied"], 1)

    def test_a_scan_trace_finds_the_same_photo_before_and_after_a_wipe(self):
        data_a = json.loads(self.trace_a.read_text())
        before = benchmark.review_photo_loader(self.Session, data_a)()
        self.assertIsNotNone(before)
        self.wipe()
        # a new trainer's scan now owns the same item id with a different photo
        self.db.add(ScanJob(id=self.job_id, user_id=99, status="done", expires_at=datetime.utcnow() + timedelta(days=1)))
        self.db.flush()
        self.db.add(ScanJobItem(id=self.item_id, job_id=self.job_id, user_id=99, position=0, image_path="stranger.jpg", byte_size=1, status="done"))
        self.db.commit()
        (self.root / "uploads" / "stranger.jpg").write_bytes(jpeg("blue"))
        data_a = json.loads(self.trace_a.read_text())
        after = benchmark.review_photo_loader(self.Session, data_a)()
        self.assertTrue(np.array_equal(before, after))

    def test_an_old_trace_without_a_photo_never_fetches_a_strangers_scan_after_a_wipe(self):
        data_b = json.loads(self.trace_b.read_text())
        self.assertIsNone(benchmark.review_photo_loader(self.Session, data_b)())  # its photo is already gone
        self.wipe()
        self.db.add(ScanJob(id=self.job_id, user_id=99, status="done", expires_at=datetime.utcnow() + timedelta(days=1)))
        self.db.flush()
        self.db.add(ScanJobItem(id=self.gone_id, job_id=self.job_id, user_id=99, position=1, image_path="stranger.jpg", byte_size=1, status="done"))
        self.db.commit()
        (self.root / "uploads" / "stranger.jpg").write_bytes(jpeg("blue"))
        data_b = json.loads(self.trace_b.read_text())
        self.assertIsNone(benchmark.review_photo_loader(self.Session, data_b)())

    def test_a_trace_of_the_current_epoch_still_reads_through_the_database(self):
        data_a = {**json.loads(self.trace_a.read_text()), "data_epoch": self.old_epoch}
        self.assertIsNotNone(benchmark.review_photo_loader(self.Session, data_a)())
        stale = {**data_a, "data_epoch": "some-older-epoch"}
        self.assertIsNone(benchmark.review_photo_loader(self.Session, stale)())

    def test_another_stacks_trace_is_not_looked_up_here(self):
        foreign = {**json.loads(self.trace_a.read_text()), "_source": "prod"}
        self.assertIsNone(benchmark.review_photo_loader(self.Session, foreign))

    def test_detaching_twice_changes_nothing_the_second_time(self):
        first = trace_photos.detach_review_photos(self.db, self.old_epoch)
        self.assertEqual((first["copied"], first["no_photo"]), (1, 1))
        snap = snapshot(self.root / "traces")
        second = trace_photos.detach_review_photos(self.db, self.old_epoch)
        self.assertEqual((second["copied"], second["already_done"]), (0, 1))
        self.assertEqual(snapshot(self.root / "traces"), snap)

    def test_a_failure_to_detach_aborts_before_anything_is_deleted(self):
        with patch.object(trace_photos, "_atomic_write", side_effect=OSError("disk full")):
            with self.assertRaises(data_wipe.WipeRefused) as ctx:
                self.wipe()
        self.assertEqual(ctx.exception.code, "detach_failed")
        self.assertEqual(self.db.query(User).count(), 2)
        self.assertEqual(self.db.query(CollectionItem).count(), 2)
        self.assertEqual(self.db.query(ScanJobItem).count(), 2)
        self.assertEqual(data_wipe.get_data_epoch(self.db), self.old_epoch)
        self.assertTrue((self.root / "uploads" / "job-1.jpg").exists())

    def test_new_traces_carry_the_data_epoch(self):
        from services.scan_trace import create_scan_trace

        self.db.add(UserSetting(user_id=self.trainer_id, key="scan_diagnostics_enabled", value="true"))
        self.db.commit()
        trace = create_scan_trace(self.db, self.trainer_id, mode="job", job_id=self.job_id, item_id=self.item_id)
        self.assertTrue(trace.enabled)
        self.assertEqual(trace.data["data_epoch"], self.old_epoch)

    def test_audit_entry_is_written_and_old_entries_stay_readable(self):
        report = self.wipe()
        entry = self.db.query(AuditLog).filter(AuditLog.action == "data.wipe").one()
        details = json.loads(entry.details)
        self.assertEqual(details["actor"], "oldadmin")
        self.assertEqual(details["backup_file"], "pre-wipe-20261118T000000Z.sql")
        self.assertEqual(details["deleted_rows"]["collection"], 2)
        self.assertEqual(details["new_admin"], "boss")
        self.assertIsNone(entry.actor_user_id)
        self.assertEqual(report["backup_file"], details["backup_file"])
        old = self.db.query(AuditLog).filter(AuditLog.action == "user.create").one()
        self.assertEqual(json.loads(old.details)["actor"], "oldadmin")

    def test_audit_details_never_hold_secrets(self):
        self.wipe()
        entry = self.db.query(AuditLog).filter(AuditLog.action == "data.wipe").one()
        for secret in ("env-secret-pw", "sk-keep-me", "gem-keep-me"):
            self.assertNotIn(secret, entry.details)

    # --- the endpoint -----------------------------------------------------------------------

    def call(self, user=None, **body):
        payload = wipe_api.WipeRequest(**body)
        with patch.object(wipe_api, "multi_user_enabled", return_value=True):
            return asyncio.run(wipe_api.run_data_wipe(payload, None, user or self.admin, self.db))

    def test_non_admins_are_refused(self):
        with self.assertRaises(HTTPException) as ctx:
            self.call(self.trainer, phrase="WIPE ALL DATA", password="ash-pw")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(self.db.query(User).count(), 2)

    def test_wrong_phrase_is_refused(self):
        for phrase in ("", "wipe all data", "WIPE ALL DATA ", "yes"):
            with self.assertRaises(HTTPException) as ctx:
                self.call(phrase=phrase, password="old-pw")
            self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(self.db.query(User).count(), 2)

    def test_wrong_or_missing_password_is_refused(self):
        for password in (None, "", "nope"):
            with self.assertRaises(HTTPException) as ctx:
                self.call(phrase="WIPE ALL DATA", password=password)
            self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(self.db.query(User).count(), 2)

    def test_refused_without_environment_admin_through_the_endpoint(self):
        with patch.dict(os.environ, {"ADMIN_USERNAME": "", "ADMIN_PASSWORD": ""}):
            with self.assertRaises(HTTPException) as ctx:
                self.call(phrase="WIPE ALL DATA", password="old-pw")
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("ADMIN_PASSWORD", ctx.exception.detail)
        self.assertEqual(self.db.query(User).count(), 2)

    def test_endpoint_without_password_in_single_user_mode(self):
        payload = wipe_api.WipeRequest(phrase="WIPE ALL DATA")
        with patch.object(wipe_api, "multi_user_enabled", return_value=False), \
                patch.object(data_wipe, "wipe_all_user_data", return_value={"ok": True}) as run:
            result = asyncio.run(wipe_api.run_data_wipe(payload, None, self.admin, self.db))
        self.assertEqual(result, {"ok": True})
        self.assertNotIn("include_traces", run.call_args.kwargs)

    def test_preview_lists_counts_and_readiness(self):
        with patch.dict(os.environ, ENV), patch.object(wipe_api, "multi_user_enabled", return_value=True):
            preview = wipe_api.preview_data_wipe(self.admin, self.db)
        self.assertEqual(preview["phrase"], "WIPE ALL DATA")
        self.assertTrue(preview["env_admin_ready"])
        self.assertEqual(preview["delete"]["collection"], 2)
        self.assertIn("settings", preview["keep"])
        with patch.dict(os.environ, {"ADMIN_USERNAME": "", "ADMIN_PASSWORD": ""}), \
                patch.object(wipe_api, "multi_user_enabled", return_value=True):
            self.assertFalse(wipe_api.preview_data_wipe(self.admin, self.db)["env_admin_ready"])
        with self.assertRaises(HTTPException):
            wipe_api.preview_data_wipe(self.trainer, self.db)

    def test_health_shows_wiped_at_only_after_a_wipe(self):
        before = data_wipe.health_fields(self.db)
        self.assertEqual(before["data_epoch"], self.old_epoch)
        self.assertIsNone(before["data_wiped_at"])
        report = self.wipe()
        after = data_wipe.health_fields(self.db)
        self.assertEqual(after["data_epoch"], report["data_epoch"])
        self.assertEqual(after["data_wiped_at"], report["data_wiped_at"])
        self.assertRegex(after["data_wiped_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")

    def test_a_refused_or_failed_wipe_leaves_no_wiped_at(self):
        with self.assertRaises(data_wipe.WipeRefused):
            self.wipe(env={})
        with patch.object(data_wipe, "write_scanner_settings", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.wipe()
        self.assertIsNone(data_wipe.health_fields(self.db)["data_wiped_at"])

    def test_health_endpoint_includes_both_fields(self):
        import main

        class FakeSession:
            def __enter__(self_inner):
                return self.db

            def __exit__(self_inner, *args):
                return False

        with patch("database.SessionLocal", FakeSession):
            payload = main.health_check()
        self.assertEqual(payload["data_epoch"], self.old_epoch)
        self.assertIsNone(payload["data_wiped_at"])
    def test_pre_wipe_backup_name_and_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(data_wipe.WipeBackupFailed):
                data_wipe.create_pre_wipe_backup("", Path(folder))
            with patch.object(data_wipe.subprocess, "run") as run:
                run.return_value.returncode = 1
                run.return_value.stderr = "pg_dump: error"
                with self.assertRaises(data_wipe.WipeBackupFailed):
                    data_wipe.create_pre_wipe_backup("postgresql://u:p@db:5432/x", Path(folder))
            self.assertEqual(list(Path(folder).iterdir()), [])  # no half-written file left behind


if __name__ == "__main__":
    unittest.main()
