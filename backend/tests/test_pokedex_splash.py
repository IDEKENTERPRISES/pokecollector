"""The launch splash screen: Pokédex extras cache, GET /api/pokedex/splash and the warm-up.

PokéAPI payloads here are synthetic: fetched Pokédex texts are never committed (size and IP).
"""

import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import httpx

from services import pokedex_extras, pokedex_images, pokedex_splash

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    API_TEST_DEPS_AVAILABLE = True
except ImportError:  # pragma: no cover - lightweight test environments
    API_TEST_DEPS_AVAILABLE = False


def pokemon_payload(weight=60, height=4):
    return {"id": 25, "weight": weight, "height": height, "moves": [{"move": {"name": "x"}}] * 3}


def species_payload():
    return {
        "genera": [
            {"genus": "Test Pokémon", "language": {"name": "en"}},
            {"genus": "Test-Art", "language": {"name": "de"}},
            {"genus": "Pokémon Test", "language": {"name": "fr"}},
        ],
        "flavor_text_entries": [
            {"flavor_text": "It keeps\fits tail\nraised to\nwatch for\fPOKéMON.", "language": {"name": "en"}},
            {"flavor_text": "It keeps its tail raised to watch for Pokémon.", "language": {"name": "en"}},
            {"flavor_text": "A sec­\nond line, with a\fbreak.", "language": {"name": "en"}},
            {"flavor_text": "Ein Test-\nEintrag.", "language": {"name": "de"}},
            {"flavor_text": "Une entrée.", "language": {"name": "fr"}},
        ],
    }


def record(dex_id, en=("An English entry.",), de=("Ein deutscher Eintrag.",), weight=6.0, height=0.4):
    return {
        "v": 1, "dex_id": dex_id, "weight_kg": weight, "height_m": height,
        "genus": {"en": "Test Pokémon"}, "flavor": {"en": list(en), "de": list(de)},
    }


class CacheRootTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_root = pokedex_images.CACHE_ROOT
        pokedex_images.CACHE_ROOT = Path(self.temp_dir.name)
        pokedex_extras.clear_index()
        pokedex_splash.splash_throttle.reset()
        pokedex_splash.on_demand_budget.reset()

    def tearDown(self):
        pokedex_images.CACHE_ROOT = self.old_root
        pokedex_extras.clear_index()
        self.temp_dir.cleanup()

    def seed(self, dex_id, **kwargs):
        pokedex_extras._write_json_atomic(pokedex_extras.extras_path(dex_id), record(dex_id, **kwargs))
        pokedex_extras.clear_index()


class FlavorTextTests(unittest.TestCase):
    def test_page_and_line_breaks_become_spaces(self):
        self.assertEqual(
            pokedex_extras.clean_flavor_text("When several\fof these\nPOKéMON gather."),
            "When several of these Pokémon gather.",
        )

    def test_soft_hyphen_breaks_join_the_word(self):
        self.assertEqual(pokedex_extras.clean_flavor_text("elec­\ntricity"), "electricity")

    def test_old_capitals_are_normalised(self):
        self.assertEqual(pokedex_extras.clean_flavor_text("A POKé BALL"), "A Poké Ball")


class ParseExtrasTests(unittest.TestCase):
    def test_reduces_both_resources_to_the_cached_record(self):
        extras = pokedex_extras.parse_extras(25, pokemon_payload(), species_payload())
        self.assertEqual(extras["dex_id"], 25)
        self.assertEqual(extras["weight_kg"], 6.0)  # 60 hectograms
        self.assertEqual(extras["height_m"], 0.4)  # 4 decimetres
        self.assertEqual(extras["genus"], {"en": "Test Pokémon", "de": "Test-Art"})
        # Cleaned, de-duplicated across versions, other languages dropped.
        self.assertEqual(extras["flavor"]["en"], [
            "It keeps its tail raised to watch for Pokémon.",
            "A second line, with a break.",
        ])
        self.assertEqual(extras["flavor"]["de"], ["Ein Test-Eintrag."])
        self.assertNotIn("fr", extras["flavor"])
        self.assertNotIn("moves", extras)

    def test_missing_numbers_stay_empty(self):
        extras = pokedex_extras.parse_extras(25, {"weight": 0}, {})
        self.assertIsNone(extras["weight_kg"])
        self.assertIsNone(extras["height_m"])
        self.assertEqual(extras["flavor"], {})


class ExtrasCacheTests(CacheRootTestCase):
    def client_for(self, handler):
        return httpx.Client(transport=httpx.MockTransport(handler))

    def test_fetches_both_resources_once_and_writes_json_to_the_data_volume(self):
        calls = []

        def handler(request):
            calls.append(request.url.path)
            payload = species_payload() if "pokemon-species" in request.url.path else pokemon_payload()
            return httpx.Response(200, json=payload)

        with self.client_for(handler) as client:
            extras = pokedex_extras.fetch_extras(25, client=client)
            again = pokedex_extras.fetch_extras(25, client=client)

        self.assertEqual(calls, ["/api/v2/pokemon/25", "/api/v2/pokemon-species/25"])
        self.assertEqual(again, extras)
        path = Path(self.temp_dir.name) / "extras" / "25.json"
        self.assertTrue(path.is_file())
        self.assertFalse(any(path.parent.glob("*.tmp")))
        self.assertEqual(pokedex_extras.cached_species_ids(), frozenset({25}))

    def test_unknown_species_returns_none_without_writing(self):
        with self.client_for(lambda request: httpx.Response(404)) as client:
            self.assertIsNone(pokedex_extras.fetch_extras(25, client=client))
        self.assertEqual(pokedex_extras.cached_species_ids(), frozenset())

    def test_server_errors_and_timeouts_raise_unavailable(self):
        with self.client_for(lambda request: httpx.Response(503)) as client:
            with self.assertRaises(pokedex_extras.ExtrasUnavailable):
                pokedex_extras.fetch_extras(25, client=client)

        def timeout(request):
            raise httpx.ConnectTimeout("slow", request=request)

        with self.client_for(timeout) as client:
            with self.assertRaises(pokedex_extras.ExtrasUnavailable):
                pokedex_extras.fetch_extras(25, client=client)

    def test_index_ignores_stray_files_and_bad_numbers(self):
        self.seed(7)
        folder = Path(self.temp_dir.name) / "extras"
        (folder / "notes.txt").write_text("x")
        (folder / "0.json").write_text("{}")
        (folder / "9999.json").write_text("{}")
        (folder / ".8-abc.tmp").write_text("{}")
        pokedex_extras.clear_index()
        self.assertEqual(pokedex_extras.cached_species_ids(), frozenset({7}))

    def test_unreadable_record_counts_as_missing(self):
        folder = Path(self.temp_dir.name) / "extras"
        folder.mkdir(parents=True)
        (folder / "12.json").write_text("{not json")
        self.assertIsNone(pokedex_extras.load_extras(12))

    def test_rejects_numbers_outside_the_national_dex(self):
        with self.assertRaises(ValueError):
            pokedex_extras.extras_path(0)
        with self.assertRaises(ValueError):
            pokedex_extras.extras_path(1026)


class SeenBagTests(unittest.TestCase):
    def test_round_trip(self):
        ids = {1, 8, 9, 25, 649, 1025}
        encoded = pokedex_splash.encode_seen(ids)
        self.assertLessEqual(len(encoded), 172)
        self.assertEqual(pokedex_splash.decode_seen(encoded), frozenset(ids))

    def test_matches_the_frontend_bit_order(self):
        # Species 1 is bit 0 of byte 0; species 9 is bit 0 of byte 1 (shuffleBag.test.js).
        self.assertEqual(pokedex_splash.encode_seen({1, 9})[:3], "AQE")

    def test_garbage_is_an_empty_bag(self):
        self.assertEqual(pokedex_splash.decode_seen("%%%"), frozenset())
        self.assertEqual(pokedex_splash.decode_seen(""), frozenset())
        self.assertEqual(pokedex_splash.decode_seen(None), frozenset())


class SplashEntryTests(CacheRootTestCase):
    def test_prefers_cached_species_the_device_has_not_seen(self):
        for dex_id in (4, 7, 25):
            self.seed(dex_id)
        seen = frozenset({4, 25})
        with patch.object(pokedex_extras, "fetch_extras") as fetch:
            for seed in range(20):
                entry = pokedex_splash.splash_entry(seen=seen, rng=random.Random(seed))
                self.assertEqual(entry["dex_id"], 7)
        fetch.assert_not_called()

    def test_fetches_a_new_species_when_every_cached_one_was_seen(self):
        self.seed(25)

        def fake_fetch(dex_id, **kwargs):
            pokedex_extras._write_json_atomic(pokedex_extras.extras_path(dex_id), record(dex_id))
            return record(dex_id)

        with patch.object(pokedex_extras, "fetch_extras", side_effect=fake_fetch) as fetch:
            entry = pokedex_splash.splash_entry(seen=frozenset({25}), rng=random.Random(3))
        self.assertNotEqual(entry["dex_id"], 25)
        fetch.assert_called_once()
        self.assertEqual(fetch.call_args.kwargs["timeout"], pokedex_splash.ON_DEMAND_TIMEOUT_SECONDS)
        self.assertEqual(entry["weight_kg"], 6.0)

    def test_falls_back_to_a_cached_species_while_pokeapi_is_down(self):
        self.seed(25)
        with patch.object(pokedex_extras, "fetch_extras",
                          side_effect=pokedex_extras.ExtrasUnavailable("down")):
            entry = pokedex_splash.splash_entry(seen=frozenset({25}), rng=random.Random(1))
        self.assertEqual(entry["dex_id"], 25)
        self.assertEqual(entry["fact"], "An English entry.")

    def test_nothing_cached_and_pokeapi_down_still_answers_from_the_catalogue(self):
        with patch.object(pokedex_extras, "fetch_extras",
                          side_effect=pokedex_extras.ExtrasUnavailable("down")):
            entry = pokedex_splash.splash_entry(requested_id=25, rng=random.Random(1))
        self.assertEqual(entry["name"], "Pikachu")
        self.assertIsNone(entry["weight_kg"])
        self.assertEqual(entry["fact"], "Pikachu is an Electric-type Pokémon from Kanto.")

    def test_the_on_demand_budget_limits_pokeapi_calls(self):
        with patch.object(pokedex_extras, "fetch_extras", return_value=None) as fetch:
            for seed in range(pokedex_splash.ON_DEMAND_FETCHES_PER_MINUTE + 5):
                pokedex_splash.splash_entry(rng=random.Random(seed))
        self.assertEqual(fetch.call_count, pokedex_splash.ON_DEMAND_FETCHES_PER_MINUTE)

    def test_payload_shape_language_and_sprite(self):
        self.seed(25)
        entry = pokedex_splash.splash_entry(lang="de", requested_id=25, rng=random.Random(0))
        self.assertEqual(entry, {
            "dex_id": 25, "name": "Pikachu", "lang": "de", "generation": 1, "region": "Kanto",
            "types": ["electric"], "weight_kg": 6.0, "height_m": 0.4, "genus": "Test Pokémon",
            "fact": "Ein deutscher Eintrag.", "sprite_url": "/api/pokedex/images/animated/25.gif",
        })
        self.assertEqual(pokedex_splash.splash_entry(lang="fr-FR", requested_id=25)["lang"], "en")

    def test_static_sprite_after_black_and_white(self):
        self.assertEqual(pokedex_splash.sprite_url(649), "/api/pokedex/images/animated/649.gif")
        self.assertEqual(pokedex_splash.sprite_url(650), "/api/pokedex/images/sprites/650.png")
        with patch.object(pokedex_splash, "SPRITE_STYLE", "showdown"):
            self.assertEqual(pokedex_splash.sprite_url(1000), "/api/pokedex/images/showdown/1000.gif")

    def test_prefers_short_entries_and_falls_back_to_english(self):
        long_text = "x" * (pokedex_splash.FACT_MAX_CHARS + 1)
        self.seed(1, en=(long_text, "Short."), de=())
        entry = pokedex_splash.splash_entry(lang="de", requested_id=1, rng=random.Random(0))
        self.assertEqual(entry["name"], "Bisasam")
        self.assertEqual(entry["fact"], "Short.")

    def test_data_facts(self):
        catalogue = {"name_en": "Eevee", "name_de": "Evoli", "region": "Kanto", "types": ["normal"]}
        self.assertEqual(pokedex_splash.data_fact(catalogue, {"height_m": 0.3}, "en"),
                         "Eevee is a Normal-type Pokémon from Kanto, 0.3 m tall.")
        self.assertEqual(pokedex_splash.data_fact(catalogue, {"height_m": 0.3}, "de"),
                         "Evoli ist ein Pokémon vom Typ Normal aus Kanto, 0,3 m groß.")
        with patch.object(pokedex_splash, "FACT_SOURCE", "data"):
            self.seed(25)
            entry = pokedex_splash.splash_entry(requested_id=25)
        self.assertEqual(entry["fact"], "Pikachu is an Electric-type Pokémon from Kanto, 0.4 m tall.")


class ThrottleTests(unittest.TestCase):
    def test_sliding_window(self):
        now = [100.0]
        throttle = pokedex_splash.SlidingWindowThrottle(2, 60, clock=lambda: now[0])
        self.assertEqual(throttle.hit("a"), 0)
        self.assertEqual(throttle.hit("a"), 0)
        self.assertEqual(throttle.hit("a"), 60)
        self.assertEqual(throttle.hit("b"), 0)
        now[0] = 161.0
        self.assertEqual(throttle.hit("a"), 0)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class SplashApiTests(CacheRootTestCase):
    def setUp(self):
        super().setUp()
        from api.auth import get_current_user
        from api.pokedex import router

        self.user = Mock(role="admin")
        app = FastAPI()
        app.include_router(router, prefix="/api/pokedex")
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def test_public_small_and_never_cached(self):
        self.seed(25)
        with patch.object(pokedex_extras, "fetch_extras", side_effect=AssertionError("no fetch")):
            response = self.client.get("/api/pokedex/splash", params={"id": 25, "lang": "en"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.json()["name"], "Pikachu")
        self.assertLess(len(response.content), 1024)

    def test_route_is_not_swallowed_by_the_species_route(self):
        self.seed(25)
        response = self.client.get("/api/pokedex/splash", params={"seen": pokedex_splash.encode_seen({1})})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["dex_id"], 25)

    def test_throttled_per_client(self):
        self.seed(25)
        for _ in range(pokedex_splash.SPLASH_REQUESTS_PER_WINDOW):
            self.assertEqual(self.client.get("/api/pokedex/splash").status_code, 200)
        response = self.client.get("/api/pokedex/splash")
        self.assertEqual(response.status_code, 429)
        self.assertGreaterEqual(int(response.headers["retry-after"]), 1)

    def test_rejects_bad_parameters(self):
        self.assertEqual(self.client.get("/api/pokedex/splash", params={"id": 0}).status_code, 422)
        self.assertEqual(self.client.get("/api/pokedex/splash", params={"seen": "x" * 300}).status_code, 422)

    def test_animated_sprite_and_static_fallback(self):
        animated = pokedex_images.cache_path("animated", 25)
        animated.parent.mkdir(parents=True)
        animated.write_bytes(b"GIF89a")
        static = pokedex_images.cache_path("sprites", 700)
        static.parent.mkdir(parents=True)
        static.write_bytes(b"\x89PNG")

        response = self.client.get("/api/pokedex/images/animated/25.gif")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/gif")
        self.assertEqual(response.content, b"GIF89a")

        with patch("api.pokedex.fetch_image", side_effect=AssertionError("no fetch")):
            response = self.client.get("/api/pokedex/images/animated/700.gif")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/png")

        self.assertEqual(self.client.get("/api/pokedex/images/secret/25.gif").status_code, 404)
        self.assertEqual(self.client.get("/api/pokedex/images/animated/2000.gif").status_code, 404)

    def test_warm_up_is_admin_only(self):
        with patch.object(pokedex_splash.splash_cache_warmer, "start", return_value={"running": True}) as start:
            self.assertEqual(self.client.post("/api/pokedex/splash/cache").json(), {"running": True})
            start.assert_called_once()
            self.user = Mock(role="user")
            self.assertEqual(self.client.post("/api/pokedex/splash/cache").status_code, 403)
            self.assertEqual(self.client.get("/api/pokedex/splash/cache").status_code, 403)
            start.assert_called_once()


class WarmUpTests(CacheRootTestCase):
    def test_fills_missing_species_at_a_polite_rate_and_counts_failures(self):
        self.seed(1)
        sprite = pokedex_images.cache_path("animated", 1)
        sprite.parent.mkdir(parents=True)
        sprite.write_bytes(b"GIF89a")
        pauses = []
        warmer = pokedex_splash.SplashCacheWarmer(sleep=pauses.append)

        def fake_fetch(dex_id, **kwargs):
            if dex_id == 3:
                raise pokedex_extras.ExtrasUnavailable("down")
            return record(dex_id)

        with patch.object(pokedex_splash, "MAX_DEX_ID", 4), \
             patch.object(pokedex_extras, "fetch_extras", side_effect=fake_fetch) as fetch, \
             patch.object(pokedex_images, "fetch_image", return_value=None) as fetch_image:
            warmer.run()

        state = warmer.status()
        self.assertEqual(state["done"], 4)
        self.assertEqual(state["failed"], 1)
        self.assertEqual(state["downloaded"], 2)  # species 2 and 4
        self.assertFalse(state["running"])
        self.assertEqual([call.args[0] for call in fetch.call_args_list], [2, 3, 4])
        self.assertEqual([call.args[1] for call in fetch_image.call_args_list], [2, 4])
        # Two PokéAPI calls and one sprite per new species at 5 requests per second.
        self.assertAlmostEqual(sum(pauses), (3 + 3 + 1) / pokedex_splash.WARM_REQUESTS_PER_SECOND)


if __name__ == "__main__":
    unittest.main()
