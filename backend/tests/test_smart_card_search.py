import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.cards import search_cards
    from database import Base
    from models import Card, Set, Setting, User
    from services import card_search_query as query_service

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


def _card(card_id, name, set_id, number, **extra):
    return Card(id=f"{card_id}_en", tcg_card_id=card_id, name=name, set_id=set_id, number=number,
                lang="en", is_custom=False, **extra)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class SmartCardSearchTests(unittest.TestCase):
    def setUp(self):
        query_service.reset_card_names_cache()
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en"),
            Set(id="pbl_en", tcg_set_id="pbl", name="Phantom Blaze", abbreviation="PBL", lang="en"),
            Set(id="viv_en", tcg_set_id="viv", name="Vivid Voltage", abbreviation="VIV", lang="en"),
            Set(id="mew_en", tcg_set_id="mew", name="Scarlet Violet 151", abbreviation="MEW", lang="en"),
            _card("pbl-117", "Morpeko", "pbl", "117"),
            _card("pbl-040", "Morpeko V", "pbl", "040"),
            _card("pbl-003", "Pikachu", "pbl", "003"),
            _card("viv-117", "Morpeko", "viv", "117"),
            _card("viv-080", "Morpeko", "viv", "080"),
            _card("mew-151", "Mew ex", "mew", "151"),
            _card("mew-047", "Mew", "mew", "047"),
            _card("viv-tg12", "Eevee", "viv", "TG12"),
            _card("viv-sv1", "Charizard ex", "viv", "001"),
            _card("pbl-gh", "Gengar", "pbl", "010"),
            _card("pbl-gg", "Gangar", "pbl", "011"),
        ])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _search(self, q, **kwargs):
        return search_cards(q=q, type_filter=None, lang="en", db=self.db, current_user=self.user, **kwargs)

    def _ids(self, q, **kwargs):
        return sorted(card["id"] for card in self._search(q, **kwargs)["data"])

    # ── The owner's four examples ───────────────────────────────────────────
    def test_pokemon_and_number(self):
        ids = self._ids("Morpeko 117")
        self.assertEqual(ids, ["pbl-117_en", "viv-117_en"])

    def test_pokemon_and_set_code(self):
        self.assertEqual(self._ids("Morpeko PBL"), ["pbl-040_en", "pbl-117_en"])

    def test_misspelt_name_is_corrected_and_reported(self):
        result = self._search("Morbeko")
        self.assertEqual(sorted(c["id"] for c in result["data"]), ["pbl-040_en", "pbl-117_en", "viv-080_en", "viv-117_en"])
        self.assertEqual(result["corrected"], {"from": "Morbeko", "to": "Morpeko"})

    def test_pokemon_number_and_set(self):
        self.assertEqual(self._ids("Morpeko 117 PBL"), ["pbl-117_en"])

    # ── Other orders and formats ────────────────────────────────────────────
    def test_any_token_order(self):
        for q in ("PBL 117 Morpeko", "117 Morpeko PBL", "pbl morpeko 117", "Morpeko pbl 117"):
            self.assertEqual(self._ids(q), ["pbl-117_en"], q)

    def test_multi_word_set_name_and_accent_case(self):
        self.assertEqual(self._ids("morpeko vivid voltage"), ["viv-080_en", "viv-117_en"])
        self.assertEqual(self._ids("Morpeko 117 Vivid Voltage"), ["viv-117_en"])

    def test_tcg_set_id_and_unique_prefix(self):
        self.assertEqual(self._ids("Morpeko viv 080"), ["viv-080_en"])
        self.assertEqual(self._ids("Morpeko vivid"), ["viv-080_en", "viv-117_en"])

    def test_number_formats(self):
        for number in ("117", "0117", "117/185"):
            self.assertEqual(self._ids(f"Morpeko {number} PBL"), ["pbl-117_en"], number)
        self.assertEqual(self._ids("Morpeko 40 PBL"), ["pbl-040_en"])
        self.assertEqual(self._ids("Eevee TG12"), ["viv-tg12_en"])

    def test_set_code_and_number_still_works(self):
        self.assertEqual(self._ids("PBL 117"), ["pbl-117_en"])
        self.assertEqual(self._ids("MEW 151"), ["mew-151_en"])

    def test_pokemon_name_that_is_also_a_set_code_stays_a_name(self):
        self.assertEqual(self._ids("Mew"), ["mew-047_en", "mew-151_en"])
        self.assertEqual(self._ids("Mew ex"), ["mew-151_en"])

    def test_plain_name_search_is_unchanged(self):
        self.assertEqual(self._ids("morpeko v"), ["pbl-040_en"])
        self.assertNotIn("corrected", self._search("Morpeko"))

    # ── Fuzzy limits ─────────────────────────────────────────────────────────
    def test_no_correction_when_the_query_already_matches(self):
        result = self._search("Mew")
        self.assertNotIn("corrected", result)

    def test_short_names_are_never_corrected(self):
        self.assertEqual(self._search("Mow")["data"], [])
        self.assertNotIn("corrected", self._search("Mow"))

    def test_no_correction_to_a_name_with_no_results(self):
        # Bulbasaur is the closest species, but this catalogue has no Bulbasaur card.
        result = self._search("Bulbasuar")
        self.assertEqual(result["data"], [])
        self.assertNotIn("corrected", result)

    def test_unrelated_text_is_not_corrected(self):
        result = self._search("Zzzzzzzz")
        self.assertEqual(result["data"], [])
        self.assertNotIn("corrected", result)

    def test_tie_gives_no_correction(self):
        # A species and a card name tie: the species wins.
        self.assertEqual(query_service.suggest_names(self.db, "Gongar"), ["Gengar"])
        # Two card names that are not species tie: no correction at all.
        self.db.add_all([_card("pbl-zx", "Zorbix", "pbl", "020"), _card("pbl-za", "Zorbax", "pbl", "021")])
        self.db.commit()
        self.assertEqual(query_service.suggest_names(self.db, "Zorbex"), [])

    def test_edit_limits(self):
        self.assertEqual(query_service.max_edits(4), 0)
        self.assertEqual(query_service.max_edits(5), 1)
        self.assertEqual(query_service.max_edits(7), 1)
        self.assertEqual(query_service.max_edits(8), 2)
        self.assertEqual(query_service.edit_distance("morpeko", "morbeko", 1), 1)
        self.assertEqual(query_service.edit_distance("morpeko", "mropeko", 1), 1)  # transposition
        self.assertGreater(query_service.edit_distance("morpeko", "pikachu", 1), 1)

    def test_correction_keeps_set_and_number_filters(self):
        result = self._search("Morbeko 117 PBL")
        self.assertEqual([c["id"] for c in result["data"]], ["pbl-117_en"])
        self.assertEqual(result["corrected"], {"from": "Morbeko", "to": "Morpeko"})

    def test_numbers_and_set_tokens_are_never_corrected(self):
        result = self._search("Morpeko 999 PBL")
        self.assertEqual(result["data"], [])
        self.assertNotIn("corrected", result)


if __name__ == "__main__":
    unittest.main()
