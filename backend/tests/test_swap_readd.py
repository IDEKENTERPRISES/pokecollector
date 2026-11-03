"""Re-adding a card an offer lists clears its warning, through the endpoints the app calls
(docs/SOCIAL_DESIGN.md section 5.5.6): remove with DELETE, add with POST /collection, bulk-add or the offline outbox."""
import datetime
import json
import unittest
import uuid
from unittest.mock import patch

try:
    from models import CollectionItem, NotificationQueue, SwapOffer, UserEvent, UserSetting
    from services import feed as feed_service
    from services import notifications, swaps
    from test_swaps import SwapBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    SwapBase = object


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class ReAddTests(SwapBase):
    def add(self, card="tst-002", **extra):
        """What Search > Add, the card page and a scan review send: the default NM / Normal / en copy."""
        self.as_user(self.ash)
        response = self.client.post("/api/collection/", json={"card_id": f"{card}_en", **extra})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def delete(self, copy_id):
        self.as_user(self.ash)
        response = self.client.delete(f"/api/collection/{copy_id}")
        self.assertEqual(response.status_code, 200, response.text)

    def problems(self, user, offer_id):
        self.as_user(user)
        return self.client.get(f"/api/swaps/{offer_id}").json()["unavailable"]

    def offer_view(self, user, offer_id):
        self.as_user(user)
        return self.client.get(f"/api/swaps/{offer_id}").json()

    def holo_lp_offer(self):
        """ash owns tst-002 as Holo / LP and offers it."""
        self.delete(self.a2.id)
        held = self.add(variant="Holo", condition="LP")
        self.a2 = self.db.get(CollectionItem, held["id"])
        return self.propose([(self.a2, 1), (self.m1, 1)])

    def assert_clear(self, offer_id):
        for user in (self.ash, self.misty):
            self.assertEqual(self.problems(user, offer_id), [])

    def test_remove_then_add_a_default_copy_of_a_normal_card(self):
        offer = self.propose()
        self.delete(self.a2.id)
        self.assertEqual(len(self.problems(self.ash, offer["id"])), 1)
        self.add()
        self.assert_clear(offer["id"])

    def test_re_adding_with_the_default_condition_when_the_offer_copy_was_lp_clears_and_notes_it(self):
        self.delete(self.a2.id)
        held = self.add(condition="LP")
        offer = self.propose([(self.db.get(CollectionItem, held["id"]), 1), (self.m1, 1)])
        self.delete(held["id"])
        self.assertEqual(len(self.problems(self.misty, offer["id"])), 1)
        self.add()  # NM by default
        self.assert_clear(offer["id"])
        view = self.offer_view(self.misty, offer["id"])
        mine = next(i for i in view["items"] if i["giver_user_id"] == self.ash.id)
        self.assertEqual((mine["condition"], mine["now_condition"]), ("LP", "NM"))
        self.assertIsNone(next(i for i in view["items"] if i["giver_user_id"] == self.misty.id)["now_condition"])

    def test_the_closest_condition_is_preferred(self):
        offer = self.propose()
        self.delete(self.a2.id)
        self.add(condition="HP")
        nm = self.add()
        self.assert_clear(offer["id"])
        self.assertEqual(self.act(self.misty, offer["id"], "accept").status_code, 200)
        item = next(i for i in self.offer_row(offer["id"]).items if i.giver_user_id == self.ash.id)
        self.assertEqual(item.collection_item_id, nm["id"])

    def test_a_removed_holo_added_back_as_normal_still_warns_and_says_why(self):
        offer = self.holo_lp_offer()
        self.delete(self.a2.id)
        self.add()  # Normal by default
        for user in (self.ash, self.misty):
            found = self.problems(user, offer["id"])
            self.assertEqual(len(found), 1)
            self.assertEqual(
                (found[0]["reason"], found[0]["have_variants"], found[0]["offer_variant"]),
                ("variant", ["Normal"], "Holo"),
            )
        self.add(variant="Holo")
        self.assert_clear(offer["id"])

    def test_a_card_gone_entirely_has_no_variant_reason(self):
        offer = self.propose()
        self.delete(self.a2.id)
        self.assertNotIn("reason", self.problems(self.misty, offer["id"])[0])

    def test_quantity_minus_then_plus_on_a_stack(self):
        offer = self.propose([(self.a1, 2), (self.m1, 1)])
        self.as_user(self.ash)
        self.assertEqual(self.client.put(f"/api/collection/{self.a1.id}", json={"quantity": 1}).status_code, 200)
        self.assertEqual(self.problems(self.misty, offer["id"])[0]["available"], 1)
        self.add("tst-001")  # merges into the same row
        self.assert_clear(offer["id"])

    def test_remove_the_whole_stack_and_bulk_add_it_back(self):
        offer = self.propose([(self.a1, 2), (self.m1, 1)])
        self.delete(self.a1.id)
        self.as_user(self.ash)
        response = self.client.post("/api/collection/bulk-add", json={"items": [{"card_id": "tst-001_en", "quantity": 2}]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assert_clear(offer["id"])

    def test_the_outbox_replay_with_an_idempotency_key(self):
        offer = self.propose()
        self.delete(self.a2.id)
        self.as_user(self.ash)
        response = self.client.post(
            "/api/collection/", json={"card_id": "tst-002_en", "quantity": 1},
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assert_clear(offer["id"])

    def test_an_accepted_offer_swaps_the_re_added_copy(self):
        offer = self.holo_lp_offer()
        self.assertEqual(self.act(self.misty, offer["id"], "accept").status_code, 200)
        self.delete(self.a2.id)
        self.add(variant="Holo")
        self.assert_clear(offer["id"])
        self.act(self.ash, offer["id"], "confirm-swapped")
        self.assertEqual(self.act(self.misty, offer["id"], "confirm-swapped").status_code, 200)
        self.db.expire_all()
        copy = self.db.query(CollectionItem).filter_by(user_id=self.misty.id, card_id="tst-002_en", variant="Holo").one()
        self.assertEqual(copy.quantity, 1)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class PushSendingSanityTests(SwapBase):
    """flush_due still sends a swap offer push and a feed reaction push, and holds both for quiet hours."""

    def setUp(self):
        super().setUp()
        for user in (self.ash, self.misty):
            self.db.add(UserSetting(user_id=user.id, key="time_zone", value="UTC"))
        self.db.commit()
        self.sent = []
        patcher = patch.object(
            notifications, "_send",
            side_effect=lambda db, uid, payload: self.sent.append((uid, json.loads(payload))) or {"sent": 1, "removed": 0},
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def queue_both(self, at):
        """ash offers misty a swap and reacts to misty's set completion, both at `at`."""
        offer = self.propose()
        # the service queued the push with the real clock; queue it again as of `at`
        for row in self.db.query(NotificationQueue).filter_by(user_id=self.misty.id, category="swap_offers"):
            self.db.delete(row)
        self.db.commit()
        swaps._notify(self.db, self.db.get(SwapOffer, offer["id"]), self.misty.id, "offer", self.ash, at)
        event = UserEvent(user_id=self.misty.id, kind="set_completed", subject_key="tst_en", dedupe_key="sanity:1",
                          payload={"set_name": "Test Set", "lang": "en", "total": 2}, occurred_at=at)
        self.db.add(event)
        self.db.commit()
        feed_service.add_reaction(self.db, event.id, self.ash.id, "cheer")
        notifications.notify_feed_reaction(self.db, event, self.ash, "cheer", now=at)
        self.db.commit()

    def bodies(self):
        return sorted(p["notification"]["body"] for uid, p in self.sent if uid == self.misty.id)

    def test_both_go_out_at_noon(self):
        noon = datetime.datetime(2026, 10, 30, 12, 0)
        self.queue_both(noon)
        notifications.flush_due(self.db, now=noon)
        bodies = self.bodies()
        self.assertEqual(len(bodies), 2, bodies)
        self.assertTrue(any("offered" in b for b in bodies), bodies)
        self.assertTrue(any("reacted" in b for b in bodies), bodies)

    def test_both_go_out_at_night_by_default(self):
        night = datetime.datetime(2026, 10, 30, 22, 50)
        self.queue_both(night)
        notifications.flush_due(self.db, now=night)
        self.assertEqual(len(self.bodies()), 2)

    def test_both_wait_for_eight_when_quiet_hours_are_on(self):
        self.db.add(UserSetting(user_id=self.misty.id, key="notify_quiet_hours", value="true"))
        self.db.commit()
        night = datetime.datetime(2026, 10, 30, 22, 50)
        self.queue_both(night)
        notifications.flush_due(self.db, now=night)
        self.assertEqual(self.bodies(), [])
        rows = self.db.query(NotificationQueue).filter(
            NotificationQueue.user_id == self.misty.id, NotificationQueue.sent_at.is_(None)
        ).all()
        self.assertEqual({r.send_after for r in rows}, {datetime.datetime(2026, 10, 31, 8, 0)})
        notifications.flush_due(self.db, now=datetime.datetime(2026, 10, 31, 8, 0))
        self.assertEqual(len(self.bodies()), 2)
