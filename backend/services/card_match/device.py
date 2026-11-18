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
import logging
import os
import subprocess
import sys
import threading
from typing import Any

logger = logging.getLogger(__name__)

CPU = "CPUExecutionProvider"
CUDA = "CUDAExecutionProvider"
MB = 1024 * 1024

# Share of the budget per session, planned so a healthy start fits: picture model 0.5, OCR detector 0.2, recogniser 0.2,
# direction classifier 0.05 (RapidOCR loads it even with use_cls=False; it is tiny) = 0.95. The rest is headroom.
EMBEDDER_SHARE = 0.5
OCR_SHARES = {"det": 0.2, "rec": 0.2, "cls": 0.05}
OCR_DEFAULT_SHARE = 0.2
MAX_GPU_BATCH = 16  # a bigger batch on the card could exceed the cap; the index build uses 16

_lock = threading.Lock()
_granted_mb = 0.0
_reported_failures: set[str] = set()
_status: dict[str, dict] = {}


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
                info = {"device": "cuda", "reason": None, "granted_mb": granted}
                _record(kind, info)
                return session, info
            release(granted)
            granted, reason = 0.0, "the CUDA provider was not used by the session"
        except Exception as exc:  # noqa: BLE001 - no device, no libs, out of memory at load, ...
            release(granted)
            text = str(exc).strip().splitlines()
            granted, reason = 0.0, "CUDA failed: " + (text[0][:200] if text else type(exc).__name__)
    if requested() != "cpu":
        _log_fallback(kind, reason)
    session = build(path, sess_options=options, providers=[CPU])
    info = {"device": "cpu", "reason": reason, "granted_mb": 0.0}
    _record(kind, info)
    return session, info


def note_warm(kind: str, seconds: float) -> None:
    _record(kind, {"warm_ms": round(seconds * 1000)})


def drop(kind: str) -> None:
    """Forget a model's status and give its GPU share back (a deleted custom model, a rebuilt OCR engine)."""
    with _lock:
        info = _status.pop(kind, None)
    if info and info.get("granted_mb"):
        release(info["granted_mb"])


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
            release(info["granted_mb"])
        raise
    finally:
        for owner in targets:
            owner.InferenceSession = real


def summarise_ocr(infos: list[dict]) -> dict:
    """One status for the OCR engine: GPU only if every one of its sessions got it."""
    with _lock:
        _status.pop("ocr-part", None)
    granted = sum(i["granted_mb"] for i in infos)
    if infos and all(i["device"] == "cuda" for i in infos):
        info = {"device": "cuda", "reason": None, "granted_mb": granted}
    else:
        reasons = [i["reason"] for i in infos if i.get("reason")]
        info = {"device": "cpu", "reason": reasons[0] if reasons else None, "granted_mb": granted}
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
    on_gpu = entry["device"] == "cuda"
    label = f"GPU ({gpu_name() or 'CUDA'})" if on_gpu else "CPU"
    return {"loaded": True, "device": entry["device"], "label": label, "reason": entry.get("reason"), "warm_ms": entry.get("warm_ms")}


def report(default_model: str = "dinov2-small") -> dict:
    """For Scanner lab's status: what was asked for and where the embedder and OCR actually run."""
    with _lock:
        snapshot = {key: dict(value) for key, value in _status.items()}
    embedders = {key.split(":", 1)[1]: _view(value) for key, value in snapshot.items() if key.startswith("embedder:")}
    return {
        "requested": requested(), "gpu_budget_mb": budget_mb(), "embedders": embedders,
        "embedder": embedders.get(default_model) or (next(iter(embedders.values())) if embedders else _view(None)),
        "ocr": _view(snapshot.get("ocr")),
    }


def reset_for_tests() -> None:
    global _granted_mb, _gpu_name
    with _lock:
        _granted_mb = 0.0
        _reported_failures.clear()
        _status.clear()
    _gpu_name = None
