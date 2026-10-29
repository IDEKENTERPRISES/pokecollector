import datetime
import unittest

try:
    from fastapi.testclient import TestClient

    import main
    from api.auth import get_current_user
    from database import get_db
    from models import Card, CollectionItem, Set, Setting, UserSetting
    from services import delights
    from test_progress import ProgressTestBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    ProgressTestBase = object

NOW = datetime.datetime(2026, 10, 28, 12, 0)


class ApiBase(ProgressTestBase):
    def setUp(self):
        super().setUp()

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


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class OnThisDayTests(ProgressTestBase):
    def zone(self, name):
        self.db.add(UserSetting(user_id=self.user.id, key="time_zone", value=name))
        self.db.commit()

    def test_only_earlier_years_on_the_same_day(self):
        self.own("tst-001", acquired_at=datetime.datetime(2024, 10, 28, 9))
        self.own("tst-002", acquired_at=datetime.datetime(2026, 10, 28, 9))  # this year: not earlier
        self.own("big-001", acquired_at=datetime.datetime(2025, 10, 27, 9))  # another day
        result = delights.on_this_day(self.db, self.user.id, NOW)
        self.assertEqual([y["year"] for y in result["years"]], [2024])
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["years"][0]["cards"][0]["card_id"], "tst-001_en")
        self.assertEqual(result["years"][0]["cards"][0]["item_id"], self.db.query(CollectionItem).filter_by(card_id="tst-001_en").one().id)

    def test_falls_back_to_added_at_and_acquired_at_wins(self):
        self.own("tst-001", added_at=datetime.datetime(2023, 10, 28, 8))
        self.own("tst-002", added_at=datetime.datetime(2023, 10, 28, 8), acquired_at=datetime.datetime(2020, 3, 1))
        result = delights.on_this_day(self.db, self.user.id, NOW)
        self.assertEqual([(y["year"], y["count"]) for y in result["years"]], [(2023, 1)])

    def test_uses_the_users_time_zone(self):
        # 2025-10-28 23:30 UTC is already 29 Oct in Sydney (UTC+11).
        self.own("tst-001", acquired_at=datetime.datetime(2025, 10, 28, 23, 30))
        self.assertEqual(len(delights.on_this_day(self.db, self.user.id, NOW)["years"]), 1)
        self.zone("Australia/Sydney")
        self.assertEqual(delights.on_this_day(self.db, self.user.id, NOW)["years"], [])
        # 28 Oct 21:00 UTC is 29 Oct 08:00 in Sydney.
        sydney_now = datetime.datetime(2026, 10, 28, 21, 0)
        self.assertEqual(delights.on_this_day(self.db, self.user.id, sydney_now)["years"][0]["year"], 2025)

    def test_leap_day_only_appears_on_29_february(self):
        self.own("tst-001", acquired_at=datetime.datetime(2024, 2, 29, 12))
        self.assertEqual(delights.on_this_day(self.db, self.user.id, datetime.datetime(2028, 2, 29, 12))["total"], 1)
        self.assertEqual(delights.on_this_day(self.db, self.user.id, datetime.datetime(2027, 2, 28, 12))["total"], 0)
        self.assertEqual(delights.on_this_day(self.db, self.user.id, datetime.datetime(2027, 3, 1, 12))["total"], 0)

    def test_other_users_cards_are_ignored_and_empty_is_empty(self):
        self.own("tst-001", user=self.other, acquired_at=datetime.datetime(2024, 10, 28, 9))
        result = delights.on_this_day(self.db, self.user.id, NOW)
        self.assertEqual((result["total"], result["years"]), (0, []))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ShowcaseTests(ApiBase):
    def test_save_and_read_back_in_order(self):
        a, b = self.own("tst-001"), self.own("tst-002")
        response = self.client.put("/api/profile/showcase", json={"ids": [b.id, a.id]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([c["id"] for c in response.json()["cards"]], [b.id, a.id])
        self.assertEqual(response.json()["cards"][0]["market_value"], 5.0)

    def test_rejects_other_users_copies_more_than_six_and_bad_input(self):
        mine = [self.own("tst-001") for _ in range(7)]
        theirs = self.own("tst-002", user=self.other)
        self.assertEqual(self.client.put("/api/profile/showcase", json={"ids": [theirs.id]}).status_code, 400)
        self.assertEqual(self.client.put("/api/profile/showcase", json={"ids": [i.id for i in mine]}).status_code, 400)
        self.assertEqual(self.client.put("/api/profile/showcase", json={"ids": ["x"]}).status_code, 400)
        self.assertEqual(self.client.put("/api/profile/showcase", json={"ids": [i.id for i in mine[:6]]}).status_code, 200)

    def test_missing_ids_are_skipped(self):
        a, b = self.own("tst-001"), self.own("tst-002")
        self.client.put("/api/profile/showcase", json={"ids": [a.id, b.id]})
        self.db.query(CollectionItem).filter(CollectionItem.id == a.id).delete()
        self.db.commit()
        self.assertEqual([c["id"] for c in self.client.get("/api/profile/showcase").json()["cards"]], [b.id])

    def test_public_profile_shows_showcase_and_follows_value_setting(self):
        item = self.own("tst-001")
        self.client.put("/api/profile/showcase", json={"ids": [item.id]})
        self.user.is_profile_public = True
        self.user.public_handle = "ash"
        self.user.public_show_values = False
        self.db.merge(self.user)
        self.db.add(Setting(key="public_profiles_enabled", value="true"))
        self.db.commit()
        body = self.client.get("/api/public/profiles/ash").json()
        self.assertEqual([c["id"] for c in body["showcase"]], [item.id])
        self.assertIsNone(body["showcase"][0]["market_value"])
        self.user.public_show_values = True
        self.db.merge(self.user)
        self.db.commit()
        self.assertEqual(self.client.get("/api/public/profiles/ash").json()["showcase"][0]["market_value"], 5.0)

    def test_nothing_is_exposed_while_the_profile_is_not_public(self):
        item = self.own("tst-001")
        self.client.put("/api/profile/showcase", json={"ids": [item.id]})
        self.db.add(Setting(key="public_profiles_enabled", value="true"))
        self.db.commit()
        self.assertEqual(self.client.get("/api/public/profiles/ash").status_code, 404)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class DnaTests(ApiBase):
    def test_aggregates(self):
        self.db.query(Set).filter(Set.id == "tst_en").update({"release_date": "2023/03/31"})
        self.db.query(Card).filter(Card.id == "tst-001_en").update(
            {"types": ["Fire"], "artist": "Mitsuhiro Arita", "dex_ids": [6], "name": "Charizard"})
        self.db.query(Card).filter(Card.id == "tst-002_en").update(
            {"types": ["Lightning"], "artist": "Mitsuhiro Arita", "dex_ids": [25], "name": "Pikachu"})
        self.db.query(Card).filter(Card.id == "big-001_en").update(
            {"types": ["Fire"], "artist": "Ken Sugimori", "dex_ids": [6], "name": "Charizard ex"})
        self.db.commit()
        first = self.own("tst-001")
        first.quantity = 2
        self.own("tst-002")
        self.own("big-001")
        self.own("tst-001", user=self.other)
        self.db.commit()
        dna = self.client.get("/api/analytics/dna").json()
        self.assertEqual(dna["total_cards"], 4)
        self.assertEqual(dna["types"], [{"type": "fire", "count": 3}, {"type": "lightning", "count": 1}])
        self.assertEqual(dna["illustrators"][0], {"name": "Mitsuhiro Arita", "count": 3})
        self.assertEqual(dna["eras"], [{"year": 2023, "count": 3}])  # big_en has no set row, so no era
        self.assertEqual(dna["pokemon"][0], {"dex_id": 6, "name": "Charizard", "count": 3})

    def test_empty_collection(self):
        response = self.client.get("/api/analytics/dna")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"total_cards": 0, "types": [], "illustrators": [], "eras": [], "pokemon": []})


if __name__ == "__main__":
    unittest.main()
