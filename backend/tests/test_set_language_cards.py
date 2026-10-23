import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.cards import search_cards
    from api.sets import get_set_checklist
    from database import Base
    from models import Card, Set, Setting, User

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


def _card(tcg_id, number, name, lang, **extra):
    return Card(
        id=f"{tcg_id}-{number}_{lang}",
        tcg_card_id=f"{tcg_id}-{number}",
        name=name,
        set_id=tcg_id,
        number=number,
        lang=lang,
        is_custom=False,
        **extra,
    )


@unittest.skipUnless(
    API_TEST_DEPS_AVAILABLE,
    "FastAPI/SQLAlchemy are not installed in this lightweight test environment",
)
class SetsInTwoLanguagesTests(unittest.TestCase):
    """The same tcg_set_id exists once per language (sv1_en / sv1_ja): nothing may mix them."""

    def setUp(self):
        self.engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en,ja"),
            Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet & Violet", lang="en", total=2),
            Set(id="sv1_ja", tcg_set_id="sv1", name="スカーレットex", lang="ja", total=2),
            _card("sv1", "1", "Sprigatito", "en"),
            _card("sv1", "2", "Floragato", "en"),
            _card("sv1", "1", "ニャオハ", "ja"),
            _card("sv1", "2", "ニャローテ", "ja"),
        ])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _search_ids(self, **kwargs):
        result = search_cards(type_filter=None, db=self.db, current_user=self.user, **kwargs)
        return sorted(card["id"] for card in result["data"])

    def test_search_by_a_composite_set_id_returns_only_that_languages_cards(self):
        self.assertEqual(self._search_ids(set_id="sv1_ja", lang="all"), ["sv1-1_ja", "sv1-2_ja"])
        self.assertEqual(self._search_ids(set_id="sv1_en", lang="all"), ["sv1-1_en", "sv1-2_en"])

    def test_search_by_the_bare_catalogue_id_still_spans_the_languages(self):
        self.assertEqual(
            self._search_ids(set_id="sv1", lang="all"),
            ["sv1-1_en", "sv1-1_ja", "sv1-2_en", "sv1-2_ja"],
        )

    def test_set_cards_relationship_stays_in_the_sets_language(self):
        ja = self.db.query(Set).filter(Set.id == "sv1_ja").one()
        en = self.db.query(Set).filter(Set.id == "sv1_en").one()
        self.assertEqual(sorted(card.id for card in ja.cards), ["sv1-1_ja", "sv1-2_ja"])
        self.assertEqual(sorted(card.id for card in en.cards), ["sv1-1_en", "sv1-2_en"])

    def test_checklist_of_a_japanese_set_has_only_japanese_rows(self):
        result = get_set_checklist("sv1_ja", db=self.db, current_user=self.user)
        self.assertEqual(result["set"]["lang"], "ja")
        self.assertEqual(sorted(card["id"] for card in result["cards"]), ["sv1-1_ja", "sv1-2_ja"])
        self.assertTrue(all(card["lang"] == "ja" for card in result["cards"]))
        self.assertTrue(all(card["set_ref"]["id"] == "sv1_ja" for card in result["cards"]))


if __name__ == "__main__":
    unittest.main()
