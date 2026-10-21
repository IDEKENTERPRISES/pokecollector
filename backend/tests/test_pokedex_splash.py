"""The launch splash: Pokémon of the day, the extras cache, sprites and GET /api/pokedex/splash.

PokéAPI payloads here are synthetic: fetched Pokédex texts are never committed (size and IP).
"""

import tempfile
import unittest
from collections import Counter
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

import httpx

from services import pokedex_extras, pokedex_facts, pokedex_images, pokedex_splash

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    API_TEST_DEPS_AVAILABLE = True
except ImportError:  # pragma: no cover - lightweight test environments
    API_TEST_DEPS_AVAILABLE = False

DAY = date(2026, 10, 21)


def group(number):
    return {"name": f"group-{number}", "url": f"https://pokeapi.co/api/v2/version-group/{number}/"}


def learned(level, method, number):
    return {"level_learned_at": level, "move_learn_method": {"name": method}, "version_group": group(number)}


def pokemon_payload(weight=60, height=4):
    return {
        "weight": weight,
        "height": height,
        "abilities": [
            {"ability": {"name": "lightning-rod"}, "is_hidden": True, "slot": 3},
            {"ability": {"name": "static"}, "is_hidden": False, "slot": 1},
        ],
        "moves": [
            {"move": {"name": "thunder"}, "version_group_details": [learned(44, "level-up", 25), learned(41, "level-up", 20)]},
            {"move": {"name": "thunder-shock"}, "version_group_details": [learned(1, "level-up", 25)]},
            {"move": {"name": "volt-tackle"}, "version_group_details": [learned(0, "egg", 25)]},
            # A newer game that lists only machine moves must not hide the level-up moves.
            {"move": {"name": "thunderbolt"}, "version_group_details": [learned(0, "machine", 30)]},
        ],
    }


def species_payload(**traits):
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
        "evolution_chain": {"url": "https://pokeapi.co/api/v2/evolution-chain/10/"},
        "is_legendary": False,
        "is_mythical": False,
        "is_baby": False,
        "capture_rate": 190,
        "hatch_counter": 10,
        "gender_rate": 4,
        **traits,
    }


def record(dex_id, en=("An English entry.",), de=("Ein deutscher Eintrag.",), **fields):
    return {
        "v": pokedex_extras.EXTRAS_VERSION, "dex_id": dex_id, "weight_kg": 6.0, "height_m": 0.4,
        "genus": {"en": "Test Pokémon"}, "flavor": {"en": list(en), "de": list(de)},
        "abilities": [], "moves": {"level": [], "all": []}, "chain_id": None, "traits": {},
        **fields,
    }


class CacheRootTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_root = pokedex_images.CACHE_ROOT
        pokedex_images.CACHE_ROOT = Path(self.temp_dir.name)
        pokedex_extras.clear_index()
        pokedex_splash.splash_throttle.reset()
        pokedex_splash.on_demand_budget.reset()
        pokedex_splash._complete.clear()
        pokedex_splash._prewarm_attempts.clear()

    def tearDown(self):
        pokedex_images.CACHE_ROOT = self.old_root
        pokedex_extras.clear_index()
        self.temp_dir.cleanup()

    def seed(self, dex_id, **kwargs):
        pokedex_extras._write_json_atomic(pokedex_extras.extras_path(dex_id), record(dex_id, **kwargs))
        pokedex_extras.clear_index()

    def write_image(self, kind, dex_id, content=b"img"):
        path = pokedex_images.cache_path(kind, dex_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def mark_missing(self, kind, dex_id):
        path = pokedex_images.missing_path(kind, dex_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()


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
        self.assertEqual(extras["v"], pokedex_extras.EXTRAS_VERSION)
        self.assertEqual(extras["weight_kg"], 6.0)  # 60 hectograms
        self.assertEqual(extras["height_m"], 0.4)  # 4 decimetres
        self.assertEqual(extras["genus"], {"en": "Test Pokémon", "de": "Test-Art"})
        self.assertEqual(extras["flavor"]["en"], [
            "It keeps its tail raised to watch for Pokémon.",
            "A second line, with a break.",
        ])
        self.assertEqual(extras["flavor"]["de"], ["Ein Test-Eintrag."])
        self.assertNotIn("fr", extras["flavor"])

    def test_keeps_what_the_facts_need(self):
        extras = pokedex_extras.parse_extras(25, pokemon_payload(), species_payload(is_baby=True))
        self.assertEqual(extras["abilities"], [
            {"name": "static", "hidden": False},
            {"name": "lightning-rod", "hidden": True},
        ])
        # Level-up moves from the newest game that lists any, strongest level first.
        self.assertEqual(extras["moves"]["level"], [["thunder", 44], ["thunder-shock", 1]])
        self.assertEqual(extras["moves"]["all"], ["thunder", "thunder-shock", "thunderbolt", "volt-tackle"])
        self.assertEqual(extras["chain_id"], 10)
        self.assertEqual(extras["traits"]["baby"], True)
        self.assertEqual(extras["traits"]["capture_rate"], 190)

    def test_missing_numbers_stay_empty(self):
        extras = pokedex_extras.parse_extras(25, {"weight": 0}, {})
        self.assertIsNone(extras["weight_kg"])
        self.assertIsNone(extras["height_m"])
        self.assertEqual(extras["flavor"], {})
        self.assertEqual(extras["moves"], {"level": [], "all": []})


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

    def test_an_older_record_is_fetched_again(self):
        pokedex_extras._write_json_atomic(pokedex_extras.extras_path(25), {**record(25), "v": 1})
        handler = Mock(side_effect=lambda request: httpx.Response(
            200, json=species_payload() if "species" in request.url.path else pokemon_payload()))
        with self.client_for(handler) as client:
            extras = pokedex_extras.fetch_extras(25, client=client)
        self.assertEqual(handler.call_count, 2)
        self.assertEqual(extras["chain_id"], 10)

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


class DailyTests(unittest.TestCase):
    def test_the_order_is_every_species_once_and_fixed(self):
        order = pokedex_splash.daily_order()
        self.assertEqual(sorted(order), list(range(1, 1026)))
        pokedex_splash.daily_order.cache_clear()
        self.assertEqual(pokedex_splash.daily_order(), order)

    def test_no_repeats_for_1025_days_then_the_cycle_starts_again(self):
        start = date(2027, 3, 1)
        days = [pokedex_splash.species_for_date(start + timedelta(days=offset)) for offset in range(1025)]
        self.assertEqual(len(set(days)), 1025)
        self.assertEqual(pokedex_splash.species_for_date(start + timedelta(days=1025)), days[0])
        # Dates before the epoch work too.
        self.assertIn(pokedex_splash.species_for_date(date(2020, 1, 1)), range(1, 1026))

    def test_the_same_day_is_the_same_pokemon_and_shiny_for_everyone(self):
        self.assertEqual(pokedex_splash.species_for_date(DAY), pokedex_splash.species_for_date(date(2026, 10, 21)))
        self.assertEqual(pokedex_splash.shiny_for_date(DAY), pokedex_splash.shiny_for_date(date(2026, 10, 21)))

    def test_about_one_day_in_sixty_four_is_shiny(self):
        start = date(2020, 1, 1)
        shiny = sum(pokedex_splash.shiny_for_date(start + timedelta(days=offset)) for offset in range(64_000))
        self.assertGreater(shiny, 850)
        self.assertLess(shiny, 1150)

    def test_parse_day(self):
        self.assertEqual(pokedex_splash.parse_day("2026-10-21"), DAY)
        self.assertIsInstance(pokedex_splash.parse_day(None), date)
        for bad in ("2026-13-01", "1999-12-31", "2101-01-01"):
            with self.assertRaises(ValueError):
                pokedex_splash.parse_day(bad)


class SpriteTests(CacheRootTestCase):
    def test_showdown_first_then_artwork_then_the_static_sprite(self):
        self.assertEqual(pokedex_splash.resolve_sprite(25, False), ("/api/pokedex/images/showdown/25.gif", "animated"))
        self.mark_missing("showdown", 990)
        self.assertEqual(pokedex_splash.resolve_sprite(990, False), ("/api/pokedex/images/artwork/990.png", "artwork"))
        self.mark_missing("artwork", 990)
        self.assertEqual(pokedex_splash.resolve_sprite(990, False), ("/api/pokedex/images/sprites/990.png", "pixel"))

    def test_shiny_has_its_own_chain(self):
        self.assertEqual(pokedex_splash.resolve_sprite(25, True), ("/api/pokedex/images/showdown-shiny/25.gif", "animated"))
        self.mark_missing("showdown-shiny", 25)
        self.assertEqual(pokedex_splash.resolve_sprite(25, True)[0], "/api/pokedex/images/artwork-shiny/25.png")

    def test_a_cached_file_wins_over_an_old_miss(self):
        self.mark_missing("showdown", 25)
        self.write_image("showdown", 25)
        self.assertEqual(pokedex_splash.resolve_sprite(25, False)[1], "animated")

    def test_the_gen5_option(self):
        with patch.object(pokedex_splash, "SPRITE_SET", "gen5"):
            self.assertEqual(pokedex_splash.resolve_sprite(25, False), ("/api/pokedex/images/animated/25.gif", "pixel"))
            self.assertEqual(pokedex_splash.resolve_sprite(700, False), ("/api/pokedex/images/sprites/700.png", "pixel"))

    def test_fetch_walks_the_chain_and_remembers_misses(self):
        calls = []

        def handler(request):
            calls.append(request.url.path)
            if "/showdown/" in request.url.path:
                return httpx.Response(404)
            return httpx.Response(200, content=b"png")

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            path = pokedex_splash.fetch_sprite(990, False, client=client)
            again = pokedex_splash.fetch_sprite(990, False, client=client)
        self.assertEqual(path, pokedex_images.cache_path("artwork", 990))
        self.assertEqual(again, path)
        self.assertEqual(len(calls), 2)  # the miss is remembered, the artwork is cached
        self.assertTrue(pokedex_images.is_known_missing("showdown", 990))


class SplashEntryTests(CacheRootTestCase):
    def test_the_pokemon_of_the_day(self):
        dex_id = pokedex_splash.species_for_date(DAY)
        self.seed(dex_id)
        with patch.object(pokedex_facts, "fetch_bundle", side_effect=AssertionError("no fetch")):
            entry = pokedex_splash.splash_entry(day=DAY)
        self.assertEqual(entry["dex_id"], dex_id)
        self.assertEqual(entry["date"], "2026-10-21")
        self.assertEqual(entry["shiny"], pokedex_splash.shiny_for_date(DAY))

    def test_payload_shape_language_and_facts(self):
        self.seed(25)
        entry = pokedex_splash.splash_entry(day=DAY, lang="de", requested_id=25, shiny=True)
        self.assertEqual(entry, {
            "date": "2026-10-21", "dex_id": 25, "name": "Pikachu", "lang": "de", "generation": 1,
            "region": "Kanto", "types": ["electric"], "genus": "Test Pokémon", "height_m": 0.4,
            "weight_kg": 6.0, "shiny": True,
            "facts": [{"kind": "pokedex", "text": "Ein deutscher Eintrag."}],
            "sprite_url": "/api/pokedex/images/showdown-shiny/25.gif", "sprite_style": "animated",
        })
        self.assertEqual(pokedex_splash.splash_entry(day=DAY, lang="fr-FR", requested_id=25)["lang"], "en")

    def test_fetches_the_quick_bundle_when_the_species_is_new(self):
        def fake_bundle(dex_id, **kwargs):
            pokedex_extras._write_json_atomic(pokedex_extras.extras_path(dex_id), record(dex_id))
            return record(dex_id)

        with patch.object(pokedex_facts, "fetch_bundle", side_effect=fake_bundle) as fetch:
            entry = pokedex_splash.splash_entry(day=DAY, requested_id=133)
        fetch.assert_called_once()
        self.assertEqual(fetch.call_args.kwargs["depth"], "quick")
        self.assertEqual(fetch.call_args.kwargs["timeout"], pokedex_splash.ON_DEMAND_TIMEOUT_SECONDS)
        self.assertEqual(entry["weight_kg"], 6.0)

    def test_still_answers_while_pokeapi_is_down(self):
        with patch.object(pokedex_facts, "fetch_bundle", side_effect=pokedex_extras.ExtrasUnavailable("down")):
            entry = pokedex_splash.splash_entry(day=DAY, requested_id=25)
        self.assertEqual(entry["name"], "Pikachu")
        self.assertIsNone(entry["weight_kg"])
        self.assertEqual(entry["facts"], [])

    def test_the_on_demand_budget_limits_pokeapi_calls(self):
        with patch.object(pokedex_facts, "fetch_bundle", return_value=None) as fetch:
            for dex_id in range(1, pokedex_splash.ON_DEMAND_FETCHES_PER_MINUTE + 6):
                pokedex_splash.splash_entry(day=DAY, requested_id=dex_id)
        self.assertEqual(fetch.call_count, pokedex_splash.ON_DEMAND_FETCHES_PER_MINUTE)


class PrewarmTests(CacheRootTestCase):
    def test_makes_today_and_the_next_two_days_complete_at_a_polite_rate(self):
        days = [DAY + timedelta(days=offset) for offset in range(3)]
        species = [pokedex_splash.species_for_date(day) for day in days]
        pauses = []
        with patch.object(pokedex_facts, "fetch_bundle", return_value=None) as bundle, \
             patch.object(pokedex_splash, "fetch_sprite", return_value=None) as sprite:
            pokedex_splash.prewarm(DAY, sleep=pauses.append)
        self.assertEqual([call.args[0] for call in bundle.call_args_list], species)
        self.assertTrue(all(call.kwargs["depth"] == "full" for call in bundle.call_args_list))
        self.assertEqual([call.args[0] for call in sprite.call_args_list], species)
        bundle.call_args_list[0].kwargs["pause"]()
        self.assertEqual(pauses, [1 / pokedex_splash.WARM_REQUESTS_PER_SECOND])

    def test_skips_days_that_are_already_complete(self):
        dex_id = pokedex_splash.species_for_date(DAY)
        self.seed(dex_id)
        self.write_image("showdown", dex_id)
        self.write_image("showdown-shiny", dex_id)
        with patch.object(pokedex_facts, "fetch_bundle", return_value=None) as bundle, \
             patch.object(pokedex_splash, "fetch_sprite", return_value=None):
            pokedex_splash.prewarm(DAY, sleep=lambda seconds: None)
        self.assertNotIn(dex_id, [call.args[0] for call in bundle.call_args_list])

    def test_scheduled_at_most_once_in_a_while(self):
        with patch.object(pokedex_splash.threading, "Thread") as thread:
            self.assertTrue(pokedex_splash.schedule_prewarm(DAY))
            self.assertFalse(pokedex_splash.schedule_prewarm(DAY))
            self.assertTrue(pokedex_splash.schedule_prewarm(DAY + timedelta(days=1)))
        self.assertEqual(thread.call_count, 2)
        self.assertTrue(thread.call_args.kwargs["daemon"])


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
        self.prewarm = patch("api.pokedex.schedule_prewarm").start()
        self.addCleanup(patch.stopall)

    def test_public_small_never_cached_and_warms_the_next_days(self):
        dex_id = pokedex_splash.species_for_date(DAY)
        self.seed(dex_id)
        with patch.object(pokedex_facts, "fetch_bundle", side_effect=AssertionError("no fetch")):
            response = self.client.get("/api/pokedex/splash", params={"date": "2026-10-21", "lang": "en"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.json()["dex_id"], dex_id)
        self.assertLess(len(response.content), 1536)
        self.prewarm.assert_called_once_with(DAY)

    def test_the_preview_can_ask_for_a_species(self):
        self.seed(25)
        response = self.client.get("/api/pokedex/splash", params={"id": 25, "shiny": "true"})
        self.assertEqual(response.json()["dex_id"], 25)
        self.assertTrue(response.json()["shiny"])
        self.prewarm.assert_not_called()

    def test_throttled_per_client(self):
        self.seed(25)
        for _ in range(pokedex_splash.SPLASH_REQUESTS_PER_WINDOW):
            self.assertEqual(self.client.get("/api/pokedex/splash", params={"id": 25}).status_code, 200)
        response = self.client.get("/api/pokedex/splash", params={"id": 25})
        self.assertEqual(response.status_code, 429)
        self.assertGreaterEqual(int(response.headers["retry-after"]), 1)

    def test_rejects_bad_parameters(self):
        for params in ({"id": 0}, {"date": "21.10.2026"}, {"date": "2026-02-30"}, {"date": "1999-01-01"}):
            self.assertEqual(self.client.get("/api/pokedex/splash", params=params).status_code, 422, params)

    def test_route_is_not_swallowed_by_the_species_route(self):
        self.seed(25)
        self.assertEqual(self.client.get("/api/pokedex/splash", params={"id": 25}).status_code, 200)

    def test_animated_sprite_falls_back_to_the_artwork(self):
        self.write_image("showdown", 25, b"GIF89a")
        response = self.client.get("/api/pokedex/images/showdown/25.gif")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/gif")

        self.mark_missing("showdown", 990)
        self.write_image("artwork", 990, b"\x89PNG")
        with patch("api.pokedex.fetch_image", side_effect=AssertionError("no fetch")):
            response = self.client.get("/api/pokedex/images/showdown/990.gif")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertEqual(response.content, b"\x89PNG")

        self.assertEqual(self.client.get("/api/pokedex/images/secret/25.gif").status_code, 404)
        self.assertEqual(self.client.get("/api/pokedex/images/showdown/2000.gif").status_code, 404)

    def test_shiny_artwork_falls_back_to_the_shiny_sprite(self):
        self.mark_missing("artwork-shiny", 25)
        self.write_image("sprites-shiny", 25, b"\x89PNG-shiny")
        response = self.client.get("/api/pokedex/images/artwork-shiny/25.png")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"\x89PNG-shiny")

    def test_warm_up_is_admin_only(self):
        with patch.object(pokedex_splash.splash_cache_warmer, "start", return_value={"running": True}) as start:
            self.assertEqual(self.client.post("/api/pokedex/splash/cache").json(), {"running": True})
            start.assert_called_once()
            self.user = Mock(role="user")
            self.assertEqual(self.client.post("/api/pokedex/splash/cache").status_code, 403)
            self.assertEqual(self.client.get("/api/pokedex/splash/cache").status_code, 403)
            start.assert_called_once()


class WarmUpTests(CacheRootTestCase):
    def test_moves_first_then_every_species_at_a_polite_rate(self):
        self.seed(1)
        self.write_image("showdown", 1)
        pauses = []
        warmer = pokedex_splash.SplashCacheWarmer(sleep=pauses.append)
        listing = {"results": [{"name": "pound"}, {"name": "volt-tackle"}]}

        def fake_bundle(dex_id, **kwargs):
            if dex_id == 3:
                raise pokedex_extras.ExtrasUnavailable("down")
            pokedex_extras._write_json_atomic(pokedex_extras.extras_path(dex_id), record(dex_id))
            return record(dex_id)

        with patch.object(pokedex_splash, "MAX_DEX_ID", 4), \
             patch.object(pokedex_extras, "_get_json", return_value=listing), \
             patch.object(pokedex_facts, "fetch_resource", return_value={}) as fetch_move, \
             patch.object(pokedex_facts, "fetch_bundle", side_effect=fake_bundle) as bundle, \
             patch.object(pokedex_images, "fetch_image", return_value=None):
            warmer.run()

        self.assertEqual([call.args[1] for call in fetch_move.call_args_list], ["pound", "volt-tackle"])
        self.assertEqual([call.args[0] for call in bundle.call_args_list], [1, 2, 3, 4])
        self.assertTrue(all(call.kwargs["depth"] == "full" for call in bundle.call_args_list))
        state = warmer.status()
        self.assertEqual((state["done"], state["total"], state["failed"]), (4, 4, 1))
        self.assertFalse(state["running"])
        self.assertTrue(pauses)
        self.assertTrue(all(pause == 1 / pokedex_splash.WARM_REQUESTS_PER_SECOND for pause in pauses))


class CountsTests(unittest.TestCase):
    def test_every_type_maps_to_a_ground_on_the_client(self):
        # The catalogue's types are the 18 game types the client's ground and light colours cover.
        from services.pokedex import load_pokedex

        types = Counter(t for entry in load_pokedex() for t in entry.get("types") or [])
        self.assertEqual(len(types), 18)


if __name__ == "__main__":
    unittest.main()
