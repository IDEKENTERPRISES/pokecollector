"""Picture matcher prototype (services/card_match): card finder, OCR parsing, index, pipeline, admin API.

Uses a tiny fake embedder and generated card pictures; the real model is exercised by one test that
skips when the model file is not present.
"""
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    import numpy as np
    from fastapi.testclient import TestClient
    from PIL import Image
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from api.auth import get_current_user
    from database import Base, get_db
    from models import Card, ImageCache, Set, Setting, User
    from services import card_picture_packs, offline_carddb
    from services.card_match import benchmark, config, detect, embed, images, index, jobs, ocr, pipeline, synthetic

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def card_picture(seed: int, size=(630, 880)) -> "Image.Image":
    """A made-up card: border, coloured art box, bars and a number strip, distinct per seed."""
    rng = np.random.default_rng(seed)
    base = np.zeros((size[1], size[0], 3), dtype=np.uint8)
    base[:] = rng.integers(60, 230, 3)
    base[40:560, 40:590] = rng.integers(0, 255, 3)
    for band in range(5):
        top = 580 + band * 40
        base[top:top + 24, 50:580] = rng.integers(0, 255, 3)
    base[::7, :, :] = base[::7, :, :] // 2  # texture
    base[0:14, :] = (240, 200, 40)  # gold border, as on a real card
    base[-14:, :] = (240, 200, 40)
    base[:, 0:14] = (240, 200, 40)
    base[:, -14:] = (240, 200, 40)
    return Image.fromarray(base, "RGB")


def png_bytes(image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class DetectTests(unittest.TestCase):
    def test_finds_and_flattens_a_card_in_a_synthetic_photo(self):
        found = 0
        for seed in range(6):
            jpeg, corners, _settings = synthetic.make_photo(card_picture(seed), seed)
            photo = images.decode_rgb(jpeg)
            detection = detect.detect_card(photo)
            width = ((corners[1][0] - corners[0][0]) ** 2 + (corners[1][1] - corners[0][1]) ** 2) ** 0.5
            if detection.found and synthetic.corner_error(detection.corners, corners, width) < 0.05:
                found += 1
            self.assertEqual(detection.card.shape, (detect.CARD_H, detect.CARD_W, 3))
        self.assertGreaterEqual(found, 5)

    def test_falls_back_to_the_guide_crop_when_there_is_no_card(self):
        flat = np.full((600, 450, 3), 120, dtype=np.uint8)
        detection = detect.detect_card(flat)
        self.assertFalse(detection.found)
        self.assertEqual(detection.method, "guide_crop")
        self.assertEqual(detection.card.shape, (detect.CARD_H, detect.CARD_W, 3))
        self.assertLess(detection.confidence, detect.MIN_CONFIDENCE)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class OcrParsingTests(unittest.TestCase):
    def test_number_and_total(self):
        result = ocr.parse_text(["Illus. Someone", "018/091", "2024 Pokemon"])
        self.assertEqual((result.number_local, result.number_total), ("018", "091"))

    def test_gallery_numbers_keep_their_prefix(self):
        result = ocr.parse_text(["TG06/TG30"])
        self.assertEqual((result.number_local, result.number_total), ("TG06", "TG30"))

    def test_a_stray_mark_after_the_total_is_ignored(self):
        result = ocr.parse_text(["049/2030"])
        self.assertEqual((result.number_local, result.number_total), ("049", "203"))

    def test_promo_number_has_no_total(self):
        result = ocr.parse_text(["SWSH 062"])
        self.assertEqual((result.number_local, result.number_total), ("SWSH062", None))

    def test_digit_lookalikes_inside_the_number(self):
        result = ocr.parse_text(["O18/O91"])
        self.assertEqual((result.number_local, result.number_total), ("018", "091"))

    def test_hp_and_set_code_tokens(self):
        result = ocr.parse_text(["SVI EN 018/091", "HP 70"])
        self.assertEqual(result.hp, "70")
        info = result.as_card_info({"svi", "pal"})
        self.assertEqual(info["set_code"], "SVI")
        self.assertIsNone(result.as_card_info({"pal"})["set_code"])

    def test_nothing_readable(self):
        result = ocr.parse_text(["", "flavour text only"])
        self.assertIsNone(result.number_local)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class IndexAndPipelineTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine, autoflush=False)
        self.db = self.Session()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)
        self.embedder = embed.FakeEmbedder()
        self.pictures = {f"c{n}": card_picture(n) for n in range(1, 6)}
        self.db.add(Set(id="tst_en", tcg_set_id="tst", name="Test Set", series="X", lang="en", total=5, printed_total=5, abbreviation="TST"))
        for n, (name, picture) in enumerate(self.pictures.items(), start=1):
            self.db.add(Card(
                id=f"tst-{n}_en", tcg_card_id=f"tst-{n}", name=f"Mon {n}", set_id="tst", number=str(n), lang="en", is_custom=False,
                is_digital=False, images_small=f"https://img.example/tst-{n}/low.webp", images_large=f"https://img.example/tst-{n}/high.webp",
            ))
        self.db.add(Card(id="dig-1_en", tcg_card_id="dig-1", name="Digital", set_id="tst", number="9", lang="en", is_custom=False,
                         is_digital=True, images_small="https://img.example/dig-1/low.webp"))
        self.db.add(Card(id="tst-1_de", tcg_card_id="tst-1", name="Mon 1", set_id="tst", number="1", lang="de", is_custom=False,
                         is_digital=False, images_small="https://img.example/tst-1de/low.webp"))
        self.db.commit()
        for n, picture in enumerate(self.pictures.values(), start=1):
            self._cache(f"tst-{n}_en", picture)

    def _cache(self, card_id, picture):
        card = self.db.query(Card).filter(Card.id == card_id).one()
        key = card_picture_packs.card_image_key(card.id, card.images_small)
        self.db.add(ImageCache(image_key=key, data=png_bytes(picture.resize((245, 337))), content_type="image/png"))
        self.db.commit()

    def build(self):
        return index.build_index(self.Session, self.embedder, data_dir=self.data_dir)

    def test_builds_english_physical_cards_only_and_is_incremental(self):
        first = self.build()
        self.assertEqual((first["total"], first["embedded"], first["reused"], first["indexed"]), (5, 5, 0, 5))
        loaded = index.load_index(self.embedder.name, self.data_dir)
        self.assertEqual(sorted(loaded.card_ids), [f"tst-{n}_en" for n in range(1, 6)])
        np.testing.assert_allclose(np.linalg.norm(loaded.vectors, axis=1), 1.0, rtol=1e-5)
        second = self.build()
        self.assertEqual((second["embedded"], second["reused"]), (0, 5))

    def test_a_changed_picture_url_is_embedded_again_and_a_missing_picture_is_counted(self):
        self.build()
        card = self.db.query(Card).filter(Card.id == "tst-2_en").one()
        card.images_small = "https://img.example/tst-2/new-low.webp"
        self.db.commit()
        third = self.build()
        self.assertEqual((third["embedded"], third["not_cached"], third["reused"]), (0, 1, 4))
        self._cache("tst-2_en", card_picture(99))
        fourth = self.build()
        self.assertEqual((fourth["embedded"], fourth["indexed"]), (1, 5))

    def test_search_finds_the_card_itself_first(self):
        self.build()
        loaded = index.load_index(self.embedder.name, self.data_dir)
        query = self.embedder.embed([np.asarray(self.pictures["c3"].resize((245, 337)))])
        hits = loaded.search(query, 3)[0]
        self.assertEqual(hits[0][0], "tst-3_en")
        self.assertGreater(hits[0][1], 0.99)
        status = index.index_status(self.embedder.name, self.data_dir)
        self.assertEqual((status["built"], status["count"]), (True, 5))

    def test_pipeline_decides_by_number_and_picture_and_is_unsure_otherwise(self):
        self.build()
        loaded = index.load_index(self.embedder.name, self.data_dir)
        loader = pipeline.db_candidate_loader(self.Session)

        class Reader:
            def __init__(self, number_local, number_total):
                self.result = ocr.OcrResult(number_local=number_local, number_total=number_total, tokens=["TST"])

            def read(self, card, read_hp=False, flipped=None):
                return self.result

        jpeg, _corners, _s = synthetic.make_photo(self.pictures["c4"], 4)
        photo = images.decode_rgb(jpeg)
        with_number = pipeline.CardMatcher(loaded, self.embedder, loader, Reader("4", "5")).match(photo)
        self.assertEqual(with_number.status, "decided")
        self.assertEqual(with_number.decision["card_id"], "tst-4_en")
        self.assertIn(with_number.decision["mechanism"], {"number_unique", "number_metadata"})
        self.assertEqual(set(with_number.timings_ms) >= {"detect", "embed", "search", "ocr", "decide", "total"}, True)
        with patch.object(pipeline, "SIM_MIN_PICTURE_STRONG", 2.0):  # the picture-only lane has its own test
            wrong_number = pipeline.CardMatcher(loaded, self.embedder, loader, Reader("77", "5")).match(photo)
        self.assertEqual(wrong_number.status, "unsure")
        self.assertEqual(wrong_number.unsure_reason, "number_not_among_picture_matches")
        self.assertTrue(wrong_number.matches)
        no_reader = pipeline.CardMatcher(loaded, self.embedder, loader, None).match(photo, use_ocr=False)
        self.assertIn(no_reader.status, {"decided", "unsure"})
        self.assertEqual(len(no_reader.matches), 5)

    def test_decide_requires_the_picture_to_agree_with_the_printed_number(self):
        candidates = [
            {"tcg_card_id": "a-1", "number": "1", "printed_total": 10, "_similarity": 0.9, "_rank": 1, "_db_id": "a-1_en"},
            {"tcg_card_id": "b-5", "number": "5", "printed_total": 10, "_similarity": 0.3, "_rank": 2, "_db_id": "b-5_en"},
        ]
        chosen, reason = pipeline.decide({"number_local": "5", "number_total": "10"}, candidates)
        self.assertIsNone(chosen)
        self.assertEqual(reason, "rules_choice_not_close_in_picture")
        chosen, _ = pipeline.decide({"number_local": "1", "number_total": "10"}, candidates)
        self.assertEqual(chosen["candidate"]["tcg_card_id"], "a-1")

    def test_picture_only_needs_similarity_and_lead(self):
        sure = [{"number": "1", "_similarity": 0.95, "_rank": 1, "_db_id": "a"}, {"number": "2", "_similarity": 0.7, "_rank": 2, "_db_id": "b"}]
        self.assertEqual(pipeline.decide({}, sure)[0]["mechanism"], "picture_lead")
        close = [{"number": "1", "_similarity": 0.95, "_rank": 1, "_db_id": "a"}, {"number": "2", "_similarity": 0.94, "_rank": 2, "_db_id": "b"}]
        self.assertEqual(pipeline.decide({}, close)[1], "no_number_and_picture_not_clear")

    def test_a_number_that_names_nothing_may_be_decided_by_a_very_clear_picture_only(self):
        strong = [
            {"number": "1", "_similarity": 0.95, "_rank": 1, "_db_id": "a", "tcg_card_id": "a"},
            {"number": "2", "_similarity": 0.70, "_rank": 2, "_db_id": "b", "tcg_card_id": "b"},
        ]
        chosen, _ = pipeline.decide({"number_local": "77", "number_total": "5"}, strong)
        self.assertEqual(chosen["mechanism"], "picture_lead_strong")
        # A reprint with the same artwork scores nearly the same: no decision.
        reprint = [dict(strong[0]), {**strong[1], "_similarity": 0.93}]
        self.assertEqual(pipeline.decide({"number_local": "77", "number_total": "5"}, reprint)[1], "number_not_among_picture_matches")
        # Clear but under the strong bar: still no decision.
        middling = [{**strong[0], "_similarity": 0.84}, {**strong[1], "_similarity": 0.60}]
        self.assertEqual(pipeline.decide({"number_local": "77", "number_total": "5"}, middling)[1], "number_not_among_picture_matches")

    def test_a_damaged_number_is_corrected_from_the_closest_printings(self):
        candidates = [
            {"tcg_card_id": "x-112", "number": "112", "printed_total": 113, "_similarity": 0.9, "_rank": 1, "_db_id": "x-112_en"},
            {"tcg_card_id": "x-12", "number": "12", "printed_total": 113, "_similarity": 0.8, "_rank": 2, "_db_id": "x-12_en"},
            {"tcg_card_id": "y-69", "number": "69", "printed_total": 97, "_similarity": 0.7, "_rank": 3, "_db_id": "y-69_en"},
        ]
        # A read that names a real printing among the candidates is never overridden.
        info = {"number_local": "12", "number_total": "13"}
        self.assertIsNone(pipeline.correct_number(info, candidates, ["12/13"]))
        self.assertEqual(info["number_local"], "12")
        # A number that matches nothing is replaced by the one printing the text is a damaged copy of.
        only = candidates[:1] + candidates[2:]
        info = {"number_local": "12", "number_total": "13"}
        fixed = pipeline.correct_number(info, only, ["K-10#", "12/13"])
        self.assertEqual((info["number_local"], str(info["number_total"])), ("112", "113"))
        self.assertEqual(fixed["read"], "12")
        # Nothing was read at all, but the text holds "69/97" with the slash read as a 1.
        info = {"number_local": None, "number_total": None}
        pipeline.correct_number(info, only, ["ID K-10 #69197"])
        self.assertEqual(info["number_local"], "69")

    def test_constrained_reading_is_withheld_when_it_is_not_clear(self):
        from services.card_match import constrained

        cands = [{"number": "69", "printed_total": 97}, {"number": "12", "printed_total": 97}, {"number": "125", "printed_total": 197}]
        self.assertEqual(constrained.constrain(["69/97"], cands).index, 0)
        self.assertEqual(constrained.constrain(["W5N-012 69197 *"], cands).index, 0)  # slash read as 1
        self.assertEqual(constrained.constrain(["25/197"], cands).index, 2)  # a dropped first digit
        self.assertIsNone(constrained.constrain(["GAMEFREAK 1999"], cands))
        self.assertIsNone(constrained.constrain([], cands))
        # Two printings print the same number and total: the text cannot choose between them.
        twins = [{"number": "5", "printed_total": 100}, {"number": "5", "printed_total": 100}]
        self.assertIsNone(constrained.constrain(["5/100"], twins))
        # Gallery numbers do not take part.
        self.assertIsNone(constrained.constrain(["TG06/TG30"], [{"number": "TG06", "printed_total": 30}]))

    def test_the_reader_turns_the_card_when_it_finds_no_number_and_reads_one_way_when_told_which(self):
        calls = []

        class Fake(ocr.OcrReader):
            def __init__(self):
                pass

            def _read_card(self, card):
                calls.append(int(card[0, 0, 0]))
                # Readable only when the marker pixel is at the top-left of what we are given.
                return ocr.parse_text(["58/102"] if card[0, 0, 0] == 1 else [])

        card = np.zeros((880, 630, 3), dtype=np.uint8)
        card[-1, -1, 0] = 1  # upside down: after turning it sits at [0, 0]
        reader = Fake()
        result = reader.read(card, read_hp=False)
        self.assertEqual((result.number_local, result.flipped), ("58", True))
        self.assertEqual(calls, [0, 1])
        calls.clear()
        told = reader.read(card, read_hp=False, flipped=True)
        self.assertEqual((told.number_local, told.flipped), ("58", True))
        self.assertEqual(calls, [1])  # one pass only
        calls.clear()
        upright_told = reader.read(card, read_hp=False, flipped=False)
        self.assertIsNone(upright_told.number_local)
        self.assertEqual(calls, [0])

    def test_benchmark_picks_traps_holo_and_random_cards(self):
        self.build()
        loaded = index.load_index(self.embedder.name, self.data_dir)
        for card in self.db.query(Card).filter(Card.lang == "en", Card.is_digital == False):  # noqa: E712
            card.name = "Pikachu" if card.number in {"1", "2", "3", "4"} else card.name
            card.rarity = "Rare Holo" if card.number == "5" else "Common"
        self.db.commit()
        sample = benchmark.choose_cards(self.db, loaded, count=5, traps=2, holo=1)
        tags = {tag for entry in sample for tag in entry["tags"]}
        self.assertIn("trap", tags)
        self.assertIn("holo", tags)
        self.assertEqual(len({entry["id"] for entry in sample}), len(sample))

    def test_timing_summary_and_percentiles(self):
        rows = [{"total": float(n)} for n in range(1, 101)]
        summary = benchmark.timing_summary(rows)["total"]
        self.assertEqual(summary["median"], 50.5)
        self.assertEqual(summary["p95"], 95)

    def test_report_round_trip_and_labelled_traces_count(self):
        report = {"kind": "synthetic", "metrics": {"n": 1}}
        path = benchmark.save_report(report, self.data_dir)
        self.assertEqual(benchmark.latest_reports(self.data_dir)["synthetic"]["metrics"]["n"], 1)
        self.assertTrue(path.name.startswith("benchmark-synthetic-"))
        self.assertEqual(benchmark.count_labelled_traces(self.data_dir / "nope"), 0)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class JobTests(unittest.TestCase):
    def test_only_one_job_runs_at_a_time(self):
        runner = jobs.MatchJobs()
        release = __import__("threading").Event()
        started, _ = runner.start("index", lambda: (release.wait(5), {"ok": True})[1])
        self.assertTrue(started)
        again, status = runner.start("benchmark-synthetic", lambda: {})
        self.assertFalse(again)
        self.assertTrue(status["running"])
        release.set()
        runner.wait(5)
        self.assertEqual(runner.status()["summary"], {"ok": True})
        self.assertFalse(runner.status()["running"])

    def test_a_failing_job_records_its_error(self):
        runner = jobs.MatchJobs()

        def boom():
            raise RuntimeError("no pictures")

        runner.start("index", boom)
        runner.wait(5)
        self.assertEqual(runner.status()["error"], "no pictures")

    def test_autorun_is_off_unless_the_flag_is_set(self):
        with patch.dict(os.environ, {"SCAN_MATCHER_AUTORUN": ""}):
            self.assertFalse(jobs.autorun_once(None, delay_seconds=0))

    def test_autorun_runs_once_per_matcher_version(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"CARD_MATCH_DIR": directory}):
            self.assertTrue(jobs.autorun_due())
            Path(directory, "autorun.json").write_text('{"matcher_version": "%s", "model": "%s"}' % (jobs.MATCHER_VERSION, jobs.DEFAULT_MODEL))
            self.assertFalse(jobs.autorun_due())

    def test_threads_are_capped(self):
        with patch.dict(os.environ, {"CARD_MATCH_THREADS": "99"}):
            self.assertEqual(config.threads(), 8)
        with patch.dict(os.environ, {"CARD_MATCH_THREADS": "x"}):
            self.assertEqual(config.threads(), 3)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class AdminApiTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.admin = User(username="oak", hashed_password="x", role="admin", is_active=True)
        self.db.add_all([self.user, self.admin, Setting(key="tcgdex_sync_languages", value="en")])
        self.db.commit()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.dict(os.environ, {"CARD_MATCH_DIR": self.tmp.name, "CARD_MATCH_MODEL_DIR": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.current = self.user

        def override_db():
            session = self.Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_db
        main.app.dependency_overrides[get_current_user] = lambda: self.current
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    def test_non_admins_get_nothing(self):
        self.assertEqual(self.client.get("/api/card-match/status").status_code, 403)
        self.assertEqual(self.client.post("/api/card-match/index").status_code, 403)
        self.assertEqual(self.client.post("/api/card-match/benchmark", json={"kind": "synthetic"}).status_code, 403)
        self.assertEqual(self.client.post("/api/card-match/stop").status_code, 403)

    def test_admin_status_reports_coverage_and_reports(self):
        self.current = self.admin
        status = self.client.get("/api/card-match/status").json()
        self.assertEqual(status["index"]["built"], False)
        self.assertEqual(status["english_total"], 0)
        self.assertFalse(status["model"]["available"])
        self.assertIn("thresholds", status)
        self.assertEqual(status["reports"], {})

    def test_starting_needs_the_model_and_an_index(self):
        self.current = self.admin
        self.assertEqual(self.client.post("/api/card-match/index").status_code, 409)  # no model file here
        self.assertEqual(self.client.post("/api/card-match/benchmark", json={"kind": "bogus"}).status_code, 422)

    def test_admin_can_start_an_index_build_when_the_model_exists(self):
        self.current = self.admin
        with patch.object(embed, "model_available", return_value=True), \
                patch.object(jobs, "start_index", return_value=(True, {"running": True})) as start:
            response = self.client.post("/api/card-match/index")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["started"])
        start.assert_called_once()


MODEL_FILE = embed.model_path(embed.DEFAULT_MODEL) if DEPS_AVAILABLE else None


@unittest.skipUnless(DEPS_AVAILABLE and MODEL_FILE is not None and MODEL_FILE.is_file(), "the DINOv2 model file is not present")
class RealModelTests(unittest.TestCase):
    def test_vectors_are_unit_length_and_the_same_card_is_closest(self):
        embedder = embed.get_embedder()
        pictures = [np.asarray(card_picture(n)) for n in (1, 2, 3)]
        vectors = embedder.embed(pictures + [np.asarray(card_picture(2).resize((245, 337)))])
        self.assertEqual(vectors.shape, (4, 384))
        np.testing.assert_allclose(np.linalg.norm(vectors, axis=1), 1.0, rtol=1e-4)
        self.assertEqual(int(np.argmax(vectors[3] @ vectors[:3].T)), 1)


if __name__ == "__main__":
    unittest.main()
