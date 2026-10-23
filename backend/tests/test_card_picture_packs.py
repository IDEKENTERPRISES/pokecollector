import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from api.auth import get_current_user
    from database import Base, get_db
    from models import Card, ImageCache, Set, Setting, User
    from services import card_picture_packs, offline_carddb

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _card(card_id, set_id, number, lang="en", small="https://img.example/{id}/low.webp"):
    return Card(id=f"{card_id}_{lang}", tcg_card_id=card_id, name=card_id, set_id=set_id, number=number,
                lang=lang, is_custom=False, images_small=small.format(id=card_id) if small else None)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class CardPicturePackTests(unittest.TestCase):
    def setUp(self):
        offline_carddb.reset()
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.admin = User(username="oak", hashed_password="x", role="admin", is_active=True)
        self.db.add_all([
            self.user, self.admin,
            Setting(key="tcgdex_sync_languages", value="en"),
            Set(id="pbl_en", tcg_set_id="pbl", name="Phantom Blaze", series="Mega", lang="en", total=3),
            _card("pbl-001", "pbl", "001"),
            _card("pbl-002", "pbl", "002"),
            _card("pbl-003", "pbl", "003"),
            _card("pbl-004", "pbl", "004", small=None),  # no catalogue picture: not part of the pack
        ])
        self.db.commit()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.object(card_picture_packs, "PACK_DIR", Path(self.tmp.name))
        patcher.start()
        self.addCleanup(patcher.stop)
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
        self.addCleanup(offline_carddb.reset)

    def _cache(self, card_id, data=b"img", content_type="image/webp"):
        card = self.db.query(Card).filter(Card.id == f"{card_id}_en").one()
        key = card_picture_packs.card_image_key(card.id, card.images_small)
        self.db.add(ImageCache(image_key=key, data=data, content_type=content_type))
        self.db.commit()

    def test_pack_holds_the_cached_pictures_and_lists_the_missing_ones(self):
        self._cache("pbl-001", b"AAAA", "image/webp")
        self._cache("pbl-002", b"BB", "image/png")
        response = self.client.get("/api/offline/carddb/pictures/en/pbl_en")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-pack-missing"], "1")
        parsed = card_picture_packs.unpack(response.content)
        self.assertEqual(parsed["items"], [("pbl-001_en", "image/webp", b"AAAA"), ("pbl-002_en", "image/png", b"BB")])
        self.assertEqual(parsed["missing"], ["pbl-003_en"])

    def test_etag_gives_304_until_a_picture_changes(self):
        self._cache("pbl-001")
        first = self.client.get("/api/offline/carddb/pictures/en/pbl_en")
        etag = first.headers["etag"]
        again = self.client.get("/api/offline/carddb/pictures/en/pbl_en", headers={"If-None-Match": etag})
        self.assertEqual(again.status_code, 304)
        self._cache("pbl-002")
        changed = self.client.get("/api/offline/carddb/pictures/en/pbl_en", headers={"If-None-Match": etag})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["etag"], etag)

    def test_a_replaced_picture_changes_the_etag(self):
        self._cache("pbl-001", b"old")
        etag = self.client.get("/api/offline/carddb/pictures/en/pbl_en").headers["etag"]
        row = self.db.query(ImageCache).one()
        row.data = b"newer bytes"
        self.db.commit()
        self.assertNotEqual(self.client.get("/api/offline/carddb/pictures/en/pbl_en").headers["etag"], etag)

    def test_built_packs_are_kept_on_disk_and_old_ones_dropped(self):
        self._cache("pbl-001")
        self.client.get("/api/offline/carddb/pictures/en/pbl_en")
        self.assertEqual(len(list(Path(self.tmp.name).glob("en/pbl_en-*.pack"))), 1)
        self._cache("pbl-002")
        self.client.get("/api/offline/carddb/pictures/en/pbl_en")
        self.assertEqual(len(list(Path(self.tmp.name).glob("en/pbl_en-*.pack"))), 1)

    def test_unknown_set_and_language(self):
        self.assertEqual(self.client.get("/api/offline/carddb/pictures/en/nope").status_code, 404)
        self.assertEqual(self.client.get("/api/offline/carddb/pictures/ja/pbl_en").status_code, 404)

    def test_flag_off_hides_everything(self):
        with patch.dict(os.environ, {"OFFLINE_CARD_DB_ENABLED": "false"}):
            self.assertEqual(self.client.get("/api/offline/carddb/pictures/en/pbl_en").status_code, 404)
            self.current = self.admin
            self.assertEqual(self.client.post("/api/offline/carddb/pictures-prepare").status_code, 404)

    def test_only_admins_can_start_or_read_the_warm_up(self):
        self.assertEqual(self.client.post("/api/offline/carddb/pictures-prepare").status_code, 403)
        self.assertEqual(self.client.get("/api/offline/carddb/pictures-prepare").status_code, 403)
        self.current = self.admin
        with patch.object(card_picture_packs.card_picture_warmer, "start", return_value={"running": True}) as start:
            response = self.client.post("/api/offline/carddb/pictures-prepare")
        self.assertEqual(response.json(), {"running": True})
        start.assert_called_once()
        self.assertIn("running", self.client.get("/api/offline/carddb/pictures-prepare").json())

    def test_status_after_a_restart_reports_the_real_counts(self):
        self._cache("pbl-001")
        self._cache("pbl-002")
        card_picture_packs.reset_counts_cache()
        self.current = self.admin
        restarted = card_picture_packs.CardPictureWarmer()  # a fresh process: no run state at all
        with patch.object(card_picture_packs, "card_picture_warmer", restarted):
            status = self.client.get("/api/offline/carddb/pictures-prepare").json()
        self.assertFalse(status["running"])
        self.assertEqual((status["total"], status["cached"], status["missing"]), (3, 2, 1))

    def test_counts_are_kept_for_a_few_seconds(self):
        self._cache("pbl-001")
        card_picture_packs.reset_counts_cache()
        clock = [100.0]
        first = card_picture_packs.picture_counts(self.db, now=lambda: clock[0])
        self._cache("pbl-002")
        clock[0] += 1
        self.assertEqual(card_picture_packs.picture_counts(self.db, now=lambda: clock[0]), first)
        clock[0] += card_picture_packs.COUNTS_TTL_SECONDS
        self.assertEqual(card_picture_packs.picture_counts(self.db, now=lambda: clock[0])["cached"], 2)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class CardPictureWarmerTests(unittest.TestCase):
    def setUp(self):
        offline_carddb.reset()
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        db = self.Session()
        db.add_all([
            Setting(key="tcgdex_sync_languages", value="en"),
            Set(id="pbl_en", tcg_set_id="pbl", name="Phantom Blaze", series="Mega", lang="en", total=3),
            *[_card(f"pbl-00{n}", "pbl", f"00{n}") for n in range(1, 5)],
        ])
        db.commit()
        db.close()
        self.addCleanup(offline_carddb.reset)

    def _fetch_into(self, fetched, fail=()):
        def fetch(db, key, url):
            if any(marker in key for marker in fail):
                raise RuntimeError("upstream")
            fetched.append(key)
            db.add(ImageCache(image_key=key, data=b"x", content_type="image/webp"))
            db.commit()
        return fetch

    def test_throttles_to_five_requests_a_second_and_skips_what_is_cached(self):
        pauses = []
        warmer = card_picture_packs.CardPictureWarmer(sleep=pauses.append)
        db = self.Session()
        card = db.query(Card).filter(Card.id == "pbl-001_en").one()
        db.add(ImageCache(image_key=card_picture_packs.card_image_key(card.id, card.images_small), data=b"x"))
        db.commit()
        db.close()
        fetched = []
        warmer.run(session_factory=self.Session, fetch=self._fetch_into(fetched))
        self.assertEqual(len(fetched), 3)
        self.assertEqual(pauses, [0.2, 0.2, 0.2])
        state = warmer.status()
        self.assertEqual((state["total"], state["cached"], state["done"], state["running"]), (4, 4, 3, False))

    def test_a_second_run_resumes_with_only_the_failures(self):
        warmer = card_picture_packs.CardPictureWarmer(sleep=lambda _s: None)
        first = []
        warmer.run(session_factory=self.Session, fetch=self._fetch_into(first, fail=("pbl-003",)))
        self.assertEqual(warmer.status()["failed"], 1)
        second = []
        warmer.start(background=False)
        warmer.run(session_factory=self.Session, fetch=self._fetch_into(second))
        self.assertEqual(len(second), 1)
        self.assertIn("pbl-003", second[0])

    def test_single_flight(self):
        gate = threading.Event()
        started = []
        warmer = card_picture_packs.CardPictureWarmer(sleep=lambda _s: None)

        def slow_run(**_kwargs):
            started.append(1)
            gate.wait(5)
            warmer._set(running=False)

        with patch.object(warmer, "run", side_effect=slow_run):
            warmer.start()
            second = warmer.start()
            gate.set()
            warmer._thread.join(5)
        self.assertTrue(second["running"])
        self.assertEqual(len(started), 1)

    def test_gives_up_when_the_upstream_keeps_failing(self):
        warmer = card_picture_packs.CardPictureWarmer(sleep=lambda _s: None)
        with patch.object(card_picture_packs, "MAX_CONSECUTIVE_FAILURES", 2):
            warmer.run(session_factory=self.Session, fetch=self._fetch_into([], fail=("card:",)))
        state = warmer.status()
        self.assertEqual(state["failed"], 2)
        self.assertEqual(state["error"], "upstream unavailable")

    def test_does_nothing_when_the_feature_is_off(self):
        warmer = card_picture_packs.CardPictureWarmer(sleep=lambda _s: None)
        fetched = []
        with patch.dict(os.environ, {"OFFLINE_CARD_DB_ENABLED": "0"}):
            warmer.run(session_factory=self.Session, fetch=self._fetch_into(fetched))
        self.assertEqual(fetched, [])

    def test_schedule_after_sync_can_be_switched_off(self):
        with patch.dict(os.environ, {"CARD_PICTURE_PREWARM_AFTER_SYNC": "false"}), \
                patch.object(card_picture_packs.card_picture_warmer, "start") as start:
            card_picture_packs.schedule_after_sync()
        start.assert_not_called()


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class CardSyncWarmupHookTests(unittest.TestCase):
    def test_one_full_sync_schedules_the_warm_up_once(self):
        from services import sync_service

        wrappers = 0
        fn = sync_service.perform_full_sync
        while fn is not None:
            if fn.__dict__.get("prewarms_card_pictures"):
                wrappers += 1
            fn = getattr(fn, "__wrapped__", None)
        self.assertEqual(wrappers, 1)

        calls = []
        wrapped = sync_service._prewarm_card_pictures_after(lambda: "done")
        with patch.object(card_picture_packs, "schedule_after_sync", side_effect=lambda: calls.append(1)):
            self.assertEqual(wrapped(), "done")
        self.assertEqual(len(calls), 1)
