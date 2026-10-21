"""The Pokémon of the day for the launch splash and Home (``GET /api/pokedex/splash``).

Every user and device sees the same Pokémon all day: the server takes it from a fixed shuffled
order of all 1025 species, indexed by the date the client sends (its local date), so nothing
repeats for 1025 days. Whether it is shiny is decided per day as well, so the splash and Home
always agree.

The species' extras and facts (services/pokedex_extras.py, services/pokedex_facts.py) and its
sprite are cached on the server. After each request the next days are made complete in the
background, so the device's pre-fetch of tomorrow never waits for PokéAPI; the admin warm-up
fills everything at a polite rate.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections import deque
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Callable

import httpx

from services import pokedex_extras, pokedex_facts, pokedex_images
from services.pokedex import MAX_DEX_ID, pokedex_by_id

logger = logging.getLogger(__name__)

# ── The owner's choices (one-line changes) ───────────────────────────────────
# "showdown": Pokémon Showdown's animated sprites for every species, falling back to the official
# artwork and then the static sprite (14 species have no Showdown sprite yet).
# "gen5": Black/White's animated pixel sprites up to 649 and the static sprite after that.
SPRITE_SET = "showdown"
# One day in SHINY_ODDS has a shiny Pokémon of the day.
SHINY_ODDS = 64
# The fixed order: changing the seed or the epoch changes every future day's Pokémon.
DAILY_EPOCH = date(2026, 10, 21)
DAILY_SEED = 0x9C0115
SHINY_SALT = "pokecollector-shiny"
SPLASH_LANGUAGES = pokedex_extras.EXTRAS_LANGUAGES
FIRST_DATE = date(2020, 1, 1)
LAST_DATE = date(2100, 12, 31)

# ── Throttles (the endpoint is public) ───────────────────────────────────────
SPLASH_REQUESTS_PER_WINDOW = 30
SPLASH_WINDOW_SECONDS = 60
# PokéAPI calls made while a request waits: the timeout of each call, and how many species may
# be fetched on demand per minute across all clients.
ON_DEMAND_TIMEOUT_SECONDS = 2.5
ON_DEMAND_FETCHES_PER_MINUTE = 20

# ── Background work ──────────────────────────────────────────────────────────
WARM_REQUESTS_PER_SECOND = 5
PREWARM_DAYS = 2  # tomorrow and the day after
PREWARM_RETRY_SECONDS = 600


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


def _client(timeout: float = 30.0) -> httpx.Client:
    return httpx.Client(timeout=timeout, headers={"User-Agent": pokedex_extras.USER_AGENT}, follow_redirects=True)


# ── The Pokémon of the day ───────────────────────────────────────────────────

def _mulberry32(seed: int):
    """A tiny seeded generator, written out so the order never depends on a library version."""
    state = seed & 0xFFFFFFFF
    while True:
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        value = ((state ^ (state >> 15)) * (state | 1)) & 0xFFFFFFFF
        value = ((value + (((value ^ (value >> 7)) * (value | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF) ^ value
        yield ((value ^ (value >> 14)) & 0xFFFFFFFF) / 4294967296


@lru_cache(maxsize=1)
def daily_order() -> tuple[int, ...]:
    """Every species once, in a fixed shuffled order (Fisher-Yates)."""
    order = list(range(1, MAX_DEX_ID + 1))
    random_numbers = _mulberry32(DAILY_SEED)
    for index in range(len(order) - 1, 0, -1):
        other = int(next(random_numbers) * (index + 1))
        order[index], order[other] = order[other], order[index]
    return tuple(order)


def species_for_date(day: date) -> int:
    return daily_order()[(day - DAILY_EPOCH).days % MAX_DEX_ID]


def shiny_for_date(day: date) -> bool:
    digest = hashlib.sha256(f"{SHINY_SALT}:{day.isoformat()}".encode()).digest()
    return int.from_bytes(digest[:8], "big") % SHINY_ODDS == 0


def parse_day(value: str | None) -> date:
    """The client's local date (YYYY-MM-DD), else today in UTC. Raises ValueError."""
    if not value:
        return datetime.now(timezone.utc).date()
    day = date.fromisoformat(value)
    if not FIRST_DATE <= day <= LAST_DATE:
        raise ValueError("date out of range")
    return day


def normalize_language(value: str | None) -> str:
    base = str(value or "").strip().lower().replace("_", "-").split("-")[0]
    return base if base in SPLASH_LANGUAGES else "en"


# ── Sprites ──────────────────────────────────────────────────────────────────

# (image kind, how the client draws it): "animated" and "artwork" are scaled smoothly, "pixel"
# by whole numbers with crisp pixels.
_CHAINS = {
    ("showdown", False): (("showdown", "animated"), ("artwork", "artwork"), ("sprites", "pixel")),
    ("showdown", True): (("showdown-shiny", "animated"), ("artwork-shiny", "artwork"), ("sprites-shiny", "pixel")),
    ("gen5", False): (("animated", "pixel"), ("sprites", "pixel")),
    ("gen5", True): (("sprites-shiny", "pixel"), ("sprites", "pixel")),
}
# What the image route serves when the requested kind is missing upstream.
FALLBACKS = {
    "showdown": ("artwork", "sprites"),
    "showdown-shiny": ("artwork-shiny", "sprites-shiny"),
    "animated": ("sprites",),
    "artwork-shiny": ("sprites-shiny",),
}


def sprite_chain(dex_id: int, shiny: bool) -> tuple[tuple[str, str], ...]:
    chain = _CHAINS[(SPRITE_SET, bool(shiny))]
    if SPRITE_SET == "gen5" and dex_id > pokedex_images.ANIMATED_MAX_DEX_ID:
        chain = tuple(step for step in chain if step[0] != "animated")
    return chain


def image_url(kind: str, dex_id: int) -> str:
    return f"/api/pokedex/images/{kind}/{dex_id}.{pokedex_images.EXTENSIONS[kind]}"


def resolve_sprite(dex_id: int, shiny: bool) -> tuple[str, str]:
    """The first image in the chain that is cached or not known to be missing. An unknown one is
    returned optimistically; the image route falls back along the chain if it turns out missing."""
    chain = sprite_chain(dex_id, shiny)
    for kind, style in chain:
        if pokedex_images.cache_path(kind, dex_id).is_file() or not pokedex_images.is_known_missing(kind, dex_id):
            return image_url(kind, dex_id), style
    kind, style = chain[-1]
    return image_url(kind, dex_id), style


def fetch_sprite(dex_id: int, shiny: bool, *, client: httpx.Client, pause: Callable[[], None] | None = None):
    for kind, _style in sprite_chain(dex_id, shiny):
        cached = pokedex_images.cache_path(kind, dex_id).is_file()
        path = pokedex_images.fetch_image(kind, dex_id, client=client)
        if pause and not cached:
            pause()
        if path:
            return path
    return None


# ── The entry ────────────────────────────────────────────────────────────────

def build_entry(dex_id: int, extras: dict | None, lang: str, *, day: date, shiny: bool) -> dict:
    entry = pokedex_by_id()[dex_id]
    name_lang = lang if entry.get(f"name_{lang}") else "en"
    genus = (extras or {}).get("genus") or {}
    sprite_url, sprite_style = resolve_sprite(dex_id, shiny)
    return {
        "date": day.isoformat(),
        "dex_id": dex_id,
        "name": entry.get(f"name_{name_lang}") or entry.get("name_en"),
        "lang": name_lang,
        "generation": entry.get("generation"),
        "region": entry.get("region"),
        "types": list(entry.get("types") or []),
        "genus": genus.get(name_lang) or genus.get("en"),
        "height_m": (extras or {}).get("height_m"),
        "weight_kg": (extras or {}).get("weight_kg"),
        "shiny": bool(shiny),
        "facts": pokedex_facts.build_facts(dex_id, extras, name_lang, seed=day.isoformat()),
        "sprite_url": sprite_url,
        "sprite_style": sprite_style,
    }


def _fetch_on_demand(dex_id: int) -> dict | None:
    """The quick bundle for one species within the global budget, or None."""
    if on_demand_budget.hit("pokeapi"):
        return None
    if not _on_demand_lock.acquire(timeout=ON_DEMAND_TIMEOUT_SECONDS):
        return None
    try:
        with _client(ON_DEMAND_TIMEOUT_SECONDS) as client:
            return pokedex_facts.fetch_bundle(dex_id, client=client, depth="quick", timeout=ON_DEMAND_TIMEOUT_SECONDS)
    except pokedex_extras.ExtrasUnavailable as exc:
        logger.info("Splash: PokéAPI unavailable for species %s (%s)", dex_id, exc)
    except Exception:  # never fail the splash because of a fetch
        logger.exception("Splash: fetching species %s failed", dex_id)
    finally:
        _on_demand_lock.release()
    return None


def splash_entry(*, day: date, lang: str = "en", requested_id: int | None = None, shiny: bool | None = None) -> dict:
    """The Pokémon of ``day`` (or ``requested_id``, for the DEV preview), as the endpoint returns it."""
    lang = normalize_language(lang)
    dex_id = requested_id or species_for_date(day)
    is_shiny = shiny_for_date(day) if shiny is None else bool(shiny)
    extras = pokedex_extras.load_extras(dex_id)
    if not pokedex_extras.is_current(extras):
        extras = _fetch_on_demand(dex_id) or extras
    return build_entry(dex_id, extras, lang, day=day, shiny=is_shiny)


# ── Pre-warming the next days ────────────────────────────────────────────────

_prewarm_lock = threading.Lock()
_prewarm_attempts: dict[date, float] = {}
_complete: set[tuple[int, bool]] = set()


def _is_complete(dex_id: int, shiny: bool) -> bool:
    if (dex_id, shiny) in _complete:
        return True
    extras = pokedex_extras.load_extras(dex_id)
    done = (
        pokedex_extras.is_current(extras)
        and not pokedex_facts.bundle_requests(extras, depth="full")
        and any(pokedex_images.cache_path(kind, dex_id).is_file() for kind, _style in sprite_chain(dex_id, shiny))
    )
    if done:
        _complete.add((dex_id, shiny))
    return done


def prewarm(day: date, *, sleep: Callable[[float], None] = time.sleep) -> None:
    """Make today and the next PREWARM_DAYS complete: full facts and the sprite."""
    if not _prewarm_lock.acquire(blocking=False):
        return
    try:
        pause = lambda: sleep(1 / WARM_REQUESTS_PER_SECOND)  # noqa: E731
        with _client() as client:
            for offset in range(PREWARM_DAYS + 1):
                target = day + timedelta(days=offset)
                dex_id, shiny = species_for_date(target), shiny_for_date(target)
                if _is_complete(dex_id, shiny):
                    continue
                try:
                    pokedex_facts.fetch_bundle(dex_id, client=client, depth="full", pause=pause)
                    fetch_sprite(dex_id, shiny, client=client, pause=pause)
                    _is_complete(dex_id, shiny)
                except Exception as exc:  # the next request tries again
                    logger.info("Splash: pre-warming species %s failed (%s)", dex_id, exc)
    finally:
        _prewarm_lock.release()


def schedule_prewarm(day: date) -> bool:
    """Start prewarm(day) in a background thread, at most once per PREWARM_RETRY_SECONDS."""
    now = time.monotonic()
    if _prewarm_lock.locked() or now - _prewarm_attempts.get(day, -PREWARM_RETRY_SECONDS) < PREWARM_RETRY_SECONDS:
        return False
    _prewarm_attempts[day] = now
    if len(_prewarm_attempts) > 64:
        for old in sorted(_prewarm_attempts)[:-8]:
            del _prewarm_attempts[old]
    threading.Thread(target=prewarm, args=(day,), name="pokedex-splash-prewarm", daemon=True).start()
    return True


# ── Admin warm-up: everything, at a polite rate ──────────────────────────────

class SplashCacheWarmer:
    """Every move first (their learners reveal the signature moves), then each species' facts
    and sprite. About 5,000 PokéAPI and GitHub requests: roughly 17 minutes at 5 a second."""

    def __init__(self, sleep: Callable[[float], None] = time.sleep) -> None:
        self._sleep = sleep
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._state = {
            "running": False, "phase": None, "done": 0, "total": MAX_DEX_ID, "downloaded": 0, "failed": 0,
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
                running=True, phase="moves", done=0, total=MAX_DEX_ID, downloaded=0, failed=0,
                started_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(), finished_at=None,
            )
            self._thread = threading.Thread(target=self.run, name="pokedex-splash-cache", daemon=True)
            self._thread.start()
        return self.status()

    def _set(self, **changes) -> None:
        with self._lock:
            self._state.update(changes)

    def _add(self, **counts) -> None:
        with self._lock:
            for key, value in counts.items():
                self._state[key] += value

    def _pause(self) -> None:
        self._sleep(1 / WARM_REQUESTS_PER_SECOND)

    def run(self) -> None:
        """Fill the cache synchronously (the thread's target; tests call it directly)."""
        try:
            with _client() as client:
                self._warm_moves(client)
                self._set(phase="species", done=0, total=MAX_DEX_ID)
                for dex_id in range(1, MAX_DEX_ID + 1):
                    try:
                        had_extras = pokedex_extras.is_current(pokedex_extras.load_extras(dex_id))
                        pokedex_facts.fetch_bundle(dex_id, client=client, depth="full", pause=self._pause)
                        if not had_extras:  # pokemon/{id} and pokemon-species/{id}
                            self._pause()
                            self._pause()
                            self._add(downloaded=1)
                        fetch_sprite(dex_id, False, client=client, pause=self._pause)
                    except Exception as exc:  # keep going; the next run retries what failed
                        logger.info("Splash cache: species %s failed (%s)", dex_id, exc)
                        self._add(failed=1)
                        self._pause()
                    self._add(done=1)
        finally:
            self._set(running=False, phase=None,
                         finished_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat())

    def _warm_moves(self, client: httpx.Client) -> None:
        try:
            listing = pokedex_extras._get_json(client, f"{pokedex_extras.POKEAPI_BASE}/move?limit=2000", None) or {}
        except pokedex_extras.ExtrasUnavailable as exc:
            logger.info("Splash cache: listing moves failed (%s)", exc)
            return
        names = [item["name"] for item in listing.get("results") or [] if item.get("name")]
        self._set(total=len(names))
        for name in names:
            try:
                if pokedex_facts.load_resource("move", name) is None:
                    pokedex_facts.fetch_resource("move", name, client=client)
                    self._add(downloaded=1)
                    self._pause()
            except Exception as exc:
                logger.info("Splash cache: move %s failed (%s)", name, exc)
                self._add(failed=1)
            self._add(done=1)


splash_cache_warmer = SplashCacheWarmer()
