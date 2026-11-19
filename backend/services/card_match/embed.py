"""Picture embeddings: a flat card in, an L2-normalised float32 vector out.

``Embedder`` is the interface; ``OnnxEmbedder`` runs any model listed in ``model_specs.py`` on ONNX
Runtime's CUDA provider when there is a GPU (``device.py``, memory capped) and its CPU provider otherwise,
with the thread count capped. A second model (MobileCLIP, SigLIP, ...) is one
more entry in ``MODEL_SPECS``.
Tests use ``FakeEmbedder`` (no model file).
"""

from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from typing import Protocol, Sequence

import numpy as np

from . import config, custom_models, device, lifecycle
from .model_specs import DEFAULT_MODEL, MODEL_SPECS


class Embedder(Protocol):
    name: str
    dim: int

    def embed(self, images: Sequence[np.ndarray]) -> np.ndarray:
        """RGB uint8 images (any size) -> float32 matrix (n, dim), rows of unit length."""
        ...


def l2_normalise(matrix: np.ndarray) -> np.ndarray:
    matrix = np.asarray(matrix, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, 1e-12)


def model_path(name: str) -> Path:
    if custom_models.is_custom_name(name):  # an uploaded model lives in the card-match data folder
        return custom_models.model_file(name)
    return config.model_dir() / MODEL_SPECS[name]["filename"]


def model_spec(name: str) -> dict:
    if custom_models.is_custom_name(name):
        return custom_models.spec_for(name)
    if name not in MODEL_SPECS:
        raise ValueError(f"Unknown card-match model {name!r}")
    return MODEL_SPECS[name]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def model_available(name: str = DEFAULT_MODEL) -> bool:
    if custom_models.is_custom_name(name):
        return custom_models.get_model(name) is not None and model_path(name).is_file()
    return name in MODEL_SPECS and model_path(name).is_file()


def preprocess(image: np.ndarray, size: int, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    """RGB uint8 image (any size) -> the model's input tensor (3, size, size): resize (INTER_AREA when shrinking, INTER_CUBIC
    when enlarging), scale to 0..1, subtract the mean, divide by the std."""
    import cv2

    resized = cv2.resize(image, (size, size), interpolation=cv2.INTER_AREA if min(image.shape[:2]) > size else cv2.INTER_CUBIC)
    normalised = (resized.astype(np.float32) / 255.0 - mean) / std
    return normalised.transpose(2, 0, 1)


class OnnxEmbedder:
    """ONNX Runtime CPU embedder for the models in MODEL_SPECS."""

    def __init__(self, name: str = DEFAULT_MODEL, *, path: Path | None = None, threads: int | None = None, verify: bool = True) -> None:
        import onnxruntime as ort

        spec = model_spec(name)
        self.name = name
        self.dim = spec["dim"]
        self.size = spec["input_size"]
        self.path = path or model_path(name)
        if not self.path.is_file():
            raise FileNotFoundError(f"Model file {self.path} is missing (pinned models are baked into the backend image; custom ones are uploaded in Scanner lab)")
        if verify and file_sha256(self.path) != spec["sha256"]:
            raise ValueError(f"Model file {self.path} does not match the pinned checksum" if name in MODEL_SPECS else f"Model file {self.path} does not match its registered checksum")
        self.mean = np.array(spec["mean"], dtype=np.float32).reshape(1, 1, 3)
        self.std = np.array(spec["std"], dtype=np.float32).reshape(1, 1, 3)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads or config.threads()
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._ort, self._options = ort, options
        self._run_lock = threading.Lock()  # one run at a time per model: bounds the GPU arena
        self._load_lock = threading.RLock()
        self.session = None
        self._open()
        lifecycle.register(self)

    def _open(self) -> None:
        """Create the session (on the GPU when there is one). Also runs again after an idle unload."""
        with self._load_lock:
            self.session, info = device.create_session(self._ort, str(self.path), self._options, kind=f"embedder:{self.name}", share=device.EMBEDDER_SHARE)
            self.device = info["device"]
            self.fallback_reason = info["reason"]
            self.input_name = self.session.get_inputs()[0].name

    def unload(self) -> bool:
        """Release the GPU session after an idle spell (called by lifecycle, never during a use). The object stays usable:
        the next ``embed`` opens the session again. A CPU session is left alone. True when something was released."""
        with self._load_lock:
            if not isinstance(self.session, device.GpuSession):
                return False
            self.session.close()
            self.session = None
            device.mark_unloaded(f"embedder:{self.name}")
            return True

    def reopen(self) -> None:
        """Close the session (GPU or CPU) and open it again: it takes the GPU share if one is free now. The object stays the same, so
        anything holding it (a cached matcher) keeps working."""
        with self._load_lock:
            if isinstance(self.session, device.GpuSession):
                self.session.close()
                device.mark_unloaded(f"embedder:{self.name}")
            self.session = None
            self._open()

    def warm_up(self) -> float:
        """One dummy inference, so the first real scan does not pay for CUDA or session start-up. Returns seconds."""
        import time

        started = time.monotonic()
        self.embed([np.full((self.size, self.size, 3), 127, dtype=np.uint8)])
        seconds = time.monotonic() - started
        device.note_warm(f"embedder:{self.name}", seconds)
        return seconds

    def prepare(self, image: np.ndarray) -> np.ndarray:
        return preprocess(image, self.size, self.mean, self.std)

    def embed(self, images: Sequence[np.ndarray], batch_size: int = 8) -> np.ndarray:
        out = []
        with lifecycle.in_use():
            with self._load_lock:
                if self.session is None:
                    self._open()
            if self.device == "cuda":
                batch_size = min(batch_size, device.MAX_GPU_BATCH)
            for start in range(0, len(images), batch_size):
                batch = np.stack([self.prepare(image) for image in images[start:start + batch_size]])
                with self._run_lock:
                    hidden = self.session.run(None, {self.input_name: batch})[0]
                out.append(np.asarray(hidden[:, 0, :], dtype=np.float32))  # the CLS token
        if not out:
            return np.zeros((0, self.dim), dtype=np.float32)
        return l2_normalise(np.concatenate(out))


class FakeEmbedder:
    """Deterministic stand-in for tests: a coarse colour/layout signature, no model file needed."""

    def __init__(self, name: str = "fake", dim: int = 48) -> None:
        self.name = name
        self.dim = dim

    def embed(self, images: Sequence[np.ndarray], batch_size: int = 8) -> np.ndarray:
        import cv2

        rows = []
        for image in images:
            tiny = cv2.resize(image, (4, 4), interpolation=cv2.INTER_AREA).astype(np.float32).reshape(-1) - 127.5
            rows.append(tiny)
        return l2_normalise(np.stack(rows)) if rows else np.zeros((0, self.dim), dtype=np.float32)


_cache: dict[tuple[str, int], OnnxEmbedder] = {}
_cache_lock = threading.Lock()


def get_embedder(name: str = DEFAULT_MODEL) -> OnnxEmbedder:
    """The shared embedder for a model (one ONNX session per process)."""
    key = (name, config.threads())
    with _cache_lock:
        if key not in _cache:
            _cache[key] = OnnxEmbedder(name)
        return _cache[key]


def forget(name: str) -> None:
    """Drop a model's cached session (a deleted custom model)."""
    with _cache_lock:
        for key in [key for key in _cache if key[0] == name]:
            del _cache[key]
    device.drop(f"embedder:{name}")
