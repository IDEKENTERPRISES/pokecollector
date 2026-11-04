"""Number / set-code lookup, card-text lookup and the reprint tie-break (``card_match/lookup.py``, ``pipeline.decide``)."""
import unittest

try:
    import numpy as np

    from services.card_match import lookup, pipeline, variants

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

MISTY = "You may play only 1 Supporter card during your turn. Choose up to 2 of your Benched Pokémon and heal 60 damage from each of them."


def _rows():
    return [
        lookup.LookupRow("pal-17_en", "Lapras", "017", "128", set_id="xx1"),
        lookup.LookupRow("zzz-17_en", "Lapras", "017", "198", set_id="xx2"),
        lookup.LookupRow("yyy-17_en", "Lapras", "017", "128", set_id="xx3"),  # same number and total in another set
        lookup.LookupRow("pal-18_en", "Dragonair", "018", "128", set_id="xx1"),
        lookup.LookupRow("tg-6_en", "Charizard", "TG06", "30", set_id="xx4"),
        lookup.LookupRow("swsh-20_en", "Pikachu", "SWSH020", None, set_id="swshp"),
        lookup.LookupRow("misty_en", "Misty's Vitality", "170", "191", set_id="xx5",
                         texts=lookup.card_texts(MISTY, None, None)),
        lookup.LookupRow("erika_en", "Erika's Invitation", "171", "191", set_id="xx5",
                         texts=lookup.card_texts("Switch 1 of your opponent's Benched Pokémon with their Active Pokémon.", None, None)),
        lookup.LookupRow("mew_en", "Mew ex", "053", "091", set_id="xx6", suffix="ex",
                         texts=lookup.card_texts(None, [{"name": "Genome Hacking", "effect": "Choose 1 of your opponent's Active Pokémon's attacks and use it as this attack."}], None)),
        lookup.LookupRow("mewtwo_en", "Mewtwo", "054", "091", set_id="xx6"),
    ] + [
        lookup.LookupRow(f"sup{i}_en", f"Supporter {i}", str(100 + i), "191", set_id="xx5",
                         texts=lookup.card_texts("You may play only 1 Supporter card during your turn. Draw a card.", None, None))
        for i in range(40)
    ]


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class NumberLaneTests(unittest.TestCase):
    def setUp(self):
        self.index = lookup.LookupIndex(_rows(), {"PAL": ["xx1"], "TWM": ["xx2"]})

    def test_the_pair_is_found_even_when_ocr_parsed_the_wrong_numbers(self):
        pairs = lookup.number_pairs(["30C | 017/128", "Illus. Someone"], "30C", "017")
        self.assertIn(("17", "128"), pairs)

    def test_number_and_total_find_every_printing_with_both(self):
        hits, _codes = self.index.find_numbers([("17", "128")])
        self.assertEqual({c for c, h in hits.items() if h.level == "number_total"}, {"pal-17_en", "yyy-17_en"})
        self.assertEqual(hits["zzz-17_en"].level, "number")  # the total contradicts: a boost at most

    def test_a_set_code_narrows_to_one_printing(self):
        hits, used = self.index.find_numbers([("17", "128")], ["PAL"])
        self.assertEqual(used, ["PAL"])
        self.assertEqual(hits["pal-17_en"].level, "number_total_set")
        self.assertEqual(hits["yyy-17_en"].level, "number_total")

    def test_a_word_that_is_not_a_set_code_is_ignored(self):
        _hits, used = self.index.find_numbers([("17", "128")], ["30C", "LAPRAS"])
        self.assertEqual(used, [])

    def test_promo_codes_and_numbers_without_a_total(self):
        self.assertEqual(self.index.sets_for_codes(["SWSH"])[0], {"swshp"})
        hits, _ = self.index.find_numbers(lookup.number_pairs(["SWSH020"], "SWSH020", None))
        self.assertEqual(hits["swsh-20_en"].level, "number")  # no total printed: only a boost, never added
        self.assertNotIn("swsh-20_en", lookup.LookupEvidence(numbers=hits).add_ids())

    def test_only_strong_levels_bring_cards_in(self):
        evidence = self.index.search(["30C | 017/128"], None, None, ["PAL"], text=False)
        self.assertEqual(set(evidence.add_ids()), {"pal-17_en", "yyy-17_en"})
        self.assertGreater(evidence.bonus("pal-17_en"), evidence.bonus("yyy-17_en"))
        self.assertEqual(evidence.bonus("zzz-17_en"), 0.0)

    def test_nothing_read_finds_nothing(self):
        self.assertTrue(self.index.search(["Illus. Someone"], None, None, [], ).empty())


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class TextLaneTests(unittest.TestCase):
    def setUp(self):
        self.index = lookup.LookupIndex(_rows())

    def test_body_text_finds_the_card_that_prints_it(self):
        hits, _ = self.index.find_text(["Switch 1 of your opponents Benched Pokemon with their Active Pokemon"])
        self.assertEqual(list(hits), ["erika_en"])

    def test_an_attack_name_finds_its_card(self):
        hits, _ = self.index.find_text(["Genome Hacking 0"])
        self.assertIn("mew_en", hits)

    def test_a_sentence_every_supporter_prints_adds_nobody(self):
        evidence = self.index.search(["You may play only 1 Supporter card during your turn"], None, None, [], number=False)
        self.assertEqual(evidence.add_ids(), [])
        self.assertTrue(all(hit.cards > lookup.TEXT_ADD_MAX_CARDS for hit in evidence.text.values()))

    def test_the_rest_of_the_misty_sentence_is_what_finds_her(self):
        evidence = self.index.search(["Choose up to 2 of your Benched Pokemon and heal 60 damage from each"], None, None, [], number=False)
        self.assertEqual(evidence.add_ids(), ["misty_en"])

    def test_the_ex_rule_only_boosts_ex_cards(self):
        evidence = self.index.search(["Pokémon ex rule: when your Pokémon ex is Knocked Out, your opponent takes 2 Prize cards"], None, None, [], number=False)
        self.assertEqual(evidence.rule_kinds, {"ex"})
        self.assertEqual(evidence.add_ids(), [])
        self.assertGreater(evidence.bonus("mew_en"), 0.0)
        self.assertEqual(evidence.bonus("mewtwo_en"), 0.0)

    def test_noise_matches_nothing(self):
        hits, rules = self.index.find_text(["Illus. 5ban Graphics", "©2023 Pokémon / Nintendo / Creatures / GAME FREAK"])
        self.assertEqual((hits, rules), ({}, set()))


def _candidate(card_id, name, number, total, similarity, rank, **extra):
    return {"tcg_card_id": card_id, "_db_id": card_id, "name": name, "number": number, "printed_total": total,
            "_similarity": similarity, "_rank": rank, **extra}


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class MergeAndDecideTests(unittest.TestCase):
    def test_lookup_cards_join_the_list_and_rise(self):
        index = lookup.LookupIndex(_rows(), {"PAL": ["xx1"]})
        ids = [row.card_id for row in _rows()]
        row_of = {card_id: i for i, card_id in enumerate(ids)}
        scores = np.full(len(ids), 0.3, dtype=np.float32)
        hits = [(ids[5 + i], 0.9 - 0.01 * i) for i in range(6)]
        for card_id, score in hits:
            scores[row_of[card_id]] = score
        scores[row_of["pal-17_en"]] = 0.62
        evidence = index.search(["017/128"], "017", "128", ["PAL"], text=False)
        merged, added = pipeline.merge_candidates(hits, scores, row_of, None, None, "017", "128", top_k=8, evidence=evidence)
        self.assertEqual(added, 2)
        ids_out = [card_id for card_id, _score in merged]
        self.assertLess(ids_out.index("pal-17_en"), ids_out.index("yyy-17_en"))  # the set code puts it first of the two

    def test_nothing_changes_without_evidence(self):
        self.assertEqual(pipeline.merge_candidates([("a", 0.5)], np.zeros(1, dtype=np.float32), {"a": 0}, None, None, None, None), ([("a", 0.5)], 0))

    def test_a_unique_number_total_set_match_decides_far_down_the_pictures(self):
        candidates = [
            _candidate("a", "Dragonite", "9", 100, 0.90, 1),
            _candidate("pal-17_en", "Lapras", "017", 128, 0.66, 11, _lookup="number_total_set", _lookup_unique=True),
        ]
        chosen, _ = pipeline.decide({"number_local": "017", "number_total": "128"}, candidates)
        self.assertEqual(chosen["candidate"]["_db_id"], "pal-17_en")

    def test_without_the_lookup_the_same_printing_stays_unsure(self):
        candidates = [
            _candidate("a", "Dragonite", "9", 100, 0.90, 1),
            _candidate("pal-17_en", "Lapras", "017", 128, 0.66, 11),
        ]
        self.assertEqual(pipeline.decide({"number_local": "017", "number_total": "128"}, candidates)[1], "rules_choice_not_close_in_picture")

    def test_a_picture_that_disagrees_keeps_it_unsure(self):
        candidates = [
            _candidate("a", "Dragonite", "9", 100, 0.90, 1),
            _candidate("pal-17_en", "Lapras", "017", 128, 0.40, 11, _lookup="number_total_set", _lookup_unique=True),
        ]
        self.assertIsNone(pipeline.decide({"number_local": "017", "number_total": "128"}, candidates)[0])

    def test_several_cards_with_the_same_number_and_total_are_not_unique(self):
        candidates = [
            _candidate("a", "Dragonite", "9", 100, 0.90, 1),
            _candidate("pal-17_en", "Lapras", "017", 128, 0.66, 11, _lookup="number_total", _lookup_unique=False),
        ]
        self.assertIsNone(pipeline.decide({"number_local": "017", "number_total": "128"}, candidates)[0])

    def test_a_name_that_contradicts_the_number_keeps_it_unsure(self):
        candidates = [
            _candidate("a", "Dragonite", "9", 100, 0.90, 1, _name_score=1.0, _name_known=True),
            _candidate("pal-17_en", "Lapras", "017", 128, 0.70, 3, _lookup="number_total_set", _lookup_unique=True, _name_score=0.0, _name_known=True),
        ]
        chosen, reason = pipeline.decide({"number_local": "017", "number_total": "128"}, candidates)
        self.assertIsNone(chosen)
        self.assertEqual(reason, "number_lookup_conflicts_with_name")

    def test_the_number_of_the_looked_up_printing_replaces_a_misparsed_one(self):
        info = {"number_local": "30C", "number_total": "017"}
        candidates = [
            _candidate("a", "Dragonite", "9", 100, 0.90, 1),
            _candidate("pal-17_en", "Lapras", "017", 128, 0.66, 11, _lookup="number_total_set", _lookup_unique=True),
        ]
        changed = pipeline.number_from_lookup(info, candidates)
        self.assertEqual((info["number_local"], info["number_total"]), ("017", "128"))
        self.assertEqual(changed["level"], "number_total_set")
        self.assertIsNone(pipeline.number_from_lookup(info, candidates))  # now it matches: nothing more to change

    def test_text_alone_decides_only_when_few_cards_print_it_and_the_picture_is_close(self):
        top = _candidate("m", "Misty's Vitality", "170", 191, 0.84, 1, _text_score=0.95, _text_cards=1)
        rival = _candidate("e", "Erika's Invitation", "171", 191, 0.78, 2)
        self.assertEqual(pipeline.decide({}, [top, rival])[0]["mechanism"], "text_and_picture")
        self.assertIsNone(pipeline.decide({}, [{**top, "_text_cards": 9}, rival])[0])
        self.assertIsNone(pipeline.decide({}, [{**top, "_similarity": 0.70}, {**rival, "_similarity": 0.60}])[0])
        self.assertIsNone(pipeline.decide({}, [{**top, "_name_score": 0.0, "_name_known": True}, rival])[0])


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class ReprintTests(unittest.TestCase):
    def group(self, art_a, art_b, sim_a=0.90, sim_b=0.89, other=0.70):
        return [
            _candidate("t-68", "Toucannon", "068", 198, sim_a, 1, _art_similarity=art_a),
            _candidate("t-108", "Toucannon", "108", 198, sim_b, 2, _art_similarity=art_b),
            _candidate("x", "Trumbeak", "067", 198, other, 3, _art_similarity=0.5),
        ]

    def test_a_clear_artwork_lead_chooses_the_printing(self):
        chosen, _ = pipeline.decide({}, self.group(0.80, 0.86), reprint=True)
        self.assertEqual(chosen["candidate"]["_db_id"], "t-108")
        self.assertEqual(chosen["mechanism"], "reprint_art_lead")

    def test_without_the_option_or_with_a_small_lead_it_stays_unsure(self):
        self.assertIsNone(pipeline.decide({}, self.group(0.80, 0.86))[0])
        self.assertIsNone(pipeline.decide({}, self.group(0.83, 0.85), reprint=True)[0])

    def test_no_artwork_scores_means_no_choice(self):
        candidates = [{k: v for k, v in c.items() if k != "_art_similarity"} for c in self.group(0.80, 0.86)]
        self.assertIsNone(pipeline.decide({}, candidates, reprint=True)[0])

    def test_a_group_that_does_not_clearly_lead_other_cards_stays_unsure(self):
        self.assertIsNone(pipeline.decide({}, self.group(0.80, 0.86, other=0.88), reprint=True)[0])


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class OptionTests(unittest.TestCase):
    def test_each_lane_is_its_own_comparison_row(self):
        labels = variants.COMPARE_LABELS
        self.assertIn("names+number", labels)
        self.assertIn("names+number+text", labels)
        for label in labels:
            self.assertEqual(variants.parse(label).label, label)

    def test_reprint_turns_on_the_artwork_index(self):
        options = variants.parse("names+reprint")
        self.assertTrue(options.art and options.reprint)
        self.assertEqual(options.label, "names+art+reprint")

    def test_the_matcher_version_was_bumped(self):
        from services.card_match import MATCHER_VERSION
        self.assertGreaterEqual(int(MATCHER_VERSION), 5)
