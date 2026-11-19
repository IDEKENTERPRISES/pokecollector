import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api import backup as backup_api
    from database import Base
    from models import AuditLog
    from services import data_wipe
    from services.auth import hash_password
    from services.restore_sql_guard import check_restore_sql
    from tests.test_restore_sql_guard import REAL_DUMP

    DEPS = True
except ModuleNotFoundError:
    DEPS = False

PARAMS = {"user": "pokemon", "password": "secret", "host": "postgres", "port": "5432", "dbname": "pokemon_tcg"}
VALID_SQL = b"SET statement_timeout = 0;\n"


@unittest.skipUnless(DEPS, "FastAPI dependencies are not installed")
class ServerBackupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.admin = SimpleNamespace(id=1, username="boss", role="admin", hashed_password=hash_password("pw"))
        self.trainer = SimpleNamespace(id=2, username="ash", role="trainer", hashed_password=hash_password("pw"))
        for patcher in (
            patch.object(backup_api, "BACKUP_DIR", str(self.dir)),
            patch.object(backup_api, "get_db_params", return_value=PARAMS),
            patch.object(backup_api, "_clear_idempotency_keys"),
            patch.object(backup_api, "_recreate_schema"),
            patch.object(backup_api, "_mark_all_users_dirty"),
            patch.object(backup_api.restore_schema, "plan_restore_drops", return_value=[]),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self._reset()
        self.addCleanup(self._reset)

    def tearDown(self):
        self._wait()
        self.db.close()
        self.tmp.cleanup()

    @staticmethod
    def _reset():
        with backup_api._restore_lock:
            backup_api._restore_state.clear()
            backup_api._restore_state.update(backup_api._IDLE_RESTORE_STATE)

    def _wait(self, timeout=5.0):
        deadline = time.monotonic() + timeout
        while backup_api._load_restore_state()["state"] == "running":
            if time.monotonic() > deadline:
                self.fail("restore job did not finish")
            time.sleep(0.01)
        return backup_api._load_restore_state()

    def make(self, name, content=b"-- dump\n", age=0):
        path = self.dir / name
        path.write_bytes(content)
        stamp = time.time() - age
        os.utime(path, (stamp, stamp))
        return path

    async def restore(self, filename, password="pw", user=None, multi_user=True):
        body = backup_api.ServerRestoreRequest(filename=filename, password=password)
        with patch.object(backup_api, "multi_user_enabled", return_value=multi_user):
            return await backup_api.restore_server_backup(body, None, user or self.admin, self.db)

    # --- the list -----------------------------------------------------------------------------

    def test_list_shows_sql_files_newest_first_with_kind_size_and_date(self):
        self.make("pokemon_tcg_backup_20261101_100000.sql", age=300)
        self.make("pre-wipe-20261118T120000Z.sql", b"-- wipe dump\n", age=10)
        self.make("pre_upgrade_1.0_to_1.1_20261110_090000.sql", age=100)
        listed = backup_api.list_server_backups()
        self.assertEqual([item["name"] for item in listed], [
            "pre-wipe-20261118T120000Z.sql",
            "pre_upgrade_1.0_to_1.1_20261110_090000.sql",
            "pokemon_tcg_backup_20261101_100000.sql",
        ])
        self.assertEqual([item["kind"] for item in listed], ["pre-wipe", "pre-upgrade", "download"])
        self.assertEqual(listed[0]["size"], len(b"-- wipe dump\n"))
        self.assertRegex(listed[0]["modified"], r"^\d{4}-\d{2}-\d{2}T")

    def test_list_ignores_other_temp_hidden_and_empty_files(self):
        self.make("good.sql")
        self.make("notes.txt")
        self.make("backup.sql.gz")
        self.make(".pre-wipe-x.sql.tmp")
        self.make(".hidden.sql")
        self.make("restore_abcd1234.sql")
        self.make("restore_status.json", b"{}")
        self.make("empty.sql", b"")
        self.make("has space.sql")
        (self.dir / "folder.sql").mkdir()
        self.assertEqual([item["name"] for item in backup_api.list_server_backups()], ["good.sql"])

    def test_list_skips_symlinks(self):
        target = self.make("real.sql")
        try:
            os.symlink(target, self.dir / "link.sql")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not available here")
        self.assertEqual([item["name"] for item in backup_api.list_server_backups()], ["real.sql"])

    def test_list_of_a_missing_folder_is_empty(self):
        with patch.object(backup_api, "BACKUP_DIR", str(self.dir / "nope")):
            self.assertEqual(backup_api.list_server_backups(), [])

    # --- names ----------------------------------------------------------------------------------

    def test_only_a_bare_existing_file_name_is_accepted(self):
        path = self.make("pre-wipe-20261118T120000Z.sql")
        self.assertEqual(backup_api.resolve_server_backup("pre-wipe-20261118T120000Z.sql"), path.resolve())
        for bad in ("../x.sql", "a/b.sql", "a\\b.sql", "..sql", "x..y.sql", "", "/etc/passwd", ".hidden.sql", "restore_abc.sql",
                    "x.sql/", "x.txt", "a" * 300 + ".sql", "pre-wipe-20261118T120000Z.sql\0"):
            with self.assertRaises(HTTPException, msg=repr(bad)) as ctx:
                backup_api.resolve_server_backup(bad)
            self.assertIn(ctx.exception.status_code, (400, 404), repr(bad))
        with self.assertRaises(HTTPException) as ctx:
            backup_api.resolve_server_backup("missing.sql")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_a_symlink_is_refused_even_when_it_points_into_the_folder(self):
        target = self.make("real.sql")
        outside = Path(self.tmp.name).parent / "outside-target.sql"
        outside.write_bytes(b"x")
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        try:
            os.symlink(target, self.dir / "inside.sql")
            os.symlink(outside, self.dir / "outside.sql")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not available here")
        for name in ("inside.sql", "outside.sql"):
            with self.assertRaises(HTTPException) as ctx:
                backup_api.resolve_server_backup(name)
            self.assertEqual(ctx.exception.status_code, 400)

    # --- who may ----------------------------------------------------------------------------------

    async def test_non_admins_get_403_everywhere(self):
        self.make("a.sql")
        with self.assertRaises(HTTPException) as ctx:
            backup_api.server_backups(self.trainer)
        self.assertEqual(ctx.exception.status_code, 403)
        with self.assertRaises(HTTPException) as ctx:
            backup_api.download_server_backup(None, "a.sql", self.trainer, self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        with self.assertRaises(HTTPException) as ctx:
            await self.restore("a.sql", user=self.trainer)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(self.db.query(AuditLog).count(), 0)

    def test_download_streams_the_file_and_writes_an_audit_entry(self):
        self.make("a.sql", b"SELECT 1;\n")
        response = backup_api.download_server_backup(None, "a.sql", self.admin, self.db)
        self.assertEqual(Path(response.path).name, "a.sql")
        self.assertIn("attachment", response.headers["content-disposition"])
        entry = self.db.query(AuditLog).one()
        self.assertEqual((entry.action, entry.target_type, entry.target_id), ("backup.download", "backup", "a.sql"))

    def test_listing_endpoint_returns_the_files(self):
        self.make("a.sql")
        self.assertEqual([b["name"] for b in backup_api.server_backups(self.admin)["backups"]], ["a.sql"])

    # --- restore ------------------------------------------------------------------------------------

    async def test_restore_from_file_runs_the_same_job_and_keeps_the_original(self):
        original = self.make("pre-wipe-20261118T120000Z.sql", VALID_SQL)
        seen = {}

        def fake_run(command, **_kwargs):
            path = Path(command[command.index("-f") + 1])
            seen["command"] = command
            seen["copy"] = path
            seen["content"] = path.read_bytes()
            return subprocess.CompletedProcess(command, 0, "", "")

        with patch.object(backup_api.subprocess, "run", side_effect=fake_run):
            result = await self.restore("pre-wipe-20261118T120000Z.sql")
            status = self._wait()
        self.assertEqual((result["state"], result["filename"]), ("running", "pre-wipe-20261118T120000Z.sql"))
        self.assertEqual(status["state"], "done")
        self.assertEqual(seen["content"], VALID_SQL)
        self.assertNotEqual(seen["copy"], original)
        self.assertIn("--single-transaction", seen["command"])
        self.assertIn("ON_ERROR_STOP=1", seen["command"])
        self.assertTrue(original.exists())  # the backup itself is never deleted
        self.assertFalse(seen["copy"].exists())  # the temporary copy is
        entry = self.db.query(AuditLog).one()
        self.assertEqual((entry.action, entry.target_id), ("backup.restore", "pre-wipe-20261118T120000Z.sql"))

    async def test_restore_is_refused_while_one_is_running(self):
        self.make("a.sql", VALID_SQL)
        with backup_api._restore_lock:
            backup_api._restore_state.update(state="running", started_at="now", started_by=1)
        with self.assertRaises(HTTPException) as ctx:
            await self.restore("a.sql")
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(backup_api._restore_state["state"], "running")  # the running job is untouched
        self._reset()
        self.assertEqual(self.db.query(AuditLog).count(), 0)

    async def test_restore_needs_the_password_when_logins_are_on(self):
        self.make("a.sql", VALID_SQL)
        for password in (None, "", "wrong"):
            with self.assertRaises(HTTPException) as ctx:
                await self.restore("a.sql", password=password)
            self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(backup_api._restore_state["state"], "idle")

    async def test_a_file_the_sql_guard_rejects_is_not_restored_and_the_slot_is_freed(self):
        self.make("evil.sql", b"\\! rm -rf /\n")
        with patch.object(backup_api.subprocess, "run") as run:
            with self.assertRaises(HTTPException) as ctx:
                await self.restore("evil.sql")
        self.assertEqual(ctx.exception.status_code, 400)
        run.assert_not_called()
        self.assertEqual(backup_api._restore_state["state"], "idle")
        self.assertEqual([p.name for p in self.dir.iterdir() if p.name.startswith("restore_")], [])
        self.assertTrue((self.dir / "evil.sql").exists())

    async def test_bad_names_never_start_a_restore(self):
        for bad in ("../x.sql", "a/b.sql", "missing.sql"):
            with self.assertRaises(HTTPException):
                await self.restore(bad)
        self.assertEqual(backup_api._restore_state["state"], "idle")


@unittest.skipUnless(DEPS, "FastAPI dependencies are not installed")
class PreWipeDumpTests(unittest.TestCase):
    def test_the_dump_the_wipe_makes_passes_the_restore_guard(self):
        """create_pre_wipe_backup runs `pg_dump --clean --if-exists --exclude-table-data image_cache`. A fake pg_dump
        writes dump text shaped like that output (image_cache keeps its schema but has no COPY block), and the file
        the real function leaves in the backups folder must pass the same guard a restore applies."""
        dump = REAL_DUMP.replace(
            "\\unrestrict AbC123xyz\n",
            "DROP TABLE IF EXISTS public.image_cache;\n"
            "CREATE TABLE public.image_cache (\n    id integer NOT NULL,\n    image_key character varying NOT NULL,\n"
            "    data bytea NOT NULL\n);\n"
            "ALTER TABLE public.image_cache OWNER TO pokemon;\n"
            "ALTER TABLE ONLY public.image_cache\n    ADD CONSTRAINT image_cache_pkey PRIMARY KEY (id);\n"
            "\n\\unrestrict AbC123xyz\n",
        )
        seen = {}

        def fake_pg_dump(command, **_kwargs):
            seen["command"] = command
            Path(command[command.index("-f") + 1]).write_text(dump, encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "", "")

        with tempfile.TemporaryDirectory() as folder, patch.object(data_wipe.subprocess, "run", side_effect=fake_pg_dump):
            path = data_wipe.create_pre_wipe_backup("postgresql://u:p@db:5432/x", Path(folder))
            self.assertRegex(path.name, r"^pre-wipe-\d{8}T\d{6}Z\.sql$")
            check_restore_sql(path)
            self.assertEqual([p.name for p in Path(folder).iterdir()], [path.name])
        for flag in ("--clean", "--if-exists"):
            self.assertIn(flag, seen["command"])
        index = seen["command"].index("--exclude-table-data")
        self.assertEqual(seen["command"][index + 1], "image_cache")


if __name__ == "__main__":
    unittest.main()
