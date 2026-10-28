import datetime
import inspect
import json
import unittest
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import database
    from api import settings as settings_api
    from database import Base
    from models import (
        Card, CollectionItem, NotificationQueue, PushSubscription, ScanJob, ScanJobItem, Set, User, UserAchievement,
        UserSetting,
        WishlistItem,
    )
    from services import notifications as n
    from services import push as push_service
    from services import scan_queue

    DEPS_AVAILABLE = push_service.webpush is not None
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

# 2026-10-28: Europe/Berlin is UTC+1 and America/New_York is UTC-4.
NOON_UTC = datetime.datetime(2026, 10, 28, 12, 0)
SKIP_REASON = "FastAPI/SQLAlchemy/pywebpush are not installed in this lightweight test environment"


def _db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _user(db, name="ash", time_zone=None):
    user = User(username=name, hashed_password="x", role="trainer")
    db.add(user)
    db.flush()
    db.add(PushSubscription(
        user_id=user.id, endpoint="https://web.push.apple.com/" + name, p256dh="p", auth="a",
    ))
    if time_zone:
        db.add(UserSetting(user_id=user.id, key="time_zone", value=time_zone))
    db.commit()
    return user


def _card(db, card_id, price, avg7=None, avg30=None):
    card = Card(
        id=card_id, tcg_card_id=card_id, name=card_id.title(), set_id="tst", number="1", lang="en",
        is_custom=False, price_trend=price, price_market=price, price_avg7=avg7, price_avg30=avg30,
    )
    db.add(card)
    db.commit()
    return card


def _set_pref(db, user_id, key, value):
    db.add(UserSetting(user_id=user_id, key=key, value=value))
    db.commit()


class NotificationTestCase(unittest.TestCase):
    """Every push goes through a mocked pywebpush, as in test_push.py."""

    def setUp(self):
        self.db = _db()
        self.webpush = patch.object(push_service, "webpush").start()
        patch.object(push_service, "get_or_create_vapid_keys", return_value=(MagicMock(), "pub")).start()
        self.addCleanup(patch.stopall)
        self.addCleanup(self.db.close)

    def payloads(self):
        return [json.loads(call.kwargs["data"]) for call in self.webpush.call_args_list]

    def make_job(self, user, items=(("done", False),), status="running"):
        job = ScanJob(user_id=user.id, status=status, expires_at=NOON_UTC + datetime.timedelta(days=14))
        self.db.add(job)
        self.db.flush()
        for position, (item_status, resolved) in enumerate(items):
            self.db.add(ScanJobItem(
                job_id=job.id, user_id=user.id, position=position, byte_size=1,
                status=item_status, resolved=resolved,
            ))
        self.db.commit()
        return job


@unittest.skipUnless(DEPS_AVAILABLE, SKIP_REASON)
class PrefsTests(NotificationTestCase):
    def test_defaults_match_the_design(self):
        user = _user(self.db)
        self.assertTrue(n.category_enabled(self.db, user.id, "scans_ready"))
        self.assertTrue(n.category_enabled(self.db, user.id, "new_sets"))
        self.assertTrue(n.category_enabled(self.db, user.id, "wishlist_dips"))
        self.assertFalse(n.category_enabled(self.db, user.id, "big_movers"))
        self.assertFalse(n.category_enabled(self.db, user.id, "weekly_recap"))
        self.assertEqual(n.UI_CATEGORIES, ["scans_ready", "wishlist_alerts", "new_sets", "wishlist_dips", "big_movers", "badges"])

    def test_user_value_overrides_default(self):
        user = _user(self.db)
        _set_pref(self.db, user.id, "notify_big_movers", "true")
        _set_pref(self.db, user.id, "notify_new_sets", "false")
        self.assertTrue(n.category_enabled(self.db, user.id, "big_movers"))
        self.assertFalse(n.category_enabled(self.db, user.id, "new_sets"))

    def test_settings_api_returns_defaults_and_coerces(self):
        user = _user(self.db)
        merged = settings_api._get_user_settings(self.db, user.id)
        self.assertEqual(merged["notify_scans_ready"], "true")
        self.assertEqual(merged["notify_big_movers"], "false")
        self.assertEqual(merged["notify_digest_hour"], "18")
        self.assertEqual(settings_api._coerce_setting_value("notify_new_sets", "on"), "true")
        self.assertEqual(settings_api._coerce_setting_value("notify_digest_hour", "23"), "21")
        self.assertEqual(settings_api._coerce_setting_value("notify_digest_hour", "3"), "8")


@unittest.skipUnless(DEPS_AVAILABLE, SKIP_REASON)
class ThresholdTests(NotificationTestCase):
    def test_dip_needs_15_percent_and_one_euro(self):
        self.assertTrue(n.is_dip(8.0, 10.0))
        self.assertFalse(n.is_dip(8.6, 10.0))  # only 14 % down
        self.assertFalse(n.is_dip(0.5, 1.2))   # 58 % down but only 0.70 EUR
        self.assertFalse(n.is_dip(4.5, 5.2))   # 13 %, under 1 EUR
        self.assertTrue(n.is_dip(4.0, 5.0))    # exactly 1 EUR and 20 %
        self.assertFalse(n.is_dip(None, 5.0))

    def test_mover_needs_threshold_percent_and_two_euro(self):
        self.assertTrue(n.is_big_move(22.0, 20.0, 10))
        self.assertFalse(n.is_big_move(21.0, 20.0, 10))  # 1 EUR
        self.assertFalse(n.is_big_move(2.5, 2.0, 10))    # 25 % but 0.50 EUR
        self.assertTrue(n.is_big_move(17.0, 20.0, 10))   # downward counts too
        self.assertFalse(n.is_big_move(22.0, 20.0, 25))  # the threshold is respected
        self.assertTrue(n.is_big_move(26.0, 20.0, 25))

    def test_mover_threshold_default_and_override(self):
        user = _user(self.db)
        self.assertEqual(n.mover_threshold(self.db, user.id), 10.0)
        _set_pref(self.db, user.id, "price_alert_threshold", "25")
        self.assertEqual(n.mover_threshold(self.db, user.id), 25.0)

    def test_dips_are_queued_once_a_week(self):
        user = _user(self.db)
        card = _card(self.db, "dipcard", price=8.0, avg30=10.0)
        self.db.add(WishlistItem(user_id=user.id, card_id=card.id))
        self.db.commit()
        self.assertEqual(n.queue_price_events(self.db, [card.id], now=NOON_UTC), 1)
        self.assertEqual(n.queue_price_events(self.db, [card.id], now=NOON_UTC + datetime.timedelta(days=3)), 0)
        self.assertEqual(n.queue_price_events(self.db, [card.id], now=NOON_UTC + datetime.timedelta(days=8)), 1)

    def test_movers_are_off_by_default(self):
        user = _user(self.db)
        card = _card(self.db, "movecard", price=30.0, avg7=20.0)
        self.db.add(CollectionItem(user_id=user.id, card_id=card.id, quantity=1))
        self.db.commit()
        self.assertEqual(n.queue_price_events(self.db, [card.id], now=NOON_UTC), 0)
        _set_pref(self.db, user.id, "notify_big_movers", "true")
        self.assertEqual(n.queue_price_events(self.db, [card.id], now=NOON_UTC), 1)

    def test_dips_respect_the_category_switch(self):
        user = _user(self.db)
        _set_pref(self.db, user.id, "notify_wishlist_dips", "false")
        card = _card(self.db, "dipcard", price=8.0, avg30=10.0)
        self.db.add(WishlistItem(user_id=user.id, card_id=card.id))
        self.db.commit()
        self.assertEqual(n.queue_price_events(self.db, [card.id], now=NOON_UTC), 0)


@unittest.skipUnless(DEPS_AVAILABLE, SKIP_REASON)
class QuietHoursTests(NotificationTestCase):
    def test_window_in_local_time(self):
        berlin = ZoneInfo("Europe/Berlin")
        self.assertTrue(n.in_quiet_hours(datetime.datetime(2026, 10, 28, 21, 0), berlin))   # 22:00 local
        self.assertTrue(n.in_quiet_hours(datetime.datetime(2026, 10, 28, 6, 59), berlin))   # 07:59 local
        self.assertFalse(n.in_quiet_hours(datetime.datetime(2026, 10, 28, 7, 0), berlin))   # 08:00 local
        self.assertFalse(n.in_quiet_hours(NOON_UTC, berlin))

    def test_end_of_quiet_hours(self):
        berlin = ZoneInfo("Europe/Berlin")
        late = datetime.datetime(2026, 10, 28, 22, 30)  # 23:30 local
        self.assertEqual(n.quiet_hours_end(late, berlin), datetime.datetime(2026, 10, 29, 7, 0))
        early = datetime.datetime(2026, 10, 28, 3, 0)   # 04:00 local
        self.assertEqual(n.quiet_hours_end(early, berlin), datetime.datetime(2026, 10, 28, 7, 0))

    def test_instant_push_waits_until_morning(self):
        user = _user(self.db, time_zone="Europe/Berlin")
        late = datetime.datetime(2026, 10, 28, 22, 30)
        job = self.make_job(user, status="done")
        self.assertTrue(n.notify_scans_ready(self.db, user.id, job.id, now=late))
        self.db.commit()
        row = self.db.query(NotificationQueue).one()
        self.assertEqual(row.send_after, datetime.datetime(2026, 10, 29, 7, 0))
        n.flush_due(self.db, now=late + datetime.timedelta(hours=1))
        self.webpush.assert_not_called()
        n.flush_due(self.db, now=datetime.datetime(2026, 10, 29, 7, 1))
        self.assertEqual(len(self.payloads()), 1)

    def test_quiet_hours_can_be_switched_off(self):
        user = _user(self.db, time_zone="Europe/Berlin")
        _set_pref(self.db, user.id, "notify_quiet_hours", "false")
        late = datetime.datetime(2026, 10, 28, 22, 30)
        job = self.make_job(user, status="done")
        n.notify_scans_ready(self.db, user.id, job.id, now=late)
        self.db.commit()
        n.flush_due(self.db, now=late)
        self.assertEqual(len(self.payloads()), 1)


@unittest.skipUnless(DEPS_AVAILABLE, SKIP_REASON)
class ScansReadyTests(NotificationTestCase):
    def test_job_reaching_review_pushes_once_with_icon_number(self):
        user = _user(self.db, time_zone="UTC")
        job = self.make_job(user, (("done", False), ("done", False)))
        for _ in range(3):  # the transition can be seen more than once (rescans)
            scan_queue._refresh_job_status(self.db, job, NOON_UTC)
            self.db.commit()
        self.assertEqual(self.db.query(NotificationQueue).count(), 1)
        n.flush_due(self.db, now=NOON_UTC)
        n.flush_due(self.db, now=NOON_UTC + datetime.timedelta(minutes=1))
        payloads = self.payloads()
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["web_push"], 8030)
        self.assertEqual(payloads[0]["notification"]["navigate"], "/scans")
        self.assertEqual(payloads[0]["app_badge"], 2)
        self.assertNotIn("EUR", json.dumps(payloads[0]))

    def test_no_push_while_processing_or_when_switched_off(self):
        user = _user(self.db)
        job = self.make_job(user, (("done", False), ("pending", False)))
        scan_queue._refresh_job_status(self.db, job, NOON_UTC)
        self.db.commit()
        self.assertEqual(self.db.query(NotificationQueue).count(), 0)

        _set_pref(self.db, user.id, "notify_scans_ready", "false")
        job2 = self.make_job(user)
        scan_queue._refresh_job_status(self.db, job2, NOON_UTC)
        self.db.commit()
        self.assertEqual(self.db.query(NotificationQueue).count(), 0)

    def test_nothing_sent_when_already_reviewed(self):
        user = _user(self.db, time_zone="UTC")
        job = self.make_job(user)
        scan_queue._refresh_job_status(self.db, job, NOON_UTC)
        self.db.commit()
        self.db.query(ScanJobItem).update({"resolved": True})
        self.db.commit()
        n.flush_due(self.db, now=NOON_UTC)
        self.webpush.assert_not_called()


@unittest.skipUnless(DEPS_AVAILABLE, SKIP_REASON)
class ScansReadyLogTests(NotificationTestCase):
    """The scans-ready path explains every decision in the INFO log (no payloads, no endpoints)."""

    def logged(self, action):
        with self.assertLogs("services.notifications", level="INFO") as captured:
            action()
        return "\n".join(captured.output)

    def test_enqueued(self):
        user = _user(self.db, time_zone="UTC")
        job = self.make_job(user)
        text = self.logged(lambda: scan_queue._refresh_job_status(self.db, job, NOON_UTC))
        self.assertIn(f"Notification queued: category=scans_ready user={user.id} subject=job:{job.id}", text)

    def test_not_enqueued_category_off(self):
        user = _user(self.db)
        _set_pref(self.db, user.id, "notify_scans_ready", "false")
        job = self.make_job(user)
        text = self.logged(lambda: scan_queue._refresh_job_status(self.db, job, NOON_UTC))
        self.assertIn(f"Notification not queued: category=scans_ready user={user.id} subject=job:{job.id} category_off", text)

    def test_not_enqueued_duplicate(self):
        user = _user(self.db)
        job = self.make_job(user)
        scan_queue._refresh_job_status(self.db, job, NOON_UTC)
        self.db.commit()
        text = self.logged(lambda: scan_queue._refresh_job_status(self.db, job, NOON_UTC))
        self.assertIn("not queued: category=scans_ready", text)
        self.assertIn("duplicate", text)

    def test_not_enqueued_nothing_to_review(self):
        user = _user(self.db)
        job = self.make_job(user, (("done", True),))
        text = self.logged(lambda: scan_queue._refresh_job_status(self.db, job, NOON_UTC))
        self.assertIn("nothing_to_review", text)

    def test_flushed_logs_the_send_counts(self):
        user = _user(self.db, time_zone="UTC")
        job = self.make_job(user)
        scan_queue._refresh_job_status(self.db, job, NOON_UTC)
        self.db.commit()
        text = self.logged(lambda: n.flush_due(self.db, now=NOON_UTC))
        self.assertIn(f"Notification flushed: category=scans_ready user={user.id} subject=job:{job.id} sent=1 removed=0", text)
        self.assertNotIn("web.push.apple.com", text)
        self.assertNotIn("Scans ready to review", text)

    def test_flushed_without_a_device_says_so(self):
        user = _user(self.db, time_zone="UTC")
        self.db.query(PushSubscription).delete()
        self.db.commit()
        job = self.make_job(user)
        scan_queue._refresh_job_status(self.db, job, NOON_UTC)
        self.db.commit()
        text = self.logged(lambda: n.flush_due(self.db, now=NOON_UTC))
        self.assertIn("sent=0 removed=0 (no device received it)", text)

    def test_deferred_for_quiet_hours_logs_the_end_time(self):
        user = _user(self.db, time_zone="Europe/Berlin")
        late = datetime.datetime(2026, 10, 28, 22, 30)
        job = self.make_job(user)
        scan_queue._refresh_job_status(self.db, job, NOON_UTC)  # queued for noon, due immediately
        self.db.commit()
        text = self.logged(lambda: n.flush_due(self.db, now=late))
        self.assertIn("Notification deferred: category=scans_ready", text)
        self.assertIn("reason=quiet_hours until=2026-10-29T07:00:00", text)

    def test_skipped_when_the_category_was_switched_off_meanwhile(self):
        user = _user(self.db, time_zone="UTC")
        job = self.make_job(user)
        scan_queue._refresh_job_status(self.db, job, NOON_UTC)
        self.db.commit()
        _set_pref(self.db, user.id, "notify_scans_ready", "false")
        text = self.logged(lambda: n.flush_due(self.db, now=NOON_UTC))
        self.assertIn("Notification skipped: category=scans_ready", text)
        self.assertIn("reason=category_off", text)

    def test_skipped_when_already_reviewed(self):
        user = _user(self.db, time_zone="UTC")
        job = self.make_job(user)
        scan_queue._refresh_job_status(self.db, job, NOON_UTC)
        self.db.commit()
        self.db.query(ScanJobItem).update({"resolved": True})
        self.db.commit()
        text = self.logged(lambda: n.flush_due(self.db, now=NOON_UTC))
        self.assertIn("Notification skipped: category=scans_ready", text)
        self.assertIn("reason=already_reviewed", text)

    def test_badge_skipped_when_the_sheet_was_already_seen(self):
        user = _user(self.db, time_zone="UTC")
        self.db.add(UserAchievement(
            user_id=user.id, achievement_id="first_scan", unlocked_at=NOON_UTC, seen_at=NOON_UTC,
        ))
        self.db.commit()
        n.enqueue(self.db, user.id, "badges", "badge:first_scan", now=NOON_UTC)
        self.db.commit()
        text = self.logged(lambda: n.flush_due(self.db, now=NOON_UTC))
        self.assertIn("Notification skipped: category=badges", text)
        self.assertIn("reason=sheet_already_seen", text)
        self.webpush.assert_not_called()


@unittest.skipUnless(DEPS_AVAILABLE, SKIP_REASON)
class WishlistAlertTests(NotificationTestCase):
    def setUp(self):
        super().setUp()
        self.user = _user(self.db, time_zone='UTC')
        self.card = _card(self.db, 'alertcard', price=5.0)

    def test_pushes_card_name_only_without_a_price(self):
        self.assertTrue(n.notify_wishlist_alert(self.db, self.user.id, self.card.id, now=NOON_UTC))
        self.db.commit()
        n.flush_due(self.db, now=NOON_UTC)
        payloads = self.payloads()
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]['notification']['body'], 'Alertcard price alert')
        self.assertEqual(payloads[0]['notification']['navigate'], '/wishlist')
        self.assertNotIn('app_badge', payloads[0])
        self.assertNotRegex(payloads[0]['notification']['body'], r'[0-9]|EUR')

    def test_switch_off_means_no_push(self):
        _set_pref(self.db, self.user.id, 'notify_wishlist_alerts', 'false')
        self.assertFalse(n.notify_wishlist_alert(self.db, self.user.id, self.card.id, now=NOON_UTC))
        self.db.commit()
        n.flush_due(self.db, now=NOON_UTC)
        self.webpush.assert_not_called()

    def test_alert_in_quiet_hours_waits_until_08_00(self):
        late = datetime.datetime(2026, 10, 28, 23, 30)
        n.notify_wishlist_alert(self.db, self.user.id, self.card.id, now=late)
        self.db.commit()
        self.assertEqual(self.db.query(NotificationQueue).one().send_after, datetime.datetime(2026, 10, 29, 8, 0))
        n.flush_due(self.db, now=datetime.datetime(2026, 10, 29, 3, 0))
        self.webpush.assert_not_called()
        n.flush_due(self.db, now=datetime.datetime(2026, 10, 29, 8, 1))
        self.assertEqual(len(self.payloads()), 1)

    def test_same_card_queued_once_a_day(self):
        self.assertTrue(n.notify_wishlist_alert(self.db, self.user.id, self.card.id, now=NOON_UTC))
        self.db.commit()
        self.assertFalse(n.notify_wishlist_alert(self.db, self.user.id, self.card.id, now=NOON_UTC + datetime.timedelta(hours=2)))


@unittest.skipUnless(DEPS_AVAILABLE, SKIP_REASON)
class NewSetsTests(NotificationTestCase):
    def test_calls_telegram_and_queues_a_digest_entry(self):
        on = _user(self.db, "on")
        off = _user(self.db, "off")
        _set_pref(self.db, off.id, "notify_new_sets", "false")
        self.db.add(Set(id="new1_en", tcg_set_id="new1", name="Fresh Set", series="SV", lang="en", is_new=True))
        self.db.commit()
        with patch.object(n.telegram, "send_new_sets_notification") as telegram_send:
            n.on_new_sets(self.db, ["new1_en"])
        telegram_send.assert_called_once()
        self.assertEqual(telegram_send.call_args.args[0], [{"name": "Fresh Set", "series": "SV"}])
        self.assertEqual(telegram_send.call_args.kwargs["user_id"], on.id)
        rows = self.db.query(NotificationQueue).all()
        self.assertEqual([(r.user_id, r.category) for r in rows], [(on.id, "new_sets")])


@unittest.skipUnless(DEPS_AVAILABLE, SKIP_REASON)
class DigestTests(NotificationTestCase):
    def _queue(self, user, category, key, now=NOON_UTC):
        n.enqueue(self.db, user.id, category, key, now=now)
        self.db.commit()

    def test_payload_is_content_light_and_counted(self):
        payload = json.loads(n.build_digest_payload({"new_sets": 2, "wishlist_dips": 1, "big_movers": 0}))
        self.assertEqual(payload["web_push"], 8030)
        self.assertEqual(payload["notification"]["body"], "2 new sets, 1 wishlist dip")
        self.assertEqual(payload["notification"]["navigate"], "/")
        self.assertNotIn("app_badge", payload)
        single = json.loads(n.build_digest_payload({"new_sets": 1}))
        self.assertEqual(single["notification"]["navigate"], "/sets")
        self.assertIsNone(n.build_digest_payload({}))

    def test_sent_once_a_day_at_18_in_the_users_time_zone(self):
        user = _user(self.db, time_zone="America/New_York")  # UTC-4 on this date
        self._queue(user, "new_sets", "set:a")
        self._queue(user, "wishlist_dips", "card:x")
        # 21:00 UTC = 17:00 New York: too early.
        n.flush_due(self.db, now=datetime.datetime(2026, 10, 28, 21, 0))
        self.webpush.assert_not_called()
        # 22:00 UTC = 18:00 New York: one push.
        result = n.flush_due(self.db, now=datetime.datetime(2026, 10, 28, 22, 0))
        self.assertEqual(result["digests"], 1)
        self.assertEqual(self.payloads()[0]["notification"]["body"], "1 new set, 1 wishlist dip")
        # More arrives the same local day: held for tomorrow.
        self._queue(user, "new_sets", "set:b", now=datetime.datetime(2026, 10, 28, 22, 30))
        n.flush_due(self.db, now=datetime.datetime(2026, 10, 28, 23, 0))
        self.assertEqual(len(self.payloads()), 1)
        n.flush_due(self.db, now=datetime.datetime(2026, 10, 29, 22, 0))
        self.assertEqual(len(self.payloads()), 2)

    def test_falls_back_to_the_server_time_zone(self):
        user = _user(self.db)  # no time zone stored
        self._queue(user, "new_sets", "set:a")
        with patch.dict("os.environ", {"TZ": "Europe/Berlin"}):
            n.flush_due(self.db, now=datetime.datetime(2026, 10, 28, 16, 0))  # 17:00 Berlin
            self.webpush.assert_not_called()
            n.flush_due(self.db, now=datetime.datetime(2026, 10, 28, 17, 0))  # 18:00 Berlin
        self.assertEqual(len(self.payloads()), 1)

    def test_custom_digest_hour_and_disabled_category_dropped(self):
        user = _user(self.db, time_zone="UTC")
        _set_pref(self.db, user.id, "notify_digest_hour", "9")
        at = datetime.datetime(2026, 10, 28, 9, 0)
        self._queue(user, "new_sets", "set:a", now=at)
        self._queue(user, "wishlist_dips", "card:x", now=at)
        _set_pref(self.db, user.id, "notify_wishlist_dips", "false")
        n.flush_due(self.db, now=at)
        self.assertEqual(self.payloads()[0]["notification"]["body"], "1 new set")

    def test_digest_never_sent_in_quiet_hours(self):
        user = _user(self.db, time_zone="UTC")
        self._queue(user, "new_sets", "set:a")
        n.flush_due(self.db, now=datetime.datetime(2026, 10, 28, 23, 0))
        self.webpush.assert_not_called()


def _dip(name="Charizard ex", price=12.4, avg30=15.1, drop=17.9, set_code="OBF", number="125", card_id=None):
    return {
        "card_id": card_id or name.lower().replace(" ", "-") + "_en", "name": name, "set": "Obsidian Flames",
        "set_code": set_code, "number": number, "price": price, "avg30": avg30, "drop_pct": drop,
    }


def _mover(name="Pikachu ex", price=30.0, baseline=26.8, change=11.9, card_id=None):
    return {
        "card_id": card_id or name.lower().replace(" ", "-") + "_en", "name": name, "set": "Surging Sparks",
        "set_code": "SSP", "number": "57", "price": price, "baseline": baseline, "change_pct": change,
    }


def _note(raw):
    payload = json.loads(raw)
    assert payload["web_push"] == 8030
    assert len(raw.encode("utf-8")) <= push_service.MAX_PAYLOAD_BYTES
    return payload["notification"]


@unittest.skipUnless(DEPS_AVAILABLE, SKIP_REASON)
class DetailedPayloadTests(NotificationTestCase):
    def test_one_dip_names_the_card_and_the_drop(self):
        note = _note(n.build_detail_digest_payload({"wishlist_dips": [_dip()]}))
        self.assertEqual(note["title"], "Wishlist dip")
        self.assertEqual(note["body"], "Charizard ex (OBF 125) is down 18% to €12.40 (30-day avg €15.10)")
        self.assertEqual(note["navigate"], "/wishlist")

    def test_several_dips_list_the_biggest_drop_first(self):
        dips = [_dip("Pikachu", 3.1, 3.7, 16.2), _dip("Charizard ex", 12.4, 15.1, 17.9), _dip("Eevee", 1.0, 2.0, 50.0)]
        note = _note(n.build_detail_digest_payload({"wishlist_dips": dips}))
        self.assertEqual(note["title"], "3 wishlist dips")
        self.assertEqual(note["body"], "Eevee −50% €1.00 · Charizard ex −18% €12.40 · Pikachu −16% €3.10")
        self.assertEqual(note["navigate"], "/wishlist")

    def test_big_movers_show_direction_and_percent(self):
        single = _note(n.build_detail_digest_payload({"big_movers": [_mover()]}))
        self.assertEqual(single["title"], "Big mover")
        self.assertEqual(single["body"], "Pikachu ex (SSP 57) is up 12% to €30.00 (7-day avg €26.80)")
        self.assertEqual(single["navigate"], "/collection?cardId=pikachu-ex_en")
        movers = [_mover("Mewtwo", 8.0, 9.0, -11.1), _mover("Pikachu ex"), _mover("Ditto", 2.0, 2.0, 0.0)]
        several = _note(n.build_detail_digest_payload({"big_movers": movers[:2]}))
        self.assertEqual(several["title"], "2 big movers")
        self.assertEqual(several["body"], "Pikachu ex ▲12% €30.00 · Mewtwo ▼11% €8.00")
        self.assertEqual(several["navigate"], "/collection")

    def test_new_sets_list_the_names(self):
        one = _note(n.build_detail_digest_payload({"new_sets": [{"name": "Obsidian Flames", "series": "SV"}]}))
        self.assertEqual((one["title"], one["body"], one["navigate"]), ("New set", "Obsidian Flames", "/sets"))
        two = _note(n.build_detail_digest_payload({
            "new_sets": [{"name": "Obsidian Flames"}, {"name": "Paldea Evolved"}],
        }))
        self.assertEqual((two["title"], two["body"]), ("2 new sets", "Obsidian Flames, Paldea Evolved"))

    def test_mixed_digest_is_one_push_with_a_line_per_category(self):
        note = _note(n.build_detail_digest_payload({
            "new_sets": [{"name": "Obsidian Flames"}],
            "wishlist_dips": [_dip(), _dip("Pikachu", 3.1, 3.7, 16.2)],
            "big_movers": [_mover()],
        }))
        self.assertEqual(note["title"], "1 new set, 2 wishlist dips, 1 big mover")
        self.assertEqual(note["body"].split("\n"), [
            "New sets: Obsidian Flames",
            "Wishlist: Charizard ex −18% €12.40 · Pikachu −16% €3.10",
            "Movers: Pikachu ex ▲12% €30.00",
        ])
        self.assertEqual(note["navigate"], "/")

    def test_navigation_picks_the_most_relevant_page(self):
        route = lambda groups: _note(n.build_detail_digest_payload(groups))["navigate"]  # noqa: E731
        self.assertEqual(route({"wishlist_dips": [_dip(), _dip("Pikachu")]}), "/wishlist")
        self.assertEqual(route({"wishlist_dips": [_dip()]}), "/wishlist")
        self.assertEqual(route({"wishlist_dips": [_dip()], "big_movers": [_mover(card_id=_dip()["card_id"])]}),
                         "/collection?cardId=charizard-ex_en")
        self.assertEqual(route({"wishlist_dips": [_dip()], "big_movers": [_mover()]}), "/")
        self.assertEqual(route({"wishlist_dips": [_dip()], "new_sets": [{"name": "X"}]}), "/")

    def test_rows_without_details_fall_back_to_counts(self):
        note = _note(n.build_detail_digest_payload({"new_sets": [None, None]}))
        self.assertEqual(note["body"], "2 new sets")
        mixed = _note(n.build_detail_digest_payload({"new_sets": [None], "wishlist_dips": [_dip()]}))
        self.assertEqual(mixed["body"].split("\n"), ["1 new set", "Wishlist: Charizard ex −18% €12.40"])
        self.assertEqual(mixed["navigate"], "/")

    def test_a_long_list_ends_with_and_n_more_and_stays_in_the_limit(self):
        dips = [_dip(f"Card number {i} with a long name", 10.0, 20.0, 50.0 - i / 10) for i in range(300)]
        note = _note(n.build_detail_digest_payload({"wishlist_dips": dips}))
        self.assertEqual(note["title"], "300 wishlist dips")
        self.assertLessEqual(len(note["body"]), n.MAX_BODY_CHARS)
        self.assertRegex(note["body"], r" · and \d+ more$")
        shown = note["body"].count("−")
        self.assertEqual(int(note["body"].rsplit("and ", 1)[1].split()[0]), 300 - shown)
        sets = [{"name": f"Set {i} of the very long names"} for i in range(200)]
        body = _note(n.build_detail_digest_payload({"new_sets": sets}))["body"]
        self.assertRegex(body, r" and \d+ more$")
        mixed = _note(n.build_detail_digest_payload({"wishlist_dips": dips, "big_movers": dips, "new_sets": sets}))
        self.assertLessEqual(len(mixed["body"]), n.MAX_BODY_CHARS + 2)

    def test_the_hard_limit_is_enforced_for_huge_or_multibyte_text(self):
        raw = push_service.encode_payload_fitted("T" * 500, "🃏" * 5000, "/" + "x" * 2000)
        self.assertLessEqual(len(raw.encode("utf-8")), push_service.MAX_PAYLOAD_BYTES)
        json.loads(raw)
        dips = [_dip("🃏" * 200, 10.0, 20.0, 50.0)] * 50
        _note(n.build_detail_digest_payload({"wishlist_dips": dips, "new_sets": [{"name": "é" * 5000}]}))

    def test_wishlist_price_alert_says_price_against_the_threshold(self):
        below = {"name": "Charizard ex", "price": 12.4, "threshold": 13.0, "alert_type": "below"}
        note = _note(n.build_wishlist_alert_payload(below))
        self.assertEqual(note["title"], "Wishlist price alert")
        self.assertEqual(note["body"], "Charizard ex is now €12.40, under your €13.00 alert")
        self.assertEqual(note["navigate"], "/wishlist")
        above = _note(n.build_wishlist_alert_payload({**below, "price": 20.0, "threshold": 18.5, "alert_type": "above"}))
        self.assertEqual(above["body"], "Charizard ex is now €20.00, over your €18.50 alert")
        light = _note(n.build_wishlist_alert_payload({"name": "Charizard ex"}))
        self.assertEqual(light["body"], "Charizard ex price alert")

    def test_badge_names_the_badge_and_tier(self):
        note = _note(n.build_badge_payload("dex_50"))
        self.assertEqual((note["title"], note["body"], note["navigate"]),
                         ("Badge unlocked", "Species Seeker 50 · Bronze", "/achievements"))
        self.assertEqual(_note(n.build_badge_payload("collector_100"))["body"], "Centurion · Silver")
        self.assertEqual(_note(n.build_badge_payload())["body"], "You earned a badge")

    def test_badge_without_a_name_falls_back(self):
        from services import achievements as ach

        entry = {**ach.registry_by_id()["dex_50"], "name": ""}
        with patch.object(ach, "registry_by_id", return_value={"dex_50": entry}):
            self.assertEqual(_note(n.build_badge_payload("dex_50"))["body"], "You earned a new badge · Bronze")
        self.assertEqual(_note(n.build_badge_payload("not_a_badge"))["body"], "You earned a new badge")

    def test_scans_ready_text_and_app_badge(self):
        payload = json.loads(n.build_scans_payload(5, 3))
        self.assertEqual(payload["notification"]["body"], "3 scans ready to review")
        self.assertEqual(payload["app_badge"], 5)
        self.assertEqual(json.loads(n.build_scans_payload(1, 1))["notification"]["body"], "1 scan ready to review")
        light = json.loads(n.build_scans_payload(5))
        self.assertEqual(light["notification"]["body"], "Scans ready to review")
        self.assertEqual(light["app_badge"], 5)


@unittest.skipUnless(DEPS_AVAILABLE, SKIP_REASON)
class StoredDetailsTests(NotificationTestCase):
    def setUp(self):
        super().setUp()
        self.user = _user(self.db, time_zone="UTC")

    def row(self, category):
        self.db.expire_all()
        return self.db.query(NotificationQueue).filter_by(category=category).one()

    def test_the_model_has_the_details_column(self):
        self.assertIn("details", NotificationQueue.__table__.columns)
        self.assertTrue(NotificationQueue.__table__.columns["details"].nullable)
        self.assertIn(
            "ALTER TABLE notification_queue ADD COLUMN IF NOT EXISTS details",
            inspect.getsource(database._run_migrations),
        )

    def test_dip_details_are_stored_as_they_were(self):
        self.db.add(Set(id="tst_en", tcg_set_id="tst", name="Test Set", abbreviation="TST", lang="en"))
        card = _card(self.db, "dipcard", price=8.0, avg30=10.0)
        self.db.add(WishlistItem(user_id=self.user.id, card_id=card.id))
        self.db.commit()
        n.queue_price_events(self.db, [card.id], now=NOON_UTC)
        details = self.row("wishlist_dips").details
        self.assertEqual(
            details,
            {"card_id": "dipcard", "name": "Dipcard", "set": "Test Set", "set_code": "TST", "number": "1",
             "price": 8.0, "avg30": 10.0, "drop_pct": 20.0},
        )
        card.price_trend = card.price_market = 2.0  # later price changes do not touch the stored values
        self.db.commit()
        self.assertEqual(self.row("wishlist_dips").details["price"], 8.0)

    def test_mover_details_are_stored(self):
        _set_pref(self.db, self.user.id, "notify_big_movers", "true")
        card = _card(self.db, "movecard", price=17.0, avg7=20.0)
        self.db.add(CollectionItem(user_id=self.user.id, card_id=card.id, quantity=1))
        self.db.commit()
        n.queue_price_events(self.db, [card.id], now=NOON_UTC)
        details = self.row("big_movers").details
        self.assertEqual((details["name"], details["price"], details["baseline"], details["change_pct"]),
                         ("Movecard", 17.0, 20.0, -15.0))

    def test_alert_new_set_scan_and_badge_details_are_stored(self):
        card = _card(self.db, "alertcard", price=5.0)
        n.notify_wishlist_alert(self.db, self.user.id, card.id, now=NOON_UTC, price=12.4, threshold=13.0, alert_type="below")
        self.db.add(Set(id="new1_en", tcg_set_id="new1", name="Fresh Set", series="SV", lang="en", is_new=True))
        self.db.commit()
        with patch.object(n.telegram, "send_new_sets_notification"):
            n.on_new_sets(self.db, ["new1_en"])
        job = self.make_job(self.user, items=(("done", False), ("failed", False), ("done", True)), status="done")
        n.on_scan_job_finished(self.db, job, now=NOON_UTC)
        n.enqueue(self.db, self.user.id, "badges", "badge:first_scan", now=NOON_UTC, details={"badge_id": "first_scan"})
        self.db.commit()
        alert = self.row("wishlist_alerts").details
        self.assertEqual((alert["name"], alert["price"], alert["threshold"], alert["alert_type"]),
                         ("Alertcard", 12.4, 13.0, "below"))
        self.assertEqual(self.row("new_sets").details, {"name": "Fresh Set", "series": "SV"})
        self.assertEqual(self.row("scans_ready").details, {"job_id": job.id, "count": 2})
        self.assertEqual(self.row("badges").details, {"badge_id": "first_scan"})

    def test_enqueue_without_details_leaves_the_column_empty(self):
        n.enqueue(self.db, self.user.id, "new_sets", "set:z", now=NOON_UTC)
        self.db.commit()
        self.assertIsNone(self.row("new_sets").details)

    def test_the_daily_digest_uses_the_stored_values_end_to_end(self):
        card = _card(self.db, "dipcard", price=8.0, avg30=10.0)
        self.db.add(WishlistItem(user_id=self.user.id, card_id=card.id))
        self.db.commit()
        n.queue_price_events(self.db, [card.id], now=NOON_UTC)
        n.flush_due(self.db, now=datetime.datetime(2026, 10, 28, 18, 0))
        note = self.payloads()[0]["notification"]
        self.assertEqual(note["title"], "Wishlist dip")
        self.assertEqual(note["body"], "Dipcard (#1) is down 20% to €8.00 (30-day avg €10.00)")

    def test_the_switch_off_sends_the_content_light_texts(self):
        _set_pref(self.db, self.user.id, "notify_show_details", "false")
        card = _card(self.db, "dipcard", price=8.0, avg30=10.0)
        self.db.add(WishlistItem(user_id=self.user.id, card_id=card.id))
        self.db.commit()
        n.queue_price_events(self.db, [card.id], now=NOON_UTC)
        self.db.add(Set(id="new1_en", tcg_set_id="new1", name="Fresh Set", series="SV", lang="en", is_new=True))
        self.db.commit()
        with patch.object(n.telegram, "send_new_sets_notification"):
            n.on_new_sets(self.db, ["new1_en"])
        self.db.query(NotificationQueue).filter_by(category="new_sets").update({"send_after": NOON_UTC})
        self.db.commit()
        n.notify_wishlist_alert(self.db, self.user.id, card.id, now=NOON_UTC, price=8.0, threshold=9.0, alert_type="below")
        job = self.make_job(self.user, status="done")
        n.on_scan_job_finished(self.db, job, now=NOON_UTC)
        n.enqueue(self.db, self.user.id, "badges", "badge:first_scan", now=NOON_UTC, details={"badge_id": "first_scan"})
        self.db.add(UserAchievement(
            user_id=self.user.id, achievement_id="first_scan", unlocked_at=NOON_UTC, seen_at=None,
        ))
        self.db.commit()
        n.flush_due(self.db, now=datetime.datetime(2026, 10, 28, 18, 0))
        bodies = sorted(p["notification"]["body"] for p in self.payloads())
        self.assertEqual(bodies, ["1 wishlist dip, 1 new set", "Dipcard price alert", "Scans ready to review",
                                  "You earned a badge"])
        for payload in self.payloads():
            self.assertNotRegex(json.dumps(payload, ensure_ascii=False), r"€|Fresh Set|20%")

    def test_instant_pushes_carry_the_details_by_default(self):
        card = _card(self.db, "alertcard", price=5.0)
        n.notify_wishlist_alert(self.db, self.user.id, card.id, now=NOON_UTC, price=12.4, threshold=13.0, alert_type="below")
        job = self.make_job(self.user, items=(("done", False), ("done", False), ("done", False)), status="done")
        n.on_scan_job_finished(self.db, job, now=NOON_UTC)
        self.db.commit()
        n.flush_due(self.db, now=NOON_UTC)
        notes = {p["notification"]["title"]: p for p in self.payloads()}
        self.assertEqual(notes["Wishlist price alert"]["notification"]["body"],
                         "Alertcard is now €12.40, under your €13.00 alert")
        self.assertEqual(notes["PokéCollector"]["notification"]["body"], "3 scans ready to review")
        self.assertEqual(notes["PokéCollector"]["app_badge"], 3)

    def test_the_setting_defaults_on_and_is_a_boolean(self):
        self.assertTrue(n.show_details(self.db, self.user.id))
        merged = settings_api._get_user_settings(self.db, self.user.id)
        self.assertEqual(merged["notify_show_details"], "true")
        self.assertEqual(settings_api._coerce_setting_value("notify_show_details", "off"), "false")
        _set_pref(self.db, self.user.id, "notify_show_details", "false")
        self.assertFalse(n.show_details(self.db, self.user.id))


if __name__ == "__main__":
    unittest.main()
