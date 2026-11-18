"""Where the matcher's ONNX models run: the GPU when there is one, the CPU always as the fallback.

``CARD_MATCH_DEVICE`` = ``auto`` (default: CUDA when ONNX Runtime lists it and a session really creates on it),
``cuda`` (same attempt) or ``cpu`` (never touch the GPU). Any CUDA failure (no device, missing libraries, out of
memory while loading) is caught, logged once as one line, and the session is built on the CPU instead.

The card is small (2 GB, shared by the prod and nonprod stacks), so every process has a GPU memory budget
(``CARD_MATCH_GPU_MEM_MB``, default 600) that is handed out to sessions as a per-session ``gpu_mem_limit``. A session
that would not fit in what is left runs on the CPU. The arena grows only by what is asked for (``kSameAsRequested``).
"""

from __future__ import annotations

import contextlib
import gc
import logging
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

CPU = "CPUExecutionProvider"
CUDA = "CUDAExecutionProvider"
MB = 1024 * 1024

# Share of the budget per session, planned so a healthy start fits: picture model 0.3 (fixed 224x224 inputs, about 90 MB
# of weights), OCR detector 0.3 and recogniser 0.3 (their inputs vary in size and need headroom for the biggest crop),
# direction classifier 0.05 (RapidOCR loads it even with use_cls=False; it is tiny) = 0.95. The rest is headroom.
# A run that still runs out of arena is rerun on the CPU (``GpuSession``), so a share that is too small costs time, not scans.
EMBEDDER_SHARE = 0.3
OCR_SHARES = {"det": 0.3, "rec": 0.3, "cls": 0.05}
OCR_DEFAULT_SHARE = 0.3
MAX_GPU_BATCH = 16  # a bigger batch on the card could exceed the cap; the index build uses 16

_lock = threading.Lock()
_granted_mb = 0.0
_reported_failures: set[str] = set()
_status: dict[str, dict] = {}


def failure_limit() -> int:
    """GPU run failures of one model before it is marked CPU-only (until it is unloaded and loaded again)."""
    try:
        return max(1, int(os.environ.get("CARD_MATCH_GPU_FAILURES", "3")))
    except ValueError:
        return 3


def requested() -> str:
    value = os.environ.get("CARD_MATCH_DEVICE", "auto").strip().lower()
    return value if value in {"auto", "cuda", "cpu"} else "auto"


def budget_mb() -> int:
    try:
        return max(128, int(os.environ.get("CARD_MATCH_GPU_MEM_MB", "600")))
    except ValueError:
        return 600


def warm_enabled() -> bool:
    return os.environ.get("CARD_MATCH_WARM", "").strip().lower() in {"1", "true", "yes", "on"}


def cuda_listed(ort) -> bool:
    try:
        return CUDA in ort.get_available_providers()
    except Exception:  # noqa: BLE001 - a broken runtime means CPU
        return False


def select_providers(ort, mem_limit_bytes: int, *, device: str | None = None) -> tuple[list, str | None]:
    """Providers to try, in order, and why CUDA is not among them (None when it is). The CPU is always last."""
    device = device or requested()
    if device == "cpu":
        return [CPU], "CARD_MATCH_DEVICE=cpu"
    if not cuda_listed(ort):
        return [CPU], "ONNX Runtime has no CUDA provider (CPU build, or CUDA libraries missing)"
    options = {
        "device_id": 0,
        "gpu_mem_limit": int(mem_limit_bytes),
        "arena_extend_strategy": "kSameAsRequested",
        "cudnn_conv_algo_search": "HEURISTIC",  # EXHAUSTIVE re-benchmarks every new input shape (OCR crops vary)
    }
    return [(CUDA, options), CPU], None


def _grant(mb: float) -> bool:
    global _granted_mb
    with _lock:
        if _granted_mb + mb > budget_mb() + 1e-6:
            return False
        _granted_mb += mb
        return True


def release(mb: float) -> None:
    global _granted_mb
    with _lock:
        _granted_mb = max(0.0, _granted_mb - mb)


def _log_fallback(kind: str, reason: str) -> None:
    with _lock:
        first = kind not in _reported_failures
        _reported_failures.add(kind)
    if first:
        logger.warning("Card matcher: %s runs on the CPU (%s)", kind, reason)


def _record(kind: str, info: dict) -> None:
    with _lock:
        _status[kind] = {**_status.get(kind, {}), **info}


class GpuSession:
    """An ONNX Runtime session on CUDA that never fails a scan.

    ``run`` tries the GPU; if that raises (arena out of memory, another CUDA runtime error) the same call is rerun on a CPU
    twin of the model, built lazily with the real ``InferenceSession``, and one line is logged. After
    ``failure_limit()`` failures the model is CPU-only: the GPU session is released (so its memory is free) and the reason
    is shown in Scanner lab, until the model is unloaded and loaded again. Everything else (``get_inputs``,
    ``get_modelmeta``, ...) goes to whichever session is current."""

    def __init__(self, gpu_session, path: str, options, real_class, kind: str, granted_mb: float) -> None:
        self._gpu = gpu_session
        self._cpu = None
        self._path, self._options, self._real, self.kind = path, options, real_class, kind
        self.granted_mb = granted_mb
        self.failures = 0
        self.cpu_only = False
        self.reason: str | None = None
        self._lock = threading.Lock()

    @property
    def on_gpu(self) -> bool:
        return self._gpu is not None

    def _cpu_session(self):
        with self._lock:
            if self._cpu is None:
                self._cpu = self._real(self._path, sess_options=self._options, providers=[CPU])
            return self._cpu

    def run(self, output_names, input_feed, run_options=None):
        gpu = self._gpu
        if gpu is not None:
            try:
                return gpu.run(output_names, input_feed, run_options)
            except Exception as exc:  # noqa: BLE001 - arena out of memory, CUDA runtime error, ...
                self._failed(exc)
        return self._cpu_session().run(output_names, input_feed, run_options)

    def _failed(self, exc: Exception) -> None:
        text = str(exc).strip().splitlines()
        why = text[0][:200] if text else type(exc).__name__
        with self._lock:
            self.failures += 1
            count, limit = self.failures, failure_limit()
        logger.warning("Card matcher: a GPU run of %s failed (%s); rerun on the CPU (%d of %d)", self.kind, why, count, limit)
        if count >= limit and not self.cpu_only:
            self.cpu_only = True
            self.reason = f"{count} GPU runs failed, last: {why}"
            logger.warning("Card matcher: %s is now CPU-only until it is reloaded", self.kind)
            self.release_gpu()

    def release_gpu(self) -> None:
        """Drop the GPU session (freeing its arena) and give its budget back. Idempotent."""
        with self._lock:
            gpu, self._gpu = self._gpu, None
            mb, self.granted_mb = self.granted_mb, 0.0
        if mb:
            release(mb)
        del gpu
        gc.collect()

    def close(self) -> None:
        self.release_gpu()
        with self._lock:
            self._cpu = None

    def __getattr__(self, name):
        if name.startswith("__") or name in {"_gpu", "_cpu", "_lock"}:
            raise AttributeError(name)
        target = self._gpu if self._gpu is not None else self._cpu_session()
        return getattr(target, name)


def ocr_share(path) -> float:
    """The budget share for one of RapidOCR's model files, by its name (..._det_..., ..._cls_..., ..._rec_...)."""
    name = os.path.basename(str(path)).lower()
    for part, share in OCR_SHARES.items():
        if f"_{part}" in name or name.startswith(part):
            return share
    return OCR_DEFAULT_SHARE


def create_session(ort, path: str, options, *, kind: str, share: float = EMBEDDER_SHARE, session_class=None) -> tuple[Any, dict]:
    """An InferenceSession on CUDA when possible, else the CPU. Returns (session, info).

    ``session_class`` is always the real ``InferenceSession``: while RapidOCR is being built ``ort.InferenceSession`` is
    swapped for a factory that calls back into here, so using that attribute would recurse forever."""
    build = session_class or ort.InferenceSession
    mb = budget_mb() * share
    providers, reason = select_providers(ort, int(mb * MB))
    granted = 0.0
    if reason is None:
        if _grant(mb):
            granted = mb
        else:
            reason = "GPU memory budget used by other models"
    if reason is None:
        try:
            session = build(path, sess_options=options, providers=providers)
            used = list(session.get_providers())
            if used and used[0] == CUDA:
                wrapper = GpuSession(session, path, options, build, kind, granted)
                info = {"device": "cuda", "reason": None, "granted_mb": granted, "unloaded_at": None, "wrappers": [wrapper]}
                _record(kind, info)
                _clear_failure_log(kind)
                from . import lifecycle

                lifecycle.ensure_reaper()
                return wrapper, info
            release(granted)
            granted, reason = 0.0, "the CUDA provider was not used by the session"
        except Exception as exc:  # noqa: BLE001 - no device, no libs, out of memory at load, ...
            release(granted)
            text = str(exc).strip().splitlines()
            granted, reason = 0.0, "CUDA failed: " + (text[0][:200] if text else type(exc).__name__)
    if requested() != "cpu":
        _log_fallback(kind, reason)
    session = build(path, sess_options=options, providers=[CPU])
    info = {"device": "cpu", "reason": reason, "granted_mb": 0.0, "unloaded_at": None, "wrappers": []}
    _record(kind, info)
    return session, info


def _clear_failure_log(kind: str) -> None:
    with _lock:
        _reported_failures.discard(kind)


def note_warm(kind: str, seconds: float) -> None:
    _record(kind, {"warm_ms": round(seconds * 1000)})


def mark_unloaded(kind: str) -> None:
    """The model's sessions were released because nothing used them for a while (lifecycle.py)."""
    _record(kind, {"unloaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "granted_mb": 0.0})


def drop(kind: str) -> None:
    """Forget a model's status and give its GPU share back (a deleted custom model, a rebuilt OCR engine)."""
    with _lock:
        info = _status.pop(kind, None)
    for wrapper in (info or {}).get("wrappers", []):
        wrapper.close()


def gpu_used_mb() -> int | None:
    """Memory in use on the whole card (all processes), from nvidia-smi; None if that is not available."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip().splitlines()[0]) if out.returncode == 0 and out.stdout.strip() else None
    except Exception:  # noqa: BLE001
        return None


@contextlib.contextmanager
def ocr_sessions(ort):
    """While RapidOCR builds its sessions, route them through ``create_session``: RapidOCR cannot set a GPU memory
    cap itself. Yields a list that collects each session's info."""
    infos: list[dict] = []
    real = ort.InferenceSession
    real = getattr(real, "real_session", real)  # never build on a leftover factory from an interrupted swap
    targets = [ort]
    for name, module in list(sys.modules.items()):
        if name.startswith("rapidocr_onnxruntime") and getattr(module, "InferenceSession", None) is real:
            targets.append(module)

    def factory(path, sess_options=None, providers=None, **kwargs):
        session, info = create_session(ort, str(path), sess_options, kind="ocr-part", share=ocr_share(path), session_class=real)
        infos.append(info)
        return session

    factory.real_session = real
    for owner in targets:
        owner.InferenceSession = factory
    try:
        yield infos
    except BaseException:
        for info in infos:  # the engine did not come up: give its GPU shares back
            for wrapper in info.get("wrappers", []):
                wrapper.close()
        raise
    finally:
        for owner in targets:
            owner.InferenceSession = real


def summarise_ocr(infos: list[dict]) -> dict:
    """One status for the OCR engine: GPU only if every one of its sessions got it."""
    with _lock:
        _status.pop("ocr-part", None)
    granted = sum(i["granted_mb"] for i in infos)
    wrappers = [w for i in infos for w in i.get("wrappers", [])]
    if infos and all(i["device"] == "cuda" for i in infos):
        info = {"device": "cuda", "reason": None, "granted_mb": granted}
    else:
        reasons = [i["reason"] for i in infos if i.get("reason")]
        info = {"device": "cpu", "reason": reasons[0] if reasons else None, "granted_mb": granted}
    info.update(unloaded_at=None, wrappers=wrappers)
    _record("ocr", info)
    return info


_gpu_name: str | None = None


def gpu_name() -> str | None:
    global _gpu_name
    if _gpu_name is None:
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, timeout=5)
            _gpu_name = (out.stdout.strip().splitlines() or [""])[0] if out.returncode == 0 else ""
        except Exception:  # noqa: BLE001
            _gpu_name = ""
    return _gpu_name or None


def _view(entry: dict | None) -> dict:
    if not entry or "device" not in entry:
        return {"loaded": False, "label": "Not loaded yet"}
    wrappers = entry.get("wrappers", [])
    failures = sum(w.failures for w in wrappers)
    cpu_only = [w for w in wrappers if w.cpu_only]
    where = entry["device"]
    reason = entry.get("reason")
    if where == "cuda" and wrappers and len(cpu_only) == len(wrappers):
        where, reason = "cpu", cpu_only[0].reason  # every session lost the GPU after repeated failures
    elif cpu_only:
        reason = f"{len(cpu_only)} of {len(wrappers)} sessions CPU-only: {cpu_only[0].reason}"
    label = f"GPU ({gpu_name() or 'CUDA'})" if where == "cuda" else "CPU"
    unloaded_at = entry.get("unloaded_at")
    return {
        "loaded": True, "device": where, "label": label, "reason": reason, "warm_ms": entry.get("warm_ms"),
        "state": "unloaded" if unloaded_at else "warm", "unloaded_at": unloaded_at, "gpu_failures": failures,
    }


def report(default_model: str = "dinov2-small") -> dict:
    """For Scanner lab's status: what was asked for and where the embedder and OCR actually run."""
    with _lock:
        snapshot = {key: dict(value) for key, value in _status.items()}
    embedders = {key.split(":", 1)[1]: _view(value) for key, value in snapshot.items() if key.startswith("embedder:")}
    return {
        "requested": requested(), "gpu_budget_mb": budget_mb(), "idle_unload_minutes": _idle_minutes(), "embedders": embedders,
        "embedder": embedders.get(default_model) or (next(iter(embedders.values())) if embedders else _view(None)),
        "ocr": _view(snapshot.get("ocr")),
    }


def _idle_minutes() -> float:
    from . import lifecycle

    return lifecycle.idle_minutes()


def reset_for_tests() -> None:
    global _granted_mb, _gpu_name
    with _lock:
        _granted_mb = 0.0
        _reported_failures.clear()
        _status.clear()
    _gpu_name = None
