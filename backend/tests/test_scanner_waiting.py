"""A switched-off scanner endpoint parks scans instead of climbing the retry ladder."""

import asyncio
import datetime
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

try:
    import httpx
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import ScanJob, ScanJobItem, ScanQueueUserState, User
    from services import scan_queue, scanner_reachability
    from services.scan_providers import ScannerUnreachableError, post_openai_chat
    from services.scan_queue import (
        RecognitionScanError,
        claim_next_scan_item,
        hold_expiry_for_waiting_scans,
        job_progress,
        process_claimed_scan_item,
        purge_expired_scan_jobs,
        release_waiting_scans_if_reachable,
        retry_scan_item,
    )

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed")
class ScannerWaitingTests(unittest.TestCase):
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
        self.user = User(username="waiter", hashed_password="x")
        self.db.add(self.user)
        self.db.commit()
        scanner_reachability.reset_reachability()

    def tearDown(self):
        scanner_reachability.reset_reachability()
        self.db.close()
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    def _job(self, *, expires_in_days=14):
        now = datetime.datetime.utcnow()
        job = ScanJob(
            user_id=self.user.id,
            status="pending",
            created_at=now,
            updated_at=now,
            expires_at=now + datetime.timedelta(days=expires_in_days),
        )
        self.db.add(job)
        self.db.flush()
        if self.db.get(ScanQueueUserState, self.user.id) is None:
            self.db.add(ScanQueueUserState(user_id=self.user.id))
        path = os.path.join(self.temp_dir.name, str(job.id))
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, "0.jpg"), "wb") as handle:
            handle.write(b"jpeg")
        self.db.add(
            ScanJobItem(
                job_id=job.id,
                user_id=self.user.id,
                position=0,
                image_path=f"{job.id}/0.jpg",
                content_type="image/jpeg",
                byte_size=4,
                status="pending",
                resolved=False,
                attempts=0,
                transient_failures=0,
                next_attempt_at=now,
                created_at=now,
                updated_at=now,
            )
        )
        self.db.commit()
        return job

    def _process_with(self, processor):
        claim = claim_next_scan_item(self.db)
        self.assertIsNotNone(claim)
        with patch("database.SessionLocal", self.Session):
            asyncio.run(process_claimed_scan_item(claim, processor=processor))
        self.db.expire_all()
        return self.db.get(ScanJobItem, claim.item_id)

    def _park_one(self):
        job = self._job()
        processor = AsyncMock(side_effect=ScannerUnreachableError(url="http://x/v1"))
        item = self._process_with(processor)
        return job, item

    def test_connection_failure_waits_without_using_attempts_or_the_ladder(self):
        _, item = self._park_one()
        self.assertEqual(item.status, "retrying")
        self.assertEqual(item.retry_reason, "scanner_unreachable")
        self.assertIsNone(item.next_attempt_at)
        self.assertEqual(item.attempts, 0)
        self.assertEqual(item.transient_failures, 0)

    def test_waiting_scans_are_not_claimed_again_by_the_timer(self):
        self._park_one()
        self.assertIsNone(claim_next_scan_item(self.db))

    def test_repeated_outages_never_climb_the_backoff(self):
        job, item = self._park_one()
        for _ in range(4):
            scan_queue.release_waiting_scans(self.db)
            item = self._process_with(
                AsyncMock(side_effect=ScannerUnreachableError(url="http://x/v1"))
            )
        self.assertEqual(item.transient_failures, 0)
        self.assertIsNone(item.next_attempt_at)

    def test_released_within_a_minute_once_the_endpoint_answers(self):
        self._park_one()
        scanner_reachability.record_reachability("http://x/v1", False)
        with patch(
            "services.scan_queue.endpoint_reachable", AsyncMock(return_value=False)
        ):
            self.assertEqual(
                asyncio.run(release_waiting_scans_if_reachable(self.db)), 0
            )
        self.assertIsNone(claim_next_scan_item(self.db))
        with patch(
            "services.scan_queue.endpoint_reachable", AsyncMock(return_value=True)
        ):
            self.assertEqual(
                asyncio.run(release_waiting_scans_if_reachable(self.db)), 1
            )
        self.db.expire_all()
        self.assertIsNotNone(claim_next_scan_item(self.db))

    def test_wording_and_progress_report_waiting_for_the_scanner(self):
        job, _ = self._park_one()
        progress = job_progress(self.db, job)
        self.assertEqual(progress["retry_reason"], "scanner_unreachable")
        self.assertEqual(progress["waiting_for_scanner"], 1)
        self.assertIsNone(progress["next_retry_at"])

    def test_try_now_accepts_a_waiting_scan(self):
        _, item = self._park_one()
        retried = retry_scan_item(self.db, item)
        self.assertEqual(retried.status, "pending")
        self.assertIsNone(retried.retry_reason)
        self.assertIsNotNone(claim_next_scan_item(self.db))

    def test_try_now_accepts_an_ordinary_retrying_scan(self):
        self._job()
        claim = claim_next_scan_item(self.db)
        scan_queue.fail_claim(self.db, claim, "boom", transient=True)
        item = self.db.get(ScanJobItem, claim.item_id)
        self.assertEqual(item.status, "retrying")
        retried = retry_scan_item(self.db, item)
        self.assertEqual(retried.status, "pending")
        self.assertEqual(retried.transient_failures, 0)

    def test_waiting_scans_hold_the_expiry_clock(self):
        job, _ = self._park_one()
        job.expires_at = datetime.datetime.utcnow() - datetime.timedelta(hours=1)
        self.db.commit()
        hold_expiry_for_waiting_scans(self.db)
        self.assertEqual(purge_expired_scan_jobs(self.db), 0)
        self.db.expire_all()
        self.assertGreater(
            self.db.get(ScanJob, job.id).expires_at,
            datetime.datetime.utcnow() + datetime.timedelta(days=1),
        )

    def test_scans_that_are_not_waiting_still_expire(self):
        job = self._job()
        job.expires_at = datetime.datetime.utcnow() - datetime.timedelta(hours=1)
        self.db.commit()
        hold_expiry_for_waiting_scans(self.db)
        self.assertEqual(purge_expired_scan_jobs(self.db), 1)

    def test_recognition_errors_keep_their_retries(self):
        self._job()
        item = self._process_with(
            AsyncMock(side_effect=RecognitionScanError("no card"))
        )
        self.assertEqual(item.status, "retrying")
        self.assertEqual(item.attempts, 1)
        self.assertEqual(item.transient_failures, 0)
        self.assertIsNone(item.retry_reason)
        self.assertIsNotNone(item.next_attempt_at)

    def test_connect_error_raises_unreachable_and_marks_endpoint_down(self):
        client = MagicMock()
        client.post = AsyncMock(side_effect=httpx.ConnectError("refused"))
        with patch("asyncio.sleep", AsyncMock()), patch(
            "services.provider_rate_limit.raise_if_provider_blocked"
        ):
            with self.assertRaises(ScannerUnreachableError):
                asyncio.run(
                    post_openai_chat(
                        client, "http://pc:11434/v1/chat/completions", "", {}
                    )
                )
        self.assertTrue(scanner_reachability.known_down("http://pc:11434/v1"))

    def test_read_timeout_is_not_treated_as_switched_off(self):
        from fastapi import HTTPException

        client = MagicMock()
        client.post = AsyncMock(side_effect=httpx.ReadTimeout("slow"))
        with patch("asyncio.sleep", AsyncMock()), patch(
            "services.provider_rate_limit.raise_if_provider_blocked"
        ):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(
                    post_openai_chat(
                        client,
                        "http://pc:11434/v1/chat/completions",
                        "",
                        {},
                        max_attempts=1,
                    )
                )
        self.assertNotIsInstance(caught.exception, ScannerUnreachableError)

    def test_reachability_is_cached_for_about_a_minute(self):
        calls = []

        class FakeClient:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def get(self, url):
                calls.append(url)
                raise httpx.ConnectError("off")

        with patch("services.scanner_reachability.httpx.AsyncClient", FakeClient):
            self.assertFalse(
                asyncio.run(scanner_reachability.endpoint_reachable("http://pc/v1"))
            )
            self.assertFalse(
                asyncio.run(scanner_reachability.endpoint_reachable("http://pc/v1"))
            )
            self.assertEqual(len(calls), 1)
            asyncio.run(
                scanner_reachability.endpoint_reachable("http://pc/v1", force=True)
            )
            self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
