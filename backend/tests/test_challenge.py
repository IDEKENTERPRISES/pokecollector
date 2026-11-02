import datetime
import unittest
from unittest.mock import patch

try:
    from api.backup import BACKUP_GROUPS
    from models import (
        Binder,
        BinderCard,
        Card,
        ChallengeProgress,
        ChallengeWeek,
        Setting,
        User,
        UserAchievement,
        UserDailyActivity,
        UserEvent,
        UserSetting,
        UserXpLedger,
    )
    from services import challenge
    from services.progress import xp
    from services.progress.evaluator import evaluate_user
    from services.social_feature import SOCIAL_SETTING_KEY
    from test_feed import FeedBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    FeedBase = object

D = datetime.datetime
W43 = "2026-W43"  # Mon 19 Oct to Sun 25 Oct 2026: BST ends in it, so it is 169 hours long
MON_W44_0005 = D(2026, 10, 26, 0, 5)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class WeekBoundaryTests(unittest.TestCase):
    def test_the_week_that_ends_british_summer_time_is_an_hour_longer(self):
        week = challenge.week_by_key(W43)
        self.assertEqual(week.start, D(2026, 10, 18, 23, 0))  # Monday 00:00 BST
        self.assertEqual(week.end, D(2026, 10, 26, 0, 0))  # Monday 00:00 GMT
        self.assertEqual(week.end - week.start, datetime.timedelta(hours=169))

    def test_the_week_that_starts_british_summer_time_is_an_hour_shorter(self):
        week = challenge.week_by_key("2026-W13")  # Mon 23 Mar to Sun 29 Mar 2026
        self.assertEqual(week.start, D(2026, 3, 23, 0, 0))
        self.assertEqual(week.end, D(2026, 3, 29, 23, 0))  # Monday 30 March 00:00 BST
        self.assertEqual(week.end - week.start, datetime.timedelta(hours=167))

    def test_instants_either_side_of_the_october_change(self):
        self.assertEqual(challenge.week_at(D(2026, 10, 25, 23, 59)).key, W43)  # Sunday 23:59 GMT
        self.assertEqual(challenge.week_at(D(2026, 10, 26, 0, 0)).key, "2026-W44")
        self.assertEqual(challenge.week_at(D(2026, 10, 18, 22, 59)).key, "2026-W42")  # still Sunday 23:59 BST
        self.assertEqual(challenge.week_at(D(2026, 10, 18, 23, 0)).key, W43)

    def test_instants_either_side_of_the_march_change(self):
        self.assertEqual(challenge.week_at(D(2026, 3, 29, 22, 59)).key, "2026-W13")  # Sunday 23:59 GMT
        self.assertEqual(challenge.week_at(D(2026, 3, 29, 23, 0)).key, "2026-W14")  # Monday 00:00 BST
        self.assertEqual(challenge.week_at(D(2026, 3, 23, 0, 0)).key, "2026-W13")

    def test_the_year_boundary_uses_the_iso_week(self):
        self.assertEqual(challenge.week_at(D(2027, 1, 1, 12)).key, "2026-W53")
        self.assertEqual(challenge.week_by_key("2026-W53").monday, datetime.date(2026, 12, 28))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class CatalogueTests(unittest.TestCase):
    def weeks(self, count=400):
        week = challenge.week_by_key("2026-W01")
        while week.index % len(challenge.CATALOGUE):  # start on the first week of a run
            week = challenge.week_of_monday(week.monday + datetime.timedelta(days=7))
        for _ in range(count):
            yield week
            week = challenge.week_of_monday(week.monday + datetime.timedelta(days=7))

    def test_the_pick_is_the_same_every_time(self):
        week = challenge.week_by_key(W43)
        self.assertEqual(len({challenge.challenge_id_for(week) for _ in range(5)}), 1)

    def test_never_the_same_challenge_two_weeks_running(self):
        picks = [challenge.challenge_id_for(w) for w in self.weeks()]
        self.assertTrue(all(a != b for a, b in zip(picks, picks[1:])))

    def test_every_goal_comes_round_in_each_run_of_the_catalogue(self):
        size = len(challenge.CATALOGUE)
        picks = [challenge.challenge_id_for(w) for w in self.weeks(size * 20)]
        for start in range(0, len(picks), size):
            self.assertEqual(sorted(picks[start:start + size]), sorted(challenge.CATALOGUE_BY_ID))

    def test_the_catalogue_is_well_formed(self):
        self.assertGreaterEqual(len(challenge.CATALOGUE), 3)
        self.assertEqual(len(challenge.CATALOGUE_BY_ID), len(challenge.CATALOGUE))
        for entry in challenge.CATALOGUE:
            self.assertGreater(entry["target"], 0)
            self.assertTrue(callable(entry["count"]))

    def test_the_badge_family_is_in_the_registry(self):
        from services.achievements import registry_by_id

        for steps, badge_id in challenge.BADGE_STEPS:
            entry = registry_by_id()[badge_id]
            self.assertEqual(
                (entry["metric"], entry["target"], entry["family"]), ("challenges_finished", steps, "challenge"))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ChallengeBase(FeedBase):
    def setUp(self):
        super().setUp()
        self.week = challenge.week_by_key(W43)
        self.db.add(ChallengeWeek(week=W43, challenge_id="binder_cards"))
        self.db.commit()

    def binder_card(self, user, when, card="tst-001_en", binder=None):
        binder = binder or Binder(name="B", user_id=user.id, binder_type="collection")
        if binder.id is None:
            self.db.add(binder)
            self.db.flush()
        self.db.add(BinderCard(binder_id=binder.id, card_id=card, added_at=when))
        self.db.commit()
        return binder

    def progress(self, user):
        self.db.expire_all()
        return self.db.query(ChallengeProgress).filter_by(week=W43, user_id=user.id).first()

    def social(self, value):
        self.db.query(Setting).filter_by(key=SOCIAL_SETTING_KEY).update({"value": value})
        self.db.commit()


class ProgressTests(ChallengeBase):
    def count(self, cid):
        return challenge.count_progress(self.db, self.user.id, self.week, cid)

    def test_only_activity_inside_the_uk_week_counts(self):
        binder = self.binder_card(self.user, self.week.start - datetime.timedelta(minutes=1))  # Sunday 23:59 BST
        for when in (self.week.start, D(2026, 10, 22, 12), self.week.end - datetime.timedelta(seconds=1)):
            self.binder_card(self.user, when, binder=binder)
        self.binder_card(self.user, self.week.end, binder=binder)  # Monday 00:00 GMT: next week
        self.assertEqual(self.count("binder_cards"), 3)

    def test_decks_do_not_count_as_binders(self):
        self.binder_card(self.user, D(2026, 10, 22), binder=Binder(name="D", user_id=self.user.id, binder_type="deck"))
        self.assertEqual(self.count("binder_cards"), 0)

    def test_the_count_keeps_going_past_the_target(self):
        binder = self.binder_card(self.user, D(2026, 10, 20, 9))
        with patch.dict(challenge.CATALOGUE_BY_ID["binder_cards"], {"target": 2}):
            for hour in (10, 11, 12):
                self.binder_card(self.user, D(2026, 10, 20, hour), binder=binder)
            challenge.update_progress(self.db, self.user.id, D(2026, 10, 20, 13))
            self.db.commit()
        row = self.progress(self.user)
        self.assertEqual(row.progress, 4)
        self.assertEqual(row.finished_at, D(2026, 10, 20, 13))
        self.assertEqual(row.reached_at, D(2026, 10, 20, 13))

    def test_reached_at_moves_only_when_the_count_changes(self):
        binder = self.binder_card(self.user, D(2026, 10, 20, 9))
        challenge.update_progress(self.db, self.user.id, D(2026, 10, 20, 10))
        challenge.update_progress(self.db, self.user.id, D(2026, 10, 20, 11))
        self.db.commit()
        self.assertEqual(self.progress(self.user).reached_at, D(2026, 10, 20, 10))
        self.binder_card(self.user, D(2026, 10, 20, 11, 30), binder=binder)
        challenge.update_progress(self.db, self.user.id, D(2026, 10, 20, 12))
        self.db.commit()
        self.assertEqual(self.progress(self.user).reached_at, D(2026, 10, 20, 12))

    def test_nothing_is_stored_until_there_is_something_to_count(self):
        challenge.update_progress(self.db, self.user.id, D(2026, 10, 20, 10))
        self.db.commit()
        self.assertIsNone(self.progress(self.user))

    def test_open_days_quests_and_wtp_days_read_the_daily_rows(self):
        for day, data in ((19, {"wtp": True, "quests": {"done": ["a", "b"]}}), (21, {"quests": {"done": ["a"]}}),
                          (26, {"wtp": True, "quests": {"done": ["a"]}})):  # the 26th is next week
            self.db.add(UserDailyActivity(user_id=self.user.id, local_date=datetime.date(2026, 10, day), data=data))
        self.db.commit()
        self.assertEqual((self.count("open_days"), self.count("quests_done"), self.count("wtp_days")), (2, 3, 1))

    def test_new_species_and_sets_ignore_old_collections_and_known_species(self):
        self.db.query(Card).filter_by(id="tst-001_en").update({"dex_ids": [1]})
        self.db.query(Card).filter_by(id="tst-002_en").update({"dex_ids": [1, 4]})
        self.db.query(Card).filter_by(id="big-001_en").update({"dex_ids": [7]})
        self.db.commit()
        self.own("tst-001", added_at=D(2026, 10, 1))  # known before the week
        self.own("tst-002", added_at=D(2026, 10, 21))  # adds species 4 only
        self.own("big-001", added_at=D(2026, 10, 21), acquired_at=D(2020, 1, 1))  # an old collection brought in
        self.assertEqual(self.count("new_species"), 1)
        self.assertEqual(self.count("sets_touched"), 1)

    def test_the_evaluator_counts_for_active_trainers_when_social_is_on(self):
        week = challenge.week_at(datetime.datetime.utcnow())
        self.db.add(ChallengeWeek(week=week.key, challenge_id="binder_cards"))
        self.binder_card(self.user, datetime.datetime.utcnow())
        evaluate_user(self.db, self.user.id)
        row = self.db.query(ChallengeProgress).filter_by(week=week.key, user_id=self.user.id).first()
        self.assertEqual(row.progress, 1)
        self.assertIsNotNone(self.db.get(ChallengeWeek, week.key))

    def test_nothing_is_counted_while_social_is_off_or_single_user(self):
        self.binder_card(self.user, datetime.datetime.utcnow())
        self.social("false")
        evaluate_user(self.db, self.user.id)
        self.assertEqual(self.db.query(ChallengeProgress).count(), 0)
        self.social("true")
        with patch("api.auth.multi_user_enabled", return_value=False):
            evaluate_user(self.db, self.user.id)
        self.assertEqual(self.db.query(ChallengeProgress).count(), 0)

    def test_a_deactivated_trainer_does_not_take_part(self):
        self.binder_card(self.other, datetime.datetime.utcnow())
        self.other.is_active = False
        self.db.commit()
        self.assertFalse(challenge.update_progress(self.db, self.other.id))


class CloseTests(ChallengeBase):
    """Counts come from a stand-in counter so each trainer's count and the time they reached it are set directly."""

    def setUp(self):
        super().setUp()
        self.dawn = User(username="dawn", hashed_password="x", role="trainer", is_active=True, avatar_id=5)
        self.db.add(self.dawn)
        self.db.commit()
        self.counts = {}
        patcher = patch.dict(challenge.CATALOGUE_BY_ID["binder_cards"], {
            "target": 2, "count": lambda db, uid, week: self.counts.get(uid, 0)})
        patcher.start()
        self.addCleanup(patcher.stop)
        # One evaluation each before the week closes, so later badges are genuine unlocks and not silent backfills.
        self.everyone = (self.user, self.other, self.brock, self.dawn)
        for trainer in self.everyone:
            evaluate_user(self.db, trainer.id)

    def reach(self, user, count, when):
        self.counts[user.id] = count
        challenge.update_progress(self.db, user.id, when)
        self.db.commit()

    def play_week(self):
        self.reach(self.user, 3, D(2026, 10, 22, 9))  # ash: 3, later
        self.reach(self.other, 3, D(2026, 10, 20, 10))  # misty: 3, earlier
        self.reach(self.brock, 5, D(2026, 10, 24, 18))  # brock: highest
        self.reach(self.dawn, 1, D(2026, 10, 19, 8))  # dawn: short of the target

    def test_places_go_to_the_highest_count_and_ties_to_whoever_got_there_first(self):
        self.play_week()
        self.assertTrue(challenge.close_week(self.db, self.week, MON_W44_0005))
        places = {u.username: self.progress(u).place for u in self.everyone}
        self.assertEqual(places, {"brock": 1, "misty": 2, "ash": 3, "dawn": None})

    def test_everyone_who_reached_the_target_gets_the_badge_xp_and_an_event(self):
        self.play_week()
        challenge.close_week(self.db, self.week, MON_W44_0005)
        for trainer in self.everyone:
            evaluate_user(self.db, trainer.id)
        self.db.expire_all()
        have = {u.username: "challenge_1" in self.achievement_ids(u) for u in self.everyone}
        self.assertEqual(have, {"ash": True, "misty": True, "brock": True, "dawn": False})
        row = self.db.query(UserAchievement).filter_by(user_id=self.user.id, achievement_id="challenge_1").one()
        self.assertFalse(row.backfilled)  # a genuine unlock: the sheet celebrates it
        self.assertIsNone(row.seen_at)
        for trainer, expected in ((self.user, 1), (self.dawn, 0)):
            self.assertEqual(self.db.query(UserXpLedger).filter_by(
                user_id=trainer.id, source=xp.SOURCE_CHALLENGE).count(), expected)
        events = {u.username: self.events(challenge.EVENT_CHALLENGE_FINISHED, u) for u in (self.user, self.brock, self.dawn)}
        self.assertEqual([len(v) for v in events.values()], [1, 1, 0])
        self.assertEqual(events["brock"][0].payload, {
            "week": W43, "challenge_id": "binder_cards", "title_key": "challenge.binder_cards", "place": 1})
        self.assertEqual(events["ash"][0].payload["place"], 3)

    def test_closing_is_idempotent(self):
        self.play_week()
        self.assertTrue(challenge.close_week(self.db, self.week, MON_W44_0005))
        before = (self.db.query(UserEvent).count(), self.db.query(UserXpLedger).count())
        self.reach(self.dawn, 9, D(2026, 10, 26, 3))  # late activity must not rewrite a closed week
        self.assertFalse(challenge.close_week(self.db, self.week, D(2026, 10, 26, 6)))
        self.assertEqual(challenge.close_due_weeks(self.db, D(2026, 10, 26, 7)), 0)
        self.assertEqual((self.db.query(UserEvent).count(), self.db.query(UserXpLedger).count()), before)
        self.assertIsNone(self.progress(self.dawn).place)
        row = self.db.get(ChallengeWeek, W43)
        self.assertEqual((row.trainer_count, row.finished_count, row.closed_at), (4, 3, MON_W44_0005))

    def test_a_week_is_not_closed_before_it_ends(self):
        self.play_week()
        self.assertFalse(challenge.close_week(self.db, self.week, D(2026, 10, 25, 23, 59)))
        challenge.close_due_weeks(self.db, D(2026, 10, 25, 23, 59))  # may close W42, never W43
        self.assertIsNone(self.db.get(ChallengeWeek, W43).closed_at)

    def test_after_downtime_the_next_run_closes_the_week_and_older_ones_with_progress(self):
        self.play_week()
        old = challenge.week_by_key("2026-W41")
        self.db.add(ChallengeProgress(week=old.key, user_id=self.user.id, progress=1, reached_at=old.start))
        self.db.commit()
        self.assertEqual(challenge.close_due_weeks(self.db, D(2026, 10, 29, 12)), 2)  # Thursday: the server was down
        self.assertEqual(challenge.close_due_weeks(self.db, D(2026, 10, 29, 12, 1)), 0)
        self.assertEqual(self.progress(self.brock).place, 1)
        self.assertIsNotNone(self.db.get(ChallengeWeek, old.key).closed_at)

    def test_the_close_recounts_trainers_the_evaluator_had_not_reached(self):
        self.play_week()
        self.counts[self.dawn.id] = 4  # activity the evaluator never saw
        challenge.close_week(self.db, self.week, MON_W44_0005)
        row = self.progress(self.dawn)
        self.assertEqual(row.progress, 4)
        self.assertIsNotNone(row.finished_at)
        self.assertEqual(row.reached_at, MON_W44_0005 if MON_W44_0005 < self.week.end else self.week.end)

    def test_trainers_off_the_board_finish_but_never_place_or_appear_in_the_feed(self):
        self.play_week()
        self.db.add(UserSetting(user_id=self.brock.id, key=challenge.ON_BOARD_KEY, value="false"))
        self.db.commit()
        challenge.close_week(self.db, self.week, MON_W44_0005)
        self.assertIsNone(self.progress(self.brock).place)
        self.assertIsNotNone(self.progress(self.brock).finished_at)
        self.assertEqual(self.progress(self.other).place, 1)
        self.assertEqual(self.events(challenge.EVENT_CHALLENGE_FINISHED, self.brock), [])
        self.assertEqual(self.db.get(ChallengeWeek, W43).trainer_count, 3)

    def test_nobody_places_without_a_count(self):
        challenge.close_week(self.db, self.week, MON_W44_0005)
        self.assertEqual(self.db.query(ChallengeProgress).count(), 0)
        self.assertIsNotNone(self.db.get(ChallengeWeek, W43).closed_at)

    def test_social_off_closes_nothing(self):
        self.play_week()
        self.social("false")
        self.assertEqual(challenge.close_due_weeks(self.db, D(2026, 10, 26, 0, 5)), 0)


class ApiTests(ChallengeBase):
    def get(self):
        return self.client.get("/api/challenge")

    def test_the_route_is_404_while_the_switch_is_off(self):
        self.social("false")
        self.assertEqual(self.get().status_code, 404)
        self.social("true")
        with patch("api.auth.multi_user_enabled", return_value=False):
            self.assertEqual(self.get().status_code, 404)

    def test_the_week_me_and_board(self):
        week = challenge.week_at(datetime.datetime.utcnow())
        self.binder_card(self.user, datetime.datetime.utcnow())
        response = self.get()
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["week"], week.key)
        self.assertEqual(data["time_zone"], "Europe/London")
        self.assertEqual(set(data["challenge"]), {"id", "title_key", "target", "type"})
        self.assertIsNone(data["last"])
        self.assertEqual((data["trainer_count"], data["finished_count"]), (3, 0))
        self.assertTrue(data["me"]["on_board"])
        self.assertEqual({r["user"]["username"] for r in data["board"]}, {"ash", "misty", "brock"})
        self.assertEqual(set(data["board"][0]), {"user", "progress", "finished_at", "place"})

    def test_the_week_boundaries_are_in_uk_time(self):
        data = challenge.challenge_view(self.db, self.user.id, D(2026, 10, 21, 12))
        self.assertEqual(data["starts_at"], "2026-10-19T00:00:00+01:00")
        self.assertEqual(data["ends_at"], "2026-10-25T23:59:00+00:00")

    def test_the_board_orders_by_count_then_who_got_there_first_and_hides_those_off_it(self):
        self.db.add_all([
            ChallengeProgress(week=W43, user_id=self.user.id, progress=4, reached_at=D(2026, 10, 22, 9)),
            ChallengeProgress(week=W43, user_id=self.other.id, progress=4, reached_at=D(2026, 10, 21, 9)),
            ChallengeProgress(week=W43, user_id=self.brock.id, progress=9, reached_at=D(2026, 10, 23, 9)),
        ])
        self.db.add(UserSetting(user_id=self.brock.id, key=challenge.ON_BOARD_KEY, value="false"))
        self.db.commit()
        data = challenge.challenge_view(self.db, self.brock.id, D(2026, 10, 24, 12))  # the viewer's own count is recounted
        self.assertEqual([(r["user"]["username"], r["place"]) for r in data["board"]], [("misty", 1), ("ash", 2)])
        self.assertEqual(data["trainer_count"], 2)

    def test_last_week_shows_monday_and_tuesday_only(self):
        self.db.add_all([
            ChallengeProgress(week=W43, user_id=self.user.id, progress=3, reached_at=D(2026, 10, 22),
                              finished_at=D(2026, 10, 22), place=1),
            ChallengeProgress(week=W43, user_id=self.other.id, progress=1, reached_at=D(2026, 10, 21), place=2),
        ])
        row = self.db.get(ChallengeWeek, W43)
        row.closed_at, row.trainer_count, row.finished_count = MON_W44_0005, 3, 1
        self.db.add(UserAchievement(user_id=self.user.id, achievement_id="challenge_1", unlocked_at=MON_W44_0005))
        self.db.commit()
        monday = challenge.challenge_view(self.db, self.user.id, D(2026, 10, 26, 9))["last"]
        self.assertEqual(monday["week"], W43)
        self.assertEqual([(p["user"]["username"], p["place"]) for p in monday["podium"]], [("ash", 1), ("misty", 2)])
        self.assertEqual((monday["finished_count"], monday["trainer_count"]), (1, 3))
        self.assertEqual(monday["me"]["place"], 1)
        self.assertEqual(monday["badge"], {"id": "challenge_1", "tier": "bronze"})
        self.assertIsNotNone(challenge.challenge_view(self.db, self.user.id, D(2026, 10, 27, 23, 30))["last"])
        self.assertIsNone(challenge.challenge_view(self.db, self.user.id, D(2026, 10, 28, 0, 0))["last"])
        self.assertIsNone(challenge.challenge_view(self.db, self.other.id, D(2026, 10, 26, 9))["last"]["badge"])


class BackupAndDeletionTests(ChallengeBase):
    def test_both_tables_are_in_the_users_backup_group(self):
        self.assertIn("challenge_weeks", BACKUP_GROUPS["users"])
        self.assertIn("challenge_progress", BACKUP_GROUPS["users"])

    def test_deleting_a_trainer_removes_their_progress_only(self):
        victim_id = self.other.id
        self.db.add_all([
            ChallengeProgress(week=W43, user_id=victim_id, progress=2),
            ChallengeProgress(week=W43, user_id=self.user.id, progress=3),
        ])
        self.db.commit()
        with patch("services.scan_trace.revoke_user_traces"):
            response = self.client.delete(f"/api/auth/users/{victim_id}")
        self.assertEqual(response.status_code, 200, response.text)
        self.db.expire_all()
        self.assertEqual(self.db.query(ChallengeProgress).filter_by(user_id=victim_id).count(), 0)
        self.assertEqual(self.db.query(ChallengeProgress).filter_by(user_id=self.user.id).count(), 1)
        self.assertIsNotNone(self.db.get(ChallengeWeek, W43))


if __name__ == "__main__":
    unittest.main()
