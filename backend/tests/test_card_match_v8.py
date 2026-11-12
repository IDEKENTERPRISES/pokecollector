"""Matcher version 8: the card finder that distrusts itself, the corners check, and the two tightened deciding rules."""
import os
import sys
import types
import unittest
from unittest.mock import patch

if os.name == "nt":  # api.recognize imports fcntl through the auth service; CI is Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

try:
    import cv2
    import numpy as np

    from services.card_match import MATCHER_VERSION, corners_check, detect, images, misses, ocr, pipeline, synthetic, variants
    from tests.test_card_match import card_picture
    from tests import test_card_match as base_tests, test_card_match_v6 as v6_tests

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

W, H = 450, 628  # a guide crop: 63:88


def noisy(colour, seed=3, shape=(H, W)):
    rng = np.random.default_rng(seed)
    return np.clip(np.full((*shape, 3), colour) + rng.integers(-6, 6, (*shape, 3)), 0, 255).astype(np.uint8)


def coverage(detection, picture):
    return float(cv2.contourArea(np.array(detection.corners, np.float32))) / (picture.shape[0] * picture.shape[1])


@skip
class OptionAndVersionTests(unittest.TestCase):
    def test_version_default_and_options(self):
        self.assertGreaterEqual(int(MATCHER_VERSION), 8)
        self.assertEqual(variants.DEFAULT_LABEL, "names+number+text+art+tta+fastread+numberonce+corners+wholepic")  # version 10: the version 9 pick, measured
        self.assertTrue(variants.parse(variants.DEFAULT_LABEL).corners)
        self.assertTrue(variants.parse(variants.DEFAULT_LABEL).wholepic)
        self.assertFalse(variants.parse(variants.DEFAULT_LABEL).trustrejected)
        self.assertTrue(variants.parse("names+wholepic").corners)  # both act on a refused quad
        self.assertTrue(variants.parse("names+trustrejected").corners)
        self.assertEqual(variants.parse("names+tworeads").label, "names")  # removed: ignored like any unknown word

    def test_the_comparison_has_the_finder_rows_and_at_most_twelve(self):
        labels = variants.COMPARE_LABELS
        self.assertLessEqual(len(labels), 13)  # version 11 added the three phone rows
        self.assertEqual(len(set(labels)), len(labels))
        self.assertFalse([label for label in labels if "tworeads" in label])
        for word in ("corners", "corners+wholepic"):  # version 9 dropped the trustrejected row (61.2%, no real gain); the option stays
            self.assertTrue(any(label.endswith("+" + word) for label in labels), word)
        self.assertIn(variants.DEFAULT_LABEL, labels)
        for label in labels:
            self.assertEqual(variants.parse(label).label, label)  # every row is spelled the way the options print


@skip
class FinderPlausibilityTests(unittest.TestCase):
    def test_a_card_that_fills_the_frame_is_still_found(self):
        picture = cv2.resize(np.asarray(card_picture(1).convert("RGB")), (W, H))
        detection = detect.detect_card(picture, check=True)
        self.assertTrue(detection.found)
        self.assertGreater(coverage(detection, picture), 0.85)
        self.assertIsNone(detection.rejected)

    def test_a_card_with_its_edges_cut_off_finds_nothing_and_does_not_invent_a_quad(self):
        card = np.asarray(card_picture(1).convert("RGB"))
        zoomed = cv2.resize(card, (int(630 * 1.08), int(880 * 1.08)))
        y0, x0 = (zoomed.shape[0] - 880) // 2, (zoomed.shape[1] - 630) // 2
        picture = cv2.resize(zoomed[y0:y0 + 880, x0:x0 + 630], (W, H))
        detection = detect.detect_card(picture, check=True)
        self.assertFalse(detection.found)
        self.assertEqual(detection.method, "guide_crop")
        whole = detect.detect_card(picture, check=True, whole=True)
        self.assertEqual(whole.method, "whole_picture")
        self.assertTrue(np.array_equal(whole.card, detect.whole_picture(picture)))

    def test_a_strong_inner_rectangle_with_no_outer_edge_is_refused_with_its_measurements(self):
        picture = noisy((200, 170, 90))
        iw = int(W * 0.6)
        ih = int(iw * 88 / 63)
        x0, y0 = (W - iw) // 2, int(H * 0.18)
        picture[y0:y0 + ih, x0:x0 + iw] = (40, 90, 160)
        before = detect.detect_card(picture)
        self.assertTrue(before.found)  # the version 7 finder takes the inner rectangle for the card
        self.assertLess(coverage(before, picture), 0.4)
        after = detect.detect_card(picture, check=True)
        self.assertFalse(after.found)
        self.assertEqual(after.method, "guide_crop")
        self.assertEqual(after.rejected["reason"], "too_small")
        self.assertLess(after.rejected["coverage"], detect.GUIDE_MIN_COVERAGE)
        self.assertEqual(len(after.rejected["corners"]), 4)
        self.assertTrue(after.rejected["guide_picture"])
        self.assertEqual(after.card.shape, (detect.CARD_H, detect.CARD_W, 3))

    def test_the_artwork_window_turned_on_its_side_is_refused(self):
        picture = noisy((200, 170, 90))
        aw = int(W * 0.86)
        ah = int(aw * 63 / 88)
        picture[int(H * 0.12):int(H * 0.12) + ah, (W - aw) // 2:(W - aw) // 2 + aw] = (40, 90, 160)
        after = detect.detect_card(picture, check=True)
        self.assertFalse(after.found)
        self.assertEqual(after.rejected["reason"], "sideways")

    def test_the_same_small_quad_in_a_full_photo_is_not_judged_by_how_much_it_covers(self):
        photo = noisy((60, 60, 60), shape=(1000, 800))  # a 4:5 full photo, not a guide crop
        card = np.asarray(card_picture(2).convert("RGB"))
        small = cv2.resize(card, (300, 419))
        photo[300:719, 250:550] = small
        self.assertFalse(detect.is_guide_picture(photo))
        detection = detect.detect_card(photo, check=True)
        self.assertTrue(detection.found)
        self.assertLess(coverage(detection, photo), 0.2)

    def test_a_card_on_a_cluttered_background_is_either_the_card_or_refused_never_a_fragment(self):
        picture = noisy((70, 90, 70))
        for index, colour in enumerate(((180, 60, 60), (60, 60, 180), (60, 180, 60))):  # other cards stacked behind
            x0 = 10 + index * 9
            picture[10 + index * 22:H - 8 - (2 - index) * 10, x0:x0 + 380] = colour
        front = cv2.resize(np.asarray(card_picture(4).convert("RGB")), (395, 551))
        picture[40:40 + 551, 28:28 + 395] = front
        detection = detect.detect_card(picture, check=True)
        if detection.found:
            self.assertGreaterEqual(coverage(detection, picture), detect.GUIDE_MIN_COVERAGE)
        else:
            self.assertIn(detection.method, ("guide_crop", "whole_picture"))

    def test_normal_cards_tilted_with_perspective_keep_working(self):
        good = 0
        for seed in range(6):
            jpeg, corners, _ = synthetic.make_photo(card_picture(seed), seed)
            photo = images.decode_rgb(jpeg)
            ph, pw = photo.shape[:2]
            cx, cy = np.mean([p[0] for p in corners]), np.mean([p[1] for p in corners])
            bh = 1536
            bw = int(bh * 63 / 88)
            x0, y0 = int(min(max(cx - bw / 2, 0), pw - bw)), int(min(max(cy - bh / 2, 0), ph - bh))
            crop = photo[y0:y0 + bh, x0:x0 + bw]  # a guide crop with the card at 55 to 80% of it
            truth = [(x - x0, y - y0) for x, y in corners]
            width = ((truth[1][0] - truth[0][0]) ** 2 + (truth[1][1] - truth[0][1]) ** 2) ** 0.5
            detection = detect.detect_card(crop, check=True)
            if detection.found and synthetic.corner_error(detection.corners, truth, width) < 0.05:
                good += 1
        self.assertGreaterEqual(good, 5)

    def test_check_off_is_the_version_7_finder(self):
        picture = noisy((200, 170, 90))
        picture[100:400, 100:310] = (40, 90, 160)
        self.assertTrue(detect.detect_card(picture).found)

    def test_measures_are_plain_geometry(self):
        quad = np.array([[0, 0], [100, 0], [100, 140], [0, 140]], np.float32)
        measures = detect.quad_measures(quad, 14000.0, 56000.0)
        self.assertEqual(measures["coverage"], 0.25)
        self.assertEqual(measures["angle_deviation"], 0.0)
        self.assertLess(measures["ratio_error"], 0.01)
        self.assertEqual(detect.plausibility_problem(measures, True), "too_small")
        self.assertIsNone(detect.plausibility_problem(measures, False))
        skewed = detect.quad_measures(np.array([[0, 0], [100, 0], [260, 140], [0, 140]], np.float32), 25200.0, 56000.0)
        self.assertEqual(detect.plausibility_problem(skewed, False), "bad_angles")


@skip
class FindCardWiringTests(unittest.TestCase):
    setUp = base_tests.IndexAndPipelineTests.setUp
    _cache = base_tests.IndexAndPipelineTests._cache
    build = base_tests.IndexAndPipelineTests.build
    matcher = v6_tests.FallbackTests.matcher

    def refused(self, **options):
        matcher = self.matcher("4", "5")
        for key, value in options.items():
            setattr(matcher, key, value)
        photo = np.zeros((628, 450, 3), np.uint8)
        rejected = {"reason": "too_small", "coverage": 0.3, "corners": [[0, 0]] * 4}
        calls = []

        def fake(picture, **kwargs):
            calls.append(kwargs)
            return detect.Detection(card=np.zeros((880, 630, 3), np.uint8), found=False, confidence=0.2, method="guide_crop", rejected=rejected)

        with patch.object(detect, "detect_card", side_effect=fake):
            outcome = matcher.match(photo)
        return outcome, calls

    def test_the_options_reach_the_finder_and_the_refusal_reaches_the_lab(self):
        outcome, calls = self.refused(corners=True, wholepic=True)
        self.assertEqual(calls[0], {"check": True, "whole": True})
        self.assertEqual(outcome.detection["rejected"]["reason"], "too_small")
        self.assertEqual(outcome.detection["fallback"], "guide_crop")
        off, calls = self.refused()
        self.assertEqual(calls[0], {})  # off: the version 7 finder, called as before

    def test_a_refused_quad_is_decided_strictly_unless_trustrejected_is_on(self):
        none_read = self.matcher(None, None)
        photo = np.zeros((628, 450, 3), np.uint8)
        rejected = {"reason": "too_small", "coverage": 0.3, "corners": []}
        fake = lambda picture, **kw: detect.Detection(card=np.zeros((880, 630, 3), np.uint8), found=False, confidence=0.2, method="guide_crop", rejected=rejected)
        with patch.object(detect, "detect_card", side_effect=fake):
            self.assertEqual(none_read.match(photo).unsure_reason, "card_not_found_no_number_read")
        none_read.corners, none_read.trustrejected = True, True
        with patch.object(detect, "detect_card", side_effect=fake):
            self.assertNotEqual(none_read.match(photo).unsure_reason, "card_not_found_no_number_read")
        nothing = lambda picture, **kw: detect.Detection(card=np.zeros((880, 630, 3), np.uint8), found=False, confidence=0.2, method="guide_crop")
        with patch.object(detect, "detect_card", side_effect=nothing):  # nothing card-like at all: still strict
            self.assertEqual(none_read.match(photo).unsure_reason, "card_not_found_no_number_read")

    def test_a_stored_card_made_from_refused_corners_is_not_trusted_for_the_text(self):
        matcher = pipeline.CardMatcher.__new__(pipeline.CardMatcher)
        matcher.corners = True
        stored = np.zeros((1400, 1000, 3), np.uint8)
        upright = np.zeros((880, 630, 3), np.uint8)
        sharp = np.zeros((1200, 860, 3), np.uint8)
        refused = detect.Detection(card=upright, found=False, confidence=0.2, method="guide_crop", hires=sharp, rejected={"reason": "too_small"})
        card, source = matcher._text_card(refused, upright, None, stored, "guide_crop")
        self.assertIs(card, sharp)
        self.assertEqual(source, "guide_crop_sharp")
        fine = detect.Detection(card=upright, found=True, confidence=0.9, method="contour")
        self.assertEqual(matcher._text_card(fine, upright, None, stored, None)[1], "stored_card")
        matcher.corners = False
        self.assertEqual(matcher._text_card(refused, upright, None, stored, "guide_crop")[1], "stored_card")


def candidate(name, number, total, rank, similarity, set_name="Set", **extra):
    return {"name": name, "number": number, "printed_total": total, "_rank": rank, "_similarity": similarity, "set": set_name,
            "tcg_card_id": f"{name}-{number}-{set_name}", "_lang": "en", **extra}


@skip
class DecideTighteningTests(unittest.TestCase):
    """The Darumaka case: Black Bolt #013/086 read as 023/086 and decided as Black & White #23/114."""

    def darumaka(self):
        wrong = candidate("Darumaka", "23", 114, 2, 0.6416, "Black & White")
        right = candidate("Darumaka", "13", 86, 1, 0.7928, "Black Bolt")
        other = candidate("Sandile", "23", None, 7, 0.55, "Elsewhere")  # a second card carries the number, so the picture breaks the tie
        return wrong, right, other

    def test_the_old_rule_would_have_decided_the_wrong_printing(self):
        wrong, right, other = self.darumaka()
        info = {"number_local": "023", "number_total": None}
        with patch.object(pipeline, "SAME_NAME_PICTURE_MARGIN", 9.0):
            chosen, _ = pipeline.decide(info, [right, wrong, other])
        self.assertEqual(chosen["candidate"], wrong)  # no read total, no margin: version 7's answer

    def test_the_darumaka_case_is_now_unsure(self):
        wrong, right, other = self.darumaka()
        info = {"number_local": "023", "number_total": "086"}
        chosen, reason = pipeline.decide(info, [right, wrong, other])
        self.assertIsNone(chosen)
        self.assertEqual(reason, "total_contradicts_read")

    def test_a_total_that_contradicts_alone_blocks_it_and_leading_zeros_do_not(self):
        wrong = candidate("Darumaka", "23", 114, 1, 0.80)
        other = candidate("Sandile", "23", None, 7, 0.55)
        self.assertEqual(pipeline.decide({"number_local": "023", "number_total": "086"}, [wrong, other])[1], "total_contradicts_read")
        agree = candidate("Darumaka", "23", 86, 1, 0.80)
        chosen, _ = pipeline.decide({"number_local": "023", "number_total": "086"}, [agree, other])  # 086 is 86: numerically equal
        self.assertEqual(chosen["candidate"], agree)  # decided by the rules lane: the total agrees

    def test_a_closer_printing_of_the_same_name_blocks_the_number_lane_without_any_total(self):
        wrong, right, other = self.darumaka()
        chosen, reason = pipeline.decide({"number_local": "023", "number_total": None}, [right, wrong, other])
        self.assertIsNone(chosen)
        self.assertEqual(reason, "closer_printing_of_same_name")

    def test_a_reprint_that_is_only_a_little_closer_does_not_block(self):
        near = candidate("Darumaka", "23", 114, 2, 0.80)
        reprint = candidate("Darumaka", "13", 86, 1, 0.80 + pipeline.SAME_NAME_PICTURE_MARGIN - 0.01)
        other = candidate("Sandile", "23", None, 7, 0.60)
        chosen, _ = pipeline.decide({"number_local": "023", "number_total": None}, [reprint, near, other])
        self.assertEqual(chosen["candidate"], near)

    def test_the_margin_is_more_than_twice_the_reprint_noise(self):
        self.assertGreaterEqual(pipeline.SAME_NAME_PICTURE_MARGIN, 2 * pipeline.REPRINT_ART_LEAD)

    def test_picture_only_lanes_never_decide_a_card_whose_total_contradicts_a_read_total(self):
        top = candidate("Mon", "5", 114, 1, 0.92)
        second = candidate("Other", "6", 114, 2, 0.60)
        self.assertEqual(pipeline.decide({"number_local": None, "number_total": None}, [top, second])[0]["mechanism"], "picture_lead")
        chosen, reason = pipeline.decide({"number_local": None, "number_total": "086"}, [top, second])
        self.assertEqual((chosen, reason), (None, "total_contradicts_read"))

    def test_the_rules_lane_is_blocked_too(self):
        closer = candidate("Mon", "9", 100, 1, 0.90)
        carries = candidate("Mon", "7", 100, 3, 0.70)
        chosen, reason = pipeline.decide({"number_local": "7", "number_total": "100"}, [closer, carries])
        self.assertIsNone(chosen)
        self.assertEqual(reason, "closer_printing_of_same_name")


@skip
class CornersCheckTests(unittest.TestCase):
    def row(self, quad, guide, whole=0.5, batch="new", set_name="A", number_read=False, coverage=0.4, refused=None):
        return {"batch": batch, "set": set_name, "quad": quad, "guide": guide, "whole": whole, "number_read": number_read,
                "coverage": coverage, "ratio_error": 0.02, "angle_deviation": 3.0, "wide_over_tall": 0.7, "refused": refused}

    def test_a_scan_is_spoiled_only_when_the_guide_crop_is_clearly_closer(self):
        self.assertTrue(corners_check.spoiled(self.row(0.5, 0.5 + corners_check.CLEAR_MARGIN)))
        self.assertFalse(corners_check.spoiled(self.row(0.5, 0.5 + corners_check.CLEAR_MARGIN - 0.01)))
        self.assertFalse(corners_check.spoiled(self.row(None, 0.9)))  # no quad: not the finder's doing

    def test_the_summary_counts_groups_sets_and_the_numbers_not_read(self):
        rows = [
            self.row(0.40, 0.70, set_name="Black Bolt", refused="too_small", coverage=0.38),
            self.row(0.45, 0.75, set_name="Black Bolt", number_read=True, coverage=0.30),
            self.row(0.80, 0.82, set_name="Black Bolt", coverage=0.9, batch="tuning"),
            self.row(None, 0.6, set_name="Pitch Black"),
            self.row(0.50, 0.9, whole=0.4, set_name="Pitch Black", coverage=0.5, batch="tuning"),
        ]
        summary = corners_check.summarise(rows)
        self.assertEqual((summary["all"]["scans"], summary["all"]["spoiled"], summary["all"]["no_quad"]), (5, 3, 1))
        self.assertEqual(summary["all"]["spoiled_no_number"], 2)
        self.assertEqual(summary["all"]["refused_among_spoiled"], 1)
        self.assertEqual(summary["all"]["coverage"], {"min": 0.3, "median": 0.38, "max": 0.5})
        self.assertEqual((summary["new"]["scans"], summary["new"]["spoiled"], summary["tuning"]["spoiled"]), (3, 2, 1))
        self.assertEqual(summary["sets"][0], {"set": "Black Bolt", "scans": 3, "spoiled": 2, "spoiled_no_number": 1})
        self.assertEqual(summary["refused_reasons"], {"too_small": 1})
        self.assertEqual(corners_check.summarise([])["all"]["scans"], 0)

    def test_misses_are_tagged_corners_off_with_the_measurements(self):
        note = corners_check.miss_note(self.row(0.40, 0.70))
        self.assertTrue(note["spoiled"])
        tags = misses.tag_miss(found=True, rotated=False, truth={}, others=[], stats=None, corners=note)
        self.assertEqual(tags, ["corners_off"])
        self.assertEqual(misses.primary_tag(tags), "corners_off")
        self.assertIn("corners_off", misses.TAGS)
        fine = misses.tag_miss(found=True, rotated=False, truth={}, others=[], stats=None, corners=corners_check.miss_note(self.row(0.6, 0.62)))
        self.assertEqual(fine, ["other"])
        self.assertEqual(misses.tag_miss(found=True, rotated=False, truth={}, others=[], stats=None), ["other"])


@skip
class CardSimilaritiesTests(unittest.TestCase):
    def test_the_better_of_upright_and_turned_per_card(self):
        class Index:
            row_of = {"c": 0}
            vectors = np.array([[1.0, 0.0]], np.float32)

        class Embedder:
            def embed(self, views):  # a card's own vector for the upright view of card 0 and for the turned view of card 1
                return np.array([[1.0, 0.0] if int(v[0, 0, 0]) == 1 and i % 2 == 0 else [0.0, 1.0] if int(v[0, 0, 0]) == 2 else [0.5, 0.5]
                                 for i, v in enumerate(views)], np.float32)

        matcher = pipeline.CardMatcher.__new__(pipeline.CardMatcher)
        matcher.index, matcher.embedder = Index(), Embedder()
        mark = lambda value: np.full((4, 4, 3), value, np.uint8)
        sims = matcher.card_similarities([mark(1), mark(2), mark(3)], "c")
        self.assertEqual([round(s, 3) for s in sims], [1.0, 0.0, 0.5])
        self.assertIsNone(matcher.card_similarities([mark(1)], "missing"))


if __name__ == "__main__":
    unittest.main()
