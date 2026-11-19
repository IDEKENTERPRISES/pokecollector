import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class ComposeEnvPassthroughTests(unittest.TestCase):
    """Portainer stack variables reach the backend only when the compose file lists them."""

    def text(self, name):
        path = ROOT / name
        if not path.exists():  # the backend image has no compose files (CI runs the tests inside it)
            self.skipTest(f"{name} is not in this environment")
        return path.read_text(encoding="utf-8")

    def active_lines(self, name):
        return [line.strip() for line in self.text(name).splitlines() if not line.strip().startswith("#")]

    def test_backend_gets_default_currency_from_the_stack_variable(self):
        self.assertIn("DEFAULT_CURRENCY: ${DEFAULT_CURRENCY:-EUR}", self.active_lines("docker-compose.portainer.yml"))

    def test_backend_gets_the_push_presence_window_from_the_stack_variable(self):
        self.assertIn(
            "PUSH_FOREGROUND_WINDOW_SECONDS: ${PUSH_FOREGROUND_WINDOW_SECONDS:-60}",
            self.active_lines("docker-compose.portainer.yml"),
        )

    def test_nonprod_file_does_not_override_them(self):
        lines = "\n".join(self.active_lines("docker-compose.nonprod.yml"))
        self.assertNotIn("DEFAULT_CURRENCY", lines)
        self.assertNotIn("PUSH_FOREGROUND_WINDOW_SECONDS", lines)


if __name__ == "__main__":
    unittest.main()
