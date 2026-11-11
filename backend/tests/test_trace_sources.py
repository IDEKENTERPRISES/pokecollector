"""Read-only scan-diagnostics roots (SCAN_TRACE_READONLY_DIRS): prod's scans read by the test stack's Scanner lab.

Everything here uses temporary folders. The guarantees under test: scans of two roots with the same ids stay separate; a missing or
unreadable root changes nothing; nothing ever writes to, renames in or deletes from a read-only root; the held-back split is stable
and about 30%; held-back scans never reach a pick; another stack's scans are never looked up in the local database; the pictures made
from a deleted scan go away."""
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

if os.name == "nt":  # api.recognize imports fcntl through the auth service; CI is Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

try:
    import cv2
    import numpy as np

    from services import scan_trace, trace_sources
    from services.card_match import benchmark, misses, ocr_check

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip = unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")


def jpeg() -> bytes:
    ok, buffer = cv2.imencode(".jpg", np.full((60, 40, 3), 128, dtype=np.uint8))
    return buffer.tobytes()


def make_trace(root: Path, user: int, day: str, stem: str, *, job=1, item=1, truth="swsh1-1", created="2026-11-12T10:00:00+00:00", confirmed=True) -> Path:
    folder = root / f"user-{user}" / day
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{stem}.jpg").write_bytes(jpeg())
    data = {"user_id": user, "job_id": job, "item_id": item, "image_file": f"{stem}.jpg", "created_at": created}
    if confirmed:
        data["ground_truth"] = truth
    (folder / f"{stem}.json").write_text(json.dumps(data), encoding="utf-8")
    return folder / f"{stem}.json"


def snapshot(root: Path) -> dict:
    """Every file under ``root`` with its content and modification time, and every folder: any change shows."""
    out = {}
    for path in sorted(root.rglob("*")):
        rel = str(path.relative_to(root))
        out[rel] = (path.read_bytes(), path.stat().st_mtime_ns) if path.is_file() else "dir"
    return out


class Env:
    """Set environment variables for a test and restore them."""

    def __init__(self, **values):
        self.values = values
        self.patcher = None

    def __enter__(self):
        self.patcher = patch.dict(os.environ, {k: v for k, v in self.values.items()})
        self.patcher.start()
        return self

    def __exit__(self, *exc):
        self.patcher.stop()


@skip
class ParsingTests(unittest.TestCase):
    def test_entries_and_bad_entries(self):
        roots = trace_sources.parse_roots("prod=/app/data/a, Other=/b ; local=/c\nprod=/dup,noequals,=/x,bad label=/y,empty=")
        self.assertEqual([(r.label, r.path) for r in roots], [("prod", Path("/app/data/a")), ("other", Path("/b"))])
        self.assertEqual(trace_sources.parse_roots(None), [])
        self.assertEqual(trace_sources.parse_roots(""), [])

    def test_overlap_with_the_local_root_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "local"
            local.mkdir()
            with Env(SCAN_TRACE_READONLY_DIRS=f"same={local},inside={local / 'sub'},other={Path(tmp) / 'other'}"):
                self.assertEqual([r.label for r in trace_sources.usable_roots(local)], ["other"])


@skip
class HeldBackSplitTests(unittest.TestCase):
    def test_stable_and_about_thirty_percent(self):
        path = Path("user-1/2026-11-12/x.json")
        held = [trace_sources.hold_back("prod", {"user_id": u, "job_id": j, "item_id": j * 3}, path) for u in range(1, 21) for j in range(1, 101)]
        again = [trace_sources.hold_back("prod", {"user_id": u, "job_id": j, "item_id": j * 3}, path) for u in range(1, 21) for j in range(1, 101)]
        self.assertEqual(held, again)
        self.assertEqual(trace_sources.HELD_BACK_FRACTION, 0.30)
        share = sum(held) / len(held)
        self.assertTrue(0.27 <= share <= 0.33, share)

    def test_a_scan_keeps_its_side_across_attempts_and_a_new_scan_does_not_move_it(self):
        first = trace_sources.hold_back("prod", {"user_id": 4, "job_id": 9, "item_id": 2}, Path("user-4/2026-11-12/attempt-a.json"))
        second = trace_sources.hold_back("prod", {"user_id": 4, "job_id": 9, "item_id": 2}, Path("user-4/2026-11-13/attempt-b.json"))
        self.assertEqual(first, second)

    def test_the_source_is_part_of_the_identity(self):
        sides = {trace_sources.hold_back(label, {"user_id": 1, "job_id": j, "item_id": 1}, Path("a/b/c.json")) for label in ("prod", "other") for j in range(40)}
        self.assertEqual(sides, {True, False})
        differs = [trace_sources.hold_back("prod", {"user_id": 1, "job_id": j, "item_id": 1}, Path("a/b/c.json")) != trace_sources.hold_back("other", {"user_id": 1, "job_id": j, "item_id": 1}, Path("a/b/c.json")) for j in range(60)]
        self.assertTrue(any(differs))


@skip
class LabelledTraceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.local, self.prod = Path(self.tmp.name) / "local", Path(self.tmp.name) / "prod"
        self.local.mkdir()
        self.prod.mkdir()

    def roots(self, *entries):
        return [trace_sources.ReadOnlyRoot(label, path) for label, path in entries]

    def test_two_roots_with_colliding_ids_stay_separate(self):
        make_trace(self.local, 1, "2026-11-01", "a", job=1, item=1, truth="swsh1-1")
        make_trace(self.prod, 1, "2026-11-12", "a", job=1, item=1, truth="swsh1-2")
        found = ocr_check.labelled_traces(self.local, self.roots(("prod", self.prod)))
        self.assertEqual(len(found), 2)
        by_source = {trace_sources.source_of(data): data["ground_truth"] for data, _path in found}
        self.assertEqual(by_source, {"local": "swsh1-1", "prod": "swsh1-2"})
        info = ocr_check.trainers_by_group(found)
        self.assertEqual(info["local"]["trainers"], 1)
        self.assertEqual(sum(info[g]["scans"] for g in info if g != "local"), 1)
        self.assertEqual(ocr_check.labelled_traces(self.local, []), [found[0]] if trace_sources.source_of(found[0][0]) == "local" else [found[1]])

    def test_local_traces_are_not_tagged_and_never_held_back(self):
        make_trace(self.local, 1, "2026-11-01", "a")
        (data, _path), = ocr_check.labelled_traces(self.local, self.roots(("prod", self.prod)))
        self.assertNotIn(trace_sources.SOURCE_KEY, data)
        self.assertFalse(trace_sources.is_held_back(data))
        self.assertEqual(trace_sources.group_of(data), "local")

    def test_missing_unreadable_or_odd_roots_change_nothing(self):
        make_trace(self.local, 1, "2026-11-01", "a")
        baseline = ocr_check.labelled_traces(self.local, [])
        missing = trace_sources.ReadOnlyRoot("prod", Path(self.tmp.name) / "nothing-here")
        self.assertEqual(ocr_check.labelled_traces(self.local, [missing]), baseline)
        afile = Path(self.tmp.name) / "afile"
        afile.write_text("x", encoding="utf-8")
        self.assertEqual(ocr_check.labelled_traces(self.local, [trace_sources.ReadOnlyRoot("prod", afile)]), baseline)
        with patch.object(Path, "glob", side_effect=PermissionError("denied")):
            self.assertEqual(ocr_check.labelled_traces(None, [missing]), [])

    def test_half_written_and_odd_files_in_a_read_only_root_are_skipped(self):
        good = make_trace(self.prod, 2, "2026-11-12", "good", job=5, item=5)
        (self.prod / "user-2" / "2026-11-12" / "half.json").write_text('{"ground_truth": "swsh1-1", "image_fi', encoding="utf-8")
        (self.prod / "user-2" / "2026-11-12" / "list.json").write_text("[1, 2]", encoding="utf-8")
        (self.prod / "user-2" / "2026-11-12" / "noimage.json").write_text(json.dumps({"ground_truth": "swsh1-1", "image_file": "gone.jpg", "job_id": 1, "item_id": 1}), encoding="utf-8")
        (self.prod / "user-2" / "2026-11-12" / "escape.json").write_text(json.dumps({"ground_truth": "swsh1-1", "image_file": "../2026-11-12/good.jpg", "job_id": 2, "item_id": 2}), encoding="utf-8")
        make_trace(self.prod, 2, "2026-11-12", "unconfirmed", job=6, item=6, confirmed=False)
        found = ocr_check.labelled_traces(None, self.roots(("prod", self.prod)))
        self.assertEqual([path for _data, path in found], [good])

    def test_reading_changes_nothing_in_either_root(self):
        make_trace(self.prod, 2, "2026-11-12", "a")
        before = snapshot(self.prod)
        ocr_check.labelled_traces(self.local, self.roots(("prod", self.prod)))
        trace_sources.source_status(trace_sources.ReadOnlyRoot("prod", self.prod))
        self.assertEqual(snapshot(self.prod), before)

    def test_source_status_in_plain_words(self):
        make_trace(self.prod, 2, "2026-11-12", "a", created="2026-11-12T08:00:00+00:00")
        make_trace(self.prod, 2, "2026-11-13", "b", job=2, item=2, created="2026-11-13T09:30:00+00:00", confirmed=False)
        status = trace_sources.source_status(trace_sources.ReadOnlyRoot("prod", self.prod))
        self.assertEqual((status["readable"], status["scans"], status["confirmed"], status["newest"]), (True, 2, 1, "2026-11-13"))
        gone = trace_sources.source_status(trace_sources.ReadOnlyRoot("prod", Path(self.tmp.name) / "nope"))
        self.assertFalse(gone["readable"])
        self.assertIn("not there", gone["reason"])
        with patch.object(trace_sources.os, "scandir", side_effect=PermissionError("denied")):
            denied = trace_sources.source_status(trace_sources.ReadOnlyRoot("prod", self.prod))
        self.assertFalse(denied["readable"])
        self.assertIn("permission", denied["reason"])
        self.assertEqual(denied["scans"], 0)


@skip
class NothingWritesToAReadOnlyRootTests(unittest.TestCase):
    """Even when a read-only root is also configured as a writable one (a mistake in the compose file), nothing lands in it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.prod = Path(self.tmp.name) / "prod"
        old = make_trace(self.prod, 7, "2020-01-01", "old", job=3, item=3, confirmed=False)
        make_trace(self.prod, 7, "2026-11-12", "new", job=4, item=4, confirmed=False)
        shadow = self.prod / "user-7" / "shadow"
        shadow.mkdir()
        (shadow / "job3-item3.shadow").write_text("{}", encoding="utf-8")
        (shadow / "job4-item4.card.jpg").write_bytes(jpeg())
        os.utime(shadow / "job3-item3.shadow", (1_000_000_000, 1_000_000_000))
        self.old = old
        self.env = Env(SCAN_TRACE_READONLY_DIRS=f"prod={self.prod}", SCAN_TRACE_DIR=str(self.prod), SCAN_TRACE_STORAGE_DIR=str(self.prod),
                       SCAN_TRACE_KEEP_DAYS="30")
        self.env.__enter__()
        self.addCleanup(self.env.__exit__)
        self.before = snapshot(self.prod)

    def test_ensure_writable_refuses_the_root_and_anything_in_it(self):
        for path in (self.prod, self.prod / "user-7", self.prod / "user-7" / "x.json", self.prod / ".revoked-user-7", self.prod / "a" / ".." / "b"):
            with self.assertRaises(trace_sources.ReadOnlyTraceRoot):
                trace_sources.ensure_writable(path)
        trace_sources.ensure_writable(Path(self.tmp.name) / "elsewhere" / "x.json")
        trace_sources.ensure_writable(Path(self.tmp.name) / "prod-other" / "x.json")  # a sibling with the same prefix is not inside

    def test_no_writer_or_deleter_touches_it(self):
        self.assertEqual(scan_trace._cleanup_roots(), [])
        self.assertEqual(scan_trace.record_ground_truth(7, 4, 4, "swsh1-1"), 0)
        self.assertFalse(scan_trace.record_shadow(7, 4, 4, {"status": "ok"}))
        self.assertFalse(scan_trace.record_shadow_card(7, 4, 4, jpeg()))
        self.assertEqual(scan_trace.purge_old_traces(), {"scans": 0, "shadow_files": 0})
        self.assertEqual(scan_trace.purge_old_traces(1), {"scans": 0, "shadow_files": 0})
        self.assertEqual(scan_trace.delete_user_traces(7), {"traces": 0, "images": 0})
        scan_trace.clear_user_trace_revocation(7)
        try:
            scan_trace.revoke_user_traces(7)
        except Exception:
            pass
        self.assertEqual(snapshot(self.prod), self.before)

    def test_the_low_level_helpers_refuse_it(self):
        with self.assertRaises(trace_sources.ReadOnlyTraceRoot):
            scan_trace._write_private(self.prod / "user-7" / "new.json", "{}")
        with self.assertRaises(trace_sources.ReadOnlyTraceRoot):
            scan_trace._ensure_private_dir(self.prod / "user-9")
        with self.assertRaises(trace_sources.ReadOnlyTraceRoot):
            scan_trace._delete_user_dir(self.prod, 7)
        self.assertEqual(snapshot(self.prod), self.before)

    def test_a_trace_save_with_the_root_misconfigured_writes_nothing(self):
        trace = scan_trace.ScanTrace(enabled=True, user_id=7, mode="single", job_id=11, item_id=11)
        try:
            trace.save()
        except Exception:
            pass
        self.assertEqual(snapshot(self.prod), self.before)

    def test_the_lab_readers_and_the_misses_cleanup_leave_it_alone(self):
        make_trace(self.prod, 7, "2026-11-12", "conf", job=8, item=8)
        before = snapshot(self.prod)
        found = ocr_check.labelled_traces(None)
        self.assertEqual(len(found), 1)
        data_dir = Path(self.tmp.name) / "data"
        run = data_dir / "misses" / "run-1"
        run.mkdir(parents=True)
        for suffix in ("photo", "card", "photo-full", "card-full"):
            (run / f"prod-gone-{suffix}.jpg").write_bytes(b"x")
        report = {"created_at": "x", "matcher_version": "9", "scans": 1, "misses": 1, "tags": {}, "counts": {}, "run": "run-1",
                  "items": [{"key": "prod-gone", "trace": "gone.json", "source": "prod", "trace_rel": "user-7/2026-11-12/gone.json", "kind": "not_top1",
                             "tags": ["other"], "primary": "other", "decided_wrong": False}]}
        (data_dir / "misses" / "latest.json").write_text(json.dumps(report), encoding="utf-8")
        self.assertEqual(misses.purge_vanished(data_dir), 1)
        self.assertEqual(snapshot(self.prod), before)


@skip
class ReviewPhotoTests(unittest.TestCase):
    def test_skipped_for_a_prod_trace_and_kept_for_a_local_one(self):
        local = {"item_id": 5}
        prod = {"item_id": 5, trace_sources.SOURCE_KEY: "prod"}
        factory = lambda: (_ for _ in ()).throw(AssertionError("the database must not be touched"))  # noqa: E731
        self.assertIsNone(benchmark.review_photo_loader(factory, prod))
        self.assertTrue(callable(benchmark.review_photo_loader(factory, local)))
        self.assertIsNone(benchmark.review_photo_loader(factory, {"item_id": None}))


class FakeOutcome(SimpleNamespace):
    pass


class FakeMatcher:
    """Answers every photo with the first card; records whether it was given a review photo."""

    label = "fake"

    def __init__(self, ids):
        self.index = SimpleNamespace(card_ids=[f"{i}_en" for i in ids], model="fake")
        self.calls = []

    def match(self, photo, flat_card=None, review_photo=None):
        self.calls.append(review_photo)
        top = self.index.card_ids[0]
        match = {"card_id": top, "tcg_card_id": top[:-3], "rank": 1, "number": "1", "name": "Card", "similarity": 0.9}
        return FakeOutcome(detection={"found": True}, matches=[match], decision={"card_id": top, "tcg_card_id": top[:-3], "mechanism": "picture"},
                           ocr={"number_local": "1"}, unsure_reason=None, timings_ms={"total": 10.0})


@skip
class RunLabelledGroupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.local, self.prod = Path(self.tmp.name) / "local", Path(self.tmp.name) / "prod"
        self.local.mkdir()
        make_trace(self.local, 1, "2026-10-01", "mine", job=1, item=1, truth="swsh1-1")
        for n in range(1, 41):  # prod scans with ids that collide with the local ones
            make_trace(self.prod, 1 + n % 4, "2026-11-12", f"p{n}", job=1, item=n, truth="swsh1-1" if n % 2 else "swsh1-9")
        self.env = Env(SCAN_TRACE_READONLY_DIRS=f"prod={self.prod}")
        self.env.__enter__()
        self.addCleanup(self.env.__exit__)

    def run_it(self, **kwargs):
        matcher = FakeMatcher(["swsh1-1"])
        with patch.object(benchmark, "index_status", return_value={}), patch.object(benchmark, "rss_mb", return_value=None):
            report = benchmark.run_labelled(lambda: None, matcher, trace_dir=self.local, corners_check=False, **kwargs)
        return report, matcher

    def test_groups_headline_and_review_photos(self):
        report, matcher = self.run_it()
        groups = report["by_group"]
        held, tuning = groups["prod_held_back"]["n"], groups["prod_tuning"]["n"]
        self.assertEqual(groups["local"]["n"], 1)
        self.assertEqual(held + tuning, 20)  # the 20 prod scans whose card is English and indexed
        self.assertGreater(held, 0)
        self.assertGreater(tuning, 0)
        self.assertEqual(report["metrics"]["n"], 1 + tuning)  # the headline leaves the held-back ones out
        self.assertLessEqual(groups["prod_tuning"]["trainers"], 4)
        self.assertEqual(groups["local"]["trainers"], 1)
        self.assertEqual(groups["prod_held_back"]["label"], "From prod: held back")
        self.assertEqual(groups["prod_tuning"]["label"], "From prod: for tuning")
        self.assertNotIn("user", json.dumps(report["by_group"]))
        # Today's groups are the owner's own scans only (one scan, made after the new-scan date; prod's 40 are not in them).
        self.assertEqual(report["by_scan_time"]["new"]["n"], 1)
        self.assertIsNone(report["by_scan_time"]["tuning"])
        self.assertEqual(report["fallback"]["found_on_photo"]["n"], 1)
        # no review photo was asked for for any prod scan (the first call is the local scan, sorted first)
        self.assertEqual(len(matcher.calls), groups["local"]["n"] + held + tuning)

    def test_skip_and_only(self):
        skipped, _ = self.run_it(held_back="skip")
        self.assertNotIn("prod_held_back", skipped["by_group"])
        only, _ = self.run_it(held_back="only")
        self.assertEqual(list(only["by_group"]), ["prod_held_back"])
        self.assertEqual(only["metrics"]["n"], only["by_group"]["prod_held_back"]["n"])
        both, _ = self.run_it()
        self.assertEqual(skipped["by_group"]["prod_tuning"]["n"] + only["by_group"]["prod_held_back"]["n"] + 1, both["metrics"]["n"] + both["by_group"]["prod_held_back"]["n"])

    def test_the_misses_collector_never_gets_a_held_back_scan(self):
        class Collector:
            def __init__(self):
                self.added = []

            def add(self, **kwargs):
                self.added.append(kwargs)

            def finish(self, label=""):
                pass

        collector = Collector()
        report, _ = self.run_it(collector=collector)
        sources = {(a["source"], a["trace"]) for a in collector.added}
        self.assertEqual(len(collector.added), 1 + report["by_group"]["prod_tuning"]["n"])
        held = {path.name for data, path in ocr_check.labelled_traces(self.local) if trace_sources.is_held_back(data)}
        self.assertTrue(held)
        self.assertFalse({trace for _source, trace in sources} & held)
        self.assertTrue(all(a["trace_rel"].count("/") == 2 for a in collector.added))


@skip
class PickIgnoresHeldBackTests(unittest.TestCase):
    def test_compare_runs_without_the_held_back_scans_and_measures_them_once_for_the_winner(self):
        calls = []

        def fake_run_labelled(session_factory, matcher, **kwargs):
            calls.append((matcher.label, kwargs.get("held_back")))
            n = 5 if kwargs.get("held_back") == "only" else 10
            return {"metrics": {"n": n, "top1_pct": 80, "top5_pct": 90, "top20_pct": 95, "number_exact_pct": 70, "decided_pct": 60,
                                "decided_right_pct": 99, "decided_wrong": 0}, "timings_ms": {"total": {"median": 100, "p95": 200}}, "memory": {}, "host": {}}

        fake_variants = SimpleNamespace(
            parse=lambda label: label, missing_indexes=lambda options, data_dir: [],
            build_matcher=lambda options, factory, data_dir=None, ocr_reader=None: SimpleNamespace(label=options),
        )
        held = {"user_id": 1, "job_id": 1, "item_id": 1, trace_sources.SOURCE_KEY: "prod", trace_sources.HELD_BACK_KEY: True}
        tuning = {"user_id": 2, "job_id": 1, "item_id": 2, trace_sources.SOURCE_KEY: "prod", trace_sources.HELD_BACK_KEY: False}
        with patch("services.card_match.variants.parse", fake_variants.parse), \
                patch("services.card_match.variants.missing_indexes", fake_variants.missing_indexes), \
                patch("services.card_match.variants.build_matcher", fake_variants.build_matcher), \
                patch.object(benchmark, "run_labelled", fake_run_labelled), \
                patch.object(ocr_check, "labelled_traces", return_value=[(held, Path("a")), (tuning, Path("b"))]):
            report = benchmark.run_compare("labelled", lambda: None, ["plain", "other"], trace_dir=None)
        self.assertEqual([held_back for _label, held_back in calls[:2]], ["skip", "skip"])
        self.assertEqual(calls[2], (report["winner"], "only"))
        self.assertEqual(len(calls), 3)
        self.assertEqual(report["held_back"]["n"], 5)
        self.assertEqual(report["rows"][0]["n"], 10)
        self.assertIn("held back", report["held_back_note"])
        self.assertEqual(report["groups"]["prod_held_back"]["scans"], 1)

    def test_without_prod_scans_nothing_changes(self):
        calls = []

        def fake_run_labelled(session_factory, matcher, **kwargs):
            calls.append(kwargs.get("held_back"))
            return {"metrics": {"n": 3, "top1_pct": 80, "top5_pct": 90, "top20_pct": 95, "number_exact_pct": 70, "decided_pct": 60,
                                "decided_right_pct": 99, "decided_wrong": 0}, "timings_ms": {}, "memory": {}, "host": {}}

        with patch("services.card_match.variants.parse", lambda label: label), patch("services.card_match.variants.missing_indexes", lambda o, d: []), \
                patch("services.card_match.variants.build_matcher", lambda o, f, data_dir=None, ocr_reader=None: SimpleNamespace(label=o)), \
                patch.object(benchmark, "run_labelled", fake_run_labelled), \
                patch.object(ocr_check, "labelled_traces", return_value=[({"user_id": 1}, Path("a"))]):
            report = benchmark.run_compare("labelled", lambda: None, ["plain"], trace_dir=None)
        self.assertEqual(calls, ["skip"])
        self.assertIsNone(report["held_back"])
        self.assertIsNone(report["held_back_note"])


@skip
class OcrCheckGroupTests(unittest.TestCase):
    def test_groups_are_tallied_apart_and_local_keeps_the_old_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            local, prod = Path(tmp) / "local", Path(tmp) / "prod"
            local.mkdir()
            make_trace(local, 1, "2026-10-01", "mine", job=1, item=1)
            for n in range(1, 21):
                make_trace(prod, 3, "2026-11-12", f"p{n}", job=1, item=n)
            result = SimpleNamespace(number_local="1", number_total="102", lines=["1/102"], strips=[], flipped=False, seconds=0.1, number_confidence=0.9,
                                     as_card_info=lambda abbreviations: {"set_code": "SWSH1"})
            truth = {"name": "Card", "number": "1", "printed_total": "102", "set_abbreviation": "SWSH1"}
            card = np.zeros((880, 630, 3), dtype=np.uint8)
            with Env(SCAN_TRACE_READONLY_DIRS=f"prod={prod}"), \
                    patch.object(ocr_check, "read_both", return_value=(result, "Card", 0.1, [])), \
                    patch.object(ocr_check, "read_variant", return_value=None), \
                    patch.object(ocr_check, "whole_second_read", return_value=(result, False)), \
                    patch("services.card_match.benchmark.load_stored_card", return_value=card), \
                    patch("services.card_match.pipeline.db_candidate_loader", return_value=lambda ids: {ids[0]: truth}), \
                    patch("services.card_match.misses.card_stats", return_value={"glare": 0.0, "mean": 120.0, "sharpness": 100.0}):
                report = ocr_check.run_ocr_check(lambda: None, object(), trace_dir=local)
            self.assertEqual(report["traces"], 21)
            self.assertEqual(report["by_resolution"]["all"]["detect"]["n"], 1)  # the owner's own scan only, as before
            self.assertEqual(set(report["groups"]), {"prod_held_back", "prod_tuning"})
            counted = sum(report["groups"][g]["by_resolution"]["all"]["detect"]["n"] for g in report["groups"])
            self.assertEqual(counted, 20)
            self.assertEqual(report["group_info"]["prod_tuning"]["trainers"], 1)
            self.assertEqual(report["group_info"]["local"]["scans"], 1)


@skip
class MissesFollowTheirScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.prod, self.local, self.data = base / "prod", base / "local", base / "data"
        self.local.mkdir()
        self.live = make_trace(self.prod, 5, "2026-11-12", "live")
        self.gone = self.prod / "user-5" / "2026-11-12" / "gone.json"  # deleted on prod: not there
        run = self.data / "misses" / "run-1"
        run.mkdir(parents=True)
        items = []
        for key, name in (("prod-live", "live"), ("prod-gone", "gone")):
            for suffix in ("photo", "card", "photo-full", "card-full"):
                (run / f"{key}-{suffix}.jpg").write_bytes(jpeg())
            items.append({"key": key, "trace": f"{name}.json", "source": "prod", "trace_rel": f"user-5/2026-11-12/{name}.json", "kind": "not_top1",
                          "tags": ["glare"], "primary": "glare", "decided_wrong": False, "ocr": {}})
        items.append({"key": "old", "trace": "old.json", "kind": "not_top1", "tags": ["other"], "primary": "other", "decided_wrong": False, "ocr": {}})  # an older report's item
        (run / "old-photo.jpg").write_bytes(jpeg())
        report = {"created_at": "2026-11-12T00:00:00+00:00", "matcher_version": "9", "options": "x", "scans": 3, "misses": 3, "decided_wrong": 0,
                  "tags": {"glare": "Glare", "other": "Other"}, "counts": {"glare": 2, "other": 1}, "primary_counts": {"glare": 2, "other": 1},
                  "run": "run-1", "items": items}
        (self.data / "misses" / "latest.json").write_text(json.dumps(report), encoding="utf-8")
        self.env = Env(SCAN_TRACE_READONLY_DIRS=f"prod={self.prod}", SCAN_TRACE_DIR=str(self.local), SCAN_TRACE_STORAGE_DIR=str(self.local))
        self.env.__enter__()
        self.addCleanup(self.env.__exit__)

    def files(self):
        return sorted(p.name for p in (self.data / "misses" / "run-1").iterdir())

    def test_a_report_older_than_the_newest_run_does_not_serve_a_deleted_scan(self):
        shown = misses.page(None, 0, 24, self.data)
        self.assertEqual(sorted(item["key"] for item in shown["items"]), ["old", "prod-live"])
        self.assertEqual(shown["misses"], 2)
        self.assertEqual(shown["counts"], {"glare": 1, "other": 1})
        self.assertIsNone(misses.full_image("prod-gone", "photo", self.data))
        self.assertIsNone(misses.strip_views("prod-gone", self.data))
        self.assertEqual(misses.full_image("prod-live", "photo", self.data), (self.data / "misses" / "run-1" / "prod-live-photo-full.jpg").read_bytes())
        self.assertEqual(len(self.files()), 9)  # serving deletes nothing

    def test_the_next_run_removes_the_derived_files_of_a_vanished_scan(self):
        before = snapshot(self.prod)
        self.assertEqual(misses.purge_vanished(self.data), 1)
        self.assertEqual(self.files(), sorted(["old-photo.jpg"] + [f"prod-live-{s}.jpg" for s in ("card-full", "card", "photo-full", "photo")]))
        report = misses.load_latest(self.data)
        self.assertEqual([item["key"] for item in report["items"]], ["prod-live", "old"])
        self.assertEqual((report["misses"], report["removed_deleted_scans"]), (2, 1))
        self.assertEqual(misses.purge_vanished(self.data), 0)
        self.assertEqual(snapshot(self.prod), before)

    def test_an_unreadable_source_hides_its_scans_but_deletes_nothing(self):
        with patch.object(misses, "_readable", return_value=False):
            shown = misses.page(None, 0, 24, self.data)
            self.assertEqual([item["key"] for item in shown["items"]], ["old"])
            self.assertEqual(misses.purge_vanished(self.data), 0)
        self.assertEqual(len(self.files()), 9)
        self.assertEqual(len(misses.load_latest(self.data)["items"]), 3)

    def test_a_prod_scan_named_like_a_local_one_gets_its_own_key(self):
        class Outcome(SimpleNamespace):
            pass

        collector = misses.MissCollector(lambda ids: {}, self.data)
        outcome = Outcome(detection={"found": False, "corners": []}, matches=[], decision=None, card=None, text_card=None, ocr={}, unsure_reason=None)
        photo = np.full((60, 40, 3), 100, dtype=np.uint8)
        with patch("services.card_match.detect.detect_card", return_value=SimpleNamespace(card=photo, found=False)), patch.object(misses, "card_stats", return_value=None):
            collector.add(trace="same.json", photo=photo, outcome=outcome, truth_id="swsh1-1_en")
            collector.add(trace="same.json", photo=photo, outcome=outcome, truth_id="swsh1-1_en", source="prod", trace_rel="user-1/2026-11-12/same.json")
        self.assertEqual([item["key"] for item in collector.items], ["same", "prod-same"])
        self.assertEqual(collector.items[1]["trace_rel"], "user-1/2026-11-12/same.json")


if __name__ == "__main__":
    unittest.main()
