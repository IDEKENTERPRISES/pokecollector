"""The display currency a user gets when they have not chosen one.

Set DEFAULT_CURRENCY (for example GBP) to change it for new users and for users with no stored
currency. A stored choice is never touched. An unknown value logs a warning and falls back to EUR.
Prices themselves are still stored in EUR; this is only the display currency.
"""
import logging
import os

logger = logging.getLogger(__name__)

FALLBACK_CURRENCY = "EUR"

# The currencies the exchange-rate provider (Frankfurter) supports.
SUPPORTED_CURRENCIES = frozenset({
    "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "IDR",
    "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "SEK",
    "SGD", "THB", "TRY", "USD", "ZAR",
})

_warned_values: set[str] = set()


def default_currency() -> str:
    """The configured default display currency (upper case), or EUR when unset or invalid."""
    raw = os.environ.get("DEFAULT_CURRENCY")
    if raw is None or not raw.strip():
        return FALLBACK_CURRENCY
    code = raw.strip().upper()
    if code in SUPPORTED_CURRENCIES:
        return code
    if raw not in _warned_values:
        _warned_values.add(raw)
        logger.warning("DEFAULT_CURRENCY=%r is not a supported currency; using %s", raw, FALLBACK_CURRENCY)
    return FALLBACK_CURRENCY
