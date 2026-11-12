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
    from models import AuditLog, Banner, User
    from services.auth import hash_password
    from services.login_throttle import login_throttle

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

PASSWORD = "correct horse battery"


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class BannerTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        db = self.Session()
        db.add(User(username="admin", hashed_password=hash_password(PASSWORD), role="admin", is_active=True, avatar_id=25))
        for name in ("misty", "brock"):
            db.add(User(username=name, hashed_password=hash_password(PASSWORD), role="trainer", is_active=True))
        db.commit()
        self.ids = {u.username: u.id for u in db.query(User).all()}
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

    def create(self, **body):
        body = {"message": "Hello trainers", "sender_name": "admin", **body}
        return self.client.post("/api/admin/banners", json=body, headers=self.login("admin"))

    def actions(self):
        db = self.Session()
        try:
            rows = db.query(AuditLog).order_by(AuditLog.id).all()
            return [(a.action, a.target_id) for a in rows if a.action.startswith("banner.")]
        finally:
            db.close()

    def active(self, who):
        response = self.client.get("/api/banners/active", headers=self.login(who))
        self.assertEqual(response.status_code, 200)
        return response.json()["banners"]

    def test_admin_endpoints_refuse_trainers(self):
        headers = self.login("misty")
        self.assertEqual(self.client.post("/api/admin/banners", json={"message": "x", "sender_name": "n"}, headers=headers).status_code, 403)
        self.assertEqual(self.client.get("/api/admin/banners", headers=headers).status_code, 403)
        self.assertEqual(self.client.put("/api/admin/banners/1", json={"message": "x", "sender_name": "n"}, headers=headers).status_code, 403)
        self.assertEqual(self.client.post("/api/admin/banners/1/end", headers=headers).status_code, 403)
        self.assertEqual(self.client.delete("/api/admin/banners/1", headers=headers).status_code, 403)

    def test_create_as_me_uses_current_username_and_avatar(self):
        response = self.create()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["sender_name"], body["avatar_id"], body["status"]), ("admin", 25, "active"))
        self.assertEqual(self.active("misty")[0]["label"], "admin")
        self.assertEqual(body["sender_mode"], "me")

    def test_custom_name_and_pokemon(self):
        body = self.create(sender_name="Professor Oak", avatar_mode="pokemon", avatar_id=151).json()
        self.assertEqual((body["sender_name"], body["avatar_id"]), ("Professor Oak", 151))
        self.assertEqual(self.active("misty")[0]["label"], "system")

    def test_validation(self):
        bad = [
            {"message": ""},
            {"message": "x" * 281},
            {"sender_name": ""},
            {"sender_name": "   "},
            {"sender_name": "n" * 41},
            {"avatar_mode": "pokemon", "avatar_id": 0},
            {"avatar_mode": "pokemon", "avatar_id": 152},
            {"avatar_mode": "pokemon"},
            {"style": "rainbow"},
            {"route": "https://evil.test"},
            {"audience": "some", "user_ids": []},
            {"audience": "some", "user_ids": [9999]},
            {"ends_at": "2000-01-01T00:00:00Z"},
        ]
        for extra in bad:
            self.assertEqual(self.create(**extra).status_code, 422, extra)
        self.assertEqual(self.actions(), [])
        self.assertEqual(self.create(route="/sets", style="alert").status_code, 200)

    def test_audience_filtering(self):
        self.create(audience="some", user_ids=[self.ids["misty"]])
        self.assertEqual(len(self.active("misty")), 1)
        self.assertEqual(self.active("brock"), [])

    def test_newest_first_and_end_date(self):
        self.create(message="first")
        self.create(message="second")
        self.assertEqual([b["message"] for b in self.active("misty")], ["second", "first"])
        db = self.Session()
        row = db.query(Banner).filter(Banner.message == "first").one()
        row.ends_at = dt.datetime.utcnow() - dt.timedelta(minutes=1)
        db.commit()
        db.close()
        self.assertEqual([b["message"] for b in self.active("misty")], ["second"])
        entries = self.client.get("/api/admin/banners", headers=self.login("admin")).json()["entries"]
        self.assertEqual({e["message"]: e["status"] for e in entries}, {"first": "expired", "second": "active"})

    def test_dismiss_is_per_trainer_and_audited(self):
        banner_id = self.create().json()["id"]
        self.assertEqual(self.client.post(f"/api/banners/{banner_id}/dismiss", headers=self.login("misty")).status_code, 200)
        self.assertEqual(self.active("misty"), [])
        self.assertEqual(len(self.active("brock")), 1)
        self.client.post(f"/api/banners/{banner_id}/dismiss", headers=self.login("misty"))  # idempotent
        self.assertEqual(self.actions().count(("banner.dismissed", str(banner_id))), 1)

    def test_dismiss_refused_when_not_dismissible(self):
        banner_id = self.create(dismissible=False).json()["id"]
        response = self.client.post(f"/api/banners/{banner_id}/dismiss", headers=self.login("misty"))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(len(self.active("misty")), 1)

    def test_edit_end_delete_and_audit(self):
        banner_id = self.create(sender_name="Prof").json()["id"]
        edited = self.client.put(
            f"/api/admin/banners/{banner_id}",
            json={"message": "changed", "style": "warning", "sender_name": "Prof"},
            headers=self.login("admin"),
        )
        self.assertEqual(edited.status_code, 200, edited.text)
        self.assertEqual(self.active("misty")[0]["message"], "changed")
        ended = self.client.post(f"/api/admin/banners/{banner_id}/end", headers=self.login("admin"))
        self.assertEqual(ended.json()["status"], "ended")
        self.assertEqual(self.active("misty"), [])
        self.assertEqual(self.client.delete(f"/api/admin/banners/{banner_id}", headers=self.login("admin")).status_code, 200)
        self.assertEqual(self.client.delete(f"/api/admin/banners/{banner_id}", headers=self.login("admin")).status_code, 404)
        self.assertEqual(
            [a for a, _ in self.actions()], ["banner.created", "banner.updated", "banner.ended", "banner.deleted"]
        )
        db = self.Session()
        created = db.query(AuditLog).filter(AuditLog.action == "banner.created").one()
        self.assertIn("Prof", created.details)
        self.assertIn("sender_name", created.details)
        self.assertEqual(db.query(Banner).count(), 0)
        db.close()


if __name__ == "__main__":
    unittest.main()
