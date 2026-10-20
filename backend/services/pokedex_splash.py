"""The launch splash screen's random Pokémon (``GET /api/pokedex/splash``) and its cache warm-up.

The device keeps a shuffle bag of the species it has shown and sends it as ``seen`` (a base64url
bit set), so nobody sees a repeat until every species has appeared. The server answers from the
species whose extras it already has on disk (services/pokedex_extras.py); only when all of those
have been seen does it fetch a new one from PokéAPI, with a short timeout and a global budget,
falling back to a cached species while PokéAPI is down. The cache therefore grows by about one
species per launch, and the admin warm-up fills it completely.
"""

from __future__ import annotations

import base64
import binascii
import logging
import random
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Callable

import httpx

from services import pokedex_extras, pokedex_images
from services.pokedex import MAX_DEX_ID, pokedex_by_id

logger = logging.getLogger(__name__)

# ── The owner's choices (one-line changes) ───────────────────────────────────
# "flavor": an official Pokédex entry, cleaned up. "data": a sentence built from the numbers.
FACT_SOURCE = "flavor"
# "gen5": Black/White animated sprites for 1–649 and the static sprite after that.
# "showdown": Pokémon Showdown's animated sprites for every species (static where one is missing).
SPRITE_STYLE = "gen5"
# Entries longer than this are used only when a species has nothing shorter.
FACT_MAX_CHARS = 180
SPLASH_LANGUAGES = pokedex_extras.EXTRAS_LANGUAGES

# ── Throttles (the endpoint is public) ───────────────────────────────────────
SPLASH_REQUESTS_PER_WINDOW = 30
SPLASH_WINDOW_SECONDS = 60
# PokéAPI calls made while answering a splash request: the timeout of each call, and how many
# species may be fetched on demand per minute across all clients.
ON_DEMAND_TIMEOUT_SECONDS = 2.5
ON_DEMAND_FETCHES_PER_MINUTE = 20
# 1025 bits in base64url is 172 characters.
SEEN_MAX_CHARS = 200

# ── Admin warm-up ─────────────────────────────────────────────────────────────
WARM_REQUESTS_PER_SECOND = 5


class SlidingWindowThrottle:
    """At most ``limit`` hits per ``window`` seconds for each key. In memory and per process,
    like services/login_throttle.py; a restart clears it."""

    def __init__(self, limit: int, window: float, clock: Callable[[], float] = time.monotonic,
                 max_keys: int = 10_000) -> None:
        self.limit = limit
        self.window = window
        self._clock = clock
        self._max_keys = max_keys
        self._lock = threading.Lock()
        self._hits: dict[str, deque[float]] = {}

    def hit(self, key: str) -> int:
        """Count a hit. Returns 0 when it is allowed, else the seconds until one will be."""
        now = self._clock()
        with self._lock:
            entries = self._hits.setdefault(key, deque())
            while entries and entries[0] <= now - self.window:
                entries.popleft()
            if len(entries) >= self.limit:
                return max(1, int(entries[0] + self.window - now + 0.999))
            entries.append(now)
            if len(self._hits) > self._max_keys:
                for other in list(self._hits):
                    kept = self._hits[other]
                    while kept and kept[0] <= now - self.window:
                        kept.popleft()
                    if not kept:
                        del self._hits[other]
            return 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


splash_throttle = SlidingWindowThrottle(SPLASH_REQUESTS_PER_WINDOW, SPLASH_WINDOW_SECONDS)
on_demand_budget = SlidingWindowThrottle(ON_DEMAND_FETCHES_PER_MINUTE, 60)
_on_demand_lock = threading.Lock()


# ── The shuffle bag on the wire ──────────────────────────────────────────────

def encode_seen(dex_ids) -> str:
    """Bit ``i`` of byte ``k`` is species ``8k + i + 1``; base64url without padding.
    frontend/src/components/splash/shuffleBag.js writes the same format."""
    raw = bytearray((MAX_DEX_ID + 7) // 8)
    for dex_id in dex_ids:
        if 1 <= int(dex_id) <= MAX_DEX_ID:
            index = int(dex_id) - 1
            raw[index // 8] |= 1 << (index % 8)
    return base64.urlsafe_b64encode(bytes(raw)).decode("ascii").rstrip("=")


def decode_seen(value: str | None) -> frozenset[int]:
    if not value:
        return frozenset()
    text = value.strip()[:SEEN_MAX_CHARS]
    try:
        raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        return frozenset()
    seen = set()
    for byte_index, byte in enumerate(raw[: (MAX_DEX_ID + 7) // 8]):
        for bit in range(8):
            if byte >> bit & 1:
                dex_id = byte_index * 8 + bit + 1
                if dex_id <= MAX_DEX_ID:
                    seen.add(dex_id)
    return frozenset(seen)


def normalize_language(value: str | None) -> str:
    base = str(value or "").strip().lower().replace("_", "-").split("-")[0]
    return base if base in SPLASH_LANGUAGES else "en"


# ── Building an entry ────────────────────────────────────────────────────────

def sprite_kind(dex_id: int) -> str:
    """The image kind the splash shows for a species (see SPRITE_STYLE)."""
    if SPRITE_STYLE == "showdown":
        return "showdown"
    return "animated" if dex_id <= pokedex_images.ANIMATED_MAX_DEX_ID else "sprites"


def sprite_url(dex_id: int) -> str:
    kind = sprite_kind(dex_id)
    return f"/api/pokedex/images/{kind}/{dex_id}.{pokedex_images.EXTENSIONS[kind]}"


_TYPE_NAMES = {
    "en": {
        "normal": "Normal", "fire": "Fire", "water": "Water", "grass": "Grass", "electric": "Electric",
        "ice": "Ice", "fighting": "Fighting", "poison": "Poison", "ground": "Ground", "flying": "Flying",
        "psychic": "Psychic", "bug": "Bug", "rock": "Rock", "ghost": "Ghost", "dragon": "Dragon",
        "dark": "Dark", "steel": "Steel", "fairy": "Fairy",
    },
    "de": {
        "normal": "Normal", "fire": "Feuer", "water": "Wasser", "grass": "Pflanze", "electric": "Elektro",
        "ice": "Eis", "fighting": "Kampf", "poison": "Gift", "ground": "Boden", "flying": "Flug",
        "psychic": "Psycho", "bug": "Käfer", "rock": "Gestein", "ghost": "Geist", "dragon": "Drache",
        "dark": "Unlicht", "steel": "Stahl", "fairy": "Fee",
    },
}


def data_fact(entry: dict, extras: dict | None, lang: str) -> str:
    """A fact built from the catalogue and the numbers, for FACT_SOURCE "data" and as the
    fallback when a species has no Pokédex entry yet (or PokéAPI is down)."""
    lang = lang if lang in _TYPE_NAMES else "en"
    names = _TYPE_NAMES[lang]
    name = entry.get(f"name_{lang}") or entry.get("name_en") or ""
    types = "/".join(names.get(t, str(t).title()) for t in entry.get("types") or []) or names["normal"]
    height = (extras or {}).get("height_m")
    if lang == "de":
        text = f"{name} ist ein Pokémon vom Typ {types} aus {entry.get('region')}"
        if height:
            text += f", {height:g} m groß".replace(".", ",")
        return text + "."
    article = "an" if types[:1] in "AEIOU" else "a"
    text = f"{name} is {article} {types}-type Pokémon from {entry.get('region')}"
    if height:
        text += f", {height:g} m tall"
    return text + "."


def pick_fact(entry: dict, extras: dict | None, lang: str, rng: random.Random) -> str:
    if FACT_SOURCE == "flavor" and extras:
        flavor = extras.get("flavor") or {}
        for candidate in dict.fromkeys((lang, "en")):
            texts = [text for text in flavor.get(candidate) or [] if isinstance(text, str) and text]
            if texts:
                short = [text for text in texts if len(text) <= FACT_MAX_CHARS]
                return rng.choice(short or texts)
    return data_fact(entry, extras, lang)


def build_entry(dex_id: int, extras: dict | None, lang: str, rng: random.Random) -> dict:
    entry = pokedex_by_id()[dex_id]
    name_lang = lang if entry.get(f"name_{lang}") else "en"
    genus = (extras or {}).get("genus") or {}
    return {
        "dex_id": dex_id,
        "name": entry.get(f"name_{name_lang}") or entry.get("name_en"),
        "lang": name_lang,
        "generation": entry.get("generation"),
        "region": entry.get("region"),
        "types": list(entry.get("types") or []),
        "weight_kg": (extras or {}).get("weight_kg"),
        "height_m": (extras or {}).get("height_m"),
        "genus": genus.get(name_lang) or genus.get("en"),
        "fact": pick_fact(entry, extras, name_lang, rng),
        "sprite_url": sprite_url(dex_id),
    }


def _fetch_on_demand(dex_id: int) -> dict | None:
    """Fetch one species from PokéAPI within the global budget, or None."""
    if on_demand_budget.hit("pokeapi"):
        return None
    if not _on_demand_lock.acquire(timeout=ON_DEMAND_TIMEOUT_SECONDS):
        return None
    try:
        return pokedex_extras.fetch_extras(dex_id, timeout=ON_DEMAND_TIMEOUT_SECONDS)
    except pokedex_extras.ExtrasUnavailable as exc:
        logger.info("Splash: PokéAPI unavailable for species %s (%s)", dex_id, exc)
    except Exception:  # never fail the splash because of a fetch
        logger.exception("Splash: fetching species %s failed", dex_id)
    finally:
        _on_demand_lock.release()
    return None


def splash_entry(
    *,
    lang: str = "en",
    seen: frozenset[int] = frozenset(),
    requested_id: int | None = None,
    rng: random.Random | None = None,
) -> dict:
    """One species for the splash screen, as the endpoint returns it."""
    rng = rng or random.Random()
    lang = normalize_language(lang)
    catalogue = pokedex_by_id()
    every = [dex_id for dex_id in range(1, MAX_DEX_ID + 1) if dex_id in catalogue]
    unseen = [dex_id for dex_id in every if dex_id not in seen] or every
    cached = pokedex_extras.cached_species_ids()

    if requested_id is not None:
        extras = pokedex_extras.load_extras(requested_id) or _fetch_on_demand(requested_id)
        return build_entry(requested_id, extras, lang, rng)

    pool = [dex_id for dex_id in unseen if dex_id in cached]
    if pool:
        dex_id = rng.choice(pool)
        extras = pokedex_extras.load_extras(dex_id)
        if extras:
            return build_entry(dex_id, extras, lang, rng)

    # Every cached species has been seen on this device: fetch a new one.
    target = rng.choice(unseen)
    extras = pokedex_extras.load_extras(target) or _fetch_on_demand(target)
    if extras:
        return build_entry(target, extras, lang, rng)

    # PokéAPI is down (or the budget is spent): repeat a cached species rather than fail.
    fallback = sorted(cached - {target})
    if fallback:
        dex_id = rng.choice(fallback)
        extras = pokedex_extras.load_extras(dex_id)
        if extras:
            return build_entry(dex_id, extras, lang, rng)
    return build_entry(target, None, lang, rng)


# ── Admin warm-up: every species' extras and sprite, at a polite rate ────────

class SplashCacheWarmer:
    def __init__(self, sleep: Callable[[float], None] = time.sleep) -> None:
        self._sleep = sleep
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._state = {
            "running": False, "done": 0, "total": MAX_DEX_ID, "downloaded": 0, "failed": 0,
            "started_at": None, "finished_at": None,
        }

    def status(self) -> dict:
        with self._lock:
            state = dict(self._state)
        state["cached"] = len(pokedex_extras.cached_species_ids())
        return state

    def start(self) -> dict:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return {**self._state, "cached": len(pokedex_extras.cached_species_ids())}
            self._state.update(
                running=True, done=0, downloaded=0, failed=0,
                started_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                finished_at=None,
            )
            self._thread = threading.Thread(target=self.run, name="pokedex-splash-cache", daemon=True)
            self._thread.start()
        return self.status()

    def _update(self, **changes) -> None:
        with self._lock:
            for key, value in changes.items():
                self._state[key] = self._state[key] + value if key in {"done", "downloaded", "failed"} else value

    def run(self) -> None:
        """Fill the cache synchronously (the thread's target; tests call it directly)."""
        pause = 1 / WARM_REQUESTS_PER_SECOND
        try:
            with httpx.Client(timeout=30.0, headers={"User-Agent": pokedex_extras.USER_AGENT},
                              follow_redirects=True) as client:
                for dex_id in range(1, MAX_DEX_ID + 1):
                    downloaded = False
                    try:
                        if pokedex_extras.load_extras(dex_id) is None:
                            pokedex_extras.fetch_extras(dex_id, client=client)
                            downloaded = True
                            self._sleep(2 * pause)
                        kind = sprite_kind(dex_id)
                        if not pokedex_images.cache_path(kind, dex_id).is_file():
                            pokedex_images.fetch_image(kind, dex_id, client=client)
                            downloaded = True
                            self._sleep(pause)
                    except Exception as exc:  # keep going; the next run retries what failed
                        logger.info("Splash cache: species %s failed (%s)", dex_id, exc)
                        self._update(failed=1)
                        self._sleep(pause)
                    self._update(done=1, downloaded=1 if downloaded else 0)
        finally:
            self._update(running=False, finished_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat())


splash_cache_warmer = SplashCacheWarmer()
