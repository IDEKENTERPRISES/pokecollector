"""Device selection for the picture matcher: CUDA when listed and it really creates, the CPU otherwise (no GPU in CI)."""

import unittest
from unittest import mock

from services.card_match import device


class FakeSession:
    def __init__(self, providers):
        self._providers = providers

    def get_providers(self):
        return self._providers


class FakeOrt:
    def __init__(self, available, cuda_works=True):
        self.available = available
        self.cuda_works = cuda_works
        self.calls = []

    def get_available_providers(self):
        return self.available

    def InferenceSession(self, path, sess_options=None, providers=None):
        self.calls.append(providers)
        first = providers[0][0] if isinstance(providers[0], tuple) else providers[0]
        if first == device.CUDA:
            if not self.cuda_works:
                raise RuntimeError("CUDA failure: out of memory\nmore detail")
            return FakeSession([device.CUDA, device.CPU])
        return FakeSession([device.CPU])


class DeviceTests(unittest.TestCase):
    def setUp(self):
        device.reset_for_tests()
        patcher = mock.patch.dict("os.environ", {"CARD_MATCH_DEVICE": "auto", "CARD_MATCH_GPU_MEM_MB": "600"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_cuda_chosen_when_listed(self):
        ort = FakeOrt([device.CUDA, device.CPU])
        session, info = device.create_session(ort, "m.onnx", None, kind="embedder:x")
        self.assertEqual(info["device"], "cuda")
        provider, options = ort.calls[0][0]
        self.assertEqual(provider, device.CUDA)
        self.assertEqual(options["gpu_mem_limit"], 300 * device.MB)
        self.assertEqual(options["arena_extend_strategy"], "kSameAsRequested")
        self.assertEqual(ort.calls[0][1], device.CPU)

    def test_cpu_when_cuda_not_listed(self):
        ort = FakeOrt([device.CPU])
        _, info = device.create_session(ort, "m.onnx", None, kind="embedder:x")
        self.assertEqual(info["device"], "cpu")
        self.assertIn("no CUDA provider", info["reason"])
        self.assertEqual(ort.calls, [[device.CPU]])

    def test_cpu_forced(self):
        with mock.patch.dict("os.environ", {"CARD_MATCH_DEVICE": "cpu"}):
            ort = FakeOrt([device.CUDA, device.CPU])
            _, info = device.create_session(ort, "m.onnx", None, kind="embedder:x")
        self.assertEqual(info["device"], "cpu")
        self.assertEqual(ort.calls, [[device.CPU]])

    def test_cuda_failure_falls_back_without_raising(self):
        ort = FakeOrt([device.CUDA, device.CPU], cuda_works=False)
        with self.assertLogs(device.logger, "WARNING") as logs:
            _, info = device.create_session(ort, "m.onnx", None, kind="embedder:x")
        self.assertEqual(info["device"], "cpu")
        self.assertIn("out of memory", info["reason"])
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(device.report()["embedder"]["label"], "CPU")

    def test_memory_budget_is_shared(self):
        ort = FakeOrt([device.CUDA, device.CPU])
        results = [device.create_session(ort, "m.onnx", None, kind=f"embedder:{n}")[1]["device"] for n in ("a", "b", "c")]
        self.assertEqual(results, ["cuda", "cuda", "cpu"])  # 300 + 300 = the 600 MB budget
        device.drop("embedder:a")
        self.assertEqual(device.create_session(ort, "m.onnx", None, kind="embedder:d")[1]["device"], "cuda")

    def test_report_names_the_gpu_and_warm_time(self):
        ort = FakeOrt([device.CUDA, device.CPU])
        device.create_session(ort, "m.onnx", None, kind="embedder:dinov2-small")
        device.note_warm("embedder:dinov2-small", 0.8)
        with mock.patch.object(device, "gpu_name", return_value="Quadro P620"):
            view = device.report()
        self.assertEqual(view["embedder"]["label"], "GPU (Quadro P620)")
        self.assertEqual(view["embedder"]["warm_ms"], 800)
        self.assertFalse(view["ocr"]["loaded"])


if __name__ == "__main__":
    unittest.main()
