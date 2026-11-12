"""The phone settings and the phone bundle (matcher version 11). See docs/CARD_MATCH.md, "Phone settings and bundle".

Two things live here:

* **index8**, the phone's 8-bit index simulated on the server: every row of a picture index is stored as int8 numbers plus one
  float scale (``scale = max|row| / 127``) and dequantised for the cosine search. ``int8_view`` gives the matcher such an index.
* **The bundle**: the files the iPhone will download later (the int8 model, the int8 indexes split per set, the OCR models and
  their character list) and a ``manifest.json`` with a sha256 and size for each. ``build_bundle`` writes it under
  ``<card-match dir>/phone-bundle/v<matcher version>/``; the endpoints in ``api/card_match.py`` serve it.

Index file format (``index/<whole|art>/<set>.bin``, little-endian), read by the phone's JavaScript:

    4 bytes   magic ``PCI8``
    4 bytes   u32 H, the length of the JSON header, which is padded with spaces so that 8 + H is a multiple of 4
    H bytes   JSON ``{"dim": 384, "count": n, "ids": [card id, ...]}`` (card ids as in the server's card table, ``sv1-1_en``)
    n*dim     int8 vectors, row after row
    n*4       float32 scales, one per row   (vector = int8 row * scale)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import struct
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import MATCHER_VERSION, config
from .index import CardIndex

logger = logging.getLogger(__name__)

MAGIC = b"PCI8"
BUNDLE_DIR = "phone-bundle"
MANIFEST = "manifest.json"
INT8_MAX = 127


# ── index8: the phone's 8-bit index, simulated ───────────────────────────────

def quantise_rows(vectors: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """float matrix (n, dim) -> (int8 matrix, float32 scale per row): ``scale = max|row| / 127``."""
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.ndim != 2:
        raise ValueError("vectors must be a matrix")
    scales = (np.abs(vectors).max(axis=1) / INT8_MAX).astype(np.float32) if vectors.size else np.zeros(len(vectors), dtype=np.float32)
    safe = np.where(scales > 0, scales, 1.0).astype(np.float32)
    quantised = np.clip(np.rint(vectors / safe[:, None]), -INT8_MAX, INT8_MAX).astype(np.int8)
    return quantised, scales


def dequantise_rows(quantised: np.ndarray, scales: np.ndarray) -> np.ndarray:
    return quantised.astype(np.float32) * np.asarray(scales, dtype=np.float32)[:, None]


def int8_view(index: CardIndex) -> CardIndex:
    """The same index with its vectors stored as int8 + a scale per row and dequantised in memory (cached on the index object)."""
    cached = index.__dict__.get("_int8_view")
    if cached is not None and len(cached) == len(index):
        return cached
    quantised, scales = quantise_rows(index.vectors)
    view = CardIndex(index.model, dequantise_rows(quantised, scales), list(index.entries), {**index.meta, "index8": True})
    index.__dict__["_int8_view"] = view
    return view


# ── the index files ──────────────────────────────────────────────────────────

def pack_index(ids: list[str], quantised: np.ndarray, scales: np.ndarray) -> bytes:
    count, dim = quantised.shape
    header = json.dumps({"dim": int(dim), "count": int(count), "ids": list(ids)}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    header += b" " * ((-(8 + len(header))) % 4)
    return MAGIC + struct.pack("<I", len(header)) + header + np.ascontiguousarray(quantised, dtype=np.int8).tobytes() + np.ascontiguousarray(scales, dtype="<f4").tobytes()


def unpack_index(data: bytes) -> tuple[list[str], np.ndarray, np.ndarray]:
    """The inverse of ``pack_index`` (the tests, and the later parity checks, read the files with it)."""
    if data[:4] != MAGIC:
        raise ValueError("not a phone index file")
    (header_length,) = struct.unpack("<I", data[4:8])
    header = json.loads(data[8:8 + header_length].decode("utf-8"))
    count, dim = header["count"], header["dim"]
    start = 8 + header_length
    quantised = np.frombuffer(data, dtype=np.int8, count=count * dim, offset=start).reshape(count, dim)
    scales = np.frombuffer(data, dtype="<f4", count=count, offset=start + count * dim)
    return header["ids"], quantised, scales


def set_of(card_id: str) -> str:
    """``sv1-1_en`` -> ``sv1``; ``swsh12tg-TG01_en`` -> ``swsh12tg`` (the part before the last dash of the TCGdex id)."""
    tcg = card_id.rsplit("_", 1)[0] if "_" in card_id else card_id
    return tcg.rsplit("-", 1)[0] if "-" in tcg else tcg


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name) or "_"


def split_by_set(index: CardIndex) -> dict[str, tuple[list[str], np.ndarray, np.ndarray]]:
    """set -> (card ids, int8 rows, scales), sets in name order, cards in index order."""
    quantised, scales = quantise_rows(index.vectors)
    rows: dict[str, list[int]] = {}
    for row, (card_id, _key) in enumerate(index.entries):
        rows.setdefault(set_of(card_id), []).append(row)
    out = {}
    for name in sorted(rows):
        picked = rows[name]
        out[name] = ([index.entries[i][0] for i in picked], quantised[picked], scales[picked])
    return out


# ── the OCR files of the installed wheel ─────────────────────────────────────

def find_ocr_files() -> dict:
    """``{"det": Path, "rec": Path, "characters": str}`` from the installed rapidocr-onnxruntime wheel (the angle model is not
    used: the matcher runs with ``use_cls=False``). The character list is stored inside the recognition model."""
    import rapidocr_onnxruntime
    import onnxruntime as ort

    models = Path(rapidocr_onnxruntime.__file__).resolve().parent / "models"
    det, rec = models / "ch_PP-OCRv4_det_infer.onnx", models / "ch_PP-OCRv4_rec_infer.onnx"
    for path in (det, rec):
        if not path.is_file():
            raise RuntimeError(f"The OCR model {path.name} is missing from the installed wheel")
    session = ort.InferenceSession(str(rec), providers=["CPUExecutionProvider"])
    characters = session.get_modelmeta().custom_metadata_map.get("character")
    if not characters:
        raise RuntimeError("The recognition model carries no character list")
    return {"det": det, "rec": rec, "characters": characters}


# ── building the bundle ──────────────────────────────────────────────────────

def bundle_root(data_dir: Path | None = None) -> Path:
    return (data_dir or config.data_dir()) / BUNDLE_DIR


def bundle_dir(data_dir: Path | None = None, version: str | None = None) -> Path:
    return bundle_root(data_dir) / f"v{version or MATCHER_VERSION}"


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decision_settings() -> dict:
    """The thresholds the phone's matcher must use: read from the server's own constants, never copied by hand."""
    from . import ocr as ocr_module, pipeline

    names = ("SIM_MIN_WITH_RULES", "RANK_MAX_WITH_RULES", "SIM_MIN_PICTURE_ONLY", "LEAD_MIN_PICTURE_ONLY", "SIM_MIN_PICTURE_STRONG",
             "LEAD_MIN_PICTURE_STRONG", "SIM_MIN_NAME_PICTURE", "LEAD_MIN_NAME_PICTURE", "NAME_AGREES", "RANK_MAX_WITH_NAME", "PICTURE_KEEP",
             "LOOKUP_RANK_MAX", "LOOKUP_SIM_SET", "LOOKUP_SIM_TOTAL", "LOOKUP_RANK_MAX_TOTAL", "ORIENT_MARGIN", "TOP_K")
    out = {name.lower(): getattr(pipeline, name) for name in names if hasattr(pipeline, name)}
    out["ocr_accept_confidence"] = ocr_module.ACCEPT_CONFIDENCE
    return out


def build_bundle(
    data_dir: Path | None = None, *, model_file: Path | None = None, verify_model: bool = True, ocr_files: dict | None = None,
    progress=None, fp16_model_file: Path | None = None, whole_name: str | None = None, art_name: str | None = None,
) -> dict:
    """Write ``phone-bundle/v<version>/`` and return its manifest. Raises RuntimeError when the int8 model or an int8 index is missing."""
    from . import embed, index as index_module, variants
    from .model_specs import MODEL_SPECS

    report = progress or (lambda _state: None)
    whole_name, art_name = whole_name or variants.PHONE_INDEX, art_name or variants.PHONE_ART_INDEX
    spec = MODEL_SPECS[variants.PHONE_MODEL]
    model_file = model_file or embed.model_path(variants.PHONE_MODEL)
    if not model_file.is_file():
        raise RuntimeError("The int8 model file is not in this image")
    if verify_model and _sha256_file(model_file) != spec["sha256"]:
        raise RuntimeError("The int8 model file does not match its pinned checksum")
    indexes = {}
    for kind, name in (("whole", whole_name), ("art", art_name)):
        found = index_module.load_index(name, data_dir)
        if found is None or len(found) == 0:
            raise RuntimeError(f"The {kind} int8 index ({name}) is not built yet")
        indexes[kind] = found
    ocr = ocr_files or find_ocr_files()
    webgpu_spec = MODEL_SPECS[variants.FP16_MODEL]
    webgpu_file = fp16_model_file if fp16_model_file is not None else embed.model_path(variants.FP16_MODEL)

    root = bundle_root(data_dir)
    root.mkdir(parents=True, exist_ok=True)
    final = bundle_dir(data_dir)
    temp = root / f".v{MATCHER_VERSION}.{os.getpid()}.tmp"
    shutil.rmtree(temp, ignore_errors=True)
    temp.mkdir(parents=True)
    files: list[dict] = []

    def add(relative: str, data: bytes | None = None, *, source: Path | None = None, kind: str, extra: dict | None = None) -> None:
        target = temp / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if source is not None:
            shutil.copyfile(source, target)
        else:
            target.write_bytes(data or b"")
        files.append({"path": relative, "kind": kind, "size": target.stat().st_size, "sha256": _sha256_file(target), **(extra or {})})

    try:
        report({"phase": "model"})
        add(f"model/{spec['filename']}", source=model_file, kind="model")
        has_webgpu = webgpu_file.is_file() and (not verify_model or _sha256_file(webgpu_file) == webgpu_spec["sha256"])
        if has_webgpu:  # optional: the half-precision model is the WebGPU candidate (WebGPU has no integer kernels)
            add(f"model/{webgpu_spec['filename']}", source=webgpu_file, kind="model-webgpu", extra={"optional": True})
        add("ocr/det.onnx", source=Path(ocr["det"]), kind="ocr")
        add("ocr/rec.onnx", source=Path(ocr["rec"]), kind="ocr")
        add("ocr/characters.txt", str(ocr["characters"]).encode("utf-8"), kind="ocr")
        sets_info: dict[str, dict] = {}
        for kind, found in indexes.items():
            report({"phase": f"index-{kind}"})
            used: set[str] = set()
            for set_name, (ids, quantised, scales) in split_by_set(found).items():
                file_name = _safe_name(set_name)
                while file_name.lower() in used:  # two set ids that differ only in case or odd characters
                    file_name += "_"
                used.add(file_name.lower())
                add(f"index/{kind}/{file_name}.bin", pack_index(ids, quantised, scales), kind=f"index-{kind}", extra={"set": set_name, "count": len(ids)})
                sets_info.setdefault(set_name, {})[kind] = len(ids)
        manifest = {
            "matcher_version": MATCHER_VERSION,
            "built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "option_set": variants.PHONE_LABEL,
            "lite_option_set": variants.PHONE_LITE_LABEL,
            "options": {name: getattr(variants.parse(variants.PHONE_LABEL), name) for name in variants.ORDER},
            "thresholds": decision_settings(),
            "model": {
                "file": f"model/{spec['filename']}", "name": variants.PHONE_MODEL, "dim": spec["dim"], "input_size": spec["input_size"],
                "mean": list(spec["mean"]), "std": list(spec["std"]), "output": spec["output"], "source": spec["source"], "license": spec["license"],
                "weights": "uint8 (onnx/model_quantized.onnx)", "operators": spec.get("operators", []),
                "runtime_note": "ConvInteger and MatMulInteger are implemented for uint8 only in ONNX Runtime's CPU kernels, which onnxruntime-web's WebAssembly backend uses; WebGPU has no integer kernels, and running the uint8 model on WebGPU crashes Safari on iOS 26.6 (measured on an iPhone, also behind a switch): the phone uses fp16 on WebGPU and uint8 on WebAssembly as the fallback",
                "webgpu_candidate": {"file": f"model/{webgpu_spec['filename']}", "name": variants.FP16_MODEL, "weights": "float16", "size": webgpu_spec["size_bytes"],
                                     "sha256": webgpu_spec["sha256"], "in_bundle": has_webgpu, "input": "float32 pixels (the model casts)"},
            },
            "index": {
                "format": "PCI8", "quantisation": "int8, one float32 scale per row (vector = int8 * scale)", "dim": spec["dim"],
                "id_format": "card id of the server's card table (sv1-1_en)", "split": "one file per set and kind",
                "whole_count": len(indexes["whole"]), "art_count": len(indexes["art"]), "sets": sets_info,
            },
            "ocr": {
                "detection": "ocr/det.onnx", "recognition": "ocr/rec.onnx", "characters": "ocr/characters.txt", "angle": None,
                "settings": {"use_cls": False, "det_limit_side_len": 480, "det_limit_type": "max", "rec_img_shape": [3, 48, 320]},
            },
            "files": sorted(files, key=lambda item: item["path"]),
        }
        sizes: dict[str, int] = {}
        for item in files:
            group = item["kind"].split("-")[0]
            sizes[group] = sizes.get(group, 0) + item["size"]
        optional = sum(item["size"] for item in files if item.get("optional"))
        manifest["totals"] = {"files": len(files), "bytes": sum(sizes.values()) - optional, "optional_bytes": optional, "by_kind": sizes}
        (temp / MANIFEST).write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
        shutil.rmtree(final, ignore_errors=True)
        os.replace(temp, final)
    finally:
        shutil.rmtree(temp, ignore_errors=True)
    return manifest


# ── reading the bundle back (the endpoints, Scanner lab) ─────────────────────

def load_manifest(data_dir: Path | None = None) -> dict | None:
    try:
        return json.loads((bundle_dir(data_dir) / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def file_entry(manifest: dict, path: str) -> dict | None:
    """The manifest's entry for exactly this path (the allow-list: nothing outside the manifest is ever served)."""
    for item in manifest.get("files", []):
        if item.get("path") == path:
            return item
    return None


def resolve_file(path: str, data_dir: Path | None = None) -> tuple[Path, dict] | None:
    manifest = load_manifest(data_dir)
    if manifest is None:
        return None
    entry = file_entry(manifest, path)
    if entry is None:
        return None
    base = bundle_dir(data_dir).resolve()
    full = (base / entry["path"]).resolve()
    if base not in full.parents or not full.is_file():
        return None
    return full, entry


def bundle_status(data_dir: Path | None = None) -> dict:
    manifest = load_manifest(data_dir)
    if manifest is None:
        return {"built": False, "matcher_version": MATCHER_VERSION}
    return {
        "built": True, "matcher_version": manifest.get("matcher_version"), "built_at": manifest.get("built_at"),
        "total_bytes": manifest.get("totals", {}).get("bytes"), "optional_bytes": manifest.get("totals", {}).get("optional_bytes"), "files": manifest.get("totals", {}).get("files"),
        "by_kind": manifest.get("totals", {}).get("by_kind"), "option_set": manifest.get("option_set"),
    }


def int8_error(vectors: np.ndarray) -> dict:
    """How much one quantise -> dequantise round trip changes a (unit-vector) matrix: the worst row's cosine with itself."""
    quantised, scales = quantise_rows(vectors)
    back = dequantise_rows(quantised, scales)
    num = (vectors * back).sum(axis=1)
    den = np.linalg.norm(vectors, axis=1) * np.linalg.norm(back, axis=1)
    cosine = num / np.maximum(den, 1e-12)
    return {"min_cosine": float(cosine.min()) if len(cosine) else None, "mean_cosine": float(cosine.mean()) if len(cosine) else None}
