import datetime
import json
import unittest
from unittest.mock import patch

try:
    from api.backup import BACKUP_GROUPS
    from models import (
        Binder, BinderCard, Card, CollectionItem, NotificationQueue, ProgressState, Set, Setting, User, UserGoal,
        UserSetting, WishlistItem,
    )
    from services import goals, notifications
    from services.progress.evaluator import evaluate_user
    from test_progress import ProgressTestBase, _card
    from test_small_delights import ApiBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    ProgressTestBase = ApiBase = object

NOW = datetime.datetime(2026, 10, 29, 12, 0)


class GoalBase(ProgressTestBase):
    def goal(self, kind, params, user=None, **extra):
        goal = UserGoal(user_id=(user or self.user).id, kind=kind, params=params, **extra)
        self.db.add(goal)
        self.db.commit()
        return goal

    def progress(self, goal, detail=False):
        return goals.progress_for(goals.GoalContext(self.db, self.user.id), goal, detail=detail)

    def species(self, card_id, dex_ids, price=1.0, lang="en", **extra):
        card = _card(card_id, set_id="spc", price=price, lang=lang, dex_ids=dex_ids, **extra)
        self.db.add(card)
        self.db.commit()
        return card


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ProgressTests(GoalBase):
    def test_set_goal_owned_percent_and_cost(self):
        goal = self.goal("set", {"set_id": "tst", "lang": "en"})
        self.own("tst-001")
        result = self.progress(goal)
        self.assertEqual((result["owned"], result["total"], result["missing"], result["percent"]), (1, 2, 1, 50.0))
        self.assertEqual(result["cost_to_finish"], 5.0)
        self.assertEqual(result["cheapest_missing"][0]["card_id"], "tst-002_en")

    def test_a_goal_grows_when_the_catalogue_does(self):
        goal = self.goal("set", {"set_id": "tst", "lang": "en"})
        self.own("tst-001")
        self.own("tst-002")
        self.assertEqual(self.progress(goal)["percent"], 100.0)
        self.db.add(_card("tst-003", price=2.5))
        self.db.commit()
        result = self.progress(goal)
        self.assertEqual((result["owned"], result["total"]), (2, 3))
        self.assertEqual(result["cost_to_finish"], 2.5)

    def test_cheapest_missing_is_sorted_and_unpriced_cards_are_counted_apart(self):
        goal = self.goal("set", {"set_id": "big", "lang": "en"})
        self.db.add(_card("big-003", set_id="big", price=0))
        self.db.commit()
        result = self.progress(goal)
        self.assertEqual([c["card_id"] for c in result["cheapest_missing"]], ["big-002_en", "big-001_en", "big-003_en"])
        self.assertEqual(result["cost_to_finish"], 31.0)
        self.assertEqual(result["unpriced_missing"], 1)

    def test_cost_uses_the_trainers_price_field(self):
        self.db.add(UserSetting(user_id=self.user.id, key="price_primary", value="low"))
        self.db.query(Card).filter_by(id="tst-001_en").update({"price_low": 1.0})
        self.db.commit()
        goal = self.goal("set", {"set_id": "tst", "lang": "en"})
        self.own("tst-002")
        self.assertEqual(self.progress(goal)["cost_to_finish"], 1.0)

    def test_set_master_needs_every_variant(self):
        self.db.query(Card).filter_by(id="tst-001_en").update({"variants_normal": True, "variants_holo": True})
        self.db.query(Card).filter_by(id="tst-002_en").update({"variants_normal": True})
        self.db.commit()
        goal = self.goal("set_master", {"set_id": "tst", "lang": "en"})
        self.assertEqual(self.progress(goal)["total"], 3)
        self.own("tst-001")
        self.own("tst-002")
        result = self.progress(goal)
        self.assertEqual((result["owned"], result["total"]), (2, 3))
        self.assertEqual(result["cheapest_missing"][0]["variant"], "Holo")
        self.db.add(CollectionItem(card_id="tst-001_en", user_id=self.user.id, quantity=1, variant="Holo", lang="en"))
        self.db.commit()
        self.assertEqual(self.progress(goal)["percent"], 100.0)

    def test_generation_counts_species_any_printing_and_grows(self):
        self.species("pika-1", [25], price=3.0)
        self.species("pika-2", [25], price=1.0)
        self.species("eevee-1", [133], price=2.0)
        self.species("chikorita-1", [152])  # generation 2
        goal = self.goal("generation", {"generation": 1})
        result = self.progress(goal)
        self.assertEqual((result["owned"], result["total"]), (0, 2))
        self.assertEqual(result["cost_to_finish"], 3.0)  # the cheapest Pikachu plus Eevee
        self.db.add(CollectionItem(card_id="pika-1_en", user_id=self.user.id, quantity=1, variant="Normal", lang="en"))
        self.db.commit()
        self.assertEqual(self.progress(goal)["owned"], 1)  # any printing counts
        self.species("char-1", [4])
        self.assertEqual(self.progress(goal)["total"], 3)

    def test_catalogue_languages_limit_what_counts(self):
        self.species("pika-1", [25])
        self.species("char-fr", [4], lang="fr")
        goal = self.goal("generation", {"generation": 1})
        self.assertEqual(self.progress(goal)["total"], 1)
        self.db.add(Setting(key="tcgdex_sync_languages", value="en,fr"))
        self.db.commit()
        self.assertEqual(self.progress(goal)["total"], 2)

    def test_digital_cards_are_left_out_unless_enabled(self):
        self.species("pika-1", [25])
        self.species("char-d", [4], is_digital=True)
        goal = self.goal("generation", {"generation": 1})
        self.db.add(Setting(key="tcgdex_digital_sets_enabled", value="false"))
        self.db.commit()
        self.assertEqual(self.progress(goal)["total"], 1)

    def test_family_goal(self):
        self.species("eevee-1", [133])
        self.species("vap-1", [134])
        self.species("pika-1", [25])
        goal = self.goal("family", {"family": "eeveelutions"})
        self.db.add(CollectionItem(card_id="vap-1_en", user_id=self.user.id, quantity=1, variant="Normal", lang="en"))
        self.db.commit()
        result = self.progress(goal)
        self.assertEqual((result["owned"], result["total"]), (1, 2))

    def test_family_goal_for_every_card_counts_each_print(self):
        self.species("eevee-1", [133], price=2.0)
        self.species("eevee-2", [133], price=3.0)
        self.species("eevee-2", [133], price=3.0, lang="de")  # the same print in another language
        self.species("vap-1", [134], price=4.0)
        self.species("pika-1", [25])
        self.db.add(Setting(key="tcgdex_sync_languages", value="en,de"))
        self.db.commit()
        goal = self.goal("family", {"family": "eeveelutions", "every": True})
        self.db.add(CollectionItem(card_id="eevee-2_de", user_id=self.user.id, quantity=1, variant="Normal", lang="de"))
        self.db.commit()
        result = self.progress(goal)
        self.assertEqual((result["owned"], result["total"]), (1, 3))
        self.assertEqual(result["cost_to_finish"], 6.0)
        self.assertEqual(goals.goal_title(self.db, goal), "Eevee and all Eeveelutions (every card)")

    def test_artist_goal_merges_languages_and_ignores_case(self):
        self.db.add_all([
            _card("art-001", set_id="art", artist="Mitsuhiro Arita"),
            _card("art-001", set_id="art", artist="Mitsuhiro Arita", lang="de"),
            _card("art-002", set_id="art", artist="Someone Else"),
        ])
        self.db.commit()
        goal = self.goal("artist", {"artist": "mitsuhiro arita"})
        self.assertEqual(self.progress(goal)["total"], 1)
        self.db.add(CollectionItem(card_id="art-001_de", user_id=self.user.id, quantity=1, variant="Normal", lang="de"))
        self.db.commit()
        self.assertEqual(self.progress(goal)["percent"], 100.0)

    def test_custom_goal_uses_the_listed_cards(self):
        goal = self.goal("custom", {"card_ids": ["tst-001_en", "big-001_en", "gone_en"]})
        self.own("tst-001")
        result = self.progress(goal)
        self.assertEqual((result["owned"], result["total"]), (1, 2))
        self.assertEqual(result["cost_to_finish"], 30.0)

    def test_other_trainers_cards_do_not_count(self):
        goal = self.goal("set", {"set_id": "tst", "lang": "en"})
        self.own("tst-001", user=self.other)
        self.assertEqual(self.progress(goal)["owned"], 0)

    def test_empty_goal_is_zero_percent(self):
        goal = self.goal("generation", {"generation": 9})
        self.assertEqual(self.progress(goal)["percent"], 0.0)

    def test_big_generation_runs_a_constant_number_of_queries(self):
        for i in range(300):
            self.db.add(_card(f"bulk-{i:04d}", set_id="bulk", price=1.0, dex_ids=[1 + i % 100]))
        self.db.commit()
        goal = self.goal("generation", {"generation": 1})
        statements = []
        from sqlalchemy import event

        def count(conn, cursor, statement, *args):
            statements.append(statement)

        event.listen(self.engine, "before_cursor_execute", count)
        try:
            result = self.progress(goal)
        finally:
            event.remove(self.engine, "before_cursor_execute", count)
        self.assertEqual(result["total"], 100)
        self.assertLess(len(statements), 8)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ParamTests(GoalBase):
    def test_params_are_validated(self):
        bad = [
            ("set", {}), ("set", {"set_id": "nope", "lang": "en"}), ("generation", {"generation": 99}),
            ("generation", {"generation": "x"}), ("family", {"family": "nope"}), ("artist", {"artist": ""}),
            ("artist", {"artist": "Nobody"}), ("custom", {"card_ids": []}), ("custom", {"card_ids": ["zzz"]}),
            ("custom", {}), ("other", {}),
        ]
        for kind, params in bad:
            with self.assertRaises(goals.GoalError, msg=f"{kind} {params}"):
                goals.clean_params(self.db, kind, params)
        self.assertEqual(goals.clean_params(self.db, "set", {"set_id": "tst"}), {"set_id": "tst", "lang": "en"})
        self.assertEqual(
            goals.clean_params(self.db, "custom", {"card_ids": ["tst-001_en", "tst-001_en", "x"], "name": " My  list "}),
            {"card_ids": ["tst-001_en"], "name": "My list"},
        )
        family = goals.clean_params(self.db, "family", {"family": "eeveelutions", "every": "yes"})
        self.assertEqual(family, {"family": "eeveelutions"})  # only a real true picks every card
        self.assertEqual(
            goals.clean_params(self.db, "family", {"family": "eeveelutions", "every": True}),
            {"family": "eeveelutions", "every": True},
        )


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class MilestoneTests(GoalBase):
    def setUp(self):
        super().setUp()
        for i in range(3, 11):
            self.db.add(_card(f"tst-{i:03d}", price=1.0))
        self.db.commit()  # the set now has 10 cards
        self.goal_row = self.goal("set", {"set_id": "tst", "lang": "en"})

    def own_n(self, start, end):
        for i in range(start, end + 1):
            self.own(f"tst-{i:03d}")

    def queue(self):
        return self.db.query(NotificationQueue).filter_by(user_id=self.user.id, category="goal_milestones").all()

    def evaluate(self):
        goals.evaluate_goals(self.db, self.user.id, NOW)
        self.db.commit()

    def test_first_evaluation_backfills_silently(self):
        self.own_n(1, 8)
        self.evaluate()
        self.db.refresh(self.goal_row)
        self.assertEqual(self.goal_row.milestones, [50, 75])
        self.assertEqual(self.queue(), [])

    def test_crossing_a_threshold_pushes_once(self):
        self.evaluate()
        self.own_n(1, 5)
        self.evaluate()
        self.evaluate()
        rows = self.queue()
        self.assertEqual([r.subject_key for r in rows], [f"goal:{self.goal_row.id}:50"])
        self.assertEqual(rows[0].details["percent"], 50)
        self.assertEqual(rows[0].details["title"], "Test Set")

    def test_a_jump_announces_only_the_highest_threshold(self):
        self.evaluate()
        self.own_n(1, 9)
        self.evaluate()
        self.assertEqual([r.subject_key for r in self.queue()], [f"goal:{self.goal_row.id}:90"])
        self.db.refresh(self.goal_row)
        self.assertEqual(self.goal_row.milestones, [50, 75, 90])

    def test_completing_sets_completed_at_and_a_hundred_percent_push(self):
        self.evaluate()
        self.own_n(1, 10)
        self.evaluate()
        self.db.refresh(self.goal_row)
        self.assertIsNotNone(self.goal_row.completed_at)
        self.assertEqual([r.details["percent"] for r in self.queue()], [100])

    def test_a_goal_that_grows_back_does_not_push_old_thresholds_again(self):
        self.own_n(1, 5)
        self.evaluate()
        self.db.add(_card("tst-011", price=1.0))
        self.db.commit()
        self.evaluate()
        self.assertEqual(self.queue(), [])

    def test_category_off_queues_nothing(self):
        self.db.add(UserSetting(user_id=self.user.id, key="notify_goal_milestones", value="false"))
        self.db.commit()
        self.evaluate()
        self.own_n(1, 6)
        self.evaluate()
        self.assertEqual(self.queue(), [])

    def test_the_progress_evaluator_runs_it(self):
        evaluate_user(self.db, self.user.id)
        self.own_n(1, 5)
        evaluate_user(self.db, self.user.id)
        self.assertEqual(len(self.queue()), 1)

    def test_push_text_names_the_goal_unless_details_are_off(self):
        details = {"goal_id": 7, "title": "Test Set", "percent": 75}
        detailed = json.loads(notifications.build_goal_payload(details, True))["notification"]
        self.assertIn("Test Set", detailed["body"])
        self.assertIn("75%", detailed["body"])
        self.assertEqual(detailed["navigate"], "/goals/7")
        light = json.loads(notifications.build_goal_payload(details, False))["notification"]
        self.assertNotIn("Test Set", json.dumps(light))
        self.assertNotIn("75", json.dumps(light))
        done = json.loads(notifications.build_goal_payload({**details, "percent": 100}, True))["notification"]
        self.assertEqual(done["title"], "Goal complete")

    def test_flush_sends_a_light_push_when_details_are_off(self):
        self.evaluate()
        self.own_n(1, 5)
        self.evaluate()
        self.db.add(UserSetting(user_id=self.user.id, key="notify_show_details", value="false"))
        self.db.commit()
        with patch.object(notifications, "in_quiet_hours", return_value=False), \
                patch.object(notifications, "_send") as send:
            notifications.flush_due(self.db, now=NOW + datetime.timedelta(hours=1))
        self.assertEqual(send.call_count, 1)
        self.assertNotIn("Test Set", send.call_args[0][2])


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ApiTests(ApiBase):
    def create(self, kind="set", params=None, **extra):
        return self.client.post("/api/goals", json={"kind": kind, "params": params or {"set_id": "tst", "lang": "en"}, **extra})

    def test_create_list_get_pin_delete(self):
        created = self.create(pinned=True)
        self.assertEqual(created.status_code, 201, created.text)
        goal_id = created.json()["id"]
        self.assertEqual(created.json()["title"], "Test Set")
        self.assertEqual(created.json()["progress"]["total"], 2)

        listed = self.client.get("/api/goals").json()["goals"]
        self.assertEqual([g["id"] for g in listed], [goal_id])
        detail = self.client.get(f"/api/goals/{goal_id}").json()
        self.assertEqual(len(detail["progress"]["cheapest_missing"]), 2)

        patched = self.client.patch(f"/api/goals/{goal_id}", json={"pinned": False})
        self.assertFalse(patched.json()["pinned"])
        self.assertEqual(self.client.delete(f"/api/goals/{goal_id}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/goals/{goal_id}").status_code, 404)

    def test_creating_records_current_thresholds_without_a_push(self):
        self.own("tst-001")
        self.own("tst-002")
        created = self.create().json()
        self.assertIsNotNone(created["completed_at"])
        self.assertEqual(self.db.query(NotificationQueue).count(), 0)
        self.assertEqual(self.db.get(UserGoal, created["id"]).milestones, [50, 75, 90, 100])

    def test_invalid_and_duplicate_goals_are_refused(self):
        self.assertEqual(self.create("set", {"set_id": "nope"}).status_code, 422)
        self.assertEqual(self.create("bogus", {}).status_code, 422)
        self.assertEqual(self.create().status_code, 201)
        self.assertEqual(self.create().status_code, 409)

    def test_goals_are_private(self):
        goal = GoalBase.goal(self, "set", {"set_id": "tst", "lang": "en"}, user=self.other)
        self.assertEqual(self.client.get(f"/api/goals/{goal.id}").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/goals/{goal.id}").status_code, 404)
        self.assertEqual(self.client.get("/api/goals").json()["goals"], [])

    def test_options_and_artist_search(self):
        self.db.add(_card("art-001", set_id="art", artist="Mitsuhiro Arita"))
        self.db.commit()
        options = self.client.get("/api/goals/options?artist=arita").json()
        self.assertEqual(len(options["generations"]), 9)
        self.assertIn("eeveelutions", [f["id"] for f in options["families"]])
        self.assertEqual(options["artists"], [{"artist": "Mitsuhiro Arita", "cards": 1}])

    def test_wishlist_action_adds_only_missing_cards_not_already_listed(self):
        goal_id = self.create().json()["id"]
        self.own("tst-001")
        self.db.add(WishlistItem(card_id="tst-002_en", user_id=self.user.id, quantity=2))
        self.db.commit()
        self.assertEqual(self.client.get(f"/api/goals/{goal_id}/wishlist").json(), {"to_add": 0})
        self.db.add(_card("tst-003", price=1.0))
        self.db.commit()
        self.assertEqual(self.client.get(f"/api/goals/{goal_id}/wishlist").json(), {"to_add": 1})
        self.assertEqual(self.client.post(f"/api/goals/{goal_id}/wishlist").json(), {"added": 1})
        self.assertEqual(self.client.post(f"/api/goals/{goal_id}/wishlist").json(), {"added": 0})
        rows = {w.card_id: w.quantity for w in self.db.query(WishlistItem).filter_by(user_id=self.user.id)}
        self.assertEqual(rows, {"tst-002_en": 2, "tst-003_en": 1})

    def test_planned_binder_from_a_goal(self):
        goal_id = self.create().json()["id"]
        self.own("tst-001")
        response = self.client.post(f"/api/goals/{goal_id}/binder", json={})
        self.assertEqual(response.status_code, 201, response.text)
        binder = self.db.get(Binder, response.json()["binder_id"])
        self.assertEqual((binder.name, binder.binder_type, binder.user_id), ("Test Set", "wishlist", self.user.id))
        cards = {bc.card_id for bc in self.db.query(BinderCard).filter_by(binder_id=binder.id)}
        self.assertEqual(cards, {"tst-001_en", "tst-002_en"})

    def test_binder_from_a_goal_with_no_cards_is_refused(self):
        goal_id = self.create("generation", {"generation": 9}).json()["id"]
        self.assertEqual(self.client.post(f"/api/goals/{goal_id}/binder", json={}).status_code, 422)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class BackupAndDeletionTests(ApiBase):
    def test_goals_are_in_the_users_backup_group(self):
        self.assertIn("user_goals", BACKUP_GROUPS["users"])

    def test_deleting_a_user_removes_their_goals(self):
        other_id = self.other.id
        GoalBase.goal(self, "set", {"set_id": "tst", "lang": "en"}, user=self.other)
        GoalBase.goal(self, "set", {"set_id": "tst", "lang": "en"})
        with patch("services.scan_trace.revoke_user_traces"):
            response = self.client.delete(f"/api/auth/users/{other_id}")
        self.assertEqual(response.status_code, 200, response.text)
        self.db.expire_all()
        self.assertEqual(self.db.query(UserGoal).filter_by(user_id=other_id).count(), 0)
        self.assertEqual(self.db.query(UserGoal).filter_by(user_id=self.user.id).count(), 1)


if __name__ == "__main__":
    unittest.main()
