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
        patcher = mock.patch.dict("os.environ", {"CARD_MATCH_DEVICE": "auto", "CARD_MATCH_GPU_MEM_MB": "1024"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_cuda_chosen_when_listed(self):
        ort = FakeOrt([device.CUDA, device.CPU])
        session, info = device.create_session(ort, "m.onnx", None, kind="embedder:x")
        self.assertEqual(info["device"], "cuda")
        provider, options = ort.calls[0][0]
        self.assertEqual(provider, device.CUDA)
        self.assertEqual(options["gpu_mem_limit"], int(1024 * 0.2 * device.MB))
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
        results = [device.create_session(ort, "m.onnx", None, kind=f"embedder:{n}")[1]["device"] for n in ("a", "b", "c", "d", "e", "f")]
        self.assertEqual(results, ["cuda"] * 5 + ["cpu"])  # 5 x 205 MB fit in the 1024 MB budget, a sixth does not
        device.drop("embedder:a")
        self.assertEqual(device.create_session(ort, "m.onnx", None, kind="embedder:g")[1]["device"], "cuda")

    def test_report_names_the_gpu_and_warm_time(self):
        ort = FakeOrt([device.CUDA, device.CPU])
        device.create_session(ort, "m.onnx", None, kind="embedder:dinov2-small")
        device.note_warm("embedder:dinov2-small", 0.8)
        with mock.patch.object(device, "gpu_name", return_value="Quadro P620"):
            view = device.report()
        self.assertEqual(view["embedder"]["label"], "GPU (Quadro P620)")
        self.assertEqual(view["embedder"]["warm_ms"], 800)
        self.assertFalse(view["ocr"]["loaded"])


class SwappableOrt(FakeOrt):
    """A fake whose InferenceSession is a plain attribute, like onnxruntime's, so ``ocr_sessions`` can swap it."""

    def __init__(self, available, cuda_works=True):
        super().__init__(available, cuda_works)
        real = FakeOrt.InferenceSession.__get__(self)
        self.InferenceSession = real
        self.real = real


class OcrSessionTests(unittest.TestCase):
    def setUp(self):
        device.reset_for_tests()
        patcher = mock.patch.dict("os.environ", {"CARD_MATCH_DEVICE": "auto", "CARD_MATCH_GPU_MEM_MB": "1024"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def build_ocr(self, ort, names=("det.onnx", "cls.onnx", "rec.onnx")):
        with device.ocr_sessions(ort) as infos:
            for name in names:  # what RapidOCR does: ort.InferenceSession(...) for each model
                ort.InferenceSession(f"/models/ch_PP-OCRv4_{name}", sess_options=None, providers=["whatever"])
        return infos

    def test_shares_are_planned_to_fit(self):
        self.assertEqual(device.ocr_share("/m/ch_PP-OCRv4_det_infer.onnx"), 0.35)
        self.assertEqual(device.ocr_share("/m/ch_ppocr_mobile_v2.0_cls_infer.onnx"), 0.03)
        self.assertEqual(device.ocr_share("/m/ch_PP-OCRv4_rec_infer.onnx"), 0.35)
        self.assertLessEqual(device.EMBEDDER_SHARE + sum(device.OCR_SHARES.values()), 1.0)

    def test_healthy_start_puts_embedder_and_all_three_ocr_parts_on_the_gpu_without_a_warning(self):
        ort = SwappableOrt([device.CUDA, device.CPU])
        device.create_session(ort, "dino.onnx", None, kind="embedder:dinov2-small")
        with self.assertNoLogs(device.logger, "WARNING"):
            infos = self.build_ocr(ort)
        self.assertEqual([i["device"] for i in infos], ["cuda", "cuda", "cuda"])
        self.assertEqual(device.summarise_ocr(infos)["device"], "cuda")

    def test_budget_running_out_on_the_third_session_falls_back_without_recursing(self):
        ort = SwappableOrt([device.CUDA, device.CPU])
        with mock.patch.dict("os.environ", {"CARD_MATCH_GPU_MEM_MB": "300"}):  # embedder 60 + det 105 + rec 105 fit, a further OCR session does not
            device.create_session(ort, "dino.onnx", None, kind="embedder:x")  # 60 MB
            infos = self.build_ocr(ort, ("det.onnx", "rec.onnx", "rec2.onnx", "rec3.onnx"))
        devices = [i["device"] for i in infos]
        self.assertEqual(devices[:2], ["cuda", "cuda"])
        self.assertIn("cpu", devices)  # ran out, fell back on the real class (no RecursionError)
        self.assertIs(ort.InferenceSession, ort.real)  # swap restored

    def test_cpu_fallback_while_swapped_uses_the_real_session_class(self):
        ort = SwappableOrt([device.CPU])  # no CUDA at all: every part takes the CPU path inside the swap
        infos = self.build_ocr(ort)
        self.assertEqual([i["device"] for i in infos], ["cpu"] * 3)
        self.assertIs(ort.InferenceSession, ort.real)

    def test_swap_is_restored_and_shares_released_when_the_engine_fails(self):
        ort = SwappableOrt([device.CUDA, device.CPU])
        with self.assertRaises(ValueError):
            with device.ocr_sessions(ort):
                ort.InferenceSession("/m/x_det.onnx", sess_options=None, providers=None)
                raise ValueError("engine failed")
        self.assertIs(ort.InferenceSession, ort.real)
        self.assertEqual(device._granted_mb, 0.0)


class StatusDoesNotLoadModels(unittest.TestCase):
    def test_report_never_touches_a_session_factory(self):
        device.reset_for_tests()
        ort = FakeOrt([device.CUDA, device.CPU])
        with mock.patch("services.card_match.embed.get_embedder") as embedder, mock.patch("services.card_match.ocr.get_reader") as reader:
            view = device.report()
        embedder.assert_not_called()
        reader.assert_not_called()
        self.assertEqual(ort.calls, [])
        self.assertFalse(view["embedder"]["loaded"])
        self.assertFalse(view["ocr"]["loaded"])


if __name__ == "__main__":
    unittest.main()
