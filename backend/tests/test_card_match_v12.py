"""Matcher version 12 test: the two reading options ``widefirst`` and ``topname`` (off by default, comparison rows only), and the lab
numbers that go with them (name read, mean number time, where each set's number is first read). The version stays 11."""
import os
import sys
import threading
import types
import unittest

if os.name == "nt":  # api.recognize imports fcntl through the auth service; CI is Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

try:
    import numpy as np

    from services.card_match import MATCHER_VERSION, benchmark, names, ocr, ocr_check, pipeline, variants

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")

KEPT = "names+number+text+art+tta+fastread+numberonce+corners+wholepic+wholeread+wholestrict"
LINE = (lambda text, score=0.95, y0=0.0, y1=30.0: ocr.Line(text, score, 0.0, y0, 100.0, y1)) if DEPS_AVAILABLE else None
NUMBER_LINES = [LINE("30C", 0.9), LINE("061/128", 0.97)] if DEPS_AVAILABLE else []


class ScriptedReader(ocr.OcrReader if DEPS_AVAILABLE else object):
    """The real ladders and stopping rules; ``_scan`` answers from a table (label -> lines) and records the order it was asked in."""

    def __init__(self, table):
        self._lock = threading.Lock()
        self._whole = {}
        self.mode = "detect"
        self.table = table
        self.order = []

    def _scan(self, card, label, box, variant, zoom, low, record, flipped):
        self.order.append((label, variant))
        lines = list(self.table.get(label, []))
        record.append({"label": label, "box": list(box), "variant": variant, "zoom": zoom, "low": low, "flipped": flipped, "ms": 10.0,
                       "lines": [{"text": line.text, "score": line.score} for line in lines]})
        return lines


def card():
    return np.zeros((880, 630, 3), np.uint8)


@skip
class OptionTests(unittest.TestCase):
    def test_the_version_and_the_default_do_not_move(self):
        self.assertEqual(str(MATCHER_VERSION), "11")  # the phone matcher on nonprod refuses any other version
        options = variants.parse(variants.DEFAULT_LABEL)
        self.assertFalse(options.widefirst or options.topname)
        self.assertEqual(variants.DEFAULT_LABEL, variants.IN_USE)
        self.assertNotIn("widefirst", variants.DEFAULT_LABEL)

    def test_parsing_and_label_order(self):
        options = variants.parse(KEPT + "+topname+widefirst")
        self.assertTrue(options.widefirst and options.topname and options.wholestrict)
        self.assertEqual(options.label, KEPT + "+widefirst+topname")
        self.assertEqual(variants.parse(KEPT + "+widefirst").label, KEPT + "+widefirst")
        self.assertFalse(variants.parse(KEPT + "+widefirst").topname)
        self.assertEqual(variants.parse("baseline").label, "baseline")

    def test_the_comparison_rows(self):
        rows = variants.COMPARE_LABELS
        for label in (KEPT, KEPT + "+widefirst", KEPT + "+topname", KEPT + "+widefirst+topname"):
            self.assertIn(label, rows)
        for label in ("baseline", variants.IN_USE, variants.IN_USE + "+wholeread"):  # the old rows stay
            self.assertIn(label, rows)
        self.assertEqual(len(rows), len(set(rows)))
        for label in rows:  # every row round-trips through parse
            self.assertEqual(variants.parse(label).label, label)

    def test_a_new_row_can_win_and_be_chosen(self):
        def row(label, decided, wrong=0, p95=1400):
            return {"label": label, "status": "ok", "top1": 70, "top20": 99, "decided": decided, "decided_wrong": wrong, "p95_ms": p95}

        winner = benchmark.pick_winner([row(KEPT, 72.1), row(KEPT + "+widefirst", 73.0)])
        self.assertEqual(winner["label"], KEPT + "+widefirst")


@skip
class WideFirstTests(unittest.TestCase):
    def read(self, table, widefirst):
        reader = ScriptedReader(table)
        result = reader.read(card(), read_hp=False, flipped=False, fast=True, widefirst=widefirst)
        return reader, result

    def labels(self, reader):
        return [label for label, _variant in reader.order]

    def test_a_card_with_empty_tight_strips_goes_to_the_wide_bottom_early(self):
        table = {"bottom-wide": NUMBER_LINES}
        plain, plain_result = self.read(table, False)
        wide, wide_result = self.read(table, True)
        self.assertEqual(self.labels(plain)[-1], "bottom-wide")  # as before: last
        self.assertEqual(len(plain.order), 7)  # two tight, bottom band, two wide strips, bottom band clahe, then bottom-wide
        self.assertEqual(self.labels(wide), ["number-left-tight", "number-right-tight", "bottom-wide"])
        self.assertEqual((wide_result.number_local, wide_result.number_total), ("061", "128"))
        self.assertEqual((plain_result.number_local, plain_result.number_total), ("061", "128"))  # the same answer, fewer steps
        self.assertEqual(ocr.number_read_ms(wide_result.strips), 30.0)
        self.assertEqual(ocr.number_read_ms(plain_result.strips), 70.0)

    def test_when_the_wide_bottom_finds_no_text_the_sharp_and_contrast_steps_are_skipped(self):
        reader, result = self.read({}, True)
        self.assertEqual(reader.order, [("number-left-tight", "plain"), ("number-right-tight", "plain"), ("bottom-wide", "clahe"), ("bottom-band", "plain")])
        self.assertIsNone(result.number_local)
        plain, _ = self.read({}, False)
        self.assertEqual(len(plain.order), 7)  # the whole ladder ran: tight x2, band, wide x2, band clahe, bottom-wide

    def test_wide_text_without_a_number_carries_on_down_the_normal_ladder(self):
        reader, _ = self.read({"bottom-wide": [LINE("Illus. Someone")]}, True)
        self.assertEqual(self.labels(reader)[:3], ["number-left-tight", "number-right-tight", "bottom-wide"])
        self.assertIn(("number-left-wide", "sharp"), reader.order)
        self.assertEqual(self.labels(reader).count("bottom-wide"), 1)  # not read twice

    def test_a_normal_card_is_unaffected(self):
        table = {"number-left-tight": [LINE("018/091")], "number-right-tight": []}
        plain, plain_result = self.read(table, False)
        wide, wide_result = self.read(table, True)
        self.assertEqual(plain.order, wide.order)
        self.assertNotIn("bottom-wide", self.labels(wide))
        self.assertEqual(plain_result.number_local, wide_result.number_local)

    def test_tight_strips_that_found_other_text_also_read_as_before(self):
        table = {"number-left-tight": [LINE("Weakness")], "bottom-band": [LINE("061/128")]}
        plain, _ = self.read(table, False)
        wide, _ = self.read(table, True)
        self.assertEqual(plain.order, wide.order)

    def test_off_by_default(self):
        import inspect

        self.assertFalse(inspect.signature(ocr.OcrReader.read).parameters["widefirst"].default)
        self.assertFalse(inspect.signature(pipeline.CardMatcher.__init__).parameters["widefirst"].default)

    def test_the_other_stages_are_untouched(self):
        reader = ScriptedReader({"bottom-wide": NUMBER_LINES})
        reader.read(card(), read_hp=False, flipped=False, fast=True, stage="quick", budget=5.0, widefirst=True)
        self.assertEqual(self.labels(reader), ["number-left-tight", "number-right-tight", "bottom-band"])


@skip
class TopNameTests(unittest.TestCase):
    CATALOGUE = {"morpeko": 1.0, "morgrem": 1.0, "pikachu": 1.0}

    def check(self, name):
        key = name.casefold()
        return [(1.0, key)] if key in self.CATALOGUE else []

    def pick(self, lines):
        index = names.pick_top_line(lines, self.check)
        return lines[index] if index is not None else None

    def test_stage_word_name_and_hp_figure(self):
        self.assertEqual(self.pick(["BASIC", "Morpeko", "70"]), "Morpeko")

    def test_stage_one_with_hp_word(self):
        self.assertEqual(self.pick(["STAGE 1", "Morgrem", "90", "HP"]), "Morgrem")

    def test_nothing_but_a_stage_word_and_hp_gives_none(self):
        self.assertIsNone(self.pick(["ASIC", "70"]))
        self.assertIsNone(self.pick(["BASIC", "VSTAR", "HP", "70", "2", "C C"]))

    def test_a_name_the_catalogue_does_not_know_is_refused(self):
        self.assertIsNone(self.pick(["BASIC", "Zzyzx Qwrt", "70"]))
        self.assertIsNone(self.pick(["You may discard this card"]))  # not name-like even if known

    def test_the_tallest_agreeing_line_wins(self):
        items = [("Pikachu", 20.0), ("Morpeko", 45.0), ("70", 20.0)]
        self.assertEqual(items[names.pick_top_line(items, self.check)][0], "Morpeko")

    def read_name(self, table, topname):
        reader = ScriptedReader(table)
        read = reader.read_name(card(), fast=True, **({"topname": self.check} if topname else {}))
        return reader, read

    def test_empty_name_strips_take_the_name_from_the_top_band(self):
        table = {"top-wide": [LINE("BASIC", y1=20), LINE("Morpeko", y1=60), LINE("70", y1=60)]}
        reader, read = self.read_name(table, True)
        self.assertEqual(read.name, "Morpeko")
        self.assertEqual([label for label, _ in reader.order], ["name-line", "name-band", "top-wide"])

    def test_it_does_not_wait_for_the_time_the_normal_fallback_needs(self):
        table = {"top-wide": [LINE("Morpeko", y1=60)]}
        reader = ScriptedReader(table)
        original = ocr.time.monotonic
        ticks = iter(range(0, 1000, 5))
        ocr.time.monotonic = lambda: float(next(ticks))  # every look at the clock says a lot of time has passed
        try:
            slow = reader.read_name(card(), fast=True)
            reader.order.clear()
            reader._whole.clear()
            fast = reader.read_name(card(), fast=True, topname=self.check)
        finally:
            ocr.time.monotonic = original
        self.assertIsNone(slow.name)  # the normal fallback is behind the time gate
        self.assertEqual(fast.name, "Morpeko")

    def test_a_strip_that_detected_lines_keeps_the_normal_read(self):
        table = {"name-line": [LINE("Pikachu", y1=50)], "top-wide": [LINE("Morpeko", y1=60)]}
        reader, read = self.read_name(table, True)
        self.assertEqual(read.name, "Pikachu")
        self.assertNotIn("top-wide", [label for label, _ in reader.order])

    def test_ASIC_and_70_gives_no_name(self):
        _reader, read = self.read_name({"top-wide": [LINE("ASIC", y1=20), LINE("70", y1=30)]}, True)
        self.assertIsNone(read.name)

    def test_the_agreement_test_is_what_off_by_default_skips(self):
        table = {"top-wide": [LINE("Zzyzx Qwrt", y1=60)]}
        _reader, off = self.read_name(table, False)
        _reader, on = self.read_name(table, True)
        self.assertEqual(off.name, "Zzyzx Qwrt")  # the normal read takes any name-like line
        self.assertIsNone(on.name)

    def test_off_by_default_everywhere(self):
        import inspect

        self.assertIsNone(inspect.signature(ocr.OcrReader.read_name).parameters["topname"].default)
        self.assertFalse(inspect.signature(pipeline.CardMatcher.__init__).parameters["topname"].default)


@skip
class PipelineWiringTests(unittest.TestCase):
    class Recorder:
        def __init__(self):
            self.calls = []

        def read(self, card, **kwargs):
            self.calls.append(("read", kwargs))
            return ocr.parse_text([])

        def read_name(self, card, **kwargs):
            self.calls.append(("read_name", kwargs))
            return names.NameRead()

    def matcher(self, **flags):
        built = pipeline.CardMatcher.__new__(pipeline.CardMatcher)
        built.fastread, built.read_hp, built.widefirst, built.topname = True, False, False, False
        built.names = types.SimpleNamespace(score_names=lambda name: [(1.0, name)])
        built.ocr_reader = self.Recorder()
        for key, value in flags.items():
            setattr(built, key, value)
        return built

    def test_default_calls_are_as_before(self):
        built = self.matcher()
        built._read_text(card(), True, use_names=True)
        self.assertEqual(built.ocr_reader.calls[0], ("read", {"read_hp": False, "flipped": True, "fast": True}))
        self.assertEqual(built.ocr_reader.calls[1], ("read_name", {"flipped": True, "fast": True}))

    def test_the_options_are_passed_only_when_on(self):
        built = self.matcher(widefirst=True, topname=True)
        built._read_text(card(), True, use_names=True)
        read, name = built.ocr_reader.calls
        self.assertTrue(read[1]["widefirst"])
        self.assertTrue(callable(name[1]["topname"]))

    def test_topname_needs_the_name_index(self):
        built = self.matcher(topname=True, names=None)
        built._read_text(card(), True, use_names=False)
        self.assertEqual([call[0] for call in built.ocr_reader.calls], ["read"])


@skip
class LabNumbersTests(unittest.TestCase):
    def test_strip_kinds_and_number_time(self):
        self.assertEqual(ocr.strip_kind("name-band"), "name")
        self.assertEqual(ocr.strip_kind("top-wide"), "name")
        self.assertEqual(ocr.strip_kind("hp"), "hp")
        self.assertEqual(ocr.strip_kind("bottom-wide"), "number")
        self.assertEqual(ocr.strip_kind("whole-bottom-band"), "number")
        strips = [{"label": "number-left-tight", "ms": 100.0}, {"label": "bottom-wide", "ms": 800.0}, {"label": "name-line", "ms": 90.0}, {"label": "hp", "ms": 40.0}]
        self.assertEqual(ocr.number_read_ms(strips), 900.0)
        self.assertEqual(ocr.number_read_ms(None), 0.0)

    def test_compare_row_carries_name_read_and_number_time(self):
        metrics = {"n": 10, "top1_pct": 60, "top5_pct": 80, "top20_pct": 95, "number_exact_pct": 70, "decided_pct": 72.1, "decided_right_pct": 100,
                   "decided_wrong": 0, "name_read_pct": 88.5, "number_ms_mean": 640.2}
        row = benchmark.compare_row(KEPT + "+widefirst", {"metrics": metrics, "timings_ms": {"total": {"median": 900, "p95": 1400}}})
        self.assertEqual((row["name_read"], row["number_ms_mean"]), (88.5, 640.2))
        old = benchmark.compare_row("baseline", {"metrics": {k: v for k, v in metrics.items() if k not in ("name_read_pct", "number_ms_mean")}, "timings_ms": {}})
        self.assertEqual((old["name_read"], old["number_ms_mean"]), (None, None))  # a report from before this version still shows

    def test_name_read_is_the_confirmed_name(self):
        outcome = types.SimpleNamespace(ocr={"name": "Morpeko"})
        self.assertTrue(benchmark._name_read(outcome, "Morpeko"))
        self.assertFalse(benchmark._name_read(types.SimpleNamespace(ocr={"name": None}), "Morpeko"))
        self.assertIsNone(benchmark._name_read(types.SimpleNamespace(ocr={}), "Morpeko"))  # the name was not asked for
        self.assertIsNone(benchmark._name_read(outcome, None))

    def test_which_step_first_reads_each_sets_number(self):
        def strips(label, number):
            return [{"label": "number-left-tight", "after": {"number": None}, "flipped": False}, {"label": label, "after": {"number": number}, "flipped": False}]

        right = lambda after: after.get("number") == "061"  # noqa: E731
        acc = {}
        ocr_check.add_set_steps(acc, "30C", strips("bottom-wide", "061"), right, flipped=False)
        ocr_check.add_set_steps(acc, "30C", strips("bottom-wide", "061"), right, flipped=False)
        ocr_check.add_set_steps(acc, "30C", strips("bottom-band", "061"), right, flipped=False)
        ocr_check.add_set_steps(acc, "SV1", strips("number-right-tight", "061"), right, flipped=False)
        ocr_check.add_set_steps(acc, "SV1", strips("bottom-band", "999"), right, flipped=False)
        self.assertEqual(acc["30C"]["bottom_wide"], 2)
        self.assertEqual(acc["30C"]["bottom_band"], 1)
        self.assertEqual(acc["SV1"]["tight"], 1)
        self.assertEqual(acc["SV1"]["never"], 1)
        summary = ocr_check.summarise_set_steps(acc)
        self.assertEqual(summary["all"]["scans"], 5)
        self.assertEqual([row["set"] for row in summary["sets"]], ["30C"])  # SV1 has fewer than the minimum scans


if __name__ == "__main__":
    unittest.main()
