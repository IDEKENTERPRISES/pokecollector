import unittest
from unittest.mock import patch

try:
    from fastapi import APIRouter, Depends

    import main
    from api.auth import get_current_user
    from models import Setting
    from services.social_feature import SOCIAL_SETTING_KEY, require_social, social_enabled
    from test_small_delights import ApiBase

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False
    ApiBase = object


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class SocialSwitchTests(ApiBase):
    def setUp(self):
        super().setUp()
        patcher = patch("api.auth.multi_user_enabled", return_value=True)
        self.multi_user = patcher.start()
        self.addCleanup(patcher.stop)

    def test_off_by_default(self):
        self.assertFalse(social_enabled(self.db))
        self.assertEqual(self.client.get("/api/settings/").json()[SOCIAL_SETTING_KEY], "false")

    def test_an_admin_turns_it_on_for_everyone(self):
        response = self.client.put("/api/settings/", json={SOCIAL_SETTING_KEY: True})
        self.assertEqual(response.status_code, 200)
        self.db.expire_all()
        self.assertEqual(self.db.query(Setting).filter_by(key=SOCIAL_SETTING_KEY).one().value, "true")
        self.assertTrue(social_enabled(self.db))
        main.app.dependency_overrides[get_current_user] = lambda: self.other
        self.assertEqual(self.client.get("/api/settings/").json()[SOCIAL_SETTING_KEY], "true")

    def test_only_an_admin_can_change_it(self):
        main.app.dependency_overrides[get_current_user] = lambda: self.other
        response = self.client.put("/api/settings/", json={SOCIAL_SETTING_KEY: "true"})
        self.assertEqual(response.status_code, 403)
        self.assertFalse(social_enabled(self.db))

    def test_needs_multi_user_mode(self):
        self.db.add(Setting(key=SOCIAL_SETTING_KEY, value="true"))
        self.db.commit()
        self.assertTrue(social_enabled(self.db))
        self.multi_user.return_value = False
        self.assertFalse(social_enabled(self.db))

    def test_social_routes_are_absent_while_off(self):
        router = APIRouter()

        @router.get("/api/social-probe", dependencies=[Depends(require_social)])
        def probe():
            return {"ok": True}

        main.app.include_router(router)
        self.addCleanup(lambda: main.app.router.routes.remove(main.app.router.routes[-1]))
        self.assertEqual(self.client.get("/api/social-probe").status_code, 404)
        self.db.add(Setting(key=SOCIAL_SETTING_KEY, value="true"))
        self.db.commit()
        self.assertEqual(self.client.get("/api/social-probe").json(), {"ok": True})
