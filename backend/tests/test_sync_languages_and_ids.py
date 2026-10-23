"""Sync requests: deselected languages, encoded ids, padded card numbers, the card-details cap, the audit."""

import datetime
import unittest
from unittest.mock import MagicMock, patch

try:
    import httpx
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, CollectionItem, Set, Setting, SyncLog, User, WishlistItem
    from scripts import tcgdex_audit
    from services import card_picture_packs, offline_carddb, pokemon_api, sync_progress
    from services import sync_service
    from services.card_fallbacks import apply_cross_language_fallbacks
    from services.card_metadata import (
        count_cards_missing_metadata,
        enrich_card_metadata,
        enrich_cards_metadata,
        enrich_missing_card_metadata,
    )

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


_REAL_CLIENT = httpx.Client if DEPS else None


def _recording_client_factory(handler, paths):
    """httpx.Client replacement that answers from ``handler`` and records each raw request path."""
    def respond(request):
        paths.append(request.url.raw_path.decode())
        return handler(request)

    def factory(*args, **kwargs):
        kwargs.pop("timeout", None)
        return _REAL_CLIENT(transport=httpx.MockTransport(respond), **kwargs)

    return factory


@unittest.skipUnless(DEPS, "Backend sync dependencies are not installed")
class EncodedTcgdexIdTests(unittest.TestCase):
    def test_set_detail_and_card_list_encode_reserved_characters(self):
        paths = []
        handler = lambda request: httpx.Response(200, json={"id": "SM1+", "cards": []})
        with patch.object(pokemon_api.httpx, "Client", _recording_client_factory(handler, paths)):
            pokemon_api.get_set_detail("SM1+", lang="ja")
            pokemon_api.get_set_cards("sm2+", lang="ja")
        self.assertEqual(paths, ["/v2/ja/sets/SM1%2B", "/v2/ja/sets/sm2%2B"])

    def test_card_id_is_encoded_as_one_path_segment(self):
        paths = []
        handler = lambda request: httpx.Response(200, json={"id": "x"})
        with patch.object(pokemon_api.httpx, "Client", _recording_client_factory(handler, paths)):
            pokemon_api.get_card("a/b+c d?e#f", lang="en")
        self.assertEqual(paths, ["/v2/en/cards/a%2Fb%2Bc%20d%3Fe%23f"])

    def test_set_list_requests_encode_set_and_series_ids(self):
        paths = []

        def handler(request):
            path = request.url.raw_path.decode()
            if path.endswith("/ja/sets"):
                return httpx.Response(200, json=[{"id": "SM1+", "name": "SM1+"}])
            if path.endswith("/ja/series"):
                return httpx.Response(200, json=[{"id": "S+M", "name": "Sun"}])
            if "/series/" in path:
                return httpx.Response(200, json={"id": "S+M", "name": "Sun", "sets": [{"id": "SM1+"}]})
            return httpx.Response(200, json={"id": "SM1+", "name": "SM1+", "cardCount": {"total": 51}})

        with patch.object(pokemon_api.httpx, "Client", _recording_client_factory(handler, paths)):
            sets = pokemon_api.get_all_sets(languages=["ja"])
        self.assertEqual(sets[0]["_db_key"], "SM1+_ja")
        self.assertIn("/v2/ja/series/S%2BM", paths)
        self.assertIn("/v2/ja/sets/SM1%2B", paths)
        self.assertFalse([p for p in paths if "+" in p])


@unittest.skipUnless(DEPS, "Backend sync dependencies are not installed")
class PaddedCardNumberTests(unittest.TestCase):
    def test_unpadded_card_id(self):
        self.assertEqual(pokemon_api.unpadded_card_id("neo4-001"), "neo4-1")
        self.assertEqual(pokemon_api.unpadded_card_id("neo4-010"), "neo4-10")
        self.assertEqual(pokemon_api.unpadded_card_id("sv1-000"), "sv1-0")
        self.assertIsNone(pokemon_api.unpadded_card_id("neo4-1"))
        self.assertIsNone(pokemon_api.unpadded_card_id("neo4-10"))
        self.assertIsNone(pokemon_api.unpadded_card_id("swsh12tg-TG01"))
        self.assertIsNone(pokemon_api.unpadded_card_id("neo4"))

    def test_padded_id_that_404s_is_retried_with_tcgdexs_id(self):
        paths = []

        def handler(request):
            if request.url.raw_path.decode().endswith("/neo4-1"):
                return httpx.Response(200, json={"id": "neo4-1", "localId": "1", "name": "Dark Ampharos"})
            return httpx.Response(404)

        with patch.object(pokemon_api.httpx, "Client", _recording_client_factory(handler, paths)):
            card = pokemon_api.get_card("neo4-001", lang="en")
            missing = pokemon_api.get_card("neo4-99", lang="en")
        self.assertEqual(card["id"], "neo4-1")
        self.assertIsNone(missing)
        self.assertEqual(paths, ["/v2/en/cards/neo4-001", "/v2/en/cards/neo4-1", "/v2/en/cards/neo4-99"])

    def test_unpadded_id_that_404s_is_not_retried(self):
        paths = []
        with patch.object(pokemon_api.httpx, "Client", _recording_client_factory(lambda r: httpx.Response(404), paths)):
            self.assertIsNone(pokemon_api.get_card("neo4-1", lang="en"))
        self.assertEqual(paths, ["/v2/en/cards/neo4-1"])

    def test_legacy_padded_row_keeps_its_id_and_learns_tcgdexs_id(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine, autoflush=False)()
        try:
            db.add(Card(id="neo4-001_en", tcg_card_id="neo4-001", name="Dark Ampharos", lang="en", set_id="neo4", number="001"))
            db.commit()
            card = db.query(Card).one()
            detail = {"id": "neo4-1", "localId": "1", "name": "Dark Ampharos", "category": "Pokemon", "rarity": "Rare",
                      "types": ["Lightning"], "hp": 70, "set": {"id": "neo4"}}
            with patch("services.card_metadata.pokemon_api.get_card", return_value=detail) as get_card:
                enrich_card_metadata(db, card)
            get_card.assert_called_once_with("neo4-001", lang="en")
            db.commit()
            row = db.query(Card).one()  # still exactly one row: collections keep pointing at it
            self.assertEqual(row.id, "neo4-001_en")
            self.assertEqual(row.tcg_card_id, "neo4-1")
            self.assertEqual(row.rarity, "Rare")
        finally:
            db.close()


@unittest.skipUnless(DEPS, "Backend sync dependencies are not installed")
class DeselectedLanguageTests(unittest.TestCase):
    """Selected: en. Deselected: ja, with cards a user owns / wants in it."""

    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine, autoflush=False)()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en"),
            Setting(key="tcgdex_digital_sets_enabled", value="false"),
            Set(id="sv1_en", tcg_set_id="sv1", name="SV1", lang="en", total=1, release_date="2023-01-01"),
            Set(id="sv9_ja", tcg_set_id="sv9", name="SV9 JA", lang="ja", total=2),
            Card(id="sv1-1_en", tcg_card_id="sv1-1", name="EN card", set_id="sv1", number="1", lang="en", images_small="https://x/en/low.webp"),
            Card(id="sv9-1_ja", tcg_card_id="sv9-1", name="JA owned", set_id="sv9", number="1", lang="ja", images_small="https://x/ja/low.webp"),
            Card(id="sv9-2_ja", tcg_card_id="sv9-2", name="JA wanted", set_id="sv9", number="2", lang="ja", images_small="https://x/ja2/low.webp"),
        ])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.add_all([
            CollectionItem(card_id="sv9-1_ja", user_id=self.user.id, quantity=1, condition="NM", variant="Normal",
                           lang="ja", added_at=datetime.datetime.utcnow()),
            WishlistItem(card_id="sv9-2_ja", user_id=self.user.id, quantity=1, created_at=datetime.datetime.utcnow()),
        ])
        self.db.commit()

    def tearDown(self):
        sync_progress.finish()
        self.db.close()

    def _tcgdex(self):
        """Patches every TCGdex call in pokemon_api; ``calls`` records (function, language)."""
        calls = []

        def make(name, result):
            def fake(*args, **kwargs):
                lang = kwargs.get("lang")
                if name == "get_all_sets":
                    for language in kwargs.get("languages") or []:
                        calls.append((name, language))
                else:
                    calls.append((name, lang))
                return result(*args, **kwargs) if callable(result) else result
            return fake

        patches = [
            patch.object(pokemon_api, "get_all_sets", make("get_all_sets", [])),
            patch.object(pokemon_api, "get_set_detail", make("get_set_detail", None)),
            patch.object(pokemon_api, "get_set_cards", make("get_set_cards", {"cards": []})),
            patch.object(pokemon_api, "get_card", make("get_card", None)),
        ]
        return calls, patches

    def _languages_requested(self, calls):
        return {lang for _name, lang in calls}

    def test_full_sync_requests_nothing_for_a_deselected_language(self):
        calls, patches = self._tcgdex()
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        with patch.object(sync_service, "check_wishlist_alerts"), patch.object(sync_service, "take_portfolio_snapshot"), \
             patch.object(sync_service, "check_custom_card_matches"):
            result = sync_service._perform_full_sync_locked(self.db)

        self.assertEqual(result["status"], "success")
        self.assertTrue(calls)  # the English set list at least
        self.assertEqual(self._languages_requested(calls), {"en"})
        # What people own in the deselected language is kept and untouched.
        self.assertIsNotNone(self.db.query(Card).filter(Card.id == "sv9-1_ja").first())
        self.assertEqual(self.db.query(CollectionItem).count(), 1)
        self.assertEqual(self.db.query(Set).filter(Set.id == "sv9_ja").count(), 1)
        self.assertEqual(self.db.query(SyncLog).one().status, "success")

    def test_price_sync_requests_nothing_for_a_deselected_language(self):
        calls, patches = self._tcgdex()
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        with patch.object(sync_service, "check_wishlist_alerts"), patch.object(sync_service, "take_portfolio_snapshot"):
            sync_service.perform_price_sync(self.db, force=True)
        self.assertEqual([c for c in calls if c[1] == "ja"], [])

    def test_price_plan_skips_deselected_language_cards_even_when_tracked(self):
        plan = sync_service._price_sync_plan(self.db, force=True)
        self.assertEqual(plan["ids"], [])
        self.assertEqual(plan["total_syncable"], 0)

    def test_retry_queue_entries_for_a_deselected_language_do_nothing(self):
        calls, patches = self._tcgdex()
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.assertIsNone(sync_service._fetch_and_store_price_card(self.db, "sv9-1_ja", "Retry"))
        sync_service._retry_card_metadata(self.db, "sv9-1_ja", [])
        self.assertEqual(calls, [])

    def test_metadata_enrichment_skips_deselected_language_cards(self):
        calls, patches = self._tcgdex()
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        result = enrich_missing_card_metadata(self.db, limit=50)
        self.assertEqual(result["attempted"], 1)  # the English card only
        self.assertEqual(self._languages_requested(calls), {"en"})
        explicit = enrich_cards_metadata(self.db, self.db.query(Card).filter(Card.lang == "ja").all(), limit=10, force=True)
        self.assertEqual(explicit["attempted"], 0)
        self.assertEqual([c for c in calls if c[1] == "ja"], [])

    def test_cross_language_fallback_does_not_fetch_a_deselected_sibling_language(self):
        self.db.query(Setting).filter(Setting.key == "tcgdex_sync_languages").one().value = "ja"
        self.db.add(Set(id="sv9_en", tcg_set_id="sv9", name="SV9 EN", lang="en", total=2))
        self.db.commit()
        calls, patches = self._tcgdex()
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        parsed = {"id": "sv9-3_ja", "tcg_card_id": "sv9-3", "lang": "ja", "set_id": "sv9"}
        apply_cross_language_fallbacks(self.db, parsed)
        self.assertEqual(calls, [])  # English is deselected here, so no English sibling is requested

    def test_set_checklist_for_a_deselected_language_set_requests_nothing(self):
        from sqlalchemy import true

        from api.sets import get_set_checklist

        self.db.query(CollectionItem).delete()
        self.db.query(WishlistItem).delete()
        self.db.query(Card).filter(Card.set_id == "sv9").delete()
        self.db.commit()
        calls, patches = self._tcgdex()
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        # An empty stored set of a deselected language: it is shown as stored, nothing is fetched.
        with patch("api.sets.visible_set_filter", return_value=true()):
            get_set_checklist("sv9_ja", db=self.db, current_user=self.user)
        self.assertEqual(calls, [])

    def test_offline_card_database_and_picture_prewarm_cover_selected_languages_only(self):
        self.assertEqual(offline_carddb.languages(self.db), ["en"])
        fetched = []
        with patch.object(offline_carddb, "offline_carddb_enabled", return_value=True):
            card_picture_packs.CardPictureWarmer(sleep=lambda _s: None)._warm(
                self.db, lambda db, key, url: fetched.append(url)
            )
        self.assertEqual(fetched, ["https://x/en/low.webp"])

    def test_switch_restores_syncing_of_pinned_deselected_languages(self):
        with patch.dict("os.environ", {"SYNC_DESELECTED_LANGUAGES": "1"}):
            plan = sync_service._price_sync_plan(self.db, force=True)
        self.assertEqual(sorted(plan["ids"]), ["sv9-1_ja", "sv9-2_ja"])


@unittest.skipUnless(DEPS, "Backend sync dependencies are not installed")
class CardDetailsCapTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine, autoflush=False)()
        self.db.add(Setting(key="tcgdex_sync_languages", value="en,ja"))
        self.db.commit()

    def tearDown(self):
        sync_progress.finish()
        self.db.close()

    def test_default_cap_is_one_thousand_for_a_small_collection(self):
        with patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop("CARD_DETAILS_PER_SYNC", None)
            self.assertEqual(sync_service._metadata_enrichment_limit(self.db), 1000)

    def test_env_setting_raises_the_cap_and_ignores_garbage(self):
        with patch.dict("os.environ", {"CARD_DETAILS_PER_SYNC": "5000"}):
            self.assertEqual(sync_service._metadata_enrichment_limit(self.db), 5000)
        with patch.dict("os.environ", {"CARD_DETAILS_PER_SYNC": "999999"}):
            self.assertEqual(sync_service._metadata_enrichment_limit(self.db), sync_service.MAX_CARD_DETAILS_PER_SYNC_SETTING)
        for bad in ("abc", "0", "-5", ""):
            with patch.dict("os.environ", {"CARD_DETAILS_PER_SYNC": bad}):
                self.assertEqual(sync_service._metadata_enrichment_limit(self.db), 1000)

    def test_backlog_counts_per_language_and_the_cooldown(self):
        now = datetime.datetime.utcnow()
        self.db.add_all([
            Card(id="a-1_en", tcg_card_id="a-1", name="x", lang="en"),
            Card(id="a-2_en", tcg_card_id="a-2", name="x", lang="en", last_metadata_enrichment_attempt_at=now),
            Card(id="b-1_ja", tcg_card_id="b-1", name="x", lang="ja"),
            Card(id="c-1_fr", tcg_card_id="c-1", name="x", lang="fr"),  # deselected: not counted
            Card(id="d-1_en", tcg_card_id="d-1", name="x", lang="en", rarity="Rare", supertype="Trainer", subtypes=["Item"]),
        ])
        self.db.commit()
        backlog = count_cards_missing_metadata(self.db)
        self.assertEqual(backlog["missing"], 3)
        self.assertEqual(backlog["due"], 2)
        self.assertEqual(backlog["per_language"], {"en": 2, "ja": 1})

    def test_full_sync_progress_says_how_much_is_left_overall(self):
        seen = []
        self.db.add_all([Card(id=f"s-{n}_en", tcg_card_id=f"s-{n}", name="x", lang="en") for n in range(5)])
        self.db.commit()

        def record(stage, done=0, total=0, overall_total=None):
            seen.append((stage, done, total, overall_total))

        def enrich(db, limit, on_progress):
            on_progress(2, limit)
            return {"attempted": 0, "updated": 0, "missing": 0, "failed": 0, "ids": [], "transient": []}

        with patch.dict("os.environ", {"CARD_DETAILS_PER_SYNC": "2"}), \
             patch.object(pokemon_api, "get_all_sets", return_value=[]), \
             patch.object(sync_service.sync_progress, "update", side_effect=record), \
             patch.object(sync_service, "enrich_missing_card_metadata", side_effect=lambda db, limit, on_progress: enrich(db, limit, on_progress)), \
             patch.object(sync_service, "check_wishlist_alerts"), patch.object(sync_service, "take_portfolio_snapshot"), \
             patch.object(sync_service, "check_custom_card_matches"):
            sync_service._perform_full_sync_locked(self.db)

        metadata = [entry for entry in seen if entry[0] == "metadata"]
        self.assertEqual(metadata[0], ("metadata", 0, 2, 5))  # 2 this sync, 5 in all
        self.assertEqual(metadata[-1], ("metadata", 2, 2, 5))

    def test_progress_snapshot_carries_overall_total_and_drops_it_for_other_stages(self):
        sync_progress.start("full")
        sync_progress.update("metadata", 1, 1000, overall_total=28412)
        self.assertEqual(sync_progress.snapshot()["overall_total"], 28412)
        sync_progress.update("prices", 0, 10)
        self.assertNotIn("overall_total", sync_progress.snapshot())


@unittest.skipUnless(DEPS, "Backend sync dependencies are not installed")
class AuditScriptTests(unittest.TestCase):
    def _handler(self):
        def handler(request):
            path = request.url.raw_path.decode().replace("/v2/", "", 1)
            lang, _, rest = path.partition("/")
            if rest == "sets":
                return httpx.Response(200, json=[{"id": "SM1+"}, {"id": "neo4"}, {"id": "empty"}] if lang == "ja"
                                      else [{"id": "neo4"}])
            if rest == "series":
                return httpx.Response(200, json=[])
            if rest == "sets/SM1%2B":
                return httpx.Response(200, json={"id": "SM1+", "cardCount": {"total": 1}, "cards": [{"id": "SM1+-1"}]})
            if rest == "sets/neo4":
                return httpx.Response(200, json={"id": "neo4", "cardCount": {"total": 2},
                                                 "cards": [{"id": "neo4-1"}, {"id": "neo4-2"}]})
            if rest == "sets/empty":
                return httpx.Response(200, json={"id": "empty", "cardCount": {"total": 5}})
            if rest in ("cards/neo4-1", "cards/neo4-2", "cards/SM1%2B-1"):
                return httpx.Response(200, json={"id": rest.split("/")[1]})
            if rest == "cards/neo4-boom":
                return httpx.Response(503)
            return httpx.Response(404)
        return handler

    def _audit(self, langs):
        client = httpx.Client(transport=httpx.MockTransport(self._handler()))
        audit = tcgdex_audit.Audit(tcgdex_audit.Fetcher(client, delay=0, retries=1, backoff=0), workers=2)
        with patch.object(tcgdex_audit, "LOG_CARD_IDS", {"en": ["neo4-001", "neo4-999", "neo4-boom"]}), \
             patch.object(tcgdex_audit, "LOG_SET_IDS", {"ja": ["SM1+"]}):
            audit_run = tcgdex_audit.run_audit(langs, use_db=False, delay=0, client=client, progress=lambda m: None)
        return audit, audit_run

    def test_failures_are_grouped_by_cause(self):
        _audit, run = self._audit(["en", "ja"])
        by_cause = {}
        for row in run.rows:
            by_cause.setdefault(row.cause, []).append((row.lang, row.kind, row.id))
        self.assertIn(("ja", "set-unencoded", "SM1+"), by_cause["unencoded_characters"])
        self.assertIn(("en", "card", "neo4-001"), by_cause["padded_number"])
        self.assertIn(("ja", "set", "empty"), by_cause["set_without_cards"])
        self.assertIn(("en", "card", "neo4-999"), by_cause["card_missing_upstream"])
        self.assertIn(("en", "card", "neo4-boom"), by_cause["transient"])
        self.assertNotIn(("en", "card", "neo4-1"), [r for rows in by_cause.values() for r in rows])

    def test_summary_and_csv(self):
        import tempfile
        from pathlib import Path

        _audit, run = self._audit(["en", "ja"])
        text = tcgdex_audit.summarize(run, ["en", "ja"])
        self.assertIn("padded_number", text)
        self.assertIn("unencoded_characters", text)
        with tempfile.TemporaryDirectory() as tmp:
            path = tcgdex_audit.write_csv(run, Path(tmp))
            self.assertTrue(path.read_text(encoding="utf-8").startswith("cause,lang,kind,id,origin,status,url,note"))

    def test_throttle_spaces_requests(self):
        throttle = tcgdex_audit.Throttle(0.05)
        started = datetime.datetime.now()
        for _ in range(4):
            throttle.wait()
        elapsed = (datetime.datetime.now() - started).total_seconds()
        self.assertGreaterEqual(elapsed, 0.14)


if __name__ == "__main__":
    unittest.main()
