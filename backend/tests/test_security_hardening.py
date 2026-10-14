import unittest
from types import SimpleNamespace
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from api import images as images_api
    from api.auth import validate_new_password, validate_role
    from database import Base, get_db
    from models import Card, CollectionItem, ImageCache, Set, User
    from services.auth import hash_password, verify_password
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

PASSWORD = "correct horse battery"


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class PasswordRuleTests(unittest.TestCase):
    def test_short_passwords_are_rejected(self):
        for password in ("", "x", "123456789"):
            with self.subTest(password=password), self.assertRaises(HTTPException) as raised:
                validate_new_password(password)
            self.assertEqual(raised.exception.status_code, 400)

    def test_ten_characters_is_enough(self):
        validate_new_password("1234567890")
        validate_new_password(None)  # "not changing the password"

    def test_passwords_bcrypt_cannot_hash_are_rejected_cleanly(self):
        with self.assertRaises(HTTPException) as raised:
            validate_new_password("x" * 73)
        self.assertEqual(raised.exception.status_code, 400)
        validate_new_password("x" * 72)

    def test_multibyte_passwords_are_measured_in_bytes(self):
        with self.assertRaises(HTTPException):
            validate_new_password("é" * 40)  # 80 bytes

    def test_roles_are_limited_to_known_values(self):
        validate_role("admin")
        validate_role("trainer")
        validate_role(None)
        with self.assertRaises(HTTPException):
            validate_role("superuser")

    def test_verify_password_does_not_crash_on_overlong_input_or_bad_hashes(self):
        stored = hash_password(PASSWORD)
        self.assertFalse(verify_password("x" * 200, stored))
        self.assertFalse(verify_password(PASSWORD, "not-a-bcrypt-hash"))
        self.assertTrue(verify_password(PASSWORD, stored))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class AuthHardeningApiTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        db = self.Session()
        db.add(User(username="admin", hashed_password=hash_password(PASSWORD), role="admin", is_active=True))
        db.add(User(
            username="temp", hashed_password=hash_password("temporary-password"),
            role="trainer", is_active=True, must_change_password=True,
        ))
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

    def _login(self, username, password):
        main.app.state._login_attempts = {}
        response = self.client.post("/api/auth/login", data={"username": username, "password": password})
        self.assertEqual(response.status_code, 200, response.text)
        return {"Authorization": f"Bearer {response.json()['access_token']}"}

    def test_admin_cannot_create_users_with_weak_passwords_or_bogus_roles(self):
        headers = self._login("admin", PASSWORD)
        weak = self.client.post("/api/auth/users", headers=headers, json={"username": "a", "password": "short"})
        self.assertEqual(weak.status_code, 400)
        self.assertIsInstance(weak.json()["detail"], str)  # the UI renders this as text
        bogus = self.client.post(
            "/api/auth/users", headers=headers,
            json={"username": "b", "password": "long enough password", "role": "root"},
        )
        self.assertEqual(bogus.status_code, 400)
        good = self.client.post(
            "/api/auth/users", headers=headers,
            json={"username": "c", "password": "long enough password"},
        )
        self.assertEqual(good.status_code, 200, good.text)

    def test_password_change_enforces_the_rules(self):
        headers = self._login("admin", PASSWORD)
        response = self.client.put(
            "/api/auth/me/password", headers=headers,
            json={"current_password": PASSWORD, "new_password": "short"},
        )
        self.assertEqual(response.status_code, 400)

    def test_overlong_login_password_is_a_normal_failure_not_a_server_error(self):
        main.app.state._login_attempts = {}
        response = self.client.post("/api/auth/login", data={"username": "admin", "password": "x" * 200})
        self.assertEqual(response.status_code, 401)

    def test_unknown_user_login_still_checks_a_password_hash(self):
        main.app.state._login_attempts = {}
        with patch("api.auth.verify_password", return_value=False) as check:
            response = self.client.post("/api/auth/login", data={"username": "ghost", "password": "whatever-password"})
        self.assertEqual(response.status_code, 401)
        check.assert_called_once()

    def test_temporary_password_accounts_can_only_change_their_password(self):
        headers = self._login("temp", "temporary-password")
        self.assertEqual(self.client.get("/api/auth/me", headers=headers).status_code, 200)
        for path in ("/api/settings/", "/api/collection/", "/api/dashboard/"):
            with self.subTest(path=path):
                blocked = self.client.get(path, headers=headers)
                self.assertEqual(blocked.status_code, 403, path)
                self.assertIn("temporary password", blocked.json()["detail"])

        changed = self.client.put(
            "/api/auth/me/force-password", headers=headers, json={"new_password": "my new long password"}
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(self.client.get("/api/settings/", headers=headers).status_code, 200)

    def test_force_password_change_enforces_the_rules(self):
        headers = self._login("temp", "temporary-password")
        response = self.client.put("/api/auth/me/force-password", headers=headers, json={"new_password": "tiny"})
        self.assertEqual(response.status_code, 400)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class OtherUsersCollectionTests(unittest.TestCase):
    def test_another_users_collection_hides_purchase_prices(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        db = Session()
        db.add(User(username="admin", hashed_password=hash_password(PASSWORD), role="admin", is_active=True))
        db.add(User(username="misty", hashed_password=hash_password(PASSWORD), role="trainer", is_active=True))
        db.add(Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet", lang="en"))
        db.add(Card(id="sv1-25_en", tcg_card_id="sv1-25", name="Pikachu", set_id="sv1", number="25", lang="en"))
        db.commit()
        misty_id = db.query(User).filter(User.username == "misty").one().id
        db.add(CollectionItem(card_id="sv1-25_en", user_id=misty_id, quantity=1, lang="en", purchase_price=123.45))
        db.commit()
        db.close()

        def override_get_db():
            session = Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_get_db
        self.addCleanup(main.app.dependency_overrides.clear)
        client = TestClient(main.app)
        main.app.state._login_attempts = {}
        token = client.post("/api/auth/login", data={"username": "admin", "password": PASSWORD}).json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        other = client.get(f"/api/collection/user/{misty_id}", headers=headers)
        self.assertEqual(other.status_code, 200, other.text)
        row = other.json()[0]
        self.assertNotIn("purchase_price", row)
        self.assertNotIn("product_sources", row)
        self.assertEqual(row["card_id"], "sv1-25_en")

        # Misty still sees her own price.
        main.app.state._login_attempts = {}
        own_token = client.post("/api/auth/login", data={"username": "misty", "password": PASSWORD}).json()["access_token"]
        own = client.get("/api/collection/", headers={"Authorization": f"Bearer {own_token}"})
        self.assertEqual(own.json()[0]["purchase_price"], 123.45)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ImageSafetyTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.addCleanup(self.db.close)

    def test_custom_image_responses_cannot_be_svg_and_stale_svg_is_refetched(self):
        # An SVG cached before the restriction must not be served again.
        self.db.add(ImageCache(image_key="k", data=b"<svg onload='x()'/>", content_type="image/svg+xml"))
        self.db.commit()
        with patch.object(images_api, "validate_public_https_image_url", side_effect=ValueError("blocked in test")):
            with self.assertRaises(ValueError):
                images_api._get_or_fetch_custom_image(
                    self.db, "k", "https://example.test/x.svg",
                    allowed_content_types=images_api._ALLOWED_CUSTOM_IMAGE_TYPES,
                )
        self.assertIsNone(self.db.query(ImageCache).filter(ImageCache.image_key == "k").first())

    def test_allowed_cached_images_are_still_served(self):
        self.db.add(ImageCache(image_key="ok", data=b"png-bytes", content_type="image/png"))
        self.db.commit()
        data, content_type = images_api._get_or_fetch_custom_image(
            self.db, "ok", "https://example.test/x.png",
            allowed_content_types=images_api._ALLOWED_CUSTOM_IMAGE_TYPES,
        )
        self.assertEqual((data, content_type), (b"png-bytes", "image/png"))

    def test_image_security_headers_are_defined(self):
        self.assertEqual(images_api._IMAGE_SECURITY_HEADERS["X-Content-Type-Options"], "nosniff")
        self.assertIn("sandbox", images_api._IMAGE_SECURITY_HEADERS["Content-Security-Policy"])


if __name__ == "__main__":
    unittest.main()
