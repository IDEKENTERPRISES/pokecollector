"""Matcher recall work: name OCR parsing, text + picture candidate merging, the misses view's tagging,
the option sets and their comparison, and the stable result shape that the scan queue depends on."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    import numpy as np
    from fastapi.testclient import TestClient

    import main
    from api.auth import get_current_user
    from database import get_db
    from models import User
    from services.card_match import benchmark, detect, embed, images, index, misses, names, ocr, pipeline, synthetic, variants

    from tests.test_card_match import IndexAndPipelineTests, card_picture

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class NameParsingTests(unittest.TestCase):
    def test_the_stage_label_and_hp_are_not_part_of_the_name(self):
        self.assertEqual(names.clean_name_line("BASIC Pikachu HP 70"), "Pikachu")
        self.assertEqual(names.clean_name_line("Stage 1 Charizard ex"), "Charizard ex")
        self.assertEqual(names.clean_name_line("Evolves from Charmander"), "")
        self.assertEqual(names.clean_name_line("Pikachu 0"), "Pikachu")

    def test_card_type_suffixes_and_punctuation_stay(self):
        self.assertEqual(names.clean_name_line("Pikachu V"), "Pikachu V")
        self.assertEqual(names.clean_name_line("Boss's Orders"), "Boss's Orders")
        self.assertEqual(names.clean_name_line("Mr. Mime"), "Mr. Mime")
        self.assertEqual(names.clean_name_line("Nidoran♀"), "Nidoran♀")

    def test_a_label_on_its_own_line_is_not_a_name_but_a_card_that_starts_with_the_word_is(self):
        for label in ("SUPPORTER", "Item", "Pokémon Tool", "BASIC"):
            self.assertEqual(names.clean_name_line(label), "", label)
        self.assertEqual(names.clean_name_line("Energy Retrieval"), "Energy Retrieval")
        self.assertEqual(names.clean_name_line("Trainer's Mail"), "Trainer's Mail")

    def test_the_biggest_type_in_the_strip_is_the_name_and_hp_is_read_from_the_same_lines(self):
        read = names.parse_name_lines([("BASIC", 20.0), ("Pikachu", 60.0), ("HP 70", 30.0)])
        self.assertEqual((read.name, read.hp), ("Pikachu", "70"))
        # Without heights the longest plausible line wins.
        self.assertEqual(names.parse_name_lines(["Basic", "Charizard ex", "HP 330"]).name, "Charizard ex")
        self.assertIsNone(names.parse_name_lines(["", "12"]).name)
        self.assertIsNone(names.parse_name_lines([]).name)


def _rows():
    return [
        names.NameRow("base1-58_en", "Pikachu", "58", "102"),
        names.NameRow("sv1-63_en", "Pikachu", "63", "198"),
        names.NameRow("swsh4-43_en", "Pikachu V", "43", "185"),
        names.NameRow("sv3-125_en", "Charizard ex", "125", "197"),
        names.NameRow("swsh1-1_en", "Boss's Orders (Ghetsis)", "131", "163"),
        names.NameRow("sv1-1_en", "Raichu", "9", "198"),
    ]


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class NameSearchTests(unittest.TestCase):
    def setUp(self):
        self.names = names.NameIndex(_rows())

    def test_a_damaged_name_still_finds_the_card(self):
        found = [hit.card_id for hit in self.names.search("Charizrd ex")]
        self.assertEqual(found[0], "sv3-125_en")

    def test_the_catalogues_qualifier_and_separators_do_not_matter(self):
        self.assertEqual(self.names.search("Boss’s Orders")[0].card_id, "swsh1-1_en")
        self.assertEqual(self.names.search("boss's  orders")[0].name_score, 1.0)

    def test_a_read_number_brings_the_printings_that_carry_it_first(self):
        hits = self.names.search("Pikachu", number="63", total="198")
        self.assertEqual(hits[0].card_id, "sv1-63_en")
        self.assertTrue(hits[0].number_ok and hits[0].total_ok)
        self.assertEqual({hit.card_id for hit in hits}, {"base1-58_en", "sv1-63_en", "swsh4-43_en"} & {hit.card_id for hit in hits})
        self.assertFalse(next(hit for hit in hits if hit.card_id == "base1-58_en").number_ok)

    def test_a_different_pokemon_is_not_brought_in(self):
        self.assertNotIn("sv1-1_en", [hit.card_id for hit in self.names.search("Pikachu")])
        self.assertEqual(self.names.search("Qzxwv"), [])
        self.assertEqual(self.names.search(None), [])

    def test_name_score_of_one_card(self):
        self.assertEqual(self.names.name_score_of("sv1-63_en", "Pikachu"), 1.0)
        self.assertEqual(self.names.name_score_of("sv3-125_en", "Pikachu"), 0.0)
        self.assertEqual(self.names.name_score_of("sv3-125_en", None), 0.0)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class MergeCandidatesTests(unittest.TestCase):
    def setUp(self):
        rows = [names.NameRow(f"o{i}_en", f"Other {i}", str(i), "100") for i in range(1, 8)]
        rows += [names.NameRow("pika-58_en", "Pikachu", "58", "102"), names.NameRow("pika-63_en", "Pikachu", "63", "198")]
        self.names = names.NameIndex(rows)
        self.ids = [row.card_id for row in rows]
        self.row_of = {card_id: row for row, card_id in enumerate(self.ids)}
        scores = np.full(len(self.ids), 0.2, dtype=np.float32)
        for position in range(7):
            scores[position] = 0.9 - 0.05 * position  # the picture's top 7 are the "Other" cards
        scores[self.row_of["pika-58_en"]] = 0.45
        scores[self.row_of["pika-63_en"]] = 0.44
        self.scores = scores
        self.hits = [(self.ids[i], float(scores[i])) for i in range(7)]

    def test_text_candidates_join_and_rise_with_the_name_and_number(self):
        merged, added = pipeline.merge_candidates(self.hits, self.scores, self.row_of, self.names, "Pikachu", "58", "102", top_k=8)
        ids = [card_id for card_id, _score in merged]
        self.assertEqual(added, 2)
        self.assertIn("pika-58_en", ids)
        self.assertEqual(ids[0], "o1_en")  # the best picture still leads a lukewarm picture match
        self.assertLess(ids.index("pika-58_en"), ids.index("pika-63_en"))
        self.assertLess(ids.index("pika-58_en"), ids.index("o4_en"))

    def test_the_closest_pictures_always_stay(self):
        merged, _added = pipeline.merge_candidates(self.hits, self.scores, self.row_of, self.names, "Pikachu", "58", "102", top_k=6)
        ids = {card_id for card_id, _score in merged}
        self.assertTrue({f"o{i}_en" for i in range(1, 6)} <= ids)
        self.assertEqual(len(merged), 6)

    def test_nothing_changes_when_no_name_was_read(self):
        self.assertEqual(pipeline.merge_candidates(self.hits, self.scores, self.row_of, self.names, None, "58", "102"), (self.hits, 0))
        self.assertEqual(pipeline.merge_candidates(self.hits, self.scores, self.row_of, None, "Pikachu", None, None), (self.hits, 0))

    def test_a_name_that_is_not_in_the_catalogue_adds_nothing(self):
        merged, added = pipeline.merge_candidates(self.hits, self.scores, self.row_of, self.names, "Zzzzzz", None, None, top_k=7)
        self.assertEqual(added, 0)
        self.assertEqual({card_id for card_id, _ in merged}, {card_id for card_id, _ in self.hits})

    def test_a_card_whose_name_was_read_may_be_decided_by_the_picture_with_a_smaller_lead(self):
        candidates = [
            {"number": "1", "_similarity": 0.84, "_rank": 1, "_db_id": "a", "tcg_card_id": "a", "_name_score": 1.0},
            {"number": "2", "_similarity": 0.80, "_rank": 2, "_db_id": "b", "tcg_card_id": "b", "_name_score": 0.0},
        ]
        chosen, _ = pipeline.decide({}, candidates)
        self.assertEqual(chosen["mechanism"], "name_and_picture")
        candidates[0]["_name_score"] = 0.5
        self.assertEqual(pipeline.decide({}, candidates)[1], "no_number_and_picture_not_clear")

    def test_a_printing_found_by_name_may_sit_further_down_the_pictures_when_the_rules_choose_it(self):
        candidates = [
            {"tcg_card_id": "a-1", "number": "1", "printed_total": 10, "_similarity": 0.9, "_rank": 1, "_db_id": "a-1_en"},
            {"tcg_card_id": "b-5", "number": "5", "printed_total": 10, "_similarity": 0.7, "_rank": 25, "_db_id": "b-5_en", "_name_score": 1.0},
        ]
        info = {"number_local": "5", "number_total": "10"}
        self.assertEqual(pipeline.decide(info, candidates)[0]["candidate"]["tcg_card_id"], "b-5")
        candidates[1]["_name_score"] = 0.0
        self.assertEqual(pipeline.decide(info, candidates)[1], "rules_choice_not_close_in_picture")


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class MissTaggingTests(unittest.TestCase):
    def tags(self, **overrides):
        args = dict(found=True, rotated=False, truth={"card_id": "t", "name": "Pikachu", "card_type": "pokemon", "rarity": "Common"}, others=[], stats={"glare": 0.0, "mean": 120, "sharpness": 200})
        args.update(overrides)
        return misses.tag_miss(**args)

    def test_each_cause_is_tagged(self):
        self.assertEqual(self.tags(found=False, stats=None), ["not_found"])
        self.assertIn("upside_down", self.tags(rotated=True))
        self.assertIn("generic", self.tags(truth={"card_id": "t", "name": "Grass Energy", "card_type": "energy", "rarity": "Common"}))
        self.assertIn("generic", self.tags(truth={"card_id": "t", "name": "Switch", "card_type": "trainer", "rarity": "Uncommon"}))
        self.assertNotIn("generic", self.tags(truth={"card_id": "t", "name": "Boss", "card_type": "trainer", "rarity": "Rare Holo"}))
        self.assertIn("glare", self.tags(stats={"glare": 0.08, "mean": 150, "sharpness": 200}))
        self.assertIn("dark_or_blur", self.tags(stats={"glare": 0, "mean": 50, "sharpness": 200}))
        self.assertIn("dark_or_blur", self.tags(stats={"glare": 0, "mean": 150, "sharpness": 5}))
        self.assertIn("holo", self.tags(truth={"card_id": "t", "name": "Pikachu", "card_type": "pokemon", "rarity": "Illustration Rare"}))

    def test_the_same_artwork_in_another_set_is_tagged_from_what_the_matcher_returned(self):
        others = [{"card_id": "other", "name": "pikachu"}, {"card_id": "t", "name": "Pikachu"}]
        self.assertIn("reprint_art", self.tags(others=others))
        self.assertNotIn("reprint_art", self.tags(others=[{"card_id": "t", "name": "Pikachu"}, {"card_id": "x", "name": "Raichu"}]))

    def test_a_scan_with_no_cause_is_other_and_several_causes_all_count(self):
        self.assertEqual(self.tags(), ["other"])
        items = [{"tags": ["glare", "holo"]}, {"tags": ["glare"]}, {"tags": ["other"]}]
        self.assertEqual(misses.count_tags(items), {"glare": 2, "holo": 1, "other": 1})
        self.assertEqual(misses.primary_tag(["holo", "glare"]), "glare")
        self.assertEqual(misses.primary_tag(["other"]), "other")

    def test_card_stats_see_glare_darkness_and_blur(self):
        flat = np.full((880, 630, 3), 120, dtype=np.uint8)
        flat[::6] = 90
        base = misses.card_stats(flat)
        self.assertEqual(base["glare"], 0.0)
        bright = flat.copy()
        bright[:200] = 255
        self.assertGreater(misses.card_stats(bright)["glare"], 0.2)
        self.assertLess(misses.card_stats(np.full((880, 630, 3), 30, dtype=np.uint8))["mean"], misses.DARK_MEAN)
        self.assertLess(misses.card_stats(np.full((880, 630, 3), 128, dtype=np.uint8))["sharpness"], misses.BLUR_VARIANCE)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class OptionTests(unittest.TestCase):
    def test_labels_round_trip_in_a_fixed_order(self):
        self.assertEqual(variants.parse("tta+names+art").label, "names+art+tta")
        self.assertEqual(variants.parse("").label, "baseline")
        self.assertEqual(variants.parse("baseline").label, "baseline")
        self.assertEqual(variants.parse("names,base").label, "names+base")
        for label in variants.COMPARE_LABELS:
            self.assertEqual(variants.parse(label).label, label)

    def test_extra_indexes_are_needed_only_by_the_options_that_read_them(self):
        self.assertEqual(variants.needed_indexes(variants.parse("names+tta")), [])
        self.assertEqual(variants.needed_indexes(variants.parse("names+art+base")), [variants.ART_INDEX, variants.BASE_MODEL])
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(variants.missing_indexes(variants.parse("names+art"), Path(tmp)), [variants.ART_INDEX])

    def test_the_option_set_in_use_comes_from_the_environment_then_the_chosen_file_then_the_default(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"CARD_MATCH_OPTIONS": ""}):
            data_dir = Path(tmp)
            self.assertEqual(variants.active_label(data_dir), variants.DEFAULT_LABEL)
            variants.save_chosen("names+art", "test", data_dir)
            self.assertEqual(variants.active_label(data_dir), "names+art")
            with patch.dict(os.environ, {"CARD_MATCH_OPTIONS": "baseline"}):
                self.assertEqual(variants.active_label(data_dir), "baseline")

    def row(self, label, top20, decided, wrong=0, p95=600, status="ok"):
        return {"label": label, "status": status, "top20": top20, "decided": decided, "decided_wrong": wrong, "p95_ms": p95}

    def test_the_comparison_keeps_the_plainest_set_unless_another_is_clearly_better(self):
        rows = [self.row("baseline", 72, 40), self.row("names", 97.4, 55), self.row("names+tta", 97.6, 55.2), self.row("names+art", 98.5, 57)]
        self.assertEqual(benchmark.pick_winner(rows)["label"], "names+art")
        rows[3] = self.row("names+art", 98.5, 57, wrong=1)
        self.assertEqual(benchmark.pick_winner(rows)["label"], "names")  # never trade a wrong answer for recall
        rows[3] = self.row("names+art", 98.5, 57, p95=2000)
        self.assertEqual(benchmark.pick_winner(rows)["label"], "names")  # too slow
        rows = [self.row("baseline", 72, 40), self.row("names", 97, 55, status="skipped")]
        self.assertEqual(benchmark.pick_winner(rows)["label"], "baseline")
        self.assertIsNone(benchmark.pick_winner([self.row("baseline", 0, 0, status="skipped")]))

    def test_views_for_augmentation_and_artwork_have_the_right_shapes(self):
        card = np.asarray(card_picture(7))
        art = detect.art_crop(card)
        self.assertEqual(art.shape[2], 3)
        self.assertLess(art.shape[0], card.shape[0] // 2 + 20)
        views = detect.augmented_views(card)
        self.assertEqual(len(views), 2)
        self.assertTrue(all(view.shape == card.shape for view in views))


class _Reader:
    """OCR stand-in that also reads a name."""

    def __init__(self, number_local=None, number_total=None, name=None):
        self.result = ocr.OcrResult(number_local=number_local, number_total=number_total, tokens=["TST"])
        self.name = name

    def read(self, card, read_hp=False, flipped=None):
        return self.result

    def read_name(self, card, *, flipped=False):
        return names.NameRead(name=self.name, raw=[self.name or ""], hp=None)


RESULT_KEYS = {"status", "decision", "unsure_reason", "matches", "detection", "ocr", "timings_ms"}
MATCH_KEYS = {"card_id", "tcg_card_id", "similarity", "rank", "name", "number", "set", "printed_total"}
DECISION_KEYS = {"card_id", "tcg_card_id", "mechanism", "similarity", "lead"}
DETECTION_KEYS = {"found", "confidence", "method", "corners"}
OCR_KEYS = {"number_local", "number_total", "hp", "tokens", "flipped", "lines"}


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class ResultShapeTests(unittest.TestCase):
    """The scan queue reads the matcher's result: fields may be added, never renamed or removed."""

    setUp = IndexAndPipelineTests.setUp
    _cache = IndexAndPipelineTests._cache
    build = IndexAndPipelineTests.build

    def photo(self, key="c4", seed=4):
        jpeg, _corners, _settings = synthetic.make_photo(self.pictures[key], seed)
        return images.decode_rgb(jpeg)

    def matcher(self, reader, **options):
        self.build()
        loaded = index.load_index(self.embedder.name, self.data_dir)
        if options.pop("with_names", False):
            options["names"] = names.build_name_index(self.Session, loaded.card_ids)
        return pipeline.CardMatcher(loaded, self.embedder, pipeline.db_candidate_loader(self.Session), reader, **options)

    def assert_shape(self, result):
        as_dict = result.as_dict()
        self.assertTrue(RESULT_KEYS <= set(as_dict))
        self.assertTrue(DETECTION_KEYS <= set(as_dict["detection"]))
        self.assertTrue(OCR_KEYS <= set(as_dict["ocr"]))
        for match in as_dict["matches"]:
            self.assertTrue(MATCH_KEYS <= set(match), set(match))
        if as_dict["decision"]:
            self.assertTrue(DECISION_KEYS <= set(as_dict["decision"]))
        self.assertIn("total", as_dict["timings_ms"])
        self.assertIn(as_dict["status"], {"decided", "unsure"})

    def test_the_shape_is_the_same_with_every_option_on_and_off(self):
        photo = self.photo()
        plain = self.matcher(_Reader("4", "5"))
        self.assert_shape(plain.match(photo))
        with_names = self.matcher(_Reader("4", "5", name="Mon 4"), with_names=True)
        result = with_names.match(photo)
        self.assert_shape(result)
        self.assertEqual(result.decision["card_id"], "tst-4_en")
        self.assertEqual(result.ocr["name"], "Mon 4")
        self.assertEqual(result.matches[0]["name_score"], 1.0)
        self.assertIn("name", result.timings_ms)

    def test_a_reader_that_cannot_read_names_still_works_with_the_name_search_on(self):
        class OldReader:
            def read(self, card, read_hp=False, flipped=None):
                return ocr.OcrResult(number_local="4", number_total="5", tokens=["TST"])

        result = self.matcher(OldReader(), with_names=True).match(self.photo())
        self.assert_shape(result)
        self.assertNotIn("name", result.ocr)

    def test_augmented_views_and_an_artwork_index_keep_the_shape_and_find_the_card(self):
        self.build()
        index.build_index(self.Session, self.embedder, data_dir=self.data_dir, crop="art", index_name="fake-art")
        loaded = index.load_index(self.embedder.name, self.data_dir)
        art = index.load_index("fake-art", self.data_dir)
        self.assertEqual(len(art), 5)
        matcher = pipeline.CardMatcher(
            loaded, self.embedder, pipeline.db_candidate_loader(self.Session), _Reader("4", "5"),
            extra_signals=[pipeline.Signal("art", art, self.embedder, crop="art")], tta=True,
        )
        result = matcher.match(self.photo())
        self.assert_shape(result)
        self.assertEqual(result.matches[0]["card_id"], "tst-4_en")
        self.assertEqual(result.decision["card_id"], "tst-4_en")

    def test_misses_are_collected_with_thumbnails_and_paged(self):
        matcher = self.matcher(_Reader("1", "5", name="Mon 1"), with_names=True)
        photo = self.photo("c4", 4)
        outcome = matcher.match(photo)
        collector = misses.MissCollector(matcher.candidate_loader, self.data_dir)
        collector.add(trace="trace-1.json", photo=photo, outcome=outcome, truth_id="tst-2_en")  # not the first pick
        collector.add(trace="trace-2.json", photo=photo, outcome=outcome, truth_id=outcome.matches[0]["card_id"])  # a hit: skipped
        report = collector.finish("names")
        self.assertEqual((report["scans"], report["misses"]), (2, 1))
        item = report["items"][0]
        self.assertEqual(item["truth"]["name"], "Mon 2")
        self.assertLessEqual(len(item["top3"]), 3)
        self.assertEqual(item["ocr"]["name"], "Mon 1")
        self.assertTrue(set(item["tags"]) <= set(misses.TAGS))
        page = misses.page(None, 0, 10, self.data_dir)
        self.assertTrue(page["items"][0]["photo"].startswith("data:image/jpeg;base64,"))
        self.assertTrue(page["items"][0]["card"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(misses.page(item["primary"], 0, 10, self.data_dir)["total"], 1)
        self.assertEqual(misses.page("holo", 0, 10, self.data_dir)["total"] if "holo" not in item["tags"] else 0, 0)
        # A second run replaces the first run's pictures.
        again = misses.MissCollector(matcher.candidate_loader, self.data_dir)
        again.add(trace="trace-1.json", photo=photo, outcome=outcome, truth_id="tst-3_en")
        again.finish("names")
        self.assertEqual(len(list((self.data_dir / "misses").glob("run-*"))), 1)

    def test_the_misses_endpoint_is_admin_only_and_empty_before_a_run(self):
        engine_user = {"admin": User(username="oak", hashed_password="x", role="admin", is_active=True), "trainer": User(username="ash", hashed_password="x", role="trainer", is_active=True)}
        current = {"user": engine_user["trainer"]}
        main.app.dependency_overrides[get_current_user] = lambda: current["user"]
        main.app.dependency_overrides[get_db] = lambda: iter([None])
        self.addCleanup(main.app.dependency_overrides.clear)
        with patch.dict(os.environ, {"CARD_MATCH_DIR": str(self.data_dir)}):
            client = TestClient(main.app)
            self.assertEqual(client.get("/api/card-match/misses").status_code, 403)
            current["user"] = engine_user["admin"]
            self.assertEqual(client.get("/api/card-match/misses").json(), {"available": False})
            self.assertEqual(client.get("/api/card-match/misses", params={"tag": "nonsense"}).status_code, 422)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class AutorunTests(unittest.TestCase):
    def test_the_autorun_adds_the_real_photo_benchmark_only_with_enough_confirmed_scans(self):
        from services.card_match import jobs

        for traces, expected in ((99, ["index"] * 4 + ["phone-bundle", "benchmark-synthetic", "benchmark-compare-synthetic"]),  # version 11: two more (int8) indexes and the bundle
                                 (100, ["index"] * 4 + ["benchmark-ocr-check", "benchmark-labelled", "benchmark-compare-labelled", "phone-bundle", "benchmark-synthetic", "benchmark-compare-synthetic"])):
            started = []

            def fake_start(kind, work):
                started.append(kind)
                return True, {}

            with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"SCAN_MATCHER_AUTORUN": "1", "CARD_MATCH_DIR": tmp}), \
                    patch.object(jobs.jobs, "start", side_effect=fake_start), patch.object(jobs.jobs, "wait"), \
                    patch.object(jobs.jobs, "status", return_value={"error": None}), \
                    patch.object(benchmark, "count_labelled_traces", return_value=traces):
                self.assertTrue(jobs.autorun_once(None, delay_seconds=0))
                for thread in __import__("threading").enumerate():
                    if thread.name == "card-match-autorun":
                        thread.join(10)
            self.assertEqual(started, expected)

    def test_the_matcher_version_was_bumped_so_the_autorun_runs_again_after_this_deploy(self):
        from services.card_match import MATCHER_VERSION

        self.assertGreaterEqual(int(MATCHER_VERSION), 3)


if __name__ == "__main__":
    unittest.main()
