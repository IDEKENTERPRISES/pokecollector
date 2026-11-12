import datetime as dt
import os
import unittest
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from database import Base, get_db
    from models import AdminNotification, AuditLog, NotificationQueue, PushSubscription, User, UserSetting
    from services import notifications
    from services.auth import hash_password
    from services.login_throttle import login_throttle

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

PASSWORD = "correct horse battery"


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class AdminNotificationTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        db = self.Session()
        for name, role in (("admin", "admin"), ("misty", "trainer"), ("brock", "trainer"), ("gary", "trainer")):
            db.add(User(username=name, hashed_password=hash_password(PASSWORD), role=role, is_active=True))
        db.add(User(username="old", hashed_password=hash_password(PASSWORD), role="trainer", is_active=False))
        db.commit()
        self.ids = {u.username: u.id for u in db.query(User).all()}
        for name in ("admin", "misty", "brock"):  # gary has no push subscription
            db.add(PushSubscription(user_id=self.ids[name], endpoint=f"https://push.test/{name}", p256dh="p", auth="a"))
        db.commit()
        db.close()

        def override_get_db():
            session = self.Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_get_db
        self.env = patch.dict(os.environ, {"USER_MODE": "multi"})
        self.env.start()
        login_throttle.reset()
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.pop(get_db, None)
        self.env.stop()
        login_throttle.reset()

    def login(self, username):
        response = self.client.post("/api/auth/login", data={"username": username, "password": PASSWORD})
        self.assertEqual(response.status_code, 200, response.text)
        return {"Authorization": f"Bearer {response.json()['access_token']}"}

    def send(self, headers=None, **body):
        body = {"title": "Hello", "body": "Something new", **body}
        return self.client.post("/api/admin/notifications", json=body, headers=headers or self.login("admin"))

    def test_only_admins_can_send_or_list(self):
        trainer = self.login("misty")
        self.assertEqual(self.send(trainer).status_code, 403)
        self.assertEqual(self.client.get("/api/admin/notifications", headers=trainer).status_code, 403)
        self.assertEqual(self.client.post("/api/admin/notifications", json={}).status_code, 401)

    def test_validation(self):
        headers = self.login("admin")
        for body in (
            {"title": ""}, {"title": "   "}, {"title": "x" * 61}, {"body": ""}, {"body": "y" * 241},
            {"route": "https://evil.test"}, {"route": "/settings"}, {"recipients": []},
            {"recipients": [99999]}, {"recipients": [self.ids["old"]]}, {"recipients": "everyone"},
        ):
            self.assertEqual(self.send(headers, **body).status_code, 422, body)
        edge = self.send(headers, title="x" * 60, body="y" * 240)
        self.assertEqual(edge.status_code, 200, edge.text)

    def test_everyone_skips_unreachable_and_inactive(self):
        response = self.send(route="/sets")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        # admin, misty, brock, gary are active; gary has no push and no Telegram.
        self.assertEqual((data["recipient_count"], data["queued"], data["skipped"]), (4, 3, 1))
        db = self.Session()
        rows = db.query(NotificationQueue).filter_by(category="announcements").all()
        self.assertEqual({r.user_id for r in rows}, {self.ids[n] for n in ("admin", "misty", "brock")})
        self.assertEqual(rows[0].details["title"], "Hello")
        self.assertEqual(rows[0].details["body"], "Something new")
        self.assertEqual(rows[0].details["route"], "/sets")
        db.close()

    def test_chosen_trainers_only_and_admin_can_include_themselves(self):
        data = self.send(recipients=[self.ids["misty"], self.ids["admin"]]).json()
        self.assertEqual((data["recipient_count"], data["queued"], data["skipped"]), (2, 2, 0))
        db = self.Session()
        self.assertEqual(
            {r.user_id for r in db.query(NotificationQueue).all()}, {self.ids["misty"], self.ids["admin"]}
        )
        db.close()

    def test_trainers_who_switched_announcements_off_are_skipped(self):
        db = self.Session()
        db.add(UserSetting(user_id=self.ids["misty"], key="notify_announcements", value="false"))
        db.commit()
        db.close()
        data = self.send(recipients=[self.ids["misty"], self.ids["brock"]]).json()
        self.assertEqual((data["queued"], data["skipped"]), (1, 1))
        db = self.Session()
        self.assertEqual([r.user_id for r in db.query(NotificationQueue).all()], [self.ids["brock"]])
        db.close()

    def test_rate_limit_ten_an_hour(self):
        headers = self.login("admin")
        for _ in range(10):
            self.assertEqual(self.send(headers, recipients=[self.ids["misty"]]).status_code, 200)
        self.assertEqual(self.send(headers, recipients=[self.ids["misty"]]).status_code, 429)
        db = self.Session()
        for row in db.query(AdminNotification).all():
            row.created_at = dt.datetime.utcnow() - dt.timedelta(hours=2)
        db.commit()
        db.close()
        self.assertEqual(self.send(headers, recipients=[self.ids["misty"]]).status_code, 200)

    def test_audit_entry_and_history(self):
        self.send(title="Maintenance", body="Back at noon", recipients=[self.ids["misty"]])
        db = self.Session()
        entry = db.query(AuditLog).filter_by(action="admin.notification_sent").one()
        self.assertIn("Maintenance", entry.details)
        db.close()
        history = self.client.get("/api/admin/notifications", headers=self.login("admin")).json()["entries"]
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["sent_by"], "admin")
        self.assertEqual((history[0]["title"], history[0]["body"]), ("Maintenance", "Back at noon"))
        self.assertEqual((history[0]["recipient_count"], history[0]["queued_count"]), (1, 1))

    def test_history_is_capped_at_50_newest_first(self):
        db = self.Session()
        for i in range(55):
            db.add(AdminNotification(title=f"t{i}", body="b", route="/", sent_by_username="admin"))
        db.commit()
        db.close()
        entries = self.client.get("/api/admin/notifications", headers=self.login("admin")).json()["entries"]
        self.assertEqual(len(entries), 50)
        self.assertEqual(entries[0]["title"], "t54")

    def test_quiet_hours_defer_then_send_in_the_morning(self):
        misty = self.ids["misty"]
        db = self.Session()
        db.add(UserSetting(user_id=misty, key="notify_quiet_hours", value="true"))
        db.add(UserSetting(user_id=misty, key="time_zone", value="UTC"))
        db.commit()
        night = dt.datetime(2026, 11, 12, 23, 0)
        notifications.queue_announcement(db, misty, 1, "Night", "Shh", "/", now=night)
        db.commit()
        row = db.query(NotificationQueue).one()
        self.assertEqual(row.send_after, dt.datetime(2026, 11, 13, 8, 0))
        sent = []

        def fake_send(_db, user_id, payload):
            sent.append((user_id, payload))
            return {"sent": 1, "removed": 0}

        with patch("services.notifications.push.send_to_user", side_effect=fake_send):
            notifications.flush_due(db, now=dt.datetime(2026, 11, 13, 1, 0))
            self.assertEqual(sent, [])
            notifications.flush_due(db, now=dt.datetime(2026, 11, 13, 8, 5))
        self.assertEqual(len(sent), 1)
        self.assertIn("Night", sent[0][1])
        self.assertIn("Shh", sent[0][1])
        db.close()

    def test_the_card_details_switch_does_not_blank_an_announcement(self):
        misty = self.ids["misty"]
        db = self.Session()
        db.add(UserSetting(user_id=misty, key="notify_show_details", value="false"))
        db.commit()
        notifications.queue_announcement(db, misty, 1, "Free packs", "Open the app", "/collection")
        db.commit()
        sent = []

        def fake_send(_db, user_id, payload):
            sent.append(payload)
            return {"sent": 1, "removed": 0}

        with patch("services.notifications.push.send_to_user", side_effect=fake_send):
            notifications.flush_due(db)
        self.assertEqual(len(sent), 1)
        self.assertIn("Free packs", sent[0])
        self.assertIn("Open the app", sent[0])
        self.assertIn("/collection", sent[0])
        db.close()

    def quiet_misty(self):
        db = self.Session()
        db.add(UserSetting(user_id=self.ids["misty"], key="notify_quiet_hours", value="true"))
        db.add(UserSetting(user_id=self.ids["misty"], key="time_zone", value="UTC"))
        db.commit()
        db.close()

    def test_urgent_ignores_quiet_hours_at_enqueue_and_flush(self):
        self.quiet_misty()
        night = dt.datetime(2026, 11, 12, 2, 40)
        db = self.Session()
        notifications.queue_announcement(db, self.ids["misty"], 1, "Now", "Urgent", "/", now=night, urgent=True)
        notifications.queue_announcement(db, self.ids["brock"], 1, "Now", "Urgent", "/", now=night, urgent=True)
        db.commit()
        for row in db.query(NotificationQueue).all():
            self.assertEqual(row.send_after, night)
            self.assertTrue(row.details["urgent"])
        sent = []
        with patch(
            "services.notifications.push.send_to_user",
            side_effect=lambda _d, u, p: sent.append(u) or {"sent": 1, "removed": 0},
        ):
            notifications.flush_due(db, now=night)
        self.assertEqual(sorted(sent), sorted([self.ids["misty"], self.ids["brock"]]))
        db.close()

    def test_urgent_row_queued_before_quiet_hours_is_not_deferred_at_flush(self):
        self.quiet_misty()
        db = self.Session()
        db.add(NotificationQueue(
            user_id=self.ids["misty"], category="announcements", subject_key="announcement:9",
            created_at=dt.datetime(2026, 11, 12, 1, 0), send_after=dt.datetime(2026, 11, 12, 1, 0),
            details={"title": "T", "body": "B", "route": "/", "urgent": True},
        ))
        db.commit()
        sent = []
        with patch(
            "services.notifications.push.send_to_user",
            side_effect=lambda _d, u, p: sent.append(u) or {"sent": 1, "removed": 0},
        ):
            notifications.flush_due(db, now=dt.datetime(2026, 11, 12, 2, 0))
        self.assertEqual(sent, [self.ids["misty"]])
        db.close()

    def test_non_urgent_still_defers(self):
        self.quiet_misty()
        night = dt.datetime(2026, 11, 12, 2, 40)
        db = self.Session()
        notifications.queue_announcement(db, self.ids["misty"], 1, "Later", "Calm", "/", now=night)
        db.commit()
        self.assertEqual(db.query(NotificationQueue).one().send_after, dt.datetime(2026, 11, 12, 8, 0))
        db.close()

    def test_api_stores_urgent_and_audits_it(self):
        response = self.send(recipients=[self.ids["misty"]], urgent=True)
        self.assertEqual(response.status_code, 200)
        db = self.Session()
        self.assertTrue(db.query(AdminNotification).one().urgent)
        self.assertTrue(db.query(NotificationQueue).one().details["urgent"])
        self.assertIn('"urgent": true', db.query(AuditLog).filter_by(action="admin.notification_sent").one().details)
        db.close()
        entry = self.client.get("/api/admin/notifications", headers=self.login("admin")).json()["entries"][0]
        self.assertTrue(entry["urgent"])

    def test_history_counts_sent_waiting_and_skipped(self):
        self.quiet_misty()
        db = self.Session()
        db.add(UserSetting(user_id=self.ids["brock"], key="notify_announcements", value="false"))
        db.commit()
        db.close()
        # admin reachable, misty reachable (in quiet hours when sent), brock off, gary unreachable
        with patch("api.admin_notifications.datetime") as fake:
            fake.utcnow.return_value = dt.datetime(2026, 11, 12, 2, 40)
            self.send(recipients=[self.ids[n] for n in ("admin", "misty", "brock", "gary")])
        db = self.Session()
        admin_row = db.query(NotificationQueue).filter_by(user_id=self.ids["admin"]).one()
        admin_row.sent_at = dt.datetime(2026, 11, 12, 2, 41)
        db.commit()
        db.close()
        entry = self.client.get("/api/admin/notifications", headers=self.login("admin")).json()["entries"][0]
        self.assertEqual((entry["sent"], entry["waiting"], entry["skipped_count"]), (1, 1, 2))
        self.assertEqual(entry["waiting_until"], "2026-11-12T08:00:00Z")

    def test_history_falls_back_to_stored_counts_without_queue_rows(self):
        self.send(recipients=[self.ids["misty"], self.ids["brock"]])
        db = self.Session()
        db.query(NotificationQueue).delete()
        db.commit()
        db.close()
        entry = self.client.get("/api/admin/notifications", headers=self.login("admin")).json()["entries"][0]
        self.assertEqual((entry["sent"], entry["waiting"], entry["waiting_until"]), (2, 0, None))

    def test_audience_counts_trainers_in_quiet_hours(self):
        self.quiet_misty()
        with patch("api.admin_notifications.datetime") as fake:
            fake.utcnow.return_value = dt.datetime(2026, 11, 12, 2, 40)
            data = self.client.get("/api/admin/notifications/audience", headers=self.login("admin")).json()
            some = self.client.get(
                f"/api/admin/notifications/audience?recipients={self.ids['brock']}", headers=self.login("admin")
            ).json()
        self.assertEqual(data, {"recipient_count": 4, "quiet_now": 1})
        self.assertEqual(some, {"recipient_count": 1, "quiet_now": 0})
        self.assertEqual(
            self.client.get("/api/admin/notifications/audience", headers=self.login("misty")).status_code, 403
        )

    def test_category_defaults(self):
        spec = notifications.CATEGORIES["announcements"]
        self.assertTrue(spec.default)
        self.assertEqual(spec.timing, notifications.INSTANT)
        self.assertEqual(notifications.default_settings()["notify_announcements"], "true")


if __name__ == "__main__":
    unittest.main()
