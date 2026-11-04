import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from models import Base, User, UserSetting
    from api.settings import _get_user_settings, update_settings
    from services.scan_trace import (
        SCAN_DIAGNOSTICS_SETTING_KEY,
        create_scan_trace,
        delete_user_traces,
        record_ground_truth,
        revoke_user_traces,
        trace_available,
        trace_deletion_available,
        user_trace_enabled,
    )

    DEPS_AVAILABLE = True
except ImportError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed")
class ScanTraceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env = patch.dict(
            os.environ,
            {
                "SCAN_TRACE_DIR": self.temp_dir.name,
                "SCAN_TRACE_STORAGE_DIR": self.temp_dir.name,
            },
        )
        self.env.start()
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(username="trace-user", hashed_password="x")
        self.other_user = User(username="other-trace-user", hashed_password="x")
        self.db.add_all([self.user, self.other_user])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    def _enable(self, user):
        self.db.add(
            UserSetting(
                user_id=user.id,
                key=SCAN_DIAGNOSTICS_SETTING_KEY,
                value="true",
            )
        )
        self.db.commit()

    def test_tracing_requires_server_and_user_opt_in(self):
        self.assertTrue(trace_available())
        self.assertFalse(user_trace_enabled(self.db, self.user.id))
        trace = create_scan_trace(self.db, self.user.id, mode="single")
        trace.set_image(b"photo")
        self.assertIsNone(trace.save())
        self.assertEqual(list(Path(self.temp_dir.name).rglob("*")), [])

        self._enable(self.user)
        self.assertTrue(user_trace_enabled(self.db, self.user.id))

    def test_diagnostics_setting_is_per_user_and_off_by_default(self):
        self.assertEqual(
            _get_user_settings(self.db, self.user.id)[SCAN_DIAGNOSTICS_SETTING_KEY],
            "false",
        )
        self.assertEqual(
            _get_user_settings(self.db, self.user.id)["scan_diagnostics_available"],
            "true",
        )
        self.assertEqual(
            _get_user_settings(self.db, self.user.id)["scan_diagnostics_deletion_available"],
            "true",
        )

        update_settings(
            {SCAN_DIAGNOSTICS_SETTING_KEY: True},
            db=self.db,
            current_user=self.user,
        )

        self.assertEqual(
            _get_user_settings(self.db, self.user.id)[SCAN_DIAGNOSTICS_SETTING_KEY],
            "true",
        )
        self.assertEqual(
            _get_user_settings(self.db, self.other_user.id)[SCAN_DIAGNOSTICS_SETTING_KEY],
            "false",
        )

    def test_test_server_default_on_keeps_an_explicit_off(self):
        with patch.dict(os.environ, {"SCAN_TRACE_DEFAULT_ON": "1"}):
            self.assertTrue(user_trace_enabled(self.db, self.user.id))
            self.assertEqual(
                _get_user_settings(self.db, self.user.id)[SCAN_DIAGNOSTICS_SETTING_KEY],
                "true",
            )

            update_settings(
                {SCAN_DIAGNOSTICS_SETTING_KEY: False},
                db=self.db,
                current_user=self.user,
            )

            self.assertFalse(user_trace_enabled(self.db, self.user.id))
            self.assertEqual(
                _get_user_settings(self.db, self.user.id)[SCAN_DIAGNOSTICS_SETTING_KEY],
                "false",
            )
            self.assertTrue(user_trace_enabled(self.db, self.other_user.id))

    def test_default_on_needs_a_trace_folder(self):
        with patch.dict(os.environ, {"SCAN_TRACE_DEFAULT_ON": "1", "SCAN_TRACE_DIR": ""}):
            self.assertFalse(user_trace_enabled(self.db, self.user.id))

    def test_enabled_trace_is_scoped_to_the_user_and_contains_analysis_data(self):
        self._enable(self.user)
        Path(self.temp_dir.name).chmod(0o755)
        trace = create_scan_trace(
            self.db,
            self.user.id,
            mode="single",
            job_id=10,
            item_id=20,
            provider="gemini",
            model="gemini-test",
        )
        trace.set_image(b"sanitized-photo")
        trace.record_extraction(
            prompt="generic prompt",
            raw_response='{"name":"Pikachu"}',
            parsed={"name": "Pikachu", "number_local": "25"},
        )
        trace.record_candidates(
            [{"tcg_card_id": "base1-58", "name": "Pikachu", "number": "58"}],
            lambda _card: (1, 0),
        )
        trace.record_decision("number_metadata", "base1-58")

        path = trace.save()

        self.assertIsNotNone(path)
        self.assertEqual(path.parent.parent.name, f"user-{self.user.id}")
        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(payload["provider"], "gemini")
        self.assertEqual(payload["decision"]["selected"], "base1-58")
        self.assertEqual(payload["candidates"][0]["rank_key"], [1, 0])
        self.assertNotIn("api_key", json.dumps(payload).lower())
        self.assertTrue(path.with_suffix(".jpg").is_file())
        self.assertEqual(
            stat.S_IMODE(Path(self.temp_dir.name).stat().st_mode),
            0o700,
        )
        self.assertEqual(stat.S_IMODE(path.parent.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.with_suffix(".jpg").stat().st_mode), 0o600)

    def test_errors_are_redacted_before_persistence(self):
        self._enable(self.user)
        trace = create_scan_trace(self.db, self.user.id, mode="single")
        trace.record_error(
            "request failed?key=AIza123456789012345678901234567890 "
            "Authorization: Bearer eyJheader.eyJpayload.signature "
            "bot 123456789:abcdefghijklmnopqrstuvwxyzABCDE"
        )

        path = trace.save()
        payload = json.loads(path.read_text(encoding="utf-8"))

        self.assertNotIn("AIza", payload["error"])
        self.assertNotIn("eyJheader", payload["error"])
        self.assertNotIn("123456789:", payload["error"])
        self.assertIn("[REDACTED", payload["error"])

    def test_arbitrary_key_is_redacted_from_successful_provider_data(self):
        self._enable(self.user)
        secret = "local-provider-key-with-no-known-prefix"
        trace = create_scan_trace(self.db, self.user.id, mode="single")
        trace.add_secret(secret)
        trace.record_extraction(
            raw_response=f'{{"echo":"{secret}"}}',
            parsed={"nested": [secret]},
            usage={"provider": {"credential": secret}},
        )
        trace.record_visual_verification(
            raw_response=f"selected using {secret}", selected=1
        )

        path = trace.save()
        saved = path.read_text(encoding="utf-8")

        self.assertNotIn(secret, saved)
        self.assertGreaterEqual(saved.count("[REDACTED_API_KEY]"), 4)

    def test_ground_truth_labels_all_attempts_for_one_item(self):
        self._enable(self.user)
        for selected in ("wrong-card", "right-card", None):
            trace = create_scan_trace(
                self.db,
                self.user.id,
                mode="single",
                job_id=7,
                item_id=9,
            )
            trace.record_candidates(
                [
                    {"tcg_card_id": selected},
                    {"tcg_card_id": "right-card"},
                ]
            )
            trace.record_decision("test" if selected else "abstained", selected)
            trace.save()

        self.assertEqual(record_ground_truth(self.user.id, 7, 9, "right-card"), 3)
        payload_paths = list(
            Path(self.temp_dir.name).glob(
                f"user-{self.user.id}/*/job7-item9-*.json"
            )
        )
        payloads = [
            json.loads(path.read_text(encoding="utf-8"))
            for path in payload_paths
        ]
        self.assertEqual({payload["ground_truth"] for payload in payloads}, {"right-card"})
        self.assertEqual(
            sorted((payload["correct"] for payload in payloads), key=str),
            [False, None, True],
        )
        self.assertTrue(
            all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in payload_paths)
        )

    def _traced(self, job, item, selected, candidates, mechanism="test"):
        trace = create_scan_trace(self.db, self.user.id, mode="single", job_id=job, item_id=item)
        trace.record_candidates([{"tcg_card_id": c} for c in candidates])
        trace.record_decision(mechanism if selected else "abstained", selected)
        trace.save()

    def _confirmation(self, job, item):
        path = next(Path(self.temp_dir.name).glob(f"user-{self.user.id}/*/job{job}-item{item}-*.json"))
        return json.loads(path.read_text(encoding="utf-8"))["confirmation"]["source"]

    def test_confirmation_source_tells_how_the_card_was_chosen(self):
        self._enable(self.user)
        self._traced(1, 1, "a", ["a", "b"])
        self._traced(2, 2, "a", ["a", "b"])
        self._traced(3, 3, "a", ["a", "b"], mechanism="matcher")
        self._traced(4, 4, None, [])
        self._traced(5, 5, None, [])
        record_ground_truth(self.user.id, 1, 1, "a")
        record_ground_truth(self.user.id, 2, 2, "b")
        record_ground_truth(self.user.id, 3, 3, "b")
        record_ground_truth(self.user.id, 4, 4, "z", manual=True, had_matches=True, lang="en")
        record_ground_truth(self.user.id, 5, 5, "z", manual=True, had_matches=False, lang="en")
        self.assertEqual(
            [self._confirmation(n, n) for n in range(1, 6)],
            ["scanner_decision", "ollama_candidate", "matcher_candidate", "manual_search", "manual_no_result"],
        )

    def test_manual_trace_keeps_the_photo_and_the_answer_when_nothing_was_recorded(self):
        self._enable(self.user)
        from services.scan_trace import record_manual_trace

        self.assertTrue(record_manual_trace(self.db, self.user.id, 8, 8, "z", image_bytes=b"\xff\xd8jpeg", lang="en"))
        path = next(Path(self.temp_dir.name).glob(f"user-{self.user.id}/*/job8-item8-*.json"))
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["ground_truth"], "z")
        self.assertEqual(data["confirmation"], {"source": "manual_no_result", "lang": "en"})
        self.assertTrue((path.parent / data["image_file"]).is_file())

    def test_lab_counts_how_confirmed_cards_were_chosen(self):
        self._enable(self.user)
        from services.card_match import shadow as shadow_module
        from services.scan_trace import record_manual_trace

        self._traced(1, 1, 'a', ['a', 'b'])
        self._traced(2, 2, 'a', ['a', 'b'])
        self._traced(3, 3, None, ['b'])
        record_ground_truth(self.user.id, 1, 1, 'a')
        record_ground_truth(self.user.id, 2, 2, 'b')
        record_ground_truth(self.user.id, 3, 3, 'z', manual=True, had_matches=True, lang='en')
        record_manual_trace(self.db, self.user.id, 4, 4, 'y', image_bytes=b'x', lang='en')
        self._traced(5, 5, 'a', ['a'])  # never confirmed: not counted
        report = shadow_module.how_confirmed(Path(self.temp_dir.name))
        self.assertEqual(report['counts'], {
            'scanner_decision': 1, 'matcher_candidate': 0, 'ollama_candidate': 1,
            'manual_search': 1, 'manual_no_result': 1,
        })
        self.assertEqual((report['total'], report['manual'], report['manual_pct']), (4, 2, 50.0))

    def test_manual_trace_is_not_written_without_consent(self):
        from services.scan_trace import record_manual_trace

        with patch("services.scan_trace.user_trace_enabled", return_value=False):
            self.assertFalse(record_manual_trace(self.db, self.user.id, 9, 9, "z", image_bytes=b"x"))

    def test_delete_removes_only_the_requesting_users_trace_tree(self):
        self._enable(self.user)
        self._enable(self.other_user)
        for owner in (self.user, self.other_user):
            trace = create_scan_trace(self.db, owner.id, mode="single")
            trace.set_image(b"photo")
            trace.save()

        deleted = delete_user_traces(self.user.id)

        self.assertEqual(deleted, {"traces": 1, "images": 1})
        self.assertFalse((Path(self.temp_dir.name) / f"user-{self.user.id}").exists())
        self.assertTrue((Path(self.temp_dir.name) / f"user-{self.other_user.id}").exists())

    def test_delete_remains_available_when_new_collection_is_disabled(self):
        self._enable(self.user)
        trace = create_scan_trace(self.db, self.user.id, mode="single")
        trace.save()

        with patch.dict(os.environ, {"SCAN_TRACE_DIR": ""}):
            self.assertFalse(trace_available())
            self.assertTrue(trace_deletion_available())
            deleted = delete_user_traces(self.user.id)

        self.assertEqual(deleted, {"traces": 1, "images": 0})
        self.assertFalse((Path(self.temp_dir.name) / f"user-{self.user.id}").exists())

    def test_account_revocation_blocks_an_inflight_trace_from_reappearing(self):
        self._enable(self.user)
        inflight = create_scan_trace(self.db, self.user.id, mode="single")
        existing = create_scan_trace(self.db, self.user.id, mode="single")
        existing.save()

        deleted = revoke_user_traces(self.user.id)

        self.assertEqual(deleted, {"traces": 1, "images": 0})
        self.assertIsNone(inflight.save())
        self.assertFalse((Path(self.temp_dir.name) / f"user-{self.user.id}").exists())
        marker = Path(self.temp_dir.name) / f".revoked-user-{self.user.id}"
        self.assertTrue(marker.is_file())
        self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o600)

    def test_turning_setting_off_keeps_existing_files_and_stops_new_traces(self):
        self._enable(self.user)
        existing = create_scan_trace(self.db, self.user.id, mode="single")
        existing.save()
        row = self.db.query(UserSetting).filter(
            UserSetting.user_id == self.user.id,
            UserSetting.key == SCAN_DIAGNOSTICS_SETTING_KEY,
        ).one()
        row.value = "false"
        self.db.commit()

        future = create_scan_trace(self.db, self.user.id, mode="single")

        self.assertFalse(future.enabled)
        self.assertIsNone(future.save())
        self.assertEqual(
            len(list(Path(self.temp_dir.name).glob(f"user-{self.user.id}/*/*.json"))),
            1,
        )


if __name__ == "__main__":
    unittest.main()
