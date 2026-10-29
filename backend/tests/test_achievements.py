import datetime
import json
import pathlib
import re
import unittest
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from api.auth import get_current_user
    from api.social import ACHIEVEMENTS
    from database import Base, get_db
    from models import (
        Binder, Card, CollectionItem, NotificationQueue, ProgressState, PushSubscription, Set, Trade, User,
        UserAchievement,
    )
    from services import achievements as ach
    from services import notifications as n
    from services.progress.evaluator import evaluate_user

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _card(card_id, set_id="tst", dex=None, types=None, rarity=None, price=1.0, **extra):
    return Card(
        id=f"{card_id}_en", tcg_card_id=card_id, name=card_id.title(), set_id=set_id, number=card_id[-3:],
        lang="en", is_custom=False, price_trend=price, price_market=price, dex_ids=dex, types=types,
        rarity=rarity, **extra,
    )


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class AchievementTestBase(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(username="ash", hashed_password="x", role="admin", is_active=True)
        self.db.add_all([
            self.user,
            Set(id="tst_en", tcg_set_id="tst", name="Test Set", lang="en", total=2),
            _card("tst-001", dex=[1], types=["Grass"], variants_normal=True, variants_reverse=True),
            _card("tst-002", dex=[4], types=["Fire"], rarity="Ultra Rare", variants_normal=True),
        ])
        self.db.commit()
        self.db.add(PushSubscription(user_id=self.user.id, endpoint="https://web.push.apple.com/x", p256dh="p", auth="a"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def own(self, card_id, variant="Normal"):
        self.db.add(CollectionItem(card_id=f"{card_id}_en", user_id=self.user.id, quantity=1, variant=variant, lang="en"))
        self.db.commit()

    def rows(self):
        self.db.expire_all()
        return {r.achievement_id: r for r in self.db.query(UserAchievement).filter_by(user_id=self.user.id)}

    def queued(self):
        return self.db.query(NotificationQueue).filter_by(user_id=self.user.id, category="badges").all()


class RegistryTests(AchievementTestBase):
    def test_old_badges_are_kept_and_every_entry_is_placed(self):
        entries = ach.registry()
        self.assertEqual([e["id"] for e in entries[:20]], [c["id"] for c in ACHIEVEMENTS])
        ids = [e["id"] for e in entries]
        self.assertEqual(len(ids), len(set(ids)))
        for entry in entries:
            self.assertIn(entry["track"], ach.TRACKS)
            self.assertIn(entry["tier"], ach.TIERS)
            self.assertLessEqual(len(entry["id"]), 64)
        self.assertEqual(len(ach.TRACKS), 8)

    def test_every_entry_has_an_english_name(self):
        for entry in ach.registry():
            self.assertTrue(str(entry.get("name") or "").strip(), f"{entry['id']} has no English name")

    def test_names_match_the_app_strings(self):
        """The push names a badge exactly as the app does (frontend/src/i18n/en.js)."""
        en_js = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "src" / "i18n" / "en.js"
        if not en_js.exists():
            self.skipTest("frontend sources are not part of this checkout")
        text = en_js.read_text(encoding="utf-8")
        start = text.index("\n  achievements: {")
        block = text[start:text.index("\n  },", start)]
        strings = dict(re.findall(r"^\s{4}(\w+): '((?:[^'\\]|\\.)*)',?$", block, flags=re.MULTILINE))
        for entry in ach.registry():
            key = entry["name_key"].split(".", 1)[1]
            self.assertEqual(entry["name"], strings.get(key), entry["id"])

    def test_new_badges_are_marked_with_the_current_version(self):
        self.assertTrue(all(e["since"] == 1 for e in ach.registry()[:20]))
        self.assertTrue(all(e["since"] == ach.REGISTRY_VERSION for e in ach.registry()[20:]))

    def test_track_summary_uses_the_highest_tier(self):
        summary = {row["track"]: row for row in ach.track_summary(["first_card", "collector_50", "dex_10"])}
        self.assertEqual(summary["collection"]["tier"], "silver")
        self.assertEqual(summary["collection"]["earned"], 2)
        self.assertEqual(summary["pokedex"]["tier"], "bronze")
        self.assertIsNone(summary["daily"]["tier"])


class MetricTests(AchievementTestBase):
    def test_metrics_count_species_types_and_flags(self):
        self.own("tst-001", "Reverse Holo")
        self.own("tst-002")
        stats = ach.extra_stats(self.db, self.user.id)
        self.assertEqual(stats["dex_species"], 2)
        self.assertEqual(stats["energy_types"], 2)
        self.assertEqual(stats["holo_flag"], 1)
        self.assertEqual(stats["full_art_flag"], 1)
        self.assertEqual(stats["dex_gen_1"], 2)
        self.assertEqual(stats["dex_gen_2"], 0)

    def test_counts_for_trades_decks_and_scans(self):
        self.db.add(Trade(user_id=self.user.id, trade_date=datetime.date.today()))
        self.db.add(Binder(name="Deck", user_id=self.user.id, binder_type="deck"))
        self.db.add(Binder(name="Plain", user_id=self.user.id, binder_type="collection"))
        self.db.commit()
        stats = ach.extra_stats(self.db, self.user.id)
        self.assertEqual((stats["trades_count"], stats["decks_count"], stats["scans_confirmed"]), (1, 1, 0))

    def test_master_set_needs_every_listed_printing(self):
        self.own("tst-001")
        self.own("tst-002")
        self.assertEqual(ach.extra_stats(self.db, self.user.id)["master_sets"], 0)  # no reverse of 001
        self.own("tst-001", "Reverse Holo")
        self.assertEqual(ach.extra_stats(self.db, self.user.id)["master_sets"], 1)


class UnlockFlowTests(AchievementTestBase):
    def test_first_evaluation_is_silent_for_old_and_new_badges(self):
        self.own("tst-001", "Holo")
        self.own("tst-002")
        evaluate_user(self.db, self.user.id)
        rows = self.rows()
        self.assertIn("first_card", rows)
        self.assertIn("first_holo", rows)
        self.assertTrue(all(r.backfilled and r.seen_at for r in rows.values()))
        self.assertEqual(self.queued(), [])
        self.assertEqual(self.db.get(ProgressState, self.user.id).state_version, ach.REGISTRY_VERSION)

    def test_registry_bump_does_not_flood_existing_installs(self):
        self.own("tst-001")
        evaluate_user(self.db, self.user.id)
        # An install that last evaluated under P1 (registry version 1), already holding qualifying data.
        self.own("tst-002", "Holo")
        state = self.db.get(ProgressState, self.user.id)
        state.state_version = 1
        self.db.commit()

        evaluate_user(self.db, self.user.id)

        rows = self.rows()
        new_ids = {e["id"] for e in ach.registry() if e["since"] > 1}
        for achievement_id in new_ids & set(rows):
            self.assertTrue(rows[achievement_id].backfilled, achievement_id)
            self.assertIsNotNone(rows[achievement_id].seen_at)
        self.assertIn("first_holo", rows)
        # Completing the set is a badge from the old registry, so it still gets its push.
        self.assertEqual([q.subject_key for q in self.queued()], ["badge:first_set"])
        self.assertEqual(self.db.get(ProgressState, self.user.id).state_version, ach.REGISTRY_VERSION)

    def test_a_genuine_unlock_is_unseen_and_queues_one_push(self):
        self.own("tst-001")
        evaluate_user(self.db, self.user.id)
        self.own("tst-002", "Holo")
        evaluate_user(self.db, self.user.id)
        evaluate_user(self.db, self.user.id)

        rows = self.rows()
        self.assertFalse(rows["first_holo"].backfilled)
        self.assertIsNone(rows["first_holo"].seen_at)
        self.assertIsNotNone(rows["first_holo"].notified_at)
        self.assertEqual(sorted(q.subject_key for q in self.queued()),
                         sorted(f"badge:{i}" for i, r in rows.items() if not r.backfilled))
        self.assertEqual(len([q for q in self.queued() if q.subject_key == "badge:first_holo"]), 1)

    def test_push_names_the_badge_and_tier_and_is_skipped_once_seen(self):
        self.own("tst-001")
        evaluate_user(self.db, self.user.id)
        self.own("tst-002", "Holo")
        evaluate_user(self.db, self.user.id)
        now = datetime.datetime.utcnow() + datetime.timedelta(days=1, hours=12)
        with patch.object(n, "in_quiet_hours", return_value=False), patch.object(n, "_send") as send:
            n.flush_due(self.db, now)
        self.assertTrue(send.called)
        notes = [json.loads(call.args[2])["notification"] for call in send.call_args_list]
        self.assertTrue(all(note["title"] == "Badge unlocked" and note["navigate"] == "/achievements" for note in notes))
        self.assertIn("First Shine · Bronze", [note["body"] for note in notes])

        # Seen before the push goes out: nothing is sent.
        self.db.query(NotificationQueue).delete()
        self.db.query(UserAchievement).filter_by(achievement_id="first_holo").update({"seen_at": now})
        self.db.add(NotificationQueue(
            user_id=self.user.id, category="badges", subject_key="badge:first_holo", send_after=now,
            created_at=now,
        ))
        self.db.commit()
        with patch.object(n, "in_quiet_hours", return_value=False), patch.object(n, "_send") as send:
            n.flush_due(self.db, now)
        send.assert_not_called()

    def test_push_is_content_light_when_details_are_switched_off(self):
        from models import UserSetting

        self.db.add(UserSetting(user_id=self.user.id, key="notify_show_details", value="false"))
        self.db.commit()
        self.own("tst-001")
        evaluate_user(self.db, self.user.id)
        self.own("tst-002", "Holo")
        evaluate_user(self.db, self.user.id)
        now = datetime.datetime.utcnow() + datetime.timedelta(days=1, hours=12)
        with patch.object(n, "in_quiet_hours", return_value=False), patch.object(n, "_send") as send:
            n.flush_due(self.db, now)
        self.assertTrue(send.called)
        for call in send.call_args_list:
            payload = call.args[2]
            self.assertIn("You earned a badge", payload)
            self.assertNotIn("holo", payload.lower())

    def test_queued_badge_row_keeps_the_badge_id(self):
        self.own("tst-001")
        evaluate_user(self.db, self.user.id)
        self.own("tst-002", "Holo")
        evaluate_user(self.db, self.user.id)
        details = {q.subject_key: q.details for q in self.queued()}
        self.assertEqual(details["badge:first_holo"], {"badge_id": "first_holo"})

    def test_badges_push_respects_the_user_switch(self):
        from models import UserSetting

        self.db.add(UserSetting(user_id=self.user.id, key="notify_badges", value="false"))
        self.db.commit()
        self.own("tst-001")
        evaluate_user(self.db, self.user.id)
        self.own("tst-002", "Holo")
        evaluate_user(self.db, self.user.id)
        self.assertEqual(self.queued(), [])
        self.assertIsNone(self.rows()["first_holo"].notified_at)


class UnlockApiTests(AchievementTestBase):
    def setUp(self):
        super().setUp()

        def override_db():
            session = self.Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_db
        main.app.dependency_overrides[get_current_user] = lambda: self.user
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)
        self.own("tst-001")
        evaluate_user(self.db, self.user.id)
        self.own("tst-002", "Holo")
        evaluate_user(self.db, self.user.id)

    def test_unseen_then_seen(self):
        unseen = self.client.get("/api/progress/unlocks/unseen").json()["unlocks"]
        ids = [u["id"] for u in unseen]
        self.assertIn("first_holo", ids)
        self.assertEqual(unseen[0]["tier"] in ach.TIERS, True)
        self.assertIn("track", unseen[0])

        one = self.client.post("/api/progress/unlocks/seen", json={"ids": ["first_holo"]})
        self.assertEqual(one.json(), {"marked": 1, "quests_marked": 0})
        self.assertNotIn("first_holo", [u["id"] for u in self.client.get("/api/progress/unlocks/unseen").json()["unlocks"]])

        rest = self.client.post("/api/progress/unlocks/seen", json={}).json()["marked"]
        self.assertEqual(rest, len(ids) - 1)
        self.assertEqual(self.client.get("/api/progress/unlocks/unseen").json(), {"unlocks": [], "quests": []})

    def test_achievements_response_adds_tier_track_and_dates_and_keeps_old_fields(self):
        data = self.client.get(f"/api/social/achievements/{self.user.id}").json()
        self.assertEqual(data["total"], len(ach.registry()))
        first = next(a for a in data["achievements"] if a["id"] == "first_card")
        for key in ("name_key", "description_key", "badge_id", "unlocked", "progress", "target"):
            self.assertIn(key, first)
        self.assertEqual((first["tier"], first["track"]), ("bronze", "collection"))
        self.assertIsNotNone(first["unlocked_at"])
        holo = next(a for a in data["achievements"] if a["id"] == "first_holo")
        self.assertTrue(holo["unlocked"])
        self.assertIsNone(holo["seen_at"])
        self.assertEqual(len(data["tracks"]), 8)

    def test_other_users_do_not_see_seen_state(self):
        other = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add(other)
        self.db.commit()
        main.app.dependency_overrides[get_current_user] = lambda: other
        data = self.client.get(f"/api/social/achievements/{self.user.id}").json()
        self.assertTrue(all(a["seen_at"] is None for a in data["achievements"]))
        self.assertEqual(self.client.get("/api/progress/unlocks/unseen").json(), {"unlocks": [], "quests": []})


if __name__ == "__main__":
    unittest.main()
