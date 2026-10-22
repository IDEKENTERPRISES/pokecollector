import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.recognize import get_gemini_key
    from api.settings import (
        ScannerConfigurationUpdate,
        _get_user_settings,
        _scanner_configuration,
        adopt_scanner_settings_for_everyone,
        get_setting,
        set_setting,
        test_scanner_configuration as run_scanner_configuration_test,
        update_scanner_configuration,
        update_settings,
    )
    from api.scan_jobs import _item_payload
    from database import Base
    from models import AuditLog, ScanJob, ScanJobItem, Setting, User, UserSetting
    from services.scan_providers import (
        GEMINI,
        OPENAI,
        ScanProvider,
        enabled_providers,
        gemini_fallback_enabled,
        NEUTRAL_SCAN_ERROR,
        get_provider,
        resolve_model,
        resolve_provider_name,
        resolve_scanner_request_timeout,
        scanner_capability_mode,
    )
    DEPS = True
except ModuleNotFoundError:
    DEPS = False

GLOBAL = {"SCANNER_GLOBAL_CONFIG": "true", "OPENAI_SCANNER_ENABLED": "true", "OPENAI_ALLOWED_MODELS": "vision-fast"}
OPENAI_ENV = {"OPENAI_SCANNER_ENABLED": "true", "OPENAI_API_KEY_REQUIRED": "true"}


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class ScannerGlobalConfigTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.admin = User(username="admin", hashed_password="x", role="admin", is_active=True)
        self.member = User(username="member", hashed_password="x", role="user", is_active=True)
        self.db.add_all([self.admin, self.member])
        self.db.commit()
        for name in ("SCANNER_GLOBAL_CONFIG", "GEMINI_SCANNER_ENABLED", "OPENAI_SCANNER_ENABLED"):
            patcher = patch.dict(os.environ, {})
            patcher.start()
            self.addCleanup(patcher.stop)
            os.environ.pop(name, None)

    def tearDown(self):
        self.db.close()

    def _user_row(self, user, key, value):
        self.db.add(UserSetting(user_id=user.id, key=key, value=value))
        self.db.commit()

    def _global_row(self, key, value):
        self.db.add(Setting(key=f"scanner_global.{key}", value=value))
        self.db.commit()

    def _save_global_openai(self, **extra):
        request = ScannerConfigurationUpdate(
            provider="openai", model="vision-fast", api_key="sk-secret-1234", save_on_success=True, **extra
        )
        with patch.object(
            ScanProvider, "generate_text", new=AsyncMock(return_value=("MAGENTA-GREEN", None))
        ):
            return asyncio.run(run_scanner_configuration_test(request, self.db, self.admin))

    # ---- per-user mode is unchanged ---------------------------------------------------------

    def test_per_user_mode_keeps_reading_the_users_own_rows(self):
        self._user_row(self.member, "scanner_provider", "openai")
        self._user_row(self.member, "scanner_model_openai", "mine")
        self._user_row(self.member, "scanner_request_timeout_openai", "120")
        self._user_row(self.admin, "scanner_provider", "gemini")
        with patch.dict(os.environ, {**OPENAI_ENV, "OPENAI_ALLOWED_MODELS": "mine"}):
            self.assertEqual(resolve_provider_name(self.db, self.member.id), OPENAI)
            self.assertEqual(resolve_provider_name(self.db, self.admin.id), GEMINI)
            self.assertEqual(resolve_model(self.db, self.member.id, OPENAI), "mine")
            self.assertEqual(resolve_scanner_request_timeout(self.db, self.member.id, OPENAI), 120)
            config = _scanner_configuration(self.db, self.member.id)
        self.assertEqual(config["scope"], "user")
        self.assertTrue(config["editable"])

    # ---- global mode resolution -------------------------------------------------------------

    def test_global_mode_resolves_every_scanner_setting_from_the_global_rows(self):
        self._user_row(self.member, "scanner_provider", "gemini")
        self._user_row(self.member, "scanner_request_timeout_openai", "30")
        self._user_row(self.member, "gemini_api_key", "personal-gemini")
        for key, value in {
            "scanner_provider": "openai",
            "scanner_model_openai": "shared-model",
            "scanner_request_timeout_openai": "180",
            "scanner_gemini_fallback": "true",
            "openai_api_key": "global-openai-key",
            "gemini_api_key": "global-gemini-key",
        }.items():
            self._global_row(key, value)
        with patch.dict(os.environ, {**GLOBAL, "OPENAI_ALLOWED_MODELS": "shared-model"}):
            self.assertEqual(resolve_provider_name(self.db, self.member.id), OPENAI)
            self.assertEqual(resolve_model(self.db, self.member.id, OPENAI), "shared-model")
            self.assertEqual(resolve_scanner_request_timeout(self.db, self.member.id, OPENAI), 180)
            self.assertTrue(gemini_fallback_enabled(self.db, self.member.id))
            self.assertEqual(get_gemini_key(self.db, self.member.id), "global-gemini-key")
            provider = get_provider(self.db, self.member.id)
            self.assertEqual(provider.credential(self.db, self.member.id), "global-openai-key")
            self.assertEqual(provider.name, OPENAI)

    def test_global_capability_proof_applies_to_every_user(self):
        env = {**GLOBAL, "OPENAI_API_KEY_REQUIRED": "true"}
        with patch.dict(os.environ, env):
            self._save_global_openai()
            self.assertEqual(scanner_capability_mode(self.db, self.member.id, OPENAI, "vision-fast"), "full")
            self.assertIsNone(scanner_capability_mode(self.db, self.member.id, OPENAI, "other-model"))

    def test_per_user_key_is_not_used_in_global_mode(self):
        self._user_row(self.member, "gemini_api_key", "personal-gemini")
        with patch.dict(os.environ, GLOBAL):
            self.assertEqual(get_gemini_key(self.db, self.member.id), "")

    def test_global_admin_custom_model_is_honoured_for_everyone(self):
        self._global_row("scanner_provider", "openai")
        self._global_row("scanner_model_openai", "bespoke-model")
        self._global_row("scanner_custom_model_openai", "bespoke-model")
        with patch.dict(os.environ, GLOBAL):
            self.assertEqual(resolve_model(self.db, self.member.id, OPENAI), "bespoke-model")

    # ---- admin only, secrets, audit ---------------------------------------------------------

    def test_non_admin_cannot_write_the_global_config(self):
        request = ScannerConfigurationUpdate(provider="gemini", model="x", clear_api_key=True)
        with patch.dict(os.environ, GLOBAL):
            with self.assertRaises(HTTPException) as put_error:
                update_scanner_configuration(request, self.db, self.member)
            with self.assertRaises(HTTPException) as test_error:
                asyncio.run(run_scanner_configuration_test(request, self.db, self.member))
            with self.assertRaises(HTTPException) as fallback_error:
                update_settings({"scanner_gemini_fallback": "true"}, self.db, self.member)
            with self.assertRaises(HTTPException) as fallback_post_error:
                set_setting("scanner_gemini_fallback", {"value": "true"}, self.db, self.member)
            with self.assertRaises(HTTPException) as adopt_error:
                adopt_scanner_settings_for_everyone(self.db, self.member)
        for error in (put_error, test_error, fallback_error, fallback_post_error, adopt_error):
            self.assertEqual(error.exception.status_code, 403)
        self.assertEqual(self.db.query(Setting).count(), 0)

    def test_admin_save_writes_global_rows_audits_and_never_returns_the_key(self):
        with patch.dict(os.environ, {**GLOBAL, "OPENAI_API_KEY_REQUIRED": "true"}):
            result = self._save_global_openai()
            admin_view = _scanner_configuration(self.db, self.admin.id, is_admin=True)
            member_view = _scanner_configuration(self.db, self.member.id)
        self.assertTrue(result["saved"])
        stored = {row.key: row.value for row in self.db.query(Setting)}
        self.assertEqual(stored["scanner_global.scanner_provider"], "openai")
        self.assertEqual(stored["scanner_global.openai_api_key"], "sk-secret-1234")
        self.assertEqual(self.db.query(UserSetting).count(), 0)
        openai = next(item for item in admin_view["providers"] if item["id"] == "openai")
        self.assertEqual(openai["api_key_hint"], "••1234")
        for payload in (result, admin_view, member_view):
            self.assertNotIn("sk-secret-1234", json.dumps(payload))
        # A user who is not an administrator gets no scanner configuration at all.
        self.assertEqual(
            set(member_view),
            {"scope", "editable", "scanning_available", "visual_verification"},
        )
        self.assertFalse(member_view["editable"])
        self.assertTrue(member_view["scanning_available"])
        self.assertNotIn("openai", json.dumps(member_view).lower())
        self.assertNotIn("vision-fast", json.dumps(member_view))
        audit = self.db.query(AuditLog).filter(AuditLog.action == "scanner.config.updated").one()
        self.assertEqual(audit.actor_user_id, self.admin.id)
        self.assertNotIn("sk-secret", audit.details)
        self.assertIn('"provider": "openai"', audit.details)

    def test_per_user_mode_does_not_audit_or_use_global_rows(self):
        with patch.dict(os.environ, {"OPENAI_SCANNER_ENABLED": "true", "OPENAI_API_KEY_REQUIRED": "true", "OPENAI_ALLOWED_MODELS": "vision-fast"}):
            self._save_global_openai()
        self.assertEqual(self.db.query(Setting).count(), 0)
        self.assertEqual(self.db.query(AuditLog).count(), 0)
        self.assertEqual(
            self.db.query(UserSetting).filter(UserSetting.key == "scanner_provider").one().user_id,
            self.admin.id,
        )

    def test_global_fallback_toggle_is_admin_only_audited_and_shared(self):
        with patch.dict(os.environ, GLOBAL):
            update_settings({"scanner_gemini_fallback": "true"}, self.db, self.admin)
            self.assertTrue(gemini_fallback_enabled(self.db, self.member.id))
            self.assertNotIn("scanner_gemini_fallback", _get_user_settings(self.db, self.member.id))
            self.assertEqual(_get_user_settings(self.db, self.admin.id)["scanner_gemini_fallback"], "true")
        self.assertEqual(self.db.query(AuditLog).filter(AuditLog.action == "scanner.config.updated").count(), 1)

    # ---- members see nothing of the scanner setup in global mode ---------------------------------

    def test_settings_response_for_a_member_has_no_scanner_fields(self):
        self._global_row("scanner_gemini_fallback", "true")
        self._user_row(self.member, "scan_diagnostics", "true")
        with patch.dict(os.environ, GLOBAL):
            member = _get_user_settings(self.db, self.member.id)
            admin = _get_user_settings(self.db, self.admin.id)
        self.assertNotIn("scanner_gemini_fallback", member)
        self.assertEqual(admin["scanner_gemini_fallback"], "true")
        for key in member:
            self.assertFalse(key.startswith("scanner_") or key.endswith("_api_key"), key)

    def test_a_member_cannot_read_or_write_any_scanner_key_in_global_mode(self):
        with patch.dict(os.environ, GLOBAL):
            for key in (
                "scanner_provider", "scanner_model_openai", "openai_api_key", "gemini_api_key",
                "scanner_request_timeout_openai", "scanner_capability_openai",
                "scanner_custom_model_openai", "scanner_gemini_fallback",
            ):
                with self.assertRaises(HTTPException) as put_error:
                    update_settings({key: "x"}, self.db, self.member)
                with self.assertRaises(HTTPException) as post_error:
                    set_setting(key, {"value": "x"}, self.db, self.member)
                with self.assertRaises(HTTPException) as get_error:
                    get_setting(key, self.db, self.member)
                for error in (put_error, post_error, get_error):
                    self.assertEqual(error.exception.status_code, 403, key)
        self.assertEqual(self.db.query(UserSetting).count(), 0)

    def test_per_user_mode_still_refuses_scanner_keys_on_the_generic_endpoints_with_409(self):
        with self.assertRaises(HTTPException) as error:
            update_settings({"scanner_provider": "gemini"}, self.db, self.member)
        self.assertEqual(error.exception.status_code, 409)

    def test_config_errors_are_neutral_for_a_member_and_detailed_for_an_admin(self):
        env = {**GLOBAL, "GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "true"}
        self._global_row("scanner_provider", "gemini")
        with patch.dict(os.environ, env):
            with self.assertRaises(HTTPException) as member_error:
                get_provider(self.db, self.member.id)
            with self.assertRaises(HTTPException) as admin_error:
                get_provider(self.db, self.admin.id)
        self.assertEqual(member_error.exception.status_code, 409)
        self.assertEqual(member_error.exception.detail, NEUTRAL_SCAN_ERROR)
        self.assertIn("no longer enabled", admin_error.exception.detail)
        self.assertIn("Scanner Settings", admin_error.exception.detail)

    def test_nothing_enabled_is_neutral_for_a_member(self):
        env = {**GLOBAL, "GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "false"}
        with patch.dict(os.environ, env):
            with self.assertRaises(HTTPException) as member_error:
                get_provider(self.db, self.member.id)
            config = _scanner_configuration(self.db, self.member.id)
        self.assertEqual(member_error.exception.detail, NEUTRAL_SCAN_ERROR)
        self.assertFalse(config["scanning_available"])
        self.assertNotIn("providers", config)

    def test_stored_item_errors_and_provider_names_are_hidden_from_a_member_only(self):
        job = ScanJob(user_id=self.member.id, expires_at=__import__("datetime").datetime(2030, 1, 1))
        self.db.add(job)
        self.db.commit()
        item = ScanJobItem(
            job_id=job.id, user_id=self.member.id, position=0, byte_size=1, status="failed",
            error="The OpenAI API key was rejected. Please check it in Settings.",
            recognized={"name": "Bill", "_gemini_fallback_used": True},
        )
        photo_problem = ScanJobItem(
            job_id=job.id, user_id=self.member.id, position=1, byte_size=1, status="failed",
            error="The image could not be read.",
        )
        self.db.add_all([item, photo_problem])
        self.db.commit()
        with patch.dict(os.environ, GLOBAL):
            hidden = _item_payload(item)
            plain = _item_payload(photo_problem)
            job.user_id = self.admin.id
            self.db.commit()
            shown = _item_payload(item)
        self.assertEqual(hidden["error"], NEUTRAL_SCAN_ERROR)
        self.assertEqual(hidden["recognized"], {"name": "Bill"})
        self.assertEqual(plain["error"], "The image could not be read.")
        self.assertIn("OpenAI API key", shown["error"])
        self.assertTrue(shown["recognized"]["_gemini_fallback_used"])

    def test_per_user_mode_keeps_detailed_errors_for_everyone(self):
        env = {"GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "true"}
        self._user_row(self.member, "scanner_provider", "gemini")
        with patch.dict(os.environ, env):
            with self.assertRaises(HTTPException) as error:
                get_provider(self.db, self.member.id)
        self.assertIn("no longer enabled", error.exception.detail)

    # ---- copy my settings -------------------------------------------------------------------

    def test_admin_can_copy_their_settings_once(self):
        for key, value in {
            "scanner_provider": "openai",
            "scanner_model_openai": "vision-fast",
            "openai_api_key": "sk-copy-9999",
            "scanner_capability_openai": "{}",
        }.items():
            self._user_row(self.admin, key, value)
        with patch.dict(os.environ, {**GLOBAL, "OPENAI_API_KEY_REQUIRED": "true"}):
            result = adopt_scanner_settings_for_everyone(self.db, self.admin)
            self.assertEqual(result["provider"], "openai")
            self.assertEqual(get_provider(self.db, self.member.id).credential(self.db, self.member.id), "sk-copy-9999")
            self.assertNotIn("sk-copy-9999", json.dumps(result))
            with self.assertRaises(HTTPException) as again:
                adopt_scanner_settings_for_everyone(self.db, self.admin)
        self.assertEqual(again.exception.status_code, 409)
        self.assertEqual(self.db.query(AuditLog).filter(AuditLog.action == "scanner.config.updated").count(), 1)

    def test_copy_needs_global_mode_and_a_usable_provider(self):
        with self.assertRaises(HTTPException) as off:
            adopt_scanner_settings_for_everyone(self.db, self.admin)
        self.assertEqual(off.exception.status_code, 409)
        with patch.dict(os.environ, GLOBAL):
            with self.assertRaises(HTTPException) as empty:
                adopt_scanner_settings_for_everyone(self.db, self.admin)
        self.assertEqual(empty.exception.status_code, 409)


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class GeminiDisabledTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="admin", hashed_password="x", role="admin", is_active=True)
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _row(self, key, value):
        self.db.add(UserSetting(user_id=self.user.id, key=key, value=value))
        self.db.commit()

    def test_gemini_is_dropped_from_the_provider_list(self):
        with patch.dict(os.environ, {"GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "true"}):
            self.assertEqual(enabled_providers(), (OPENAI,))
            config = _scanner_configuration(self.db, self.user.id, is_admin=True)
        self.assertEqual([item["id"] for item in config["providers"]], ["openai"])
        self.assertFalse(config["gemini_enabled"])
        gemini = next(item for item in config["administrator"]["providers"] if item["id"] == "gemini")
        self.assertFalse(gemini["enabled"])

    def test_default_provider_falls_to_openai(self):
        with patch.dict(os.environ, {"GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "true"}):
            self.assertEqual(resolve_provider_name(self.db, self.user.id), OPENAI)
            self.assertEqual(resolve_provider_name(self.db, self.user.id, require_enabled=True), OPENAI)

    def test_gemini_fallback_is_off_even_when_opted_in(self):
        self._row("scanner_gemini_fallback", "true")
        self._row("scanner_provider", "openai")
        with patch.dict(os.environ, {"OPENAI_SCANNER_ENABLED": "true"}):
            self.assertTrue(gemini_fallback_enabled(self.db, self.user.id))
        with patch.dict(os.environ, {"GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "true"}):
            self.assertFalse(gemini_fallback_enabled(self.db, self.user.id))
            self.assertEqual(_get_user_settings(self.db, self.user.id)["scanner_gemini_fallback"], "false")

    def test_fallback_cannot_be_turned_on_without_gemini(self):
        with patch.dict(os.environ, {"GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "true"}):
            update_settings({"scanner_gemini_fallback": "true"}, self.db, self.user)
            self.assertEqual(_get_user_settings(self.db, self.user.id)["scanner_gemini_fallback"], "false")

    def test_a_stored_gemini_choice_fails_closed(self):
        self._row("scanner_provider", "gemini")
        with patch.dict(os.environ, {"GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "true"}):
            with self.assertRaises(HTTPException) as error:
                get_provider(self.db, self.user.id)
        self.assertEqual(error.exception.status_code, 409)
        self.assertIn("no longer enabled", error.exception.detail)

    def test_a_global_gemini_choice_fails_closed_too(self):
        self.db.add(Setting(key="scanner_global.scanner_provider", value="gemini"))
        self.db.commit()
        env = {"SCANNER_GLOBAL_CONFIG": "true", "GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "true"}
        with patch.dict(os.environ, env):
            with self.assertRaises(HTTPException) as error:
                get_provider(self.db, self.user.id)
        self.assertEqual(error.exception.status_code, 409)

    def test_no_provider_at_all_says_scanning_is_not_set_up(self):
        env = {"GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "false"}
        with patch.dict(os.environ, env):
            with self.assertRaises(HTTPException) as error:
                get_provider(self.db, self.user.id)
            config = _scanner_configuration(self.db, self.user.id, is_admin=True)
        self.assertEqual(error.exception.status_code, 409)
        self.assertIn("Scanning isn't set up", error.exception.detail)
        self.assertEqual(config["status"], "unavailable")
        self.assertEqual(config["providers"], [])
        self.assertIn("administrator", config)

    def test_saving_gemini_is_refused_when_disabled(self):
        request = ScannerConfigurationUpdate(provider="gemini", model="x", api_key="k", save_on_success=True)
        with patch.dict(os.environ, {"GEMINI_SCANNER_ENABLED": "false", "OPENAI_SCANNER_ENABLED": "true"}):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(run_scanner_configuration_test(request, self.db, self.user))
        self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
