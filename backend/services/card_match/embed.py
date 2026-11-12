"""Picture embeddings: a flat card in, an L2-normalised float32 vector out.

``Embedder`` is the interface; ``OnnxEmbedder`` runs any model listed in ``model_specs.py`` on ONNX
Runtime's CPU provider with the thread count capped. A second model (MobileCLIP, SigLIP, ...) is one
more entry in ``MODEL_SPECS``; the phone can load the same ``.onnx`` file with onnxruntime-web later.
Tests use ``FakeEmbedder`` (no model file).
"""

from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from typing import Protocol, Sequence

import numpy as np

from . import config
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
    return config.model_dir() / MODEL_SPECS[name]["filename"]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def model_available(name: str = DEFAULT_MODEL) -> bool:
    return name in MODEL_SPECS and model_path(name).is_file()


class OnnxEmbedder:
    """ONNX Runtime CPU embedder for the models in MODEL_SPECS."""

    def __init__(self, name: str = DEFAULT_MODEL, *, path: Path | None = None, threads: int | None = None, verify: bool = True) -> None:
        import onnxruntime as ort

        if name not in MODEL_SPECS:
            raise ValueError(f"Unknown card-match model {name!r}")
        spec = MODEL_SPECS[name]
        self.name = name
        self.dim = spec["dim"]
        self.size = spec["input_size"]
        self.path = path or model_path(name)
        if not self.path.is_file():
            raise FileNotFoundError(f"Model file {self.path} is missing (it is baked into the backend image)")
        if verify and file_sha256(self.path) != spec["sha256"]:
            raise ValueError(f"Model file {self.path} does not match the pinned checksum")
        self.mean = np.array(spec["mean"], dtype=np.float32).reshape(1, 1, 3)
        self.std = np.array(spec["std"], dtype=np.float32).reshape(1, 1, 3)
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads or config.threads()
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(self.path), sess_options=options, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.input_half = "float16" in str(self.session.get_inputs()[0].type)  # the fp16 export (version 11) takes half-precision pixels

    def prepare(self, image: np.ndarray) -> np.ndarray:
        import cv2

        resized = cv2.resize(image, (self.size, self.size), interpolation=cv2.INTER_AREA if min(image.shape[:2]) > self.size else cv2.INTER_CUBIC)
        normalised = (resized.astype(np.float32) / 255.0 - self.mean) / self.std
        return normalised.transpose(2, 0, 1)

    def embed(self, images: Sequence[np.ndarray], batch_size: int = 8) -> np.ndarray:
        out = []
        for start in range(0, len(images), batch_size):
            batch = np.stack([self.prepare(image) for image in images[start:start + batch_size]])
            if self.input_half:
                batch = batch.astype(np.float16)
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
