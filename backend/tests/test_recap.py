import datetime
import json
import os
import unittest
from unittest.mock import patch

try:
    from models import (
        CollectionItem, NotificationQueue, PortfolioSnapshot, Trade, UserAchievement, UserDailyActivity,
        UserSetting,
    )
    from services import notifications, recap
    from test_progress import ProgressTestBase
    from test_small_delights import ApiBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    ProgressTestBase = ApiBase = object

# 2026-11-01 is a Sunday; the recap week is Monday 26 October to Sunday 1 November.
SUNDAY_1759 = datetime.datetime(2026, 11, 1, 17, 59)
SUNDAY_1800 = datetime.datetime(2026, 11, 1, 18, 0)
TUESDAY_2359 = datetime.datetime(2026, 11, 3, 23, 59)
WEDNESDAY = datetime.datetime(2026, 11, 4, 0, 0)
IN_WEEK = datetime.datetime(2026, 10, 28, 12, 0)


class RecapBase(ProgressTestBase):
    def zone(self, name):
        self.db.add(UserSetting(user_id=self.user.id, key="time_zone", value=name))
        self.db.commit()

    def snapshot(self, when, value):
        self.db.add(PortfolioSnapshot(user_id=self.user.id, date=when, total_value=value, total_cards=1))
        self.db.commit()

    def badge(self, achievement_id, when, backfilled=False):
        self.db.add(UserAchievement(
            user_id=self.user.id, achievement_id=achievement_id, unlocked_at=when, backfilled=backfilled))
        self.db.commit()


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class WindowTests(RecapBase):
    def test_sunday_before_18_still_covers_the_previous_week(self):
        result = recap.weekly_recap(self.db, self.user.id, SUNDAY_1759)
        self.assertEqual((result["week_start"], result["week_end"]), ("2026-10-19", "2026-10-25"))
        self.assertFalse(result["show"])

    def test_sunday_18_covers_the_week_that_is_ending(self):
        result = recap.weekly_recap(self.db, self.user.id, SUNDAY_1800)
        self.assertEqual((result["week_start"], result["week_end"]), ("2026-10-26", "2026-11-01"))
        self.assertTrue(result["show"])
        self.assertEqual(result["week_key"], "2026-W44")

    def test_it_shows_until_the_end_of_tuesday(self):
        self.assertEqual(recap.weekly_recap(self.db, self.user.id, datetime.datetime(2026, 11, 2, 9))["week_start"], "2026-10-26")
        tuesday = recap.weekly_recap(self.db, self.user.id, TUESDAY_2359)
        self.assertTrue(tuesday["show"])
        self.assertEqual(tuesday["week_start"], "2026-10-26")
        wednesday = recap.weekly_recap(self.db, self.user.id, WEDNESDAY)
        self.assertFalse(wednesday["show"])
        self.assertEqual(wednesday["week_start"], "2026-10-26")

    def test_the_window_follows_the_users_time_zone(self):
        self.zone("Australia/Sydney")  # UTC+11 on 1 November
        self.assertFalse(recap.weekly_recap(self.db, self.user.id, datetime.datetime(2026, 11, 1, 6, 59))["show"])
        self.assertTrue(recap.weekly_recap(self.db, self.user.id, datetime.datetime(2026, 11, 1, 7, 0))["show"])
        # Tuesday 23:59 UTC is already Wednesday 10:59 in Sydney.
        self.assertFalse(recap.weekly_recap(self.db, self.user.id, TUESDAY_2359)["show"])

    def test_an_empty_week_has_no_activity(self):
        result = recap.weekly_recap(self.db, self.user.id, SUNDAY_1800)
        self.assertFalse(result["has_activity"])
        self.assertEqual(result["cards_added"], 0)
        self.assertIsNone(result["best_pull"])
        self.assertIsNone(result["value"])
        self.assertEqual(result["badges"], [])


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ContentTests(RecapBase):
    def test_counts_cards_by_quantity_and_picks_the_best_pull(self):
        cheap = self.own("tst-001", acquired_at=IN_WEEK)
        cheap.quantity = 3
        self.own("big-001", added_at=IN_WEEK)  # added_at when acquired_at is empty; EUR 30
        self.own("tst-002", acquired_at=datetime.datetime(2026, 10, 20))  # the week before
        self.own("big-002", user=self.other, acquired_at=IN_WEEK)  # someone else's
        self.db.commit()
        result = recap.weekly_recap(self.db, self.user.id, SUNDAY_1800)
        self.assertEqual(result["cards_added"], 4)
        self.assertTrue(result["has_activity"])
        self.assertEqual(result["best_pull"]["card_id"], "big-001_en")
        self.assertEqual(result["best_pull"]["price"], 30.0)
        self.assertEqual(result["best_pull"]["item_id"], self.db.query(CollectionItem).filter_by(card_id="big-001_en").one().id)

    def test_acquired_at_wins_over_added_at_and_uses_local_days(self):
        # Added last week but acquired this week.
        self.own("tst-001", added_at=datetime.datetime(2026, 10, 10), acquired_at=IN_WEEK)
        # 2026-10-25 20:00 UTC is already Monday 26 October 07:00 in Sydney.
        self.zone("Australia/Sydney")
        self.own("tst-002", acquired_at=datetime.datetime(2026, 10, 25, 20, 0))
        result = recap.weekly_recap(self.db, self.user.id, datetime.datetime(2026, 11, 1, 8, 0))
        self.assertEqual(result["cards_added"], 2)

    def test_closest_set_names_how_many_are_missing(self):
        self.own("tst-001")
        result = recap.weekly_recap(self.db, self.user.id, SUNDAY_1800)
        self.assertEqual(result["closest_set"], {
            "set_id": "tst_en", "name": "Test Set", "owned": 1, "total": 2, "missing": 1})
        self.own("tst-002")  # complete now: nothing to chase in that set
        self.assertIsNone(recap.weekly_recap(self.db, self.user.id, SUNDAY_1800)["closest_set"])

    def test_value_change_compares_the_snapshot_before_the_week_with_the_last_one(self):
        self.snapshot(datetime.datetime(2026, 10, 25, 3), 100.0)
        self.snapshot(datetime.datetime(2026, 10, 29, 3), 130.0)
        self.snapshot(datetime.datetime(2026, 11, 1, 3), 110.0)
        self.snapshot(datetime.datetime(2026, 11, 2, 3), 999.0)  # after the week
        result = recap.weekly_recap(self.db, self.user.id, SUNDAY_1800)
        self.assertEqual(result["value"], {"start": 100.0, "end": 110.0, "change": 10.0, "percent": 10.0})
        self.assertTrue(result["has_activity"])

    def test_a_single_snapshot_is_not_a_change(self):
        self.snapshot(datetime.datetime(2026, 10, 29, 3), 130.0)
        self.assertIsNone(recap.weekly_recap(self.db, self.user.id, SUNDAY_1800)["value"])

    def test_badges_of_the_week_skip_backfilled_ones(self):
        self.badge("first_card", IN_WEEK)
        self.badge("collector_10", IN_WEEK, backfilled=True)
        self.badge("collector_50", datetime.datetime(2026, 10, 20))
        result = recap.weekly_recap(self.db, self.user.id, SUNDAY_1800)
        self.assertEqual([b["id"] for b in result["badges"]], ["first_card"])

    def test_streak_comes_from_the_daily_activity(self):
        for day in (30, 31):
            self.db.add(UserDailyActivity(user_id=self.user.id, local_date=datetime.date(2026, 10, day)))
        self.db.add(UserDailyActivity(user_id=self.user.id, local_date=datetime.date(2026, 11, 1)))
        self.db.commit()
        self.assertEqual(recap.weekly_recap(self.db, self.user.id, SUNDAY_1800)["streak"]["current"], 3)

    def test_values_are_plain_numbers_and_nobody_elses(self):
        self.own("big-001", user=self.other, acquired_at=IN_WEEK)
        self.db.commit()
        result = recap.weekly_recap(self.db, self.user.id, SUNDAY_1800)
        self.assertEqual(result["cards_added"], 0)
        self.assertNotIn("misty", json.dumps(result))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class PushTests(RecapBase):
    def enable(self):
        self.db.add(UserSetting(user_id=self.user.id, key="notify_weekly_recap", value="true"))
        self.zone("UTC")

    def queued(self):
        return self.db.query(NotificationQueue).filter_by(category="weekly_recap").all()

    def test_is_off_by_default_and_sends_only_when_enabled(self):
        self.own("tst-001", acquired_at=IN_WEEK)
        self.assertEqual(recap.queue_weekly_recaps(self.db, SUNDAY_1800), 0)
        self.enable()
        self.assertEqual(recap.queue_weekly_recaps(self.db, SUNDAY_1800), 1)

    def test_one_per_week_and_only_from_sunday_18_local(self):
        self.enable()
        self.own("tst-001", acquired_at=IN_WEEK)
        self.assertEqual(recap.queue_weekly_recaps(self.db, SUNDAY_1759), 0)
        self.assertEqual(recap.queue_weekly_recaps(self.db, datetime.datetime(2026, 11, 2, 18, 0)), 0)
        self.assertEqual(recap.queue_weekly_recaps(self.db, SUNDAY_1800), 1)
        self.assertEqual(recap.queue_weekly_recaps(self.db, datetime.datetime(2026, 11, 1, 18, 30)), 0)
        self.assertEqual([row.subject_key for row in self.queued()], ["week:2026-W44"])
        # The next week is a new key.
        self.own("tst-002", acquired_at=datetime.datetime(2026, 11, 4))
        self.assertEqual(recap.queue_weekly_recaps(self.db, datetime.datetime(2026, 11, 8, 18, 0)), 1)

    def test_a_second_run_the_same_evening_neither_recomputes_nor_logs_a_duplicate(self):
        self.enable()
        self.own("tst-001", acquired_at=IN_WEEK)
        self.assertEqual(recap.queue_weekly_recaps(self.db, SUNDAY_1800), 1)
        with patch.object(recap, "weekly_recap") as compute, self.assertLogs("services.notifications", "INFO") as logs:
            notifications.logger.info("marker")  # assertLogs needs one record
            self.assertEqual(recap.queue_weekly_recaps(self.db, SUNDAY_1800 + datetime.timedelta(minutes=1)), 0)
        compute.assert_not_called()
        self.assertFalse([line for line in logs.output if "duplicate" in line])

    def test_an_empty_week_sends_nothing(self):
        self.enable()
        self.assertEqual(recap.queue_weekly_recaps(self.db, SUNDAY_1800), 0)

    def test_text_names_the_numbers_but_no_amount(self):
        self.enable()
        item = self.own("big-001", acquired_at=IN_WEEK)
        item.quantity = 2
        self.db.commit()
        recap.queue_weekly_recaps(self.db, SUNDAY_1800)
        details = self.queued()[0].details
        title, body = recap.build_recap_push(details)
        self.assertIn("2 cards added", body)
        self.assertIn("Big-001", body)
        self.assertNotIn("€", body)
        self.assertNotIn("30", body)

    def test_content_light_text_without_details(self):
        title, body = recap.build_recap_push(None)
        self.assertEqual(body, "Your weekly recap is ready")

    def test_flush_sends_the_push_and_respects_the_details_switch(self):
        self.enable()
        self.own("tst-001", acquired_at=IN_WEEK)
        recap.queue_weekly_recaps(self.db, SUNDAY_1800)
        for details_on in (True, False):
            self.db.query(NotificationQueue).update({"sent_at": None})
            self.db.query(UserSetting).filter_by(user_id=self.user.id, key="notify_show_details").delete()
            self.db.add(UserSetting(user_id=self.user.id, key="notify_show_details", value="true" if details_on else "false"))
            self.db.commit()
            with patch.object(notifications.push, "send_to_user", return_value={"sent": 1, "removed": 0}) as send:
                notifications.flush_due(self.db, SUNDAY_1800 + datetime.timedelta(minutes=1))
            body = json.loads(send.call_args[0][2])["notification"]["body"]
            self.assertEqual("1 card added" in body, details_on)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class WrappedTests(RecapBase):
    DECEMBER = datetime.date(2026, 12, 5)

    def test_unavailable_outside_1_december_to_15_january(self):
        for day in (datetime.date(2026, 11, 30), datetime.date(2027, 1, 16), datetime.date(2026, 6, 1)):
            with self.assertRaises(recap.WrappedUnavailable):
                recap.wrapped(self.db, self.user.id, 2026, today=day)
        for day in (datetime.date(2026, 12, 1), datetime.date(2027, 1, 15)):
            self.assertEqual(recap.wrapped(self.db, self.user.id, 2026, today=day)["year"], 2026)

    def test_the_real_date_is_used_without_an_override(self):
        with patch.dict(os.environ, {recap.PREVIEW_ENV: ""}):
            with self.assertRaises(recap.WrappedUnavailable):
                recap.wrapped(self.db, self.user.id, 2026, now=datetime.datetime(2026, 10, 29, 12))
            self.assertEqual(recap.wrapped(self.db, self.user.id, 2026, now=datetime.datetime(2026, 12, 2, 12))["year"], 2026)

    def test_preview_env_opens_it_early(self):
        with patch.dict(os.environ, {recap.PREVIEW_ENV: "1"}):
            self.assertEqual(recap.wrapped(self.db, self.user.id, 2026, now=datetime.datetime(2026, 10, 29, 12))["year"], 2026)

    def test_totals_and_highlights(self):
        a = self.own("tst-001", acquired_at=datetime.datetime(2026, 3, 5), )
        a.quantity = 2
        self.own("tst-002", acquired_at=datetime.datetime(2026, 3, 9))
        self.own("big-001", acquired_at=datetime.datetime(2026, 8, 1))
        self.own("big-002", acquired_at=datetime.datetime(2025, 12, 31))  # last year
        self.db.commit()
        result = recap.wrapped(self.db, self.user.id, 2026, today=self.DECEMBER)
        self.assertEqual(result["totals"], {"cards": 4, "unique_cards": 3, "sets_touched": 2, "sets_completed": 0})
        self.assertEqual(result["first_card"]["card_id"], "tst-001_en")
        self.assertEqual(result["best_pull"]["card_id"], "big-001_en")
        self.assertEqual(result["best_pull"]["price"], 30.0)
        self.assertEqual(result["biggest_month"], {"month": 3, "count": 3})

    def test_value_streak_badges_trades_and_history(self):
        self.snapshot(datetime.datetime(2026, 2, 1), 50.0)
        self.snapshot(datetime.datetime(2026, 6, 1), 200.0)
        self.snapshot(datetime.datetime(2026, 11, 1), 120.0)
        self.badge("first_card", datetime.datetime(2026, 4, 1))
        self.badge("collector_10", datetime.datetime(2026, 4, 2), backfilled=True)
        for day in (1, 2, 3, 10):
            self.db.add(UserDailyActivity(
                user_id=self.user.id, local_date=datetime.date(2026, 5, day),
                data={"wtp": {"correct": day != 3}, "quests": {"done": ["a", "b"]}}))
        self.db.add(Trade(user_id=self.user.id, trade_date=datetime.date(2026, 7, 7), incoming_value=10, outgoing_value=4))
        self.db.add(Trade(user_id=self.user.id, trade_date=datetime.date(2025, 7, 7), incoming_value=99, outgoing_value=99))
        self.db.commit()
        result = recap.wrapped(self.db, self.user.id, 2026, today=self.DECEMBER)
        self.assertEqual(result["value"]["start"], 50.0)
        self.assertEqual(result["value"]["end"], 120.0)
        self.assertEqual(result["value"]["peak"], 200.0)
        self.assertEqual(result["longest_streak"], 3)
        self.assertEqual(result["wtp_wins"], 3)
        self.assertEqual(result["quests_done"], 8)
        self.assertEqual(result["badges_earned"], 1)
        self.assertEqual(result["trades"], {"count": 1, "incoming_value": 10.0, "outgoing_value": 4.0})
        self.assertEqual(result["history_starts"], "2026-02-01")
        self.assertTrue(result["partial_history"])

    def test_an_empty_year_is_empty_not_an_error(self):
        result = recap.wrapped(self.db, self.user.id, 2026, today=self.DECEMBER)
        self.assertEqual(result["totals"]["cards"], 0)
        self.assertIsNone(result["first_card"])
        self.assertIsNone(result["value"])
        self.assertIsNone(result["history_starts"])


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ApiTests(ApiBase):
    def test_weekly_recap_endpoint(self):
        response = self.client.get("/api/progress/recap/weekly")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        for key in ("show", "has_activity", "cards_added", "value", "best_pull", "closest_set", "streak", "badges"):
            self.assertIn(key, body)

    def test_wrapped_is_404_outside_the_window_and_ignores_preview_date_without_the_env(self):
        # 2020's window closed long ago, so these stay 404 whatever day the suite runs.
        with patch.dict(os.environ, {recap.PREVIEW_ENV: ""}):
            self.assertEqual(self.client.get("/api/progress/wrapped?year=2020").status_code, 404)
            self.assertEqual(self.client.get("/api/progress/wrapped?year=2020&preview_date=2020-12-05").status_code, 404)

    def test_wrapped_preview_date_works_with_the_env(self):
        with patch.dict(os.environ, {recap.PREVIEW_ENV: "1"}):
            response = self.client.get("/api/progress/wrapped?year=2020&preview_date=2020-12-05")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["year"], 2020)
            self.assertEqual(self.client.get("/api/progress/wrapped?year=2020&preview_date=2020-10-05").status_code, 404)


if __name__ == "__main__":
    unittest.main()
