import inspect
import unittest

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import database
    from api.auth import get_me, set_whats_new_seen
    from database import Base
    from models import User

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class WhatsNewSeenTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.db.add(self.user)
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def test_new_account_has_no_seen_id_and_me_returns_it(self):
        self.assertIsNone(get_me(current_user=self.user)["whats_new_seen"])

    def test_sets_and_returns_the_id_in_the_current_user_payload(self):
        result = set_whats_new_seen({"id": "2026-10-30"}, current_user=self.user, db=self.db)
        self.assertEqual(result, {"whats_new_seen": "2026-10-30"})
        self.db.refresh(self.user)
        self.assertEqual(get_me(current_user=self.user)["whats_new_seen"], "2026-10-30")

    def test_accepts_a_same_day_suffix(self):
        set_whats_new_seen({"id": "2026-11-04.2"}, current_user=self.user, db=self.db)
        self.assertEqual(self.user.whats_new_seen, "2026-11-04.2")

    def test_only_moves_forward(self):
        set_whats_new_seen({"id": "2026-10-30"}, current_user=self.user, db=self.db)
        result = set_whats_new_seen({"id": "2026-10-29"}, current_user=self.user, db=self.db)
        self.assertEqual(result["whats_new_seen"], "2026-10-30")

    def test_a_since_marker_is_replaced_by_a_real_id(self):
        self.user.whats_new_seen = "since:2026-10-25"
        self.db.commit()
        set_whats_new_seen({"id": "2026-10-20"}, current_user=self.user, db=self.db)
        self.assertEqual(self.user.whats_new_seen, "2026-10-20")

    def test_rejects_bad_ids(self):
        for bad in (None, 5, "", "since:2026-10-25", "latest", "2026-10-30; drop", "2026-10-30" * 4):
            with self.assertRaises(HTTPException) as exc:
                set_whats_new_seen({"id": bad}, current_user=self.user, db=self.db)
            self.assertEqual(exc.exception.status_code, 400)

    def test_migration_adds_the_column_and_backfills_a_marker(self):
        source = inspect.getsource(database._run_migrations)
        self.assertIn("ADD COLUMN IF NOT EXISTS whats_new_seen VARCHAR(24)", source)
        self.assertIn("ADD COLUMN whats_new_seen VARCHAR(24)", source)
        self.assertIn("'since:'", source)
        for table in ("user_daily_activity", "push_subscriptions", "user_sessions", "collection"):
            self.assertIn(f"FROM {table}", source)
        self.assertIn("2026-10-17", source)


if __name__ == "__main__":
    unittest.main()
