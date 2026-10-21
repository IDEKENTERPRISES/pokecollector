"""Fun facts for the Pokémon of the day (services/pokedex_facts.py). Synthetic PokéAPI payloads."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from services import pokedex_extras, pokedex_facts, pokedex_images

API = "https://pokeapi.co/api/v2"


def names(en, de):
    return [{"name": en, "language": {"name": "en"}}, {"name": de, "language": {"name": "de"}},
            {"name": "x", "language": {"name": "fr"}}]


def flavor(*entries):
    return [{"flavor_text": text, "language": {"name": lang}} for lang, text in entries]


def move_payload(en, de, learners, power=None, texts=None):
    return {
        "names": names(en, de),
        "type": {"name": "electric"},
        "power": power,
        "flavor_text_entries": flavor(*(texts or [("en", f"Old {en}."), ("de", f"Alt {de}."),
                                                   ("en", f"{en} text."), ("de", f"{de} Text.")])),
        "learned_by_pokemon": [{"name": "p", "url": f"{API}/pokemon/{dex_id}/"} for dex_id in learners],
    }


def species_node(dex_id, details=None, children=()):
    return {
        "species": {"name": str(dex_id), "url": f"{API}/pokemon-species/{dex_id}/"},
        "evolution_details": details or [],
        "evolves_to": list(children),
    }


PICHU_LINE = {"chain": species_node(172, children=[
    species_node(25, [{"trigger": {"name": "level-up"}, "min_happiness": 220}], children=[
        species_node(26, [{"trigger": {"name": "use-item"}, "item": {"name": "thunder-stone"}}]),
    ]),
])}


class ReducerTests(unittest.TestCase):
    def test_move(self):
        move = pokedex_facts.reduce_move(move_payload("Volt Tackle", "Volttackle", [25, 26, 172, 10080], power=120))
        self.assertEqual(move, {
            "names": {"en": "Volt Tackle", "de": "Volttackle"},
            "type": "electric",
            "power": 120,
            "flavor": {"en": "Volt Tackle text.", "de": "Volttackle Text."},  # the newest game's text
            "learners": [25, 26, 172],  # alternate forms (10080) are left out
        })

    def test_ability_and_item(self):
        ability = pokedex_facts.reduce_ability({"names": names("Static", "Statik"),
                                                "flavor_text_entries": flavor(("en", "May\nparalyze."))})
        self.assertEqual(ability, {"names": {"en": "Static", "de": "Statik"}, "flavor": {"en": "May paralyze."}})
        self.assertEqual(pokedex_facts.reduce_item({"names": names("Thunder Stone", "Donnerstein")}),
                         {"names": {"en": "Thunder Stone", "de": "Donnerstein"}})

    def test_chain(self):
        chain = pokedex_facts.reduce_chain(PICHU_LINE)
        self.assertEqual(chain["species"], [172, 25, 26])
        self.assertEqual(chain["links"], [
            {"from": 172, "to": 25, "how": {"trigger": "level-up", "happiness": 220}},
            {"from": 25, "to": 26, "how": {"trigger": "use-item", "item": "thunder-stone"}},
        ])

    def test_bad_keys_never_become_paths(self):
        for key in ("../x", "a/b", "", "X" * 80):
            with self.assertRaises(ValueError):
                pokedex_facts.resource_path("move", key)
        with self.assertRaises(ValueError):
            pokedex_facts.resource_path("pokemon", "pikachu")


class FactsTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_root = pokedex_images.CACHE_ROOT
        pokedex_images.CACHE_ROOT = Path(self.temp_dir.name)

    def tearDown(self):
        pokedex_images.CACHE_ROOT = self.old_root
        self.temp_dir.cleanup()

    def store(self, kind, key, data):
        pokedex_extras._write_json_atomic(pokedex_facts.resource_path(kind, key), data)

    def pikachu_line(self):
        self.store("evolution-chain", "10", pokedex_facts.reduce_chain(PICHU_LINE))
        self.store("move", "volt-tackle", pokedex_facts.reduce_move(
            move_payload("Volt Tackle", "Volttackle", [172, 25, 26], power=120)))
        self.store("move", "thunder", pokedex_facts.reduce_move(
            move_payload("Thunder", "Donner", [25, 26, 135, 145], power=110)))
        self.store("move", "thunder-shock", pokedex_facts.reduce_move(
            move_payload("Thunder Shock", "Donnerschock", [25, 81, 100], power=40)))
        self.store("ability", "static", pokedex_facts.reduce_ability(
            {"names": names("Static", "Statik"), "flavor_text_entries": flavor(("en", "May paralyze."), ("de", "Kann paralysieren."))}))
        self.store("ability", "lightning-rod", pokedex_facts.reduce_ability(
            {"names": names("Lightning Rod", "Blitzfänger"),
             "flavor_text_entries": flavor(("en", "Draws in Electric moves."), ("de", "Zieht Elektro-Attacken an."))}))
        self.store("item", "thunder-stone", {"names": {"en": "Thunder Stone", "de": "Donnerstein"}})

    def extras(self, dex_id=25, **fields):
        return {
            "v": pokedex_extras.EXTRAS_VERSION, "dex_id": dex_id,
            "flavor": {"en": ["It weighs 6 kg and is 0.4 m tall.", "Whenever PIKACHU meets hard BERRIES, it zaps them.",
                              "When PIKACHU meet, they spark."],
                       "de": ["Wenn sich Pikachu treffen, knistert es."]},
            "abilities": [{"name": "static", "hidden": False}, {"name": "lightning-rod", "hidden": True}],
            "moves": {"level": [["thunder", 44], ["thunder-shock", 1]],
                      "all": ["thunder", "thunder-shock", "volt-tackle"]},
            "chain_id": 10,
            "traits": {"legendary": False, "mythical": False, "baby": False, "capture_rate": 190,
                       "hatch_counter": 10, "gender_rate": 4},
            **fields,
        }


class BuildFactsTests(FactsTestCase):
    def test_attacks_first_then_ability_evolution_and_lore(self):
        self.pikachu_line()
        self.assertEqual(pokedex_facts.build_facts(25, self.extras(), "en", seed="2026-10-21"), [
            {"kind": "signature-move", "title": "Volt Tackle", "text": "Volt Tackle text."},
            {"kind": "hidden-ability", "title": "Lightning Rod", "text": "Draws in Electric moves."},
            {"kind": "evolution", "text": "Evolves into Raichu with a Thunder Stone."},
            # Never a size or weight, never shouting capitals; the species' own name is respelled.
            {"kind": "pokedex", "text": "When Pikachu meet, they spark."},
        ])

    def test_in_german(self):
        self.pikachu_line()
        facts = pokedex_facts.build_facts(25, self.extras(), "de")
        self.assertEqual(facts[0], {"kind": "signature-move", "title": "Volttackle", "text": "Volttackle Text."})
        self.assertEqual(facts[1]["title"], "Blitzfänger")
        self.assertEqual(facts[2]["text"], "Entwickelt sich mit Donnerstein zu Raichu.")
        self.assertEqual(facts[3]["text"], "Wenn sich Pikachu treffen, knistert es.")

    def test_without_a_signature_move_the_strongest_level_move(self):
        self.pikachu_line()
        extras = self.extras(moves={"level": [["thunder", 44]], "all": ["thunder"]})
        self.assertEqual(pokedex_facts.build_facts(25, extras, "en")[0],
                         {"kind": "move", "title": "Thunder", "text": "Thunder text. Learns it at level 44."})

    def test_evolution_sentences(self):
        self.pikachu_line()
        self.assertEqual(pokedex_facts.evolution_fact(172, pokedex_facts.load_resource("evolution-chain", "10"), "en"),
                         "Evolves into Pikachu with high friendship.")
        chain = pokedex_facts.load_resource("evolution-chain", "10")
        self.assertEqual(pokedex_facts.evolution_fact(26, chain, "en"), "Evolves from Pikachu with a Thunder Stone.")
        self.assertEqual(pokedex_facts.evolution_fact(26, chain, "de"), "Entwickelt sich aus Pikachu (mit Donnerstein).")
        eevee = {"species": [133, 134, 135, 136], "links": [
            {"from": 133, "to": 134, "how": {"trigger": "use-item", "item": "water-stone"}},
            {"from": 133, "to": 135, "how": {"trigger": "use-item", "item": "thunder-stone"}},
            {"from": 133, "to": 136, "how": {"trigger": "use-item", "item": "fire-stone"}},
        ]}
        self.assertEqual(pokedex_facts.evolution_fact(133, eevee, "en"),
                         "Can evolve into 3 different Pokémon, such as Vaporeon and Jolteon.")
        trade = {"species": [64, 65], "links": [{"from": 64, "to": 65, "how": {"trigger": "trade"}}]}
        self.assertEqual(pokedex_facts.evolution_fact(64, trade, "en"), "Evolves into Alakazam when traded.")
        self.assertEqual(pokedex_facts.evolution_fact(64, trade, "de"), "Entwickelt sich durch Tausch zu Simsala.")
        level = {"species": [1, 2], "links": [{"from": 1, "to": 2, "how": {"trigger": "level-up", "level": 16}}]}
        self.assertEqual(pokedex_facts.evolution_fact(1, level, "en"), "Evolves into Ivysaur at level 16.")
        self.assertEqual(pokedex_facts.evolution_fact(1, level, "de"), "Entwickelt sich ab Level 16 zu Bisaknosp.")
        odd = {"species": [1, 2], "links": [{"from": 1, "to": 2, "how": {"trigger": "other"}}]}
        self.assertEqual(pokedex_facts.evolution_fact(1, odd, "en"), "Evolves into Ivysaur under special conditions.")
        self.assertIsNone(pokedex_facts.evolution_fact(132, {"species": [132], "links": []}, "en"))

    def test_traits(self):
        trait = pokedex_facts.trait_fact
        self.assertTrue(trait({"mythical": True}, "en").startswith("A Mythical Pokémon"))
        self.assertEqual(trait({"legendary": True}, "de"), "Ein Legendäres Pokémon.")
        self.assertEqual(trait({"baby": True}, "en"), "A Baby Pokémon that hatches from an Egg.")
        self.assertEqual(trait({"gender_rate": -1}, "en"), "It has no gender.")
        self.assertEqual(trait({"gender_rate": 8}, "en"), "Every one of them is female.")
        self.assertEqual(trait({"gender_rate": 0}, "de"), "Es gibt nur männliche Exemplare.")
        self.assertEqual(trait({"gender_rate": 4, "capture_rate": 3}, "en"),
                         "With a catch rate of 3, it is one of the hardest Pokémon to catch.")
        self.assertIn("255", trait({"gender_rate": 4, "capture_rate": 255}, "en"))
        self.assertEqual(trait({"gender_rate": 4, "capture_rate": 45, "hatch_counter": 40}, "en"),
                         "Its Egg hatches after about 10,455 steps.")
        self.assertEqual(trait({"gender_rate": 4, "capture_rate": 45, "hatch_counter": 40}, "de"),
                         "Sein Ei schlüpft nach etwa 10.455 Schritten.")
        self.assertIsNone(trait({"gender_rate": 4, "capture_rate": 45, "hatch_counter": 20}, "en"))

    def test_deterministic_for_a_day_and_empty_without_extras(self):
        self.pikachu_line()
        extras = self.extras(flavor={"en": [f"Entry number {n}." for n in range(20)]})
        first = pokedex_facts.build_facts(25, extras, "en", seed="2026-10-21")
        self.assertEqual(pokedex_facts.build_facts(25, extras, "en", seed="2026-10-21"), first)
        self.assertEqual(pokedex_facts.build_facts(25, None, "en"), [])

    def test_missing_german_text_falls_back_to_english(self):
        self.pikachu_line()
        self.store("ability", "lightning-rod", {"names": {"en": "Lightning Rod"}, "flavor": {"en": "Draws in Electric moves."}})
        facts = pokedex_facts.build_facts(25, self.extras(), "de")
        self.assertEqual(facts[1], {"kind": "hidden-ability", "title": "Lightning Rod", "text": "Draws in Electric moves."})


class BundleTests(FactsTestCase):
    def test_quick_asks_for_the_strongest_level_moves_and_full_for_every_move(self):
        extras = self.extras(moves={"level": [["a", 50], ["b", 40], ["c", 30], ["d", 20]], "all": ["a", "b", "c", "d", "e"]})
        quick = pokedex_facts.bundle_requests(extras, depth="quick")
        self.assertEqual(quick, [("evolution-chain", "10"), ("ability", "static"), ("ability", "lightning-rod"),
                                 ("move", "a"), ("move", "b"), ("move", "c")])
        full = pokedex_facts.bundle_requests(extras, depth="full")
        self.assertEqual([key for kind, key in full if kind == "move"], ["a", "b", "c", "d", "e"])

    def test_items_follow_once_the_chain_is_known_and_cached_ones_are_skipped(self):
        self.pikachu_line()
        self.assertEqual(pokedex_facts.bundle_requests(self.extras(), depth="full"), [])
        self.store("evolution-chain", "10", pokedex_facts.reduce_chain(PICHU_LINE))
        Path(pokedex_facts.resource_path("item", "thunder-stone")).unlink()
        self.assertEqual(pokedex_facts.bundle_requests(self.extras(), depth="quick"), [("item", "thunder-stone")])

    def test_fetch_bundle_against_pokeapi(self):
        def handler(request):
            path = request.url.path
            if path.endswith("/pokemon/25"):
                return httpx.Response(200, json={"weight": 60, "height": 4,
                                                 "abilities": [{"ability": {"name": "static"}, "is_hidden": False, "slot": 1}],
                                                 "moves": []})
            if path.endswith("/pokemon-species/25"):
                return httpx.Response(200, json={"evolution_chain": {"url": f"{API}/evolution-chain/10/"}})
            if path.endswith("/evolution-chain/10"):
                return httpx.Response(200, json=PICHU_LINE)
            if path.endswith("/ability/static"):
                return httpx.Response(200, json={"names": names("Static", "Statik")})
            if path.endswith("/item/thunder-stone"):
                return httpx.Response(200, json={"names": names("Thunder Stone", "Donnerstein")})
            return httpx.Response(404)

        pauses = []
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            extras = pokedex_facts.fetch_bundle(25, client=client, depth="full", pause=lambda: pauses.append(1))
        self.assertEqual(extras["chain_id"], 10)
        self.assertEqual(pokedex_facts.load_resource("item", "thunder-stone")["names"]["de"], "Donnerstein")
        self.assertEqual(len(pauses), 3)  # chain, ability, then the item the chain names

    def test_fetch_bundle_in_parallel_without_pacing(self):
        with patch.object(pokedex_extras, "fetch_extras", return_value=self.extras()), \
             patch.object(pokedex_facts, "fetch_resource", return_value={}) as fetch:
            pokedex_facts.fetch_bundle(25, client=object(), depth="quick")
        self.assertGreaterEqual(fetch.call_count, 5)


if __name__ == "__main__":
    unittest.main()
