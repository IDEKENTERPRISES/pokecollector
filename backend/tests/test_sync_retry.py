import datetime
import unittest
from unittest.mock import patch

try:
    import httpx
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.sync import get_sync_status
    from database import Base
    from models import Card, Set, SyncLog, User
    from services import sync_progress
    from services.card_metadata import enrich_cards_metadata
    from services.sync_retry import RetryQueue, TransientSyncError, is_transient_error, retry_after_seconds
    from services.sync_service import (
        _retry_card_metadata,
        _sync_set_card_catalogue,
        perform_price_sync,
    )

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


def _status_error(status, headers=None):
    request = httpx.Request("GET", "https://api.tcgdex.net/v2/en/cards/B2-190")
    response = httpx.Response(status, headers=headers or {}, request=request)
    return httpx.HTTPStatusError(f"{status}", request=request, response=response)


@unittest.skipUnless(DEPS, "Backend dependencies are not installed in this lightweight test environment")
class ClassifyTests(unittest.TestCase):
    def test_server_errors_rate_limits_timeouts_and_connection_errors_are_transient(self):
        for exc in (
            _status_error(503),
            _status_error(500),
            _status_error(429),
            httpx.ReadTimeout("slow"),
            httpx.ConnectError("refused"),
            TransientSyncError("again"),
        ):
            self.assertTrue(is_transient_error(exc), repr(exc))

    def test_client_errors_and_bugs_are_permanent(self):
        for exc in (_status_error(404), _status_error(400), _status_error(403), ValueError("bad"), RuntimeError("x")):
            self.assertFalse(is_transient_error(exc), repr(exc))

    def test_retry_after_is_read_and_capped(self):
        self.assertEqual(retry_after_seconds(_status_error(429, {"Retry-After": "7"})), 7.0)
        self.assertEqual(retry_after_seconds(_status_error(503, {"Retry-After": "9999"})), 60.0)
        self.assertEqual(retry_after_seconds(_status_error(503, {"Retry-After": "Wed, 21 Oct"})), 0.0)
        self.assertEqual(retry_after_seconds(_status_error(503)), 0.0)
        self.assertEqual(retry_after_seconds(RuntimeError("x")), 0.0)


@unittest.skipUnless(DEPS, "Backend dependencies are not installed in this lightweight test environment")
class RetryQueueTests(unittest.TestCase):
    def test_recovers_after_backoff_and_counts(self):
        calls = {"a": 0, "b": 0}

        def flaky(key, fail_times):
            def attempt():
                calls[key] += 1
                if calls[key] <= fail_times:
                    raise _status_error(503)
            return attempt

        queue = RetryQueue()
        queue.add("card", "a", flaky("a", 0))
        queue.add("card", "b", flaky("b", 1))
        sleeps = []
        stats = queue.run(sleep=sleeps.append)

        self.assertEqual(stats, {"retried": 2, "recovered": 2, "still_failing": 0, "permanent": 0})
        self.assertEqual(sleeps, [2.0, 4.0])  # exponential backoff, one pause per round
        self.assertEqual(calls, {"a": 1, "b": 2})

    def test_rounds_are_capped_and_leftovers_reported(self):
        queue = RetryQueue()
        attempts = []

        def always():
            attempts.append(1)
            raise httpx.ReadTimeout("down")

        queue.add("card", "x", always)
        sleeps = []
        stats = queue.run(rounds=3, sleep=sleeps.append)

        self.assertEqual(len(attempts), 3)
        self.assertEqual(stats["still_failing"], 1)
        self.assertEqual(stats["recovered"], 0)
        self.assertEqual(len(sleeps), 3)

    def test_permanent_failure_in_retry_is_dropped(self):
        queue = RetryQueue()
        queue.add("card", "x", lambda: (_ for _ in ()).throw(_status_error(404)))
        stats = queue.run(sleep=lambda _s: None)

        self.assertEqual(stats, {"retried": 1, "recovered": 0, "still_failing": 0, "permanent": 1})

    def test_retry_after_longer_than_backoff_is_honoured(self):
        queue = RetryQueue()
        err = _status_error(429, {"Retry-After": "20"})
        queue.add("card", "x", lambda: None, err)
        sleeps = []
        queue.run(sleep=sleeps.append)

        self.assertEqual(sleeps, [20.0])

    def test_circuit_breaker_stops_after_consecutive_transient_failures(self):
        queue = RetryQueue()
        attempts = []

        def down():
            attempts.append(1)
            raise httpx.ReadTimeout("down")

        for n in range(20):
            queue.add("card", str(n), down)
        sleeps = []
        stats = queue.run(sleep=sleeps.append)

        self.assertEqual(len(attempts), 5)  # not 20 x 3 rounds
        self.assertEqual(stats["still_failing"], 20)
        self.assertEqual(stats["recovered"], 0)
        self.assertEqual(len(sleeps), 1)  # no further rounds after the stop

    def test_a_success_resets_the_failure_streak(self):
        queue = RetryQueue()
        outcomes = iter([True, True, True, True, False, True, True, True, True, False])

        def attempt():
            if next(outcomes):
                raise httpx.ReadTimeout("down")

        for n in range(10):
            queue.add("card", str(n), attempt)
        stats = queue.run(rounds=1, sleep=lambda _s: None)

        self.assertEqual(stats["recovered"], 2)  # four failures, a success, four more, a success

    def test_time_budget_stops_between_attempts(self):
        now = [0.0]
        queue = RetryQueue()
        attempts = []

        def slow():
            attempts.append(1)
            now[0] += 100.0  # each attempt takes 100 s on the fake clock
            raise httpx.ReadTimeout("slow")

        for n in range(10):
            queue.add("card", str(n), slow)
        stats = queue.run(sleep=lambda _s: None, clock=lambda: now[0], budget_seconds=250, max_consecutive_failures=99)

        self.assertEqual(len(attempts), 3)  # 0, 100, 200 s; the next check sees 300 s
        self.assertEqual(stats["still_failing"], 10)

    def test_time_budget_counts_the_backoff_sleep(self):
        now = [0.0]
        queue = RetryQueue()
        queue.add("card", "x", lambda: None)
        sleeps = []
        stats = queue.run(sleep=sleeps.append, clock=lambda: now[0], budget_seconds=1)

        self.assertEqual(sleeps, [])  # the 2 s pause alone would break the 1 s budget
        self.assertEqual(stats["still_failing"], 1)

    def test_empty_queue_does_not_sleep(self):
        sleeps = []
        stats = RetryQueue().run(sleep=sleeps.append)

        self.assertEqual(sleeps, [])
        self.assertEqual(stats["retried"], 0)


@unittest.skipUnless(DEPS, "Backend dependencies are not installed in this lightweight test environment")
class MetadataTransientTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.card = Card(id="B2-190_en", tcg_card_id="B2-190", name="X", lang="en", is_custom=False)
        self.db.add(self.card)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_503_gives_the_claim_back_so_the_next_sync_retries(self):
        with patch("services.card_metadata.pokemon_api.get_card", side_effect=_status_error(503)):
            result = enrich_cards_metadata(self.db, [self.card], limit=1)

        self.db.refresh(self.card)
        self.assertEqual(result["failed"], 1)
        self.assertEqual([cid for cid, _ in result["transient"]], ["B2-190_en"])
        self.assertIsNone(self.card.last_metadata_enrichment_attempt_at)

        # The very next attempt is not locked out by the seven-day cooldown.
        with patch("services.card_metadata.pokemon_api.get_card", return_value=None) as get_card:
            again = enrich_cards_metadata(self.db, [self.card], limit=1)
        self.assertEqual(again["attempted"], 1)
        get_card.assert_called_once()

    def test_give_back_never_overwrites_a_concurrent_claim(self):
        concurrent = datetime.datetime(2030, 1, 1)

        def fail_after_another_worker_claims(*_args, **_kwargs):
            # Another worker re-claims the card while our request is in flight.
            other = sessionmaker(bind=self.db.get_bind())()
            other.query(Card).filter(Card.id == "B2-190_en").update({Card.last_metadata_enrichment_attempt_at: concurrent})
            other.commit()
            other.close()
            raise _status_error(503)

        with patch("services.card_metadata.pokemon_api.get_card", side_effect=fail_after_another_worker_claims):
            result = enrich_cards_metadata(self.db, [self.card], limit=1)

        self.db.refresh(self.card)
        self.assertEqual(len(result["transient"]), 1)
        self.assertEqual(self.card.last_metadata_enrichment_attempt_at, concurrent)

    def test_permanent_failure_keeps_the_cooldown(self):
        with patch("services.card_metadata.pokemon_api.get_card", side_effect=_status_error(400)):
            result = enrich_cards_metadata(self.db, [self.card], limit=1)

        self.db.refresh(self.card)
        self.assertEqual(result["transient"], [])
        self.assertIsNotNone(self.card.last_metadata_enrichment_attempt_at)

    def test_a_restored_claim_keeps_the_previous_attempt_time(self):
        previous = datetime.datetime(2020, 1, 1)
        self.card.last_metadata_enrichment_attempt_at = previous
        self.db.commit()

        with patch("services.card_metadata.pokemon_api.get_card", side_effect=httpx.ConnectError("x")):
            enrich_cards_metadata(self.db, [self.card], limit=1, ignore_cooldown=True, force=True)

        self.db.refresh(self.card)
        self.assertEqual(self.card.last_metadata_enrichment_attempt_at, previous)

    def test_retry_helper_recovers_and_raises_when_still_failing(self):
        with patch("services.card_metadata.pokemon_api.get_card", side_effect=_status_error(503)):
            with self.assertRaises(TransientSyncError):
                _retry_card_metadata(self.db, "B2-190_en", [])

        with patch("services.card_metadata.pokemon_api.get_card", return_value=None):
            _retry_card_metadata(self.db, "B2-190_en", [])  # no error: the lookup went through

    def test_progress_callback_reports_each_card(self):
        seen = []
        with patch("services.card_metadata.pokemon_api.get_card", return_value=None):
            enrich_cards_metadata(self.db, [self.card], limit=1, on_progress=lambda d, t: seen.append((d, t)))

        self.assertEqual(seen, [(0, 1), (1, 1)])


@unittest.skipUnless(DEPS, "Backend dependencies are not installed in this lightweight test environment")
class SyncRetryIntegrationTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine, autoflush=False)()
        sync_progress.finish()

    def tearDown(self):
        sync_progress.finish()
        self.db.close()

    def _plan(self, ids):
        return {
            "ids": ids, "deferred": 0, "deferred_ids": [], "sync_limit": 10, "total_syncable": len(ids),
            "selected_missing": 0, "eligible_missing": 0, "selected_priced": len(ids), "priced": len(ids),
            "cooldown_missing": 0,
        }

    def test_price_sync_retries_transient_failures_at_the_end(self):
        self.db.add_all([Card(id=f"sv1-{n}_en", tcg_card_id=f"sv1-{n}", name="X", lang="en") for n in (1, 2)])
        self.db.commit()
        fetches = []

        def get_card(card_id, lang="en"):
            fetches.append(card_id)
            if card_id == "sv1-2" and fetches.count("sv1-2") == 1:
                raise _status_error(503)
            return {"id": card_id, "name": "X", "localId": card_id.split("-")[1]}

        with patch("services.sync_service._price_sync_plan", return_value=self._plan(["sv1-1_en", "sv1-2_en"])), \
             patch("services.sync_service.pokemon_api.get_card", side_effect=get_card), \
             patch("services.sync_retry.time.sleep") as sleep, \
             patch("services.sync_service.check_wishlist_alerts"), \
             patch("services.sync_service.take_portfolio_snapshot"):
            result = perform_price_sync(self.db)

        self.assertEqual(result["cards_updated"], 2)
        self.assertEqual(result["retry"], {"retried": 1, "recovered": 1, "still_failing": 0, "permanent": 0})
        sleep.assert_called_once_with(2.0)
        self.assertEqual(fetches, ["sv1-1", "sv1-2", "sv1-2"])
        log = self.db.query(SyncLog).one()
        self.assertEqual(log.status, "success")
        self.assertIn('"recovered": 1', log.retry_summary)
        self.assertIsNone(sync_progress.snapshot())  # tracking ends with the sync

    def test_price_sync_reports_what_still_fails(self):
        self.db.add(Card(id="sv1-3_en", tcg_card_id="sv1-3", name="X", lang="en"))
        self.db.commit()

        with patch("services.sync_service._price_sync_plan", return_value=self._plan(["sv1-3_en"])), \
             patch("services.sync_service.pokemon_api.get_card", side_effect=_status_error(503)), \
             patch("services.sync_retry.time.sleep"), \
             patch("services.sync_service.check_wishlist_alerts"), \
             patch("services.sync_service.take_portfolio_snapshot"):
            result = perform_price_sync(self.db)

        self.assertEqual(result["retry"], {"retried": 1, "recovered": 0, "still_failing": 1, "permanent": 0})
        self.assertEqual(result["status"], "success")

    def test_permanent_price_failure_is_not_retried(self):
        self.db.add(Card(id="sv1-4_en", tcg_card_id="sv1-4", name="X", lang="en"))
        self.db.commit()

        with patch("services.sync_service._price_sync_plan", return_value=self._plan(["sv1-4_en"])), \
             patch("services.sync_service.pokemon_api.get_card", side_effect=_status_error(400)) as get_card, \
             patch("services.sync_retry.time.sleep") as sleep, \
             patch("services.sync_service.check_wishlist_alerts"), \
             patch("services.sync_service.take_portfolio_snapshot"):
            result = perform_price_sync(self.db)

        get_card.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(result["retry"]["retried"], 0)
        self.assertIsNone(self.db.query(SyncLog).one().retry_summary)

    def test_set_card_list_failure_is_retried_through_the_queue(self):
        card_set = Set(id="sv1_en", tcg_set_id="sv1", name="SV", lang="en", total=1)
        self.db.add(card_set)
        self.db.commit()
        lists = []

        def get_set_cards(tcg_id, lang="en"):
            lists.append(tcg_id)
            if len(lists) == 1:
                raise _status_error(503)
            return {"cards": [{"id": "sv1-1", "localId": "1", "name": "X"}]}

        queue = RetryQueue()
        with patch("services.sync_service.pokemon_api.get_set_cards", side_effect=get_set_cards), \
             patch("services.sync_service.build_missing_language_cards_for_set", return_value=[]):
            _sync_set_card_catalogue(self.db, [card_set], card_list_cache={}, retry_queue=queue)
            self.assertEqual(queue.queued, 1)
            stats = queue.run(sleep=lambda _s: None)

        self.assertEqual(stats["recovered"], 1)
        self.assertIsNotNone(self.db.query(Card).filter(Card.id == "sv1-1_en").first())


@unittest.skipUnless(DEPS, "Backend dependencies are not installed in this lightweight test environment")
class ProgressTests(unittest.TestCase):
    def setUp(self):
        sync_progress.finish()
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="ash", hashed_password="x", role="admin", is_active=True)
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        sync_progress.finish()
        self.db.close()

    def test_tracker_copies_state_and_ignores_updates_when_idle(self):
        sync_progress.update("cards", 1, 2)
        self.assertIsNone(sync_progress.snapshot())

        sync_progress.start("full")
        sync_progress.update("cards", 3, 10)
        sync_progress.advance(4)
        snapshot = sync_progress.snapshot()
        snapshot["done"] = 99  # a copy: callers cannot change the live state

        self.assertEqual(sync_progress.snapshot(), {"kind": "full", "stage": "cards", "done": 4, "total": 10})

    def test_status_returns_progress_only_while_a_sync_runs(self):
        idle = get_sync_status(db=self.db, current_user=self.user)
        self.assertIsNone(idle["progress"])
        self.assertIn("is_running", idle)  # existing fields stay

        sync_progress.start("price")
        sync_progress.update("retrying", 1, 4)
        running = get_sync_status(db=self.db, current_user=self.user)

        self.assertEqual(running["progress"], {"kind": "price", "stage": "retrying", "done": 1, "total": 4})

    def test_status_history_carries_the_retry_counts(self):
        self.db.add(SyncLog(
            status="success", sync_type="full",
            retry_summary='{"retried": 3, "recovered": 2, "still_failing": 1, "permanent": 0}',
        ))
        self.db.commit()

        status = get_sync_status(db=self.db, current_user=self.user)

        self.assertEqual(status["history"][0]["retry"]["still_failing"], 1)
        self.assertEqual(status["last_sync"]["retry"]["recovered"], 2)


if __name__ == "__main__":
    unittest.main()
