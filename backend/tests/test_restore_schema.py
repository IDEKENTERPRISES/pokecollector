"""Restoring a dump into a database that has newer tables than the dump (psql mocked)."""

import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from api import backup as backup_api
    from services import restore_schema

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


PROD_DUMP = """\
--
-- PostgreSQL database dump
--

SET statement_timeout = 0;

DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.collection;
DROP TABLE IF EXISTS public."Odd ""Name";

CREATE TABLE public.users (
    id integer NOT NULL
);

CREATE TABLE public.collection (
    id integer NOT NULL
);

CREATE TABLE cards (
    id text
);

CREATE UNLOGGED TABLE IF NOT EXISTS public."Odd ""Name" (id integer);

CREATE TABLE other_schema.skipped (id integer);

COPY public.users (id) FROM stdin;
1
CREATE TABLE public.fake_in_data (id integer);
DROP TABLE public.fake_in_data;
\\.

ALTER TABLE ONLY public.users DROP CONSTRAINT IF EXISTS users_pkey;
"""

# The owner's case: the newer server has tables the old production dump does not.
NEWER_SCHEMA_EDGES = [
    ("progress_state", "users"),
    ("user_events", "users"),
    ("user_daily_activity", "users"),
    ("user_achievements", "users"),
    ("notification_queue", "users"),
    ("binder_slots", "binders"),  # binders is not in the dump: untouched chain
    ("collection", "users"),  # in the dump itself
    ("collection", "cards"),
    ("unrelated_child", "unrelated_parent"),
    ("achievement_rewards", "user_achievements"),  # transitive
]


class PlanTests(unittest.TestCase):
    def setUp(self):
        if not DEPS_AVAILABLE:
            self.skipTest("backend dependencies are not installed")

    def _dump_file(self, text):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "dump.sql"
        path.write_text(text, encoding="utf-8")
        return path

    def test_parser_finds_created_and_dropped_public_tables(self):
        tables = restore_schema.parse_dump_tables(self._dump_file(PROD_DUMP))
        self.assertEqual(tables, {"users", "collection", "cards", 'Odd "Name'})

    def test_parser_ignores_copy_data_and_other_schemas(self):
        tables = restore_schema.parse_dump_tables(self._dump_file(PROD_DUMP))
        self.assertNotIn("fake_in_data", tables)
        self.assertNotIn("skipped", tables)

    def test_parser_handles_a_dump_with_no_tables(self):
        self.assertEqual(restore_schema.parse_dump_tables(self._dump_file("SET x = 1;\n")), set())

    def test_closure_is_transitive_and_excludes_the_dump_and_unrelated_tables(self):
        dropped = restore_schema.compute_dependent_tables(
            {"users", "cards", "collection"}, NEWER_SCHEMA_EDGES
        )
        self.assertEqual(
            dropped,
            [
                "achievement_rewards",
                "notification_queue",
                "progress_state",
                "user_achievements",
                "user_daily_activity",
                "user_events",
            ],
        )

    def test_closure_is_empty_when_nothing_depends_on_the_dump(self):
        self.assertEqual(
            restore_schema.compute_dependent_tables(
                {"users"}, [("unrelated_child", "unrelated_parent"), ("users", "users")]
            ),
            [],
        )

    def test_closure_survives_cycles(self):
        self.assertEqual(
            restore_schema.compute_dependent_tables({"a"}, [("b", "a"), ("c", "b"), ("b", "c")]),
            ["b", "c"],
        )

    def test_drop_sql_quotes_catalog_names(self):
        sql = restore_schema.build_drop_sql(['we"ird', "progress_state"])
        self.assertEqual(
            sql,
            'DROP TABLE IF EXISTS "public"."progress_state", "public"."we""ird" CASCADE;',
        )
        self.assertIsNone(restore_schema.build_drop_sql([]))

    def test_plan_reads_the_dump_and_the_catalog(self):
        path = self._dump_file(PROD_DUMP)
        dropped = restore_schema.plan_restore_drops(
            path, {"host": "x"}, fetch_edges=lambda _params: NEWER_SCHEMA_EDGES
        )
        self.assertIn("progress_state", dropped)
        self.assertNotIn("users", dropped)
        self.assertNotIn("unrelated_child", dropped)

    def test_plan_falls_back_to_no_drops_when_the_catalog_is_unreachable(self):
        def broken(_params):
            raise OSError("no database")

        self.assertEqual(
            restore_schema.plan_restore_drops(self._dump_file(PROD_DUMP), {}, fetch_edges=broken), []
        )

    def test_the_drops_come_before_the_dump_in_the_same_psql_call(self):
        command = ["psql", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", "/app/backups/r.sql"]
        wrapped = restore_schema.with_drops(command, ["progress_state"])
        self.assertEqual(wrapped.count("--single-transaction"), 1)
        self.assertEqual(wrapped.count("-c"), 1)
        self.assertLess(wrapped.index("-c"), wrapped.index("-f"))
        self.assertTrue(wrapped[wrapped.index("-c") + 1].startswith("DROP TABLE IF EXISTS"))
        self.assertEqual(wrapped[-2:], ["-f", "/app/backups/r.sql"])

    def test_no_drops_leaves_the_command_unchanged(self):
        command = ["psql", "--single-transaction", "-f", "/app/backups/r.sql"]
        self.assertEqual(restore_schema.with_drops(command, []), command)


class RestoreJobTests(unittest.TestCase):
    def setUp(self):
        if not DEPS_AVAILABLE:
            self.skipTest("backend dependencies are not installed")
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.params = {
            "user": "u", "password": "p", "host": "postgres", "port": "5432", "dbname": "d",
        }
        self.dump = Path(self.temp_dir.name) / "restore_x.sql"
        self.dump.write_text(PROD_DUMP, encoding="utf-8")
        self.command = ["psql", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", str(self.dump)]
        patcher = patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("_recreate_schema", "_mark_all_users_dirty", "_clear_idempotency_keys"):
            patcher = patch.object(backup_api, name)
            setattr(self, name.strip("_"), patcher.start())
            self.addCleanup(patcher.stop)
        self.addCleanup(self._reset_state)
        self._reset_state()

    @staticmethod
    def _reset_state():
        with backup_api._restore_lock:
            backup_api._restore_state.clear()
            backup_api._restore_state.update(backup_api._IDLE_RESTORE_STATE)

    def _run(self, returncode=0, stderr="", edges=None):
        captured = {}

        def fake_run(command, **_kwargs):
            captured["command"] = command
            return subprocess.CompletedProcess(command, returncode, "", stderr)

        with patch.object(
            restore_schema, "fetch_fk_edges",
            return_value=NEWER_SCHEMA_EDGES if edges is None else edges,
        ), patch.object(backup_api.subprocess, "run", side_effect=fake_run):
            backup_api._run_restore_job(self.dump, self.command, {}, 60, self.params)
        return captured["command"], backup_api._load_restore_state()

    def test_newer_schema_drops_dependents_in_the_dump_transaction_then_recreates(self):
        command, status = self._run()
        self.assertEqual(status["state"], "done", status)
        self.assertEqual(command.count("--single-transaction"), 1)
        drop_sql = command[command.index("-c") + 1]
        self.assertLess(command.index("-c"), command.index("-f"))
        for table in ("progress_state", "user_events", "user_achievements", "achievement_rewards"):
            self.assertIn(f'"public"."{table}"', drop_sql)
        self.assertTrue(drop_sql.endswith("CASCADE;"))
        self.assertNotIn("unrelated_child", drop_sql)
        self.assertNotIn('"public"."users"', drop_sql)
        self.recreate_schema.assert_called_once_with()
        self.mark_all_users_dirty.assert_called_once_with()
        self.clear_idempotency_keys.assert_called_once_with()
        self.assertFalse(self.dump.exists())

    def test_same_schema_restore_drops_nothing(self):
        command, status = self._run(edges=[("unrelated_child", "unrelated_parent")])
        self.assertEqual(status["state"], "done", status)
        self.assertNotIn("-c", command)
        self.assertEqual(command, self.command)

    def test_a_failed_restore_recreates_and_marks_nothing(self):
        command, status = self._run(returncode=3, stderr="ERROR: boom\n")
        self.assertIn("-c", command)  # the drops were in the transaction psql rolled back
        self.assertEqual(status["state"], "failed")
        self.assertIn("boom", status["error"])
        self.recreate_schema.assert_not_called()
        self.mark_all_users_dirty.assert_not_called()
        self.clear_idempotency_keys.assert_not_called()

    def test_a_timeout_recreates_and_marks_nothing(self):
        with patch.object(
            backup_api.subprocess, "run", side_effect=subprocess.TimeoutExpired("psql", 1)
        ):
            backup_api._run_restore_job(self.dump, self.command, {}, 1, self.params)
        self.assertEqual(backup_api._load_restore_state()["state"], "failed")
        self.recreate_schema.assert_not_called()
        self.mark_all_users_dirty.assert_not_called()

    def test_schema_update_failure_is_reported_but_the_restore_still_finishes_its_steps(self):
        self.recreate_schema.side_effect = RuntimeError("migration broke")
        _command, status = self._run()
        self.assertEqual(status["state"], "failed")
        self.assertIn("Restart the server", status["error"])
        self.mark_all_users_dirty.assert_called_once_with()
        self.clear_idempotency_keys.assert_called_once_with()

    def test_order_is_psql_then_recreate_then_mark_dirty_then_clear_keys(self):
        order = []
        self.recreate_schema.side_effect = lambda: order.append("recreate")
        self.mark_all_users_dirty.side_effect = lambda: order.append("dirty")
        self.clear_idempotency_keys.side_effect = lambda: order.append("clear")
        self._run()
        self.assertEqual(order, ["recreate", "dirty", "clear"])


if __name__ == "__main__":
    unittest.main()
