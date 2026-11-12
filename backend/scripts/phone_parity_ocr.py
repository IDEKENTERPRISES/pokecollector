#!/usr/bin/env python3
"""Write the parity fixtures for the phone's JavaScript text reader (step 3b, matcher version 11).

    python backend/scripts/phone_parity_ocr.py [out_dir] [--no-models]

Needs ``rapidocr-onnxruntime`` (the server's version, 1.3.24), ``opencv-python-headless``, ``numpy`` and ``Pillow``.
Default out_dir: frontend/tests/fixtures/phone-matcher/v<matcher version>/ocr/. Writes

  ocr-pure.json     inputs and outputs of the pure Python functions (``parse_text``, ``pick_number_lines``, ``better_read``,
                    ``merge_reads``, ``is_name_like``, ``clean_name_line``, ``parse_name_lines``, ``find_hp``), from hand-written
                    strings only (they add to ``pure-functions.json`` of step 1);
  ocr-ops.json      small pictures run through the OpenCV operations the reader uses (cubic zoom, unsharp mask, CLAHE, bilinear
                    resize, perspective crop), inputs and outputs as bytes;
  ocr-post.json     hand-drawn detection maps run through RapidOCR's DB post-processing: the boxes and scores it produced;
  ocr-cases.json    generated cards read by the real ``OcrReader`` (fast ladders, the fast whole-picture second read): for every
                    detector and recogniser call the shapes, the detection map (8-bit), the boxes RapidOCR made and each crop's
                    recognised text and score; and the final reading of each call;
  ocr/cards/*.png   the generated cards (drawn here, fonts of the machine that runs this: regenerate PNGs and JSON together);
  characters.txt    the recogniser's character list, from the model's own metadata.

Everything comes from generated cards and hand-written strings: no trainer's scan and no catalogue picture is used.
The models' outputs are recorded the way the JavaScript side can replay them: the detection map as 8-bit probabilities and each
recogniser step as (best class, probability to four decimals). The Python reader itself runs on exactly these values, so the
recorded final readings are what the replay must reproduce. Time budgets are switched off (``1e9`` seconds) so nothing depends
on how fast this machine is.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import types
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

if os.name == "nt":  # api.recognize imports fcntl through the auth service; the servers and CI are Linux
    _fcntl = types.ModuleType("fcntl")
    _fcntl.LOCK_EX = _fcntl.LOCK_UN = 0
    _fcntl.flock = _fcntl.lockf = lambda *args, **kwargs: None
    sys.modules.setdefault("fcntl", _fcntl)

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter, ImageFont  # noqa: E402


def default_out_dir() -> Path:
    from services.card_match import MATCHER_VERSION

    return HERE.parents[1] / "frontend" / "tests" / "fixtures" / "phone-matcher" / f"v{MATCHER_VERSION}" / "ocr"


def pack(array: np.ndarray) -> str:
    """Bytes of an array, deflated, as base64."""
    return base64.b64encode(zlib.compress(np.ascontiguousarray(array).tobytes(), 9)).decode("ascii")


# ── pure functions ───────────────────────────────────────────────────────────

PARSE_INPUTS = [
    ["125/197"], ["TG06/TG30"], ["SWSH001"], ["SVI EN 018/091"], ["SVIEN018091"], ["58/102", "Illus. Someone"], ["GG12/GG70"],
    ["O18/091"], ["018|091"], ["018 | 091"], ["GAMEFREAK1999Wizards.58/102"], ["SVP 045"], ["SWSH-062"], ["HP 130", "Pikachu"], ["70 HP"],
    ["MEW EN 018/091", "HP 70"], ["SSP EN 038/270"], ["PAL 125/193 EN"], ["125/197", "126/197"], ["Illus. Mitsuhiro Arita", "0l8/09l"],
    ["TG06 / TG30"], ["10/10"], ["1/9"], ["SM123"], ["XY-99"], ["BW 7"], ["", ""], [], ["no number here"], ["PV 90", "125/197"],
    ["105/ I98"], ["30C | 017/128", "Illus. Someone"], ["PBL039/084"], ["123456"], ["12345"], ["SVI EN 000000"], ["KP 110"], ["2024 Pokemon 059/165"],
    ["ex", "Basic"], ["MEP 012", "MEE 005"], ["201/191 SIR"], ["H12/H32"], ["RC12/RC25"],
]
LINE_SETS = [
    [("018/091", 0.95), ("MEW EN", 0.7)],
    [("MEW EN 018", 0.9), ("091", 0.8)],
    [("SVI EN 125/197", 0.88), ("125/197", 0.93)],
    [("018091", 0.9), ("12/34", 0.5)],
    [("SWSH001", 0.97), ("Illus.", 0.6)],
    [("45/50", 0.4), ("12|99", 0.99)],
    [("Illus. Someone", 0.8)],
    [("TG06/TG30", 0.91), ("HP 120", 0.9)],
    [("30C | 017/128", 0.77), ("30", 0.5)],
    [],
]
NAME_LINES = [
    "Pikachu", "Mew ex", "BASIC Pikachu", "Stage 1 Charizard ex", "Evolves from Charmeleon", "Charizard ex HP 330", "Pikachu 0",
    "Boss's Orders", "Professor's Research", "Illus. Someone", "Item", "Supporter", "Pokémon Tool", "Flabébé", "Mr. Mime", "Farfetch'd",
    "Nidoran♀", "Once during your turn, you may attach", "Iono", "2024 Pokemon", "", "PV 90", "Tapu Koko-GX", "Radiant Charizard",
    "Stage 2 Venusaur VMAX", "Restored Aerodactyl", "Eevee HP 60", "Charizrd ex", "Pokémon", "of the", "Ho-Oh ex", "N's Zoroark ex",
    "Arceus VSTAR", "Rare Candy", "Judge 070/198", "knocked out", "Your opponent flips a coin", "Mimikyu 70 HP", "a b", "ab",
]
NAME_ENTRY_SETS = [
    [("Pikachu", 20.0), ("HP 70", 12.0)],
    [("BASIC", 14.0), ("Mew ex", 22.0), ("HP 180", 12.0)],
    [("Evolves from Charmeleon", 10.0), ("Charizard ex", 24.0)],
    [("Item", 14.0), ("Rare Candy", 21.0)],
    [("Once during your turn, you may", 12.0), ("Dhelmise", 20.0)],
    [("Pikachu", None), ("Raichu", None)],
    [],
    [("PV 90", 12.0), ("Piplup", 18.0)],
]
MERGE_SCENARIOS = [
    # (old lines, old confidence, new lines, new confidence, source, prefix)
    (["018/091"], 0.9, ["018/091"], 0.8, "whole_picture", "whole-"),
    (["018"], 0.5, ["018/091"], 0.4, "whole_picture", "whole-"),
    (["018/091"], 0.5, ["12/34"], 0.9, "whole_picture", "whole-"),
    ([], None, ["SWSH001"], 0.9, "whole_picture", "whole-"),
    (["018/091"], 0.6, [], None, None, ""),
    ([], None, ["018/091"], 0.7, None, ""),
    (["TG06/TG30"], 0.6, ["TG06/TG30"], 0.95, "whole_picture", "whole-"),
    (["HP 90"], None, ["018/091", "HP 70"], 0.9, "whole_picture", "whole-"),
    (["MEW EN 018"], 0.8, ["SVI 019/091"], 0.8, "whole_picture", "whole-"),
    ([], None, [], None, "whole_picture", "whole-"),
]


def reading_to_json(result) -> dict:
    return {
        "number": result.number_local, "total": result.number_total, "hp": result.hp, "tokens": list(result.tokens),
        "lines": [str(line) for line in result.lines], "confidence": result.number_confidence, "source": result.number_source,
        "seconds": result.seconds, "attempts": result.attempts, "flipped": result.flipped,
        "strips": [{"label": strip.get("label"), "source": strip.get("source")} for strip in result.strips],
    }


def pure_cases() -> dict:
    from services.card_match import names, ocr

    out: dict = {"parse_text": [], "pick_number_lines": [], "merge_reads": [], "clean_name_line": [], "is_name_like": [], "parse_name_lines": [], "find_hp": []}
    for lines in PARSE_INPUTS:
        result = ocr.parse_text(lines)
        out["parse_text"].append({"input": lines, "output": {"number": result.number_local, "total": result.number_total, "hp": result.hp, "tokens": result.tokens, "complete": ocr.is_complete(result), "completeness": ocr.completeness(result)}})
    for lines in LINE_SETS:
        picked, confidence = ocr.pick_number_lines([ocr.Line(text, score, 0, 0, 10, 10) for text, score in lines])
        out["pick_number_lines"].append({"input": [{"text": t, "score": s} for t, s in lines], "output": {"number": picked.number_local, "total": picked.number_total, "hp": picked.hp, "tokens": picked.tokens, "confidence": confidence}})
    for old_lines, old_conf, new_lines, new_conf, source, prefix in MERGE_SCENARIOS:
        old, new = ocr.parse_text(old_lines), ocr.parse_text(new_lines)
        old.number_confidence, new.number_confidence = old_conf, new_conf
        old.number_source = ocr.SOURCE_FINDER_CARD if old.number_local else None
        old.strips, new.strips = [{"label": "a"}, {"label": "b"}], [{"label": "c"}]
        old.seconds, new.seconds, old.attempts, new.attempts = 0.5, 0.25, 2, 1
        merged = ocr.merge_reads(old, new, source, prefix)
        out["merge_reads"].append({
            "old": {"lines": old_lines, "confidence": old_conf, "source": ocr.SOURCE_FINDER_CARD if ocr.parse_text(old_lines).number_local else None},
            "new": {"lines": new_lines, "confidence": new_conf}, "source": source, "prefix": prefix, "output": reading_to_json(merged),
        })
    for text in NAME_LINES:
        out["clean_name_line"].append({"input": text, "output": names.clean_name_line(text)})
        out["is_name_like"].append({"input": text, "output": ocr.is_name_like(text)})
    for entries in NAME_ENTRY_SETS:
        read = names.parse_name_lines([(text, height) if height is not None else text for text, height in entries])
        out["parse_name_lines"].append({"input": [{"text": t, "height": h} for t, h in entries], "output": {"name": read.name, "hp": read.hp, "raw": read.raw}})
    for text in ["HP 70", "70 HP", "PV 90", "KP 110", "hp330", "no hp", "HP 7", "Pikachu 60HP"]:
        out["find_hp"].append({"input": text, "output": ocr.find_hp(text)})
    return out


# ── the generated cards ──────────────────────────────────────────────────────

FONT_DIRS = ["C:/Windows/Fonts/", "/usr/share/fonts/truetype/dejavu/", "/usr/share/fonts/truetype/liberation/", ""]


def font(names: list[str], size: int):
    for name in names:
        for root in FONT_DIRS:
            try:
                return ImageFont.truetype(root + name, size)
            except OSError:
                continue
    from services.card_match import ocr_synthetic

    return ocr_synthetic._font(size)


def draw_card(spec: dict) -> Image.Image:
    """A flat card in the layout of ``ocr_synthetic.render_card`` with chosen text, fonts and sizes (630 x 880)."""
    import random

    seed = spec["seed"]
    rnd = random.Random(seed)
    width, height = 630, 880
    dark = spec.get("dark", False)
    base = np.zeros((height, width, 3), np.float32)
    hue = np.array(spec.get("hue", [rnd.randint(150, 235), rnd.randint(150, 235), rnd.randint(110, 215)]), np.float32)
    base[:] = hue * (0.35 if dark else 1.0)
    top, bottom = int(height * 0.1), int(height * 0.5)
    noise = np.random.default_rng(seed).normal(0, 25, (bottom - top, width - 60, 3))
    art = np.linspace(40, 220, width - 60)[None, :, None] + noise
    art_image = Image.fromarray(np.clip(art, 0, 255).astype("uint8")).filter(ImageFilter.GaussianBlur(3))  # smooth, so the PNG stays small
    base[top:bottom, 30:-30] = np.asarray(art_image, np.float32)
    image = Image.fromarray(np.clip(base, 0, 255).astype("uint8"))
    draw = ImageDraw.Draw(image)
    ink = (245, 245, 245) if dark else (20, 20, 20)
    bold, regular = spec.get("bold", ["arialbd.ttf", "DejaVuSans-Bold.ttf"]), spec.get("regular", ["arial.ttf", "DejaVuSans.ttf"])
    draw.text((44, int(height * 0.034)), spec["name"], font=font(bold, spec.get("name_size", 34)), fill=ink)
    if spec.get("hp"):
        draw.text((width - 150, int(height * 0.04)), f"HP {spec['hp']}", font=font(bold, 26), fill=ink)
    y = int(height * 0.56)
    for line in ["Once during your turn, you may attach a basic Energy", "This attack does 30 damage to 1 of your opponent's", "If this Pokemon is Knocked Out, flip a coin"]:
        draw.text((44, y), line, font=font(regular, 17), fill=ink)
        y += 26
    small = font(spec.get("small", regular), spec.get("small_size", 15))
    if spec.get("layout", "modern") == "modern":
        draw.text((44, int(height * 0.952)), spec["bottom_left"], font=small, fill=ink)
        draw.text((width - 250, int(height * 0.952)), "Illus. Someone Else", font=small, fill=ink)
    else:
        draw.text((44, int(height * 0.935)), "Illus. Someone Else   (c)2002 Pokemon", font=small, fill=ink)
        draw.text((width - 100, int(height * 0.952)), spec["bottom_right"], font=small, fill=ink)
    return image


CARD_SPECS = [
    {"id": "modern-125-197", "seed": 41, "name": "Pikachu ex", "hp": "190", "bottom_left": "SVI EN  125/197"},
    {"id": "modern-tg", "seed": 42, "name": "Radiant Charizard", "hp": "160", "bottom_left": "TG06/TG30", "name_size": 30, "small_size": 16},
    {"id": "promo-swsh", "seed": 43, "name": "Mimikyu", "hp": "70", "bottom_left": "SWSH001", "regular": ["times.ttf", "DejaVuSerif.ttf", "arial.ttf"], "small_size": 17},
    {"id": "modern-set-code", "seed": 44, "name": "Gardevoir ex", "hp": "310", "bottom_left": "PAL EN 018/091", "bold": ["verdanab.ttf", "arialbd.ttf"], "regular": ["verdana.ttf", "arial.ttf"], "small_size": 14},
    {"id": "old-right", "seed": 45, "name": "Slowpoke", "hp": "50", "layout": "old", "bottom_right": "58/102", "regular": ["tahoma.ttf", "arial.ttf"]},
    {"id": "dark-modern", "seed": 46, "name": "Boss's Orders", "hp": None, "bottom_left": "MEW EN 088/165", "dark": True, "regular": ["calibri.ttf", "arial.ttf"], "small_size": 17},
    {"id": "tall-1100", "seed": 47, "name": "Iono", "hp": None, "bottom_left": "PAL EN 185/193", "height": 1100},
    {"id": "glare-blur", "seed": 48, "name": "Lapras", "hp": "120", "bottom_left": "SVI EN 035/165", "degrade": 48},
    {"id": "upside-down", "seed": 49, "name": "Phantump", "hp": "70", "bottom_left": "OBF EN 120/197", "turned": True},
    {"id": "no-number", "seed": 50, "name": "Heatran", "hp": "130", "bottom_left": "", "layout": "modern"},
    {"id": "wholeread-cut", "seed": 51, "name": "Dhelmise", "hp": "110", "bottom_left": "TEF EN 042/162", "second_read": True},
    {"id": "wholeread-none", "seed": 52, "name": "Banette", "hp": "90", "bottom_left": "", "second_read": True},
]


def build_cards(card_dir: Path) -> list[dict]:
    from services.card_match import ocr_synthetic

    card_dir.mkdir(parents=True, exist_ok=True)
    cards = []
    for spec in CARD_SPECS:
        image = draw_card(spec)
        if spec.get("degrade"):
            image = ocr_synthetic.degrade(image, spec["degrade"], glare=True)
        height = spec.get("height", 880)
        array = ocr_synthetic.at_resolution(image, height)
        if spec.get("turned"):
            array = np.ascontiguousarray(array[::-1, ::-1])
        path = card_dir / f"{spec['id']}.png"
        Image.fromarray(array).save(path, optimize=True)
        cards.append({"spec": spec, "array": np.asarray(Image.open(path).convert("RGB")), "file": f"cards/{path.name}"})
    return cards


# ── recording the models ─────────────────────────────────────────────────────

class Recorder:
    """Wraps the reader's two ONNX sessions so every call is recorded and the reader sees exactly the recorded values."""

    def __init__(self, reader) -> None:
        self.events: list[dict] = []
        engine = reader.engine
        recorder = self
        real_det, real_rec = engine.text_det.infer, engine.text_rec.session

        class Det:
            def __call__(self, tensor):
                output = real_det(tensor)[0]
                quantised = np.round(output.astype(np.float64) * 255).astype(np.uint8)
                event = {"kind": "det", "dims": list(tensor.shape), "input_mean": round(float(tensor.mean()), 5), "input_std": round(float(tensor.std()), 5),
                         "map_dims": [int(output.shape[2]), int(output.shape[3])], "map": pack(quantised[0, 0])}
                recorder.events.append(event)
                recorder.det = event
                return [(quantised.astype(np.float32) / 255).astype(np.float32)]

        class Rec:
            def __call__(self, tensor):
                output = real_rec(tensor)[0]
                index = output.argmax(axis=2)
                values = np.round(output.max(axis=2).astype(np.float64) * 10000).astype(np.uint16)
                synthetic = np.zeros(output.shape, np.float32)
                np.put_along_axis(synthetic, index[..., None], (values.astype(np.float64) / 10000).astype(np.float32)[..., None], axis=2)
                event = {"kind": "rec", "dims": list(tensor.shape), "input_mean": round(float(tensor.mean()), 5), "classes": int(output.shape[2]), "steps": int(output.shape[1]),
                         "indices": pack(index.astype(np.uint16)), "values": pack(values)}
                recorder.events.append(event)
                recorder.rec = event
                return [synthetic]

        engine.text_det.infer = Det()
        engine.text_rec.session = Rec()
        post = engine.text_det.postprocess_op
        real_boxes = post.boxes_from_bitmap
        real_filter = engine.text_det.filter_tag_det_res
        real_sorted = engine.sorted_boxes

        def boxes_from_bitmap(pred, bitmap, dest_width, dest_height):
            boxes, scores = real_boxes(pred, bitmap, dest_width, dest_height)
            recorder.det.update({"size": [int(dest_width), int(dest_height)], "raw_boxes": len(boxes)})
            recorder.raw_scores = list(scores)
            recorder.raw_boxes = [np.array(box) for box in boxes]
            return boxes, scores

        def filter_tag_det_res(dt_boxes, shape):
            kept = [i for i, box in enumerate(dt_boxes) if len(real_filter(np.array([box]).copy(), shape))]
            recorder.kept = kept
            return real_filter(dt_boxes, shape)

        def sorted_boxes(dt_boxes):
            ordered = real_sorted(dt_boxes)
            scores_by_box = {np.array(b).tobytes(): float(recorder.raw_scores[i]) for b, i in zip(recorder.filtered(dt_boxes), recorder.kept)}
            recorder.det["boxes"] = [np.asarray(box).astype(int).tolist() for box in ordered]
            recorder.det["scores"] = [round(scores_by_box.get(np.asarray(box).tobytes(), -1.0), 5) for box in ordered]
            return ordered

        post.boxes_from_bitmap = boxes_from_bitmap
        engine.text_det.filter_tag_det_res = filter_tag_det_res
        engine.sorted_boxes = sorted_boxes
        self.filtered = lambda dt_boxes: list(dt_boxes)

    def take(self) -> list[dict]:
        events, self.events = self.events, []
        return events


def decode_texts(recorder_events: list[dict], reader) -> None:
    """Attach what the CTC decode made of each recogniser batch (text, score) to the events."""
    decoder = reader.engine.text_rec.postprocess_op
    for event in recorder_events:
        if event["kind"] != "rec":
            continue
        steps = event["steps"]
        index = np.frombuffer(zlib.decompress(base64.b64decode(event["indices"])), np.uint16).reshape(-1, steps).astype(np.int64)
        values = np.frombuffer(zlib.decompress(base64.b64decode(event["values"])), np.uint16).reshape(-1, steps).astype(np.float64) / 10000
        for n in range(len(index)):
            text, score = decoder.decode(index[n:n + 1], values[n:n + 1].astype(np.float32), is_remove_duplicate=True)[0]
            event.setdefault("texts", []).append([text, round(float(score), 5)])


def strips_json(strips: list[dict]) -> list[dict]:
    return [{"label": s.get("label"), "source": s.get("source"), "variant": s.get("variant"), "zoom": s.get("zoom"), "low": s.get("low"), "flipped": s.get("flipped"),
             "cached": bool(s.get("cached")), "after": s.get("after"), "lines": s.get("lines")} for s in strips]


def reading_full(result) -> dict:
    out = reading_to_json(result)
    out["strips"] = strips_json(result.strips)
    return out


def name_json(read) -> dict:
    return {"name": read.name, "hp": read.hp, "raw": list(read.raw), "strips": strips_json(read.strips)}


def read_cases(cards: list[dict], reader, recorder) -> list[dict]:
    from services.card_match import ocr as ocr_module, pipeline

    ocr_module.FAST_BUDGET_SECONDS = ocr_module.BUDGET_SECONDS = 1e9  # no time budget: results must not depend on this machine's speed
    pipeline.WHOLEREAD_MAX_SECONDS = 1e9
    pipeline.detect_module.whole_detection = lambda photo: types.SimpleNamespace(hires=None, card=photo)
    cases = []
    for card in cards:
        spec, array = card["spec"], card["array"]
        flipped = bool(spec.get("turned"))
        case: dict = {"id": spec["id"], "file": card["file"], "size": [int(array.shape[1]), int(array.shape[0])], "flipped": flipped}
        if spec.get("second_read"):
            height = array.shape[0]
            cut = array[: int(height * 0.93)]  # the finder's card cut short: the number line is missing from it
            cut = np.concatenate([cut, np.full((height - cut.shape[0], array.shape[1], 3), 90, np.uint8)])
            case["text_card"] = {"cut_fraction": 0.93, "fill": 90}
            first = reader.read(cut, read_hp=True, flipped=False, fast=True, stage="first")
            fake = types.SimpleNamespace(ocr_reader=reader)
            result, info = pipeline.CardMatcher._second_read(fake, array, cut, first, False, True)
            events = recorder.take()
            decode_texts(events, reader)
            case.update({"kind": "second_read", "events": events, "result": reading_full(result), "info": {k: info[k] for k in ("tried", "skipped", "rescued", "last_resort")}, "first_complete": ocr_module.is_complete(first)})
            cases.append(case)
            continue
        result = reader.read(array, read_hp=True, flipped=flipped, fast=True)
        events = recorder.take()
        decode_texts(events, reader)
        case.update({"kind": "read", "events": events, "result": reading_full(result)})
        cases.append(case)
        name = reader.read_name(array, flipped=flipped, fast=True)
        events = recorder.take()
        decode_texts(events, reader)
        cases.append({"id": spec["id"], "file": card["file"], "size": case["size"], "flipped": flipped, "kind": "read_name", "events": events, "result": name_json(name)})
    return cases


# ── operations on small pictures ─────────────────────────────────────────────

def ops_cases(cards: list[dict]) -> dict:
    import cv2

    from services.card_match import ocr as ocr_module

    card = cards[0]["array"]
    h, w = card.shape[:2]
    out: dict = {"cases": []}

    def crop(x0, y0, x1, y1):
        return np.ascontiguousarray(card[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)])

    small = crop(0.06, 0.948, 0.19, 0.975)  # the "SVI" end of the number line
    wide = crop(0.04, 0.945, 0.50, 0.99)

    def record(name, source, result, **extra):
        out["cases"].append({"name": name, "width": int(source.shape[1]), "height": int(source.shape[0]), "input": pack(source),
                             "out_width": int(result.shape[1]), "out_height": int(result.shape[0]), "output": pack(result), **extra})

    for zoom in (2.0, 2.5, 3.0):
        record(f"cubic-{zoom}", small, cv2.resize(small, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_CUBIC), op="cubic", zoom=zoom)
    record("sharp", small, ocr_module.prepare(small, "sharp"), op="sharp")
    record("clahe", wide, ocr_module.prepare(wide, "clahe"), op="clahe")
    record("clahe-small", small, ocr_module.prepare(small, "clahe"), op="clahe")
    record("linear-down", wide, cv2.resize(wide, (96, 32)), op="linear", size=[96, 32])
    record("linear-up", small, cv2.resize(small, (120, 48)), op="linear", size=[120, 48])
    record("rot180", small, np.ascontiguousarray(small[::-1, ::-1]), op="rot180")
    # the perspective crop as RapidOCR's get_rotate_crop_image makes it (integer corners, slightly turned; and an upright tall one)
    for name, points in (("warp-turned", [[12, 6], [100, 2], [102, 20], [14, 25]]), ("warp-tall", [[10, 4], [24, 4], [24, 60], [10, 60]])):
        pts = np.array(points, np.float32)
        width = int(max(np.linalg.norm(pts[0] - pts[1]), np.linalg.norm(pts[2] - pts[3])))
        height = int(max(np.linalg.norm(pts[0] - pts[3]), np.linalg.norm(pts[1] - pts[2])))
        std = np.array([[0, 0], [width, 0], [width, height], [0, height]], np.float32)
        matrix = cv2.getPerspectiveTransform(pts, std)
        dst = cv2.warpPerspective(wide, matrix, (width, height), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
        if dst.shape[0] * 1.0 / dst.shape[1] >= 1.5:
            dst = np.rot90(dst)
        record(name, wide, np.ascontiguousarray(dst), op="warp", points=points)
    return out


# ── the DB post-processing on drawn maps ─────────────────────────────────────

def post_cases(reader) -> dict:
    engine = reader.engine
    cases = []
    layouts = {
        "three-lines": (320, 64, [[(10, 8), (150, 8), (150, 24), (10, 24)], [(20, 36), (200, 36), (200, 50), (20, 50)], [(230, 10), (300, 10), (300, 22), (230, 22)]]),
        "turned": (256, 96, [[(20, 30), (200, 20), (202, 40), (22, 50)], [(30, 70), (120, 70), (120, 86), (30, 86)]]),
        "tiny-and-touching": (192, 64, [[(8, 8), (60, 8), (60, 20), (8, 20)], [(62, 9), (120, 9), (120, 21), (62, 21)], [(150, 30), (153, 30), (153, 33), (150, 33)], [(10, 40), (180, 40), (180, 56), (10, 56)]]),
        "faint": (224, 64, [[(10, 10), (190, 10), (190, 30), (10, 30)]]),
    }
    for name, (width, height, polygons) in layouts.items():
        image = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(image)
        for poly in polygons:
            draw.polygon(poly, fill=255)
        probability = np.asarray(image.filter(ImageFilter.GaussianBlur(1.5)), np.float32) / 255 * (0.42 if name == "faint" else 0.95)
        quantised = np.round(probability * 255).astype(np.uint8)
        dequantised = (quantised.astype(np.float32) / 255).astype(np.float32)
        for scale, box_thresh in ((2, 0.5), (2, 0.35)):
            size = (width * scale, height * scale)  # the picture the boxes are drawn in is larger than the map
            post = engine.text_det.postprocess_op
            post.box_thresh = box_thresh
            boxes, scores = post(dequantised[None, None], (size[1], size[0]))
            kept = engine.text_det.filter_tag_det_res(boxes, (size[1], size[0]))
            ordered = engine.sorted_boxes(kept) if len(kept) else []
            cases.append({"name": name, "map_dims": [height, width], "map": pack(quantised), "size": list(size), "box_thresh": box_thresh,
                          "raw_count": len(boxes), "boxes": [np.asarray(b).astype(int).tolist() for b in ordered], "scores": [round(float(s), 5) for s in scores]})
    return {"cases": cases}


# ── main ─────────────────────────────────────────────────────────────────────

def characters_text() -> tuple[str, int]:
    from services.card_match.phone import find_ocr_files

    files = find_ocr_files()
    return str(files["characters"]), len(str(files["characters"]).split("\n"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out_dir", nargs="?", type=Path, default=None)
    parser.add_argument("--no-models", action="store_true", help="only the pure-function fixtures (no RapidOCR needed)")
    args = parser.parse_args()
    out = args.out_dir or default_out_dir()
    out.mkdir(parents=True, exist_ok=True)
    from services.card_match import MATCHER_VERSION

    def write(name: str, data: dict) -> None:
        data = {"matcher_version": MATCHER_VERSION, "note": "Generated by backend/scripts/phone_parity_ocr.py from generated cards and hand-written strings only.", **data}
        path = out / name
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"{name}: {path.stat().st_size / 1024:.0f} kB")

    write("ocr-pure.json", pure_cases())
    if args.no_models:
        return
    from services.card_match.ocr import OcrReader

    characters, count = characters_text()
    (out / "characters.txt").write_text(characters, encoding="utf-8", newline="")
    cards = build_cards(out / "cards")
    reader = OcrReader(threads=2)
    write("ocr-ops.json", ops_cases(cards))
    write("ocr-post.json", post_cases(reader))
    recorder = Recorder(reader)
    cases = read_cases(cards, reader, recorder)
    classes = {event["classes"] for case in cases for event in case["events"] if event["kind"] == "rec"}
    assert classes == {count + 2}, (classes, count)  # characters + the blank + the space
    write("ocr-cases.json", {"characters": "characters.txt", "classes": count + 2, "cases": cases})
    total = sum(path.stat().st_size for path in out.rglob("*") if path.is_file())
    print(f"all files: {total / 1024:.0f} kB")


if __name__ == "__main__":
    main()
