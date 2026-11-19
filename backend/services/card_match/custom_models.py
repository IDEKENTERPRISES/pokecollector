"""Custom picture models: an admin uploads an ONNX model in Scanner lab (docs/CARD_MATCH.md, "Custom picture models").

Files live in the card-match data folder (it persists, unlike the image): ``models/custom-<sha8>.onnx`` plus the
registry ``models/registry.json``. A model is named ``custom-<sha8>`` everywhere (index folders, option words);
its whole-card index is ``custom-<sha8>`` and its artwork index ``custom-<sha8>-art``.

The model must look like the default one: input ``pixel_values`` 1x3x224x224 float32 with ImageNet normalisation,
output ``last_hidden_state`` of shape [1, N, 384] with the CLS token first. Scan photos never touch this module.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO

import numpy as np

from . import config
from .model_specs import DEFAULT_MODEL, MODEL_SPECS

PREFIX = "custom-"
NAME_RE = re.compile(r"^custom-[0-9a-f]{8}$")
MAX_BYTES = 400 * 1024 * 1024
MAX_DISPLAY_NAME = 60
MISSING_NAME = "custom-none"  # stands for "no custom model uploaded yet": never built, so a custom row shows it as missing
_lock = threading.Lock()


class CustomModelError(Exception):
    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.status = status


def is_custom_name(name: str) -> bool:
    return bool(NAME_RE.match(name or ""))


def models_dir(data_dir: Path | None = None) -> Path:
    return (data_dir or config.data_dir()) / "models"


def registry_path(data_dir: Path | None = None) -> Path:
    return models_dir(data_dir) / "registry.json"


def art_name(name: str) -> str:
    return f"{name}-art"


def model_file(name: str, data_dir: Path | None = None) -> Path:
    return models_dir(data_dir) / f"{name}.onnx"


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def list_models(data_dir: Path | None = None) -> list[dict]:
    """Registry entries, oldest first."""
    try:
        entries = json.loads(registry_path(data_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [entry for entry in entries if isinstance(entry, dict) and is_custom_name(entry.get("id", ""))]


def get_model(name: str, data_dir: Path | None = None) -> dict | None:
    return next((entry for entry in list_models(data_dir) if entry["id"] == name), None)


def newest(data_dir: Path | None = None) -> dict | None:
    models = list_models(data_dir)
    return max(models, key=lambda entry: entry.get("uploaded_at", "")) if models else None


def newest_name(data_dir: Path | None = None) -> str:
    entry = newest(data_dir)
    return entry["id"] if entry else MISSING_NAME


def spec_for(name: str, data_dir: Path | None = None) -> dict:
    """The same shape as a MODEL_SPECS entry, for the embedder."""
    entry = get_model(name, data_dir)
    if entry is None:
        raise ValueError(f"Unknown custom card-match model {name!r}")
    return {
        "sha256": entry["sha256"], "filename": f"{name}.onnx", "dim": entry["dim"], "input_size": entry["input_size"],
        "mean": tuple(entry["mean"]), "std": tuple(entry["std"]), "output": "cls",
    }


def _write_registry(entries: list[dict], data_dir: Path | None) -> None:
    path = registry_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(entries, indent=1), encoding="utf-8")
    os.replace(temp, path)


def validate_onnx(path: Path) -> dict:
    """Run one 1x3x224x224 zeros input through the file. Returns {"dim", "tokens"}; raises CustomModelError."""
    import onnxruntime as ort

    size = MODEL_SPECS[DEFAULT_MODEL]["input_size"]
    dim = MODEL_SPECS[DEFAULT_MODEL]["dim"]
    options = ort.SessionOptions()
    options.intra_op_num_threads = config.threads()
    try:
        session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
    except Exception as exc:
        raise CustomModelError("The file is not an ONNX model this server can load") from exc
    inputs = session.get_inputs()
    if len(inputs) != 1:
        raise CustomModelError("The model must have exactly one input (pixel_values)")
    try:
        output = session.run(None, {inputs[0].name: np.zeros((1, 3, size, size), dtype=np.float32)})[0]
    except Exception as exc:
        raise CustomModelError(f"The model does not run on a 1x3x{size}x{size} float32 input") from exc
    shape = tuple(np.asarray(output).shape)
    if len(shape) != 3 or shape[0] != 1 or shape[1] < 1 or shape[2] != dim:
        raise CustomModelError(f"The model's first output must have shape [1, N, {dim}] (last_hidden_state, CLS token first); this one is {list(shape)}")
    if not np.all(np.isfinite(output)):
        raise CustomModelError("The model's output has values that are not numbers")
    return {"dim": shape[2], "tokens": shape[1]}


def clean_display_name(value: str | None) -> str:
    return " ".join((value or "").split())[:MAX_DISPLAY_NAME]


def save_upload(source: BinaryIO, display_name: str, uploaded_by: str, *, data_dir: Path | None = None, max_bytes: int | None = None) -> dict:
    """Stream ``source`` to a temp file in the models folder (never held in memory), check size, sha256 and that it runs,
    then store it as ``custom-<sha8>.onnx`` with a registry entry. Returns the entry."""
    max_bytes = MAX_BYTES if max_bytes is None else max_bytes
    display_name = clean_display_name(display_name)
    if not display_name:
        raise CustomModelError("Give the model a short name")
    folder = models_dir(data_dir)
    folder.mkdir(parents=True, exist_ok=True)
    temp = folder / f".upload-{os.getpid()}-{threading.get_ident()}.tmp"
    digest = hashlib.sha256()
    size = 0
    try:
        with temp.open("wb") as out:
            while True:
                chunk = source.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise CustomModelError(f"The file is over the {max_bytes // (1024 * 1024)} MB limit", 413)
                digest.update(chunk)
                out.write(chunk)
        if size == 0:
            raise CustomModelError("The file is empty")
        sha = digest.hexdigest()
        name = f"{PREFIX}{sha[:8]}"
        with _lock:
            if get_model(name, data_dir) is not None:
                raise CustomModelError("This model is already uploaded", 409)
        info = validate_onnx(temp)
        entry = {
            "id": name, "name": display_name, "sha256": sha, "size_bytes": size, "uploaded_by": uploaded_by, "uploaded_at": _now(),
            "input_size": MODEL_SPECS[DEFAULT_MODEL]["input_size"], "mean": list(MODEL_SPECS[DEFAULT_MODEL]["mean"]),
            "std": list(MODEL_SPECS[DEFAULT_MODEL]["std"]), "dim": info["dim"], "tokens": info["tokens"],
        }
        with _lock:
            os.replace(temp, model_file(name, data_dir))
            _write_registry(list_models(data_dir) + [entry], data_dir)
        return entry
    finally:
        temp.unlink(missing_ok=True)


def delete_model(name: str, data_dir: Path | None = None) -> dict:
    """Remove the registry entry, the file and both indexes. Returns the removed entry."""
    from . import embed, index as index_module

    with _lock:
        entry = get_model(name, data_dir)
        if entry is None:
            raise CustomModelError("Unknown model", 404)
        _write_registry([e for e in list_models(data_dir) if e["id"] != name], data_dir)
    model_file(name, data_dir).unlink(missing_ok=True)
    for index_name in (name, art_name(name)):
        directory = index_module.index_dir(index_name, data_dir)
        shutil.rmtree(directory, ignore_errors=True)
        with index_module._loaded_lock:
            index_module._loaded.pop(f"{directory}", None)
    embed.forget(name)
    return entry


def index_names(name: str) -> dict[str, str]:
    return {"whole": name, "art": art_name(name)}


# ── Calibrated picture thresholds (version 16 test, ``calibration.py``) ──────────────────────────────────────────

def calibrated_thresholds(entry: dict | None) -> dict | None:
    """The calibrated table stored in a registry entry (``{threshold name: value}``), or None when it has none."""
    table = ((entry or {}).get("calibration") or {}).get("thresholds")
    return dict(table) if isinstance(table, dict) and table else None


def store_calibration(name: str, calibration: dict, data_dir: Path | None = None) -> dict:
    """Keep ``calibration`` (``at``, ``scans``, ``thresholds``, ``default``, ...) in the model's registry entry, so deleting the model removes it
    too. Returns the updated entry; raises ``CustomModelError`` (404) for an unknown model."""
    with _lock:
        entries = list_models(data_dir)
        entry = next((e for e in entries if e["id"] == name), None)
        if entry is None:
            raise CustomModelError("Unknown model", 404)
        entry["calibration"] = calibration
        _write_registry(entries, data_dir)
    return entry
