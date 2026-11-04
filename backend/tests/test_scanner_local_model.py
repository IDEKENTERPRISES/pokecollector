"""Lighter, steadier requests to a self-hosted (Ollama-style) scanner endpoint."""

import asyncio
import io
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

try:
    from fastapi import HTTPException
    from PIL import Image

    from api import recognize
    from api.recognize import match_card_info
    from services import scan_providers, scan_queue, scan_storage
    from services.scan_providers import (
        OPENAI,
        ProviderRequestRejectedError,
        ScanProvider,
        default_scanner_request_timeout,
        self_hosted_request_options,
    )

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

LOCAL = {"OPENAI_BASE_URL": "http://gaming-pc:11434/v1"}


def jpeg(width, height, colour=(120, 90, 60)):
    out = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(out, "JPEG")
    return out.getvalue()


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class RequestOptionTests(unittest.IsolatedAsyncioTestCase):
    def test_self_hosted_endpoint_gets_json_temperature_and_a_token_bound(self):
        with patch.dict(os.environ, LOCAL):
            self.assertEqual(
                self_hosted_request_options(json_output=True, max_tokens=400),
                {
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                    "max_tokens": 400,
                },
            )
            self.assertEqual(
                self_hosted_request_options(max_tokens=16),
                {"temperature": 0, "max_tokens": 16},
            )

    def test_openai_proper_is_sent_nothing_new(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": ""}):
            self.assertEqual(
                self_hosted_request_options(json_output=True, max_tokens=400), {}
            )

    async def _send(self, **kwargs):
        post = AsyncMock(
            return_value=Mock(
                json=lambda: {"choices": [{"message": {"content": "{}"}}], "usage": {}}
            )
        )
        with patch.object(scan_providers, "post_openai_chat", post):
            await ScanProvider(OPENAI, "qwen3-vl:4b-instruct").generate_text(
                object(), "", [scan_providers.text_part("hi")], **kwargs
            )
        return post

    async def test_request_body_carries_the_options_for_a_local_endpoint(self):
        with patch.dict(os.environ, LOCAL):
            post = await self._send(json_output=True, max_tokens=400)
        body = post.await_args.args[3]
        self.assertEqual(body["temperature"], 0)
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual(body["max_tokens"], 400)
        self.assertEqual(body["model"], "qwen3-vl:4b-instruct")

    async def test_request_body_is_unchanged_for_openai_proper(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": ""}):
            post = await self._send(json_output=True, max_tokens=400)
        self.assertEqual(set(post.await_args.args[3]), {"model", "messages"})

    async def test_a_rejected_option_is_retried_once_without_options(self):
        post = AsyncMock(
            side_effect=[
                ProviderRequestRejectedError(detail="no", reason="request_rejected"),
                Mock(json=lambda: {"choices": [{"message": {"content": "ok"}}]}),
            ]
        )
        with patch.dict(os.environ, LOCAL), patch.object(
            scan_providers, "post_openai_chat", post
        ):
            text, _ = await ScanProvider(OPENAI, "m").generate_text(
                object(), "", [scan_providers.text_part("hi")], json_output=True
            )
        self.assertEqual(text, "ok")
        self.assertEqual(post.await_count, 2)
        self.assertNotIn("response_format", post.await_args_list[1].args[3])

    async def test_a_context_overflow_is_not_repeated(self):
        post = AsyncMock(
            side_effect=ProviderRequestRejectedError(detail="big", reason="context_too_small")
        )
        with patch.dict(os.environ, LOCAL), patch.object(
            scan_providers, "post_openai_chat", post
        ):
            with self.assertRaises(ProviderRequestRejectedError):
                await ScanProvider(OPENAI, "m").generate_text(
                    object(), "", [scan_providers.text_part("hi")], json_output=True
                )
        self.assertEqual(post.await_count, 1)

    def test_context_overflow_message_is_classified(self):
        resp = Mock()
        resp.json.return_value = {
            "error": {"message": "request (5426 tokens) exceeds the available context size (4096 tokens)"}
        }
        resp.text = ""
        with patch.object(scan_providers, "openai_error_code", return_value=("", "")):
            self.assertEqual(scan_providers.openai_rejection_reason(resp), "context_too_small")

    def test_local_models_default_to_a_two_minute_timeout(self):
        with patch.dict(os.environ, LOCAL):
            self.assertEqual(default_scanner_request_timeout(OPENAI), 120)
            self.assertEqual(default_scanner_request_timeout("gemini"), 30)
        with patch.dict(os.environ, {"OPENAI_BASE_URL": ""}):
            self.assertEqual(default_scanner_request_timeout(OPENAI), 30)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class ConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    def test_defaults_are_one_for_openai_compatible_and_three_for_gemini(self):
        self.assertEqual(scan_queue.MAX_CONCURRENT_OPENAI_SCANS, 1)
        self.assertEqual(scan_queue.MAX_CONCURRENT_SCAN_PROCESSING, 3)

    def test_the_limits_are_configurable(self):
        with patch.dict(os.environ, {"SCAN_MAX_CONCURRENT_OPENAI": "2", "X": "y"}):
            self.assertEqual(scan_queue._env_positive_int("SCAN_MAX_CONCURRENT_OPENAI", 1), 2)
        with patch.dict(os.environ, {"SCAN_MAX_CONCURRENT_OPENAI": "zero"}):
            self.assertEqual(scan_queue._env_positive_int("SCAN_MAX_CONCURRENT_OPENAI", 1), 1)

    def test_one_gate_per_endpoint(self):
        first = scan_queue._endpoint_gate("http://pc:11434/v1")
        self.assertIs(first, scan_queue._endpoint_gate("http://pc:11434/v1"))
        self.assertIsNot(first, scan_queue._endpoint_gate("http://other:11434/v1"))

    async def test_a_local_endpoint_runs_one_scan_at_a_time(self):
        running = peak = 0
        claim = SimpleNamespace(item_id=1, openai_endpoint="http://pc-test:11434/v1")

        async def one():
            nonlocal running, peak
            async with scan_queue._ProcessingSlots(claim):
                running += 1
                peak = max(peak, running)
                await asyncio.sleep(0.05)
                running -= 1

        await asyncio.gather(*(one() for _ in range(4)))
        self.assertEqual(peak, 1)

    async def test_gemini_keeps_the_shared_limit(self):
        limiter = scan_queue._ProcessWideAsyncSemaphore(3)
        running = peak = 0

        async def one():
            nonlocal running, peak
            async with scan_queue._ProcessingSlots(SimpleNamespace(item_id=1, openai_endpoint=None)):
                running += 1
                peak = max(peak, running)
                await asyncio.sleep(0.05)
                running -= 1

        with patch.object(scan_queue, "_scan_processing_semaphore", limiter):
            await asyncio.gather(*(one() for _ in range(6)))
        self.assertEqual(peak, 3)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class CropMappingTests(unittest.TestCase):
    def test_box_is_read_from_the_file_name(self):
        self.assertEqual(
            scan_storage.guide_box_from_filename("scan-1700-g118_142_764_820.jpg"),
            (0.118, 0.142, 0.764, 0.82),
        )
        self.assertIsNone(scan_storage.guide_box_from_filename("scan-1700.jpg"))
        self.assertIsNone(scan_storage.guide_box_from_filename(None))
        self.assertIsNone(scan_storage.guide_box_from_filename("a-g900_0_500_500.jpg"))
        self.assertIsNone(scan_storage.guide_box_from_filename("a-g0_0_50_50.jpg"))

    def test_crop_selects_the_guide_area_and_is_about_1024_px(self):
        # Left half red, right half blue; the guide covers the right half only.
        image = Image.new("RGB", (1536, 2048), (200, 0, 0))
        image.paste((0, 0, 200), (768, 0, 1536, 2048))
        out = io.BytesIO()
        image.save(out, "JPEG")
        crop = scan_storage.make_recognition_image(out.getvalue(), (0.5, 0.0, 0.5, 1.0))
        cropped = Image.open(io.BytesIO(crop))
        self.assertEqual(max(cropped.size), 1024)
        self.assertAlmostEqual(cropped.size[0] / cropped.size[1], 768 / 2048, places=2)
        red, _, blue = cropped.getpixel((cropped.width // 2, cropped.height // 2))
        self.assertLess(red, 60)
        self.assertGreater(blue, 150)

    def test_no_box_means_the_stored_photo_is_used(self):
        self.assertIsNone(scan_storage.make_recognition_image(jpeg(800, 800), None))

    def test_downscale_only_shrinks(self):
        small = jpeg(600, 800)
        self.assertEqual(scan_storage.downscale_for_recognition(small)[0], small)
        big, mime = scan_storage.downscale_for_recognition(jpeg(1536, 2048))
        self.assertEqual(max(Image.open(io.BytesIO(big)).size), 1024)
        self.assertEqual(mime, "image/jpeg")

    def test_recognition_copy_is_stored_read_and_removed_with_the_photo(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"SCAN_UPLOAD_DIR": root}):
            relative, _ = scan_storage.store_sanitized_image(
                1, scan_storage.SanitizedScanImage(jpeg(1536, 2048))
            )
            self.assertEqual(
                scan_storage.read_recognition_image(relative), jpeg(1536, 2048)
            )
            scan_storage.store_recognition_image(relative, b"crop")
            self.assertEqual(scan_storage.read_recognition_image(relative), b"crop")
            scan_storage.delete_scan_image(relative)
            self.assertEqual(os.listdir(root), [])


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class VisualVerificationCapTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        recognize._visual_paused_until = 0.0

    async def _run(self, provider_name, candidate_count=10, base_url=""):
        candidates = [
            {"id": f"c{i}", "number": None, "image": f"https://assets.tcgdex.net/{i}.webp"}
            for i in range(candidate_count)
        ]
        images = {c["id"]: jpeg(8, 11) for c in candidates}
        provider = Mock()
        provider.name, provider.is_gemini = provider_name, provider_name == "gemini"
        provider.requires_credential.return_value = False
        provider.generate_text = AsyncMock(return_value=("1", None))
        with patch.dict(os.environ, {"OPENAI_BASE_URL": base_url}), patch(
            "api.recognize._search_and_rank_candidates",
            new=AsyncMock(return_value=(candidates, 0)),
        ), patch(
            "api.recognize._download_candidate_images", new=AsyncMock(return_value=images)
        ), patch("api.recognize._phash_best_match", return_value=None), patch(
            "api.recognize.retain_ranked_candidates", side_effect=lambda c: list(c)
        ):
            await match_card_info(
                object(),
                {"name": "Dedenne"},
                image_b64="cGhvdG8=",
                mime_type="image/jpeg",
                allow_visual_verification=True,
                provider=provider,
                request_timeout_seconds=60,
            )
        return provider

    @staticmethod
    def _candidate_pictures(provider):
        parts = provider.generate_text.await_args.args[2]
        return sum(1 for part in parts if "image" in part) - 1  # minus the photo

    async def test_a_local_model_sees_at_most_four_candidates(self):
        provider = await self._run("openai", base_url="http://gaming-pc:11434/v1")
        self.assertEqual(self._candidate_pictures(provider), 4)

    async def test_openai_proper_and_gemini_keep_every_candidate(self):
        self.assertEqual(
            self._candidate_pictures(await self._run("openai", base_url="")), 10
        )
        self.assertEqual(self._candidate_pictures(await self._run("gemini")), 10)

    async def test_a_context_overflow_pauses_the_check_for_local_models(self):
        provider = Mock()
        provider.name, provider.is_gemini = "openai", False
        provider.requires_credential.return_value = False
        provider.generate_text = AsyncMock(
            side_effect=ProviderRequestRejectedError(detail="x", reason="context_too_small")
        )
        candidates = [
            {"id": f"c{i}", "number": None, "image": f"https://assets.tcgdex.net/{i}.webp"}
            for i in range(3)
        ]
        images = {c["id"]: jpeg(8, 11) for c in candidates}

        async def run():
            with patch.dict(os.environ, LOCAL), patch(
                "api.recognize._search_and_rank_candidates",
                new=AsyncMock(return_value=(list(candidates), 0)),
            ), patch(
                "api.recognize._download_candidate_images",
                new=AsyncMock(return_value=images),
            ), patch("api.recognize._phash_best_match", return_value=None):
                return await match_card_info(
                    object(),
                    {"name": "Dedenne"},
                    image_b64="cGhvdG8=",
                    mime_type="image/jpeg",
                    allow_visual_verification=True,
                    provider=provider,
                    request_timeout_seconds=60,
                )

        await run()
        await run()
        self.assertEqual(provider.generate_text.await_count, 1)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class CachedCandidatePictureTests(unittest.TestCase):
    def test_pictures_already_on_the_server_are_used_before_the_cdn(self):
        from services.card_picture_packs import card_image_key

        url = "https://assets.tcgdex.net/en/base/base1/4/low.webp"
        key = card_image_key("base1-4", url)
        db = Mock()
        db.query.return_value.filter.return_value.all.return_value = [(key, b"picture")]
        found = recognize._cached_candidate_pictures(
            db, [{"id": "base1-4", "image": url}, {"id": "none", "image": None}]
        )
        self.assertEqual(found, {"base1-4": b"picture"})

    def test_a_broken_cache_lookup_falls_back_to_the_cdn(self):
        db = Mock()
        db.query.side_effect = RuntimeError("down")
        self.assertEqual(
            recognize._cached_candidate_pictures(db, [{"id": "a", "image": "https://x/y"}]), {}
        )


if __name__ == "__main__":
    unittest.main()
