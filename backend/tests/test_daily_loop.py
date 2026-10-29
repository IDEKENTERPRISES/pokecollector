import datetime
import unittest

try:
    from fastapi.testclient import TestClient

    import main
    from api.auth import get_current_user
    from api.backup import BACKUP_GROUPS
    from database import get_db
    from models import (
        Binder,
        BinderCard,
        CollectionItem,
        User,
        UserAchievement,
        UserDailyActivity,
        UserSetting,
        UserXpLedger,
    )
    from services import achievements
    from services.pokedex_splash import species_for_date
    from services.progress import daily, quests, xp
    from services.progress.evaluator import evaluate_user
    from services.progress.streak import compute_streak
    from services.progress.wtp import build_puzzle, wtp_species
    from test_progress import ProgressTestBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    ProgressTestBase = object

D = datetime.date


def days(*offsets, today=D(2026, 10, 28)):
    return [today - datetime.timedelta(days=offset) for offset in offsets]


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class StreakTests(unittest.TestCase):
    today = D(2026, 10, 28)  # a Wednesday

    def test_consecutive_days_count(self):
        result = compute_streak(days(0, 1, 2), self.today)
        self.assertEqual((result["current"], result["best"]), (3, 3))
        self.assertTrue(result["active_today"])

    def test_today_not_opened_yet_keeps_the_streak(self):
        self.assertEqual(compute_streak(days(1, 2), self.today)["current"], 2)

    def test_one_missed_day_is_frozen(self):
        result = compute_streak(days(0, 2, 3), self.today)  # yesterday missed
        self.assertEqual(result["current"], 3)
        self.assertEqual(result["frozen_days"], [D(2026, 10, 27)])
        self.assertFalse(result["freeze_available"])

    def test_second_miss_in_the_same_week_breaks(self):
        # Mon 26 open, Tue 27 missed (freeze), Wed 28 open, Thu 29 missed -> second miss in week 44
        opened = [D(2026, 10, 25), D(2026, 10, 26), D(2026, 10, 28), D(2026, 10, 30)]
        result = compute_streak(opened, D(2026, 10, 30))
        self.assertEqual(result["current"], 1)
        self.assertEqual(result["best"], 3)

    def test_a_new_week_has_a_new_freeze(self):
        opened = [D(2026, 10, d) for d in (19, 21, 22, 23, 24, 25, 26, 28)]
        result = compute_streak(opened, D(2026, 10, 28))
        self.assertEqual(result["current"], 8)
        self.assertEqual(len(result["frozen_days"]), 2)

    def test_two_missed_days_break(self):
        self.assertEqual(compute_streak(days(0, 3, 4), self.today)["current"], 1)

    def test_pending_freeze_when_yesterday_was_missed(self):
        result = compute_streak(days(2, 3), self.today)
        self.assertEqual(result["current"], 2)
        self.assertTrue(result["freeze_pending"])

    def test_no_activity(self):
        result = compute_streak([], self.today)
        self.assertEqual((result["current"], result["best"]), (0, 0))

    def test_long_gap_resets_and_best_is_kept(self):
        result = compute_streak(days(0, 1) + days(20, 21, 22, 23), self.today)
        self.assertEqual((result["current"], result["best"]), (2, 4))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class LevelCurveTests(unittest.TestCase):
    def test_curve_is_gentle_and_monotonic(self):
        thresholds = [xp.xp_for_level(level) for level in range(1, 31)]
        self.assertEqual(thresholds[0], 0)
        self.assertEqual(thresholds[1], 50)
        self.assertTrue(all(b > a for a, b in zip(thresholds, thresholds[1:])))
        steps = [b - a for a, b in zip(thresholds, thresholds[1:])]
        self.assertTrue(all(b >= a for a, b in zip(steps, steps[1:])))
        self.assertLess(thresholds[9], 1500)  # level 10 after about 1,350 XP

    def test_level_for_xp_boundaries(self):
        self.assertEqual(xp.level_for_xp(0), 1)
        self.assertEqual(xp.level_for_xp(49), 1)
        self.assertEqual(xp.level_for_xp(50), 2)
        self.assertEqual(xp.level_for_xp(xp.xp_for_level(7) - 1), 6)
        self.assertEqual(xp.level_for_xp(10 ** 9), xp.MAX_LEVEL)
        self.assertEqual(xp.level_for_xp(-5), 1)

    def test_level_info(self):
        info = xp.level_info(60)
        self.assertEqual((info["level"], info["level_start"], info["next_level_at"]), (2, 50, xp.xp_for_level(3)))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class QuestSelectionTests(unittest.TestCase):
    def test_same_user_and_date_gives_the_same_three(self):
        first = quests.select_quests(7, D(2026, 10, 28))
        self.assertEqual(first, quests.select_quests(7, D(2026, 10, 28)))
        self.assertEqual(len(first), 3)
        self.assertEqual(len(set(first)), 3)
        self.assertTrue(set(first) <= set(quests.QUEST_IDS))

    def test_it_varies_over_dates_and_users(self):
        by_date = {tuple(quests.select_quests(7, D(2026, 10, 1) + datetime.timedelta(days=n))) for n in range(30)}
        by_user = {tuple(quests.select_quests(n, D(2026, 10, 28))) for n in range(30)}
        self.assertGreater(len(by_date), 5)
        self.assertGreater(len(by_user), 5)

    def test_every_quest_gets_picked_eventually(self):
        picked = set()
        for n in range(60):
            picked.update(quests.select_quests(1, D(2026, 10, 1) + datetime.timedelta(days=n)))
        self.assertEqual(picked, set(quests.QUEST_IDS))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class WtpTests(unittest.TestCase):
    def test_puzzle_is_deterministic_with_four_distinct_choices(self):
        day = D(2026, 10, 28)
        puzzle = build_puzzle(day, "en")
        self.assertEqual(puzzle, build_puzzle(day, "en"))
        ids = [choice["dex_id"] for choice in puzzle["choices"]]
        self.assertEqual(len(set(ids)), 4)
        self.assertIn(puzzle["answer"], ids)
        self.assertEqual(puzzle["answer"], wtp_species(day))
        self.assertTrue(puzzle["sprite_url"].startswith("/api/pokedex/images/artwork/"))

    def test_never_the_pokemon_of_the_day(self):
        for n in range(400):
            day = D(2026, 10, 21) + datetime.timedelta(days=n)
            self.assertNotEqual(wtp_species(day), species_for_date(day))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class DailyLoopTests(ProgressTestBase):
    def setUp(self):
        super().setUp()
        self.today = daily.local_today(daily.user_zone(self.db, self.user.id))

    def open_day(self, day=None, **data):
        day = day or self.today
        row = self.db.query(UserDailyActivity).filter_by(user_id=self.user.id, local_date=day).first()
        if row is None:
            row = UserDailyActivity(
                user_id=self.user.id, local_date=day, first_seen_at=datetime.datetime.utcnow(),
                last_seen_at=datetime.datetime.utcnow(), opens=1, offline=False, data=data,
            )
            self.db.add(row)
        else:
            row.data = {**(row.data or {}), **data}
        self.db.commit()
        return row

    def force_quests(self, *ids):
        original = quests.select_quests
        quests.select_quests = lambda user_id, day: list(ids)
        self.addCleanup(setattr, quests, "select_quests", original)

    def test_quest_xp_is_idempotent(self):
        self.force_quests("view_pokemon", "play_wtp", "add_card")
        self.open_day(viewed=True)
        first = daily.sync_daily(self.db, self.user.id)
        second = daily.sync_daily(self.db, self.user.id)
        self.db.commit()
        self.assertEqual(first["done"], ["view_pokemon"])
        self.assertEqual(first, second)
        self.assertEqual(xp.total_xp(self.db, self.user.id), xp.QUEST_XP)

    def test_all_three_quests_add_the_bonus_once(self):
        self.force_quests("view_pokemon", "play_wtp", "add_card")
        self.open_day(viewed=True, wtp={"dex_id": 1, "correct": False})
        self.own("tst-001")
        for _ in range(3):
            result = daily.sync_daily(self.db, self.user.id)
            self.db.commit()
        self.assertEqual(len(result["done"]), 3)
        self.assertEqual(xp.total_xp(self.db, self.user.id), 3 * xp.QUEST_XP + xp.ALL_QUESTS_XP)

    def test_binder_review_and_wishlist_quests_read_the_data(self):
        self.force_quests("binder_card", "review_scans", "wishlist_card")
        self.open_day()
        binder = Binder(user_id=self.user.id, name="B", binder_type="collection")
        self.db.add(binder)
        self.db.flush()
        self.db.add(BinderCard(binder_id=binder.id, card_id="tst-001_en", required_quantity=1))
        self.db.commit()
        result = daily.sync_daily(self.db, self.user.id)
        self.assertEqual(result["done"], ["binder_card"])

    def test_missing_closest_counts_a_pull_in_the_closest_set(self):
        self.force_quests("missing_closest", "add_card", "view_pokemon")
        self.open_day()
        self.own("big-001")  # big has 2 cards: now 1 of 2, the closest incomplete set
        result = daily.sync_daily(self.db, self.user.id)
        self.assertIn("missing_closest", result["done"])

    def test_done_quests_stay_done(self):
        self.force_quests("view_pokemon", "play_wtp", "add_card")
        self.open_day(viewed=True)
        daily.sync_daily(self.db, self.user.id)
        row = self.open_day()
        row.data = {**row.data, "viewed": False}
        self.db.commit()
        self.assertIn("view_pokemon", daily.sync_daily(self.db, self.user.id)["done"])

    def test_daily_badges_unlock_and_the_registry_version_backfills(self):
        self.assertEqual(achievements.REGISTRY_VERSION, 3)
        for offset in range(7):
            self.open_day(self.today - datetime.timedelta(days=offset))
        self.open_day(wtp={"dex_id": 1, "correct": True})
        evaluate_user(self.db, self.user.id)  # first evaluation: silent
        rows = {row.achievement_id: row for row in self.db.query(UserAchievement).filter_by(user_id=self.user.id)}
        for badge in ("streak_7", "first_wtp"):
            self.assertIn(badge, rows)
            self.assertTrue(rows[badge].backfilled)
        self.assertNotIn("streak_30", rows)

    def test_new_registry_entries_backfill_silently_for_existing_trainers(self):
        from models import ProgressState

        evaluate_user(self.db, self.user.id)
        state = self.db.get(ProgressState, self.user.id)
        state.state_version = 2
        self.db.commit()
        for offset in range(7):
            self.open_day(self.today - datetime.timedelta(days=offset))
        evaluate_user(self.db, self.user.id)
        row = self.db.query(UserAchievement).filter_by(user_id=self.user.id, achievement_id="streak_7").one()
        self.assertTrue(row.backfilled)
        self.assertIsNotNone(row.seen_at)

    def test_evaluation_awards_badge_streak_and_set_xp_once(self):
        for offset in range(3):
            self.open_day(self.today - datetime.timedelta(days=offset))
        self.own("tst-001")
        self.own("tst-002")  # completes tst_en
        evaluate_user(self.db, self.user.id)
        first = xp.total_xp(self.db, self.user.id)
        evaluate_user(self.db, self.user.id)
        self.assertEqual(first, xp.total_xp(self.db, self.user.id))
        sources = {row.source for row in self.db.query(UserXpLedger).filter_by(user_id=self.user.id)}
        self.assertTrue({xp.SOURCE_STREAK, xp.SOURCE_BADGE, xp.SOURCE_SET} <= sources)
        self.assertGreaterEqual(first, xp.SET_XP)

    def test_the_ledger_rejects_duplicate_sources(self):
        self.assertTrue(xp.award(self.db, self.user.id, "quest", "k", 10))
        self.assertFalse(xp.award(self.db, self.user.id, "quest", "k", 10))
        self.assertFalse(xp.award(self.db, self.user.id, "quest", "z", 0))
        self.assertEqual(xp.totals_for(self.db, [self.user.id, self.other.id]), {self.user.id: 10})

    def test_pokemon_of_day_counts_printings_or_offers_the_cheapest(self):
        dex_id = species_for_date(self.today)
        self.db.add_all([
            _species_card("sp-a", dex_id, 3.0), _species_card("sp-b", dex_id, 1.5),
        ])
        self.db.commit()
        info = daily.pokemon_of_day_info(self.db, self.user.id, self.today)
        self.assertEqual((info["owned_printings"], info["cheapest"]["card_id"]), (0, "sp-b_en"))
        self.own("sp-a")
        info = daily.pokemon_of_day_info(self.db, self.user.id, self.today)
        self.assertEqual(info["owned_printings"], 1)
        self.assertIsNone(info["cheapest"])

    def test_pokemon_of_day_names_the_most_expensive_print_owned_or_not(self):
        from models import Set

        dex_id = species_for_date(self.today)
        self.db.add_all([
            Set(id="spc_en", tcg_set_id="spc", name="Species Set", lang="en", total=3),
            _species_card("spc-001", dex_id, 3.0),
            _species_card("spc-002", dex_id, 41.256),
            _species_card("spc-003", dex_id, 41.256),  # ties go to the lowest id
            _species_card("spc-004", dex_id, 0),  # unpriced printings never win
        ])
        self.db.commit()
        info = daily.pokemon_of_day_info(self.db, self.user.id, self.today)
        top = info["most_expensive"]
        self.assertEqual((top["card_id"], top["price"]), ("spc-002_en", 41.26))
        self.assertEqual((top["set_name"], top["number"], top["lang"]), ("Species Set", "002", "en"))
        self.assertEqual(info["cheapest"]["card_id"], "spc-001_en")

        self.own("spc-001")  # owning a printing hides the cheapest line, not the most expensive
        info = daily.pokemon_of_day_info(self.db, self.user.id, self.today)
        self.assertIsNone(info["cheapest"])
        self.assertEqual(info["most_expensive"]["card_id"], "spc-002_en")

    def test_most_expensive_print_follows_the_trainers_price_field(self):
        dex_id = species_for_date(self.today)
        cheap_trend = _species_card("spd-001", dex_id, 5.0)
        cheap_trend.price_avg7 = 99.0
        self.db.add_all([cheap_trend, _species_card("spd-002", dex_id, 20.0)])
        self.db.add(UserSetting(user_id=self.user.id, key="price_primary", value="avg7"))
        self.db.commit()
        info = daily.pokemon_of_day_info(self.db, self.user.id, self.today)
        self.assertEqual((info["most_expensive"]["card_id"], info["most_expensive"]["price"]), ("spd-001_en", 99.0))

    def test_pokemon_of_day_has_no_prints_to_show_when_nothing_is_priced(self):
        info = daily.pokemon_of_day_info(self.db, self.user.id, self.today)
        self.assertIsNone(info["most_expensive"])

    def test_new_table_is_in_a_backup_group(self):
        self.assertIn("user_xp_ledger", BACKUP_GROUPS["users"])


def _species_card(card_id, dex_id, price):
    from test_progress import _card

    return _card(card_id, set_id="spc", price=price, dex_ids=[dex_id])


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class DailyApiTests(ProgressTestBase):
    def setUp(self):
        super().setUp()

        def override_db():
            session = self.Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_db
        main.app.dependency_overrides[get_current_user] = lambda: self.user
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)
        self.today = datetime.datetime.utcnow().date()
        self.client.post("/api/progress/checkin", json={"time_zone": "UTC", "dates": [self.today.isoformat()]})

    def force_quests(self, *ids):
        original = quests.select_quests
        quests.select_quests = lambda user_id, day: list(ids)
        self.addCleanup(setattr, quests, "select_quests", original)

    def unseen_quests(self):
        return self.client.get("/api/progress/unlocks/unseen").json()["quests"]

    def test_completed_quest_is_unseen_once_then_seen(self):
        self.force_quests("view_pokemon", "play_wtp", "add_card")
        self.client.post("/api/progress/daily/view", json={})
        key = f"{self.today.isoformat()}:view_pokemon"
        self.assertEqual(self.unseen_quests(), [{
            "key": key, "date": self.today.isoformat(), "quest_id": "view_pokemon",
            "xp": xp.QUEST_XP, "bonus_xp": 0, "completed_at": self.unseen_quests()[0]["completed_at"],
        }])

        # syncing again must not bring a celebrated quest back
        marked = self.client.post("/api/progress/unlocks/seen", json={"quest_keys": [key]}).json()
        self.assertEqual(marked["quests_marked"], 1)
        self.client.get("/api/progress/today")
        self.client.post("/api/progress/daily/view", json={})
        self.assertEqual(self.unseen_quests(), [])
        row = self.db.query(UserXpLedger).filter_by(user_id=self.user.id, source="quest", source_key=key).one()
        self.assertIsNotNone(row.seen_at)

    def test_marking_only_badges_leaves_quests_and_marking_everything_clears_both(self):
        self.force_quests("view_pokemon", "play_wtp", "add_card")
        self.client.post("/api/progress/daily/view", json={})
        self.client.post("/api/progress/unlocks/seen", json={"ids": []})
        self.assertEqual(len(self.unseen_quests()), 1)
        self.assertEqual(self.client.post("/api/progress/unlocks/seen", json={"quest_keys": []}).json()["quests_marked"], 0)
        self.assertEqual(len(self.unseen_quests()), 1)
        everything = self.client.post("/api/progress/unlocks/seen", json={}).json()
        self.assertEqual(everything["quests_marked"], 1)
        self.assertEqual(self.unseen_quests(), [])

    def test_the_all_quests_bonus_rides_on_the_last_quest_of_the_day(self):
        self.force_quests("view_pokemon", "play_wtp", "add_card")
        self.client.post("/api/progress/daily/view", json={})
        self.client.post("/api/progress/wtp/answer", json={"date": self.today.isoformat(), "dex_id": wtp_species(self.today)})
        self.own("tst-001")
        self.client.get("/api/progress/today")
        found = self.unseen_quests()
        self.assertEqual([q["quest_id"] for q in found], ["view_pokemon", "play_wtp", "add_card"])
        self.assertEqual([q["bonus_xp"] for q in found], [0, 0, xp.ALL_QUESTS_XP])
        self.assertEqual(sum(q["xp"] + q["bonus_xp"] for q in found), xp.total_xp(self.db, self.user.id))

    def test_old_and_other_peoples_quests_are_not_celebrated(self):
        long_ago = (self.today - datetime.timedelta(days=5)).isoformat()
        yesterday = (self.today - datetime.timedelta(days=1)).isoformat()
        self.db.add_all([
            UserXpLedger(user_id=self.user.id, source="quest", source_key=f"{long_ago}:add_card", amount=10),
            UserXpLedger(user_id=self.user.id, source="quest", source_key=f"{yesterday}:add_card", amount=10),
            UserXpLedger(user_id=self.other.id, source="quest", source_key=f"{yesterday}:play_wtp", amount=10),
            UserXpLedger(user_id=self.user.id, source="streak", source_key=yesterday, amount=5),
            UserXpLedger(user_id=self.user.id, source="quest", source_key=f"{yesterday}:retired_quest", amount=10),
        ])
        self.db.commit()
        self.assertEqual([q["key"] for q in self.unseen_quests()], [f"{yesterday}:add_card"])

    def test_wtp_puzzle_endpoint_is_public_and_deterministic(self):
        main.app.dependency_overrides.clear()
        first = TestClient(main.app).get("/api/pokedex/wtp?date=2026-10-28&lang=en")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json(), TestClient(main.app).get("/api/pokedex/wtp?date=2026-10-28").json())
        self.assertEqual(len(first.json()["choices"]), 4)

    def test_correct_answer_is_recorded_once_and_completes_the_quest(self):
        answer = wtp_species(self.today)
        wrong = 1 if answer != 1 else 2
        response = self.client.post("/api/progress/wtp/answer", json={"date": self.today.isoformat(), "dex_id": answer})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["correct"])
        self.assertEqual(body["answer"], answer)
        self.assertTrue(body["today"]["wtp"]["played"])
        # replaying an offline result, even a different one, changes nothing
        again = self.client.post("/api/progress/wtp/answer", json={"date": self.today.isoformat(), "dex_id": wrong})
        self.assertTrue(again.json()["correct"])
        self.assertEqual(again.json()["chosen"], answer)

    def test_wrong_answer_is_recorded_as_played_not_correct(self):
        answer = wtp_species(self.today)
        wrong = 1 if answer != 1 else 2
        body = self.client.post(
            "/api/progress/wtp/answer", json={"date": self.today.isoformat(), "dex_id": wrong}).json()
        self.assertFalse(body["correct"])
        self.assertTrue(body["today"]["wtp"]["played"])
        self.assertFalse(body["today"]["wtp"]["correct"])

    def test_offline_answer_for_an_earlier_day_is_accepted_and_old_ones_are_not(self):
        yesterday = self.today - datetime.timedelta(days=1)
        ok = self.client.post(
            "/api/progress/wtp/answer", json={"date": yesterday.isoformat(), "dex_id": wtp_species(yesterday)})
        self.assertEqual(ok.status_code, 200, ok.text)
        old = self.today - datetime.timedelta(days=40)
        self.assertEqual(self.client.post(
            "/api/progress/wtp/answer", json={"date": old.isoformat(), "dex_id": 1}).status_code, 400)

    def test_today_summary_shape(self):
        response = self.client.get("/api/progress/today")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(len(body["quests"]), 3)
        self.assertEqual(body["streak"]["current"], 1)
        self.assertEqual(body["xp"]["level"], 1)
        self.assertEqual(body["pokemon"]["dex_id"], species_for_date(self.today))

    def test_viewing_the_pokemon_can_finish_the_view_quest(self):
        original = quests.select_quests
        quests.select_quests = lambda user_id, day: ["view_pokemon", "play_wtp", "add_card"]
        self.addCleanup(setattr, quests, "select_quests", original)
        body = self.client.post("/api/progress/daily/view", json={}).json()
        self.assertEqual([q["done"] for q in body["quests"]], [True, False, False])
        self.assertEqual(body["xp"]["xp"], xp.QUEST_XP)

    def test_leaderboard_carries_xp_and_level(self):
        xp.award(self.db, self.user.id, "quest", "k", 120)
        self.db.commit()
        rows = self.client.get("/api/social/leaderboard").json()
        mine = next(row for row in rows if row["user_id"] == self.user.id)
        self.assertEqual((mine["xp"], mine["level"]), (120, xp.level_for_xp(120)))


if __name__ == "__main__":
    unittest.main()
