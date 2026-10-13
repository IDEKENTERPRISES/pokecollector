import datetime
import unittest

try:
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from database import Base, get_db
    from models import User, UserSession
    from services.auth import create_access_token, hash_password
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

PASSWORD = "correct horse battery"


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class SessionTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        db = self.Session()
        db.add(User(username="admin", hashed_password=hash_password(PASSWORD), role="admin", is_active=True))
        db.add(User(username="ash", hashed_password=hash_password(PASSWORD), role="trainer", is_active=True))
        db.commit()
        db.close()

        def override_get_db():
            session = self.Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_get_db
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    def _reset_login_counter(self):
        # The per-IP login counter in main.py is not what is being tested here.
        main.app.state._login_attempts = {}

    def _login(self, username="ash", password=PASSWORD):
        self._reset_login_counter()
        response = self.client.post("/api/auth/login", data={"username": username, "password": password})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["access_token"]

    def _get(self, path, token):
        return self.client.get(path, headers={"Authorization": f"Bearer {token}"})

    def _call(self, method, path, token, **kwargs):
        return self.client.request(method, path, headers={"Authorization": f"Bearer {token}"}, **kwargs)

    def _count_sessions(self, username="ash"):
        db = self.Session()
        try:
            user = db.query(User).filter(User.username == username).one()
            return db.query(UserSession).filter(UserSession.user_id == user.id).count()
        finally:
            db.close()

    # -- basics ---------------------------------------------------------------

    def test_login_creates_a_session_and_the_token_works(self):
        token = self._login()
        self.assertEqual(self._count_sessions(), 1)
        self.assertEqual(self._get("/api/auth/me", token).status_code, 200)

    def test_token_without_a_session_id_is_rejected(self):
        db = self.Session()
        ash_id = db.query(User).filter(User.username == "ash").one().id
        db.close()
        legacy = create_access_token({"sub": str(ash_id), "role": "trainer"})
        self.assertEqual(self._get("/api/auth/me", legacy).status_code, 401)

    def test_token_for_an_unknown_session_is_rejected(self):
        db = self.Session()
        ash_id = db.query(User).filter(User.username == "ash").one().id
        db.close()
        forged = create_access_token({"sub": str(ash_id), "role": "trainer", "sid": "0" * 48})
        self.assertEqual(self._get("/api/auth/me", forged).status_code, 401)

    def test_a_session_cannot_be_used_for_another_user(self):
        token = self._login("ash")
        db = self.Session()
        session_id = db.query(UserSession).one().id
        admin_id = db.query(User).filter(User.username == "admin").one().id
        db.close()
        stolen_id = create_access_token({"sub": str(admin_id), "role": "admin", "sid": session_id})
        self.assertEqual(self._get("/api/auth/me", stolen_id).status_code, 401)
        self.assertEqual(self._get("/api/auth/me", token).status_code, 200)

    def test_expired_sessions_are_rejected(self):
        token = self._login()
        db = self.Session()
        session = db.query(UserSession).one()
        session.expires_at = datetime.datetime.utcnow() - datetime.timedelta(minutes=1)
        db.commit()
        db.close()
        self.assertEqual(self._get("/api/auth/me", token).status_code, 401)

    # -- ending sessions ------------------------------------------------------

    def test_logout_ends_the_session_immediately(self):
        token = self._login()
        self.assertEqual(self._call("POST", "/api/auth/logout", token).status_code, 200)
        self.assertEqual(self._get("/api/auth/me", token).status_code, 401)
        self.assertEqual(self._count_sessions(), 0)

    def test_logout_others_keeps_only_this_device(self):
        phone = self._login()
        laptop = self._login()
        response = self._call("POST", "/api/auth/logout-others", phone)
        self.assertEqual(response.json(), {"ended": 1})
        self.assertEqual(self._get("/api/auth/me", phone).status_code, 200)
        self.assertEqual(self._get("/api/auth/me", laptop).status_code, 401)

    def test_changing_the_password_signs_out_other_devices_but_not_this_one(self):
        phone = self._login()
        laptop = self._login()
        response = self._call(
            "PUT", "/api/auth/me/password", phone,
            json={"current_password": PASSWORD, "new_password": "a brand new password"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._get("/api/auth/me", phone).status_code, 200)
        self.assertEqual(self._get("/api/auth/me", laptop).status_code, 401)

    def test_failed_password_change_leaves_sessions_alone(self):
        phone = self._login()
        laptop = self._login()
        response = self._call(
            "PUT", "/api/auth/me/password", phone,
            json={"current_password": "wrong", "new_password": "a brand new password"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._get("/api/auth/me", laptop).status_code, 200)

    def test_admin_password_reset_signs_the_user_out_everywhere(self):
        ash = self._login("ash")
        admin = self._login("admin")
        db = self.Session()
        ash_id = db.query(User).filter(User.username == "ash").one().id
        db.close()
        response = self._call("PUT", f"/api/auth/users/{ash_id}", admin, json={"password": "reset by the admin"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._get("/api/auth/me", ash).status_code, 401)
        self.assertEqual(self._get("/api/auth/me", admin).status_code, 200)

    def test_deactivating_then_reactivating_does_not_revive_old_tokens(self):
        ash = self._login("ash")
        admin = self._login("admin")
        db = self.Session()
        ash_id = db.query(User).filter(User.username == "ash").one().id
        db.close()
        self._call("PUT", f"/api/auth/users/{ash_id}", admin, json={"is_active": False})
        self.assertEqual(self._get("/api/auth/me", ash).status_code, 401)
        self._call("PUT", f"/api/auth/users/{ash_id}", admin, json={"is_active": True})
        self.assertEqual(self._get("/api/auth/me", ash).status_code, 401)

    def test_deleting_a_user_removes_their_sessions(self):
        self._login("ash")
        admin = self._login("admin")
        db = self.Session()
        ash_id = db.query(User).filter(User.username == "ash").one().id
        db.close()
        self.assertEqual(self._call("DELETE", f"/api/auth/users/{ash_id}", admin).status_code, 200)
        db = self.Session()
        self.assertEqual(db.query(UserSession).filter(UserSession.user_id == ash_id).count(), 0)
        db.close()

    # -- listing --------------------------------------------------------------

    def test_sessions_are_listed_with_the_current_one_marked(self):
        phone = self._login()
        self._login()
        rows = self._get("/api/auth/sessions", phone).json()
        self.assertEqual(len(rows), 2)
        self.assertEqual(sum(1 for row in rows if row["current"]), 1)

    def test_one_session_can_be_revoked_but_only_by_its_owner(self):
        phone = self._login("ash")
        laptop = self._login("ash")
        admin = self._login("admin")
        rows = self._get("/api/auth/sessions", phone).json()
        other = next(row for row in rows if not row["current"])

        self.assertEqual(self._call("DELETE", f"/api/auth/sessions/{other['id']}", admin).status_code, 404)
        self.assertEqual(self._call("DELETE", f"/api/auth/sessions/{other['id']}", phone).status_code, 200)
        self.assertEqual(self._get("/api/auth/me", phone).status_code, 200)
        self.assertEqual(self._get("/api/auth/me", laptop).status_code, 401)


if __name__ == "__main__":
    unittest.main()
