import datetime
import unittest
from unittest.mock import patch

try:
    from sqlalchemy.exc import IntegrityError

    import main
    from api.auth import get_current_user
    from api.backup import BACKUP_GROUPS
    from models import (
        EventReaction,
        Setting,
        User,
        UserAchievement,
        UserEvent,
        UserGoal,
        UserSetting,
    )
    from services import feed as feed_service
    from services.progress.evaluator import evaluate_user
    from services.social_feature import SOCIAL_SETTING_KEY
    from test_goals import GoalBase
    from test_small_delights import ApiBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    ApiBase = GoalBase = object

NOW = datetime.datetime(2026, 10, 30, 12, 0)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class FeedBase(ApiBase):
    """ash (admin, the viewer), misty and brock are trainers; the social switch is on."""

    def setUp(self):
        super().setUp()
        patcher = patch("api.auth.multi_user_enabled", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.brock = User(username="brock", hashed_password="x", role="trainer", is_active=True, avatar_id=3)
        self.db.add(self.brock)
        self.db.add(Setting(key=SOCIAL_SETTING_KEY, value="true"))
        self.db.commit()
        self.counter = 0

    def event(self, user, kind, payload=None, subject=None, minutes=0, **extra):
        self.counter += 1
        row = UserEvent(
            user_id=user.id, kind=kind, subject_key=subject, payload=payload or {},
            occurred_at=NOW + datetime.timedelta(minutes=minutes), dedupe_key=f"{kind}:{self.counter}", **extra,
        )
        self.db.add(row)
        self.db.commit()
        return row

    def set_event(self, user, minutes=0, name="Test Set"):
        return self.event(
            user, "set_completed", {"set_name": name, "lang": "en", "total": 2}, subject="tst_en", minutes=minutes
        )

    def badge(self, user, achievement_id="collector_10", backfilled=False, minutes=0):
        self.db.add(UserAchievement(
            user_id=user.id, achievement_id=achievement_id, unlocked_at=NOW, backfilled=backfilled,
        ))
        self.db.commit()
        return self.event(
            user, "achievement_unlocked",
            {"achievement_id": achievement_id, "badge_id": 2, "name_key": "achievements.collector10"},
            subject=achievement_id, minutes=minutes,
        )

    def pull(self, user, card_id="big-001_en", minutes=0):
        return self.event(
            user, "big_pull", {"card_id": card_id, "name": "Big-001", "variant": "Normal"},
            subject="1", minutes=minutes,
        )

    def goal_done(self, user, minutes=0):
        return self.event(
            user, "goal_completed", {"goal_id": 1, "goal_kind": "set", "title": "Test Set"},
            subject="1", minutes=minutes,
        )

    def share(self, user, key, value):
        row = self.db.query(UserSetting).filter_by(user_id=user.id, key=key).first()
        if row:
            row.value = value
        else:
            self.db.add(UserSetting(user_id=user.id, key=key, value=value))
        self.db.commit()

    def as_user(self, user):
        main.app.dependency_overrides[get_current_user] = lambda: user

    def feed(self, **params):
        response = self.client.get("/api/feed", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def ids(self, **params):
        return [item["id"] for item in self.feed(**params)["items"]]


class SwitchTests(FeedBase):
    def test_everything_answers_404_while_the_switch_is_off(self):
        event = self.set_event(self.other)
        self.db.query(Setting).filter_by(key=SOCIAL_SETTING_KEY).update({"value": "false"})
        self.db.commit()
        self.assertEqual(self.client.get("/api/feed").status_code, 404)
        self.assertEqual(self.client.put(f"/api/feed/{event.id}/reactions/cheer").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/feed/{event.id}/reactions/cheer").status_code, 404)
        self.assertEqual(self.db.query(EventReaction).count(), 0)

    def test_needs_multi_user_mode(self):
        with patch("api.auth.multi_user_enabled", return_value=False):
            self.assertEqual(self.client.get("/api/feed").status_code, 404)


class VisibilityTests(FeedBase):
    def test_defaults_share_set_completions_and_badges_only(self):
        s = self.set_event(self.other, minutes=1)
        b = self.badge(self.other, minutes=2)
        self.goal_done(self.other, minutes=3)
        self.pull(self.other, minutes=4)
        self.assertEqual(self.ids(), [b.id, s.id])

    def test_own_events_and_inactive_trainers_are_left_out(self):
        self.set_event(self.user)
        gone = self.set_event(self.other)
        self.assertEqual(self.ids(), [gone.id])
        self.other.is_active = False
        self.db.commit()
        self.assertEqual(self.ids(), [])

    def test_a_trainer_can_opt_in_to_goals_and_big_pulls(self):
        self.share(self.other, "feed_share_goal_completed", "true")
        self.share(self.other, "feed_share_big_pull", "true")
        g = self.goal_done(self.other, minutes=1)
        p = self.pull(self.other, minutes=2)
        # Opting in is per trainer: brock's are still hidden.
        self.goal_done(self.brock, minutes=3)
        self.assertEqual(self.ids(), [p.id, g.id])

    def test_turning_a_kind_off_hides_past_events_and_back_on_shows_them_again(self):
        s = self.set_event(self.other, minutes=1)
        b = self.badge(self.other, minutes=2)
        self.share(self.other, "feed_share_set_completed", "false")
        self.assertEqual(self.ids(), [b.id])
        self.share(self.other, "feed_share_achievement_unlocked", "false")
        self.assertEqual(self.ids(), [])
        self.share(self.other, "feed_share_set_completed", "true")
        self.assertEqual(self.ids(), [s.id])

    def test_one_trainers_choice_does_not_touch_another_trainers_events(self):
        mine = self.set_event(self.other, minutes=1)
        theirs = self.set_event(self.brock, minutes=2)
        self.share(self.other, "feed_share_set_completed", "false")
        self.assertEqual(self.ids(), [theirs.id])
        self.assertNotIn(mine.id, self.ids())

    def test_nothing_of_a_hidden_trainer_is_exposed(self):
        self.share(self.other, "feed_share_set_completed", "false")
        self.share(self.other, "feed_share_achievement_unlocked", "false")
        self.set_event(self.other)
        self.badge(self.other)
        body = self.client.get("/api/feed").text
        self.assertNotIn("misty", body)
        self.assertEqual(self.feed()["items"], [])

    def test_unknown_event_kinds_never_appear(self):
        self.event(self.other, "daily_streak", {"days": 7})
        self.assertEqual(self.ids(), [])

    def test_backfilled_or_unrecorded_unlocks_never_appear(self):
        self.badge(self.other, "collector_10", backfilled=True)
        # An event with no unlock row behind it is not an unlock the trainer earned.
        self.event(self.other, "achievement_unlocked", {"achievement_id": "collector_50"}, subject="collector_50")
        self.assertEqual(self.ids(), [])

    def test_the_first_evaluation_writes_nothing_for_the_feed(self):
        self.own("tst-001", user=self.other)
        self.own("tst-002", user=self.other)  # completes tst_en
        self.own("big-001", user=self.other)
        evaluate_user(self.db, self.other.id)
        self.assertEqual(self.ids(), [])
        self.assertGreater(self.db.query(UserAchievement).filter_by(user_id=self.other.id).count(), 0)

    def test_a_later_unlock_and_set_completion_do_appear(self):
        evaluate_user(self.db, self.other.id)
        self.own("tst-001", user=self.other)
        self.own("tst-002", user=self.other)
        evaluate_user(self.db, self.other.id)
        kinds = sorted(item["kind"] for item in self.feed()["items"])
        self.assertIn("set_completed", kinds)
        self.assertIn("achievement_unlocked", kinds)

    def test_item_shape(self):
        self.badge(self.other)
        self.set_event(self.other, minutes=1)
        body = self.feed()
        self.assertEqual(body["reaction_kinds"], list(feed_service.REACTION_KINDS))
        set_item, badge_item = body["items"]
        self.assertEqual(set_item["trainer"], {"id": self.other.id, "username": "misty", "avatar_id": None})
        self.assertEqual(set_item["display"]["set_name"], "Test Set")
        self.assertEqual(set_item["display"]["total"], 2)
        self.assertEqual(set_item["occurred_at"], (NOW + datetime.timedelta(minutes=1)).isoformat())
        self.assertEqual(badge_item["display"]["achievement_id"], "collector_10")
        self.assertEqual(badge_item["display"]["tier"], "bronze")
        self.assertEqual(badge_item["display"]["name_key"], "achievements.collector10")
        self.assertEqual(badge_item["reactions"], {"counts": {k: 0 for k in feed_service.REACTION_KINDS}, "mine": []})


class ValueMaskingTests(FeedBase):
    def setUp(self):
        super().setUp()
        self.share(self.other, "feed_share_big_pull", "true")

    def test_amounts_are_left_out_unless_the_trainer_shares_values(self):
        self.pull(self.other)
        item = self.feed()["items"][0]
        self.assertNotIn("amount", item["display"])
        self.assertEqual(item["display"]["card"]["id"], "big-001_en")
        self.assertEqual(item["display"]["card"]["name"], "Big-001")
        self.assertIn("images_small", item["display"]["card"])
        self.assertNotIn("price_trend", item["display"]["card"])
        self.assertNotIn("price_market", item["display"]["card"])
        self.assertEqual(item["display"]["variant"], "Normal")

    def test_amounts_appear_once_the_trainer_shares_values_and_vanish_again(self):
        self.pull(self.other)
        self.share(self.other, "feed_share_values", "true")
        self.assertEqual(self.feed()["items"][0]["display"]["amount"], 30.0)
        self.share(self.other, "feed_share_values", "false")
        self.assertNotIn("amount", self.feed()["items"][0]["display"])

    def test_values_are_per_trainer(self):
        self.share(self.brock, "feed_share_big_pull", "true")
        self.share(self.brock, "feed_share_values", "true")
        mine = self.pull(self.other, minutes=1)
        theirs = self.pull(self.brock, minutes=2)
        by_id = {item["id"]: item for item in self.feed()["items"]}
        self.assertIn("amount", by_id[theirs.id]["display"])
        self.assertNotIn("amount", by_id[mine.id]["display"])

    def test_badges_that_state_money_need_shared_values(self):
        money = self.badge(self.other, "big_spender_100", minutes=1)
        plain = self.badge(self.other, "collector_10", minutes=2)
        self.assertEqual(self.ids(), [plain.id])
        self.share(self.other, "feed_share_values", "true")
        self.assertEqual(self.ids(), [plain.id, money.id])

    def test_a_big_pull_of_a_deleted_card_still_shows_its_name(self):
        self.event(self.other, "big_pull", {"card_id": "gone_en", "name": "Gone", "variant": "Normal"}, subject="9")
        item = self.feed()["items"][0]
        self.assertEqual(item["display"]["card"], {"id": "gone_en", "name": "Gone"})


class PagingTests(FeedBase):
    def test_newest_first_and_cursor_paging(self):
        made = [self.set_event(self.other, minutes=i) for i in range(5)]
        newest_first = [e.id for e in reversed(made)]
        first = self.feed(limit=2)
        self.assertEqual([i["id"] for i in first["items"]], newest_first[:2])
        self.assertEqual(first["next_before"], newest_first[1])
        second = self.feed(limit=2, before=first["next_before"])
        self.assertEqual([i["id"] for i in second["items"]], newest_first[2:4])
        third = self.feed(limit=2, before=second["next_before"])
        self.assertEqual([i["id"] for i in third["items"]], newest_first[4:])
        self.assertIsNone(third["next_before"])

    def test_no_next_cursor_when_the_page_is_exactly_full(self):
        self.set_event(self.other, minutes=1)
        self.set_event(self.other, minutes=2)
        self.assertIsNone(self.feed(limit=2)["next_before"])

    def test_events_with_the_same_time_page_without_gaps_or_repeats(self):
        made = [self.set_event(self.other, minutes=0) for _ in range(5)]
        seen, before = [], None
        for _ in range(5):
            page = self.feed(limit=2, **({"before": before} if before else {}))
            seen += [i["id"] for i in page["items"]]
            before = page["next_before"]
            if before is None:
                break
        self.assertEqual(seen, [e.id for e in reversed(made)])

    def test_a_cursor_after_the_event_was_deleted_still_works(self):
        made = [self.set_event(self.other, minutes=i) for i in range(3)]
        gone_id = made[1].id
        self.db.delete(made[1])
        self.db.commit()
        self.assertEqual(self.ids(before=gone_id), [made[0].id])

    def test_limit_is_bounded(self):
        self.assertEqual(self.client.get("/api/feed", params={"limit": 0}).status_code, 422)
        self.assertEqual(self.client.get("/api/feed", params={"limit": 500}).status_code, 422)


class ReactionTests(FeedBase):
    def react(self, event, kind="cheer", method="put"):
        return getattr(self.client, method)(f"/api/feed/{event.id}/reactions/{kind}")

    def test_toggle_on_and_off(self):
        event = self.set_event(self.other)
        response = self.react(event)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["counts"]["cheer"], 1)
        self.assertEqual(response.json()["mine"], ["cheer"])
        self.assertEqual(self.feed()["items"][0]["reactions"]["mine"], ["cheer"])
        response = self.react(event, method="delete")
        self.assertEqual(response.json(), {"counts": {k: 0 for k in feed_service.REACTION_KINDS}, "mine": []})
        self.assertEqual(self.db.query(EventReaction).count(), 0)

    def test_putting_twice_keeps_one_row_and_deleting_nothing_is_fine(self):
        event = self.set_event(self.other)
        self.react(event)
        self.assertEqual(self.react(event).json()["counts"]["cheer"], 1)
        self.assertEqual(self.db.query(EventReaction).count(), 1)
        self.assertEqual(self.react(event, "wow", method="delete").status_code, 200)

    def test_the_database_refuses_a_duplicate(self):
        event = self.set_event(self.other)
        self.db.add(EventReaction(event_id=event.id, user_id=self.user.id, kind="cheer"))
        self.db.commit()
        self.db.add(EventReaction(event_id=event.id, user_id=self.user.id, kind="cheer"))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()

    def test_several_kinds_and_several_trainers_are_counted(self):
        event = self.set_event(self.other)
        self.react(event, "cheer")
        self.react(event, "fire")
        self.as_user(self.brock)
        self.react(event, "cheer")
        body = self.feed()["items"][0]["reactions"]
        self.assertEqual(body["counts"]["cheer"], 2)
        self.assertEqual(body["counts"]["fire"], 1)
        self.assertEqual(body["counts"]["wow"], 0)
        self.assertEqual(body["mine"], ["cheer"])
        self.as_user(self.user)
        self.assertEqual(self.feed()["items"][0]["reactions"]["mine"], ["cheer", "fire"])

    def test_who_reacted_is_not_exposed(self):
        event = self.set_event(self.other)
        self.react(event)
        self.assertNotIn("ash", self.client.get("/api/feed").text)

    def test_unknown_reaction_kind_is_refused(self):
        event = self.set_event(self.other)
        self.assertEqual(self.react(event, "thumbs").status_code, 422)
        self.assertEqual(self.react(event, "thumbs", method="delete").status_code, 422)

    def test_you_cannot_react_to_your_own_events(self):
        event = self.set_event(self.user)
        self.assertEqual(self.react(event).status_code, 404)

    def test_you_cannot_react_to_what_you_cannot_see(self):
        hidden_kind = self.goal_done(self.other)
        backfilled = self.badge(self.other, backfilled=True)
        value_badge = self.badge(self.other, "big_spender_100")
        shared = self.set_event(self.brock)
        self.share(self.brock, "feed_share_set_completed", "false")
        for event in (hidden_kind, backfilled, value_badge, shared):
            self.assertEqual(self.react(event).status_code, 404, event.kind)
        self.assertEqual(self.client.put("/api/feed/99999/reactions/cheer").status_code, 404)
        self.assertEqual(self.db.query(EventReaction).count(), 0)

    def test_a_reaction_disappears_with_the_event_it_hid_behind(self):
        event = self.set_event(self.other)
        self.react(event)
        self.share(self.other, "feed_share_set_completed", "false")
        self.assertEqual(self.react(event, method="delete").status_code, 404)
        self.assertEqual(self.feed()["items"], [])
        self.share(self.other, "feed_share_set_completed", "true")
        self.assertEqual(self.feed()["items"][0]["reactions"]["mine"], ["cheer"])

    def test_reactions_queue_no_notification(self):
        from models import NotificationQueue

        event = self.set_event(self.other)
        self.react(event)
        self.assertEqual(self.db.query(NotificationQueue).count(), 0)


class PreferenceTests(FeedBase):
    def test_defaults_in_the_settings_response(self):
        settings = self.client.get("/api/settings/").json()
        self.assertEqual(
            {k: v for k, v in settings.items() if k.startswith("feed_share_")},
            {
                "feed_share_set_completed": "true",
                "feed_share_achievement_unlocked": "true",
                "feed_share_goal_completed": "false",
                "feed_share_big_pull": "false",
                "feed_share_values": "false",
            },
        )

    def test_a_trainer_stores_their_own_choice_as_a_boolean(self):
        self.as_user(self.other)
        response = self.client.put("/api/settings/", json={"feed_share_goal_completed": "yes", "feed_share_values": False})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["feed_share_goal_completed"], "true")
        self.assertEqual(response.json()["feed_share_values"], "false")
        self.assertEqual(
            self.db.query(UserSetting).filter_by(user_id=self.other.id, key="feed_share_goal_completed").one().value, "true"
        )
        self.assertEqual(self.db.query(UserSetting).filter_by(user_id=self.user.id, key="feed_share_goal_completed").count(), 0)
        response = self.client.post("/api/settings/feed_share_big_pull", json={"value": "on"})
        self.assertEqual(response.json(), {"key": "feed_share_big_pull", "value": "true"})

    def test_an_unknown_sharing_key_is_refused(self):
        self.assertEqual(self.client.put("/api/settings/", json={"feed_share_everything": "true"}).status_code, 422)
        self.assertEqual(self.client.post("/api/settings/feed_share_x", json={"value": "true"}).status_code, 422)
        self.assertEqual(self.db.query(UserSetting).filter(UserSetting.key.like("feed_share_%")).count(), 0)

    def test_the_choices_drive_the_feed_end_to_end(self):
        self.set_event(self.other)
        self.as_user(self.other)
        self.client.put("/api/settings/", json={"feed_share_set_completed": "false"})
        self.as_user(self.user)
        self.assertEqual(self.feed()["items"], [])


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class GoalEventTests(GoalBase):
    def goal_events(self):
        return self.db.query(UserEvent).filter_by(user_id=self.user.id, kind="goal_completed").all()

    def test_finishing_a_goal_writes_one_event(self):
        goal = self.goal("set", {"set_id": "tst", "lang": "en"})
        evaluate_user(self.db, self.user.id)  # silent first pass
        self.own("tst-001")
        self.own("tst-002")
        evaluate_user(self.db, self.user.id)
        evaluate_user(self.db, self.user.id)
        events = self.goal_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].subject_key, str(goal.id))
        self.assertEqual(events[0].payload["title"], "Test Set")

    def test_a_goal_already_complete_on_the_silent_first_pass_writes_none(self):
        self.goal("set", {"set_id": "tst", "lang": "en"})
        self.own("tst-001")
        self.own("tst-002")
        evaluate_user(self.db, self.user.id)
        self.db.expire_all()
        self.assertIsNotNone(self.db.query(UserGoal).one().completed_at)
        self.assertEqual(self.goal_events(), [])


class BackupAndDeletionTests(FeedBase):
    def test_the_reactions_table_is_in_the_users_backup_group(self):
        self.assertIn("event_reactions", BACKUP_GROUPS["users"])
        self.assertIn("user_events", BACKUP_GROUPS["users"])

    def test_deleting_a_trainer_removes_reactions_they_gave_and_received(self):
        victim = self.other
        victim_id = victim.id
        theirs = self.set_event(victim)
        other_event = self.set_event(self.brock)
        self.db.add_all([
            EventReaction(event_id=theirs.id, user_id=self.brock.id, kind="cheer"),  # received
            EventReaction(event_id=other_event.id, user_id=victim_id, kind="wow"),  # given
            EventReaction(event_id=other_event.id, user_id=self.user.id, kind="fire"),  # unrelated
        ])
        self.db.commit()
        with patch("services.scan_trace.revoke_user_traces"):
            response = self.client.delete(f"/api/auth/users/{victim_id}")
        self.assertEqual(response.status_code, 200, response.text)
        self.db.expire_all()
        rows = self.db.query(EventReaction).all()
        self.assertEqual([(r.event_id, r.user_id, r.kind) for r in rows], [(other_event.id, self.user.id, "fire")])
        self.assertEqual(self.db.query(UserEvent).filter_by(user_id=victim_id).count(), 0)
        self.assertEqual(self.ids(), [other_event.id])
