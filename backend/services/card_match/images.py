"""Image decoding shared by the matcher (RGB uint8 numpy arrays everywhere)."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageOps

MAX_PIXELS = 60_000_000


def decode_rgb(data: bytes, *, max_side: int | None = None) -> np.ndarray:
    """Bytes -> RGB uint8 array, EXIF rotation applied, optionally shrunk so the long side is ``max_side``."""
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    image = Image.open(io.BytesIO(data))
    image.load()
    image = ImageOps.exif_transpose(image).convert("RGB")
    if max_side and max(image.size) > max_side:
        scale = max_side / max(image.size)
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)
    return np.asarray(image)
