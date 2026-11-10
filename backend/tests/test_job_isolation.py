"""One trainer's error in a scheduler job must only undo that trainer's own work."""
import datetime
import unittest
from unittest.mock import patch

try:
    from models import ChallengeProgress, NotificationQueue, Set, User, UserSetting, UserXpLedger, WishlistItem
    from services import challenge, recap
    from services import notifications as n
    from services.progress import xp
    from test_challenge import ChallengeBase, MON_W44_0005
    from test_notifications import NOON_UTC, NotificationTestCase, _card, _user
    from test_progress import ProgressTestBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    ChallengeBase = ProgressTestBase = NotificationTestCase = object

SUNDAY_1800 = datetime.datetime(2026, 11, 1, 18, 0)
WRAPPED_OPEN = datetime.datetime(2026, 12, 1, 10, 0)


def _failing_for(bad_id, ok, position=1):
    """Raises when the argument at `position` is `bad_id`, otherwise calls through to `ok`."""
    def run(*args, **kwargs):
        if args[position] == bad_id:
            raise RuntimeError("boom")
        return ok(*args, **kwargs)
    return run


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class TrainerLoopTests(ProgressTestBase):
    """Three trainers (ash, misty, brock); the middle one raises."""

    def setUp(self):
        super().setUp()
        self.third = User(username="brock", hashed_password="x", role="trainer", is_active=True)
        self.db.add(self.third)
        self.db.commit()
        self.trainers = [self.user, self.other, self.third]
        for u in self.trainers:
            self.db.add_all([UserSetting(user_id=u.id, key="time_zone", value="UTC"),
                             UserSetting(user_id=u.id, key="notify_weekly_recap", value="true")])
        self.db.commit()

    def queued(self, category):
        self.db.expire_all()
        return sorted(r.user_id for r in self.db.query(NotificationQueue).filter_by(category=category))

    def survivors(self):
        return sorted([self.user.id, self.third.id])

    def test_weekly_recap_survivors_keep_their_rows_and_a_rerun_adds_none(self):
        fake = {"week_key": "2026-W44", "cards_added": 1, "best_pull": None, "badges": [], "has_activity": True}
        real = recap.weekly_recap
        with patch.object(recap, "weekly_recap", side_effect=_failing_for(self.other.id, lambda *a, **k: fake)):
            with self.assertLogs("services.job_isolation", "ERROR") as logs:
                self.assertEqual(recap.queue_weekly_recaps(self.db, SUNDAY_1800), 2)
        self.assertIn(str(self.other.id), logs.output[0])
        self.assertEqual(self.queued("weekly_recap"), self.survivors())
        # The next run: the failing trainer now works and the others are not duplicated.
        with patch.object(recap, "weekly_recap", return_value=fake):
            self.assertEqual(recap.queue_weekly_recaps(self.db, SUNDAY_1800), 1)
            self.assertEqual(recap.queue_weekly_recaps(self.db, SUNDAY_1800), 0)
        self.assertEqual(self.queued("weekly_recap"), sorted(t.id for t in self.trainers))
        self.assertIs(recap.weekly_recap, real)

    def test_wrapped_ready_survivors_keep_their_rows_and_a_rerun_adds_none(self):
        data = {"totals": {"cards": 3}}

        def wrapped(db, uid, year, now=None):
            if uid == self.other.id:
                raise RuntimeError("boom")
            return data
        with patch.object(recap, "wrapped", side_effect=wrapped), \
                patch.dict("os.environ", {recap.PREVIEW_ENV: ""}):
            with self.assertLogs("services.job_isolation", "ERROR"):
                self.assertEqual(recap.queue_wrapped_ready(self.db, WRAPPED_OPEN), 2)
            self.assertEqual(self.queued("wrapped"), self.survivors())
            self.assertEqual(recap.queue_wrapped_ready(self.db, WRAPPED_OPEN), 0)
        self.assertEqual(self.queued("wrapped"), self.survivors())


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ChallengeCloseIsolationTests(ChallengeBase):
    def setUp(self):
        super().setUp()
        self.counts = {self.user.id: 3, self.other.id: 3, self.brock.id: 3}
        self.bad = self.other.id

        def count(db, uid, week):
            if uid == self.bad:
                raise RuntimeError("boom")
            return self.counts.get(uid, 0)
        patcher = patch.dict(challenge.CATALOGUE_BY_ID["binder_cards"], {"target": 2, "count": count})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.good = sorted([self.user.id, self.brock.id])

    def ledger(self):
        self.db.expire_all()
        return sorted(r.user_id for r in self.db.query(UserXpLedger).filter_by(source=xp.SOURCE_CHALLENGE))

    def test_a_failing_recount_does_not_stop_the_others_and_a_rerun_does_not_duplicate(self):
        with self.assertLogs("services.job_isolation", "ERROR") as logs:
            self.assertGreaterEqual(challenge.close_due_weeks(self.db, MON_W44_0005), 1)
        self.assertIn(str(self.bad), logs.output[0])
        self.db.expire_all()
        rows = sorted(r.user_id for r in self.db.query(ChallengeProgress).filter_by(week="2026-W43"))
        self.assertEqual(rows, self.good)
        self.assertEqual(self.ledger(), self.good)
        challenge.close_due_weeks(self.db, MON_W44_0005 + datetime.timedelta(hours=1))
        self.assertEqual(self.ledger(), self.good)

    def test_a_failing_finisher_reward_does_not_stop_the_others(self):
        self.bad = None
        week = challenge.week_by_key("2026-W43")
        with patch.object(xp, "award", side_effect=_failing_for(self.other.id, xp.award)):
            with self.assertLogs("services.job_isolation", "ERROR"):
                self.assertTrue(challenge.close_week(self.db, week, MON_W44_0005))
        self.assertEqual(self.ledger(), self.good)
        self.assertFalse(challenge.close_week(self.db, week, MON_W44_0005))
        self.assertEqual(self.ledger(), self.good)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class NotificationLoopIsolationTests(NotificationTestCase):
    def setUp(self):
        super().setUp()
        self.a, self.b, self.c = (_user(self.db, name) for name in ("ash", "misty", "brock"))
        self.survivors = sorted([self.a.id, self.c.id])
        self.everyone = sorted([self.a.id, self.b.id, self.c.id])

    def rows(self, category):
        self.db.expire_all()
        return sorted(r.user_id for r in self.db.query(NotificationQueue).filter_by(category=category))

    def test_new_sets(self):
        self.db.add(Set(id="new1_en", tcg_set_id="new1", name="Fresh", series="SV", lang="en", is_new=True))
        self.db.commit()
        with patch.object(n.telegram, "send_new_sets_notification"), \
                patch.object(n, "enqueue", side_effect=_failing_for(self.b.id, n.enqueue)):
            with self.assertLogs("services.job_isolation", "ERROR"):
                n.on_new_sets(self.db, ["new1_en"])
        self.assertEqual(self.rows("new_sets"), self.survivors)
        with patch.object(n.telegram, "send_new_sets_notification"):
            n.on_new_sets(self.db, ["new1_en"])  # the next run fills the gap without duplicating
        self.assertEqual(self.rows("new_sets"), self.everyone)

    def test_price_events(self):
        card = _card(self.db, "dipcard", price=8.0, avg30=10.0)
        for user in (self.a, self.b, self.c):
            self.db.add(WishlistItem(user_id=user.id, card_id=card.id))
        self.db.commit()
        with patch.object(n, "_price_field", side_effect=_failing_for(self.b.id, n._price_field)):
            with self.assertLogs("services.job_isolation", "ERROR"):
                self.assertEqual(n.queue_price_events(self.db, [card.id], NOON_UTC), 2)
        self.assertEqual(self.rows("wishlist_dips"), self.survivors)
        self.assertEqual(n.queue_price_events(self.db, [card.id], NOON_UTC), 1)
        self.assertEqual(self.rows("wishlist_dips"), self.everyone)

    def test_flush_keeps_the_sends_that_went_out_when_a_later_row_fails(self):
        for user in (self.a, self.b, self.c):
            n.enqueue(self.db, user.id, "goal_milestones", "goal:1", now=NOON_UTC, details={})
        self.db.commit()
        sent = []

        def send(db, user_id, payload):
            if user_id == self.b.id:
                raise RuntimeError("boom")
            sent.append(user_id)
            return None
        # `_send` runs after a row is marked sent, so a raise there is the worst case for the middle row.
        with patch.object(n, "_send", side_effect=send), patch.object(n, "_sent_reason", return_value="ok"):
            with self.assertLogs("services.notifications", "ERROR"):
                n.flush_due(self.db, NOON_UTC)
            self.assertEqual(sorted(sent), self.survivors)
            with self.assertLogs("services.notifications", "ERROR"):
                n.flush_due(self.db, NOON_UTC)  # only the failing row is retried
        self.assertEqual(sorted(sent), self.survivors)  # survivors are not pushed twice
        self.db.expire_all()
        done = sorted(r.user_id for r in self.db.query(NotificationQueue).filter(NotificationQueue.sent_at.isnot(None)))
        self.assertEqual(done, self.survivors)
