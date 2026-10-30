import datetime
import json
import unittest
from unittest.mock import patch

try:
    import main
    from api.auth import get_current_user
    from api.backup import BACKUP_GROUPS
    from models import (
        Binder,
        BinderCard,
        CollectionItem,
        NotificationQueue,
        ProductCard,
        ProductLedgerEntry,
        ProductPurchase,
        Setting,
        SwapOffer,
        SwapOfferItem,
        Trade,
        User,
    )
    from services import notifications, scheduler, swaps
    from services.social_feature import SOCIAL_SETTING_KEY
    from test_small_delights import ApiBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    ApiBase = object


NEXT_NOON = datetime.datetime.combine(datetime.date.today() + datetime.timedelta(days=1), datetime.time(12, 0))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class SwapBase(ApiBase):
    def setUp(self):
        super().setUp()
        patcher = patch("api.auth.multi_user_enabled", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.turn_social(True)
        self.ash, self.misty = self.user, self.other
        # ash: two of tst-001 (a spare), one tst-002. misty: two of big-001, one big-002.
        self.a1 = self.give("tst-001", self.ash, 2)
        self.a2 = self.give("tst-002", self.ash, 1)
        self.m1 = self.give("big-001", self.misty, 2)
        self.m2 = self.give("big-002", self.misty, 1)

    def turn_social(self, on):
        self.db.query(Setting).filter(Setting.key == SOCIAL_SETTING_KEY).delete()
        self.db.add(Setting(key=SOCIAL_SETTING_KEY, value="true" if on else "false"))
        self.db.commit()

    def give(self, card, user, quantity):
        item = CollectionItem(
            card_id=f"{card}_en", user_id=user.id, quantity=quantity, variant="Normal", lang="en", condition="NM",
        )
        self.db.add(item)
        self.db.commit()
        return item

    def as_user(self, user):
        main.app.dependency_overrides[get_current_user] = lambda: user

    def body(self, items, cash=0, payer=None, note=None, to=None):
        data = {
            "to_user_id": (to or self.misty).id,
            "items": [{"collection_item_id": i.id, "quantity": q} for i, q in items],
            "cash_amount": cash,
            "cash_payer_user_id": payer.id if payer else None,
        }
        if note is not None:
            data["note"] = note
        return data

    def counter_body(self, items, cash=0, payer=None, note=None, revision=None):
        data = self.body(items, cash, payer, note)
        del data["to_user_id"]
        if revision is not None:
            data["revision"] = revision
        return data

    def propose(self, items=None, **kw):
        """ash gives the single tst-002 and asks one spare big-001."""
        self.as_user(self.ash)
        response = self.client.post("/api/swaps", json=self.body(items or [(self.a2, 1), (self.m1, 1)], **kw))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def act(self, user, offer_id, action, json_body=None):
        self.as_user(user)
        return self.client.post(f"/api/swaps/{offer_id}/{action}", json=json_body)

    def accepted(self):
        offer = self.propose()
        self.assertEqual(self.act(self.misty, offer["id"], "accept").status_code, 200)
        return offer["id"]

    def offer_row(self, offer_id):
        self.db.expire_all()
        return self.db.get(SwapOffer, offer_id)

    def queue(self, user, kind=None):
        self.db.expire_all()
        rows = self.db.query(NotificationQueue).filter_by(user_id=user.id, category="swap_offers").order_by(NotificationQueue.id).all()
        return [r for r in rows if kind is None or r.details["kind"] == kind]


class SwitchTests(SwapBase):
    def test_every_route_is_404_while_the_switch_is_off(self):
        offer = self.propose()
        self.turn_social(False)
        for method, path, body in [
            ("get", "/api/swaps", None),
            ("get", "/api/swaps/waiting", None),
            ("get", f"/api/swaps/{offer['id']}", None),
            ("post", "/api/swaps", self.body([(self.a2, 1), (self.m1, 1)])),
            ("post", f"/api/swaps/{offer['id']}/counter", self.counter_body([(self.a2, 1)])),
            ("post", f"/api/swaps/{offer['id']}/accept", {}),
            ("post", f"/api/swaps/{offer['id']}/decline", {}),
            ("post", f"/api/swaps/{offer['id']}/cancel", None),
            ("post", f"/api/swaps/{offer['id']}/confirm-swapped", None),
        ]:
            response = getattr(self.client, method)(path, **({"json": body} if body is not None else {}))
            self.assertEqual(response.status_code, 404, (method, path))

    def test_single_user_mode_is_404_too(self):
        with patch("api.auth.multi_user_enabled", return_value=False):
            self.assertEqual(self.client.get("/api/swaps").status_code, 404)


class CreateTests(SwapBase):
    def test_create_snapshots_items_values_and_turn(self):
        offer = self.propose(cash=2.5, payer=self.misty, note="  at the shop  ")
        self.assertEqual(offer["state"], "proposed")
        self.assertEqual(offer["revision"], 1)
        self.assertEqual(offer["role"], "proposer")
        self.assertEqual(offer["turn_user_id"], self.misty.id)
        self.assertFalse(offer["your_turn"])
        self.assertEqual(offer["note"], "at the shop")
        self.assertEqual(offer["cash"], {"amount": 2.5, "payer_user_id": self.misty.id})
        mine = [i for i in offer["items"] if i["gives"]]
        theirs = [i for i in offer["items"] if not i["gives"]]
        self.assertEqual([(i["card_id"], i["quantity"], i["collection_item_id"]) for i in mine], [("tst-002_en", 1, self.a2.id)])
        self.assertEqual([i["card_id"] for i in theirs], ["big-001_en"])
        self.assertEqual(mine[0]["value_per_card"], 5.0)
        self.assertEqual(theirs[0]["value_per_card"], 30.0)
        # fair-trade values: ash gives 5, gets 30 + 2.5 cash; misty gives 30 + 2.5, gets 5
        self.assertEqual((offer["values"]["you"]["gives"], offer["values"]["you"]["gets"]), (5.0, 32.5))
        self.assertEqual(offer["values"]["you"]["delta"], 27.5)
        self.assertEqual((offer["values"]["partner"]["gives"], offer["values"]["partner"]["gets"]), (32.5, 5.0))
        row = self.offer_row(offer["id"])
        self.assertAlmostEqual((row.expires_at - row.created_at).total_seconds(), 14 * 86400, delta=5)

    def test_values_use_each_trainers_own_price_field(self):
        from models import UserSetting

        self.db.add(UserSetting(user_id=self.misty.id, key="price_primary", value="price_market"))
        card = self.db.get(CollectionItem, self.m1.id).card
        card.price_market = 20.0
        self.db.commit()
        offer = self.propose()
        self.assertEqual(offer["values"]["you"]["gets"], 30.0)
        self.assertEqual(offer["values"]["partner"]["gives"], 20.0)
        self.assertEqual(offer["values"]["partner"]["price_field"], "price_market")

    def test_asking_for_a_card_without_a_spare_copy_is_refused(self):
        self.as_user(self.ash)
        response = self.client.post("/api/swaps", json=self.body([(self.a2, 1), (self.m2, 1)]))
        self.assertEqual(response.status_code, 409)
        self.assertIn("spare", response.json()["detail"])

    def test_cannot_ask_for_more_than_the_spare_copies(self):
        self.as_user(self.ash)
        response = self.client.post("/api/swaps", json=self.body([(self.a2, 1), (self.m1, 2)]))
        self.assertEqual(response.status_code, 409)

    def test_binder_allocated_copies_are_not_spare(self):
        binder = Binder(name="mine", user_id=self.misty.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.add(BinderCard(binder_id=binder.id, card_id=self.m1.card_id, collection_item_id=self.m1.id, required_quantity=2))
        self.db.commit()
        self.as_user(self.ash)
        response = self.client.post("/api/swaps", json=self.body([(self.a2, 1), (self.m1, 1)]))
        self.assertEqual(response.status_code, 409)

    def test_own_cards_need_the_quantity_but_no_spare(self):
        self.as_user(self.ash)
        ok = self.client.post("/api/swaps", json=self.body([(self.a2, 1), (self.m1, 1)]))
        self.assertEqual(ok.status_code, 200)
        too_many = self.client.post("/api/swaps", json=self.body([(self.a2, 2), (self.m1, 1)]))
        self.assertEqual(too_many.status_code, 409)

    def test_a_copy_of_a_third_trainer_or_a_custom_card_is_refused(self):
        brock = User(username="brock", hashed_password="x", role="trainer", is_active=True)
        self.db.add(brock)
        self.db.commit()
        theirs = self.give("tst-001", brock, 3)
        self.as_user(self.ash)
        self.assertEqual(self.client.post("/api/swaps", json=self.body([(theirs, 1), (self.a2, 1)])).status_code, 404)
        from models import Card

        self.db.add(Card(id="custom-x", name="Custom", set_id="custom", number="1", lang="en", is_custom=True, custom_owner_id=self.misty.id))
        self.db.commit()
        custom = CollectionItem(card_id="custom-x", user_id=self.misty.id, quantity=3, variant="Normal", lang="en", condition="NM")
        self.db.add(custom)
        self.db.commit()
        self.assertEqual(self.client.post("/api/swaps", json=self.body([(self.a2, 1), (custom, 1)])).status_code, 404)

    def test_validation(self):
        self.as_user(self.ash)
        base = [(self.a2, 1), (self.m1, 1)]
        self.assertEqual(self.client.post("/api/swaps", json=self.body(base, note="x" * 141)).status_code, 422)
        self.assertEqual(self.client.post("/api/swaps", json=self.body(base, note="x" * 140)).status_code, 200)
        self.assertEqual(self.client.post("/api/swaps", json=self.body(base, cash=5)).status_code, 422)  # no payer
        self.assertEqual(self.client.post("/api/swaps", json=self.body(base, cash=-1, payer=self.ash)).status_code, 422)
        self.assertEqual(self.client.post("/api/swaps", json=self.body([])).status_code, 422)
        self.assertEqual(self.client.post("/api/swaps", json=self.body(base, to=self.ash)).status_code, 422)
        self.assertEqual(self.client.post("/api/swaps", json=self.body([(self.a2, 1), (self.a2, 1)])).status_code, 422)
        missing = self.body(base)
        missing["to_user_id"] = 9999
        self.assertEqual(self.client.post("/api/swaps", json=missing).status_code, 404)


class ReadTests(SwapBase):
    def test_lists_incoming_outgoing_and_history(self):
        sent = self.propose()
        self.as_user(self.misty)
        mine = self.client.get("/api/swaps").json()
        self.assertEqual([o["id"] for o in mine["incoming"]], [sent["id"]])
        self.assertEqual(mine["outgoing"], [])
        self.assertEqual(mine["waiting_count"], 1)
        self.assertTrue(mine["incoming"][0]["your_turn"])
        self.assertEqual(mine["incoming"][0]["actions"], ["accept", "decline", "counter"])
        self.act(self.misty, sent["id"], "decline")
        mine = self.client.get("/api/swaps").json()
        self.assertEqual((mine["incoming"], mine["waiting_count"]), ([], 0))
        self.assertEqual([o["state"] for o in mine["history"]], ["declined"])
        self.as_user(self.ash)
        theirs = self.client.get("/api/swaps").json()
        self.assertEqual([o["id"] for o in theirs["history"]], [sent["id"]])

    def test_only_the_two_trainers_can_read_an_offer(self):
        offer = self.propose()
        brock = User(username="brock", hashed_password="x", role="trainer", is_active=True)
        self.db.add(brock)
        self.db.commit()
        self.as_user(brock)
        self.assertEqual(self.client.get(f"/api/swaps/{offer['id']}").status_code, 404)
        self.assertEqual(self.client.post(f"/api/swaps/{offer['id']}/accept", json={}).status_code, 404)
        self.assertEqual(self.client.post(f"/api/swaps/{offer['id']}/cancel").status_code, 404)
        self.assertEqual(self.client.get("/api/swaps").json()["incoming"], [])
        self.as_user(self.misty)
        self.assertEqual(self.client.get(f"/api/swaps/{offer['id']}").json()["role"], "recipient")


class TransitionTests(SwapBase):
    def test_accept_needs_the_trainer_whose_turn_it_is(self):
        offer = self.propose()
        self.assertEqual(self.act(self.ash, offer["id"], "accept").status_code, 403)
        self.assertEqual(self.act(self.ash, offer["id"], "decline").status_code, 403)
        self.assertEqual(self.act(self.ash, offer["id"], "counter", self.counter_body([(self.a2, 1), (self.m1, 1)])).status_code, 403)
        response = self.act(self.misty, offer["id"], "accept")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["state"], "accepted")
        self.assertEqual(response.json()["actions"], ["confirm", "cancel"])
        self.assertIsNone(self.offer_row(offer["id"]).turn_user_id)

    def test_decline(self):
        offer = self.propose()
        self.assertEqual(self.act(self.misty, offer["id"], "decline").json()["state"], "declined")
        self.assertEqual(self.act(self.misty, offer["id"], "accept").status_code, 409)

    def test_counter_replaces_items_bumps_revision_and_flips_the_turn(self):
        offer = self.propose()
        response = self.act(self.misty, offer["id"], "counter", self.counter_body(
            [(self.m1, 1), (self.a1, 1)], cash=1, payer=self.ash, note="plus one"))
        self.assertEqual(response.status_code, 200, response.text)
        counter = response.json()
        self.assertEqual((counter["state"], counter["revision"], counter["turn_user_id"]), ("countered", 2, self.ash.id))
        self.assertEqual(sorted(i["card_id"] for i in counter["items"]), ["big-001_en", "tst-001_en"])
        self.assertEqual(counter["cash"]["payer_user_id"], self.ash.id)
        self.assertEqual(self.db.query(SwapOfferItem).filter_by(offer_id=offer["id"]).count(), 2)
        # now ash is on turn, may counter back (countered -> proposed), and the old turn holder may not act
        self.assertEqual(self.act(self.misty, offer["id"], "accept").status_code, 403)
        back = self.act(self.ash, offer["id"], "counter", self.counter_body([(self.a2, 1), (self.m1, 1)]))
        self.assertEqual((back.json()["state"], back.json()["revision"]), ("proposed", 3))
        self.assertEqual(back.json()["turn_user_id"], self.misty.id)

    def test_a_stale_revision_is_refused(self):
        offer = self.propose()
        self.act(self.misty, offer["id"], "counter", self.counter_body([(self.m1, 1), (self.a1, 1)]))
        self.assertEqual(self.act(self.ash, offer["id"], "accept", {"revision": 1}).status_code, 409)
        self.assertEqual(self.act(self.ash, offer["id"], "accept", {"revision": 2}).status_code, 200)

    def test_cancel_by_the_proposer_only_before_acceptance(self):
        offer = self.propose()
        self.assertEqual(self.act(self.misty, offer["id"], "cancel").status_code, 403)
        self.assertEqual(self.act(self.ash, offer["id"], "cancel").json()["state"], "cancelled")
        self.assertEqual(self.act(self.ash, offer["id"], "cancel").status_code, 409)
        self.assertEqual(self.act(self.misty, offer["id"], "accept").status_code, 409)

    def test_either_trainer_can_cancel_an_accepted_offer(self):
        for canceller in ("ash", "misty"):
            offer_id = self.accepted()
            self.assertEqual(self.act(getattr(self, canceller), offer_id, "cancel").json()["state"], "cancelled")
            self.assertEqual(self.act(self.ash, offer_id, "confirm-swapped").status_code, 409)

    def test_confirming_needs_an_accepted_offer_and_one_tap_each(self):
        offer = self.propose()
        self.assertEqual(self.act(self.ash, offer["id"], "confirm-swapped").status_code, 409)
        self.act(self.misty, offer["id"], "accept")
        first = self.act(self.ash, offer["id"], "confirm-swapped")
        self.assertEqual(first.status_code, 200)
        self.assertEqual((first.json()["state"], first.json()["you_confirmed"], first.json()["partner_confirmed"]), ("accepted", True, False))
        self.assertEqual(first.json()["actions"], ["cancel"])
        self.assertEqual(self.act(self.ash, offer["id"], "confirm-swapped").status_code, 409)
        self.as_user(self.misty)
        self.assertTrue(self.client.get(f"/api/swaps/{offer['id']}").json()["partner_confirmed"])

    def test_accepting_names_a_card_that_is_already_gone(self):
        offer = self.propose()
        self.db.delete(self.db.get(CollectionItem, self.m1.id))
        self.db.commit()
        response = self.act(self.misty, offer["id"], "accept")
        self.assertEqual(response.status_code, 409)
        self.assertIn("Big-001", response.json()["detail"])


class ExpiryTests(SwapBase):
    def test_idle_offers_expire_after_fourteen_days(self):
        stale = self.propose()
        fresh = self.propose()
        accepted = self.accepted()
        for offer_id in (stale["id"], accepted):
            self.offer_row(offer_id).expires_at = datetime.datetime.utcnow() - datetime.timedelta(minutes=1)
            self.db.commit()
        self.assertEqual(swaps.expire_stale(self.db), 2)
        self.db.commit()
        self.assertEqual(self.offer_row(stale["id"]).state, "expired")
        self.assertEqual(self.offer_row(accepted).state, "expired")
        self.assertEqual(self.offer_row(fresh["id"]).state, "proposed")

    def test_scheduler_job_expires_offers(self):
        offer = self.propose()
        self.offer_row(offer["id"]).expires_at = datetime.datetime.utcnow() - datetime.timedelta(days=1)
        self.db.commit()
        with patch("database.SessionLocal", self.Session):
            scheduler.run_swap_expiry_job()
        self.assertEqual(self.offer_row(offer["id"]).state, "expired")

    def test_expired_offers_cannot_be_answered_and_leave_the_icon_count(self):
        offer = self.propose()
        self.offer_row(offer["id"]).expires_at = datetime.datetime.utcnow() - datetime.timedelta(minutes=1)
        self.db.commit()
        self.assertEqual(swaps.waiting_count(self.db, self.misty.id), 0)
        response = self.act(self.misty, offer["id"], "accept")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.offer_row(offer["id"]).state, "expired")
        self.assertEqual(self.client.get("/api/swaps").json()["history"][0]["state"], "expired")

    def test_each_change_pushes_the_expiry_out(self):
        offer = self.propose()
        row = self.offer_row(offer["id"])
        row.expires_at = datetime.datetime.utcnow() + datetime.timedelta(days=1)
        self.db.commit()
        self.act(self.misty, offer["id"], "accept")
        self.assertGreater(self.offer_row(offer["id"]).expires_at, datetime.datetime.utcnow() + datetime.timedelta(days=13))


class CompletionTests(SwapBase):
    def complete(self):
        offer_id = self.accepted()
        self.assertEqual(self.act(self.ash, offer_id, "confirm-swapped").status_code, 200)
        response = self.act(self.misty, offer_id, "confirm-swapped")
        self.assertEqual(response.status_code, 200, response.text)
        return offer_id, response.json()

    def quantities(self, user):
        self.db.expire_all()
        return {
            row.card_id: row.quantity
            for row in self.db.query(CollectionItem).filter_by(user_id=user.id)
        }

    def test_both_taps_log_a_trade_for_each_trainer_and_move_the_cards(self):
        offer_id, view = self.complete()
        self.assertEqual(view["state"], "completed")
        self.assertIsNotNone(self.offer_row(offer_id).completed_at)
        self.assertEqual(self.quantities(self.ash), {"tst-001_en": 2, "big-001_en": 1})
        self.assertEqual(self.quantities(self.misty), {"big-001_en": 1, "big-002_en": 1, "tst-002_en": 1})
        trades = {t.user_id: t for t in self.db.query(Trade).filter(Trade.swap_offer_id == offer_id)}
        self.assertEqual(set(trades), {self.ash.id, self.misty.id})
        self.assertEqual(trades[self.ash.id].partner_name, "misty")
        self.assertEqual(trades[self.misty.id].partner_name, "ash")
        ash_items = {(i.direction, i.card_id, i.quantity) for i in trades[self.ash.id].items}
        self.assertEqual(ash_items, {("outgoing", "tst-002_en", 1), ("incoming", "big-001_en", 1)})
        self.assertEqual(trades[self.ash.id].outgoing_value, 5.0)
        self.assertEqual(trades[self.ash.id].incoming_value, 30.0)
        self.assertEqual(trades[self.misty.id].outgoing_value, 30.0)
        # each side finds its own trade through the offer
        self.assertEqual(view["trade_id"], trades[self.misty.id].id)
        self.as_user(self.ash)
        self.assertEqual(self.client.get(f"/api/swaps/{offer_id}").json()["trade_id"], trades[self.ash.id].id)
        self.assertEqual(self.client.get("/api/trades/").json()[0]["swap_offer_id"], offer_id)

    def test_cash_is_logged_on_both_sides(self):
        offer = self.propose(cash=4, payer=self.ash)
        self.act(self.misty, offer["id"], "accept")
        self.act(self.ash, offer["id"], "confirm-swapped")
        self.assertEqual(self.act(self.misty, offer["id"], "confirm-swapped").status_code, 200)
        trades = {t.user_id: t for t in self.db.query(Trade).filter(Trade.swap_offer_id == offer["id"])}
        self.assertEqual(trades[self.ash.id].outgoing_value, 9.0)  # 5 card + 4 cash
        self.assertEqual(trades[self.misty.id].incoming_value, 9.0)
        self.assertEqual(trades[self.misty.id].outgoing_value, 30.0)

    def test_binder_allocations_are_released(self):
        binder = Binder(name="mine", user_id=self.ash.id, binder_type="collection")
        deck = Binder(name="deck", user_id=self.ash.id, binder_type="physical_deck")
        self.db.add_all([binder, deck])
        self.db.commit()
        # both copies of tst-001 are promised (1 in the binder, 1 in the deck) and the sole tst-002 too
        in_binder = BinderCard(binder_id=binder.id, card_id=self.a1.card_id, collection_item_id=self.a1.id, required_quantity=1)
        in_deck = BinderCard(binder_id=deck.id, card_id=self.a1.card_id, collection_item_id=self.a1.id, required_quantity=1)
        sole = BinderCard(binder_id=binder.id, card_id=self.a2.card_id, collection_item_id=self.a2.id, required_quantity=1)
        self.db.add_all([in_binder, in_deck, sole])
        self.db.commit()
        sole_id, deck_id = sole.id, in_deck.id
        offer = self.propose([(self.a1, 1), (self.a2, 1), (self.m1, 1)])
        self.act(self.misty, offer["id"], "accept")
        self.act(self.ash, offer["id"], "confirm-swapped")
        self.assertEqual(self.act(self.misty, offer["id"], "confirm-swapped").status_code, 200)
        self.db.expire_all()
        self.assertEqual(self.quantities(self.ash)["tst-001_en"], 1)
        self.assertIsNone(self.db.get(BinderCard, sole_id))  # the sole copy left, so its slot is gone
        remaining = self.db.query(BinderCard).filter(BinderCard.collection_item_id == self.a1.id).all()
        self.assertEqual(sum(r.required_quantity for r in remaining), 1)
        self.assertIsNone(self.db.get(BinderCard, deck_id))

    def test_product_linked_copies_are_handled_like_trades(self):
        product = ProductPurchase(
            product_name="Bundle", product_type="Bundle", purchase_price=20,
            purchase_date=datetime.date(2026, 7, 1), user_id=self.ash.id,
        )
        self.db.add(product)
        self.db.commit()
        link = ProductCard(
            product_id=product.id, user_id=self.ash.id, card_id=self.a2.card_id, collection_item_id=self.a2.id,
            initial_quantity=1, active_quantity=1, sold_quantity=0, condition="NM", variant="Normal", lang="en",
            purchase_price=None, linked_at=datetime.datetime.utcnow(),
        )
        self.db.add(link)
        self.db.commit()
        link_id = link.id
        self.complete()
        self.db.expire_all()
        link = self.db.get(ProductCard, link_id)
        self.assertEqual((link.active_quantity, link.sold_quantity), (0, 1))
        entry = self.db.query(ProductLedgerEntry).filter_by(product_card_id=link_id, entry_type="trade_out").one()
        self.assertEqual(entry.quantity, 1)
        self.assertIsNotNone(entry.trade_item_id)

    def test_a_missing_card_leaves_everything_unchanged(self):
        offer_id = self.accepted()
        self.act(self.ash, offer_id, "confirm-swapped")
        # misty sold her spare in the meantime
        mine = self.db.get(CollectionItem, self.m1.id)
        mine.quantity = 0
        self.db.commit()
        before_ash, before_misty = self.quantities(self.ash), self.quantities(self.misty)
        response = self.act(self.misty, offer_id, "confirm-swapped")
        self.assertEqual(response.status_code, 409)
        payload = response.json()
        self.assertIn("Big-001", payload["detail"])
        self.assertEqual([u["card_id"] for u in payload["unavailable"]], ["big-001_en"])
        self.assertEqual(payload["unavailable"][0]["giver_user_id"], self.misty.id)
        row = self.offer_row(offer_id)
        self.assertEqual(row.state, "accepted")
        self.assertIsNone(row.to_confirmed_at)  # misty's tap was not recorded
        self.assertIsNotNone(row.from_confirmed_at)
        self.assertEqual(self.db.query(Trade).count(), 0)
        self.assertEqual((self.quantities(self.ash), self.quantities(self.misty)), (before_ash, before_misty))
        self.assertEqual(self.queue(self.ash, "completed"), [])
        # either trainer can still cancel
        self.assertEqual(self.act(self.ash, offer_id, "cancel").json()["state"], "cancelled")

    def test_a_failure_halfway_rolls_back_the_first_trainers_trade(self):
        offer_id = self.accepted()
        self.act(self.ash, offer_id, "confirm-swapped")
        calls = []
        from api import trades as trades_api

        real = trades_api.create_trade_for_user

        def flaky(db, user, plan, *args, **kwargs):
            calls.append(user.id)
            if len(calls) == 2:
                raise swaps.SwapError(500, "boom")
            return real(db, user, plan, *args, **kwargs)

        with patch("api.trades.create_trade_for_user", flaky):
            response = self.act(self.misty, offer_id, "confirm-swapped")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.db.query(Trade).count(), 0)
        self.assertEqual(self.quantities(self.ash), {"tst-001_en": 2, "tst-002_en": 1})
        self.assertEqual(self.offer_row(offer_id).state, "accepted")


class NotificationTests(SwapBase):
    def test_pushes_follow_the_offer(self):
        offer = self.propose()
        rows = self.queue(self.misty)
        self.assertEqual([(r.subject_key, r.details["kind"]) for r in rows], [(f"swap:{offer['id']}:r1:offer", "offer")])
        self.assertEqual(self.queue(self.ash), [])
        self.act(self.misty, offer["id"], "counter", self.counter_body([(self.m1, 1), (self.a1, 1)]))
        self.assertEqual([r.subject_key for r in self.queue(self.ash)], [f"swap:{offer['id']}:r2:counter"])
        self.act(self.ash, offer["id"], "accept")
        self.assertEqual([r.details["kind"] for r in self.queue(self.misty)], ["offer", "accepted"])
        self.assertEqual(len(self.queue(self.ash)), 1)
        self.act(self.misty, offer["id"], "confirm-swapped")
        self.assertEqual([r.details["kind"] for r in self.queue(self.ash)], ["counter", "swapped"])
        self.act(self.ash, offer["id"], "confirm-swapped")
        self.assertEqual([r.details["kind"] for r in self.queue(self.ash)], ["counter", "swapped", "completed"])
        self.assertEqual([r.details["kind"] for r in self.queue(self.misty)], ["offer", "accepted", "completed"])

    def test_one_push_per_offer_and_revision(self):
        offer = self.propose()
        row = self.offer_row(offer["id"])
        self.assertFalse(notifications.enqueue(self.db, self.misty.id, "swap_offers", f"swap:{offer['id']}:r1:offer"))
        self.assertEqual(len(self.queue(self.misty)), 1)
        self.assertIsNotNone(row)

    def test_category_off_queues_nothing(self):
        from models import UserSetting

        self.db.add(UserSetting(user_id=self.misty.id, key="notify_swap_offers", value="false"))
        self.db.commit()
        self.propose()
        self.assertEqual(self.queue(self.misty), [])

    def test_texts_are_short_and_respect_show_details(self):
        detailed = json.loads(notifications.build_swap_payload(
            {"kind": "offer", "partner": "ash", "gives": 1, "gets": 2}, True, 3))
        self.assertEqual(detailed["notification"]["title"], "Swap offer")
        self.assertEqual(detailed["notification"]["body"], "ash offered 2 cards for 1 of yours")
        self.assertEqual(detailed["app_badge"], 3)
        light = json.loads(notifications.build_swap_payload({"kind": "offer", "partner": "ash", "gives": 1, "gets": 2}, False))
        self.assertEqual(light["notification"]["body"], "You have a new swap offer")
        self.assertNotIn("ash", json.dumps(light))
        self.assertNotIn("app_badge", light)
        for kind in ("counter", "accepted", "swapped", "completed"):
            for detail in (True, False):
                body = json.loads(notifications.build_swap_payload({"kind": kind, "partner": "ash", "gives": 1, "gets": 1}, detail))["notification"]["body"]
                self.assertLess(len(body), 80, (kind, detail))
        self.assertNotIn("ash", json.loads(notifications.build_swap_payload({"kind": "accepted", "partner": "ash"}, False))["notification"]["body"])

    def test_flush_sends_with_details_switch_and_icon_number(self):
        self.propose()
        sent = []
        with patch.object(notifications, "_send", side_effect=lambda db, uid, payload: sent.append((uid, json.loads(payload))) or {"sent": 1, "removed": 0}):
            notifications.flush_due(self.db, now=NEXT_NOON)
        self.assertEqual([uid for uid, _ in sent], [self.misty.id])
        payload = sent[0][1]
        self.assertEqual(payload["notification"]["body"], "ash offered Tst-002 (TST 002) for your Big-001 (BIG 001)")
        self.assertEqual(payload["app_badge"], 1)

        from models import UserSetting

        self.db.add(UserSetting(user_id=self.ash.id, key="notify_show_details", value="false"))
        self.db.commit()
        offer = self.propose()
        self.act(self.misty, offer["id"], "accept")
        sent.clear()
        with patch.object(notifications, "_send", side_effect=lambda db, uid, payload: sent.append((uid, json.loads(payload))) or {"sent": 1, "removed": 0}):
            notifications.flush_due(self.db, now=NEXT_NOON)
        for_ash = [p for uid, p in sent if uid == self.ash.id]
        self.assertEqual([p["notification"]["body"] for p in for_ash], ["Your swap offer was accepted"])

    def test_a_push_for_an_offer_that_moved_on_is_skipped(self):
        offer = self.propose()
        self.act(self.ash, offer["id"], "cancel")
        with patch.object(notifications, "_send") as send:
            notifications.flush_due(self.db, now=NEXT_NOON)
        send.assert_not_called()

    def test_nothing_is_sent_while_the_switch_is_off(self):
        self.propose()
        self.turn_social(False)
        with patch.object(notifications, "_send") as send:
            notifications.flush_due(self.db, now=NEXT_NOON)
        send.assert_not_called()


class PushTextTests(SwapBase):
    def payload(self, details, detailed=True, badge=None):
        return json.loads(notifications.build_swap_payload(details, detailed, badge))

    def test_cards_are_named_and_amounts_never_appear(self):
        base = {"offer_id": 41, "partner": "Brock", "gives": 1, "gets": 1, "cash": False,
                "give_cards": ["Greninja ex (TWM 106)"], "get_cards": ["Charizard ex (OBF 125)"]}
        expected = {
            "offer": "Brock offered Charizard ex (OBF 125) for your Greninja ex (TWM 106)",
            "counter": "Brock countered: Charizard ex (OBF 125) for your Greninja ex (TWM 106)",
            "accepted": "Brock accepted: Charizard ex (OBF 125) for your Greninja ex (TWM 106). Meet up, then both tap Swapped.",
            "swapped": "Brock tapped Swapped. Tap yours once you have Charizard ex (OBF 125).",
            "completed": "Charizard ex (OBF 125) is in your collection.",
        }
        for kind, body in expected.items():
            self.assertEqual(self.payload({**base, "kind": kind})["notification"]["body"], body)
        cash = self.payload({**base, "kind": "offer", "cash": True})["notification"]["body"]
        self.assertEqual(cash, "Brock offered Charizard ex (OBF 125) for your Greninja ex (TWM 106) + cash")
        self.assertNotRegex(cash, r"[£€$]|\d+\.\d\d")

    def test_a_side_with_more_than_two_cards_is_counted(self):
        details = {"kind": "offer", "partner": "Brock", "offer_id": 1, "gives": 1, "gets": 3,
                   "give_cards": ["Mew ex (MEW 151)", "Pikachu (MEW 173)"], "get_cards": ["A (X 1)", "B (X 2)", "C (X 3)"]}
        self.assertEqual(self.payload(details)["notification"]["body"],
                         "Brock offered 3 cards for your Mew ex (MEW 151) and Pikachu (MEW 173)")

    def test_details_off_names_nothing(self):
        details = {"kind": "offer", "partner": "Brock", "offer_id": 41, "gives": 1, "gets": 1,
                   "give_cards": ["Greninja ex (TWM 106)"], "get_cards": ["Charizard ex (OBF 125)"]}
        text = json.dumps(self.payload(details, detailed=False))
        self.assertNotIn("Greninja", text)
        self.assertNotIn("Brock", text)

    def test_every_swap_push_opens_the_offer(self):
        for kind in ("offer", "counter", "accepted", "swapped", "completed", "declined"):
            for detailed in (True, False):
                payload = self.payload({"kind": kind, "partner": "Brock", "offer_id": 41}, detailed)
                self.assertEqual(payload["notification"]["navigate"], "/trades/offers/41", (kind, detailed))

    def test_queued_rows_without_card_names_keep_the_counts(self):
        body = self.payload({"kind": "offer", "partner": "ash", "offer_id": 1, "gives": 1, "gets": 2})["notification"]["body"]
        self.assertEqual(body, "ash offered 2 cards for 1 of yours")

    def test_queued_details_hold_labels_and_no_amount(self):
        offer = self.propose(cash=2.5, payer=self.misty)
        details = self.queue(self.misty)[0].details
        self.assertEqual(details["get_cards"], ["Tst-002 (TST 002)"])
        self.assertEqual(details["give_cards"], ["Big-001 (BIG 001)"])
        self.assertTrue(details["cash"])
        self.assertNotIn("2.5", json.dumps(details))
        self.assertEqual(details["offer_id"], offer["id"])

    def test_a_decline_pushes_the_other_trainer_without_an_icon_number(self):
        offer = self.propose()
        self.act(self.misty, offer["id"], "decline", {})
        rows = self.queue(self.ash)
        self.assertEqual([(r.subject_key, r.details["kind"]) for r in rows], [(f"swap:{offer['id']}:r1:declined", "declined")])
        sent = []
        with patch.object(notifications, "_send", side_effect=lambda db, uid, payload: sent.append((uid, json.loads(payload))) or {"sent": 1, "removed": 0}):
            notifications.flush_due(self.db, now=NEXT_NOON)
        payload = next(p for uid, p in sent if uid == self.ash.id)
        self.assertEqual(payload["notification"]["title"], "Swap declined")
        self.assertEqual(payload["notification"]["body"], "misty declined your swap offer")
        self.assertNotIn("app_badge", payload)
        light = self.payload({"kind": "declined", "partner": "misty", "offer_id": 1}, False, 4)
        self.assertEqual(light["notification"]["body"], "A swap offer was declined")
        self.assertNotIn("app_badge", light)

    def test_cancelling_sends_no_push(self):
        offer = self.propose()
        self.act(self.ash, offer["id"], "cancel")
        self.assertEqual([r.details["kind"] for r in self.queue(self.misty)], ["offer"])
        self.assertEqual(self.queue(self.ash), [])


class ChangesTests(SwapBase):
    def test_a_first_revision_has_no_changes(self):
        offer = self.propose()
        self.assertEqual(offer["changes"], [])

    def test_a_counter_lists_what_it_changed_from_the_viewers_side(self):
        offer = self.propose(note="Hello")
        response = self.act(self.misty, offer["id"], "counter", self.counter_body(
            [(self.a1, 1), (self.m2, 1)], cash=3, payer=self.ash, note="Pikachu makes it fair"))
        self.assertEqual(response.status_code, 200, response.text)
        by_kind = {}
        for c in response.json()["changes"]:
            by_kind.setdefault(c["change"], []).append(c)
        # Misty (the viewer) now asks Ash's spare tst-001 and gives big-002 instead of tst-002 and the spare big-001
        self.assertEqual([(c["card_name"], c["gives"]) for c in by_kind["added"]], [("Tst-001", False), ("Big-002", True)])
        self.assertEqual([(c["card_name"], c["gives"]) for c in by_kind["removed"]], [("Tst-002", False), ("Big-001", True)])
        self.assertEqual(by_kind["cash"][0]["to"], {"amount": 3.0, "payer_user_id": self.ash.id})
        self.assertEqual(by_kind["note"][0]["to"], "Pikachu makes it fair")
        self.as_user(self.ash)
        seen = self.client.get(f"/api/swaps/{offer['id']}").json()["changes"]
        self.assertEqual([c["gives"] for c in seen if c["change"] == "added"], [True, False])

    def test_quantity_changes(self):
        offer = self.propose([(self.a1, 1), (self.m1, 1)])
        response = self.act(self.misty, offer["id"], "counter", self.counter_body([(self.a1, 1), (self.m1, 2)]))
        self.assertEqual(response.status_code, 200, response.text)
        changes = response.json()["changes"]
        self.assertEqual([(c["change"], c["from"], c["to"]) for c in changes], [("quantity", 1, 2)])

    def test_the_next_counter_replaces_the_changes(self):
        offer = self.propose()
        self.act(self.misty, offer["id"], "counter", self.counter_body([(self.a1, 1), (self.m1, 1)], note="x"))
        response = self.act(self.ash, offer["id"], "counter", self.counter_body([(self.a1, 1), (self.a2, 1), (self.m1, 1)]))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([c["change"] for c in response.json()["changes"]], ["added", "note"])


class UnavailableTests(SwapBase):
    def test_a_card_that_went_after_acceptance_shows_before_anyone_taps(self):
        offer_id = self.accepted()
        self.as_user(self.ash)
        self.assertEqual(self.client.get(f"/api/swaps/{offer_id}").json()["unavailable"], [])
        self.db.delete(self.db.get(CollectionItem, self.a2.id))
        self.db.commit()
        for user in (self.ash, self.misty):
            self.as_user(user)
            problems = self.client.get(f"/api/swaps/{offer_id}").json()["unavailable"]
            self.assertEqual([(p["card_name"], p["giver_user_id"], p["needed"], p["available"]) for p in problems],
                             [("Tst-002", self.ash.id, 1, 0)])
        self.assertEqual(self.client.get("/api/swaps").json()["incoming"][0]["unavailable"][0]["card_name"], "Tst-002")

    def test_only_accepted_offers_carry_it(self):
        offer = self.propose()
        self.assertEqual(offer["unavailable"], [])


class CandidateTests(SwapBase):
    def get(self, user, **params):
        self.as_user(user)
        return self.client.get("/api/swaps/candidates", params={"partner_id": self.misty.id if user is self.ash else self.ash.id, **params})

    def test_your_own_copies_with_a_wishlist_match_on_the_partners_list(self):
        from models import WishlistItem

        self.db.add(WishlistItem(user_id=self.misty.id, card_id="tst-001_en"))
        self.misty.is_profile_public = True
        self.misty.wishlist_visibility = "trade_matches"
        self.db.commit()
        with patch("services.public_profile_feature.public_profiles_enabled", return_value=True):
            data = self.get(self.ash, side="give").json()
            self.assertTrue(data["wishlist_visible"])
            by_card = {i["card_id"]: i for i in data["items"]}
            self.assertEqual(set(by_card), {"tst-001_en", "tst-002_en"})
            self.assertTrue(by_card["tst-001_en"]["on_wishlist"])
            self.assertFalse(by_card["tst-002_en"]["on_wishlist"])
            self.assertEqual((by_card["tst-001_en"]["offerable"], by_card["tst-001_en"]["spare"]), (2, True))
            self.assertEqual(by_card["tst-002_en"]["spare"], False)
            self.assertEqual(data["counts"], {"all": 2, "spares": 1, "wishlist": 1})
            self.assertEqual([i["card_id"] for i in self.get(self.ash, side="give", filter="wishlist").json()["items"]], ["tst-001_en"])
            self.assertEqual([i["card_id"] for i in self.get(self.ash, side="give", filter="spares").json()["items"]], ["tst-001_en"])

    def test_the_partners_wishlist_is_hidden_unless_compare_may_show_it(self):
        from models import WishlistItem

        self.db.add(WishlistItem(user_id=self.misty.id, card_id="tst-001_en"))
        self.db.commit()
        data = self.get(self.ash, side="give").json()
        self.assertFalse(data["wishlist_visible"])
        self.assertEqual(data["counts"]["wishlist"], 0)
        self.assertFalse(any(i["on_wishlist"] for i in data["items"]))

    def test_only_the_partners_spares_can_be_asked_for(self):
        data = self.get(self.ash, side="get").json()
        self.assertEqual([(i["card_id"], i["offerable"]) for i in data["items"]], [("big-001_en", 1)])
        # a binder holding the spare copy makes it not spare any more
        binder = Binder(user_id=self.misty.id, name="B", binder_type="collection")
        self.db.add(binder)
        self.db.flush()
        self.db.add(BinderCard(binder_id=binder.id, card_id="big-001_en", collection_item_id=self.m1.id, required_quantity=2))
        self.db.commit()
        self.assertEqual(self.get(self.ash, side="get").json()["items"], [])

    def test_your_wishlist_marks_the_partners_spares(self):
        from models import WishlistItem

        self.db.add(WishlistItem(user_id=self.ash.id, card_id="big-001_en"))
        self.db.commit()
        data = self.get(self.ash, side="get").json()
        self.assertTrue(data["items"][0]["on_wishlist"])
        self.assertEqual(data["counts"]["wishlist"], 1)

    def test_search_and_values_use_your_price_field(self):
        self.assertEqual(self.get(self.ash, side="give", q="002").json()["items"][0]["card_id"], "tst-002_en")
        self.assertEqual(self.get(self.ash, side="give", q="nothing").json()["items"], [])
        self.assertEqual(self.get(self.ash, side="give").json()["items"][1]["value"], 5.0)

    def test_checks_and_the_social_switch(self):
        self.as_user(self.ash)
        self.assertEqual(self.client.get("/api/swaps/candidates", params={"partner_id": self.ash.id}).status_code, 422)
        self.assertEqual(self.client.get("/api/swaps/candidates", params={"partner_id": 9999}).status_code, 404)
        self.assertEqual(self.client.get("/api/swaps/candidates", params={"partner_id": self.misty.id, "side": "x"}).status_code, 422)
        self.turn_social(False)
        self.assertEqual(self.client.get("/api/swaps/candidates", params={"partner_id": self.misty.id}).status_code, 404)

    def test_items_carry_the_set_code_and_types(self):
        offer = self.propose()
        item = offer["items"][0]
        self.assertIn("set_code", item)
        self.assertIsInstance(item["types"], list)


class IconNumberTests(SwapBase):
    def test_offers_waiting_for_you_count_while_social_is_on(self):
        self.propose()
        self.propose()
        self.assertEqual(notifications.icon_number(self.db, self.misty.id), 2)
        self.assertEqual(notifications.icon_number(self.db, self.ash.id), 0)  # their own offers are not waiting for them
        self.as_user(self.misty)
        self.assertEqual(self.client.get("/api/swaps/waiting").json(), {"count": 2})
        self.turn_social(False)
        self.assertEqual(notifications.icon_number(self.db, self.misty.id), 0)

    def test_the_count_adds_to_scans_and_follows_the_turn(self):
        from models import ScanJob, ScanJobItem

        job = ScanJob(user_id=self.misty.id, status="running", expires_at=datetime.datetime.utcnow() + datetime.timedelta(days=14))
        self.db.add(job)
        self.db.flush()
        self.db.add(ScanJobItem(job_id=job.id, user_id=self.misty.id, position=0, byte_size=1, status="done", resolved=False))
        self.db.commit()
        offer = self.propose()
        self.assertEqual(notifications.icon_number(self.db, self.misty.id), 2)
        self.act(self.misty, offer["id"], "counter", self.counter_body([(self.m1, 1), (self.a1, 1)]))
        self.assertEqual(notifications.icon_number(self.db, self.misty.id), 1)
        self.assertEqual(notifications.icon_number(self.db, self.ash.id), 1)
        self.act(self.ash, offer["id"], "accept")  # accepted offers have no turn
        self.assertEqual(notifications.icon_number(self.db, self.ash.id), 0)

    def test_the_scans_push_carries_the_combined_number(self):
        from models import ScanJob, ScanJobItem

        self.propose()
        job = ScanJob(user_id=self.misty.id, status="running", expires_at=datetime.datetime.utcnow() + datetime.timedelta(days=14))
        self.db.add(job)
        self.db.flush()
        self.db.add(ScanJobItem(job_id=job.id, user_id=self.misty.id, position=0, byte_size=1, status="done", resolved=False))
        self.db.commit()
        notifications.notify_scans_ready(self.db, self.misty.id, job.id, count=1)
        self.db.commit()
        sent = []
        with patch.object(notifications, "_send", side_effect=lambda db, uid, payload: sent.append((uid, json.loads(payload))) or {"sent": 1, "removed": 0}):
            notifications.flush_due(self.db, now=NEXT_NOON)
        scans = [p for uid, p in sent if uid == self.misty.id and "scan" in p["notification"]["body"].lower()]
        self.assertEqual(scans[0]["app_badge"], 2)


class StorageTests(SwapBase):
    def test_tables_are_backed_up_with_the_users_group(self):
        self.assertIn("swap_offers", BACKUP_GROUPS["users"])
        self.assertIn("swap_offer_items", BACKUP_GROUPS["users"])

    def test_deleting_a_trainer_removes_their_offers_and_unlinks_the_other_trade(self):
        open_offer = self.propose([(self.a1, 1), (self.m1, 1)])
        done = self.accepted()
        self.act(self.ash, done, "confirm-swapped")
        self.act(self.misty, done, "confirm-swapped")
        self.as_user(self.ash)  # ash is the admin
        with patch("services.scan_trace.revoke_user_traces"):
            response = self.client.delete(f"/api/auth/users/{self.misty.id}")
        self.assertEqual(response.status_code, 200, response.text)
        self.db.expire_all()
        self.assertEqual(self.db.query(SwapOffer).count(), 0)
        self.assertEqual(self.db.query(SwapOfferItem).count(), 0)
        ash_trade = self.db.query(Trade).filter_by(user_id=self.ash.id).one()
        self.assertIsNone(ash_trade.swap_offer_id)
        self.assertIsNotNone(open_offer)
        self.assertIsNotNone(self.db.get(User, self.ash.id))


if __name__ == "__main__":
    unittest.main()
