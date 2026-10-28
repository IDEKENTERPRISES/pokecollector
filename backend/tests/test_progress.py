import datetime
import unittest
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from api.auth import get_current_user
    from api.backup import BACKUP_GROUPS
    from database import Base, get_db
    from models import (
        Binder,
        BinderCard,
        BinderSlot,
        Card,
        CollectionItem,
        ProgressState,
        Set,
        User,
        UserAchievement,
        UserDailyActivity,
        UserEvent,
        UserSetting,
        UserXpLedger,
    )
    from services.binder_slots import delete_slots_for_entries
    from services.progress import listeners
    from services.progress.checkin import CheckinError, record_checkin
    from services.progress.evaluator import evaluate_user, evaluate_users, record_event
    from services.progress.state import mark_all_users_dirty, mark_users_dirty

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _make_session_factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


def _card(card_id, set_id="tst", price=1.0, lang="en", **extra):
    return Card(
        id=f"{card_id}_{lang}", tcg_card_id=card_id, name=card_id.title(), set_id=set_id,
        number=card_id[-3:], lang=lang, is_custom=False, price_trend=price, price_market=price, **extra,
    )


class ProgressTestBase(unittest.TestCase):
    def setUp(self):
        self.engine, self.Session = _make_session_factory()
        self.db = self.Session()
        self.user = User(username="ash", hashed_password="x", role="admin", is_active=True)
        self.other = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([
            self.user,
            self.other,
            Set(id="tst_en", tcg_set_id="tst", name="Test Set", lang="en", total=2),
            _card("tst-001", price=5.0),
            _card("tst-002", price=5.0),
            _card("big-001", set_id="big", price=30.0),
            _card("big-002", set_id="big", price=1.0),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def own(self, card_id, user=None, **extra):
        user = user or self.user
        item = CollectionItem(card_id=f"{card_id}_en", user_id=user.id, quantity=1, variant="Normal", lang="en", **extra)
        self.db.add(item)
        self.db.commit()
        return item

    def events(self, kind=None, user=None):
        user = user or self.user
        query = self.db.query(UserEvent).filter(UserEvent.user_id == user.id)
        if kind:
            query = query.filter(UserEvent.kind == kind)
        return query.all()

    def achievement_ids(self, user=None):
        user = user or self.user
        return {row.achievement_id for row in self.db.query(UserAchievement).filter_by(user_id=user.id)}


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class EvaluatorTests(ProgressTestBase):
    def test_first_evaluation_backfills_silently(self):
        self.own("tst-001")
        self.own("tst-002")  # completes tst_en

        self.assertTrue(evaluate_user(self.db, self.user.id))

        rows = {row.achievement_id: row for row in self.db.query(UserAchievement).filter_by(user_id=self.user.id)}
        self.assertIn("first_card", rows)
        self.assertIn("first_set", rows)
        self.assertTrue(all(row.backfilled and row.seen_at is not None for row in rows.values()))
        self.assertEqual(self.events(), [])
        state = self.db.get(ProgressState, self.user.id)
        self.assertEqual(state.completed_sets, ["tst_en"])
        self.assertGreater(state.last_seen_collection_id, 0)
        self.assertIsNotNone(state.evaluated_at)
        self.assertIsNone(state.dirty_at)

    def test_state_row_created_by_dirty_marking_still_counts_as_first_evaluation(self):
        self.own("tst-001")
        mark_users_dirty(self.db, [self.user.id])
        evaluate_user(self.db, self.user.id)
        self.assertEqual(self.events(), [])
        self.assertTrue(self.db.query(UserAchievement).filter_by(user_id=self.user.id, backfilled=True).count())

    def test_completing_a_set_gives_exactly_one_event(self):
        self.own("tst-001")
        evaluate_user(self.db, self.user.id)
        self.assertEqual(self.events("set_completed"), [])

        self.own("tst-002")
        evaluate_user(self.db, self.user.id)
        evaluate_user(self.db, self.user.id)

        completed = self.events("set_completed")
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0].subject_key, "tst_en")
        self.assertEqual(completed[0].payload["set_name"], "Test Set")
        self.assertEqual(completed[0].payload["total"], 2)
        unlocked = {event.subject_key for event in self.events("achievement_unlocked")}
        self.assertIn("first_set", unlocked)

    def test_price_change_unlocks_a_value_badge_once(self):
        self.own("big-002")
        evaluate_user(self.db, self.user.id)
        self.assertNotIn("big_spender_100", self.achievement_ids())

        card = self.db.get(Card, "big-002_en")
        card.price_trend = card.price_market = 150.0
        self.db.commit()
        evaluate_user(self.db, self.user.id)
        evaluate_user(self.db, self.user.id)

        unlocked = [e for e in self.events("achievement_unlocked") if e.subject_key == "big_spender_100"]
        self.assertEqual(len(unlocked), 1)
        row = self.db.query(UserAchievement).filter_by(user_id=self.user.id, achievement_id="big_spender_100").one()
        self.assertFalse(row.backfilled)
        self.assertIsNone(row.seen_at)

    def test_record_event_is_idempotent_by_dedupe_key(self):
        self.assertTrue(record_event(self.db, self.user.id, "big_pull", "k1"))
        self.assertFalse(record_event(self.db, self.user.id, "big_pull", "k1"))
        self.assertTrue(record_event(self.db, self.other.id, "big_pull", "k1"))
        self.db.commit()
        self.assertEqual(len(self.events()), 1)

    def test_big_pull_events(self):
        self.own("tst-001")
        evaluate_user(self.db, self.user.id)  # sets the high-water mark only

        pulled = self.own("big-001")
        cheap = self.own("big-002")
        old = self.own("tst-002", added_at=datetime.datetime.utcnow() - datetime.timedelta(days=10))
        evaluate_user(self.db, self.user.id)
        evaluate_user(self.db, self.user.id)

        events = self.events("big_pull")
        self.assertEqual([e.subject_key for e in events], [str(pulled.id)])
        self.assertEqual(events[0].payload["card_id"], "big-001_en")
        self.assertNotIn(str(cheap.id), [e.subject_key for e in events])
        self.assertNotIn(str(old.id), [e.subject_key for e in events])
        self.assertEqual(self.db.get(ProgressState, self.user.id).last_seen_collection_id, old.id)

    def test_first_evaluation_does_not_emit_big_pulls(self):
        self.own("big-001")
        evaluate_user(self.db, self.user.id)
        self.assertEqual(self.events("big_pull"), [])

    def test_one_users_failure_does_not_block_others(self):
        self.own("tst-001")
        self.own("tst-001", user=self.other)
        real = evaluate_user

        def flaky(db, user_id):
            if user_id == self.user.id:
                raise RuntimeError("boom")
            return real(db, user_id)

        with patch("services.progress.evaluator.evaluate_user", side_effect=flaky):
            done = evaluate_users(self.db, [self.user.id, self.other.id])
        self.assertEqual(done, 1)
        self.assertIsNotNone(self.db.get(ProgressState, self.other.id))

    def test_dirty_flag_set_during_evaluation_is_kept(self):
        self.own("tst-001")
        mark_users_dirty(self.db, [self.user.id], now=datetime.datetime.utcnow() + datetime.timedelta(minutes=5))
        evaluate_user(self.db, self.user.id)
        self.assertIsNotNone(self.db.get(ProgressState, self.user.id).dirty_at)

    def test_unpriced_new_card_is_evaluated_without_error(self):
        self.db.add(Card(id="free-001_en", tcg_card_id="free-001", name="Free", set_id="free",
                         number="001", lang="en", is_custom=False))
        self.db.commit()
        self.own("tst-001")
        evaluate_user(self.db, self.user.id)

        unpriced = self.own("free-001")
        with patch("services.progress.evaluator.effective_market_price", return_value=None):
            self.assertTrue(evaluate_user(self.db, self.user.id))
        self.assertEqual(self.events("big_pull"), [])
        state = self.db.get(ProgressState, self.user.id)
        self.assertEqual(state.last_seen_collection_id, unpriced.id)
        self.assertIsNone(state.dirty_at)

    def test_dirty_mark_committed_mid_evaluation_survives(self):
        import services.progress.evaluator as evaluator

        self.own("tst-001")
        mark_users_dirty(self.db, [self.user.id])
        real = evaluator._evaluate_sets

        def evaluate_and_get_marked(db, user_id, state, first, now):
            real(db, user_id, state, first, now)
            with self.Session() as other_session:
                mark_users_dirty(other_session, [user_id], now=now + datetime.timedelta(seconds=1))

        with patch.object(evaluator, "_evaluate_sets", side_effect=evaluate_and_get_marked):
            evaluate_user(self.db, self.user.id)
        self.db.expire_all()
        self.assertIsNotNone(self.db.get(ProgressState, self.user.id).dirty_at)

    def test_failing_user_goes_to_the_back_of_the_queue(self):
        from services.progress.evaluator import evaluate_dirty_users

        old = datetime.datetime.utcnow() - datetime.timedelta(hours=1)
        mark_users_dirty(self.db, [self.user.id], now=old)
        mark_users_dirty(self.db, [self.other.id], now=old + datetime.timedelta(minutes=5))
        real = evaluate_user

        def flaky(db, user_id):
            if user_id == self.user.id:
                raise RuntimeError("boom")
            return real(db, user_id)

        with patch("services.progress.evaluator.evaluate_user", side_effect=flaky):
            self.assertEqual(evaluate_dirty_users(self.db, limit=5), 1)

        self.db.expire_all()
        failed = self.db.get(ProgressState, self.user.id)
        self.assertGreater(failed.dirty_at, old + datetime.timedelta(minutes=30))
        self.assertIsNone(self.db.get(ProgressState, self.other.id).dirty_at)

    def test_mark_all_users_dirty_covers_active_users_only(self):
        self.other.is_active = False
        self.db.commit()
        self.assertEqual(mark_all_users_dirty(self.db), 1)
        self.assertIsNotNone(self.db.get(ProgressState, self.user.id).dirty_at)
        self.assertIsNone(self.db.get(ProgressState, self.other.id))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ListenerTests(ProgressTestBase):
    def setUp(self):
        super().setUp()
        listeners.register_progress_listeners()
        self.addCleanup(listeners.unregister_progress_listeners)

    def dirty_at(self, user):
        with self.Session() as check:
            row = check.get(ProgressState, user.id)
            return row.dirty_at if row else None

    def test_commit_marks_the_owner_dirty(self):
        self.own("tst-001")
        self.assertIsNotNone(self.dirty_at(self.user))
        self.assertIsNone(self.dirty_at(self.other))

    def test_rollback_marks_nothing(self):
        self.db.add(CollectionItem(card_id="tst-001_en", user_id=self.user.id, quantity=1, variant="Normal"))
        self.db.flush()
        self.db.rollback()
        self.db.commit()
        self.assertIsNone(self.dirty_at(self.user))

    def test_rollback_does_not_leak_into_a_later_commit(self):
        self.db.add(CollectionItem(card_id="tst-001_en", user_id=self.user.id, quantity=1, variant="Normal"))
        self.db.flush()
        self.db.rollback()
        self.db.add(CollectionItem(card_id="tst-001_en", user_id=self.other.id, quantity=1, variant="Normal"))
        self.db.commit()
        self.assertIsNone(self.dirty_at(self.user))
        self.assertIsNotNone(self.dirty_at(self.other))

    def test_binder_card_marks_the_binders_owner(self):
        binder = Binder(name="B", user_id=self.other.id)
        self.db.add(binder)
        self.db.commit()
        with self.Session() as clear:
            clear.query(ProgressState).delete()
            clear.commit()
        self.db.add(BinderCard(binder_id=binder.id, card_id="tst-001_en"))
        self.db.commit()
        self.assertIsNotNone(self.dirty_at(self.other))
        self.assertIsNone(self.dirty_at(self.user))

    def test_deletes_mark_dirty_and_progress_writes_do_not_loop(self):
        item = self.own("tst-001")
        evaluate_user(self.db, self.user.id)
        self.assertIsNone(self.dirty_at(self.user))
        self.db.delete(item)
        self.db.commit()
        self.assertIsNotNone(self.dirty_at(self.user))

    def test_registration_is_idempotent(self):
        listeners.register_progress_listeners()
        listeners.register_progress_listeners()
        self.own("tst-001")
        self.assertIsNotNone(self.dirty_at(self.user))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class CheckinTests(ProgressTestBase):
    NOW = datetime.datetime(2026, 10, 28, 12, 0, 0)

    def checkin(self, tz="Europe/London", dates=("2026-10-28",)):
        return record_checkin(self.db, self.user.id, tz, list(dates), now=self.NOW)

    def test_stores_time_zone_and_dates_idempotently(self):
        result = self.checkin(dates=("2026-10-26", "2026-10-28"))
        self.assertEqual(result, {"local_date": "2026-10-28", "days_recorded": 2})
        again = self.checkin(dates=("2026-10-26", "2026-10-28"))
        self.assertEqual(again["days_recorded"], 2)

        setting = self.db.query(UserSetting).filter_by(user_id=self.user.id, key="time_zone").one()
        self.assertEqual(setting.value, "Europe/London")
        rows = {r.local_date.isoformat(): r for r in self.db.query(UserDailyActivity).filter_by(user_id=self.user.id)}
        self.assertTrue(rows["2026-10-26"].offline)
        self.assertEqual(rows["2026-10-26"].opens, 1)
        self.assertFalse(rows["2026-10-28"].offline)
        self.assertEqual(rows["2026-10-28"].opens, 2)

    def test_time_zone_changes_the_local_date(self):
        result = self.checkin(tz="Pacific/Auckland", dates=("2026-10-29",))
        self.assertEqual(result["local_date"], "2026-10-29")
        self.assertEqual(self.db.query(UserSetting).filter_by(key="time_zone").one().value, "Pacific/Auckland")

    def test_rejects_bad_time_zones(self):
        for bad in ("Mars/Olympus", "", None, "../etc/passwd", "x" * 100):
            with self.subTest(bad=bad):
                with self.assertRaises(CheckinError):
                    self.checkin(tz=bad)
        self.assertEqual(self.db.query(UserSetting).count(), 0)

    def test_rejects_dates_out_of_range(self):
        cases = {
            "future": ["2026-10-30"],
            "too old": ["2026-10-13"],
            "garbage": ["not-a-date"],
            "empty": [],
            "too many": [(datetime.date(2026, 10, 14) + datetime.timedelta(days=i % 14)).isoformat() for i in range(15)],
        }
        for name, dates in cases.items():
            with self.subTest(name):
                with self.assertRaises(CheckinError):
                    self.checkin(dates=dates)
        self.assertEqual(self.db.query(UserDailyActivity).count(), 0)

    def test_boundaries_are_accepted(self):
        self.assertEqual(self.checkin(dates=("2026-10-14", "2026-10-29"))["days_recorded"], 2)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ProgressApiTests(ProgressTestBase):
    def setUp(self):
        super().setUp()
        self.current = self.user

        def override_db():
            session = self.Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_db
        main.app.dependency_overrides[get_current_user] = lambda: self.current
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    def test_checkin_endpoint(self):
        today = datetime.datetime.utcnow().date().isoformat()
        response = self.client.post("/api/progress/checkin", json={"time_zone": "UTC", "dates": [today]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"local_date": today, "days_recorded": 1})

    def test_checkin_endpoint_rejects_bad_input(self):
        bad_zone = self.client.post("/api/progress/checkin", json={"time_zone": "Nope/Nowhere", "dates": ["2026-10-28"]})
        self.assertEqual(bad_zone.status_code, 400)
        far = (datetime.datetime.utcnow() + datetime.timedelta(days=5)).date().isoformat()
        future = self.client.post("/api/progress/checkin", json={"time_zone": "UTC", "dates": [far]})
        self.assertEqual(future.status_code, 400)

    def test_events_endpoint_returns_only_own_events_newest_first(self):
        now = datetime.datetime.utcnow()
        self.db.add_all([
            UserEvent(user_id=self.user.id, kind="big_pull", occurred_at=now - datetime.timedelta(hours=1),
                      dedupe_key="a", payload={"n": 1}),
            UserEvent(user_id=self.user.id, kind="set_completed", occurred_at=now, dedupe_key="b", payload={}),
            UserEvent(user_id=self.other.id, kind="big_pull", occurred_at=now, dedupe_key="a", payload={}),
        ])
        self.db.commit()
        response = self.client.get("/api/progress/events?limit=10")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([e["kind"] for e in response.json()], ["set_completed", "big_pull"])
        self.assertEqual(len(self.client.get("/api/progress/events?limit=1").json()), 1)
        self.assertEqual(self.client.get("/api/progress/events?limit=0").status_code, 422)

    def test_foil_pattern_round_trip_and_validation(self):
        item = self.own("tst-001")
        listing = self.client.get("/api/collection/")
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertIsNone(listing.json()[0]["foil_pattern"])

        response = self.client.put(f"/api/collection/{item.id}", json={"foil_pattern": "cracked-ice"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["foil_pattern"], "cracked-ice")
        self.assertEqual(self.client.get("/api/collection/").json()[0]["foil_pattern"], "cracked-ice")

        invalid = self.client.put(f"/api/collection/{item.id}", json={"foil_pattern": "sparkles"})
        self.assertEqual(invalid.status_code, 422)

        untouched = self.client.put(f"/api/collection/{item.id}", json={"condition": "LP"})
        self.assertEqual(untouched.json()["foil_pattern"], "cracked-ice")

        cleared = self.client.put(f"/api/collection/{item.id}", json={"foil_pattern": None})
        self.assertEqual(cleared.status_code, 200)
        self.assertIsNone(cleared.json()["foil_pattern"])

    def test_every_foil_pattern_id_is_accepted(self):
        from services.foil_patterns import FOIL_PATTERNS

        for expected in ("holo", "pokeball-reverse", "radiant", "amazing", "v-full-art", "vmax",
                         "vstar", "trainer-gallery", "shiny", "illustration-rare",
                         "special-illustration"):
            self.assertIn(expected, FOIL_PATTERNS)
        item = self.own("tst-001")
        for pattern in FOIL_PATTERNS:
            response = self.client.put(f"/api/collection/{item.id}", json={"foil_pattern": pattern})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["foil_pattern"], pattern)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class CascadeTests(ProgressTestBase):
    def _binder_with_slot(self, user):
        item = self.own("tst-001", user=user)
        binder = Binder(name="Book", user_id=user.id)
        self.db.add(binder)
        self.db.flush()
        entry = BinderCard(binder_id=binder.id, card_id="tst-001_en", collection_item_id=item.id)
        self.db.add(entry)
        self.db.flush()
        self.db.add(BinderSlot(binder_id=binder.id, slot_index=3, binder_card_id=entry.id, copy_index=0))
        self.db.commit()
        return binder, entry

    def _client(self, current):
        def override_db():
            session = self.Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_db
        main.app.dependency_overrides[get_current_user] = lambda: current
        self.addCleanup(main.app.dependency_overrides.clear)
        return TestClient(main.app)

    def test_binder_delete_removes_its_slots(self):
        binder, _ = self._binder_with_slot(self.user)
        client = self._client(self.user)
        response = client.delete(f"/api/binders/{binder.id}")
        self.assertEqual(response.status_code, 200, response.text)
        self.db.expire_all()
        self.assertEqual(self.db.query(BinderSlot).count(), 0)

    def test_bulk_helper_removes_slots_before_bulk_delete(self):
        binder, entry = self._binder_with_slot(self.user)
        other_binder, _ = self._binder_with_slot(self.other)
        query = self.db.query(BinderCard).filter(BinderCard.binder_id == binder.id)
        self.assertEqual(delete_slots_for_entries(self.db, query), 1)
        query.delete(synchronize_session=False)
        self.db.commit()
        remaining = self.db.query(BinderSlot).all()
        self.assertEqual([slot.binder_id for slot in remaining], [other_binder.id])

    def test_user_delete_removes_all_new_rows(self):
        victim = self.other
        victim_id = victim.id
        self._binder_with_slot(victim)
        now = datetime.datetime.utcnow()
        self.db.add_all([
            ProgressState(user_id=victim.id, completed_sets=[], dirty_at=now),
            UserEvent(user_id=victim.id, kind="big_pull", occurred_at=now, dedupe_key="x", payload={}),
            UserDailyActivity(user_id=victim.id, local_date=now.date()),
            UserAchievement(user_id=victim.id, achievement_id="first_card", unlocked_at=now),
            UserXpLedger(user_id=victim.id, source="quest", source_key="k", amount=10),
            UserEvent(user_id=self.user.id, kind="big_pull", occurred_at=now, dedupe_key="x", payload={}),
        ])
        self.db.commit()

        client = self._client(self.user)
        with patch("services.scan_trace.revoke_user_traces"):
            response = client.delete(f"/api/auth/users/{victim_id}")
        self.assertEqual(response.status_code, 200, response.text)

        self.db.expire_all()
        for model in (ProgressState, UserEvent, UserDailyActivity, UserAchievement, UserXpLedger):
            self.assertEqual(self.db.query(model).filter(model.user_id == victim_id).count(), 0, model.__name__)
        self.assertEqual(self.db.query(BinderSlot).count(), 0)
        self.assertEqual(self.db.query(UserEvent).filter_by(user_id=self.user.id).count(), 1)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class SchemaAndBackupTests(unittest.TestCase):
    def test_backup_groups_list_the_new_tables(self):
        for table in ("progress_state", "user_events", "user_daily_activity", "user_achievements"):
            self.assertIn(table, BACKUP_GROUPS["users"])
        self.assertIn("binder_slots", BACKUP_GROUPS["collection"])

    def test_new_columns_and_defaults(self):
        engine, Session = _make_session_factory()
        with Session() as db:
            user = User(username="a", hashed_password="x", role="admin", is_active=True)
            db.add(user)
            db.flush()
            binder = Binder(name="B", user_id=user.id)
            db.add(binder)
            db.commit()
            self.assertEqual(binder.pocket_layout, 9)

    def test_migration_lines_exist(self):
        import inspect

        import database

        source = inspect.getsource(database._run_migrations)
        self.assertIn("ALTER TABLE collection ADD COLUMN IF NOT EXISTS foil_pattern", source)
        self.assertIn("ALTER TABLE binders ADD COLUMN IF NOT EXISTS pocket_layout", source)


class FoilPatternIdTests(unittest.TestCase):
    def test_ids_cover_the_viewer_styles_and_normalize(self):
        from services.foil_patterns import FOIL_PATTERNS, normalize_foil_pattern

        for expected in ("holo", "reverse", "cracked-ice", "cosmos", "etched", "rainbow", "gold",
                         "pokeball-reverse", "radiant", "amazing", "v-full-art", "vmax", "vstar",
                         "trainer-gallery", "shiny", "illustration-rare", "special-illustration"):
            self.assertIn(expected, FOIL_PATTERNS)
            self.assertEqual(normalize_foil_pattern(f" {expected.upper()} "), expected)
        self.assertIsNone(normalize_foil_pattern(None))
        self.assertIsNone(normalize_foil_pattern("  "))
        with self.assertRaises(ValueError):
            normalize_foil_pattern("sparkles")


if __name__ == "__main__":
    unittest.main()
