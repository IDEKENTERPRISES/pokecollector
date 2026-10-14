import unittest

from services.client_ip import client_ip_from
from services.login_throttle import (
    IP_MAX_FAILURES,
    IP_WINDOW_SECONDS,
    USER_MAX_FAILURES,
    LoginThrottle,
)

try:
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import main
    from database import Base, get_db
    from models import User
    from services.auth import hash_password
    from services.login_throttle import login_throttle
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


class ClientIpTests(unittest.TestCase):
    def test_public_peer_ignores_forwarding_headers(self):
        self.assertEqual(client_ip_from("8.8.8.9", "4.4.4.1", "4.4.4.2"), "8.8.8.9")

    def test_proxy_peer_uses_the_address_the_proxy_appended(self):
        # nginx appended the client it saw; anything before it is client-supplied.
        self.assertEqual(client_ip_from("172.20.0.3", "6.6.6.6, 8.8.8.9", None), "8.8.8.9")

    def test_chain_through_two_proxies_skips_our_own_hops(self):
        self.assertEqual(client_ip_from("172.20.0.3", "8.8.8.9, 172.20.0.2", None), "8.8.8.9")

    def test_spoofed_public_prefix_cannot_replace_a_real_public_client(self):
        self.assertEqual(client_ip_from("10.0.0.5", "1.2.3.4, 5.6.7.8", None), "5.6.7.8")

    def test_lan_only_traffic_uses_the_originating_hop(self):
        self.assertEqual(client_ip_from("172.20.0.3", "192.168.1.50", None), "192.168.1.50")
        self.assertEqual(client_ip_from("172.20.0.3", "192.168.1.50, 172.20.0.2", None), "192.168.1.50")

    def test_falls_back_to_real_ip_then_peer(self):
        self.assertEqual(client_ip_from("172.20.0.3", None, "8.8.8.9"), "8.8.8.9")
        self.assertEqual(client_ip_from("172.20.0.3", None, None), "172.20.0.3")

    def test_garbage_headers_are_ignored(self):
        self.assertEqual(client_ip_from("172.20.0.3", "not-an-ip, , 8.8.8.9", "also bad"), "8.8.8.9")
        self.assertEqual(client_ip_from("172.20.0.3", "nope", "nope"), "172.20.0.3")

    def test_ipv6(self):
        self.assertEqual(client_ip_from("::1", "2001:db8::1", None), "2001:db8::1")

    def test_missing_peer(self):
        self.assertEqual(client_ip_from(None, "8.8.8.9", None), "unknown")


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class LoginThrottleTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.throttle = LoginThrottle(clock=self.clock)

    def test_not_throttled_below_the_limit(self):
        for _ in range(IP_MAX_FAILURES - 1):
            self.throttle.record_failure("1.1.1.1", "ash")
        self.assertEqual(self.throttle.retry_after("1.1.1.1", "ash"), 0)

    def test_one_clients_failures_do_not_lock_out_another(self):
        for _ in range(IP_MAX_FAILURES):
            self.throttle.record_failure("1.1.1.1", "ash")
        self.assertGreater(self.throttle.retry_after("1.1.1.1", "ash"), 0)
        self.assertEqual(self.throttle.retry_after("2.2.2.2", "misty"), 0)

    def test_window_expires(self):
        for _ in range(IP_MAX_FAILURES):
            self.throttle.record_failure("1.1.1.1", "ash")
        self.clock.now += IP_WINDOW_SECONDS + 1
        self.assertEqual(self.throttle.retry_after("1.1.1.1", "ash"), 0)

    def test_retry_after_counts_down(self):
        for _ in range(IP_MAX_FAILURES):
            self.throttle.record_failure("1.1.1.1", "ash")
        first = self.throttle.retry_after("1.1.1.1", "ash")
        self.clock.now += 100
        self.assertLess(self.throttle.retry_after("1.1.1.1", "ash"), first)

    def test_guessing_one_account_from_many_addresses_is_limited(self):
        for index in range(USER_MAX_FAILURES):
            self.throttle.record_failure(f"9.9.9.{index}", "Ash")
        self.assertGreater(self.throttle.retry_after("8.8.8.8", "ash"), 0)
        self.assertEqual(self.throttle.retry_after("8.8.8.8", "misty"), 0)

    def test_success_clears_the_username_counter(self):
        for _ in range(USER_MAX_FAILURES - 1):
            self.throttle.record_failure("9.9.9.9", "ash")
        self.throttle.record_success("ash")
        self.assertEqual(self.throttle._user_failures.get("ash"), None)


def client_from(peer):
    """A TestClient whose requests arrive from the given TCP peer address."""
    async def app_with_peer(scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            scope = {**scope, "client": peer}
        await main.app(scope, receive, send)

    return TestClient(app_with_peer)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI is not installed")
class LoginRateLimitIntegrationTests(unittest.TestCase):
    PROXY = ("172.20.0.3", 5000)

    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        db = Session()
        db.add(User(username="ash", hashed_password=hash_password("correct horse battery"), role="trainer", is_active=True))
        db.commit()
        db.close()

        def override_get_db():
            session = Session()
            try:
                yield session
            finally:
                session.close()

        main.app.dependency_overrides[get_db] = override_get_db
        self.addCleanup(main.app.dependency_overrides.clear)
        login_throttle.reset()
        self.addCleanup(login_throttle.reset)
        self.client = client_from(self.PROXY)

    def _login(self, password, forwarded_for):
        return self.client.post(
            "/api/auth/login",
            data={"username": "ash", "password": password},
            headers={"X-Forwarded-For": forwarded_for},
        )

    def test_one_users_wrong_passwords_do_not_block_another_user_behind_the_same_proxy(self):
        for _ in range(IP_MAX_FAILURES):
            self.assertEqual(self._login("wrong", "8.8.8.1").status_code, 401)
        blocked = self._login("wrong", "8.8.8.1")
        self.assertEqual(blocked.status_code, 429)
        self.assertIn("Retry-After", blocked.headers)

        # A different person (different forwarded address) can still sign in.
        ok = self._login("correct horse battery", "8.8.8.2")
        self.assertEqual(ok.status_code, 200)

    def test_successful_logins_are_not_counted_against_the_limit(self):
        for _ in range(IP_MAX_FAILURES + 5):
            self.assertEqual(self._login("correct horse battery", "8.8.8.1").status_code, 200)

    def test_spoofing_a_forwarding_header_from_a_public_peer_does_not_help(self):
        client = client_from(("8.8.8.50", 4000))
        for index in range(IP_MAX_FAILURES):
            response = client.post(
                "/api/auth/login",
                data={"username": f"nobody{index}", "password": "x"},
                headers={"X-Forwarded-For": f"4.4.4.{index}"},
            )
            self.assertEqual(response.status_code, 401)
        response = client.post(
            "/api/auth/login",
            data={"username": "another", "password": "x"},
            headers={"X-Forwarded-For": "4.4.4.200"},
        )
        self.assertEqual(response.status_code, 429)

    def test_general_api_limit_is_per_client_not_shared(self):
        # Behind the proxy every request shares one TCP peer; without keying on the
        # forwarded client address, one busy client would exhaust everyone's budget.
        main.limiter.reset()
        self.addCleanup(main.limiter.reset)
        busy = {"X-Forwarded-For": "8.8.4.4"}
        statuses = {self.client.get("/api/health", headers=busy).status_code for _ in range(320)}
        self.assertEqual(statuses, {200, 429})

        quiet = self.client.get("/api/health", headers={"X-Forwarded-For": "1.1.1.1"})
        self.assertEqual(quiet.status_code, 200)


if __name__ == "__main__":
    unittest.main()
