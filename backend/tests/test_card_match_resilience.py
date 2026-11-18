"""The picture matcher on a shared GPU: a failed GPU run is rerun on the CPU, repeated failures make a model CPU-only,
an idle matcher gives its GPU memory back and reloads on the next use, and the warm request is cheap and rate-limited.
No GPU or ONNX Runtime needed: a fake runtime stands in."""

import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from services.card_match import device, embed, jobs, lifecycle, warmup


class FakeSession:
    """CPU or CUDA session. A CUDA one raises from ``run`` while ``ort.cuda_fails`` is set."""

    def __init__(self, ort, providers):
        self.ort, self.providers = ort, providers
        self.gpu = providers[0] == device.CUDA

    def get_providers(self):
        return [device.CUDA, device.CPU] if self.gpu else [device.CPU]

    def get_inputs(self):
        return [types.SimpleNamespace(name="pixel_values")]

    def run(self, output_names, input_feed, run_options=None):
        self.ort.runs.append("cuda" if self.gpu else "cpu")
        if self.gpu and self.ort.cuda_fails:
            raise RuntimeError("bfc_arena.cc: Available memory of 9530368 is smaller than requested bytes of 13647616")
        batch = input_feed["pixel_values"].shape[0]
        hidden = np.ones((batch, 3, 384), dtype=np.float32)
        hidden[:, 0, :] = 2.0 if self.gpu else 3.0  # lets a test see which side answered
        return [hidden]


class FakeOrt:
    class ExecutionMode:
        ORT_SEQUENTIAL = 0

    class GraphOptimizationLevel:
        ORT_ENABLE_ALL = 99

    class SessionOptions:
        pass

    def __init__(self):
        self.cuda_fails = False
        self.runs: list[str] = []
        self.created: list[list] = []

    def get_available_providers(self):
        return [device.CUDA, device.CPU]

    def InferenceSession(self, path, sess_options=None, providers=None):
        providers = [p[0] if isinstance(p, tuple) else p for p in providers]
        self.created.append(providers)
        return FakeSession(self, providers)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Base(unittest.TestCase):
    def setUp(self):
        device.reset_for_tests()
        lifecycle.reset_for_tests()
        self.clock = Clock()
        lifecycle._clock = self.clock
        lifecycle._last_use = self.clock()
        env = mock.patch.dict("os.environ", {"CARD_MATCH_DEVICE": "auto", "CARD_MATCH_GPU_MEM_MB": "1024", "CARD_MATCH_IDLE_UNLOAD_MINUTES": "10", "CARD_MATCH_GPU_FAILURES": "3"})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(lifecycle.reset_for_tests)
        reaper = mock.patch.object(lifecycle, "ensure_reaper")  # no background thread in tests
        reaper.start()
        self.addCleanup(reaper.stop)
        self.ort = FakeOrt()

    def feed(self, n=1):
        return {"pixel_values": np.zeros((n, 3, 224, 224), dtype=np.float32)}


class PerRunFallbackTests(Base):
    def test_failed_gpu_run_is_rerun_on_the_cpu_with_the_cpu_answer(self):
        session, info = device.create_session(self.ort, "m.onnx", None, kind="embedder:x")
        self.assertEqual(info["device"], "cuda")
        self.ort.cuda_fails = True
        with self.assertLogs(device.logger, "WARNING") as logs:
            out = session.run(None, self.feed())[0]
        self.assertEqual(out[0, 0, 0], 3.0)  # the CPU twin answered
        self.assertEqual(self.ort.runs, ["cuda", "cpu"])
        self.assertEqual(self.ort.created, [[device.CUDA, device.CPU], [device.CPU]])  # twin built lazily, on the CPU
        self.assertEqual(len(logs.records), 1)

    def test_other_session_methods_still_work(self):
        session, _ = device.create_session(self.ort, "m.onnx", None, kind="embedder:x")
        self.assertEqual(session.get_inputs()[0].name, "pixel_values")

    def test_three_failures_make_the_model_cpu_only_and_free_its_gpu_share(self):
        session, _ = device.create_session(self.ort, "m.onnx", None, kind="embedder:dinov2-small")
        self.ort.cuda_fails = True
        with self.assertLogs(device.logger, "WARNING"):
            for _ in range(3):
                session.run(None, self.feed())
        self.assertTrue(session.cpu_only)
        self.assertFalse(session.on_gpu)
        self.assertEqual(device._granted_mb, 0.0)
        before = list(self.ort.runs)
        session.run(None, self.feed())
        self.assertEqual(self.ort.runs[len(before):], ["cpu"])  # no more GPU attempts
        view = device.report()["embedder"]
        self.assertEqual(view["device"], "cpu")
        self.assertEqual(view["gpu_failures"], 3)
        self.assertIn("3 GPU runs failed", view["reason"])

    def test_budget_shares_are_planned_for_variable_ocr_inputs(self):
        self.assertEqual(device.EMBEDDER_SHARE, 0.2)
        self.assertEqual(device.OCR_SHARES, {"det": 0.35, "rec": 0.35, "cls": 0.03})
        self.assertLessEqual(device.EMBEDDER_SHARE + sum(device.OCR_SHARES.values()), 1.0)


class EmbedderLifecycleTests(Base):
    def embedder(self):
        path = Path(tempfile.mkdtemp()) / "m.onnx"
        path.write_bytes(b"x")
        patches = [
            mock.patch.dict(sys.modules, {"onnxruntime": self.ort}),
            mock.patch.object(embed.OnnxEmbedder, "prepare", lambda self, image: np.zeros((3, 224, 224), dtype=np.float32)),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        return embed.OnnxEmbedder("dinov2-small", path=path, verify=False)

    def test_idle_unload_frees_the_gpu_session_and_the_next_use_reloads_it(self):
        embedder = self.embedder()
        image = np.zeros((10, 10, 3), dtype=np.uint8)
        first = embedder.embed([image])
        self.assertEqual(device.report()["embedder"]["state"], "warm")
        self.assertGreater(device._granted_mb, 0)

        self.clock.now += 9 * 60
        self.assertFalse(lifecycle.unload_if_idle())  # not idle long enough
        self.clock.now += 2 * 60
        with mock.patch.object(device, "gpu_used_mb", return_value=None):
            self.assertTrue(lifecycle.unload_if_idle())
        self.assertIsNone(embedder.session)
        self.assertEqual(device._granted_mb, 0.0)
        view = device.report()["embedder"]
        self.assertEqual((view["state"], bool(view["unloaded_at"])), ("unloaded", True))

        creations = len(self.ort.created)
        second = embedder.embed([image])  # the same object works again
        self.assertEqual(len(self.ort.created), creations + 1)
        self.assertIsNotNone(embedder.session)
        self.assertEqual(device.report()["embedder"]["state"], "warm")
        np.testing.assert_allclose(first, second)

    def test_a_cpu_session_is_left_alone(self):
        self.ort.get_available_providers = lambda: [device.CPU]
        embedder = self.embedder()
        embedder.embed([np.zeros((10, 10, 3), dtype=np.uint8)])
        self.clock.now += 3600
        self.assertFalse(lifecycle.unload_if_idle())
        self.assertIsNotNone(embedder.session)

    def test_unload_never_happens_while_a_model_is_in_use(self):
        embedder = self.embedder()
        embedder.embed([np.zeros((10, 10, 3), dtype=np.uint8)])
        with lifecycle.in_use():
            self.clock.now += 3600
            self.assertFalse(lifecycle.unload_if_idle())
            self.assertIsNotNone(embedder.session)
        self.clock.now += 11 * 60  # the use just ended: idle is counted from its end
        self.assertTrue(lifecycle.unload_if_idle())

    def test_unload_waits_for_a_running_job(self):
        embedder = self.embedder()
        embedder.embed([np.zeros((10, 10, 3), dtype=np.uint8)])
        release, started = threading.Event(), threading.Event()
        runner = jobs.MatchJobs()

        def work():
            started.set()
            release.wait(5)
            return {}

        runner.start("test", work)
        self.assertTrue(started.wait(5))
        self.clock.now += 3600
        self.assertFalse(lifecycle.unload_if_idle())
        self.assertIsNotNone(embedder.session)
        release.set()
        runner.wait(5)
        self.clock.now += 11 * 60
        self.assertTrue(lifecycle.unload_if_idle())

    def test_idle_unload_can_be_switched_off(self):
        embedder = self.embedder()
        embedder.embed([np.zeros((10, 10, 3), dtype=np.uint8)])
        self.clock.now += 3600
        with mock.patch.dict("os.environ", {"CARD_MATCH_IDLE_UNLOAD_MINUTES": "0"}):
            self.assertFalse(lifecycle.unload_if_idle())
        self.assertIsNotNone(embedder.session)

    def test_a_failed_gpu_load_after_unload_uses_the_cpu(self):
        embedder = self.embedder()
        embedder.embed([np.zeros((10, 10, 3), dtype=np.uint8)])
        self.clock.now += 3600
        with mock.patch.object(device, "gpu_used_mb", return_value=None):
            lifecycle.unload_if_idle()
        real = self.ort.InferenceSession

        def taken(path, sess_options=None, providers=None):  # another program (Jellyfin) holds the memory
            if providers and isinstance(providers[0], tuple):
                raise RuntimeError("CUDA failure 2: out of memory")
            return real(path, sess_options, providers)

        self.ort.InferenceSession = taken
        embedder.embed([np.zeros((10, 10, 3), dtype=np.uint8)])
        self.assertEqual(embedder.device, "cpu")
        self.assertIn("out of memory", embedder.fallback_reason)


class WarmRequestTests(Base):
    def setUp(self):
        super().setUp()
        warmup._last_request = float("-inf")
        warmup._warming = False
        env = mock.patch.dict("os.environ", {"CARD_MATCH_WARM": "1"})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(lambda: setattr(warmup, "_warming", False))

    def test_returns_at_once_and_warms_in_the_background(self):
        release, started = threading.Event(), threading.Event()

        def slow_warm_up():
            started.set()
            release.wait(5)

        with mock.patch.object(warmup, "warm_up", slow_warm_up), mock.patch.object(warmup, "is_warm", return_value=False):
            self.assertEqual(warmup.request_warm(now=100.0), {"status": "warming"})  # returned while warm_up is still blocked
            self.assertTrue(started.wait(5))
            self.assertEqual(warmup.request_warm(now=101.0), {"status": "warming"})  # no second warm-up
            release.set()
            for _ in range(100):
                if not warmup._warming:
                    break
                threading.Event().wait(0.02)

    def test_is_rate_limited(self):
        calls = []
        with mock.patch.object(warmup, "warm_up", lambda: calls.append(1)), mock.patch.object(warmup, "is_warm", return_value=False):
            self.assertEqual(warmup.request_warm(now=100.0)["status"], "warming")
            for _ in range(100):
                if not warmup._warming:
                    break
                threading.Event().wait(0.02)
            self.assertEqual(warmup.request_warm(now=105.0)["status"], "rate-limited")
            self.assertEqual(warmup.request_warm(now=100.0 + warmup.WARM_INTERVAL + 1)["status"], "warming")
            for _ in range(100):
                if not warmup._warming:
                    break
                threading.Event().wait(0.02)
        self.assertEqual(len(calls), 2)

    def test_warm_models_are_not_warmed_again_and_the_request_counts_as_use(self):
        self.clock.now += 5 * 60
        with mock.patch.object(warmup, "is_warm", return_value=True), mock.patch.object(warmup, "warm_up") as warm:
            self.assertEqual(warmup.request_warm(now=100.0), {"status": "warm"})
        warm.assert_not_called()
        self.assertEqual(lifecycle._last_use, self.clock.now)

    def test_does_nothing_unless_warm_is_switched_on(self):
        with mock.patch.dict("os.environ", {"CARD_MATCH_WARM": ""}), mock.patch.object(warmup, "warm_up") as warm:
            self.assertEqual(warmup.request_warm(now=100.0), {"status": "off"})
        warm.assert_not_called()


if __name__ == "__main__":
    unittest.main()
