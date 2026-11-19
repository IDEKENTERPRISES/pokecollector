"""Matcher version 15 test: the option ``serverocr``, a stronger second try at the card number (PP-OCRv4 server models in a second
RapidOCR engine). Off by default, one comparison row. Scripted fake engines stand in for the models, as test_card_match_v12 does."""
import os
import sys
import types
import unittest
from unittest import mock

if os.name == "nt":  # api.recognize imports fcntl through the auth service; CI is Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

try:
    import numpy as np

    from services.card_match import benchmark, device, model_specs, ocr, ocr_server, pipeline, variants

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

PIN = "names+number+text+art+tta+fastread+numberonce+corners+wholepic+wholeread+widefirst+topname+edgeguard"
ROW = PIN + "+serverocr"
LINE = (lambda text, score=0.95: ocr.Line(text, score, 0.0, 0.0, 100.0, 30.0)) if DEPS_AVAILABLE else None


class ScriptedServer(ocr_server.ServerOcrReader if DEPS_AVAILABLE else object):
    """The real second-try code; ``_scan`` answers from a table (label -> lines) and records what it was asked. The name read must never be used."""

    def __init__(self, table):
        super().__init__()
        self.table = table
        self.asked = []

    def _scan(self, card, label, box, variant, zoom, low, record, flipped):
        self.asked.append((label, variant))
        lines = list(self.table.get(label, []))
        record.append({"label": label, "box": list(box), "variant": variant, "zoom": zoom, "low": low, "flipped": flipped, "ms": 40.0,
                       "lines": [{"text": line.text, "score": line.score} for line in lines]})
        return lines

    def read_name(self, *args, **kwargs):
        raise AssertionError("the second try must never read the name")


def card():
    return np.zeros((880, 630, 3), np.uint8)


def first_read(number=None, total=None, confidence=None):
    result = ocr.OcrResult(number_local=number, number_total=total, number_confidence=confidence, tokens=["SVI"], lines=["first"])
    result.strips = [{"label": "number-left-tight", "variant": "plain", "ms": 10.0}]
    result.attempts = 1
    result.number_source = ocr.SOURCE_FINDER_CARD if number else None
    return result


@skip
class OptionAndRowTests(unittest.TestCase):
    def test_the_option_word_parses_and_keeps_its_place(self):
        self.assertEqual(variants.V15_WORDS, ("serverocr",))
        options = variants.parse(ROW)
        self.assertTrue(options.serverocr and options.edgeguard and options.corners)
        self.assertEqual(options.label, ROW)  # the order of the words round-trips
        self.assertFalse(variants.parse(PIN).serverocr)
        self.assertFalse(variants.parse(variants.DEFAULT_LABEL).serverocr)  # off by default

    def test_exactly_one_new_row_built_on_the_set_in_use_not_the_v9_set(self):
        self.assertEqual(variants.NO_STRICT_LABEL + "+widefirst+topname+edgeguard+serverocr", ROW)
        self.assertEqual([label for label in variants.COMPARE_LABELS if "serverocr" in label], [ROW])
        self.assertTrue(ROW.startswith(variants.NO_STRICT_LABEL))
        self.assertEqual(len(set(variants.COMPARE_LABELS)), len(variants.COMPARE_LABELS))
        self.assertEqual(variants.compare_group(ROW), "v15")
        self.assertEqual(variants.compare_title(ROW), "Kept set without wholestrict + widefirst + topname + edgeguard + serverocr")
        self.assertEqual(variants.compare_group(PIN), "v14")  # the pin row stays where it was

    def test_the_matcher_takes_the_option(self):
        self.assertTrue(pipeline.CardMatcher(None, None, None, None, serverocr=True).serverocr)
        self.assertFalse(pipeline.CardMatcher(None, None, None, None).serverocr)

    def test_the_models_are_pinned_like_the_picture_models(self):
        self.assertEqual(set(model_specs.OCR_MODEL_SPECS), {"ocr-server-det", "ocr-server-rec"})
        for spec in model_specs.OCR_MODEL_SPECS.values():
            self.assertRegex(spec["url"], r"/resolve/[0-9a-f]{40}/")
            self.assertRegex(spec["sha256"], r"^[0-9a-f]{64}$")
            self.assertEqual(spec["license"], "Apache-2.0")
            self.assertGreater(spec["size_bytes"], 1_000_000)
        script = open(os.path.join(os.path.dirname(__file__), "..", "scripts", "fetch_card_match_models.py"), encoding="utf-8").read()
        self.assertIn("OCR_MODEL_SPECS", script)  # fetched at image build time with the others


@skip
class SecondTryTests(unittest.TestCase):
    def setUp(self):
        self.complete = {"number-left-tight": [LINE("SVI EN 058/102", 0.97)]}

    def test_an_incomplete_number_is_read_again_and_the_complete_one_is_merged(self):
        reader = ScriptedServer(self.complete)
        merged, info = reader.second_try(card(), first_read(number="058"), flipped=False)
        self.assertEqual((merged.number_local, merged.number_total), ("058", "102"))
        self.assertTrue(info["tried"] and info["complete"] and info["rescued"])
        self.assertEqual(info["number"], "058")
        self.assertGreaterEqual(info["ms"], 0.0)
        self.assertEqual(reader.asked[0], ("number-left-tight", "plain"))  # plain first
        labels = [strip["label"] for strip in merged.strips]
        self.assertIn("server-number-left-tight", labels)
        self.assertEqual(ocr.strip_kind("server-number-left-tight"), "number")
        self.assertTrue(all(strip.get("source") == "server_ocr" for strip in merged.strips if strip["label"].startswith("server-")))
        self.assertEqual(merged.number_source, ocr.SOURCE_FINDER_CARD)  # decided by the same rules as any read of the finder's card

    def test_it_stops_at_the_first_complete_number_and_runs_at_most_three_steps(self):
        reader = ScriptedServer(self.complete)
        reader.second_try(card(), first_read(), flipped=False)
        self.assertEqual(len(reader.asked), 1)  # the first strip already held a complete number
        nothing = ScriptedServer({})
        _merged, info = nothing.second_try(card(), first_read(), flipped=False)
        self.assertEqual(len(nothing.asked), 3)
        self.assertEqual([variant for _label, variant in nothing.asked], ["plain", "plain", "plain"])
        self.assertEqual((info["steps"], info["complete"], info["rescued"]), (3, False, False))

    def test_a_complete_first_read_is_never_read_again_or_replaced(self):
        reader = ScriptedServer({"number-left-tight": [LINE("999/888", 1.0)]})
        first = first_read("058", "102", 0.5)
        merged, info = reader.second_try(card(), first, flipped=False)
        self.assertIs(merged, first)
        self.assertFalse(info["tried"])
        self.assertEqual(reader.asked, [])
        self.assertEqual((merged.number_local, merged.number_total), ("058", "102"))

    def test_a_second_reading_that_is_not_more_complete_changes_nothing_but_the_record(self):
        reader = ScriptedServer({"number-left-tight": [LINE("SVI 077", 0.99)], "number-right-tight": [LINE("SVI 077", 0.99)]})
        first = first_read(number="058", confidence=0.4)
        merged, info = reader.second_try(card(), first, flipped=False)
        self.assertEqual((merged.number_local, merged.number_total), ("058", None))
        self.assertFalse(info["rescued"])
        self.assertTrue(any(strip["label"].startswith("server-") for strip in merged.strips))  # still recorded

    def test_a_failing_engine_leaves_the_first_reading_alone(self):
        reader = ScriptedServer({})
        with mock.patch.object(reader, "read", side_effect=RuntimeError("no engine")):
            first = first_read(number="058")
            merged, info = reader.second_try(card(), first, flipped=True)
        self.assertIs(merged, first)
        self.assertIn("no engine", info["error"])


class FakeServerReader:
    def __init__(self, number="058", total="102"):
        self.calls = []
        self.result = (number, total)

    def second_try(self, picture, previous, *, flipped):
        self.calls.append(flipped)
        second = ocr.OcrResult(number_local=self.result[0], number_total=self.result[1], number_confidence=0.9, tokens=["SVI"])
        second.strips = [{"label": "server-number-left-tight", "variant": "plain", "ms": 30.0}]
        merged = ocr.merge_reads(previous, second) if ocr.completeness(second) > ocr.completeness(previous) else previous
        return merged, {"tried": True, "steps": 1, "complete": ocr.is_complete(second), "rescued": ocr.is_complete(merged), "ms": 30.0, "number": second.number_local}


class FirstReader:
    def __init__(self, number=None, total=None):
        self.number, self.total = number, total

    def read(self, picture, **kwargs):
        result = ocr.OcrResult(number_local=self.number, number_total=self.total, number_confidence=0.9 if self.number else None, tokens=["SVI"])
        result.strips = [{"label": "number-left-tight", "variant": "plain", "ms": 10.0}]
        return result


class EmptyIndex:
    vectors = np.zeros((0, 4), np.float32) if DEPS_AVAILABLE else None
    card_ids: list = []
    row_of: dict = {}

    def __len__(self):
        return 0


class Embedder:
    def embed(self, views):
        return np.zeros((len(views), 4), np.float32)


def run_matcher(reader, **options):
    detection = types.SimpleNamespace(card=card(), found=True, confidence=0.9, method="contour", corners=[], hires=None, rejected=None)
    matcher = pipeline.CardMatcher(EmptyIndex(), Embedder(), lambda ids: {}, reader, **options)
    with mock.patch.object(pipeline.detect_module, "detect_card", return_value=detection):
        return matcher.match(np.zeros((300, 400, 3), np.uint8), flat_card=card())


@skip
class MatcherTests(unittest.TestCase):
    def setUp(self):
        device.reset_for_tests()
        self.addCleanup(device.reset_for_tests)

    def test_off_means_untouched_the_server_engine_is_never_built_and_results_are_identical(self):
        with mock.patch.object(ocr_server, "get_server_reader", side_effect=AssertionError("built")), \
                mock.patch.object(ocr_server.ServerOcrReader, "__init__", side_effect=AssertionError("constructed")):
            plain = run_matcher(FirstReader("058"))
            also_plain = run_matcher(FirstReader("058"), serverocr=False)
        self.assertNotIn("serverocr", plain.ocr)
        self.assertEqual(plain.ocr, also_plain.ocr)
        self.assertEqual((plain.status, plain.unsure_reason), (also_plain.status, also_plain.unsure_reason))
        self.assertIsNone(ocr_server._reader)
        self.assertEqual(device.report()["ocr_server"], {"loaded": False, "label": "Not loaded yet"})

    def test_on_with_a_complete_first_read_the_second_try_does_not_run(self):
        server = FakeServerReader()
        result = run_matcher(FirstReader("058", "102"), serverocr=True, server_reader=server)
        self.assertEqual(server.calls, [])
        self.assertNotIn("serverocr", result.ocr)
        self.assertEqual((result.ocr["number_local"], result.ocr["number_total"]), ("058", "102"))

    def test_on_with_an_incomplete_first_read_the_second_try_runs_and_its_number_is_merged(self):
        server = FakeServerReader()
        result = run_matcher(FirstReader("058"), serverocr=True, server_reader=server)
        self.assertEqual(len(server.calls), 1)
        self.assertEqual((result.ocr["number_local"], result.ocr["number_total"]), ("058", "102"))
        self.assertTrue(result.ocr["serverocr"]["tried"] and result.ocr["serverocr"]["rescued"])
        self.assertEqual(result.ocr["serverocr"]["ms"], 30.0)
        self.assertIn("server-number-left-tight", [strip["label"] for strip in result.ocr["strips"]])
        self.assertEqual(result.ocr["number_source"], ocr.SOURCE_FINDER_CARD)

    def test_a_second_try_with_nothing_found_keeps_the_first_reading(self):
        server = FakeServerReader(number=None, total=None)
        result = run_matcher(FirstReader("058"), serverocr=True, server_reader=server)
        self.assertEqual((result.ocr["number_local"], result.ocr["number_total"]), ("058", None))
        self.assertFalse(result.ocr["serverocr"]["rescued"])

    def test_missing_model_files_never_fail_the_scan(self):
        with mock.patch.object(ocr_server, "models_available", return_value=False):
            result = run_matcher(FirstReader("058"), serverocr=True)
        self.assertEqual(result.ocr["number_local"], "058")
        self.assertIn("model files", result.ocr["serverocr"]["error"])


class FakeSession:
    def __init__(self, providers):
        self._providers = providers

    def get_providers(self):
        return self._providers


class FakeOrt:
    def get_available_providers(self):
        return [device.CUDA, device.CPU]

    def InferenceSession(self, path, sess_options=None, providers=None):
        first = providers[0][0] if isinstance(providers[0], tuple) else providers[0]
        return FakeSession([device.CUDA, device.CPU] if first == device.CUDA else [device.CPU])


@skip
class GpuBudgetTests(unittest.TestCase):
    def setUp(self):
        device.reset_for_tests()
        patcher = mock.patch.dict("os.environ", {"CARD_MATCH_DEVICE": "auto", "CARD_MATCH_GPU_MEM_MB": "1024"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(device.reset_for_tests)

    def test_the_server_models_take_the_same_shares_as_the_mobile_ones(self):
        for name in ("ch_PP-OCRv4_det_server_infer.onnx", "ch_PP-OCRv4_rec_server_infer.onnx"):
            self.assertEqual(device.ocr_share("/models/" + name), 0.35)

    def test_with_the_budget_used_up_the_server_sessions_run_on_the_cpu_with_a_reason(self):
        ort = FakeOrt()
        # What the picture model and the mobile OCR hold: 0.2 + 0.35 + 0.35 + 0.03 = 0.93 of the 1 GB budget.
        used = [device.create_session(ort, "m.onnx", None, kind="embedder:x", share=device.EMBEDDER_SHARE)[1]]
        for share in (0.35, 0.35, 0.03):
            used.append(device.create_session(ort, "m.onnx", None, kind="ocr-part", share=share)[1])
        self.assertTrue(all(info["device"] == "cuda" for info in used))
        before = device._granted_mb
        infos = [device.create_session(ort, f"/models/ch_PP-OCRv4_{part}_server_infer.onnx", None, kind="ocr-server-part",
                                       share=device.ocr_share(f"/models/ch_PP-OCRv4_{part}_server_infer.onnx"))[1] for part in ("det", "rec")]
        self.assertEqual([info["device"] for info in infos], ["cpu", "cpu"])
        self.assertTrue(all("budget" in info["reason"] for info in infos))
        self.assertEqual(device._granted_mb, before)  # nothing more was taken from the budget
        summary = device.summarise_ocr(infos, "ocr-server")
        self.assertEqual((summary["device"], summary["granted_mb"]), ("cpu", 0.0))
        view = device.report()["ocr_server"]
        self.assertEqual((view["device"], view["label"]), ("cpu", "CPU"))
        self.assertIn("budget", view["reason"])
        self.assertEqual(device.budget_mb(), 1024)  # the budget itself is not raised

    def test_the_engine_is_built_lazily_and_idle_unload_knows_it(self):
        from services.card_match import lifecycle

        lifecycle.reset_for_tests()
        reader = ocr_server.ServerOcrReader()
        self.assertIsNone(reader.engine)  # nothing built, nothing taken from the GPU
        self.assertEqual(device._granted_mb, 0.0)
        self.assertFalse(reader.unload())
        self.assertIn(reader, list(lifecycle._registered))
        self.assertEqual(reader.kind, "ocr-server")
        self.assertEqual(ocr.OcrReader.kind, "ocr")  # the normal reader's status name did not change


@skip
class ReportTests(unittest.TestCase):
    def test_the_report_counts_the_second_tries(self):
        tries = [{"complete": True, "rescued": True, "ms": 400.0, "device": "cpu"}, {"complete": False, "rescued": False, "ms": 900.0},
                 {"complete": True, "rescued": True, "ms": 500.0}]
        summary = benchmark.serverocr_summary(tries)
        self.assertEqual((summary["ran"], summary["complete"], summary["median_ms"], summary["p95_ms"]), (3, 2, 500.0, 900.0))
        self.assertEqual(summary["device"], "cpu")
        self.assertIsNone(benchmark.serverocr_summary([]))  # option off, or every first read complete: no figures

    def test_the_compare_row_carries_them(self):
        report = {"metrics": {"n": 3, "top1_pct": 1, "top5_pct": 1, "top20_pct": 1, "number_exact_pct": 1, "decided_pct": 1, "decided_right_pct": 100,
                              "decided_wrong": 0, "serverocr": {"ran": 2, "complete": 1}}, "timings_ms": {}}
        self.assertEqual(benchmark.compare_row(ROW, report)["serverocr"], {"ran": 2, "complete": 1})


if __name__ == "__main__":
    unittest.main()
