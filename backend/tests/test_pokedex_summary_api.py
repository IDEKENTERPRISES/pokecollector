import unittest

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    API_TEST_DEPS_AVAILABLE = True
except ImportError:  # pragma: no cover - lightweight test environments
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class PokedexSummaryApiTests(unittest.TestCase):
    def setUp(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool

        from api.auth import get_current_user
        from api.pokedex import router
        from database import Base, get_db
        from models import Card, CollectionItem, User

        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="misty", hashed_password="x", role="admin", is_active=True)
        self.db.add(self.user)
        self.db.add(Card(id="s-1_en", tcg_card_id="s-1", name="Gengar", lang="en", is_custom=False, dex_ids=[94]))
        self.db.commit()
        self.db.add(CollectionItem(card_id="s-1_en", user_id=self.user.id, quantity=2, lang="en"))
        self.db.commit()

        app = FastAPI()
        app.include_router(router, prefix="/api/pokedex")
        app.dependency_overrides[get_current_user] = lambda: self.user
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app)

    def tearDown(self):
        self.db.close()

    def test_summary_route_is_not_swallowed_by_the_species_route(self):
        response = self.client.get("/api/pokedex/summary")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"total": 1025, "owned": 1, "missing": 1024})

    def test_summary_agrees_with_the_full_list(self):
        full = self.client.get("/api/pokedex", params={"lang": "en"}).json()["summary"]
        summary = self.client.get("/api/pokedex/summary").json()
        self.assertEqual(summary, {"total": full["total"], "owned": full["owned"], "missing": full["missing"]})
