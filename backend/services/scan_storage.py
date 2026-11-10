"""Validated temporary storage for background card scans."""

from __future__ import annotations

import datetime
import io
import json
import os
import re
import shutil
import uuid
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import text
from sqlalchemy.orm import Session

from models import ScanJob, ScanJobItem

try:
    from pillow_heif import register_heif_opener

    register_heif_opener(thumbnails=False)
    HEIC_AVAILABLE = True
except ImportError:  # pragma: no cover - production installs the dependency
    HEIC_AVAILABLE = False


MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_JOB_BYTES = 200 * 1024 * 1024
MAX_IMAGE_PIXELS = 50_000_000
MAX_IMAGE_EDGE = 2048
JPEG_QUALITY = 90
SCAN_RETENTION_DAYS = 14
ALLOWED_IMAGE_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "HEIF", "HEIC"})


# What a model is sent: about 1024 px on the long side, not the 2048 px review
# photo (an image costs roughly pixels / 750 tokens, so 2048 px was ~2,300-3,100).
RECOGNITION_LONG_SIDE = 1024
# The guide-frame crop cut from the original camera frame, before it is shrunk to the 2048 px review photo,
# is kept as a sharper picture of the card for reading its text (never sent to a model).
SHARP_CROP_LONG_SIDE = 1600
# The camera screen writes where its guide frame sat into the file name, e.g.
# "scan-1700000000000-g118_142_764_820.jpg": x, y, width, height of the frame
# in thousandths of the photo (so it survives the offline queue and re-encoding).
GUIDE_BOX_NAME = re.compile(r"-g(\d{1,4})_(\d{1,4})_(\d{1,4})_(\d{1,4})(?:\.[A-Za-z0-9]+)?$")


class ScanUploadError(ValueError):
    """An uploaded file is unsafe or outside the scanner limits."""


@dataclass(frozen=True)
class SanitizedScanImage:
    data: bytes
    content_type: str = "image/jpeg"
    # Only when the upload had a guide box: the box cut from the original (not the shrunk) image, and the sizes
    # (width, height) of that original frame and of the crop, for the Scanner lab.
    sharp_crop: bytes | None = None
    frame_size: tuple[int, int] | None = None
    crop_size: tuple[int, int] | None = None


def scan_upload_root() -> Path:
    configured = os.environ.get("SCAN_UPLOAD_DIR", "").strip()
    root = Path(configured) if configured else Path(__file__).resolve().parent.parent / "data" / "scan-uploads"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root.resolve()


async def read_limited_upload(upload, *, remaining_job_bytes: int) -> bytes:
    """Read one UploadFile without allowing it or the whole job to grow unbounded."""
    if remaining_job_bytes <= 0:
        raise ScanUploadError("The scan job exceeds the 200 MB upload limit.")

    limit = min(MAX_FILE_BYTES, remaining_job_bytes)
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await upload.read(min(1024 * 1024, limit + 1 - size))
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_FILE_BYTES:
            raise ScanUploadError("Each scan photo must be 15 MB or smaller.")
        if size > remaining_job_bytes:
            raise ScanUploadError("The scan job exceeds the 200 MB upload limit.")
        chunks.append(chunk)

    if not chunks:
        raise ScanUploadError("An uploaded scan photo is empty.")
    return b"".join(chunks)


def _cut_sharp_crop(image: Image.Image, box: tuple[float, float, float, float]) -> tuple[bytes, tuple[int, int]] | None:
    """The guide box cut from a decoded, oriented RGB image, long side capped, as an EXIF-free JPEG."""
    width, height = image.size
    x, y, w, h = box
    left, top = max(0, int(round(x * width))), max(0, int(round(y * height)))
    right, bottom = min(width, int(round((x + w) * width))), min(height, int(round((y + h) * height)))
    if right - left < 16 or bottom - top < 16:
        return None
    crop = image.crop((left, top, right, bottom))
    if max(crop.size) > SHARP_CROP_LONG_SIDE:
        crop.thumbnail((SHARP_CROP_LONG_SIDE, SHARP_CROP_LONG_SIDE), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    crop.save(output, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    return output.getvalue(), (int(crop.width), int(crop.height))


def sanitize_image_bytes(
    raw: bytes, box: tuple[float, float, float, float] | None = None
) -> SanitizedScanImage:
    """Decode, verify, orient, resize, and metadata-strip a scan photo.

    With a guide ``box`` the same decoded image is also cut to that box before it is shrunk, so the crop keeps
    the camera's own detail (see ``SanitizedScanImage.sharp_crop``).
    """
    if not raw:
        raise ScanUploadError("An uploaded scan photo is empty.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                image_format = str(source.format or "").upper()
                if image_format not in ALLOWED_IMAGE_FORMATS:
                    raise ScanUploadError("Only JPEG, PNG, WebP, and HEIC scan photos are supported.")
                if image_format in {"HEIF", "HEIC"} and not HEIC_AVAILABLE:
                    raise ScanUploadError("HEIC support is unavailable on this server.")
                if getattr(source, "n_frames", 1) != 1:
                    raise ScanUploadError("Animated images cannot be used as scan photos.")
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise ScanUploadError("The scan photo has unsupported dimensions.")
                source.load()
                oriented = ImageOps.exif_transpose(source)
                if oriented.mode in {"RGBA", "LA"} or (
                    oriented.mode == "P" and "transparency" in oriented.info
                ):
                    rgba = oriented.convert("RGBA")
                    rgb = Image.new("RGB", rgba.size, "white")
                    rgb.paste(rgba, mask=rgba.getchannel("A"))
                    oriented = rgb
                else:
                    oriented = oriented.convert("RGB")
                frame_size = (int(oriented.width), int(oriented.height))
                cut = _cut_sharp_crop(oriented, box) if box is not None else None
                oriented.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                oriented.save(
                    output,
                    format="JPEG",
                    quality=JPEG_QUALITY,
                    optimize=True,
                    progressive=True,
                )
    except ScanUploadError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ScanUploadError("The scan photo is too large to decode safely.")
    except (UnidentifiedImageError, OSError, ValueError):
        raise ScanUploadError("The uploaded file is not a valid supported image.")

    if cut is None:
        return SanitizedScanImage(output.getvalue())
    return SanitizedScanImage(output.getvalue(), sharp_crop=cut[0], frame_size=frame_size, crop_size=cut[1])


def _job_directory(job_id: int) -> Path:
    return scan_upload_root() / str(int(job_id))


def store_sanitized_image(job_id: int, image: SanitizedScanImage) -> tuple[str, int]:
    """Atomically persist an already-sanitized JPEG under a random name."""
    job_dir = _job_directory(job_id)
    job_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    name = f"{uuid.uuid4().hex}.jpg"
    final_path = job_dir / name
    temporary_path = job_dir / f".{name}.tmp"
    try:
        with temporary_path.open("xb") as handle:
            handle.write(image.data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, final_path)
        final_path.chmod(0o600)
    finally:
        temporary_path.unlink(missing_ok=True)
    relative_path = final_path.relative_to(scan_upload_root()).as_posix()
    return relative_path, len(image.data)


def guide_box_from_filename(filename: str | None) -> tuple[float, float, float, float] | None:
    """The guide-frame box (x, y, w, h as 0-1 fractions) encoded in an upload name."""
    match = GUIDE_BOX_NAME.search(str(filename or ""))
    if not match:
        return None
    x, y, w, h = (int(group) / 1000 for group in match.groups())
    if w < 0.1 or h < 0.1 or x + w > 1.001 or y + h > 1.001:
        return None
    return x, y, w, h


def make_recognition_image(
    jpeg: bytes,
    box: tuple[float, float, float, float] | None,
    *,
    long_side: int = RECOGNITION_LONG_SIDE,
) -> bytes | None:
    """The guide-frame crop (or the whole photo when there is none), resized for a model.

    Returns None when there is no box, or the stored photo is already small
    enough: the stored photo is then used as it is.
    """
    if box is None:
        return None
    try:
        with Image.open(io.BytesIO(jpeg)) as image:
            image = image.convert("RGB")
            width, height = image.size
            if box is not None:
                x, y, w, h = box
                image = image.crop(
                    (
                        int(round(x * width)),
                        int(round(y * height)),
                        int(round((x + w) * width)),
                        int(round((y + h) * height)),
                    )
                )
            if max(image.size) > long_side:
                image.thumbnail((long_side, long_side), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=JPEG_QUALITY)
            return output.getvalue()
    except Exception:
        return None


def downscale_for_recognition(
    data: bytes, content_type: str = "image/jpeg", *, long_side: int = RECOGNITION_LONG_SIDE
) -> tuple[bytes, str]:
    """Shrink a photo to ``long_side`` px for a model; unchanged when already small."""
    try:
        with Image.open(io.BytesIO(data)) as image:
            if max(image.size) <= long_side:
                return data, content_type
            image = image.convert("RGB")
            image.thumbnail((long_side, long_side), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=JPEG_QUALITY)
            return output.getvalue(), "image/jpeg"
    except Exception:
        return data, content_type


def _recognition_sibling(path: Path) -> Path:
    return path.with_name(f"{path.stem}.rec.jpg")


def store_recognition_image(relative_path: str, data: bytes) -> None:
    sibling = _recognition_sibling(resolve_scan_path(relative_path))
    sibling.write_bytes(data)
    sibling.chmod(0o600)


def read_recognition_image(relative_path: str) -> bytes:
    """What recognition sends: the stored lighter crop when there is one, else the photo."""
    path = resolve_scan_path(relative_path)
    sibling = _recognition_sibling(path)
    if sibling.is_file():
        return sibling.read_bytes()
    return path.read_bytes()


def _crop_sibling(path: Path) -> Path:
    return path.with_name(f"{path.stem}.crop.jpg")


def _frame_sibling(path: Path) -> Path:
    return path.with_name(f"{path.stem}.frame.json")


def _write_private(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(data)
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def store_sharp_crop(relative_path: str, image: SanitizedScanImage) -> bool:
    """Keep the sharper guide crop (and the frame/crop sizes) beside the stored photo. False when there is none."""
    if not image.sharp_crop:
        return False
    path = resolve_scan_path(relative_path)
    _write_private(_crop_sibling(path), image.sharp_crop)
    sizes = {
        "frame": list(image.frame_size) if image.frame_size else None,
        "crop": list(image.crop_size) if image.crop_size else None,
    }
    _write_private(_frame_sibling(path), json.dumps(sizes).encode("utf-8"))
    return True


def read_text_photo(relative_path: str) -> bytes:
    """What the card's text is read from: the sharper guide crop when there is one, else today's stored photo."""
    path = resolve_scan_path(relative_path)
    sibling = _crop_sibling(path)
    if sibling.is_file():
        try:
            return sibling.read_bytes()
        except OSError:
            pass
    return path.read_bytes()


def read_capture_info(relative_path: str) -> dict | None:
    """``{"frame": [w, h], "crop": [w, h]}`` as the camera delivered it, or None when no crop was kept."""
    try:
        data = json.loads(_frame_sibling(resolve_scan_path(relative_path)).read_text(encoding="utf-8"))
    except (OSError, ValueError, ScanUploadError):
        return None
    return data if isinstance(data, dict) else None


def resolve_scan_path(relative_path: str) -> Path:
    root = scan_upload_root()
    candidate = (root / str(relative_path or "")).resolve()
    if candidate == root or root not in candidate.parents:
        raise ScanUploadError("Invalid scan image path.")
    return candidate


def delete_scan_image(relative_path: str | None) -> None:
    if not relative_path:
        return
    try:
        path = resolve_scan_path(relative_path)
    except ScanUploadError:
        return
    path.unlink(missing_ok=True)
    _recognition_sibling(path).unlink(missing_ok=True)
    _crop_sibling(path).unlink(missing_ok=True)
    _frame_sibling(path).unlink(missing_ok=True)
    try:
        path.parent.rmdir()
    except OSError:
        pass


def delete_job_directory(job_id: int) -> None:
    shutil.rmtree(_job_directory(job_id), ignore_errors=True)


def purge_orphaned_scan_directories(
    db: Session,
    *,
    now: datetime.datetime | None = None,
    grace_minutes: int = 60,
) -> int:
    """Remove crash leftovers that have no committed database job."""
    now = now or datetime.datetime.utcnow()
    cutoff = now.timestamp() - (grace_minutes * 60)
    known_ids = {str(row[0]) for row in db.query(ScanJob.id).all()}
    removed = 0
    for child in scan_upload_root().iterdir():
        if not child.is_dir() or child.name in known_ids:
            continue
        try:
            if child.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        shutil.rmtree(child, ignore_errors=True)
        removed += 1
    return removed


async def create_scan_job(
    db: Session,
    user_id: int,
    uploads: list,
    *,
    batch_modes: list[bool] | None = None,
    before_commit: Callable[[ScanJob], None] | None = None,
    crop_for_recognition: bool = False,
) -> ScanJob:
    """Validate and persist a job without retaining any original upload bytes."""
    if not uploads:
        raise ScanUploadError("At least one scan photo is required.")
    if batch_modes is None:
        batch_modes = [len(uploads) > 1] * len(uploads)
    if len(batch_modes) != len(uploads):
        raise ScanUploadError("Scan processing choices do not match the uploaded photos.")

    now = datetime.datetime.utcnow()
    job = ScanJob(
        user_id=user_id,
        status="pending",
        created_at=now,
        updated_at=now,
        expires_at=now + datetime.timedelta(days=SCAN_RETENTION_DAYS),
    )
    db.add(job)
    db.flush()
    # Creating two jobs for the same user at once must not race on the
    # round-robin cursor's primary key. PostgreSQL and the SQLite test suite
    # both support this conflict-safe insert.
    db.execute(
        text(
            "INSERT INTO scan_queue_user_state (user_id, last_dispatched_at) "
            "VALUES (:user_id, NULL) ON CONFLICT (user_id) DO NOTHING"
        ),
        {"user_id": user_id},
    )

    raw_total = 0
    try:
        for position, upload in enumerate(uploads):
            raw = await read_limited_upload(
                upload,
                remaining_job_bytes=MAX_JOB_BYTES - raw_total,
            )
            raw_total += len(raw)
            box = guide_box_from_filename(getattr(upload, "filename", None))
            sanitized = sanitize_image_bytes(raw, box)
            relative_path, byte_size = store_sanitized_image(job.id, sanitized)
            store_sharp_crop(relative_path, sanitized)
            lighter = (
                make_recognition_image(sanitized.data, box)
                if crop_for_recognition
                else None
            )
            if lighter is not None:
                store_recognition_image(relative_path, lighter)
            db.add(
                ScanJobItem(
                    job_id=job.id,
                    user_id=user_id,
                    position=position,
                    image_path=relative_path,
                    content_type=sanitized.content_type,
                    byte_size=byte_size,
                    batch_mode=bool(batch_modes[position]) and len(uploads) > 1,
                    status="pending",
                    resolved=False,
                    attempts=0,
                    transient_failures=0,
                    next_attempt_at=now,
                    created_at=now,
                    updated_at=now,
                )
            )
        if before_commit is not None:
            # Lets a caller stage rows (e.g. an idempotency record) in the same
            # transaction as the job. Items must be visible to its queries.
            db.flush()
            before_commit(job)
        db.commit()
        db.refresh(job)
        return job
    except Exception:
        db.rollback()
        delete_job_directory(job.id)
        raise
