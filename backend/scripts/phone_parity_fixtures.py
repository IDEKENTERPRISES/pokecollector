#!/usr/bin/env python3
"""Write the parity fixtures for the phone's JavaScript matcher (matcher version 11).

    py backend/scripts/phone_parity_fixtures.py [out_dir] [--photos N] [--real-model]

Default out_dir: frontend/tests/fixtures/phone-matcher/v<matcher version>/. Writes

  pure-functions.json   inputs and outputs of the pure Python functions (number and name parsing, constrained reading, lookup,
                        the decision rules, the int8 quantiser), all from hand-written strings and catalogue-like rows;
  photos.json           for a few generated photos: the found quad, the flattened size, the model input tensor's checksum and
                        statistics, and the int8 embedding's first values, scale and norm;
  photos/photo-N.jpg    the generated photos themselves (drawn cards on generated backgrounds, downscaled): the JavaScript
                        side reads these same bytes.

Nothing here comes from a trainer's scan or from a catalogue picture: the cards are drawn by ``ocr_synthetic.render_card`` and the
photos made by ``synthetic.make_photo``. By default the embedding is the test ``FakeEmbedder`` (reproducible anywhere, no model file);
``--real-model`` uses the pinned int8 DINOv2-small model when its file is present (then ``embedder`` says ``dinov2-small-int8``).
Photos are drawn with the fonts of the machine that runs this, so regenerate the JPEGs together with the JSON, never one alone.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import os  # noqa: E402
import types  # noqa: E402

if os.name == "nt":  # api.recognize imports fcntl through the auth service; the servers and CI are Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

import numpy as np  # noqa: E402

PHOTO_LONG_SIDE = 1024  # the stored fixture photos are downscaled to this (keeps each JPEG around 100 kB)


def default_out_dir() -> Path:
    from services.card_match import MATCHER_VERSION

    return HERE.parents[1] / "frontend" / "tests" / "fixtures" / "phone-matcher" / f"v{MATCHER_VERSION}"


def _round(value, digits: int = 5):
    return round(float(value), digits)


# ── pure functions ───────────────────────────────────────────────────────────

PARSE_TEXT_INPUTS = [
    ["018/091"], ["MEW EN 018/091"], ["018091"], ["58102"], ["30C | 017/128", "Illus. Someone"], ["PBL039/084"], ["TG06/TG30"],
    ["SWSH020"], ["SV28/SV94"], ["HP 70", "Pikachu", "025/165 SVI"], ["O18/O91"], ["112/113", "TWM"], ["nothing useful here"], [],
]
NUMBER_LINES = [  # (text, confidence, y0)
    [("018/091", 0.95, 840), ("MEW EN", 0.7, 840)],
    [("0", 0.5, 840), ("18", 0.6, 840), ("091", 0.9, 850)],
    [("30C | 017/128", 0.9, 850), ("Illus. Someone", 0.8, 860)],
    [("018091", 0.8, 850)],
    [("PAL 12", 0.7, 850), ("113", 0.7, 860)],
]
NAME_STRIPS = [
    ["Pikachu", "HP 70"], ["BASIC", "Mew ex", "HP 180"], ["Stage 1", "Dragonair", "Evolves from Dratini"], [("Charizard ex", 40.0), ("Pokemonex | nocked Out", 22.0)],
    ["SUPPORTER", "Professor's Research"], ["Nintendo/Creatures Inc./GAME FREAK inc."], ["Pikachu 0"], ["Energy Retrieval"], [""],
]
IS_NAME_LIKE = ["Pikachu", "Charizard ex", "You may play only 1 Supporter card during your turn", "Nintendo/Creatures/GAMEFREAK", "018/091", "a b c d e f"]
NAME_KEYS = ["Mew ex", "Pikachu V", "Misty's Vitality", "Erika's Invitation (Giovanni)", "Flabébé"]
CONSTRAINED = [
    {"lines": ["12/13"], "candidates": [{"number": "112", "printed_total": "113"}, {"number": "5", "printed_total": "113"}]},
    {"lines": ["69197"], "candidates": [{"number": "69", "printed_total": "97"}, {"number": "70", "printed_total": "97"}]},
    {"lines": ["018/091"], "candidates": [{"number": "018", "printed_total": "091"}, {"number": "018", "printed_total": "091"}]},
    {"lines": ["no digits"], "candidates": [{"number": "1", "printed_total": "10"}]},
    {"lines": ["7/10", "2/10"], "candidates": [{"number": "7", "printed_total": "10"}, {"number": "2", "printed_total": "10"}]},
]
DECIDE_CANDIDATES = [
    {"tcg_card_id": "a-1", "number": "1", "printed_total": "10", "_similarity": 0.9, "_rank": 1, "_db_id": "a-1_en"},
    {"tcg_card_id": "b-5", "number": "5", "printed_total": "10", "_similarity": 0.3, "_rank": 2, "_db_id": "b-5_en"},
]
DECIDE_CASES = [
    ({"number_local": "5", "number_total": "10"}, DECIDE_CANDIDATES, {}),
    ({"number_local": "1", "number_total": "10"}, DECIDE_CANDIDATES, {}),
    ({}, [{"number": "1", "_similarity": 0.95, "_rank": 1, "_db_id": "a", "tcg_card_id": "a"}, {"number": "2", "_similarity": 0.7, "_rank": 2, "_db_id": "b", "tcg_card_id": "b"}], {}),
    ({}, [{"number": "1", "_similarity": 0.95, "_rank": 1, "_db_id": "a", "tcg_card_id": "a"}, {"number": "2", "_similarity": 0.94, "_rank": 2, "_db_id": "b", "tcg_card_id": "b"}], {}),
    ({"number_local": "77", "number_total": "5"}, [{"number": "1", "_similarity": 0.95, "_rank": 1, "_db_id": "a", "tcg_card_id": "a"}, {"number": "2", "_similarity": 0.70, "_rank": 2, "_db_id": "b", "tcg_card_id": "b"}], {}),
    ({"number_local": "1", "number_total": "10"}, DECIDE_CANDIDATES, {"fallback": True, "number_read": False}),
]
LOOKUP_ROWS = [
    ("pal-17_en", "Lapras", "017", "128", "xx1", None), ("zzz-17_en", "Lapras", "017", "198", "xx2", None), ("yyy-17_en", "Lapras", "017", "128", "xx3", None),
    ("pal-18_en", "Dragonair", "018", "128", "xx1", None), ("tg-6_en", "Charizard", "TG06", "30", "xx4", None), ("swsh-20_en", "Pikachu", "SWSH020", None, "swshp", None),
    ("mew_en", "Mew ex", "053", "091", "xx6", "ex"),
]
LOOKUP_QUERIES = [
    {"lines": ["30C | 017/128", "Illus. Someone"], "number": "30C", "total": "017", "tokens": []},
    {"lines": ["017/128"], "number": "017", "total": "128", "tokens": ["PAL"]},
    {"lines": ["TG06/TG30"], "number": "TG06", "total": "TG30", "tokens": []},
    {"lines": ["053/091", "Genome Hacking"], "number": "053", "total": "091", "tokens": []},
]


def pure_function_cases() -> dict:
    from api import recognize as rules  # noqa: F401  (decide imports it; fail early with a clear error)
    from services.card_match import constrained, lookup, names, ocr, phone, pipeline

    def read_dict(result) -> dict:
        return {"number_local": result.number_local, "number_total": result.number_total, "hp": result.hp, "tokens": list(result.tokens)}

    out: dict = {}
    out["parse_text"] = [{"input": lines, "output": read_dict(ocr.parse_text(list(lines)))} for lines in PARSE_TEXT_INPUTS]
    pick = []
    for lines in NUMBER_LINES:
        objects = [ocr.Line(text, score, 0, y, 100, y + 20) for text, score, y in lines]
        result, confidence = ocr.pick_number_lines(objects)
        pick.append({"input": [{"text": t, "score": s, "y0": y} for t, s, y in lines], "output": {**read_dict(result), "confidence": confidence}})
    out["pick_number_lines"] = pick
    out["is_name_like"] = [{"input": text, "output": bool(ocr.is_name_like(text))} for text in IS_NAME_LIKE]
    out["parse_name_lines"] = [
        {"input": [list(item) if isinstance(item, tuple) else item for item in items],
         "output": {"name": (read := names.parse_name_lines(items)).name, "hp": read.hp}}
        for items in NAME_STRIPS
    ]
    out["name_keys"] = [{"input": text, "key": names.name_key(text), "base_key": names.base_key(text), "clean_line": names.clean_name_line(text)} for text in NAME_KEYS]
    name_rows = [names.NameRow(card_id, name, number, total) for card_id, name, number, total, _set, _suffix in LOOKUP_ROWS]
    name_index = names.NameIndex(name_rows)
    out["name_search"] = [
        {"input": {"name": read, "number": number, "total": total},
         "output": [[hit.card_id, _round(hit.name_score, 4), hit.number_ok, hit.total_ok] for hit in name_index.search(read, number, total)]}
        for read, number, total in (("Lapras", "017", "128"), ("Lapra", None, None), ("Charizrd", None, None), ("Mew ex", "053", "091"), ("Nothing Like It", None, None))
    ]
    out["constrain"] = []
    for case in CONSTRAINED:
        found = constrained.constrain(case["lines"], case["candidates"])
        out["constrain"].append({"input": case, "output": None if found is None else {
            "index": found.index, "number": found.number, "total": found.total, "distance": _round(found.distance), "runner_up": None if found.runner_up is None else _round(found.runner_up)}})
    lookup_rows = [lookup.LookupRow(card_id, name, number, total, set_id=set_id, suffix=suffix,
                                    texts=lookup.card_texts(None, [{"name": "Genome Hacking", "effect": "Choose 1 of your opponent's Active Pokemon's attacks and use it as this attack."}], None) if name == "Mew ex" else [])
                   for card_id, name, number, total, set_id, suffix in LOOKUP_ROWS]
    lookup_index = lookup.LookupIndex(lookup_rows, {"PAL": ["xx1"], "TWM": ["xx2"]})
    out["lookup_rows"] = [{"card_id": r[0], "name": r[1], "number": r[2], "printed_total": r[3], "set_id": r[4], "suffix": r[5]} for r in LOOKUP_ROWS]
    out["lookup_set_codes"] = {"PAL": ["xx1"], "TWM": ["xx2"]}
    out["number_pairs"] = [{"input": {"lines": q["lines"], "number": q["number"], "total": q["total"]},
                            "output": [list(pair) for pair in lookup.number_pairs(q["lines"], q["number"], q["total"])]} for q in LOOKUP_QUERIES]
    out["lookup_search"] = [{"input": q, "output": lookup_index.search(list(q["lines"]), q["number"], q["total"], q["tokens"]).trace()} for q in LOOKUP_QUERIES]
    decide = []
    for card_info, candidates, options in DECIDE_CASES:
        chosen, reason = pipeline.decide(dict(card_info), [dict(c) for c in candidates], **options)
        decide.append({"input": {"card_info": card_info, "candidates": candidates, "options": options},
                       "output": {"mechanism": chosen["mechanism"] if chosen else None, "tcg_card_id": chosen["candidate"].get("tcg_card_id") if chosen else None, "reason": reason}})
    out["decide"] = decide
    thresholds = pipeline_thresholds()
    out["thresholds"] = thresholds
    rng = np.random.default_rng(11)
    sample = rng.standard_normal((4, 16)).astype(np.float32)
    sample[3] = 0
    quantised, scales = phone.quantise_rows(sample)
    out["quantise_rows"] = {"input": [[_round(v, 6) for v in row] for row in sample], "int8": quantised.tolist(), "scales": [_round(v, 8) for v in scales],
                            "dequantised": [[_round(v, 6) for v in row] for row in phone.dequantise_rows(quantised, scales)]}
    return out


def pipeline_thresholds() -> dict:
    from services.card_match import phone

    return phone.decision_settings()


# ── generated photos ─────────────────────────────────────────────────────────

def _embedder(real: bool):
    from services.card_match import embed, variants

    if real and embed.model_available(variants.PHONE_MODEL):
        return embed.OnnxEmbedder(variants.PHONE_MODEL), variants.PHONE_MODEL
    return embed.FakeEmbedder(), "fake"


def photo_cases(out_dir: Path, count: int, real_model: bool) -> dict:
    import io

    from PIL import Image

    from services.card_match import detect, embed, images, ocr_synthetic, phone, synthetic
    from services.card_match.model_specs import MODEL_SPECS, DEFAULT_MODEL

    spec = MODEL_SPECS[DEFAULT_MODEL]
    mean, std = np.array(spec["mean"], dtype=np.float32).reshape(1, 1, 3), np.array(spec["std"], dtype=np.float32).reshape(1, 1, 3)
    embedder, embedder_name = _embedder(real_model)
    (out_dir / "photos").mkdir(parents=True, exist_ok=True)
    cases = []
    for number in range(1, count + 1):
        card, truth = ocr_synthetic.render_card(100 + number)
        jpeg_big, _corners, settings = synthetic.make_photo(card, 100 + number)
        big = Image.open(io.BytesIO(jpeg_big)).convert("RGB")
        scale = PHOTO_LONG_SIDE / max(big.size)
        small = big.resize((round(big.width * scale), round(big.height * scale)), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        small.save(buffer, "JPEG", quality=85)
        name = f"photo-{number}.jpg"
        (out_dir / "photos" / name).write_bytes(buffer.getvalue())
        # Everything below is computed from the stored JPEG, exactly as the JavaScript side will read it.
        photo = images.decode_rgb((out_dir / "photos" / name).read_bytes())
        detection = detect.detect_card(photo, check=True)
        tensor = embed.preprocess(detection.card, spec["input_size"], mean, std)
        vector = embedder.embed([detection.card])[0]
        quantised, scales = phone.quantise_rows(vector[None, :])
        cases.append({
            "photo": f"photos/{name}", "settings": settings, "truth": {"name": truth.name, "number": truth.number, "total": truth.total, "set_code": truth.set_code, "hp": truth.hp},
            "photo_size": [photo.shape[1], photo.shape[0]], "photo_rgb_sha256": hashlib.sha256(photo.tobytes()).hexdigest(),
            "detection": {"found": detection.found, "method": detection.method, "confidence": detection.confidence, "corners": [[_round(x, 2), _round(y, 2)] for x, y in detection.corners],
                          "flat_size": [detection.card.shape[1], detection.card.shape[0]], "flat_rgb_sha256": hashlib.sha256(np.ascontiguousarray(detection.card).tobytes()).hexdigest()},
            "tensor": {"shape": list(tensor.shape), "sha256": hashlib.sha256(np.ascontiguousarray(tensor, dtype="<f4").tobytes()).hexdigest(),
                       "mean": _round(tensor.mean(), 5), "std": _round(tensor.std(), 5), "first_values": [_round(v, 5) for v in tensor.reshape(-1)[:8]]},
            "embedding": {"embedder": embedder_name, "dim": int(vector.shape[0]), "float_norm": _round(np.linalg.norm(vector), 5), "int8_first_values": quantised[0][:12].tolist(),
                          "int8_scale": _round(scales[0], 8), "int8_norm": _round(np.linalg.norm(phone.dequantise_rows(quantised, scales)[0]), 5)},
        })
    return {"embedder": embedder_name, "preprocess": {"size": spec["input_size"], "mean": list(spec["mean"]), "std": list(spec["std"]), "layout": "CHW float32"}, "cases": cases}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out_dir", nargs="?", type=Path)
    parser.add_argument("--photos", type=int, default=3)
    parser.add_argument("--real-model", action="store_true", help="use the int8 model for the embedding fields when its file is present")
    args = parser.parse_args(argv)
    from services.card_match import MATCHER_VERSION

    out_dir = args.out_dir or default_out_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    header = {"matcher_version": MATCHER_VERSION, "note": "Generated by backend/scripts/phone_parity_fixtures.py from generated cards and hand-written strings only."}
    (out_dir / "pure-functions.json").write_text(json.dumps({**header, **pure_function_cases()}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    (out_dir / "photos.json").write_text(json.dumps({**header, **photo_cases(out_dir, args.photos, args.real_model)}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote the phone parity fixtures for matcher version {MATCHER_VERSION} to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
