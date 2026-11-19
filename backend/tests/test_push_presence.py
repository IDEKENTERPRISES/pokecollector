import datetime
import os
import unittest
from unittest.mock import patch

from tests.test_push import APPLE, DEPS_AVAILABLE, FCM, MOZILLA, PushDatabaseTestCase

if DEPS_AVAILABLE:
    from api import push as push_api
    from models import NotificationQueue, PushSubscription
    from services import notifications
    from services import push as push_service

NOW = datetime.datetime.utcnow()


class PushPresenceTests(PushDatabaseTestCase):
    def setUp(self):
        super().setUp()
        env = patch.dict(os.environ, {}, clear=False)
        env.start()
        os.environ.pop("PUSH_FOREGROUND_WINDOW_SECONDS", None)
        self.addCleanup(env.stop)

    def presence(self, sub, state, seconds_ago=0):
        sub.app_state = state
        sub.foreground_at = NOW - datetime.timedelta(seconds=seconds_ago)
        self.db.commit()

    def send(self, user=None, **kwargs):
        with patch.object(push_service, "webpush") as sender:
            result = push_service.send_to_user(self.db, (user or self.user).id, {"x": 1}, **kwargs)
        return result, sender

    def test_foreground_device_is_skipped(self):
        self.presence(self.add_sub(), "foreground", 5)
        result, sender = self.send()
        sender.assert_not_called()
        self.assertEqual(result["sent"], 0)
        self.assertEqual(result["skipped_foreground"], 1)

    def test_skip_is_logged_and_counted(self):
        self.presence(self.add_sub(), "foreground", 5)
        before = push_service.presence_stats["skipped_foreground"]
        with self.assertLogs("services.push", level="INFO") as logs:
            self.send()
        self.assertEqual(push_service.presence_stats["skipped_foreground"], before + 1)
        self.assertTrue(any("app_in_foreground" in line for line in logs.output))

    def test_background_device_is_sent(self):
        self.presence(self.add_sub(), "background", 5)
        result, sender = self.send()
        sender.assert_called_once()
        self.assertEqual(result, {"sent": 1, "removed": 0})

    def test_stale_heartbeat_is_sent(self):
        self.presence(self.add_sub(), "foreground", 61)
        result, sender = self.send()
        sender.assert_called_once()
        self.assertEqual(result["sent"], 1)

    def test_device_that_never_reported_is_sent(self):
        self.add_sub()
        _result, sender = self.send()
        sender.assert_called_once()

    def test_other_device_of_the_same_user_is_sent(self):
        self.presence(self.add_sub(endpoint=APPLE), "foreground", 5)
        self.add_sub(endpoint=FCM)
        result, sender = self.send()
        self.assertEqual(sender.call_count, 1)
        self.assertEqual(sender.call_args.kwargs["subscription_info"]["endpoint"], FCM)
        self.assertEqual((result["sent"], result["skipped_foreground"]), (1, 1))

    def test_other_users_foreground_does_not_matter(self):
        self.presence(self.add_sub(user=self.other, endpoint=MOZILLA), "foreground", 5)
        self.add_sub()
        _result, sender = self.send()
        sender.assert_called_once()

    def test_window_is_configurable(self):
        self.presence(self.add_sub(), "foreground", 20)
        with patch.dict(os.environ, {"PUSH_FOREGROUND_WINDOW_SECONDS": "10"}):
            _result, sender = self.send()
        sender.assert_called_once()
        with patch.dict(os.environ, {"PUSH_FOREGROUND_WINDOW_SECONDS": "0"}):
            self.assertEqual(push_service.foreground_window_seconds(), 0)
            _result, sender = self.send()
        sender.assert_called_once()  # 0 turns the skip off

    def test_bad_window_value_falls_back_to_default(self):
        with patch.dict(os.environ, {"PUSH_FOREGROUND_WINDOW_SECONDS": "soon"}):
            self.assertEqual(push_service.foreground_window_seconds(), 60)

    def test_test_notification_always_sent(self):
        self.presence(self.add_sub(), "foreground", 1)
        with patch.object(push_service, "webpush") as sender:
            result = push_service.send_test(self.db, self.user.id)
        sender.assert_called_once()
        self.assertEqual(result["sent"], 1)

    def test_record_presence_endpoint_logic(self):
        sub = self.add_sub()
        self.assertTrue(push_service.record_presence(self.db, self.user.id, APPLE, "foreground"))
        self.db.refresh(sub)
        self.assertEqual(sub.app_state, "foreground")
        self.assertIsNotNone(sub.foreground_at)
        self.assertTrue(push_service.record_presence(self.db, self.user.id, APPLE, "background"))
        self.db.refresh(sub)
        self.assertEqual(sub.app_state, "background")
        # Someone else's endpoint, an unknown one, and a bad state change nothing.
        self.assertFalse(push_service.record_presence(self.db, self.other.id, APPLE, "foreground"))
        self.assertFalse(push_service.record_presence(self.db, self.user.id, FCM, "foreground"))
        with self.assertRaises(ValueError):
            push_service.record_presence(self.db, self.user.id, APPLE, "asleep")

    def test_presence_route_stores_state(self):
        sub = self.add_sub()
        body = push_api.PushPresenceRequest(endpoint=APPLE, state="foreground")
        response = push_api.set_presence(body, current_user=self.user, db=self.db)
        self.assertEqual(response.status_code, 204)
        self.db.refresh(sub)
        self.assertEqual(sub.app_state, "foreground")
        with self.assertRaises(ValueError):
            push_api.PushPresenceRequest(endpoint=APPLE, state="asleep")

    def test_in_app_notification_still_created_when_push_is_skipped(self):
        self.presence(self.add_sub(), "foreground", 5)
        notifications.queue_announcement(self.db, self.user.id, 1, "Free packs", "Open the app", "/collection")
        self.db.commit()
        with patch.object(push_service, "get_or_create_vapid_keys", return_value=(object(), "pub")), \
                patch.object(push_service, "webpush") as sender:
            notifications.flush_due(self.db, now=datetime.datetime.utcnow() + datetime.timedelta(minutes=1))
        sender.assert_not_called()
        row = self.db.query(NotificationQueue).filter_by(user_id=self.user.id, category="announcements").one()
        self.assertEqual(row.details["title"], "Free packs")  # the entry the app lists is still there
        self.assertIsNotNone(row.sent_at)


if __name__ == "__main__":
    unittest.main()
