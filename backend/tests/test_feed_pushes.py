import datetime
import json
import unittest
from unittest.mock import patch

try:
    from models import EventComment, EventReaction, NotificationQueue, Setting, User, UserSetting
    from services import feed as feed_service
    from services import notifications
    from services.social_feature import SOCIAL_SETTING_KEY
    from test_feed import FeedBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    FeedBase = object

T0 = datetime.datetime(2026, 10, 30, 12, 0)  # midday UTC, outside quiet hours for a UTC trainer


def minutes(n):
    return T0 + datetime.timedelta(minutes=n)


def seconds(n):
    return T0 + datetime.timedelta(seconds=n)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class FeedPushBase(FeedBase):
    """ash (self.user) owns the events; misty (self.other), brock and dawn react and comment."""

    def setUp(self):
        super().setUp()
        self.dawn = User(username="dawn", hashed_password="x", role="trainer", is_active=True)
        self.db.add(self.dawn)
        self.db.add(UserSetting(user_id=self.user.id, key="time_zone", value="UTC"))
        self.db.commit()
        self.sent = []
        patcher = patch.object(
            notifications, "_send",
            side_effect=lambda db, uid, payload: self.sent.append((uid, json.loads(payload))) or {"sent": 1, "removed": 0},
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def react(self, event, actor, kind="cheer", at=T0):
        feed_service.add_reaction(self.db, event.id, actor.id, kind)
        queued = notifications.notify_feed_reaction(self.db, event, actor, kind, now=at)
        self.db.commit()
        return queued

    def comment(self, event, actor, text="Nice!", at=T0):
        row = feed_service.add_comment(self.db, event, actor.id, text)
        queued = notifications.notify_feed_comment(self.db, event, actor, row, now=at)
        self.db.commit()
        return queued, row

    def flush(self, at):
        self.sent.clear()
        notifications.flush_due(self.db, now=at)
        return [p["notification"] for uid, p in self.sent if uid == self.user.id]

    def setting(self, user, key, value):
        self.db.add(UserSetting(user_id=user.id, key=key, value=value))
        self.db.commit()


class FeedPushTests(FeedPushBase):
    def test_the_first_reaction_pushes_at_once_with_a_link_to_the_event(self):
        event = self.set_event(self.user)
        self.assertTrue(self.react(event, self.other))
        pushes = self.flush(T0)
        self.assertEqual(len(pushes), 1)
        self.assertEqual(pushes[0]["body"], "misty reacted to your Test Set completion")
        self.assertEqual(pushes[0]["navigate"], f"/leaderboard/activity?event={event.id}")

    def test_a_comment_push_opens_the_comments_sheet(self):
        event = self.set_event(self.user)
        self.comment(event, self.other)
        pushes = self.flush(T0)
        self.assertEqual(pushes[0]["body"], "misty commented on your Test Set completion")
        self.assertEqual(pushes[0]["navigate"], f"/leaderboard/activity?event={event.id}&comments=1")

    def test_more_activity_inside_the_window_is_folded_into_one_follow_up(self):
        event = self.set_event(self.user)
        self.react(event, self.other)
        self.assertEqual(len(self.flush(T0)), 1)
        self.react(event, self.brock, at=seconds(8))
        self.react(event, self.dawn, kind="fire", at=seconds(20))
        self.assertEqual(self.flush(seconds(20)), [])
        self.assertEqual(self.flush(seconds(29)), [])
        pushes = self.flush(seconds(notifications.FEED_PUSH_WINDOW_SECONDS))
        self.assertEqual([p["body"] for p in pushes], ["brock and dawn reacted to your Test Set completion"])
        self.assertEqual(self.flush(minutes(40)), [])

    def test_the_window_is_thirty_seconds(self):
        self.assertEqual(notifications.FEED_PUSH_WINDOW_SECONDS, 30)

    def test_activity_after_the_window_leads_again(self):
        event = self.set_event(self.user)
        self.react(event, self.other)
        self.flush(T0)
        self.react(event, self.brock, at=seconds(45))
        self.assertEqual(len(self.flush(seconds(45))), 1)

    def test_three_names_become_and_n_others(self):
        rows = [{"kind": "reaction", "actor": name, "label": "Base Set completion"} for name in ("Misty", "Brock", "Dawn")]
        body = json.loads(notifications.build_feed_activity_payload(rows, True, 7))["notification"]["body"]
        self.assertEqual(body, "Misty and 2 others reacted to your Base Set completion")

    def test_comments_are_counted_and_the_link_opens_them(self):
        event = self.pull(self.user)
        self.comment(event, self.other)
        self.flush(T0)
        self.comment(event, self.brock, at=seconds(5))
        self.comment(event, self.dawn, at=seconds(10))
        self.comment(event, self.dawn, at=seconds(15))
        pushes = self.flush(seconds(30))
        self.assertEqual(pushes[0]["body"], "3 new comments on your Big-001 pull")
        self.assertTrue(pushes[0]["navigate"].endswith("&comments=1"))

    def test_your_own_reactions_and_comments_never_push(self):
        event = self.set_event(self.user)
        self.assertFalse(self.react(event, self.user))
        self.assertFalse(self.comment(event, self.user)[0])
        self.assertEqual(self.db.query(NotificationQueue).count(), 0)

    def test_the_category_switch_stops_the_push(self):
        event = self.set_event(self.user)
        self.setting(self.user, "notify_feed_activity", "false")
        self.assertFalse(self.react(event, self.other))
        self.assertEqual(self.flush(T0), [])

    def test_the_category_is_on_by_default(self):
        self.assertTrue(notifications.CATEGORIES["feed_activity"].default)
        self.assertTrue(notifications.category_enabled(self.db, self.user.id, "feed_activity"))
        self.assertIn("feed_activity", notifications.UI_CATEGORIES)
        self.assertEqual(notifications.default_settings()["notify_feed_activity"], "true")

    def test_nothing_is_queued_or_sent_while_the_social_switch_is_off(self):
        event = self.set_event(self.user)
        self.react(event, self.other)
        self.db.query(Setting).filter_by(key=SOCIAL_SETTING_KEY).update({"value": "false"})
        self.db.commit()
        self.assertEqual(self.flush(T0), [])
        self.assertFalse(self.react(event, self.brock))

    def test_a_reaction_removed_before_its_push_goes_out_does_not_push(self):
        event = self.set_event(self.user)
        self.react(event, self.other)
        feed_service.remove_reaction(self.db, event.id, self.other.id, "cheer")
        notifications.cancel_feed_reaction(self.db, event.id, self.other.id, "cheer")
        self.db.commit()
        self.assertEqual(self.flush(T0), [])
        # Reacting again later is a new reaction and pushes.
        self.react(event, self.other, at=minutes(1))
        self.assertEqual(len(self.flush(minutes(1))), 1)

    def test_a_follow_up_whose_reaction_was_removed_does_not_push(self):
        event = self.set_event(self.user)
        self.react(event, self.other)
        self.flush(T0)
        self.react(event, self.brock, at=seconds(5))
        feed_service.remove_reaction(self.db, event.id, self.brock.id, "cheer")
        self.db.commit()  # the row is still queued; the flush notices it is gone
        self.assertEqual(self.flush(seconds(30)), [])

    def test_a_deleted_comment_does_not_push(self):
        event = self.set_event(self.user)
        _, row = self.comment(event, self.other)
        self.db.query(EventComment).filter_by(id=row.id).delete()
        self.db.commit()
        self.assertEqual(self.flush(T0), [])

    def test_quiet_hours_hold_the_push_until_morning(self):
        self.setting(self.user, "notify_quiet_hours", "true")
        event = self.set_event(self.user)
        night = datetime.datetime(2026, 10, 30, 23, 30)
        self.react(event, self.other, at=night)
        self.assertEqual(self.flush(night), [])
        self.assertEqual(len(self.flush(datetime.datetime(2026, 10, 31, 8, 0))), 1)

    def test_the_hourly_cap_holds_the_rest_as_one_summary(self):
        cap = notifications.FEED_PUSH_HOURLY_CAP
        events = [self.set_event(self.user, minutes=i, name=f"Set {i}") for i in range(cap + 2)]
        for event in events:
            self.react(event, self.other)
        pushes = self.flush(T0)
        self.assertEqual(len(pushes), cap)
        held = self.db.query(NotificationQueue).filter(NotificationQueue.sent_at.is_(None)).all()
        self.assertEqual(len(held), 2)
        self.assertEqual({r.send_after for r in held}, {minutes(60)})
        self.assertEqual(self.flush(minutes(30)), [])
        summary = self.flush(minutes(60))
        self.assertEqual([p["body"] for p in summary], ["2 new reactions and comments"])
        self.assertEqual(summary[0]["navigate"], "/leaderboard/activity")

    def test_content_light_wording_names_nobody_and_no_amount(self):
        event = self.pull(self.user)
        self.setting(self.user, "notify_show_details", "false")
        self.react(event, self.other)
        body = self.flush(T0)[0]["body"]
        self.assertEqual(body, "Someone reacted to your activity")
        self.assertNotIn("misty", body)
        self.assertNotIn("Big-001", body)

    def test_detailed_wording_never_names_an_amount(self):
        event = self.event(
            self.user, "big_pull", {"card_id": "big-001_en", "name": "Big-001", "variant": "Normal", "amount": 30.0},
            subject="1",
        )
        self.react(event, self.other)
        body = self.flush(T0)[0]["body"]
        self.assertEqual(body, "misty reacted to your Big-001 pull")
        self.assertNotIn("30", body)
        self.assertFalse(any(sign in body for sign in "€£$"))

    def test_an_event_that_is_no_longer_shared_does_not_push(self):
        event = self.set_event(self.user)
        self.react(event, self.other)
        self.setting(self.user, "feed_share_set_completed", "false")
        self.assertEqual(self.flush(T0), [])


class FeedPushApiTests(FeedPushBase):
    def test_the_routes_queue_and_cancel_pushes(self):
        event = self.set_event(self.other)
        self.assertEqual(self.client.put(f"/api/feed/{event.id}/reactions/cheer").status_code, 200)
        rows = self.db.query(NotificationQueue).all()
        self.assertEqual([(r.user_id, r.category) for r in rows], [(self.other.id, "feed_activity")])
        self.assertEqual(self.client.delete(f"/api/feed/{event.id}/reactions/cheer").status_code, 200)
        self.assertEqual(self.db.query(NotificationQueue).count(), 0)
        response = self.client.post(f"/api/feed/{event.id}/comments", json={"text": "Great!"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.db.query(NotificationQueue).count(), 1)

    def test_reacting_to_your_own_event_queues_nothing(self):
        event = self.set_event(self.user)
        self.client.post(f"/api/feed/{event.id}/comments", json={"text": "Mine"})
        self.assertEqual(self.db.query(NotificationQueue).count(), 0)

    def test_a_single_event_can_be_fetched_for_a_push_link(self):
        event = self.set_event(self.user)
        response = self.client.get(f"/api/feed/{event.id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], event.id)
        self.assertTrue(response.json()["mine"])
        self.assertEqual(self.client.get("/api/feed/99999").status_code, 404)
        hidden = self.set_event(self.other)
        self.setting(self.other, "feed_share_set_completed", "false")
        self.assertEqual(self.client.get(f"/api/feed/{hidden.id}").status_code, 404)


class SharedByDefaultTests(FeedPushBase):
    def test_every_sharing_default_is_on(self):
        defaults = feed_service.default_settings()
        self.assertTrue(defaults)
        self.assertEqual(set(defaults.values()), {"true"})
        self.assertEqual(set(defaults), set(feed_service.preference_keys()))

    def test_a_saved_choice_to_hide_is_kept(self):
        self.setting(self.other, "feed_share_big_pull", "false")
        self.setting(self.other, "feed_share_values", "false")
        sharing = feed_service.trainers_sharing(self.db)
        self.assertIn(self.other.id, sharing["off"]["big_pull"])
        self.assertIn(self.other.id, sharing["values_off"])
        self.assertNotIn(self.brock.id, sharing["values_off"])


if __name__ == "__main__":
    unittest.main()
