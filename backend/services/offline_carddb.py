"""Offline card database: compact per-set card data and prices with content hashes.

The app downloads this once per language and refreshes only what changed (design: F13).
  - one payload per set: the set row and its cards' static data (no prices, no user data),
  - one prices file per language, with its own hash, because price syncs run every 30 minutes
    and must not change any set's hash.
Everything is built once, kept in memory as gzip bytes and rebuilt after a card or price sync
(`invalidate`), never per request. The hash of a payload is the SHA-256 of its uncompressed JSON,
used as the ETag.
"""

from __future__ import annotations

import functools
import gzip
import hashlib
import json
import logging
import os
import threading
import time

from sqlalchemy import func
from sqlalchemy.orm import Session

from models import Card, Set
from services.card_visibility import get_configured_sync_languages
from services.digital_sets import digital_sets_enabled

logger = logging.getLogger(__name__)

# Safety net next to the explicit invalidation after syncs, for cards added by live lookups.
CACHE_TTL_SECONDS = 15 * 60
FORMAT_VERSION = 1

SET_FIELDS = (
    "id", "tcg_set_id", "name", "series", "series_id", "abbreviation", "release_date",
    "total", "images_symbol", "images_logo", "is_digital", "lang",
)

CARD_FIELDS = (
    "id", "tcg_card_id", "name", "set_id", "number", "rarity", "types", "supertype", "subtypes",
    "hp", "artist", "stage", "evolve_from", "suffix", "trainer_type", "energy_type", "card_effect",
    "regulation_mark", "attacks", "abilities", "weaknesses", "resistances", "dex_ids",
    "pokedex_entry_ids", "cardmarket_products", "retreat", "images_small", "images_large",
    "image_source_lang", "data_source_lang", "is_digital", "lang",
    "variants_normal", "variants_reverse", "variants_holo", "variants_first_edition",
)

PRICE_FIELDS = (
    "price_market", "price_low", "price_mid", "price_high", "price_trend",
    "price_avg1", "price_avg7", "price_avg30",
    "price_market_holo", "price_low_holo", "price_trend_holo",
    "price_avg1_holo", "price_avg7_holo", "price_avg30_holo",
    "price_tcg_normal_low", "price_tcg_normal_mid", "price_tcg_normal_high", "price_tcg_normal_market",
    "price_tcg_reverse_low", "price_tcg_reverse_mid", "price_tcg_reverse_market",
    "price_tcg_holo_low", "price_tcg_holo_mid", "price_tcg_holo_market",
)


def offline_carddb_enabled() -> bool:
    """OFFLINE_CARD_DB_ENABLED (default true) switches the whole feature off for everyone."""
    value = os.getenv("OFFLINE_CARD_DB_ENABLED")
    if value is None or not value.strip():
        return True
    return value.strip().lower() not in {"0", "false", "no", "off"}


def _json_bytes(value) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, sort_keys=True).encode("utf-8")


def _pack(value) -> dict:
    raw = _json_bytes(value)
    return {
        "hash": hashlib.sha256(raw).hexdigest(),
        "gzip": gzip.compress(raw, compresslevel=6, mtime=0),
        "raw_bytes": len(raw),
    }


def _release_date(value) -> str | None:
    return value.isoformat() if hasattr(value, "isoformat") else (str(value) if value else None)


def _set_row(set_obj: Set) -> dict:
    row = {field: getattr(set_obj, field, None) for field in SET_FIELDS}
    row["release_date"] = _release_date(row["release_date"])
    return row


def _round_price(value):
    return None if value is None else round(float(value), 4)


class _LanguageEntry:
    def __init__(self):
        self.built_at = 0.0
        self.signature: tuple = ()
        self.sets: dict[str, dict] = {}
        self.card_count = 0
        self.lang_hash = ""
        self.prices: dict | None = None
        self.prices_built_at = 0.0
        self.prices_updated_at: str | None = None


_lock = threading.RLock()
_entries: dict[str, _LanguageEntry] = {}
_static_version = 0
_price_version = 0
_entry_versions: dict[str, tuple[int, int]] = {}


def invalidate(*, static: bool = True, prices: bool = True) -> None:
    """Rebuild lazily after a card sync (static) or a price sync (prices)."""
    global _static_version, _price_version
    with _lock:
        if static:
            _static_version += 1
        if prices:
            _price_version += 1


def reset() -> None:
    """Forget everything (tests)."""
    global _static_version, _price_version
    with _lock:
        _entries.clear()
        _entry_versions.clear()
        _static_version = 0
        _price_version = 0


def with_invalidation(*, static: bool, prices: bool):
    """Decorator for the sync entry points: invalidate once the sync has finished (or failed part-way)."""
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            finally:
                invalidate(static=static, prices=prices)
        return wrapper
    return decorator


def _visible_sets(db: Session, lang: str) -> list[Set]:
    query = db.query(Set).filter(Set.lang == lang)
    if not digital_sets_enabled(db):
        query = query.filter(Set.is_digital == False)  # noqa: E712
    return query.order_by(Set.id.asc()).all()


def _card_query(db: Session, lang: str):
    query = db.query(Card).filter(Card.is_custom == False, Card.lang == lang)  # noqa: E712
    if not digital_sets_enabled(db):
        query = query.filter(Card.is_digital == False)  # noqa: E712
    return query


def _signature(db: Session, lang: str) -> tuple:
    cards = _card_query(db, lang).with_entities(func.count(Card.id)).scalar() or 0
    sets = db.query(func.count(Set.id)).filter(Set.lang == lang).scalar() or 0
    return (cards, sets)


def _build_static(db: Session, lang: str, entry: _LanguageEntry) -> None:
    sets = _visible_sets(db, lang)
    by_set: dict[str, list] = {}
    for card in _card_query(db, lang).order_by(Card.id.asc()).yield_per(2000):
        by_set.setdefault(card.set_id, []).append([getattr(card, field) for field in CARD_FIELDS])

    packed: dict[str, dict] = {}
    card_total = 0
    for set_obj in sets:
        tcg_id = set_obj.tcg_set_id or set_obj.id
        rows = by_set.get(tcg_id, [])
        payload = {
            "v": FORMAT_VERSION,
            "set": _set_row(set_obj),
            "fields": list(CARD_FIELDS),
            "cards": rows,
        }
        item = _pack(payload)
        item["cards_count"] = len(rows)
        packed[set_obj.id] = item
        card_total += len(rows)
    entry.sets = packed
    entry.card_count = card_total
    entry.lang_hash = hashlib.sha256(
        "|".join(f"{set_id}:{packed[set_id]['hash']}" for set_id in sorted(packed)).encode()
    ).hexdigest()


def _build_prices(db: Session, lang: str, entry: _LanguageEntry) -> None:
    columns = [getattr(Card, field) for field in PRICE_FIELDS]
    rows = []
    newest = None
    query = _card_query(db, lang).with_entities(Card.id, Card.last_price_sync_success_at, *columns).order_by(Card.id.asc())
    for card_id, synced_at, *values in query.yield_per(5000):
        if all(value is None for value in values):
            continue
        rows.append([card_id, *(_round_price(value) for value in values)])
        if synced_at and (newest is None or synced_at > newest):
            newest = synced_at
    entry.prices_updated_at = _release_date(newest)
    payload = {"v": FORMAT_VERSION, "fields": list(PRICE_FIELDS), "rows": rows}
    entry.prices = _pack(payload)
    entry.prices["rows_count"] = len(rows)


def _entry(db: Session, lang: str, *, need_prices: bool) -> _LanguageEntry:
    with _lock:
        entry = _entries.get(lang)
        versions = (_static_version, _price_version)
        now = time.monotonic()
        stale_static = (
            entry is None
            or _entry_versions.get(lang, (-1, -1))[0] != versions[0]
            or now - entry.built_at > CACHE_TTL_SECONDS
        )
        if not stale_static and entry is not None:
            # A live lookup can add cards between syncs; the counts catch that cheaply.
            stale_static = entry.signature != _signature(db, lang)
        if stale_static:
            entry = _LanguageEntry()
            _build_static(db, lang, entry)
            entry.signature = _signature(db, lang)
            entry.built_at = now
            _entries[lang] = entry
            _entry_versions[lang] = (versions[0], -1)
        assert entry is not None
        if need_prices and (
            entry.prices is None
            or _entry_versions.get(lang, (-1, -1))[1] != versions[1]
            or now - entry.prices_built_at > CACHE_TTL_SECONDS
        ):
            _build_prices(db, lang, entry)
            entry.prices_built_at = now
            _entry_versions[lang] = (_entry_versions[lang][0], versions[1])
        return entry


def languages(db: Session) -> list[str]:
    return list(get_configured_sync_languages(db))


def manifest(db: Session, lang: str | None = None) -> dict:
    result: dict = {"enabled": True, "format": FORMAT_VERSION, "languages": {}}
    for code in ([lang] if lang else languages(db)):
        entry = _entry(db, code, need_prices=True)
        result["languages"][code] = {
            "hash": entry.lang_hash,
            "prices_hash": entry.prices["hash"],
            "prices_updated_at": entry.prices_updated_at,
            "prices_bytes": len(entry.prices["gzip"]),
            "set_count": len(entry.sets),
            "card_count": entry.card_count,
            "bytes": sum(len(item["gzip"]) for item in entry.sets.values()),
            "sets": [
                {"id": set_id, "hash": item["hash"], "cards": item["cards_count"], "bytes": len(item["gzip"])}
                for set_id, item in sorted(entry.sets.items())
            ],
        }
    return result


def set_payload(db: Session, lang: str, set_id: str) -> dict | None:
    return _entry(db, lang, need_prices=False).sets.get(set_id)


def prices_payload(db: Session, lang: str) -> dict:
    entry = _entry(db, lang, need_prices=True)
    assert entry.prices is not None
    return entry.prices
