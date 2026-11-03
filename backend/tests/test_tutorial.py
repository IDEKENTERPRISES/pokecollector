import datetime
import unittest

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.auth import clear_tutorial, get_me, set_tutorial
    from database import Base
    from models import User

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class TutorialTests(unittest.TestCase):
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

    def test_a_new_account_has_not_done_the_tour(self):
        me = get_me(current_user=self.user)
        self.assertIsNone(me["tutorial_completed_at"])
        self.assertIsNone(me["tutorial_outcome"])

    def test_finishing_is_stored_and_returned_by_me(self):
        result = set_tutorial({"outcome": "finished"}, current_user=self.user, db=self.db)
        self.assertEqual(result["tutorial_outcome"], "finished")
        self.assertIsNotNone(result["tutorial_completed_at"])
        me = get_me(current_user=self.user)
        self.assertEqual(me["tutorial_outcome"], "finished")
        self.assertEqual(me["tutorial_completed_at"], result["tutorial_completed_at"])

    def test_every_outcome_is_accepted_and_others_are_not(self):
        for outcome in ("finished", "skipped", "dismissed"):
            clear_tutorial(current_user=self.user, db=self.db)
            self.assertEqual(
                set_tutorial({"outcome": outcome}, current_user=self.user, db=self.db)["tutorial_outcome"], outcome
            )
        for bad in (None, "", "done", "FINISHED"):
            with self.assertRaises(HTTPException) as exc:
                set_tutorial({"outcome": bad}, current_user=self.user, db=self.db)
            self.assertEqual(exc.exception.status_code, 400)

    def test_the_earliest_completion_wins_when_two_devices_finish(self):
        set_tutorial(
            {"outcome": "skipped", "completed_at": "2026-10-31T09:00:00Z"}, current_user=self.user, db=self.db
        )
        later = set_tutorial(
            {"outcome": "finished", "completed_at": "2026-10-31T10:00:00Z"}, current_user=self.user, db=self.db
        )
        self.assertEqual(later["tutorial_outcome"], "skipped")
        self.assertTrue(later["tutorial_completed_at"].startswith("2026-10-31T09:00:00"))
        earlier = set_tutorial(
            {"outcome": "finished", "completed_at": "2026-10-31T08:00:00Z"}, current_user=self.user, db=self.db
        )
        self.assertEqual(earlier["tutorial_outcome"], "finished")
        self.assertTrue(earlier["tutorial_completed_at"].startswith("2026-10-31T08:00:00"))

    def test_a_completion_time_in_the_future_is_capped_at_now(self):
        future = (datetime.datetime.utcnow() + datetime.timedelta(days=3)).isoformat()
        result = set_tutorial({"outcome": "finished", "completed_at": future}, current_user=self.user, db=self.db)
        stored = datetime.datetime.fromisoformat(result["tutorial_completed_at"])
        self.assertLess(stored, datetime.datetime.utcnow() + datetime.timedelta(seconds=5))

    def test_a_bad_date_is_rejected(self):
        with self.assertRaises(HTTPException) as exc:
            set_tutorial({"outcome": "finished", "completed_at": "yesterday"}, current_user=self.user, db=self.db)
        self.assertEqual(exc.exception.status_code, 400)
        self.assertIsNone(self.user.tutorial_completed_at)

    def test_show_the_tour_again_clears_it(self):
        set_tutorial({"outcome": "finished"}, current_user=self.user, db=self.db)
        result = clear_tutorial(current_user=self.user, db=self.db)
        self.assertEqual(result, {"tutorial_completed_at": None, "tutorial_outcome": None})
        self.db.refresh(self.user)
        self.assertIsNone(self.user.tutorial_completed_at)
        # and it can be completed again afterwards
        self.assertEqual(
            set_tutorial({"outcome": "skipped"}, current_user=self.user, db=self.db)["tutorial_outcome"], "skipped"
        )


if __name__ == "__main__":
    unittest.main()
