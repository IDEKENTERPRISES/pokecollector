import json
import os
import unittest
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from api.auth import get_current_user
    from database import Base, get_db
    from models import Card, Set, Setting, User
    from services import offline_carddb

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _card(card_id, name, set_id, number, lang="en", **extra):
    return Card(id=f"{card_id}_{lang}", tcg_card_id=card_id, name=name, set_id=set_id, number=number,
                lang=lang, is_custom=False, **extra)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class OfflineCardDbTests(unittest.TestCase):
    def setUp(self):
        offline_carddb.reset()
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en,de"),
            Set(id="pbl_en", tcg_set_id="pbl", name="Phantom Blaze", series="Mega", abbreviation="PBL", lang="en", total=2),
            Set(id="viv_en", tcg_set_id="viv", name="Vivid Voltage", series="Sword", abbreviation="VIV", lang="en", total=1),
            Set(id="pbl_de", tcg_set_id="pbl", name="Phantomflamme", series="Mega", abbreviation="PBL", lang="de", total=1),
            _card("pbl-117", "Morpeko", "pbl", "117", price_market=1.5, price_trend=1.2, attacks=[{"name": "Aura Wheel"}]),
            _card("pbl-001", "Pikachu", "pbl", "001", price_market=3.0),
            _card("viv-001", "Eevee", "viv", "001"),
            _card("pbl-117", "Morpeko", "pbl", "117", lang="de", price_market=1.4),
            Card(id="custom-1", name="My Custom", set_id="pbl", number="9", lang="en", is_custom=True, custom_owner_id=1),
        ])
        self.db.commit()
        self.db.refresh(self.user)

        def override_db():
            session = self.Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_db
        main.app.dependency_overrides[get_current_user] = lambda: self.user
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    def tearDown(self):
        self.db.close()
        offline_carddb.reset()

    def _manifest(self, lang="en"):
        response = self.client.get(f"/api/offline/carddb/manifest?lang={lang}")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["languages"][lang]

    def _set_hashes(self, lang="en"):
        return {item["id"]: item["hash"] for item in self._manifest(lang)["sets"]}

    def test_manifest_lists_sets_with_hash_count_and_bytes(self):
        info = self._manifest()
        self.assertEqual({item["id"] for item in info["sets"]}, {"pbl_en", "viv_en"})
        pbl = next(item for item in info["sets"] if item["id"] == "pbl_en")
        self.assertEqual(pbl["cards"], 2)  # the custom card is not included
        self.assertGreater(pbl["bytes"], 0)
        self.assertEqual(info["card_count"], 3)
        self.assertTrue(info["hash"] and info["prices_hash"])

    def test_manifest_covers_every_synced_language(self):
        response = self.client.get("/api/offline/carddb/manifest")
        self.assertEqual(set(response.json()["languages"]), {"en", "de"})

    def test_unknown_language_is_refused(self):
        self.assertEqual(self.client.get("/api/offline/carddb/manifest?lang=ja").status_code, 404)

    def test_hashes_do_not_change_when_nothing_changed(self):
        first = self._manifest()
        offline_carddb.invalidate()
        second = self._manifest()
        self.assertEqual(first["hash"], second["hash"])
        self.assertEqual(first["sets"], second["sets"])
        self.assertEqual(first["prices_hash"], second["prices_hash"])

    def test_changing_one_set_changes_only_that_sets_hash_and_the_language_hash(self):
        before = self._manifest()
        before_sets = {item["id"]: item["hash"] for item in before["sets"]}
        card = self.db.query(Card).filter(Card.id == "viv-001_en").one()
        card.name = "Eevee V"
        self.db.commit()
        offline_carddb.invalidate()
        after = self._manifest()
        after_sets = {item["id"]: item["hash"] for item in after["sets"]}
        self.assertNotEqual(before_sets["viv_en"], after_sets["viv_en"])
        self.assertEqual(before_sets["pbl_en"], after_sets["pbl_en"])
        self.assertNotEqual(before["hash"], after["hash"])
        self.assertEqual(before["prices_hash"], after["prices_hash"])

    def test_a_price_change_touches_only_the_prices_hash(self):
        before = self._manifest()
        card = self.db.query(Card).filter(Card.id == "pbl-117_en").one()
        card.price_market = 9.99
        self.db.commit()
        offline_carddb.invalidate(static=False, prices=True)
        after = self._manifest()
        self.assertEqual(before["hash"], after["hash"])
        self.assertEqual(before["sets"], after["sets"])
        self.assertNotEqual(before["prices_hash"], after["prices_hash"])

    def test_a_card_added_by_a_live_lookup_is_noticed_without_an_explicit_invalidation(self):
        before = self._set_hashes()
        self.db.add(_card("viv-002", "Raichu", "viv", "002"))
        self.db.commit()
        self.assertNotEqual(before["viv_en"], self._set_hashes()["viv_en"])

    def test_set_payload_is_gzip_json_with_the_hash_as_etag_and_304_when_unchanged(self):
        info = next(item for item in self._manifest()["sets"] if item["id"] == "pbl_en")
        response = self.client.get("/api/offline/carddb/sets/en/pbl_en")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["etag"], f'"{info["hash"]}"')
        self.assertEqual(response.headers["content-encoding"], "gzip")
        body = response.json()  # the client decodes the gzip body
        self.assertEqual(body["set"]["name"], "Phantom Blaze")
        names = {dict(zip(body["fields"], row))["name"] for row in body["cards"]}
        self.assertEqual(names, {"Morpeko", "Pikachu"})
        again = self.client.get("/api/offline/carddb/sets/en/pbl_en", headers={"If-None-Match": response.headers["etag"]})
        self.assertEqual(again.status_code, 304)
        self.assertEqual(again.content, b"")

    def test_set_payload_has_no_prices_and_no_user_data(self):
        body = self.client.get("/api/offline/carddb/sets/en/pbl_en").json()
        self.assertFalse([field for field in body["fields"] if field.startswith("price_")])
        text = json.dumps(body)
        self.assertNotIn("My Custom", text)
        self.assertNotIn("owned", text)

    def test_prices_file_is_separate_with_its_own_etag(self):
        response = self.client.get("/api/offline/carddb/prices/en")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["etag"], f'"{self._manifest()["prices_hash"]}"')
        body = response.json()
        self.assertIn("price_market", body["fields"])
        by_id = {row[0]: dict(zip(["id", *body["fields"]], row)) for row in body["rows"]}
        self.assertEqual(by_id["pbl-117_en"]["price_market"], 1.5)
        self.assertNotIn("viv-001_en", by_id)  # no prices at all -> not listed
        again = self.client.get("/api/offline/carddb/prices/en", headers={"If-None-Match": response.headers["etag"]})
        self.assertEqual(again.status_code, 304)

    def test_unknown_set_is_404(self):
        self.assertEqual(self.client.get("/api/offline/carddb/sets/en/nope_en").status_code, 404)

    def test_flag_off_refuses_every_endpoint(self):
        with patch.dict(os.environ, {"OFFLINE_CARD_DB_ENABLED": "false"}):
            for path in ("manifest", "sets/en/pbl_en", "prices/en"):
                self.assertEqual(self.client.get(f"/api/offline/carddb/{path}").status_code, 404, path)

    def test_flag_defaults_to_on(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OFFLINE_CARD_DB_ENABLED", None)
            self.assertTrue(offline_carddb.offline_carddb_enabled())
        for value in ("0", "false", "No", "off"):
            with patch.dict(os.environ, {"OFFLINE_CARD_DB_ENABLED": value}):
                self.assertFalse(offline_carddb.offline_carddb_enabled(), value)

    def test_signed_out_requests_are_refused(self):
        main.app.dependency_overrides.pop(get_current_user, None)
        for path in ("manifest", "sets/en/pbl_en", "prices/en"):
            self.assertIn(self.client.get(f"/api/offline/carddb/{path}").status_code, (401, 403), path)

    def test_sync_wrappers_invalidate_the_cache(self):
        self._manifest()
        before = offline_carddb._price_version
        offline_carddb.with_invalidation(static=False, prices=True)(lambda: None)()
        self.assertEqual(offline_carddb._price_version, before + 1)


if __name__ == "__main__":
    unittest.main()
