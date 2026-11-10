import datetime
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi import UploadFile
    from PIL import Image
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from starlette.datastructures import Headers

    from database import Base
    from models import ScanJobItem, User
    from services import scan_storage
    from services.scan_storage import ScanUploadError, create_scan_job, sanitize_image_bytes

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _image_bytes(image_format="JPEG", *, size=(800, 1100), exif=False):
    image = Image.new("RGB", size, "#d92828")
    output = io.BytesIO()
    kwargs = {}
    if exif:
        metadata = Image.Exif()
        metadata[274] = 6
        metadata[270] = "private scan metadata"
        kwargs["exif"] = metadata
    image.save(output, format=image_format, **kwargs)
    return output.getvalue()


def _upload(data, content_type="image/jpeg"):
    return UploadFile(
        file=io.BytesIO(data),
        filename="private-original-name.jpg",
        headers=Headers({"content-type": content_type}),
    )


@unittest.skipUnless(DEPS_AVAILABLE, "Scanner image dependencies are not installed")
class ScanSanitizationTests(unittest.TestCase):
    def test_reencodes_orients_resizes_and_strips_metadata(self):
        sanitized = sanitize_image_bytes(_image_bytes(size=(3000, 4000), exif=True))

        with Image.open(io.BytesIO(sanitized.data)) as result:
            self.assertEqual(result.format, "JPEG")
            self.assertLessEqual(max(result.size), 2048)
            self.assertFalse(result.getexif())
        self.assertEqual(sanitized.content_type, "image/jpeg")

    def test_accepts_png_and_webp_but_always_outputs_safe_jpeg(self):
        for image_format in ("PNG", "WEBP"):
            with self.subTest(image_format=image_format):
                sanitized = sanitize_image_bytes(_image_bytes(image_format))
                with Image.open(io.BytesIO(sanitized.data)) as result:
                    self.assertEqual(result.format, "JPEG")

    def test_rejects_non_images_and_unsupported_formats(self):
        with self.assertRaises(ScanUploadError):
            sanitize_image_bytes(b"not an image")

        animated = io.BytesIO()
        frames = [Image.new("RGB", (8, 8), color) for color in ("red", "blue")]
        frames[0].save(animated, format="GIF", save_all=True, append_images=frames[1:])
        with self.assertRaises(ScanUploadError):
            sanitize_image_bytes(animated.getvalue())

    @unittest.skipUnless(getattr(scan_storage, "HEIC_AVAILABLE", False), "pillow-heif is unavailable")
    def test_accepts_heic_and_normalizes_it_to_jpeg(self):
        raw = _image_bytes("HEIF")
        sanitized = sanitize_image_bytes(raw)
        with Image.open(io.BytesIO(sanitized.data)) as result:
            self.assertEqual(result.format, "JPEG")


@unittest.skipUnless(DEPS_AVAILABLE, "Scanner image dependencies are not installed")
class ScanJobStorageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"SCAN_UPLOAD_DIR": self.temp_dir.name})
        self.env.start()
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(username="scan-owner", hashed_password="x")
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    async def test_job_stores_only_sanitized_randomly_named_files(self):
        before = datetime.datetime.utcnow()
        job = await create_scan_job(self.db, self.user.id, [_upload(_image_bytes())])
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()

        self.assertNotIn("private-original-name", item.image_path)
        stored = scan_storage.resolve_scan_path(item.image_path)
        self.assertTrue(stored.is_file())
        self.assertEqual(stored.read_bytes()[:2], b"\xff\xd8")
        self.assertEqual(item.content_type, "image/jpeg")
        self.assertGreaterEqual(job.expires_at, before + datetime.timedelta(days=13, hours=23))

    async def test_accepts_more_than_fifty_photos_in_one_job(self):
        uploads = [_upload(_image_bytes(size=(8, 8))) for _ in range(53)]
        job = await create_scan_job(self.db, self.user.id, uploads)
        self.assertEqual(len(job.items), 53)

    async def test_rejects_per_file_and_total_limits_and_cleans_partial_job(self):
        small = _image_bytes(size=(8, 8))
        with patch.object(scan_storage, "MAX_FILE_BYTES", len(small) - 1):
            with self.assertRaises(ScanUploadError):
                await create_scan_job(self.db, self.user.id, [_upload(small)])

        with patch.object(scan_storage, "MAX_JOB_BYTES", len(small) + 10):
            with self.assertRaises(ScanUploadError):
                await create_scan_job(
                    self.db,
                    self.user.id,
                    [_upload(small), _upload(small)],
                )
        self.assertEqual(list(scan_storage.scan_upload_root().iterdir()), [])


def _camera_frame(size=(3840, 2160)):
    """A 4K frame: fine vertical stripes that a 2048 px shrink blurs but the original keeps."""
    image = Image.new("RGB", size, "white")
    pixels = image.load()
    for x in range(0, size[0], 2):
        for y in range(0, size[1], 8):
            pixels[x, y] = (0, 0, 0)
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=95)
    return output.getvalue()


def _guided_upload(data, name="scan-1700000000000-g300_100_400_800.jpg"):
    return UploadFile(file=io.BytesIO(data), filename=name, headers=Headers({"content-type": "image/jpeg"}))


BOX = (0.3, 0.1, 0.4, 0.8)


@unittest.skipUnless(DEPS_AVAILABLE, "Scanner image dependencies are not installed")
class SharpGuideCropTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"SCAN_UPLOAD_DIR": self.temp_dir.name})
        self.env.start()
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.user = User(username="crop-owner", hashed_password="x")
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    async def _job(self, uploads, **kwargs):
        job = await create_scan_job(self.db, self.user.id, uploads, **kwargs)
        return job, self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).order_by(ScanJobItem.position).all()

    def test_the_crop_is_cut_from_the_original_not_from_the_shrunken_photo(self):
        raw = _camera_frame()
        sanitized = sanitize_image_bytes(raw, BOX)

        self.assertEqual(sanitized.frame_size, (3840, 2160))
        # 40% x 80% of the original is 1536 x 1728: capped at 1600 on the long side, still a real 1.0 scale.
        self.assertEqual(max(sanitized.crop_size), 1600)
        with Image.open(io.BytesIO(sanitized.sharp_crop)) as crop:
            self.assertEqual(crop.format, "JPEG")
            self.assertEqual(crop.size, sanitized.crop_size)
            self.assertFalse(crop.getexif())
        # Cutting the same box from the 2048 px review photo gives a much smaller picture.
        with Image.open(io.BytesIO(sanitized.data)) as photo:
            self.assertEqual(max(photo.size), 2048)
            shrunk_crop_height = round(BOX[3] * photo.height)
        self.assertGreater(sanitized.crop_size[1], shrunk_crop_height * 1.5)

    def test_the_review_photo_is_exactly_what_it_was_without_a_box(self):
        raw = _camera_frame()
        self.assertEqual(sanitize_image_bytes(raw, BOX).data, sanitize_image_bytes(raw).data)

    def test_no_guide_box_means_no_crop(self):
        sanitized = sanitize_image_bytes(_camera_frame())
        self.assertIsNone(sanitized.sharp_crop)
        self.assertIsNone(sanitized.frame_size)

    async def test_upload_with_a_box_keeps_the_crop_beside_the_photo_with_private_files(self):
        _job, (item,) = await self._job([_guided_upload(_camera_frame())])
        stored = scan_storage.resolve_scan_path(item.image_path)
        crop = stored.with_name(f"{stored.stem}.crop.jpg")
        self.assertTrue(crop.is_file())
        self.assertEqual(scan_storage.read_text_photo(item.image_path), crop.read_bytes())
        info = scan_storage.read_capture_info(item.image_path)
        self.assertEqual(info["frame"], [3840, 2160])
        self.assertEqual(max(info["crop"]), 1600)
        if os.name != "nt":
            self.assertEqual(crop.stat().st_mode & 0o777, 0o600)

    async def test_upload_without_a_box_has_no_crop_and_reads_the_stored_photo(self):
        _job, (item,) = await self._job([_upload(_image_bytes(size=(1200, 900)))])
        stored = scan_storage.resolve_scan_path(item.image_path)
        self.assertEqual(sorted(path.name for path in stored.parent.iterdir()), [stored.name])
        self.assertIsNone(scan_storage.read_capture_info(item.image_path))
        self.assertEqual(scan_storage.read_text_photo(item.image_path), stored.read_bytes())

    async def test_reading_falls_back_to_the_photo_when_the_crop_is_gone(self):
        _job, (item,) = await self._job([_guided_upload(_camera_frame())])
        stored = scan_storage.resolve_scan_path(item.image_path)
        stored.with_name(f"{stored.stem}.crop.jpg").unlink()
        self.assertEqual(scan_storage.read_text_photo(item.image_path), stored.read_bytes())

    async def test_the_matcher_is_handed_the_crop_and_falls_back_to_the_photo(self):
        from services import scan_queue

        _job, (guided, plain) = await self._job([_guided_upload(_camera_frame()), _upload(_image_bytes(size=(900, 1200)))])
        self.assertEqual(scan_queue._full_photo_for_item(self.db, guided.id), scan_storage.read_text_photo(guided.image_path))
        self.assertNotEqual(
            scan_queue._full_photo_for_item(self.db, guided.id), scan_storage.resolve_scan_path(guided.image_path).read_bytes()
        )
        self.assertEqual(scan_queue._full_photo_for_item(self.db, plain.id), scan_storage.resolve_scan_path(plain.image_path).read_bytes())
        self.assertEqual(scan_queue._capture_info_for_item(self.db, guided.id)["frame"], [3840, 2160])
        self.assertIsNone(scan_queue._capture_info_for_item(self.db, plain.id))
        from services.card_match import shadow

        self.assertEqual(shadow._read_full_photo(guided.image_path), scan_storage.read_text_photo(guided.image_path))
        self.assertEqual(shadow._read_full_photo(plain.image_path), scan_storage.resolve_scan_path(plain.image_path).read_bytes())

    async def test_what_the_model_receives_does_not_change(self):
        raw = _camera_frame()
        _job, (item,) = await self._job([_guided_upload(raw)], crop_for_recognition=True)
        without_crop = sanitize_image_bytes(raw)
        self.assertEqual(scan_storage.resolve_scan_path(item.image_path).read_bytes(), without_crop.data)
        expected = scan_storage.make_recognition_image(without_crop.data, BOX)
        self.assertEqual(scan_storage.read_recognition_image(item.image_path), expected)
        with Image.open(io.BytesIO(expected)) as sent:
            self.assertLessEqual(max(sent.size), 1024)

    async def test_deleting_the_photo_or_the_job_removes_the_crop_too(self):
        _job, (first, second) = await self._job([_guided_upload(_camera_frame()), _guided_upload(_camera_frame(), "scan-2-g300_100_400_800.jpg")])
        directory = scan_storage.resolve_scan_path(first.image_path).parent
        scan_storage.delete_scan_image(first.image_path)
        left = {path.name for path in directory.iterdir()}
        self.assertEqual({name for name in left if name.startswith(Path(first.image_path).stem)}, set())
        self.assertIn(Path(second.image_path).name, left)
        self.assertIn(f"{Path(second.image_path).stem}.crop.jpg", left)
        self.assertIsNone(scan_storage.read_capture_info(first.image_path))
        scan_storage.delete_job_directory(first.job_id)
        self.assertFalse(directory.exists())

    async def test_expired_jobs_and_orphaned_directories_leave_no_crop_behind(self):
        from services.scan_queue import purge_expired_scan_jobs

        job, (item,) = await self._job([_guided_upload(_camera_frame())])
        directory = scan_storage.resolve_scan_path(item.image_path).parent
        job.expires_at = datetime.datetime.utcnow() - datetime.timedelta(days=1)
        self.db.commit()
        self.assertEqual(purge_expired_scan_jobs(self.db), 1)
        self.assertFalse(directory.exists())


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class MultiPicturePhotoTests(unittest.TestCase):
    """iPhone photos that carry a second picture (HDR gain map, depth map) are read as their primary photo."""

    @staticmethod
    def _mpo(size=(800, 1100), exif=False, primary="#d92828"):
        primary_image = Image.new("RGB", size, primary)
        second = Image.new("RGB", (200, 275), "#0000ff")
        output = io.BytesIO()
        kwargs = {}
        if exif:
            metadata = Image.Exif()
            metadata[274] = 6
            metadata[270] = "private scan metadata"
            kwargs["exif"] = metadata
        primary_image.save(output, format="MPO", save_all=True, append_images=[second], **kwargs)
        return output.getvalue()

    def test_fixture_really_is_mpo(self):
        with Image.open(io.BytesIO(self._mpo())) as image:
            self.assertEqual(image.format, "MPO")
            self.assertEqual(image.n_frames, 2)

    def test_two_picture_jpeg_is_accepted_as_single_frame_primary(self):
        result = sanitize_image_bytes(self._mpo())
        with Image.open(io.BytesIO(result.data)) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(getattr(image, "n_frames", 1), 1)
            self.assertEqual(image.size, (800, 1100))
            self.assertEqual(len(image.getexif()), 0)
            red, _green, blue = image.convert("RGB").getpixel((400, 550))
            self.assertGreater(red, 150)
            self.assertLess(blue, 100)

    def test_exif_orientation_of_primary_frame_is_applied_and_stripped(self):
        result = sanitize_image_bytes(self._mpo(size=(800, 1100), exif=True))
        with Image.open(io.BytesIO(result.data)) as image:
            self.assertEqual(image.size, (1100, 800))
            self.assertEqual(len(image.getexif()), 0)
        self.assertNotIn(b"private scan metadata", result.data)

    def test_sharp_crop_still_works_for_two_picture_jpeg(self):
        result = sanitize_image_bytes(self._mpo(), (0.1, 0.1, 0.5, 0.5))
        self.assertIsNotNone(result.sharp_crop)
        self.assertEqual(result.frame_size, (800, 1100))
        self.assertEqual(result.crop_size, (400, 550))

    def test_animated_gif_and_webp_are_still_refused(self):
        frames = [Image.new("RGB", (64, 64), "red"), Image.new("RGB", (64, 64), "blue")]
        for image_format in ("GIF", "WEBP"):
            output = io.BytesIO()
            frames[0].save(output, format=image_format, save_all=True, append_images=frames[1:])
            with self.assertRaises(ScanUploadError):
                sanitize_image_bytes(output.getvalue())
        output = io.BytesIO()
        frames[0].save(output, format="WEBP", save_all=True, append_images=frames[1:])
        with self.assertRaisesRegex(ScanUploadError, "Animated"):
            sanitize_image_bytes(output.getvalue())

    def test_still_heic_with_extra_top_level_image_uses_primary(self):
        if not scan_storage.HEIC_AVAILABLE:
            self.skipTest("pillow-heif is not installed")
        output = io.BytesIO()
        Image.new("RGB", (64, 48), "red").save(
            output, format="HEIF", save_all=True, append_images=[Image.new("RGB", (32, 24), "blue")]
        )
        result = sanitize_image_bytes(output.getvalue())
        with Image.open(io.BytesIO(result.data)) as image:
            self.assertEqual(image.size, (64, 48))

    def test_unsupported_format_logs_and_gets_plain_message(self):
        output = io.BytesIO()
        Image.new("RGB", (32, 32), "red").save(output, format="PPM")
        with self.assertLogs("services.scan_storage", level="WARNING") as logs:
            with self.assertRaisesRegex(ScanUploadError, "Only JPEG, PNG, WebP, and HEIC"):
                sanitize_image_bytes(output.getvalue())
        line = logs.output[0]
        self.assertIn("format=PPM", line)
        self.assertIn("n_frames=1", line)
        self.assertIn(f"size_bytes={len(output.getvalue())}", line)

    def test_known_unreadable_still_format_is_named(self):
        output = io.BytesIO()
        Image.new("RGB", (32, 32), "red").save(output, format="TIFF")
        with self.assertLogs("services.scan_storage", level="WARNING"):
            with self.assertRaisesRegex(ScanUploadError, "RAW or TIFF"):
                sanitize_image_bytes(output.getvalue())

    def test_single_card_path_accepts_two_picture_jpeg(self):
        # POST /recognize reads its upload through sanitize_image_bytes (api.recognize cannot be imported on
        # Windows because of fcntl, so this checks the wiring in the source and runs the shared function).
        source = (Path(__file__).resolve().parent.parent / "api" / "recognize.py").read_text(encoding="utf-8")
        self.assertIn("sanitized = sanitize_image_bytes(raw_image)", source)
        self.assertEqual(sanitize_image_bytes(self._mpo()).content_type, "image/jpeg")
