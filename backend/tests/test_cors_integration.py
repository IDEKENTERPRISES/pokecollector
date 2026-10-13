import unittest

try:
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from database import Base, get_db
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class CorsIntegrationTests(unittest.TestCase):
    """Exercises the real app's middleware stack (lifespan/DB not started)."""

    def setUp(self):
        engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)

        def override_get_db():
            db = Session()
            try:
                yield db
            finally:
                db.close()

        main.app.dependency_overrides[get_db] = override_get_db
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    def test_cross_site_form_post_is_refused_before_reaching_the_route(self):
        response = self.client.post(
            "/api/backup/restore",
            files={"file": ("x.sql", b"select 1;")},
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"], "Cross-site request blocked.")

    def test_no_cors_headers_are_sent_to_foreign_origins(self):
        response = self.client.get("/api/health", headers={"Origin": "https://evil.example"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_preflight_from_foreign_origin_is_not_approved(self):
        response = self.client.options(
            "/api/settings/",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "PUT",
            },
        )
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_same_host_write_reaches_the_route(self):
        response = self.client.post(
            "/api/auth/login",
            data={"username": "nobody", "password": "x"},
            headers={"Origin": "http://testserver:3000"},
        )
        self.assertNotEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
