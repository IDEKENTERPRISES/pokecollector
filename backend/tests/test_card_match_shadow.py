"""Matcher shadow mode (services/card_match/shadow.py): runs once, never blocks, skips when not ready,
records only with the trainer's consent, agreement fields, the lab report and the labelled benchmark.

Uses the fake embedder, as test_card_match.py does.
"""
import datetime
import io
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    import numpy as np
    from PIL import Image
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import Card, ImageCache, ScanJob, ScanJobItem, Set, User, UserSetting
    from services import card_picture_packs, scan_trace
    from services.card_match import benchmark, config, embed, images, index, ocr, pipeline, shadow, synthetic

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def card_picture(seed: int, size=(630, 880)) -> "Image.Image":
    rng = np.random.default_rng(seed)
    base = np.zeros((size[1], size[0], 3), dtype=np.uint8)
    base[:] = rng.integers(60, 230, 3)
    base[40:560, 40:590] = rng.integers(0, 255, 3)
    for band in range(5):
        top = 580 + band * 40
        base[top:top + 24, 50:580] = rng.integers(0, 255, 3)
    base[::7, :, :] = base[::7, :, :] // 2
    base[0:14, :] = (240, 200, 40)
    base[-14:, :] = (240, 200, 40)
    base[:, 0:14] = (240, 200, 40)
    base[:, -14:] = (240, 200, 40)
    return Image.fromarray(base, "RGB")


def png_bytes(image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


class Reader:
    def __init__(self, number_local, number_total):
        self.result = ocr.OcrResult(number_local=number_local, number_total=number_total, tokens=["TST", f"{number_local}/{number_total}"])

    def read(self, card, read_hp=False, flipped=None):
        return self.result


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class ShadowTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.traces = Path(self.tmp.name) / "traces"
        self.data_dir = Path(self.tmp.name) / "card-match"
        env = patch.dict(os.environ, {
            "SCAN_TRACE_DIR": str(self.traces), "SCAN_TRACE_STORAGE_DIR": str(self.traces),
            "CARD_MATCH_DIR": str(self.data_dir), "CARD_MATCH_MODEL_DIR": str(Path(self.tmp.name) / "models"),
            "SCAN_MATCHER_SHADOW": "1",
        })
        env.start()
        self.addCleanup(env.stop)
        # These tests are about the plumbing, not the picture-only lane (a fake embedder matches perfectly).
        strong = patch.object(pipeline, "SIM_MIN_PICTURE_STRONG", 2.0)
        strong.start()
        self.addCleanup(strong.stop)
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine, autoflush=False)
        self.db = self.Session()
        self.addCleanup(self.db.close)
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.db.add(self.user)
        self.db.add(Set(id="tst_en", tcg_set_id="tst", name="Test Set", series="X", lang="en", total=5, printed_total=5, abbreviation="TST"))
        self.pictures = {n: card_picture(n) for n in range(1, 6)}
        for n in self.pictures:
            self.db.add(Card(
                id=f"tst-{n}_en", tcg_card_id=f"tst-{n}", name=f"Mon {n}", set_id="tst", number=str(n), lang="en", is_custom=False,
                is_digital=False, images_small=f"https://img.example/tst-{n}/low.webp",
            ))
        self.db.commit()
        for n, picture in self.pictures.items():
            card = self.db.query(Card).filter(Card.id == f"tst-{n}_en").one()
            key = card_picture_packs.card_image_key(card.id, card.images_small)
            self.db.add(ImageCache(image_key=key, data=png_bytes(picture.resize((245, 337))), content_type="image/png"))
        self.db.commit()
        self.embedder = embed.FakeEmbedder()
        index.build_index(self.Session, self.embedder, data_dir=self.data_dir)
        self.index = index.load_index(self.embedder.name, self.data_dir)
        jpeg, _corners, _s = synthetic.make_photo(self.pictures[4], 4)
        self.photo_jpeg = jpeg

    def enable_diagnostics(self):
        self.db.add(UserSetting(user_id=self.user.id, key=scan_trace.SCAN_DIAGNOSTICS_SETTING_KEY, value="true"))
        self.db.commit()

    def matcher(self, number="4", total="5"):
        return pipeline.CardMatcher(self.index, self.embedder, pipeline.db_candidate_loader(self.Session), Reader(number, total))

    def runner(self, matcher_factory=None, consent=True, photo_reader=None):
        return shadow.ShadowRunner(
            matcher_factory=matcher_factory or (lambda: (self.matcher(), None)),
            photo_reader=photo_reader or (lambda path: self.photo_jpeg),
            consent_check=lambda user_id: consent,
            busy_check=lambda: False,
            low_priority=False,
        )

    def shadow_file(self, job=1, item=1):
        return self.traces / f"user-{self.user.id}" / "shadow" / f"job{job}-item{item}.shadow"

    def read_shadow(self, job=1, item=1):
        return json.loads(self.shadow_file(job, item).read_text(encoding="utf-8"))

    def save_trace(self, job=1, item=1, selected="tst-4", truth=None, image=True, **extra):
        trace = scan_trace.ScanTrace(enabled=True, user_id=self.user.id, mode="single", job_id=job, item_id=item)
        trace.data["candidates"] = [
            {"tcg_card_id": f"tst-{n}", "name": f"Mon {n}", "lang": "en"} for n in range(1, 6)
        ]
        trace.record_decision("metadata_unique" if selected else "undecided", selected)
        if image:
            trace.set_image(self.photo_jpeg)
        trace.data.update(extra)
        path = trace.save()
        if truth:
            scan_trace.record_ground_truth(self.user.id, job, item, truth)
        return path


class ShadowRunnerTests(ShadowTestBase):
    def test_a_photo_is_run_once_and_recorded_with_everything_the_comparison_needs(self):
        self.enable_diagnostics()
        runner = self.runner()
        self.assertTrue(runner.submit(self.user.id, 1, 1, "1/a.jpg"))
        self.assertFalse(runner.submit(self.user.id, 1, 1, "1/a.jpg"))  # the same photo again is ignored
        self.assertTrue(runner.wait_idle())
        self.assertEqual(runner.status()["ran"], 1)
        record = self.read_shadow()
        self.assertEqual(record["status"], "ok")
        self.assertEqual(record["decision"]["tcg_card_id"], "tst-4")
        self.assertEqual(len(record["matches"]), 5)
        self.assertIn("similarity", record["matches"][0])
        self.assertEqual(record["ocr"]["number_local"], "4")
        self.assertTrue(record["ocr"]["tokens"])
        self.assertTrue({"detect", "embed", "search", "ocr", "decide", "total"} <= set(record["timings_ms"]))
        self.assertEqual(record["matcher_version"], shadow.MATCHER_VERSION)
        self.assertEqual(record["model"], shadow.DEFAULT_MODEL)
        # A second runner (after a restart) finds the record on disk and does not run it again.
        calls = []
        again = self.runner(matcher_factory=lambda: (calls.append(1), (self.matcher(), None))[1])
        again.submit(self.user.id, 1, 1, "1/a.jpg")
        self.assertTrue(again.wait_idle())
        self.assertEqual(calls, [])

    def test_it_does_not_block_the_caller_or_break_when_the_matcher_fails(self):
        self.enable_diagnostics()
        release = threading.Event()

        class Slow:
            def match(self, photo):
                release.wait(5)
                raise RuntimeError("boom")

        runner = self.runner(matcher_factory=lambda: (Slow(), None))
        started = time.monotonic()
        for item in range(1, 4):
            runner.submit(self.user.id, 1, item, "1/a.jpg")
        self.assertLess(time.monotonic() - started, 0.5)  # submitting never waits for the matcher
        self.assertGreaterEqual(runner.status()["waiting"], 1)
        release.set()
        self.assertTrue(runner.wait_idle())
        self.assertEqual(runner.status()["skipped"], {"match_failed": 3})
        self.assertEqual(self.read_shadow(item=1)["reason"], "match_failed")

    def test_it_steps_aside_while_an_admin_job_runs_and_works_one_photo_at_a_time(self):
        self.enable_diagnostics()
        busy = {"value": True}
        active, peak = [], []
        real = self.matcher()

        class Counting:
            def match(self, photo):
                active.append(1)
                peak.append(len(active))
                time.sleep(0.05)
                active.pop()
                return real.match(photo)

        runner = shadow.ShadowRunner(
            matcher_factory=lambda: (Counting(), None), photo_reader=lambda path: self.photo_jpeg,
            consent_check=lambda user_id: True, busy_check=lambda: busy["value"], low_priority=False,
        )
        with patch.object(shadow, "IDLE_POLL_SECONDS", 0.01):
            for item in range(1, 4):
                runner.submit(self.user.id, 1, item, "1/a.jpg")
            time.sleep(0.1)
            self.assertEqual(runner.status()["ran"], 0)  # held back by the benchmark
            busy["value"] = False
            self.assertTrue(runner.wait_idle())
        self.assertEqual(runner.status()["ran"], 3)
        self.assertEqual(max(peak), 1)

    def test_it_skips_and_says_why_when_the_model_or_index_is_not_ready(self):
        self.enable_diagnostics()
        runner = self.runner(matcher_factory=lambda: (None, "index_not_built"))
        runner.submit(self.user.id, 1, 1, "1/a.jpg")
        self.assertTrue(runner.wait_idle())
        self.assertEqual(runner.status()["skipped"], {"index_not_built": 1})
        record = self.read_shadow()
        self.assertEqual((record["status"], record["reason"]), ("skipped", "index_not_built"))
        # The real readiness check: no model file in this folder.
        matcher, reason = shadow.default_matcher()
        self.assertIsNone(matcher)
        self.assertEqual(reason, "model_missing")
        # A photo that has been deleted is a skip too.
        def gone(path):
            raise FileNotFoundError(path)

        missing = self.runner(photo_reader=gone)
        missing.submit(self.user.id, 2, 1, "2/a.jpg")
        self.assertTrue(missing.wait_idle())
        self.assertEqual(missing.status()["skipped"], {"photo_unavailable": 1})

    def test_nothing_is_recorded_without_the_trainers_consent(self):
        runner = self.runner(consent=False)
        runner.submit(self.user.id, 1, 1, "1/a.jpg")
        self.assertTrue(runner.wait_idle())
        self.assertFalse(self.shadow_file().exists())
        self.assertEqual(runner.status()["ran"], 0)
        # Queuing from an upload checks the same consent and the flag.
        job = ScanJob(user_id=self.user.id, status="pending", expires_at=datetime.datetime.utcnow() + datetime.timedelta(days=1))
        self.db.add(job)
        self.db.flush()
        self.db.add(ScanJobItem(job_id=job.id, user_id=self.user.id, position=0, image_path="1/a.jpg", byte_size=1))
        self.db.add(ScanJobItem(job_id=job.id, user_id=self.user.id, position=1, image_path="1/b.jpg", byte_size=1))
        self.db.commit()
        queue = self.runner()
        with patch.object(shadow, "runner", queue):
            self.assertEqual(shadow.schedule_job(self.db, self.user.id, job), 0)  # no consent yet
            self.enable_diagnostics()
            with patch.dict(os.environ, {"SCAN_MATCHER_SHADOW": ""}):
                self.assertEqual(shadow.schedule_job(self.db, self.user.id, job), 0)  # flag off
            self.assertEqual(shadow.schedule_job(self.db, self.user.id, job), 2)
            self.assertEqual(shadow.schedule_job(self.db, self.user.id, job), 0)  # once only
        self.assertTrue(queue.wait_idle())
        self.assertEqual(queue.status()["ran"], 2)

    def test_no_record_for_a_revoked_account(self):
        self.enable_diagnostics()
        scan_trace.revoke_user_traces(self.user.id)
        self.assertFalse(scan_trace.record_shadow(self.user.id, 1, 1, {"status": "ok"}))
        self.assertFalse(self.shadow_file().exists())


class ShadowSameInputTests(ShadowTestBase):
    """The shadow run must see the photo the scan trace stores, so it decides what the labelled benchmark does."""

    def test_the_shadow_run_and_the_benchmark_read_the_same_photo_and_decide_the_same(self):
        from services import scan_storage

        self.enable_diagnostics()
        upload_dir = Path(self.tmp.name) / "uploads"
        with patch.dict(os.environ, {"SCAN_UPLOAD_DIR": str(upload_dir)}):
            relative, _size = scan_storage.store_sanitized_image(1, scan_storage.SanitizedScanImage(self.photo_jpeg))
            crop = scan_storage.make_recognition_image(self.photo_jpeg, (0.2, 0.2, 0.6, 0.6))
            self.assertTrue(crop)
            scan_storage.store_recognition_image(relative, crop)
            seen = []
            real = self.matcher()

            class Spy:
                ocr_reader = real.ocr_reader
                index = real.index

                def match(self, photo, **kwargs):
                    seen.append((photo, kwargs.get("full_photo")))
                    return real.match(photo, **kwargs)

            runner = shadow.ShadowRunner(
                matcher_factory=lambda: (Spy(), None), consent_check=lambda user_id: True,
                busy_check=lambda: False, low_priority=False,
            )  # the default photo reader: the real one
            runner.submit(self.user.id, 1, 1, relative)
            self.assertTrue(runner.wait_idle())
            # What the trace stores (and run_labelled decodes) is the recognition image, not the full photo.
            trace_bytes = scan_storage.read_recognition_image(relative)
            self.assertEqual(trace_bytes, crop)
            benchmark_photo = images.decode_rgb(trace_bytes, max_side=2048)
            self.assertEqual(len(seen), 1)
            np.testing.assert_array_equal(seen[0][0], benchmark_photo)
            # The text is read from the full-resolution stored photo; only that, never the embedded card.
            np.testing.assert_array_equal(seen[0][1], images.decode_rgb(self.photo_jpeg, max_side=2048))
            record = self.read_shadow()
            self.assertEqual(record["decision"], real.match(benchmark_photo).decision)
            self.assertEqual(record["input"], {"bytes": len(crop), "width": benchmark_photo.shape[1], "height": benchmark_photo.shape[0]})
            self.assertTrue(record["ocr_available"])
            self.assertEqual(record["index_count"], 5)
            self.assertEqual(record["matcher_version"], shadow.MATCHER_VERSION)

    def test_without_a_recognition_crop_the_stored_photo_is_used(self):
        from services import scan_storage

        upload_dir = Path(self.tmp.name) / "uploads2"
        with patch.dict(os.environ, {"SCAN_UPLOAD_DIR": str(upload_dir)}):
            relative, _size = scan_storage.store_sanitized_image(2, scan_storage.SanitizedScanImage(self.photo_jpeg))
            self.assertEqual(shadow._read_stored_photo(relative), self.photo_jpeg)


class ShadowAgreementTests(ShadowTestBase):
    def run_shadow(self, number="4", item=1):
        runner = self.runner(matcher_factory=lambda: (self.matcher(number, "5"), None))
        runner.submit(self.user.id, 1, item, "1/a.jpg")
        self.assertTrue(runner.wait_idle())

    def trace_data(self, path):
        return json.loads(Path(path).read_text(encoding="utf-8"))

    def test_the_shadow_result_is_merged_when_the_trace_is_saved_afterwards(self):
        self.enable_diagnostics()
        self.run_shadow()  # e.g. the scan was waiting for the scanner
        data = self.trace_data(self.save_trace(selected="tst-4"))
        self.assertEqual(data["shadow"]["agreement"], "same")
        self.assertTrue(data["shadow"]["agrees"])
        self.assertEqual(data["shadow"]["current_rank_in_matcher"], 1)
        self.assertEqual(data["shadow"]["current_selected"], "tst-4")

    def test_the_trace_is_updated_when_the_shadow_result_arrives_afterwards(self):
        self.enable_diagnostics()
        path = self.save_trace(selected="tst-2")
        self.assertNotIn("shadow", self.trace_data(path))
        self.run_shadow()
        data = self.trace_data(path)
        self.assertEqual(data["shadow"]["agreement"], "different")
        self.assertFalse(data["shadow"]["agrees"])

    def test_every_kind_of_agreement(self):
        self.enable_diagnostics()
        self.run_shadow(item=1)  # matcher decides tst-4
        self.run_shadow(number="77", item=2)  # matcher unsure
        cases = {
            (1, "tst-4"): "same", (1, "tst-2"): "different", (1, None): "matcher_only",
            (2, "tst-2"): "current_only", (2, None): "neither",
        }
        for (item, selected), expected in cases.items():
            with self.subTest(item=item, selected=selected):
                data = self.trace_data(self.save_trace(item=item, selected=selected))
                self.assertEqual(data["shadow"]["agreement"], expected)
                self.assertEqual(data["shadow"]["agrees"], {"same": True, "different": False}.get(expected))

    def test_confirming_a_card_scores_the_matcher_as_well(self):
        self.enable_diagnostics()
        self.run_shadow()
        path = self.save_trace(item=1, selected="tst-2", truth="tst-4")
        data = self.trace_data(path)
        self.assertEqual(data["correct"], False)  # the current path chose the wrong card
        self.assertTrue(data["shadow"]["correct"])  # the matcher chose the confirmed one
        self.assertEqual(data["shadow"]["ground_truth_rank"], 1)
        self.assertEqual(data["shadow"]["truth_lang"], "en")
        self.assertEqual(data["shadow"]["agreement"], "different")

    def test_traces_without_consent_get_no_shadow_fields(self):
        self.run_shadow()  # even if a record existed
        trace = scan_trace.ScanTrace(enabled=False, user_id=self.user.id, mode="single", job_id=1, item_id=1)
        self.assertIsNone(trace.save())

    def test_lab_report_counts_agreement_and_who_was_right(self):
        self.enable_diagnostics()
        self.run_shadow(item=1)  # decides tst-4
        self.run_shadow(item=2)  # decides tst-4
        self.run_shadow(number="77", item=3)  # unsure
        self.save_trace(item=1, selected="tst-4", truth="tst-4")  # both right
        self.save_trace(item=2, selected="tst-2", truth="tst-4")  # differ, matcher right
        self.save_trace(item=3, selected="tst-1", truth="tst-1")  # matcher unsure, Ollama right
        report = shadow.shadow_report(self.traces)
        self.assertEqual(report["compared"], 3)
        self.assertEqual(report["agreement"]["same"], 1)
        self.assertEqual(report["agreement"]["different"], 1)
        self.assertEqual(report["agreement"]["agree_pct"], 50.0)
        self.assertEqual(report["matcher_decided_pct"], 66.7)
        confirmed = report["confirmed"]
        self.assertEqual(confirmed["n"], 3)
        self.assertEqual((confirmed["matcher"]["decided"], confirmed["matcher"]["right"]), (2, 2))
        self.assertEqual((confirmed["current"]["decided"], confirmed["current"]["right"]), (3, 2))
        self.assertEqual((confirmed["differ"], confirmed["differ_matcher_right"], confirmed["differ_current_right"]), (1, 1, 0))
        self.assertIsNotNone(report["median_ms"])
        self.assertEqual(report["disagreements"], [{"matcher": "Mon 4", "current": "Mon 2", "confirmed": "Mon 4", "right": "matcher"}])

    def test_labelled_benchmark_puts_the_two_paths_side_by_side(self):
        self.enable_diagnostics()
        self.run_shadow(item=1)
        self.run_shadow(item=2)
        self.save_trace(item=1, selected="tst-4", truth="tst-4")
        self.save_trace(item=2, selected="tst-2", truth="tst-4")
        report = benchmark.run_labelled(self.Session, self.matcher(), trace_dir=self.traces)
        self.assertEqual(report["kind"], "labelled")
        side = report["side_by_side"]
        self.assertEqual(side["rerun"]["n"], 2)
        self.assertEqual(side["recorded"]["n"], 2)  # both traces carry the matcher's answer from scan time
        for view in (side["rerun"], side["recorded"]):
            self.assertEqual((view["matcher"]["decided"], view["matcher"]["right"]), (2, 2))
            self.assertEqual((view["current"]["decided"], view["current"]["right"]), (2, 1))
            self.assertEqual((view["differ"], view["differ_matcher_right"], view["differ_current_right"], view["differ_neither_right"]), (1, 1, 0, 0))
        self.assertEqual(side["disagreements"], [{"matcher": "Mon 4", "ollama": "Mon 2", "confirmed": "Mon 4", "right": "matcher"}])
        self.assertEqual(report["ollama_today"]["decided_right"], 1)

    def test_labelled_benchmark_still_works_for_traces_without_shadow_data(self):
        self.enable_diagnostics()
        self.save_trace(item=1, selected="tst-4", truth="tst-4")
        report = benchmark.run_labelled(self.Session, self.matcher(), trace_dir=self.traces)
        self.assertIsNone(report["side_by_side"]["recorded"])
        self.assertEqual(report["side_by_side"]["rerun"]["n"], 1)


class CameraReportTests(unittest.TestCase):
    @staticmethod
    def trace(frame=None, crop=None, height=880):
        info = {"bytes": 1, "width": 1, "height": 1}
        if frame:
            info.update(frame=frame, crop=crop)
        return {"shadow": {"status": "ok", "input": info, "ocr": {"text_input": {"source": "full_photo", "height": height}}}}

    def test_4k_frames_are_reported_with_new_and_older_card_heights(self):
        report = shadow.camera_report([
            self.trace([3840, 2160], [1422, 1600], 1408), self.trace([3840, 2160], [1400, 1600], 1408),
            self.trace(height=880), self.trace(height=900),
        ])
        self.assertEqual(report["verdict"], "sharp")
        self.assertEqual(report["frame_common"], [3840, 2160])
        self.assertEqual((report["new_scans"], report["older_scans"]), (2, 2))
        self.assertEqual((report["card_height_new"], report["card_height_older"]), (1408, 890))
        self.assertEqual(report["crop_long_side"], 1600)

    def test_1080p_frames_are_flagged_as_unable_to_help(self):
        report = shadow.camera_report([self.trace([1920, 1080], [750, 867], 867)])
        self.assertEqual(report["verdict"], "hd")

    def test_no_frame_sizes_yet(self):
        self.assertEqual(shadow.camera_report([self.trace()])["verdict"], "none")
        self.assertEqual(shadow.camera_report([])["card_height_new"], None)

    def test_camera_input_info_needs_a_capture(self):
        result = SimpleNamespace(ocr={"text_input": {"source": "full_photo", "width": 700, "height": 1000}})
        self.assertEqual(shadow.camera_input_info(None, result), {})
        self.assertEqual(
            shadow.camera_input_info({"frame": [3840, 2160], "crop": [1422, 1600]}, result),
            {"frame": [3840, 2160], "crop": [1422, 1600], "text_height": 1000, "text_source": "full_photo"},
        )


if __name__ == "__main__":
    unittest.main()
