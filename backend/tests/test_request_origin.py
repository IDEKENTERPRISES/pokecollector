import unittest

from services.request_origin import (
    is_cross_site_unauthenticated_write as blocked,
    parse_allowed_origins,
)


class RequestOriginTests(unittest.TestCase):
    def test_empty_config_allows_no_origins(self):
        self.assertEqual(parse_allowed_origins(None), [])
        self.assertEqual(parse_allowed_origins(" , "), [])

    def test_origins_are_trimmed(self):
        self.assertEqual(
            parse_allowed_origins("https://a.example/, https://b.example"),
            ["https://a.example", "https://b.example"],
        )

    def test_foreign_site_write_without_token_is_blocked(self):
        headers = {"origin": "https://evil.example", "host": "pokecollector.lan"}
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            self.assertTrue(blocked(method, headers, []), method)

    def test_same_site_write_is_allowed_regardless_of_port(self):
        headers = {"origin": "http://pokecollector.lan:3000", "host": "pokecollector.lan"}
        self.assertFalse(blocked("POST", headers, []))

    def test_ipv6_host(self):
        headers = {"origin": "http://[::1]:3000", "host": "[::1]:3000"}
        self.assertFalse(blocked("POST", headers, []))

    def test_null_origin_is_blocked(self):
        self.assertTrue(blocked("POST", {"origin": "null", "host": "x"}, []))

    def test_reads_are_not_blocked(self):
        headers = {"origin": "https://evil.example", "host": "pokecollector.lan"}
        self.assertFalse(blocked("GET", headers, []))
        self.assertFalse(blocked("OPTIONS", headers, []))

    def test_native_clients_without_origin_are_allowed(self):
        self.assertFalse(blocked("POST", {"host": "pokecollector.lan"}, []))

    def test_bearer_token_requests_are_allowed(self):
        headers = {"origin": "https://evil.example", "host": "x", "authorization": "Bearer t"}
        self.assertFalse(blocked("POST", headers, []))

    def test_configured_origin_is_allowed(self):
        headers = {"origin": "https://app.example", "host": "api.example"}
        self.assertFalse(blocked("POST", headers, ["https://app.example"]))
        self.assertTrue(blocked("POST", headers, ["https://other.example"]))


if __name__ == "__main__":
    unittest.main()
