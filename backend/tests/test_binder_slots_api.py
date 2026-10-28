import asyncio
import csv
import io
import unittest

try:
    from fastapi import HTTPException, UploadFile
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.binders import (
        add_card_to_binder,
        add_collection_item_to_binder,
        compact_binder_slots,
        delete_binder,
        export_binder_csv,
        get_binder_slots,
        import_binder_csv,
        remove_binder_entry,
        replace_binder_slots,
        update_binder,
        update_binder_entry,
    )
    from database import Base
    from models import Binder, BinderCard, BinderSlot, Card, CollectionItem, Set, User
    from schemas import BinderCardUpdate, BinderSlotItem, BinderSlotsReplace, BinderUpdate
    from services.binder_slots import register_binder_slot_listeners, unregister_binder_slot_listeners
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class BinderSlotsApiTests(unittest.TestCase):
    def setUp(self):
        register_binder_slot_listeners()
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other = User(username="gary", hashed_password="x", role="trainer", is_active=True)
        self.set_obj = Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet & Violet", lang="en")
        self.cards = [
            Card(id=f"sv1-{n}_en", tcg_card_id=f"sv1-{n}", name=f"Card {n}", set_id="sv1", number=str(n), lang="en", variants_normal=True)
            for n in range(1, 6)
        ]
        self.db.add_all([self.user, self.other, self.set_obj, *self.cards])
        self.db.commit()

    def tearDown(self):
        self.db.close()
        unregister_binder_slot_listeners()

    def _binder(self, binder_type="collection", user=None):
        binder = Binder(name="B", user_id=(user or self.user).id, binder_type=binder_type)
        self.db.add(binder)
        self.db.commit()
        return binder

    def _own(self, card, quantity=1, user=None):
        item = CollectionItem(card_id=card.id, user_id=(user or self.user).id, quantity=quantity, condition="NM", variant="Normal", lang="en")
        self.db.add(item)
        self.db.commit()
        return item

    def _add(self, binder, card, quantity=1, owned=None):
        item = self._own(card, owned or quantity)
        add_collection_item_to_binder(binder.id, item.id, quantity=quantity, current_user=self.user, db=self.db)
        return self.db.query(BinderCard).filter_by(binder_id=binder.id, collection_item_id=item.id).one()

    def _get(self, binder):
        return get_binder_slots(binder.id, current_user=self.user, db=self.db)

    def _by_pocket(self, payload):
        return {s["slot_index"]: (s["binder_card_id"], s["copy_index"]) for s in payload["slots"]}

    def _put(self, binder, payload, slots, version=None):
        return replace_binder_slots(
            binder.id,
            BinderSlotsReplace(version=version or payload["version"], slots=[BinderSlotItem(**s) for s in slots]),
            current_user=self.user,
            db=self.db,
        )

    def test_lazy_assignment_gives_one_pocket_per_copy(self):
        binder = self._binder()
        a = self._add(binder, self.cards[0], 2)
        b = self._add(binder, self.cards[1], 1)
        self.assertEqual(self.db.query(BinderSlot).count(), 0)

        payload = self._get(binder)

        self.assertEqual(payload["pocket_layout"], 9)
        self.assertEqual(sorted(s["slot_index"] for s in payload["slots"]), [0, 1, 2])
        self.assertEqual(
            {(s["binder_card_id"], s["copy_index"]) for s in payload["slots"]},
            {(a.id, 0), (a.id, 1), (b.id, 0)},
        )
        self.assertEqual(self._get(binder)["version"], payload["version"])

    def test_planned_binder_assigns_ghost_pockets_per_required_copy(self):
        binder = self._binder("wishlist")
        add_card_to_binder(binder.id, self.cards[0].id, required_quantity=3, current_user=self.user, db=self.db)
        self.assertEqual(len(self._get(binder)["slots"]), 3)

    def test_other_users_binder_is_not_found(self):
        binder = self._binder(user=self.other)
        with self.assertRaises(HTTPException) as caught:
            self._get(binder)
        self.assertEqual(caught.exception.status_code, 404)

    def test_put_moves_and_swaps_with_a_new_version(self):
        binder = self._binder()
        a = self._add(binder, self.cards[0])
        b = self._add(binder, self.cards[1])
        payload = self._get(binder)
        by_pocket = self._by_pocket(payload)
        pocket_a = next(i for i, v in by_pocket.items() if v[0] == a.id)

        moved = self._put(binder, payload, [
            {"slot_index": 7, "binder_card_id": a.id, "copy_index": 0},
            {"slot_index": 2, "binder_card_id": b.id, "copy_index": 0},
        ])

        self.assertEqual(self._by_pocket(moved), {7: (a.id, 0), 2: (b.id, 0)})
        self.assertNotEqual(moved["version"], payload["version"])
        self.assertNotEqual(pocket_a, 7)

    def test_put_validation(self):
        binder = self._binder()
        a = self._add(binder, self.cards[0], 2)
        payload = self._get(binder)
        both = [
            {"slot_index": 0, "binder_card_id": a.id, "copy_index": 0},
            {"slot_index": 1, "binder_card_id": a.id, "copy_index": 1},
        ]
        bad_layouts = [
            [both[0]],  # copy left out
            [both[0], {"slot_index": 0, "binder_card_id": a.id, "copy_index": 1}],  # two in one pocket
            [both[0], both[0]],  # placed twice
            [both[0], {"slot_index": -1, "binder_card_id": a.id, "copy_index": 1}],  # negative
            [both[0], {"slot_index": 1, "binder_card_id": a.id, "copy_index": 5}],  # no such copy
            [*both, {"slot_index": 4, "binder_card_id": 9999, "copy_index": 0}],  # foreign card
        ]
        for layout in bad_layouts:
            with self.assertRaises(HTTPException) as caught:
                self._put(binder, payload, layout)
            self.assertEqual(caught.exception.status_code, 422, layout)
        self.assertEqual(self._get(binder)["version"], payload["version"])

    def test_put_cannot_place_another_users_binder_card(self):
        mine = self._binder()
        theirs = self._binder(user=self.other)
        foreign = BinderCard(binder_id=theirs.id, card_id=self.cards[0].id, required_quantity=1)
        self.db.add(foreign)
        self.db.commit()
        payload = self._get(mine)
        with self.assertRaises(HTTPException) as caught:
            self._put(mine, payload, [{"slot_index": 0, "binder_card_id": foreign.id, "copy_index": 0}])
        self.assertEqual(caught.exception.status_code, 422)

    def test_stale_version_is_a_conflict(self):
        binder = self._binder()
        a = self._add(binder, self.cards[0])
        payload = self._get(binder)
        layout = [{"slot_index": 3, "binder_card_id": a.id, "copy_index": 0}]
        self._put(binder, payload, layout)
        with self.assertRaises(HTTPException) as caught:
            self._put(binder, payload, [{"slot_index": 4, "binder_card_id": a.id, "copy_index": 0}])
        self.assertEqual(caught.exception.status_code, 409)

    def test_new_copy_takes_the_first_free_pocket(self):
        binder = self._binder()
        a = self._add(binder, self.cards[0])
        b = self._add(binder, self.cards[1])
        payload = self._get(binder)
        self._put(binder, payload, [
            {"slot_index": 0, "binder_card_id": a.id, "copy_index": 0},
            {"slot_index": 3, "binder_card_id": b.id, "copy_index": 0},
        ])

        c = self._add(binder, self.cards[2])

        self.assertEqual(self._by_pocket(self._get(binder)), {0: (a.id, 0), 1: (c.id, 0), 3: (b.id, 0)})

    def test_raised_quantity_takes_free_pockets(self):
        binder = self._binder()
        a = self._add(binder, self.cards[0], 1, owned=3)
        b = self._add(binder, self.cards[1], 1)
        self._get(binder)

        update_binder_entry(binder.id, a.id, BinderCardUpdate(required_quantity=2), current_user=self.user, db=self.db)

        slots = self._by_pocket(self._get(binder))
        self.assertEqual(len(slots), 3)
        self.assertIn((a.id, 1), slots.values())

    def test_removal_and_lowered_quantity_leave_gaps(self):
        binder = self._binder()
        a = self._add(binder, self.cards[0], 2)
        b = self._add(binder, self.cards[1], 1)
        c = self._add(binder, self.cards[2], 1)
        payload = self._get(binder)
        self._put(binder, payload, [
            {"slot_index": 0, "binder_card_id": a.id, "copy_index": 0},
            {"slot_index": 1, "binder_card_id": a.id, "copy_index": 1},
            {"slot_index": 2, "binder_card_id": b.id, "copy_index": 0},
            {"slot_index": 3, "binder_card_id": c.id, "copy_index": 0},
        ])

        update_binder_entry(binder.id, a.id, BinderCardUpdate(required_quantity=1), current_user=self.user, db=self.db)
        self.assertEqual(self._by_pocket(self._get(binder)), {0: (a.id, 0), 2: (b.id, 0), 3: (c.id, 0)})

        remove_binder_entry(binder.id, b.id, current_user=self.user, db=self.db)
        self.assertEqual(self._by_pocket(self._get(binder)), {0: (a.id, 0), 3: (c.id, 0)})

    def test_compact_closes_gaps_in_order(self):
        binder = self._binder()
        a = self._add(binder, self.cards[0])
        b = self._add(binder, self.cards[1])
        c = self._add(binder, self.cards[2])
        payload = self._get(binder)
        self._put(binder, payload, [
            {"slot_index": 2, "binder_card_id": a.id, "copy_index": 0},
            {"slot_index": 9, "binder_card_id": b.id, "copy_index": 0},
            {"slot_index": 20, "binder_card_id": c.id, "copy_index": 0},
        ])

        result = compact_binder_slots(binder.id, current_user=self.user, db=self.db)

        self.assertEqual(self._by_pocket(result), {0: (a.id, 0), 1: (b.id, 0), 2: (c.id, 0)})

    def test_pocket_layout_change_keeps_slot_indexes(self):
        binder = self._binder()
        a = self._add(binder, self.cards[0])
        payload = self._get(binder)
        self._put(binder, payload, [{"slot_index": 10, "binder_card_id": a.id, "copy_index": 0}])

        response = update_binder(binder.id, BinderUpdate(pocket_layout=4), current_user=self.user, db=self.db)

        self.assertEqual(response.pocket_layout, 4)
        after = self._get(binder)
        self.assertEqual(after["pocket_layout"], 4)
        self.assertEqual(self._by_pocket(after), {10: (a.id, 0)})
        with self.assertRaises(ValueError):
            BinderUpdate(pocket_layout=7)

    def test_csv_round_trip_keeps_pockets(self):
        binder = self._binder("wishlist")
        add_card_to_binder(binder.id, self.cards[0].id, required_quantity=2, current_user=self.user, db=self.db)
        add_card_to_binder(binder.id, self.cards[1].id, required_quantity=1, current_user=self.user, db=self.db)
        a, b = (self.db.query(BinderCard).filter_by(binder_id=binder.id, card_id=c.id).one() for c in self.cards[:2])
        payload = self._get(binder)
        self._put(binder, payload, [
            {"slot_index": 11, "binder_card_id": a.id, "copy_index": 0},
            {"slot_index": 4, "binder_card_id": a.id, "copy_index": 1},
            {"slot_index": 0, "binder_card_id": b.id, "copy_index": 0},
        ])

        response = export_binder_csv(binder.id, current_user=self.user, db=self.db)
        text = asyncio.run(self._body(response))
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual(rows[0].keys() >= {"page", "pocket"}, True)
        by_number = {r["number"]: r for r in rows}
        self.assertEqual((by_number["1"]["page"], by_number["1"]["pocket"]), ("2|1", "3|5"))
        self.assertEqual((by_number["2"]["page"], by_number["2"]["pocket"]), ("1", "1"))

        copy = self._binder("wishlist")
        result = asyncio.run(import_binder_csv(
            copy.id,
            file=UploadFile(filename="b.csv", file=io.BytesIO(text.encode())),
            current_user=self.user,
            db=self.db,
        ))
        self.assertEqual(result["failed"], 0, result)
        entries = {e.card_id: e for e in self.db.query(BinderCard).filter_by(binder_id=copy.id)}
        pockets = self._by_pocket(self._get(copy))
        self.assertEqual(pockets[11][0], entries[self.cards[0].id].id)
        self.assertEqual(pockets[4][0], entries[self.cards[0].id].id)
        self.assertEqual(pockets[0], (entries[self.cards[1].id].id, 0))

    def test_csv_import_rejects_bad_pocket(self):
        binder = self._binder()
        self._own(self.cards[0])
        text = "set_code,number,required_quantity,lang,variant,condition,printing_details,collection_item_id,page,pocket\nsv1,1,1,en,,,,,1,10\n"
        result = asyncio.run(import_binder_csv(
            binder.id, file=UploadFile(filename="b.csv", file=io.BytesIO(text.encode())), current_user=self.user, db=self.db,
        ))
        self.assertEqual(result["failed"], 1)
        self.assertIn("pocket", result["errors"][0])

    def test_csv_without_position_columns_still_imports(self):
        binder = self._binder("wishlist")
        text = "set_code,number,required_quantity,lang\nsv1,1,2,en\n"
        result = asyncio.run(import_binder_csv(
            binder.id, file=UploadFile(filename="b.csv", file=io.BytesIO(text.encode())), current_user=self.user, db=self.db,
        ))
        self.assertEqual(result["added"], 1)
        self.assertEqual(len(self._get(binder)["slots"]), 2)

    def test_deleting_a_binder_removes_its_slots(self):
        binder = self._binder()
        self._add(binder, self.cards[0], 2)
        self._get(binder)
        self.assertEqual(self.db.query(BinderSlot).count(), 2)

        delete_binder(binder.id, current_user=self.user, db=self.db)

        self.assertEqual(self.db.query(BinderSlot).count(), 0)

    def test_decks_have_no_pockets(self):
        deck = self._binder("deck")
        with self.assertRaises(HTTPException) as caught:
            self._get(deck)
        self.assertEqual(caught.exception.status_code, 409)

    @staticmethod
    async def _body(response):
        chunks = []
        async for chunk in response.body_iterator if hasattr(response.body_iterator, "__aiter__") else _aiter(response.body_iterator):
            chunks.append(chunk if isinstance(chunk, str) else chunk.decode())
        return "".join(chunks)


async def _aiter(iterator):
    for chunk in iterator:
        yield chunk


if __name__ == "__main__":
    unittest.main()
