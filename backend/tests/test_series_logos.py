import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api import images
    from api.sets import get_sets
    from database import Base
    from models import ImageCache, Set, Setting, User, UserSetting
    from schemas import SetBase
    from services.pokemon_api import parse_set_for_db

    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


class _FakeResponse:
    def __init__(self, content=b"img", content_type="image/webp"):
        self.content = content
        self.headers = {"content-type": content_type}

    def raise_for_status(self):
        pass


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class ParseSeriesTests(unittest.TestCase):
    def test_enriched_series_id_and_logo_are_stored(self):
        parsed = parse_set_for_db({
            "id": "sv01",
            "name": "Scarlet & Violet",
            "logo": "https://assets.tcgdex.net/en/sv/sv01/logo",
            "_series_id": "sv",
            "_series_name": "Scarlet & Violet",
            "_series_logo": "https://assets.tcgdex.net/univ/sv/logo",
        })

        self.assertEqual(parsed["series_id"], "sv")
        self.assertEqual(parsed["series_logo"], "https://assets.tcgdex.net/univ/sv/logo.webp")
        self.assertEqual(parsed["images_logo"], "https://assets.tcgdex.net/en/sv/sv01/logo.webp")

    def test_series_id_falls_back_to_embedded_serie(self):
        parsed = parse_set_for_db({"id": "sv01", "name": "X", "serie": {"id": "sv", "name": "Scarlet & Violet"}})

        self.assertEqual(parsed["series_id"], "sv")
        self.assertIsNone(parsed["series_logo"])

    def test_no_series_data_gives_none(self):
        parsed = parse_set_for_db({"id": "sv01", "name": "X"})

        self.assertIsNone(parsed["series_id"])
        self.assertIsNone(parsed["series_logo"])


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class SeriesLogoTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="ash", hashed_password="x", role="admin", is_active=True)
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en"),
        ])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _set(self, id, name, **kwargs):
        row = Set(id=id, tcg_set_id=id.split("_")[0], name=name, lang="en", **kwargs)
        self.db.add(row)
        self.db.commit()
        return row

    def _fetch(self, set_id, image_type="series"):
        with patch.object(images._client, "get", return_value=_FakeResponse()) as get:
            resp = images.get_set_image(set_id, image_type, db=self.db)
        return resp, get

    def test_sets_list_returns_series_id_not_logo(self):
        self.db.add(UserSetting(user_id=self.user.id, key="language", value="en"))
        self._set("sv01_en", "Scarlet & Violet", series="Scarlet & Violet", series_id="sv", series_logo="https://x/logo.webp")

        sets = get_sets(db=self.db, current_user=self.user, refresh=False, lang=None)
        payload = SetBase.model_validate(sets[0]).model_dump()

        self.assertEqual(payload["series_id"], "sv")
        self.assertNotIn("series_logo", payload)

    def test_series_image_is_fetched_and_cached_once_per_series(self):
        self._set("sv01_en", "Scarlet & Violet", series="Scarlet & Violet", series_id="sv", series_logo="https://x/sv/logo.webp")
        self._set("sv02_en", "Paldea Evolved", series="Scarlet & Violet", series_id="sv", series_logo="https://x/sv/logo.webp")

        resp, get = self._fetch("sv01_en")
        self.assertEqual(resp.body, b"img")
        self.assertEqual(resp.media_type, "image/webp")
        get.assert_called_once_with("https://x/sv/logo.webp")
        self.assertEqual(self.db.query(ImageCache).filter(ImageCache.image_key == "series:en:sv").count(), 1)

        resp, get = self._fetch("sv02_en")
        self.assertEqual(resp.body, b"img")
        get.assert_not_called()

    def test_falls_back_to_namesake_set_logo(self):
        self._set("sv02_en", "Paldea Evolved", series="Scarlet & Violet", series_id="sv",
                  release_date="2023-06-09", images_logo="https://x/sv02.webp")
        self._set("sv01_en", "Scarlet & Violet", series="Scarlet & Violet", series_id="sv",
                  release_date="2023-03-31", images_logo="https://x/sv01.webp")

        _, get = self._fetch("sv02_en")

        get.assert_called_once_with("https://x/sv01.webp")

    def test_falls_back_to_newest_set_logo_without_namesake(self):
        self._set("swsh1_en", "Sword & Shield", series="Sword & Shield Era", series_id="swsh",
                  release_date="2020-02-07", images_logo="https://x/old.webp")
        self._set("swsh2_en", "Rebel Clash", series="Sword & Shield Era", series_id="swsh",
                  release_date="2020-05-01", images_logo="https://x/new.webp")
        self._set("swsh0_en", "No Logo", series="Sword & Shield Era", series_id="swsh",
                  release_date="2021-01-01")

        _, get = self._fetch("swsh0_en")

        get.assert_called_once_with("https://x/new.webp")

    def test_falls_back_to_wordmark_without_any_logo(self):
        self._set("sv01_en", "Scarlet & Violet", series="Scarlet & Violet", series_id="sv")

        resp, get = self._fetch("sv01_en")

        self.assertEqual(resp.media_type, "image/svg+xml")
        get.assert_not_called()

    def _german_series_without_logos(self):
        self.db.query(Setting).filter(Setting.key == "tcgdex_sync_languages").one().value = "en,de"
        self._set("sm1_en", "Sun & Moon", series="Sun & Moon", series_id="sm", release_date="2017-02-03",
                  series_logo="https://x/en/sm/logo.webp", images_logo="https://x/en/sm1.webp")
        row = self._set("sm1_de", "Sonne & Mond", series="Sonne & Mond", series_id="sm", release_date="2017-02-03")
        row.lang = "de"
        self.db.commit()

    def test_series_without_local_logo_borrows_the_english_series_logo(self):
        # TCGdex has no German logo for older series; the sets' logo route already borrows
        # the English one, so the series tile must too instead of showing the wordmark.
        self._german_series_without_logos()

        resp, get = self._fetch("sm1_de")

        self.assertEqual(resp.media_type, "image/webp")
        get.assert_called_once_with("https://x/en/sm/logo.webp")

    def test_cross_language_borrowing_follows_the_setting(self):
        self._german_series_without_logos()
        self.db.add(Setting(key="cross_language_image_fallback", value="false"))
        self.db.commit()

        resp, get = self._fetch("sm1_de")

        self.assertEqual(resp.media_type, "image/svg+xml")
        get.assert_not_called()

    def test_series_wordmark_is_never_cached(self):
        # The service worker keeps any 200 image it sees, so a stand-in must not be cacheable.
        self._set("sv01_en", "Scarlet & Violet", series="Scarlet & Violet", series_id="sv")
        resp, _ = self._fetch("sv01_en")
        self.assertEqual(resp.headers["cache-control"], "no-store")

        self.db.query(Set).update({Set.series_logo: "https://x/logo.webp"})
        self.db.commit()
        with patch.object(images._client, "get", side_effect=RuntimeError("down")):
            resp = images.get_set_image("sv01_en", "series", db=self.db)
        self.assertEqual(resp.headers["cache-control"], "no-store")

        logo = images.get_set_image("sv01_en", "logo", db=self.db)
        self.assertEqual(logo.headers["cache-control"], "public, max-age=86400")

    def test_upstream_failure_serves_wordmark(self):
        self._set("sv01_en", "Scarlet & Violet", series="Scarlet & Violet", series_id="sv", series_logo="https://x/logo.webp")

        with patch.object(images._client, "get", side_effect=RuntimeError("down")):
            resp = images.get_set_image("sv01_en", "series", db=self.db)

        self.assertEqual(resp.media_type, "image/svg+xml")

    def test_series_image_respects_set_visibility(self):
        row = self._set("sv01_de", "Karmesin", series="KP", series_id="sv", series_logo="https://x/logo.webp")
        row.lang = "de"
        self.db.commit()

        with self.assertRaises(HTTPException) as ctx:
            images.get_set_image("sv01_de", "series", db=self.db)

        self.assertEqual(ctx.exception.status_code, 404)

    def test_unknown_image_type_is_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            images.get_set_image("sv01_en", "banner", db=self.db)

        self.assertEqual(ctx.exception.status_code, 400)

    def test_logo_and_symbol_are_unchanged(self):
        self._set("sv01_en", "Scarlet & Violet", series_id="sv", series_logo="https://x/series.webp",
                  images_logo="https://x/logo.webp", images_symbol="https://x/symbol.webp")

        _, get = self._fetch("sv01_en", "logo")
        get.assert_called_once_with("https://x/logo.webp")
        _, get = self._fetch("sv01_en", "symbol")
        get.assert_called_once_with("https://x/symbol.webp")
        keys = {row.image_key for row in self.db.query(ImageCache)}
        self.assertEqual(keys, {"set:sv01_en:logo", "set:sv01_en:symbol"})


if __name__ == "__main__":
    unittest.main()
