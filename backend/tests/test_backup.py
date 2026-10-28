import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    from fastapi import HTTPException

    from api import backup as backup_api
    from services.auth import hash_password

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


VALID_SQL = b"SET statement_timeout = 0;\n"


def status_file(directory: str) -> Path:
    return Path(directory) / backup_api.RESTORE_STATE_FILENAME


class ChunkedUpload:
    def __init__(self, payload: bytes, filename: str = "backup.sql", chunk_size: int = 3):
        self.filename = filename
        self._payload = payload
        self._position = 0
        self._chunk_size = chunk_size
        self.requested_sizes = []

    async def read(self, size: int = -1) -> bytes:
        self.requested_sizes.append(size)
        if self._position >= len(self._payload):
            return b""
        chunk_size = self._chunk_size if size < 0 else min(size, self._chunk_size)
        chunk = self._payload[self._position:self._position + chunk_size]
        self._position += len(chunk)
        return chunk


class InterruptedUpload(ChunkedUpload):
    async def read(self, size: int = -1) -> bytes:
        if self._position:
            raise OSError("upload interrupted")
        return await super().read(size)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI dependencies are not installed")
class BackupCommandTests(unittest.TestCase):
    def setUp(self):
        self.admin = SimpleNamespace(role="admin")
        self.params = {
            "user": "pokemon",
            "password": "secret",
            "host": "postgres",
            "port": "5432",
            "dbname": "pokemon_tcg",
        }
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_non_admin_cannot_download_a_backup(self):
        trainer = SimpleNamespace(role="trainer")
        with self.assertRaises(HTTPException) as raised:
            backup_api.download_backup(include="full", current_user=trainer)
        self.assertEqual(raised.exception.status_code, 403)

    def test_non_admin_cannot_clear_the_image_cache(self):
        trainer = SimpleNamespace(role="trainer")
        with self.assertRaises(HTTPException) as raised:
            backup_api.clear_image_cache(current_user=trainer)
        self.assertEqual(raised.exception.status_code, 403)

    def test_full_backup_excludes_only_image_cache_rows(self):
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run", return_value=completed) as run:
            backup_api.download_backup(include="full", current_user=self.admin)

        command = run.call_args.args[0]
        self.assertIn("--exclude-table-data", command)
        self.assertEqual(command[command.index("--exclude-table-data") + 1], "image_cache")
        self.assertNotIn("--exclude-table", command)

    def test_full_backup_can_include_image_cache_rows(self):
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run", return_value=completed) as run:
            backup_api.download_backup(include="full,images", current_user=self.admin)

        command = run.call_args.args[0]
        self.assertNotIn("--exclude-table-data", command)
        self.assertNotIn("--exclude-table", command)

    def test_collection_backup_includes_printing_detail_tags_and_links(self):
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run", return_value=completed) as run:
            backup_api.download_backup(include="collection", current_user=self.admin)

        command = run.call_args.args[0]
        selected_tables = [
            command[index + 1]
            for index, argument in enumerate(command)
            if argument == "-t"
        ]
        self.assertIn("printing_detail_tags", selected_tables)
        self.assertIn("collection_printing_detail_tags", selected_tables)

    def test_product_backup_includes_printing_detail_tags_and_links(self):
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run", return_value=completed) as run:
            backup_api.download_backup(include="products", current_user=self.admin)

        command = run.call_args.args[0]
        selected_tables = [
            command[index + 1]
            for index, argument in enumerate(command)
            if argument == "-t"
        ]
        self.assertIn("printing_detail_tags", selected_tables)
        self.assertIn("product_card_printing_detail_tags", selected_tables)
        self.assertIn("product_ledger_printing_detail_tags", selected_tables)

    def test_combined_partial_backup_deduplicates_shared_printing_detail_table(self):
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run", return_value=completed) as run:
            backup_api.download_backup(include="collection,products", current_user=self.admin)

        command = run.call_args.args[0]
        selected_tables = [
            command[index + 1]
            for index, argument in enumerate(command)
            if argument == "-t"
        ]
        self.assertEqual(selected_tables.count("printing_detail_tags"), 1)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI dependencies are not installed")
class RestoreBackupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.admin = SimpleNamespace(role="admin")
        self.params = {
            "user": "pokemon",
            "password": "secret",
            "host": "postgres",
            "port": "5432",
            "dbname": "pokemon_tcg",
        }
        self.temp_dir = tempfile.TemporaryDirectory()
        self._reset_restore_state()
        self.addCleanup(self._reset_restore_state)
        clear_keys = patch.object(backup_api, "_clear_idempotency_keys")
        self.clear_keys = clear_keys.start()
        self.addCleanup(clear_keys.stop)

    def tearDown(self):
        self._wait_for_restore_to_finish()
        self.temp_dir.cleanup()

    @staticmethod
    def _reset_restore_state():
        with backup_api._restore_lock:
            backup_api._restore_state.clear()
            backup_api._restore_state.update(backup_api._IDLE_RESTORE_STATE)

    def _wait_for_restore_to_finish(self, timeout=5.0):
        deadline = time.monotonic() + timeout
        while backup_api._load_restore_state()["state"] == "running":
            if time.monotonic() > deadline:
                self.fail("restore job did not finish")
            time.sleep(0.01)
        return backup_api._load_restore_state()

    def _patches(self, run_result):
        if isinstance(run_result, BaseException) or callable(run_result):
            run_patch = patch.object(backup_api.subprocess, "run", side_effect=run_result)
        else:
            run_patch = patch.object(backup_api.subprocess, "run", return_value=run_result)
        return (
            patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name),
            patch.object(backup_api, "get_db_params", return_value=self.params),
            run_patch,
        )

    def _remaining_files(self):
        return list(Path(self.temp_dir.name).iterdir())

    async def _restore(self, upload, password=None, multi_user=False, user=None):
        with patch.object(backup_api, "multi_user_enabled", return_value=multi_user):
            return await backup_api.restore_backup(
                upload, password=password, current_user=user or self.admin, db=None
            )

    async def _restore_and_wait(self, *args, **kwargs):
        result = await self._restore(*args, **kwargs)
        return result, self._wait_for_restore_to_finish()

    def _uploads_left(self):
        return [path for path in self._remaining_files() if path.suffix == ".sql"]

    async def test_restore_is_streamed_atomic_and_stops_on_sql_errors(self):
        upload = ChunkedUpload(VALID_SQL, filename="BACKUP.SQL")
        captured_command = None

        def complete(command, **_kwargs):
            nonlocal captured_command
            captured_command = command
            self.assertTrue(Path(command[command.index("-f") + 1]).is_file())
            return subprocess.CompletedProcess(command, 0, "", "")

        backup_dir, params, run = self._patches(complete)
        with backup_dir, params, run:
            result, status = await self._restore_and_wait(upload)

        self.assertEqual(result["state"], "running")
        self.assertEqual(status["state"], "done")
        self.assertIsNone(status["error"])
        self.clear_keys.assert_called_once()
        self.assertEqual(captured_command[captured_command.index("-v") + 1], "ON_ERROR_STOP=1")
        self.assertIn("--no-psqlrc", captured_command)
        self.assertIn("--single-transaction", captured_command)
        self.assertGreater(len(upload.requested_sizes), 2)
        self.assertTrue(all(size == backup_api.RESTORE_CHUNK_SIZE for size in upload.requested_sizes))
        self.assertEqual(self._uploads_left(), [])

    async def test_restore_error_removes_temporary_upload(self):
        completed = subprocess.CompletedProcess([], 1, "", "broken SQL")
        backup_dir, params, run = self._patches(completed)
        with backup_dir, params, run:
            _, status = await self._restore_and_wait(ChunkedUpload(VALID_SQL))

        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["error"], "Restore failed: broken SQL")
        self.clear_keys.assert_not_called()
        self.assertEqual(self._uploads_left(), [])

    async def test_restore_timeout_removes_temporary_upload(self):
        timeout = subprocess.TimeoutExpired("psql", 120)
        backup_dir, params, run = self._patches(timeout)
        with backup_dir, params, run:
            _, status = await self._restore_and_wait(ChunkedUpload(VALID_SQL))

        self.assertEqual(status["state"], "failed")
        self.assertIn("timed out", status["error"])
        self.assertIn("RESTORE_TIMEOUT_SECONDS", status["error"])
        self.clear_keys.assert_not_called()
        self.assertEqual(self._uploads_left(), [])

    async def test_missing_psql_removes_temporary_upload(self):
        backup_dir, params, run = self._patches(FileNotFoundError())
        with backup_dir, params, run:
            _, status = await self._restore_and_wait(ChunkedUpload(VALID_SQL))

        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["error"], "psql not found")
        self.assertEqual(self._uploads_left(), [])

    async def test_empty_restore_is_rejected_without_running_psql(self):
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 0, "", ""))
        with backup_dir, params, run as run_mock, self.assertRaises(HTTPException) as raised:
            await self._restore(ChunkedUpload(b""))

        self.assertEqual(raised.exception.status_code, 400)
        run_mock.assert_not_called()
        self.assertEqual(self._remaining_files(), [])

    async def test_missing_filename_is_rejected_without_creating_a_file(self):
        upload = ChunkedUpload(VALID_SQL, filename=None)
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run") as run, \
             self.assertRaises(HTTPException) as raised:
            await self._restore(upload)

        self.assertEqual(raised.exception.status_code, 400)
        run.assert_not_called()
        self.assertEqual(self._remaining_files(), [])

    async def test_interrupted_upload_removes_partial_file(self):
        upload = InterruptedUpload(VALID_SQL, chunk_size=3)
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 0, "", ""))
        with backup_dir, params, run as run_mock, self.assertRaises(OSError):
            await self._restore(upload)

        run_mock.assert_not_called()
        self.assertEqual(self._remaining_files(), [])

    async def test_restore_requires_the_admin_password_when_logins_are_enabled(self):
        admin = SimpleNamespace(role="admin", hashed_password=hash_password("correct horse battery"))
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 0, "", ""))
        with backup_dir, params, run as run_mock:
            for password in (None, "", "wrong password"):
                with self.subTest(password=password), self.assertRaises(HTTPException) as raised:
                    await self._restore(ChunkedUpload(VALID_SQL), password=password, multi_user=True, user=admin)
                self.assertEqual(raised.exception.status_code, 403)
            run_mock.assert_not_called()

            result, status = await self._restore_and_wait(
                ChunkedUpload(VALID_SQL), password="correct horse battery", multi_user=True, user=admin
            )
        self.assertEqual(result["state"], "running")
        self.assertEqual(status["state"], "done")
        self.assertEqual(self._uploads_left(), [])

    async def test_restore_does_not_ask_for_a_password_in_single_user_mode(self):
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 0, "", ""))
        with backup_dir, params, run:
            result, status = await self._restore_and_wait(ChunkedUpload(VALID_SQL), multi_user=False)
        self.assertEqual(result["state"], "running")
        self.assertEqual(status["state"], "done")

    async def test_non_admin_cannot_restore_even_with_a_password(self):
        trainer = SimpleNamespace(role="trainer", hashed_password=hash_password("x" * 12))
        with self.assertRaises(HTTPException) as raised:
            await self._restore(ChunkedUpload(VALID_SQL), password="x" * 12, multi_user=True, user=trainer)
        self.assertEqual(raised.exception.status_code, 403)

    async def test_dump_with_psql_commands_is_rejected_before_psql_runs(self):
        malicious = b"SET statement_timeout = 0;\n\\! id > /app/backups/pwned\n"
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 0, "", ""))
        with backup_dir, params, run as run_mock, self.assertRaises(HTTPException) as raised:
            await self._restore(ChunkedUpload(malicious))

        self.assertEqual(raised.exception.status_code, 400)
        run_mock.assert_not_called()
        self.assertEqual(self._remaining_files(), [])

    async def test_dump_that_runs_server_programs_is_rejected_before_psql_runs(self):
        malicious = b"COPY public.cards FROM PROGRAM 'id';\n"
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 0, "", ""))
        with backup_dir, params, run as run_mock, self.assertRaises(HTTPException) as raised:
            await self._restore(ChunkedUpload(malicious))

        self.assertEqual(raised.exception.status_code, 400)
        run_mock.assert_not_called()


    async def test_restore_returns_at_once_and_reports_running_then_done(self):
        release = threading.Event()
        started = threading.Event()

        def slow_psql(command, **_kwargs):
            started.set()
            release.wait(5)
            return subprocess.CompletedProcess(command, 0, "", "")

        backup_dir, params, run = self._patches(slow_psql)
        with backup_dir, params, run:
            self.assertEqual(backup_api.restore_status(current_user=self.admin)["state"], "idle")
            result = await self._restore(ChunkedUpload(VALID_SQL))
            self.assertEqual(result["state"], "running")
            self.assertTrue(result["job_id"])
            self.assertTrue(started.wait(5))

            running = backup_api.restore_status(current_user=self.admin)
            self.assertEqual(running["state"], "running")
            self.assertTrue(running["started_at"])
            self.assertIsNone(running["finished_at"])
            self.assertEqual(set(running), {"state", "started_at", "finished_at", "error"})
            self.assertTrue(status_file(self.temp_dir.name).is_file())
            # psql is still reading the upload while it runs.
            self.assertEqual(len(self._uploads_left()), 1)

            release.set()
            done = self._wait_for_restore_to_finish()

        self.assertEqual(done["state"], "done")
        status = backup_api.restore_status(current_user=self.admin)
        self.assertEqual(status["state"], "done")
        self.assertTrue(status["finished_at"])
        self.assertIsNone(status["error"])
        self.assertEqual(self._uploads_left(), [])

    async def test_second_restore_while_one_runs_is_a_409_and_leaves_the_first_alone(self):
        release = threading.Event()
        started = threading.Event()

        def slow_psql(command, **_kwargs):
            started.set()
            release.wait(5)
            return subprocess.CompletedProcess(command, 0, "", "")

        backup_dir, params, run = self._patches(slow_psql)
        with backup_dir, params, run as run_mock:
            await self._restore(ChunkedUpload(VALID_SQL))
            self.assertTrue(started.wait(5))
            with self.assertRaises(HTTPException) as raised:
                await self._restore(ChunkedUpload(VALID_SQL))
            self.assertEqual(raised.exception.status_code, 409)
            self.assertEqual(run_mock.call_count, 1)
            self.assertEqual(backup_api.restore_status(current_user=self.admin)["state"], "running")
            self.assertEqual(len(self._uploads_left()), 1)
            release.set()
            self._wait_for_restore_to_finish()

        # A new restore is accepted again once the first one finished.
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 0, "", ""))
        with backup_dir, params, run:
            _, status = await self._restore_and_wait(ChunkedUpload(VALID_SQL))
        self.assertEqual(status["state"], "done")

    async def test_rejected_upload_does_not_block_the_next_restore(self):
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 0, "", ""))
        with backup_dir, params, run, self.assertRaises(HTTPException):
            await self._restore(ChunkedUpload(b""))
        self.assertEqual(backup_api.restore_status(current_user=self.admin)["state"], "idle")

    async def test_timeout_comes_from_the_environment(self):
        captured = {}

        def fake_psql(command, **kwargs):
            captured.update(kwargs)
            return subprocess.CompletedProcess(command, 0, "", "")

        backup_dir, params, run = self._patches(fake_psql)
        with backup_dir, params, run:
            with patch.dict(os.environ, {"RESTORE_TIMEOUT_SECONDS": "7200"}):
                await self._restore_and_wait(ChunkedUpload(VALID_SQL))
            self.assertEqual(captured["timeout"], 7200)
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("RESTORE_TIMEOUT_SECONDS", None)
                await self._restore_and_wait(ChunkedUpload(VALID_SQL))
            self.assertEqual(captured["timeout"], 3600)
            with patch.dict(os.environ, {"RESTORE_TIMEOUT_SECONDS": "soon"}):
                await self._restore_and_wait(ChunkedUpload(VALID_SQL))
            self.assertEqual(captured["timeout"], 3600)

    async def test_status_survives_a_reload_from_the_status_file(self):
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 1, "", "boom"))
        with backup_dir, params, run:
            await self._restore_and_wait(ChunkedUpload(VALID_SQL))
            # A fresh process has nothing in memory but the file.
            self._reset_restore_state()
            status = backup_api.restore_status(current_user=self.admin)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["error"], "Restore failed: boom")

    def test_a_restore_left_running_by_a_restart_reads_as_failed(self):
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name):
            status_file(self.temp_dir.name).write_text(
                '{"state": "running", "started_at": "2026-01-01T00:00:00+00:00"}', encoding="utf-8"
            )
            status = backup_api.restore_status(current_user=self.admin)
        self.assertEqual(status["state"], "failed")
        self.assertIn("restarted", status["error"])

    def test_status_is_admin_only(self):
        trainer = SimpleNamespace(role="trainer")
        with self.assertRaises(HTTPException) as raised:
            backup_api.restore_status(current_user=trainer)
        self.assertEqual(raised.exception.status_code, 403)

    def test_status_poll_skips_the_database_while_the_starter_restore_runs(self):
        from services.auth import create_access_token

        with backup_api._restore_lock:
            backup_api._restore_state.update(state="running", started_by=7, requires_token=True)
        mine = create_access_token({"sub": "7"})
        other = create_access_token({"sub": "8"})
        request = SimpleNamespace(url=SimpleNamespace(path="/api/backup/restore/status"))

        with patch.object(backup_api, "get_current_user", side_effect=AssertionError("hit the database")):
            user = backup_api._restore_status_user(request=request, token=mine, db=None)
        self.assertEqual(user.role, "admin")
        # Anyone else still goes through the normal (database) check.
        with patch.object(
            backup_api, "get_current_user", side_effect=HTTPException(status_code=401)
        ) as normal:
            with self.assertRaises(HTTPException):
                backup_api._restore_status_user(request=request, token=other, db=None)
            normal.assert_called_once()
        self._reset_restore_state()


if __name__ == "__main__":
    unittest.main()
