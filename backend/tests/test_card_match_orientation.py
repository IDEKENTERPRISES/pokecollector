"""Which way up the card is (services/card_match/pipeline.py), the upside-down tag, and reading text at full resolution.

An upright card on a weak picture match must stay upright; a card that really is turned is still read turned;
the "Upside down" tag in the Misses view is a measurement against the confirmed card, never the matcher's guess.
"""
import tempfile
import unittest
from pathlib import Path

try:
    import numpy as np
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import Card, ImageCache, Set
    from services import card_picture_packs
    from services.card_match import detect, embed, images, index, misses, names, ocr, pipeline, synthetic
    from tests.test_card_match import card_picture, png_bytes

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


class RecordingReader:
    """OCR stand-in: reads text only on the side given (``readable``: "upright", "turned" or "none") and records the calls."""

    def __init__(self, readable="upright", number="4", total="5", name="Mon 4"):
        self.readable, self.number, self.total, self.name = readable, number, total, name
        self.calls: list[tuple[str, bool]] = []
        self.shapes: list[tuple] = []

    def _ok(self, flipped):
        return (self.readable == "turned") == bool(flipped) and self.readable != "none"

    def read(self, card, read_hp=False, flipped=None):
        self.calls.append(("read", bool(flipped)))
        self.shapes.append(card.shape)
        if self._ok(flipped):
            return ocr.OcrResult(number_local=self.number, number_total=self.total, tokens=["TST"])
        return ocr.OcrResult()

    def read_name(self, card, *, flipped=False):
        self.calls.append(("name", bool(flipped)))
        return names.NameRead(name=self.name if self._ok(flipped) else None, raw=[])


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class OrientationBase(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine, autoflush=False)
        db = self.Session()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data_dir = Path(tmp.name)
        self.embedder = embed.FakeEmbedder()
        db.add(Set(id="tst_en", tcg_set_id="tst", name="Test Set", series="X", lang="en", total=5, printed_total=5, abbreviation="TST"))
        self.pictures = {n: card_picture(n) for n in range(1, 6)}
        for n, picture in self.pictures.items():
            card = Card(id=f"tst-{n}_en", tcg_card_id=f"tst-{n}", name=f"Mon {n}", set_id="tst", number=str(n), lang="en",
                        is_custom=False, is_digital=False, images_small=f"https://img.example/tst-{n}/low.webp")
            db.add(card)
            db.add(ImageCache(image_key=card_picture_packs.card_image_key(card.id, card.images_small),
                              data=png_bytes(picture.resize((245, 337))), content_type="image/png"))
        db.commit()
        db.close()
        index.build_index(self.Session, self.embedder, data_dir=self.data_dir)
        self.index = index.load_index(self.embedder.name, self.data_dir)
        jpeg, _corners, _settings = synthetic.make_photo(self.pictures[4], 4)
        self.photo = images.decode_rgb(jpeg)

    def matcher(self, reader, margin=None, **options):
        matcher = pipeline.CardMatcher(self.index, self.embedder, pipeline.db_candidate_loader(self.Session), reader, **options)
        if margin is not None:  # what the picture search says about the two views: turned minus upright
            real = matcher._main_scores
            matcher._main_scores = lambda upright: (lambda best, up, turned: (best, 0.5, 0.5 + margin))(*real(upright))
        return matcher


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class OrientationTests(OrientationBase):
    # ── the choice ───────────────────────────────────────────────────────────

    def test_an_upright_card_on_a_weak_picture_match_stays_upright(self):
        """The turned view scores a little higher by chance (card not in the index, holo glare): not a reason to turn."""
        reader = RecordingReader("upright")
        result = self.matcher(reader, margin=0.03).match(self.photo)
        self.assertFalse(result.ocr["flipped"])
        self.assertEqual(result.ocr["orientation"]["by"], "default")
        self.assertEqual(result.ocr["number_local"], "4")
        self.assertEqual(reader.calls, [("read", False)])  # read once, upright: nothing was turned

    def test_a_card_that_really_is_turned_is_still_read_turned_when_the_picture_is_sure(self):
        reader = RecordingReader("turned")
        result = self.matcher(reader, margin=0.30).match(self.photo)
        self.assertTrue(result.ocr["flipped"])
        self.assertEqual(result.ocr["orientation"]["by"], "picture")
        self.assertEqual(reader.calls, [("read", True)])

    def test_a_turned_card_on_a_weak_picture_is_found_by_its_text(self):
        reader = RecordingReader("turned")
        result = self.matcher(reader, margin=0.0).match(self.photo)
        self.assertTrue(result.ocr["flipped"])
        self.assertEqual(result.ocr["orientation"]["by"], "text")
        self.assertEqual(result.ocr["number_local"], "4")
        self.assertEqual(reader.calls, [("read", False), ("read", True)])

    def test_nothing_readable_either_way_stays_upright(self):
        result = self.matcher(RecordingReader("none"), margin=0.05).match(self.photo)
        self.assertFalse(result.ocr["flipped"])
        self.assertEqual(result.ocr["orientation"]["by"], "default")

    def test_a_name_in_the_catalogue_counts_as_text_when_there_is_no_number(self):
        name_index = names.build_name_index(self.Session, self.index.card_ids)
        reader = RecordingReader("upright", number=None, total=None, name="Mon 4")
        result = self.matcher(reader, margin=0.0, names=name_index).match(self.photo)
        self.assertFalse(result.ocr["flipped"])
        self.assertEqual(result.ocr["name"], "Mon 4")
        self.assertNotIn(("read", True), reader.calls)

    def test_the_margin_is_a_real_threshold(self):
        just_under = pipeline.ORIENT_MARGIN - 0.01
        self.assertFalse(self.matcher(RecordingReader("upright"), margin=just_under).match(self.photo).ocr["flipped"])
        self.assertTrue(self.matcher(RecordingReader("turned"), margin=pipeline.ORIENT_MARGIN + 0.01).match(self.photo).ocr["flipped"])

    def test_an_upright_photo_of_a_card_in_the_index_is_never_turned(self):
        for seed in range(6):
            jpeg, _corners, settings = synthetic.make_photo(self.pictures[4], seed)
            if settings["upside_down"]:
                continue
            result = self.matcher(RecordingReader("upright")).match(images.decode_rgb(jpeg))
            self.assertFalse(result.ocr["flipped"], seed)

    # ── measuring the rotation (the "Upside down" tag) ───────────────────────

    def test_the_rotation_is_measured_against_the_confirmed_card(self):
        matcher = self.matcher(RecordingReader("upright"))
        flat = np.asarray(self.pictures[4])
        upright = matcher.card_rotation(flat, "tst-4_en")
        turned = matcher.card_rotation(np.ascontiguousarray(flat[::-1, ::-1]), "tst-4_en")
        self.assertFalse(upright["rotated"])
        self.assertTrue(turned["rotated"])
        self.assertIsNone(matcher.card_rotation(flat, "not-indexed_en"))

    def test_the_tag_follows_the_measurement_not_the_matchers_choice(self):
        truth = {"card_id": "t", "name": "Illumise", "card_type": "pokemon", "rarity": "Common"}
        base = dict(found=True, truth=truth, others=[], stats={"glare": 0.0, "mean": 120, "sharpness": 200})
        self.assertNotIn("upside_down", misses.tag_miss(rotated=False, **base))
        self.assertNotIn("upside_down", misses.tag_miss(rotated=None, **base))
        self.assertIn("upside_down", misses.tag_miss(rotated=True, **base))
        with self.assertRaises(TypeError):  # the old "the matcher turned it" input is gone
            misses.tag_miss(flipped=True, **base)

    def test_the_report_says_how_the_misses_split_on_orientation(self):
        items = [
            {"orientation": {"picture_margin": 0.02}, "rotation": {"rotated": False}},  # the old rule would turn it
            {"orientation": {"picture_margin": -0.2}, "rotation": {"rotated": False}},
            {"orientation": {"picture_margin": 0.4}, "rotation": {"rotated": True}},
            {"orientation": None, "rotation": None},
        ]
        self.assertEqual(
            misses.orientation_check(items),
            {"misses": 4, "with_margin": 3, "old_rule_would_turn": 2, "picture_sure_turned": 1, "measured_rotated": 1, "measured_upright": 2},
        )

    def test_an_upright_miss_is_not_tagged_upside_down_even_when_the_matcher_turned_it(self):
        matcher = self.matcher(RecordingReader("turned"), margin=0.30)  # the picture search wrongly says "turned"
        outcome = matcher.match(self.photo)
        self.assertTrue(outcome.ocr["flipped"])
        collector = misses.MissCollector(matcher.candidate_loader, self.data_dir)
        collector.add(trace="t.json", photo=self.photo, outcome=outcome, truth_id="tst-2_en", matcher=matcher)
        item = collector.items[0]
        self.assertNotIn("upside_down", item["tags"])
        self.assertIn("rotation", item)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class TextResolutionTests(OrientationBase):
    """The text is read from the sharpest picture there is, and every caller reads the same one."""

    def full_photo(self):
        """A 2048-px-high photo of the same card, and the 1024-px recognition image made from it."""
        from PIL import Image

        big = Image.fromarray(np.asarray(self.pictures[4])).resize((1008, 1408))
        jpeg, _corners, _settings = synthetic.make_photo(big, 4)
        full = images.decode_rgb(jpeg, max_side=2048)
        small = images.decode_rgb(jpeg, max_side=1024)
        return full, small

    def test_the_full_photo_gives_a_sharper_card_than_the_recognition_image(self):
        full, small = self.full_photo()
        reader = RecordingReader("upright")
        sharp = self.matcher(reader).match(small, full_photo=full)
        plain = self.matcher(RecordingReader("upright")).match(small)
        self.assertEqual(sharp.ocr["text_input"]["source"], "full_photo")
        self.assertGreater(sharp.ocr["text_input"]["height"], detect.CARD_H)
        self.assertLessEqual(sharp.ocr["text_input"]["height"], detect.HIRES_H)
        self.assertIn(plain.ocr["text_input"]["source"], {"photo", "crop"})
        self.assertEqual(reader.shapes[0], sharp.text_card.shape)
        # What is embedded and searched does not change.
        self.assertEqual([m["card_id"] for m in sharp.matches], [m["card_id"] for m in plain.matches])

    def test_a_stored_card_is_read_exactly_like_the_live_run_read_it(self):
        """Shadow mode and picture-first read the full photo; the benchmark re-reads the stored card: same text input, same answer."""
        full, small = self.full_photo()
        live = self.matcher(RecordingReader("upright")).match(small, full_photo=full)
        reader = RecordingReader("upright")
        stored = images.decode_rgb(images.encode_jpeg(live.text_card, 90))
        replay = self.matcher(reader).match(small, flat_card=stored)
        self.assertEqual(replay.ocr["text_input"]["source"], "stored_card")
        self.assertEqual(reader.shapes[0], live.text_card.shape)
        self.assertEqual(replay.decision, live.decision)
        self.assertEqual(replay.ocr["number_local"], live.ocr["number_local"])

    def test_a_tight_guide_crop_from_the_camera_frame_is_found_matches_and_read_sharper(self):
        """The upload keeps the guide box cut from the original frame (services.scan_storage); the card must
        still be found in it, look like the card found in the recognition image, and be read at HIRES_H."""
        from PIL import Image

        from services import scan_storage

        big = Image.fromarray(np.asarray(self.pictures[4])).resize((1008, 1408))
        frame = Image.new("RGB", (3840, 2160), (70, 80, 90))
        card = big.resize((1400, 1955))
        frame.paste(card, ((3840 - 1400) // 2, (2160 - 1955) // 2))
        buffer = __import__("io").BytesIO()
        frame.save(buffer, format="JPEG", quality=92)
        box = (0.3, 0.02, 0.4, 0.96)  # what the camera screen's guide frame (plus margin) would send
        sanitized = scan_storage.sanitize_image_bytes(buffer.getvalue(), box)
        small = images.decode_rgb(scan_storage.make_recognition_image(sanitized.data, box), max_side=1024)
        sharp_crop = images.decode_rgb(sanitized.sharp_crop, max_side=2048)
        self.assertEqual(max(sharp_crop.shape[:2]), 1600)

        result = self.matcher(RecordingReader("upright")).match(small, full_photo=sharp_crop)
        self.assertEqual(result.ocr["text_input"]["source"], "full_photo")
        self.assertGreater(result.ocr["text_input"]["height"], detect.CARD_H)
        self.assertLessEqual(result.ocr["text_input"]["height"], detect.HIRES_H)

    def test_a_full_photo_of_another_scene_is_not_used(self):
        full, small = self.full_photo()
        other = np.full_like(full, 90)
        result = self.matcher(RecordingReader("upright")).match(small, full_photo=other)
        self.assertNotEqual(result.ocr["text_input"]["source"], "full_photo")

    def test_a_zoom_that_follows_the_card_height(self):
        """A sharper card is upscaled less for the same strip size (so reading costs the same)."""
        class Engine:
            def __init__(self):
                self.shapes = []

            def __call__(self, image):
                self.shapes.append(image.shape)
                return None, None

        reader = ocr.OcrReader.__new__(ocr.OcrReader)
        reader.engine = Engine()
        import threading

        reader._lock = threading.Lock()
        low = np.zeros((880, 630, 3), dtype=np.uint8)
        high = np.zeros((1408, 1008, 3), dtype=np.uint8)
        reader._strip_items(low, (0.0, 0.9, 0.5, 1.0))
        reader._strip_items(high, (0.0, 0.9, 0.5, 1.0))
        low_shape, high_shape = reader.engine.shapes
        self.assertLess(abs(low_shape[0] - high_shape[0]), 4)
        self.assertLess(abs(low_shape[1] - high_shape[1]), 4)


if __name__ == "__main__":
    unittest.main()
