import os
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api import settings as settings_api
    from database import Base
    from models import User, UserSetting

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

from services.default_currency import default_currency


class DefaultCurrencyEnvTests(unittest.TestCase):
    def value(self, env):
        with patch.dict(os.environ, env, clear=False):
            if "DEFAULT_CURRENCY" not in env:
                os.environ.pop("DEFAULT_CURRENCY", None)
            return default_currency()

    def test_unset_is_eur(self):
        self.assertEqual(self.value({}), "EUR")

    def test_empty_is_eur(self):
        self.assertEqual(self.value({"DEFAULT_CURRENCY": "  "}), "EUR")

    def test_valid(self):
        self.assertEqual(self.value({"DEFAULT_CURRENCY": "GBP"}), "GBP")

    def test_lowercase_and_spaces(self):
        self.assertEqual(self.value({"DEFAULT_CURRENCY": " gbp "}), "GBP")

    def test_invalid_warns_and_falls_back(self):
        with self.assertLogs("services.default_currency", level="WARNING"):
            self.assertEqual(self.value({"DEFAULT_CURRENCY": "XYZ-invalid"}), "EUR")


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class DefaultCurrencySettingsTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.new_user = User(username="new", hashed_password="x", role="trainer")
        self.old_user = User(username="old", hashed_password="x", role="trainer")
        self.db.add_all([self.new_user, self.old_user])
        self.db.flush()
        self.db.add(UserSetting(user_id=self.old_user.id, key="currency", value="USD"))
        self.db.commit()
        patcher = patch.dict(os.environ, {"DEFAULT_CURRENCY": "gbp"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_new_user_gets_env_default(self):
        self.assertEqual(settings_api._get_user_settings(self.db, self.new_user.id)["currency"], "GBP")

    def test_existing_choice_is_kept(self):
        self.assertEqual(settings_api._get_user_settings(self.db, self.old_user.id)["currency"], "USD")

    def test_unset_env_gives_eur(self):
        os.environ.pop("DEFAULT_CURRENCY")
        self.assertEqual(settings_api._get_user_settings(self.db, self.new_user.id)["currency"], "EUR")


if __name__ == "__main__":
    unittest.main()
