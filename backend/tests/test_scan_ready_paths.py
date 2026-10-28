"""Every path that finishes a scan job queues exactly one scans_ready push.

The sessions here use autoflush=False like database.SessionLocal, so the item changes of a
claim are still pending when the job status is refreshed (the real production situation).
"""

import datetime
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import NotificationQueue, ScanJob, ScanJobItem, ScanQueueUserState, User
    from services import push as push_service
    from services import scan_queue
    from services.scan_queue import (
        claim_next_scan_item,
        complete_claim,
        complete_claim_group,
        fail_claim,
    )

    DEPS_AVAILABLE = push_service.webpush is not None
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI/SQLAlchemy/pywebpush are not installed")
class ScansReadyPathTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, autoflush=False)
        self.db = self.Session()
        self.user = User(username="ash", hashed_password="x")
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def _job(self, photos=1, batch_mode=False):
        now = datetime.datetime.utcnow()
        job = ScanJob(
            user_id=self.user.id, status="pending", created_at=now, updated_at=now,
            expires_at=now + datetime.timedelta(days=14),
        )
        self.db.add(job)
        self.db.flush()
        if self.db.get(ScanQueueUserState, self.user.id) is None:
            self.db.add(ScanQueueUserState(user_id=self.user.id))
        for position in range(photos):
            self.db.add(ScanJobItem(
                job_id=job.id, user_id=self.user.id, position=position,
                image_path=f"{job.id}/{position}.jpg", content_type="image/jpeg", byte_size=4,
                status="pending", resolved=False, attempts=0, transient_failures=0,
                next_attempt_at=now, created_at=now, updated_at=now, batch_mode=batch_mode,
            ))
        self.db.commit()
        return job

    def _queued(self):
        self.db.expire_all()
        return self.db.query(NotificationQueue).filter_by(category="scans_ready").all()

    def test_single_photo_completed_queues_one_push(self):
        job = self._job()
        claim = claim_next_scan_item(self.db)
        self.assertTrue(complete_claim(self.db, claim, {"recognized": {}, "matches": []}))
        rows = self._queued()
        self.assertEqual([r.subject_key for r in rows], [f"job:{job.id}"])

    def test_single_photo_permanent_failure_queues_one_push(self):
        job = self._job()
        claim = claim_next_scan_item(self.db)
        self.assertTrue(fail_claim(self.db, claim, "no card found", permanent=True))
        self.assertEqual([r.subject_key for r in self._queued()], [f"job:{job.id}"])

    def test_failure_on_the_last_attempt_queues_one_push(self):
        job = self._job()
        for _ in range(scan_queue.MAX_RECOGNITION_ATTEMPTS):
            claim = claim_next_scan_item(self.db, now=datetime.datetime.utcnow() + datetime.timedelta(days=1))
            self.assertTrue(fail_claim(self.db, claim, "boom"))
        self.assertEqual([r.subject_key for r in self._queued()], [f"job:{job.id}"])

    def test_transient_failure_does_not_queue_until_the_job_finishes(self):
        self._job()
        claim = claim_next_scan_item(self.db)
        fail_claim(self.db, claim, "rate limited", transient=True)
        self.assertEqual(self._queued(), [])

    def test_composite_group_completed_queues_one_push(self):
        job = self._job(photos=3, batch_mode=True)
        claim = claim_next_scan_item(self.db)
        self.assertTrue(claim.composite)
        results = [{"recognized": {}, "matches": []}] * len(claim.all_item_ids)
        self.assertTrue(complete_claim_group(self.db, claim, results))
        self.assertEqual([r.subject_key for r in self._queued()], [f"job:{job.id}"])

    def test_composite_group_failure_queues_one_push(self):
        job = self._job(photos=2, batch_mode=True)
        claim = claim_next_scan_item(self.db)
        self.assertTrue(fail_claim(self.db, claim, "bad", permanent=True))
        self.assertEqual([r.subject_key for r in self._queued()], [f"job:{job.id}"])

    def test_job_with_several_photos_queues_once_after_the_last_one(self):
        job = self._job(photos=2)
        first = claim_next_scan_item(self.db)
        complete_claim(self.db, first, {"recognized": {}, "matches": []})
        self.assertEqual(self._queued(), [])
        second = claim_next_scan_item(self.db)
        complete_claim(self.db, second, {"recognized": {}, "matches": []})
        self.assertEqual([r.subject_key for r in self._queued()], [f"job:{job.id}"])

    def test_retried_job_does_not_queue_a_second_push(self):
        job = self._job()
        claim = claim_next_scan_item(self.db)
        complete_claim(self.db, claim, {"recognized": {}, "matches": []})
        item = self.db.query(ScanJobItem).filter_by(job_id=job.id).one()
        with patch.object(scan_queue, "resolve_scan_path") as path:
            path.return_value.is_file.return_value = True
            scan_queue.retry_scan_item(self.db, item)
        claim = claim_next_scan_item(self.db)
        complete_claim(self.db, claim, {"recognized": {}, "matches": []})
        self.assertEqual(len(self._queued()), 1)


if __name__ == "__main__":
    unittest.main()
