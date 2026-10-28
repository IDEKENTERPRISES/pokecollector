import os
import unittest
from unittest.mock import patch

try:
    from services import telegram

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "httpx is not installed")
class TelegramSwitchTests(unittest.TestCase):
    def test_on_when_unset_or_blank(self):
        with patch.dict(os.environ, {}):
            os.environ.pop("TELEGRAM_ENABLED", None)
            self.assertTrue(telegram.telegram_enabled())
        for value in ("", "  ", "true", "1", "yes", "on", "TRUE"):
            with patch.dict(os.environ, {"TELEGRAM_ENABLED": value}):
                self.assertTrue(telegram.telegram_enabled(), repr(value))

    def test_off_values(self):
        for value in ("0", "false", "no", "off", "False", " OFF "):
            with patch.dict(os.environ, {"TELEGRAM_ENABLED": value}):
                self.assertFalse(telegram.telegram_enabled(), repr(value))

    def test_switched_off_sends_nothing(self):
        env = {"TELEGRAM_ENABLED": "false", "TELEGRAM_BOT_TOKEN": "token", "TELEGRAM_CHAT_ID": "chat"}
        with patch.dict(os.environ, env), patch.object(telegram.httpx, "Client") as client:
            self.assertFalse(telegram.send_message("hello"))
            self.assertFalse(telegram.send_price_alert("Pikachu", 2.0, 1.5, "above"))
        client.assert_not_called()

    def test_switched_on_sends(self):
        env = {"TELEGRAM_ENABLED": "true", "TELEGRAM_BOT_TOKEN": "token", "TELEGRAM_CHAT_ID": "chat"}
        with patch.dict(os.environ, env), patch.object(telegram.httpx, "Client") as client:
            self.assertTrue(telegram.send_message("hello"))
        client.return_value.__enter__.return_value.post.assert_called_once()


if __name__ == "__main__":
    unittest.main()
