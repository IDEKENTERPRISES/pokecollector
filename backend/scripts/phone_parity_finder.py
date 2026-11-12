#!/usr/bin/env python3
"""Write the parity fixtures for the phone's JavaScript card finder (matcher version 11, step 3a).

    py backend/scripts/phone_parity_finder.py [out_dir]

Default out_dir: frontend/tests/fixtures/phone-matcher/v<matcher version>/finder/. Writes

  finder.json      for every generated photo: the option the finder ran with, the quad it found, which source won (quad, guide or
                   whole), the refusal reason and the refused quad, the confidence, and stats (size, mean and standard deviation
                   per channel, an 8x11 area-averaged grid) of the flattened card, of every view the in-use option set embeds
                   (180 degrees, tight, CLAHE, and the artwork crop of the card and of both extra views), of the sharper copy and
                   of the whole-picture second-read picture; plus small cases for the pieces the finder is built from (contours,
                   hull, polygon approximation, Canny, CLAHE, the warp, the pure helpers);
  photos/*.jpg     the generated photos themselves (the JavaScript side reads these same bytes).

Nothing here comes from a trainer's scan or from a catalogue picture: the cards are drawn by ``ocr_synthetic.render_card`` and the
photos made by ``synthetic.make_photo`` (and cropped, rotated or left empty to give the finder the cases it should refuse).
Photos are drawn with the fonts of the machine that runs this, so regenerate the JPEGs together with the JSON, never one alone.
The expected values come from the OpenCV the server pins (opencv-python-headless 4.10.0.84); another OpenCV may differ a little.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

LONG_SIDE = 1024  # the stored photos are downscaled to this
JPEG_QUALITY = 80
GRID = (8, 11)  # width, height of the area-averaged checksum grid


def decode_like_the_tests(jpeg: bytes) -> np.ndarray:
    """RGB pixels of a JPEG as the JavaScript tests decode it (jpeg-js from frontend/node_modules, through Node).

    Decoders round a little differently (jpeg-js comes out about 0.8 of a level darker than libjpeg on average), and the finder's
    thresholds are chaotic on noisy pictures, so the expected values are computed from the very pixels the JavaScript side sees.
    Without Node the pictures are decoded with Pillow, and the JavaScript parity tests may then fail on the noisiest photos.
    """
    import shutil
    import subprocess
    import tempfile

    node = shutil.which("node")
    jpeg_js = HERE.parents[1] / "frontend" / "node_modules" / "jpeg-js"
    if node and jpeg_js.exists():
        script = (
            "const fs=require('fs');const j=require(process.argv[1]).decode(fs.readFileSync(process.argv[2]),{useTArray:true,formatAsRGBA:false});"
            "const h=Buffer.alloc(8);h.writeUInt32LE(j.width,0);h.writeUInt32LE(j.height,4);"
            "process.stdout.write(Buffer.concat([h,Buffer.from(j.data.buffer,j.data.byteOffset,j.data.length)]));"
        )
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as handle:
            handle.write(jpeg)
        try:
            raw = subprocess.run([node, "-e", script, str(jpeg_js), handle.name], check=True, capture_output=True).stdout
        finally:
            Path(handle.name).unlink(missing_ok=True)
        width, height = int.from_bytes(raw[:4], "little"), int.from_bytes(raw[4:8], "little")
        return np.frombuffer(raw[8:], np.uint8).reshape(height, width, 3).copy()
    print("warning: Node or frontend/node_modules/jpeg-js not found; decoding with Pillow", file=sys.stderr)
    return np.asarray(Image.open(io.BytesIO(jpeg)).convert("RGB"))


def default_out_dir() -> Path:
    from services.card_match import MATCHER_VERSION

    return HERE.parents[1] / "frontend" / "tests" / "fixtures" / "phone-matcher" / f"v{MATCHER_VERSION}" / "finder"


def _r(value, digits: int = 3):
    return round(float(value), digits)


def stats(image: np.ndarray) -> dict:
    """Size, per-channel mean and standard deviation, and an 8x11 area-averaged grid of an RGB picture."""
    image = np.ascontiguousarray(image)
    h, w = image.shape[:2]
    grid = cv2.resize(image, GRID, interpolation=cv2.INTER_AREA)
    return {"size": [w, h], "mean": [_r(v, 2) for v in image.reshape(-1, 3).mean(axis=0)], "std": [_r(v, 2) for v in image.reshape(-1, 3).std(axis=0)],
            "grid": grid.reshape(-1).astype(int).tolist()}


def view_stats(card: np.ndarray) -> dict:
    from services.card_match import detect

    tight, clahe = detect.augmented_views(card)
    return {
        "card180": stats(card[::-1, ::-1]), "tight": stats(tight), "clahe": stats(clahe),
        "art": stats(detect.art_crop(card)), "art_tight": stats(detect.art_crop(tight)), "art_clahe": stats(detect.art_crop(clahe)),
    }


def encode(image: Image.Image, keep_size: bool = False) -> bytes:
    scale = LONG_SIDE / max(image.size)
    if scale < 1 and not keep_size:
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, "JPEG", quality=JPEG_QUALITY)
    return buffer.getvalue()


def photo_cases(out_dir: Path) -> list[dict]:
    from services.card_match import detect, ocr_synthetic, synthetic

    (out_dir / "photos").mkdir(parents=True, exist_ok=True)
    pictures: list[tuple[str, str, bytes, dict]] = []  # (name, what, jpeg, options)

    def add(name: str, what: str, image: Image.Image | bytes, options: dict | None = None, keep_size: bool = False):
        jpeg = image if isinstance(image, bytes) else encode(image, keep_size)
        pictures.append((name, what, jpeg, options or {}))

    bases = []
    for number in range(8):
        card, truth = ocr_synthetic.render_card(300 + number)
        jpeg, corners, settings = synthetic.make_photo(card, 300 + number)
        bases.append((Image.open(io.BytesIO(jpeg)).convert("RGB"), corners, settings))
    for number, (image, _corners, settings) in enumerate(bases[:6], start=1):
        add(f"frame-{number}", f"a whole camera frame, {settings['background']}, tilt {settings['tilt']}, glare {settings['glare']}", image)

    def guide_crop_of(image: Image.Image, corners, height_factor: float, shift=(0.0, 0.0)) -> Image.Image:
        """A 63:88 crop centred on the card whose height is ``height_factor`` times the card's (the camera's guide crop)."""
        pts = np.array(corners)
        cx, cy = pts.mean(axis=0)
        card_h = (np.linalg.norm(pts[3] - pts[0]) + np.linalg.norm(pts[2] - pts[1])) / 2
        crop_h = card_h * height_factor
        crop_w = crop_h * 63 / 88
        cx, cy = cx + shift[0] * crop_w, cy + shift[1] * crop_h
        box = (int(cx - crop_w / 2), int(cy - crop_h / 2), int(cx + crop_w / 2), int(cy + crop_h / 2))
        return image.crop(box)

    image, corners, _ = bases[0]
    add("guide-tight", "a guide crop the card fills", guide_crop_of(image, corners, 1.06))
    add("guide-loose", "a guide crop with a small card in it", guide_crop_of(*bases[1][:2], 1.9))
    add("guide-cut", "a guide crop that cuts the card's edges off", guide_crop_of(*bases[2][:2], 0.82))
    add("guide-shifted", "a guide crop with the card pushed to one side", guide_crop_of(*bases[3][:2], 1.15, shift=(0.12, 0.05)))
    add("whole-frame", "a camera frame read as a whole frame (guide off)", bases[4][0], {"guide": False})
    sideways = bases[5][0].rotate(90, expand=True)
    add("sideways-frame", "a camera frame with the card on its side", sideways)
    rng = np.random.default_rng(7)
    empty = synthetic._background(rng, "carpet").crop((0, 0, 768, 1024))
    add("empty-frame", "a frame with no card in it", empty)
    add("empty-guide", "a guide-shaped picture with no card in it", empty.crop((0, 0, 630, 880)))
    small_card, small_corners, _ = bases[6]
    add("small-frame", "a small camera frame (no shrinking before the search)", small_card.resize((600, 800), Image.Resampling.LANCZOS))
    add("large-frame", "a frame taller than the stored size is, stored at 1400 px so the sharper copy is made", bases[7][0].resize((1050, 1400), Image.Resampling.LANCZOS), keep_size=True)

    def scene(card_seed: int, size: tuple[int, int], quad, background: str = "mat") -> Image.Image:
        """A drawn card pasted at ``quad`` (tl, tr, br, bl) on a generated background: the shapes the finder should refuse."""
        card = ocr_synthetic.render_card(card_seed)[0].convert("RGBA").resize((630, 880), Image.Resampling.LANCZOS)
        rng_scene = np.random.default_rng(card_seed)
        backdrop = synthetic._background(rng_scene, background).convert("RGBA").crop((0, 0, size[0], size[1]))
        warped = card.transform(size, Image.Transform.PERSPECTIVE, synthetic._coeffs([(0, 0), (630, 0), (630, 880), (0, 880)], quad), Image.Resampling.BICUBIC)
        backdrop.alpha_composite(warped)
        return backdrop.convert("RGB")

    add("guide-small", "a guide-shaped picture with the card small in the middle", scene(401, (630, 880), [(190, 270), (440, 270), (440, 610), (190, 610)]))
    add("guide-sideways", "a guide-shaped picture with the card on its side", scene(402, (630, 880), [(15, 220), (615, 220), (615, 650), (15, 650)]), {"guide": True})
    add("frame-skewed", "a frame with a sheared card (angles far from 90)", scene(403, (768, 1024), [(80, 250), (380, 250), (680, 650), (380, 650)], "paper"))

    cases = []
    for name, what, jpeg, options in pictures:
        (out_dir / "photos" / f"{name}.jpg").write_bytes(jpeg)
        photo = decode_like_the_tests(jpeg)
        h, w = photo.shape[:2]
        # the stored large frame keeps its size; the others are at most LONG_SIDE
        guide_arg = options.get("guide")
        detection = detect.detect_card(photo, check=True, whole=True, guide=guide_arg)
        whole = detect.whole_detection(photo)
        refused = detection.rejected
        source = "quad" if detection.found else ("whole" if detection.method == "whole_picture" else "guide")
        case = {
            "name": name, "what": what, "photo": f"photos/{name}.jpg", "size": [w, h], "guide_input": guide_arg, "is_guide_picture": detect.is_guide_picture(photo),
            "source": source, "confidence": _r(detection.confidence),
            "quad": [[_r(x, 2), _r(y, 2)] for x, y in detection.corners] if detection.found else None,
            "refused": None if refused is None else {k: (v if k != "corners" else [[_r(x, 1), _r(y, 1)] for x, y in v]) for k, v in refused.items()},
            "card": stats(detection.card), "views": view_stats(detection.card),
            "hires": None if detection.hires is None else stats(detection.hires),
            "whole_card": stats(whole.card), "whole_hires": None if whole.hires is None else stats(whole.hires),
            "guide_rect": [_r(v, 3) for v in detect.guide_rect(w, h)],
        }
        cases.append(case)
    return cases


# ── the pieces the finder is built from ──────────────────────────────────────

def pattern_rgba(width: int, height: int) -> np.ndarray:
    """The same formula as the JavaScript test: noisy, blocky, with every channel different."""
    out = np.zeros((height, width, 4), np.uint8)
    for y in range(height):
        for x in range(width):
            for c in range(3):
                out[y, x, c] = (x * 7 + y * 13 + c * 50 + ((x * y) % 17) * 5) % 256
            out[y, x, 3] = 255
    return out


def shapes_image(width: int, height: int) -> np.ndarray:
    """A gradient with a few rectangles, a hole, a diagonal bar and a ring: the JavaScript test builds the same picture."""
    img = np.zeros((height, width), np.uint8)
    for y in range(height):
        for x in range(width):
            img[y, x] = (x * 2 + y) % 90 + 20
    img[10:50, 12:70] = 200
    img[22:34, 30:44] = 60
    for t in range(60):
        img[60 + t // 2: 64 + t // 2, 20 + t: 24 + t] = 230
    for y in range(height):
        for x in range(width):
            r2 = (x - 120) ** 2 + (y - 40) ** 2
            if 18 ** 2 <= r2 <= 26 ** 2:
                img[y, x] = 255
    return img


def piece_cases() -> dict:
    from services.card_match import detect

    out: dict = {}
    # grey, blur, canny, close, otsu on the shapes picture
    img = shapes_image(160, 120)
    blurred = cv2.GaussianBlur(img, (5, 5), 0)
    edges = cv2.Canny(blurred, 40, 100)
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)), iterations=2)
    _, otsu = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    rgba = pattern_rgba(40, 30)
    out["gray"] = {"width": 40, "height": 30, "sum": int(cv2.cvtColor(rgba[:, :, :3], cv2.COLOR_RGB2GRAY).astype(int).sum())}
    out["blur"] = {"sum": int(blurred.astype(int).sum()), "checksum": int((blurred.astype(np.int64) * (np.arange(blurred.size).reshape(blurred.shape) % 251)).sum())}
    out["canny"] = {"count": int((edges > 0).sum()), "checksum": int(((edges > 0) * (np.arange(edges.size).reshape(edges.shape) + 1)).sum())}
    out["close"] = {"count": int((closed > 0).sum()), "checksum": int(((closed > 0) * (np.arange(closed.size).reshape(closed.shape) + 1)).sum())}
    out["otsu"] = {"count": int((otsu > 0).sum())}
    # contours of the closed edge picture and of the Otsu picture
    def contour_record(binary):
        contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        records = []
        for contour in contours:
            hull = cv2.convexHull(contour)
            perimeter = cv2.arcLength(hull, True)
            approx = {str(eps): cv2.approxPolyDP(hull, eps * perimeter, True).reshape(-1, 2).tolist() for eps in (0.02, 0.03, 0.045, 0.06)}
            records.append({"points": contour.reshape(-1, 2).tolist(), "area": float(cv2.contourArea(contour)), "hull": hull.reshape(-1, 2).tolist(),
                            "hull_area": float(cv2.contourArea(hull)), "perimeter": float(perimeter), "approx": approx,
                            "box": cv2.boxPoints(cv2.minAreaRect(hull)).tolist()})
        return records
    out["contours_closed"] = contour_record(closed)
    out["contours_otsu"] = contour_record(otsu)
    # clahe on a plane of an awkward size (width not a multiple of the tile grid)
    plane = np.array([[(x * 5 + y * 3 + ((x * y) % 13) * 9) % 256 for x in range(150)] for y in range(100)], np.uint8)
    equalised = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4)).apply(plane[:, :149])
    out["clahe"] = {"width": 149, "height": 100, "sum": int(equalised.astype(int).sum()), "checksum": int((equalised.astype(np.int64) * (np.arange(equalised.size).reshape(equalised.shape) % 251)).sum())}
    # lab round trip on a colour ramp
    ramp = np.array([[[(x * 3) % 256, (y * 5) % 256, (x + y * 2) % 256] for x in range(64)] for y in range(48)], np.uint8)
    lab = cv2.cvtColor(ramp, cv2.COLOR_RGB2LAB)
    out["lab"] = {"mean": [_r(v, 3) for v in lab.reshape(-1, 3).mean(axis=0)], "samples": lab[::7, ::9].reshape(-1, 3).astype(int).tolist(),
                  "back_samples": cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)[::7, ::9].reshape(-1, 3).astype(int).tolist()}
    # the warp on the pattern picture
    source = pattern_rgba(200, 150)[:, :, :3]
    quad = np.array([[22.5, 14.25], [171.0, 30.75], [160.5, 138.0], [12.0, 120.5]], np.float32)
    flat = detect.warp_card(source, quad, (126, 176))
    out["warp"] = {"quad": quad.tolist(), "size": [126, 176], "stats": stats(flat), "samples": flat[::17, ::13].reshape(-1, 3).astype(int).tolist()}
    sideways = detect.warp_card(source, np.array([[20, 20], [180, 25], [175, 130], [18, 125]], np.float32), (126, 176))
    out["warp_sideways"] = {"stats": stats(sideways)}
    # the pure helpers
    out["order_corners"] = [{"in": pts, "out": detect.order_corners(np.array(pts, np.float32)).tolist()} for pts in (
        [[10, 10], [100, 12], [98, 140], [8, 138]], [[98, 140], [8, 138], [10, 10], [100, 12]], [[50, 0], [100, 50], [50, 100], [0, 50]], [[0, 0], [10, 10], [20, 0], [10, -10]])]
    quads = [([[10, 10], [100, 12], [98, 140], [8, 138]], 12300.0, 20000.0), ([[0, 0], [200, 0], [200, 100], [0, 100]], 21000.0, 40000.0), ([[0, 0], [100, 40], [100, 140], [0, 100]], 9000.0, 40000.0)]
    out["measures"] = []
    for pts, hull_area, image_area in quads:
        measures = detect.quad_measures(np.array(pts, np.float32), hull_area, image_area)
        out["measures"].append({"quad": pts, "hull_area": hull_area, "image_area": image_area, "measures": measures,
                                "problem_guide": detect.plausibility_problem(measures, True), "problem_frame": detect.plausibility_problem(measures, False)})
    out["guide_rect"] = [{"size": [w, h], "rect": list(detect.guide_rect(w, h))} for w, h in ((768, 1024), (1024, 768), (630, 880), (3000, 1200), (101, 77))]
    out["is_guide_picture"] = [{"size": [w, h], "value": detect.is_guide_picture(np.zeros((h, w, 3), np.uint8))} for w, h in ((630, 880), (600, 880), (768, 1024), (1024, 768), (651, 880), (500, 700), (1008, 1408))]
    out["hires_size"] = [{"quad": pts, "size": detect.hires_size(np.array(pts, np.float32))} for pts in (
        [[0, 0], [630, 0], [630, 880], [0, 880]], [[0, 0], [700, 0], [700, 1000], [0, 1000]], [[0, 0], [1500, 0], [1500, 2100], [0, 2100]], [[0, 0], [1000, 0], [1000, 700], [0, 700]])]
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out_dir", nargs="?", type=Path)
    args = parser.parse_args(argv)
    from services.card_match import MATCHER_VERSION

    out_dir = args.out_dir or default_out_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    document = {
        "matcher_version": MATCHER_VERSION, "opencv": cv2.__version__,
        "note": "Generated by backend/scripts/phone_parity_finder.py from generated cards only (no trainer scan, no catalogue picture).",
        "constants": {"card": [630, 880], "hires_max": [1008, 1408], "detect_max_side": 900, "grid": list(GRID)},
        "cases": photo_cases(out_dir), "pieces": piece_cases(),
    }
    (out_dir / "finder.json").write_text(json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote the finder parity fixtures (matcher version {MATCHER_VERSION}, OpenCV {cv2.__version__}) to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
