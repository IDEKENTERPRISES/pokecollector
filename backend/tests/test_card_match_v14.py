"""Matcher version 14 test: ``edgeguard`` (an outline that touches the frame or dwarfs the guide is not trusted)."""
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

    from services.card_match import detect, variants
    from tests import test_card_match as base_tests, test_card_match_v6 as v6_tests

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

# The seven live scans of 18 Nov 2026: the finder's outline in the 1149x2046 frame (tl, tr, br, bl).
FRAME_W, FRAME_H = 1149, 2046
LIVE_OUTLINES = {
    "Pikachu 043": ([(243, 578), (887, 555), (894, 1472), (277, 1461)], False),
    "Articuno 018": ([(0, 323), (1149, 323), (1149, 1886), (0, 1886)], True),
    "Zweilous 098": ([(152, 500), (1149, 628), (1149, 2045), (250, 2045)], True),
    "Zeraora 057": ([(0, 746), (1149, 851), (1149, 2045), (252, 2045)], True),
    "Morpeko 061": ([(0, 851), (901, 630), (1149, 2045), (0, 2045)], True),
    "Jangmo-o 110": ([(0, 400), (1149, 409), (1149, 2045), (0, 2045)], True),
}

W, H = 450, 800


def frame_with_card():
    rng = np.random.default_rng(5)
    photo = np.clip(np.full((H, W, 3), (200, 170, 90)) + rng.integers(-6, 6, (H, W, 3)), 0, 255).astype(np.uint8)
    gx0, gy0, gx1, gy1 = (int(v) for v in detect.guide_rect(W, H))
    cw, ch = int((gx1 - gx0) * 0.9), int((gy1 - gy0) * 0.9)
    x0, y0 = (W - cw) // 2, (H - ch) // 2
    photo[y0:y0 + ch, x0:x0 + cw] = (40, 90, 160)
    return photo


@skip
class EdgeProblemTests(unittest.TestCase):
    def test_the_seven_live_outlines(self):
        guide = detect.guide_rect(FRAME_W, FRAME_H)
        for name, (corners, bad) in LIVE_OUTLINES.items():
            problem = detect.edge_problem(np.array(corners, np.float32), FRAME_W, FRAME_H, guide)
            self.assertEqual(problem is not None, bad, name)

    def test_the_reasons(self):
        guide = detect.guide_rect(FRAME_W, FRAME_H)
        problem = detect.edge_problem(np.array(LIVE_OUTLINES["Zeraora 057"][0], np.float32), FRAME_W, FRAME_H, guide)
        self.assertEqual(problem["reason"], "touches_edges")
        self.assertEqual(problem["edges_touched"], ["bottom", "left", "right"])
        big_inside = np.array([[60, 200], [1090, 200], [1090, 1850], [60, 1850]], np.float32)  # touches nothing, 1.9x the guide
        self.assertEqual(detect.edge_problem(big_inside, FRAME_W, FRAME_H, guide)["reason"], "oversized")

    def test_one_edge_alone_is_kept(self):
        guide = detect.guide_rect(FRAME_W, FRAME_H)
        brushing = np.array([[0, 500], [640, 500], [640, 1400], [0, 1400]], np.float32)
        self.assertIsNone(detect.edge_problem(brushing, FRAME_W, FRAME_H, guide))


@skip
class DetectWithEdgeGuardTests(unittest.TestCase):
    def test_a_card_in_a_frame_is_unchanged(self):
        photo = frame_with_card()
        plain = detect.detect_card(photo, check=True)
        guarded = detect.detect_card(photo, check=True, edgeguard=True)
        self.assertTrue(plain.found and guarded.found)
        self.assertIsNone(guarded.rejected)
        np.testing.assert_allclose(np.array(plain.corners), np.array(guarded.corners))

    def test_a_huge_outline_makes_it_look_inside_the_guide(self):
        photo = frame_with_card()
        huge = np.array([[0, 100], [W - 1, 100], [W - 1, H - 1], [0, H - 1]], np.float32)
        with patch.object(detect, "_find_quad", side_effect=lambda *a, **k: (huge * 1.0, 0.8) if not k.get("guide_input") else detect_inner(*a, **k)):
            result = detect.detect_card(photo, check=True, edgeguard=True)
        self.assertTrue(result.found)
        self.assertEqual(result.rejected["reason"], "touches_edges")
        self.assertTrue(result.rejected["searched_guide"])
        gx0, gy0, gx1, gy1 = detect.guide_rect(W, H)
        xs = [x for x, _y in result.corners]
        self.assertGreaterEqual(min(xs), gx0 - 2)  # the corners are back in the photo's own pixels, inside the guide
        self.assertLessEqual(max(xs), gx1 + 2)

    def test_no_card_in_the_guide_uses_the_guide_crop(self):
        rng = np.random.default_rng(2)
        photo = np.clip(np.full((H, W, 3), (200, 170, 90)) + rng.integers(-6, 6, (H, W, 3)), 0, 255).astype(np.uint8)
        huge = np.array([[0, 100], [W - 1, 100], [W - 1, H - 1], [0, H - 1]], np.float32)
        with patch.object(detect, "_find_quad", side_effect=lambda *a, **k: (huge, 0.8) if not k.get("guide_input") else None):
            result = detect.detect_card(photo, check=True, edgeguard=True)
        self.assertFalse(result.found)
        self.assertEqual(result.method, "guide_crop")
        self.assertEqual(result.rejected["reason"], "touches_edges")
        self.assertFalse(result.rejected["searched_guide"])

    def test_off_by_default(self):
        photo = frame_with_card()
        huge = np.array([[0, 100], [W - 1, 100], [W - 1, H - 1], [0, H - 1]], np.float32)
        with patch.object(detect, "_find_quad", return_value=(huge, 0.8)):
            result = detect.detect_card(photo, check=True)
        self.assertTrue(result.found)
        self.assertIsNone(result.rejected)


def detect_inner(*args, **kwargs):
    """The real finder, for the guide-crop search the patched outer call hands over."""
    return _REAL_FIND_QUAD(*args, **kwargs)


if DEPS_AVAILABLE:
    _REAL_FIND_QUAD = detect._find_quad


@skip
class PipelineWiringTests(unittest.TestCase):
    setUp = base_tests.IndexAndPipelineTests.setUp
    _cache = base_tests.IndexAndPipelineTests._cache
    build = base_tests.IndexAndPipelineTests.build
    matcher = v6_tests.FallbackTests.matcher

    def test_the_option_reaches_the_finder_and_the_trace(self):
        matcher = self.matcher("4", "5")
        matcher.corners = True
        matcher.edgeguard = True
        rejected = {"reason": "touches_edges", "edges_touched": ["left", "right"], "guide_area_ratio": 2.0, "corners": [[0, 0]] * 4, "searched_guide": False}
        calls = []

        def fake(picture, **kwargs):
            calls.append(kwargs)
            return detect.Detection(card=np.zeros((880, 630, 3), np.uint8), found=False, confidence=0.2, method="guide_crop", rejected=rejected)

        with patch.object(detect, "detect_card", side_effect=fake):
            outcome = matcher.match(np.zeros((800, 450, 3), np.uint8))
        self.assertTrue(calls[0]["edgeguard"])
        self.assertEqual(outcome.detection["fallback"], "guide_crop")
        self.assertEqual(outcome.detection["rejected"]["reason"], "touches_edges")
        matcher.edgeguard = False
        calls.clear()
        with patch.object(detect, "detect_card", side_effect=fake):
            matcher.match(np.zeros((800, 450, 3), np.uint8))
        self.assertNotIn("edgeguard", calls[0])


class OptionTests(unittest.TestCase):
    @unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
    def test_the_word_parses_and_needs_corners(self):
        options = variants.parse("names+edgeguard")
        self.assertTrue(options.edgeguard and options.corners)
        self.assertEqual(options.label, "names+corners+edgeguard")
        self.assertFalse(variants.parse(variants.DEFAULT_LABEL).edgeguard)
        self.assertFalse(variants.parse(variants.KEPT_LABEL).edgeguard)

    @unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
    def test_the_rows_exist(self):
        in_use = variants.IN_USE + "+edgeguard"
        kept = variants.KEPT_LABEL + "+edgeguard"
        self.assertIn(in_use, variants.COMPARE_LABELS)
        self.assertIn(kept, variants.COMPARE_LABELS)
        self.assertEqual(variants.compare_group(kept), "v14")
        self.assertEqual(variants.compare_title(kept), "Kept set + edgeguard")
        self.assertEqual(variants.compare_title(in_use), "In-use set (v9) + edgeguard")


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class TraceFlagTests(unittest.TestCase):
    def test_the_scan_result_carries_the_rejection_for_the_tip(self):
        from services import picture_first

        class Result:
            decision = None
            unsure_reason = "x"
            matches = []
            detection = {"rejected": {"edgeguard": True, "reason": "touches_edges"}}

        class Run:
            result = Result()
            elapsed_ms = 1
            input_info = {}

        self.assertEqual(picture_first._meta(Run(), "forced")["outline_rejected"], "touches_edges")
        Result.detection = {"rejected": {"reason": "too_small"}}
        self.assertNotIn("outline_rejected", picture_first._meta(Run(), "forced"))
