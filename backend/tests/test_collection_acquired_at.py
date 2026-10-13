"""`acquired_at` is the owner-editable date shown in the collection; `added_at`
stays the immutable record of when the row was created (Recently Added and sync
change detection depend on it)."""

import datetime
import unittest

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.collection import get_collection, update_collection_item
    from database import Base
    from models import Card, CollectionItem, Set, User
    from schemas import CollectionItemResponse, CollectionItemUpdate
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed")
class CollectionAcquiredAtTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.db.add(self.user)
        self.db.add(Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet", lang="en"))
        self.db.add(Card(id="sv1-25_en", tcg_card_id="sv1-25", name="Pikachu", set_id="sv1", number="25", lang="en"))
        self.db.commit()
        self.db.refresh(self.user)
        self.added = datetime.datetime(2025, 3, 4, 21, 15)
        self.item = CollectionItem(
            card_id="sv1-25_en", user_id=self.user.id, quantity=1, lang="en", added_at=self.added,
        )
        self.db.add(self.item)
        self.db.commit()
        self.db.refresh(self.item)

    def tearDown(self):
        self.db.close()

    def _update(self, **fields):
        # Validate through the response schema, as FastAPI does for the endpoint.
        return CollectionItemResponse.model_validate(update_collection_item(
            self.item.id, CollectionItemUpdate(**fields), current_user=self.user, db=self.db,
        ))

    def test_acquired_at_defaults_to_added_at(self):
        response = CollectionItemResponse.model_validate(self.item)
        self.assertEqual(response.acquired_at, self.added)
        self.assertIsNone(self.item.acquired_at)

    def test_owner_can_change_acquired_at_without_touching_added_at(self):
        result = self._update(acquired_at=datetime.datetime(2023, 12, 25))
        self.assertEqual(result.acquired_at, datetime.datetime(2023, 12, 25))
        self.db.refresh(self.item)
        self.assertEqual(self.item.added_at, self.added)
        self.assertEqual(self.item.acquired_at, datetime.datetime(2023, 12, 25))

    def test_date_only_string_is_accepted(self):
        self.assertEqual(
            CollectionItemUpdate(acquired_at="2024-01-15").acquired_at,
            datetime.datetime(2024, 1, 15),
        )

    def test_null_resets_to_added_at(self):
        self._update(acquired_at=datetime.datetime(2023, 12, 25))
        result = self._update(acquired_at=None)
        self.assertEqual(result.acquired_at, self.added)
        self.db.refresh(self.item)
        self.assertIsNone(self.item.acquired_at)

    def test_future_dates_are_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            self._update(acquired_at=datetime.datetime.utcnow() + datetime.timedelta(days=30))
        self.assertEqual(ctx.exception.status_code, 422)

    def test_other_updates_leave_acquired_at_alone(self):
        self._update(acquired_at=datetime.datetime(2023, 12, 25))
        result = self._update(quantity=3)
        self.assertEqual(result.acquired_at, datetime.datetime(2023, 12, 25))

    def test_collection_listing_reports_acquired_at(self):
        self._update(acquired_at=datetime.datetime(2023, 12, 25))
        rows = [CollectionItemResponse.model_validate(row) for row in get_collection(current_user=self.user, db=self.db)]
        self.assertEqual(rows[0].acquired_at, datetime.datetime(2023, 12, 25))


if __name__ == "__main__":
    unittest.main()
