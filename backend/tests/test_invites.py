import json
import os
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from api import invites as invites_api
    from database import Base, get_db
    from models import AuditLog, Invite, User, UserSession
    from services.auth import hash_password, verify_password
    from services.login_throttle import IP_MAX_FAILURES, login_throttle

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

PASSWORD = "correct horse battery"
PROXY = ("172.20.0.3", 5000)


def client_from(peer, headers=None):
    async def app_with_peer(scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            scope = {**scope, "client": peer}
        await main.app(scope, receive, send)

    return TestClient(app_with_peer, headers=headers or {})


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class InviteApiTests(unittest.TestCase):
    mode = "multi"

    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        db = self.Session()
        db.add(User(username="admin", hashed_password=hash_password(PASSWORD), role="admin", is_active=True))
        db.add(User(username="misty", hashed_password=hash_password(PASSWORD), role="trainer", is_active=True))
        db.commit()
        db.close()

        def override_get_db():
            session = self.Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_get_db
        self.env = patch.dict(os.environ, {"USER_MODE": self.mode})
        self.env.start()
        login_throttle.reset()
        invites_api.invite_throttle.reset()
        self.client = client_from(PROXY, {"User-Agent": "pytest-agent", "X-Forwarded-For": "8.8.4.4"})
        self.anon = client_from(PROXY, {"User-Agent": "anon-agent", "X-Forwarded-For": "8.8.4.5"})

    def tearDown(self):
        main.app.dependency_overrides.pop(get_db, None)
        self.env.stop()
        login_throttle.reset()
        invites_api.invite_throttle.reset()

    # helpers
    def login(self, username):
        response = self.client.post("/api/auth/login", data={"username": username, "password": PASSWORD})
        self.assertEqual(response.status_code, 200, response.text)
        return {"Authorization": f"Bearer {response.json()['access_token']}"}

    def create_invite(self, headers=None, **body):
        headers = headers or self.login("admin")
        response = self.client.post("/api/auth/invites", json=body, headers=headers)
        return response

    def audit_actions(self):
        db = self.Session()
        try:
            return [row.action for row in db.query(AuditLog).order_by(AuditLog.id).all()]
        finally:
            db.close()

    def audit_rows(self, action):
        db = self.Session()
        try:
            return db.query(AuditLog).filter(AuditLog.action == action).order_by(AuditLog.id).all()
        finally:
            db.close()

    def accept(self, token, username="brock", password=PASSWORD):
        return self.anon.post(f"/api/auth/invites/{token}/accept", json={"username": username, "password": password})


class AdminInviteTests(InviteApiTests):
    def test_create_returns_token_link_and_defaults(self):
        response = self.create_invite()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["role"], "trainer")
        self.assertEqual(body["status"], "pending")
        self.assertEqual(body["created_by"]["username"], "admin")
        self.assertTrue(body["token"])
        self.assertTrue(body["link"].endswith(f"/invite/{body['token']}"))
        expires = datetime.fromisoformat(body["expires_at"].rstrip("Z"))
        self.assertAlmostEqual((expires - datetime.utcnow()).total_seconds(), 7 * 86400, delta=60)

    def test_link_uses_the_browser_origin_when_sent(self):
        headers = {**self.login("admin"), "Origin": "https://cards.example.test"}
        body = self.create_invite(headers=headers).json()
        self.assertEqual(body["link"], f"https://cards.example.test/invite/{body['token']}")

    def test_token_is_stored_only_as_a_hash_and_never_listed_again(self):
        headers = self.login("admin")
        body = self.create_invite(headers=headers, note="for Brock").json()
        db = self.Session()
        invite = db.query(Invite).one()
        db.close()
        self.assertNotEqual(invite.token_hash, body["token"])
        self.assertEqual(len(invite.token_hash), 64)
        listing = self.client.get("/api/auth/invites", headers=headers)
        self.assertEqual(listing.status_code, 200)
        self.assertNotIn(body["token"], listing.text)
        self.assertNotIn("token", listing.json()[0])
        self.assertEqual(listing.json()[0]["note"], "for Brock")

    def test_role_and_expiry_options(self):
        headers = self.login("admin")
        admin_invite = self.create_invite(headers=headers, role="admin", expires_in_days=30).json()
        short = self.create_invite(headers=headers, expires_in_days=1).json()
        self.assertEqual(admin_invite["role"], "admin")
        expires = datetime.fromisoformat(admin_invite["expires_at"].rstrip("Z"))
        self.assertAlmostEqual((expires - datetime.utcnow()).total_seconds(), 30 * 86400, delta=60)
        expires = datetime.fromisoformat(short["expires_at"].rstrip("Z"))
        self.assertAlmostEqual((expires - datetime.utcnow()).total_seconds(), 86400, delta=60)

    def test_invalid_options_are_rejected(self):
        headers = self.login("admin")
        self.assertEqual(self.create_invite(headers=headers, role="owner").status_code, 422)
        self.assertEqual(self.create_invite(headers=headers, expires_in_days=3).status_code, 422)

    def test_listing_shows_every_status_with_creator_and_user(self):
        headers = self.login("admin")
        used = self.create_invite(headers=headers).json()
        revoked = self.create_invite(headers=headers).json()
        expired = self.create_invite(headers=headers).json()
        pending = self.create_invite(headers=headers).json()
        self.assertEqual(self.accept(used["token"]).status_code, 200)
        self.assertEqual(self.client.delete(f"/api/auth/invites/{revoked['id']}", headers=headers).status_code, 200)
        db = self.Session()
        db.query(Invite).filter(Invite.id == expired["id"]).update({"expires_at": datetime.utcnow() - timedelta(minutes=1)})
        db.commit()
        db.close()

        rows = {row["id"]: row for row in self.client.get("/api/auth/invites", headers=headers).json()}
        self.assertEqual(rows[used["id"]]["status"], "used")
        self.assertEqual(rows[used["id"]]["used_by"]["username"], "brock")
        self.assertEqual(rows[revoked["id"]]["status"], "revoked")
        self.assertEqual(rows[revoked["id"]]["revoked_by"]["username"], "admin")
        self.assertEqual(rows[expired["id"]]["status"], "expired")
        self.assertEqual(rows[pending["id"]]["status"], "pending")
        self.assertEqual(rows[pending["id"]]["created_by"]["username"], "admin")

    def test_revoke_unknown_and_used_invites(self):
        headers = self.login("admin")
        self.assertEqual(self.client.delete("/api/auth/invites/999", headers=headers).status_code, 404)
        used = self.create_invite(headers=headers).json()
        self.accept(used["token"])
        self.assertEqual(self.client.delete(f"/api/auth/invites/{used['id']}", headers=headers).status_code, 409)

    def test_revoking_twice_is_harmless_and_logged_once(self):
        headers = self.login("admin")
        invite = self.create_invite(headers=headers).json()
        self.assertEqual(self.client.delete(f"/api/auth/invites/{invite['id']}", headers=headers).status_code, 200)
        self.assertEqual(self.client.delete(f"/api/auth/invites/{invite['id']}", headers=headers).status_code, 200)
        self.assertEqual(self.audit_actions().count("invite.revoked"), 1)

    def test_non_admins_cannot_use_any_admin_endpoint(self):
        headers = self.login("misty")
        self.assertEqual(self.client.post("/api/auth/invites", json={}, headers=headers).status_code, 403)
        self.assertEqual(self.client.get("/api/auth/invites", headers=headers).status_code, 403)
        self.assertEqual(self.client.delete("/api/auth/invites/1", headers=headers).status_code, 403)
        self.assertEqual(self.client.get("/api/auth/audit", headers=headers).status_code, 403)
        self.assertEqual(self.audit_actions(), [])

    def test_anonymous_callers_cannot_use_admin_endpoints(self):
        self.assertEqual(self.anon.post("/api/auth/invites", json={}).status_code, 401)
        self.assertEqual(self.anon.get("/api/auth/invites").status_code, 401)
        self.assertEqual(self.anon.get("/api/auth/audit").status_code, 401)


class AcceptInviteTests(InviteApiTests):
    def test_check_reports_validity_without_details(self):
        token = self.create_invite(role="admin").json()["token"]
        response = self.anon.get(f"/api/auth/invites/{token}/check")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(set(body), {"valid", "role", "expires_at"})
        self.assertTrue(body["valid"])
        self.assertEqual(body["role"], "admin")
        self.assertEqual(self.anon.get("/api/auth/invites/nonsense/check").json(), {"valid": False, "reason": "not_found"})

    def test_check_reasons_for_used_revoked_and_expired(self):
        headers = self.login("admin")
        used = self.create_invite(headers=headers).json()
        revoked = self.create_invite(headers=headers).json()
        expired = self.create_invite(headers=headers).json()
        self.accept(used["token"])
        self.client.delete(f"/api/auth/invites/{revoked['id']}", headers=headers)
        db = self.Session()
        db.query(Invite).filter(Invite.id == expired["id"]).update({"expires_at": datetime.utcnow() - timedelta(seconds=1)})
        db.commit()
        db.close()
        for invite, reason in ((used, "used"), (revoked, "revoked"), (expired, "expired")):
            self.assertEqual(
                self.anon.get(f"/api/auth/invites/{invite['token']}/check").json(),
                {"valid": False, "reason": reason},
            )

    def test_accept_creates_the_user_with_the_invite_role_and_signs_in(self):
        token = self.create_invite(role="admin").json()["token"]
        response = self.accept(token, username="  brock  ")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["user"]["username"], "brock")
        self.assertEqual(body["user"]["role"], "admin")
        self.assertFalse(body["user"]["must_change_password"])

        db = self.Session()
        user = db.query(User).filter(User.username == "brock").one()
        self.assertEqual(user.role, "admin")
        self.assertTrue(verify_password(PASSWORD, user.hashed_password))
        self.assertEqual(db.query(UserSession).filter(UserSession.user_id == user.id).count(), 1)
        invite = db.query(Invite).one()
        self.assertEqual(invite.used_by, user.id)
        self.assertIsNotNone(invite.used_at)
        db.close()

        me = self.anon.get("/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["username"], "brock")

    def test_an_invite_is_single_use(self):
        token = self.create_invite().json()["token"]
        self.assertEqual(self.accept(token, "brock").status_code, 200)
        again = self.accept(token, "gary")
        self.assertEqual(again.status_code, 410)
        self.assertEqual(again.json()["detail"]["reason"], "used")
        db = self.Session()
        self.assertIsNone(db.query(User).filter(User.username == "gary").first())
        db.close()

    def test_expired_and_revoked_invites_cannot_be_accepted(self):
        headers = self.login("admin")
        expired = self.create_invite(headers=headers).json()
        revoked = self.create_invite(headers=headers).json()
        db = self.Session()
        db.query(Invite).filter(Invite.id == expired["id"]).update({"expires_at": datetime.utcnow() - timedelta(seconds=1)})
        db.commit()
        db.close()
        self.client.delete(f"/api/auth/invites/{revoked['id']}", headers=headers)
        response = self.accept(expired["token"])
        self.assertEqual((response.status_code, response.json()["detail"]["reason"]), (410, "expired"))
        response = self.accept(revoked["token"])
        self.assertEqual((response.status_code, response.json()["detail"]["reason"]), (410, "revoked"))

    def test_unknown_token_is_not_found(self):
        response = self.accept("no-such-token")
        self.assertEqual((response.status_code, response.json()["detail"]["reason"]), (404, "not_found"))

    def test_validation_errors_do_not_burn_the_invite(self):
        token = self.create_invite().json()["token"]
        self.assertEqual(self.accept(token, "x").status_code, 400)
        self.assertEqual(self.accept(token, "a" * 33).status_code, 400)
        self.assertEqual(self.accept(token, "brock", "short").status_code, 400)
        self.assertEqual(self.accept(token, "brock", "x" * 80).status_code, 400)
        taken = self.accept(token, "misty")
        self.assertEqual(taken.status_code, 400)
        self.assertEqual(taken.json()["detail"], "Username already exists")
        self.assertEqual(self.accept(token, "brock").status_code, 200)

    def test_repeated_bad_tokens_are_rate_limited(self):
        for _ in range(IP_MAX_FAILURES):
            self.assertEqual(self.accept("guess").status_code, 404)
        blocked = self.accept("guess")
        self.assertEqual(blocked.status_code, 429)
        self.assertIn("Retry-After", blocked.headers)
        # Even a good invite waits out the throttle for that address, but other addresses are fine.
        token = self.create_invite().json()["token"]
        self.assertEqual(self.accept(token).status_code, 429)
        other = client_from(PROXY, {"X-Forwarded-For": "8.8.4.99"})
        self.assertEqual(
            other.post(f"/api/auth/invites/{token}/accept", json={"username": "brock", "password": PASSWORD}).status_code,
            200,
        )

    def test_bad_invites_do_not_throttle_logins(self):
        for _ in range(IP_MAX_FAILURES):
            self.accept("guess")
        response = self.anon.post("/api/auth/login", data={"username": "admin", "password": PASSWORD})
        self.assertEqual(response.status_code, 200)


class SingleUserTests(InviteApiTests):
    mode = "single"

    def test_invites_do_not_work_in_single_user_mode(self):
        db = self.Session()
        admin = db.query(User).filter(User.username == "admin").one()
        db.close()
        # Single-user mode needs no token: the admin is implied.
        self.assertEqual(self.client.post("/api/auth/invites", json={}).status_code, 409)
        self.assertEqual(self.client.get("/api/auth/invites").status_code, 409)
        self.assertEqual(self.client.get("/api/auth/audit").status_code, 409)
        self.assertEqual(self.anon.get("/api/auth/invites/anything/check").json(), {"valid": False, "reason": "multi_user_off"})
        response = self.accept("anything")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["reason"], "multi_user_off")
        self.assertIsNotNone(admin)

    def test_a_token_minted_earlier_does_not_work_after_switching_to_single_user(self):
        with patch.dict(os.environ, {"USER_MODE": "multi"}):
            token = self.create_invite().json()["token"]
        self.assertEqual(self.accept(token).status_code, 409)
        db = self.Session()
        self.assertIsNone(db.query(User).filter(User.username == "brock").first())
        db.close()


class AuditLogTests(InviteApiTests):
    def test_the_full_story_is_audited(self):
        headers = self.login("admin")
        created = self.create_invite(headers=headers, note="n").json()
        revoked = self.create_invite(headers=headers).json()
        self.client.delete(f"/api/auth/invites/{revoked['id']}", headers=headers)
        self.accept(created["token"], "brock")
        self.accept(created["token"], "gary")
        self.accept(revoked["token"], "gary")
        self.accept("bogus", "gary")

        self.assertEqual(
            self.audit_actions(),
            [
                "invite.created",
                "invite.created",
                "invite.revoked",
                "invite.accepted",
                "user.created_via_invite",
                "invite.rejected",
                "invite.rejected",
                "invite.rejected",
            ],
        )

    def test_created_entry_records_actor_target_ip_and_agent(self):
        invite = self.create_invite(role="admin", note="hello").json()
        row = self.audit_rows("invite.created")[0]
        db = self.Session()
        admin = db.query(User).filter(User.username == "admin").one()
        db.close()
        self.assertEqual(row.actor_user_id, admin.id)
        self.assertEqual((row.target_type, row.target_id), ("invite", str(invite["id"])))
        self.assertEqual(row.ip, "8.8.4.4")
        self.assertEqual(row.user_agent, "pytest-agent")
        details = json.loads(row.details)
        self.assertEqual((details["role"], details["note"]), ("admin", "hello"))
        self.assertNotIn(invite["token"], row.details)

    def test_accepted_entries_carry_the_new_user_id_and_no_actor(self):
        invite = self.create_invite().json()
        self.accept(invite["token"], "brock")
        db = self.Session()
        user = db.query(User).filter(User.username == "brock").one()
        db.close()
        accepted = self.audit_rows("invite.accepted")[0]
        self.assertIsNone(accepted.actor_user_id)
        self.assertEqual(json.loads(accepted.details)["user_id"], user.id)
        self.assertEqual(accepted.ip, "8.8.4.5")
        self.assertEqual(accepted.user_agent, "anon-agent")
        via = self.audit_rows("user.created_via_invite")[0]
        self.assertEqual((via.target_type, via.target_id), ("user", str(user.id)))
        self.assertEqual(json.loads(via.details)["invite_id"], invite["id"])

    def test_rejections_record_the_reason(self):
        headers = self.login("admin")
        used = self.create_invite(headers=headers).json()
        self.accept(used["token"], "brock")
        self.accept(used["token"], "gary")
        self.accept("nope", "gary")
        reasons = [json.loads(row.details)["reason"] for row in self.audit_rows("invite.rejected")]
        self.assertEqual(reasons, ["used", "not_found"])
        self.assertNotIn("nope", " ".join(row.details for row in self.audit_rows("invite.rejected")))

    def test_audit_endpoint_is_newest_first_and_pages(self):
        headers = self.login("admin")
        for _ in range(5):
            self.create_invite(headers=headers)
        first = self.client.get("/api/auth/audit?limit=2", headers=headers).json()
        self.assertEqual(len(first["entries"]), 2)
        ids = [entry["id"] for entry in first["entries"]]
        self.assertEqual(ids, sorted(ids, reverse=True))
        self.assertEqual(first["entries"][0]["actor_username"], "admin")
        self.assertEqual(first["entries"][0]["action"], "invite.created")
        self.assertEqual(first["next_before"], ids[-1])
        second = self.client.get(f"/api/auth/audit?limit=2&before={first['next_before']}", headers=headers).json()
        self.assertTrue(all(entry["id"] < ids[-1] for entry in second["entries"]))
        last = self.client.get("/api/auth/audit?limit=50", headers=headers).json()
        self.assertEqual(len(last["entries"]), 5)
        self.assertIsNone(last["next_before"])

    def test_audit_survives_deleting_the_actor(self):
        db = self.Session()
        db.add(User(username="boss2", hashed_password=hash_password(PASSWORD), role="admin", is_active=True))
        db.commit()
        db.close()
        invite = self.create_invite(headers=self.login("boss2")).json()
        db = self.Session()
        db.query(UserSession).delete()
        db.query(User).filter(User.username == "boss2").delete()
        db.commit()
        db.close()
        entries = self.client.get("/api/auth/audit", headers=self.login("admin")).json()["entries"]
        self.assertEqual(entries[0]["action"], "invite.created")
        self.assertEqual(entries[0]["target_id"], str(invite["id"]))
        self.assertEqual(entries[0]["actor_username"], "boss2")


if __name__ == "__main__":
    unittest.main()
