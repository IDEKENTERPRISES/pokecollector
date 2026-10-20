"""Per-species Pokédex extras for the splash screen, cached from PokéAPI.

The bundled catalogue (``data/pokedex.json``) has numbers, names, generations, regions and
types. The splash screen also wants a weight and a Pokédex entry, so the first time a species
is needed its ``pokemon/{id}`` and ``pokemon-species/{id}`` resources are fetched from PokéAPI
and reduced to one small JSON file:

    {"v": 1, "dex_id": 25, "weight_kg": 6.0, "height_m": 0.4,
     "genus": {"en": "Mouse Pokémon", ...}, "flavor": {"en": ["...", ...], "de": [...]}}

The files live in ``<POKEDEX_IMAGE_CACHE_DIR>/extras``, beside the sprite cache, so they share
its persistent volume. Fetched texts are never committed to the repository.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from services import pokedex_images

MAX_DEX_ID = 1025
POKEAPI_BASE = "https://pokeapi.co/api/v2"
# Languages kept from PokéAPI's genera and flavour texts. The catalogue has names in these too.
EXTRAS_LANGUAGES = ("en", "de")
EXTRAS_VERSION = 1
MAX_TEXTS_PER_LANGUAGE = 40
USER_AGENT = pokedex_images.USER_AGENT
# How long the list of cached species is trusted before the directory is read again.
INDEX_TTL_SECONDS = 300


class ExtrasUnavailable(Exception):
    """PokéAPI could not be reached or answered with an error (not a 404)."""


def validate_species_id(dex_id) -> int:
    dex_id = int(dex_id)
    if not 1 <= dex_id <= MAX_DEX_ID:
        raise ValueError(f"National Pokédex number must be between 1 and {MAX_DEX_ID}")
    return dex_id


def extras_dir() -> Path:
    # Read CACHE_ROOT on every call: tests and the env var may point it elsewhere.
    return pokedex_images.CACHE_ROOT / "extras"


def extras_path(dex_id) -> Path:
    return extras_dir() / f"{validate_species_id(dex_id)}.json"


# ── Text clean-up ────────────────────────────────────────────────────────────

_SOFT_HYPHEN_BREAK = re.compile("­\\s*")
_HYPHEN_BREAK = re.compile(r"-[\f\n\r]+")
_BREAKS = re.compile(r"[\f\n\r\t\v]+")
_POKEMON_CAPS = re.compile(r"POK[ÉéE]MON")
_POKEBALL_CAPS = re.compile(r"POK[ÉéE] ?BALL")
_SPACES = re.compile(r"\s+")
_DEDUPE = re.compile(r"\W+")


def clean_flavor_text(value) -> str:
    """One readable line: page breaks (\\f) and line breaks (\\n) become spaces."""
    text = str(value or "")
    # A soft hyphen marks a word broken across two lines: join the halves.
    text = _SOFT_HYPHEN_BREAK.sub("", text)
    text = _HYPHEN_BREAK.sub("-", text)
    text = _BREAKS.sub(" ", text)
    # The early games wrote POKéMON and POKé BALL in capitals.
    text = _POKEMON_CAPS.sub("Pokémon", text)
    text = _POKEBALL_CAPS.sub("Poké Ball", text)
    return _SPACES.sub(" ", text).strip()


def _dedupe_key(text: str) -> str:
    return _DEDUPE.sub("", text.casefold())


def _language(item: dict) -> str | None:
    language = item.get("language") if isinstance(item, dict) else None
    return language.get("name") if isinstance(language, dict) else None


def parse_extras(dex_id: int, pokemon: dict, species: dict) -> dict:
    """Reduce PokéAPI's two resources to the cached record. Pure; unit-tested."""
    weight = pokemon.get("weight")
    height = pokemon.get("height")
    genus = {}
    for item in species.get("genera") or []:
        lang = _language(item)
        text = clean_flavor_text(item.get("genus")) if lang in EXTRAS_LANGUAGES else ""
        if text and lang not in genus:
            genus[lang] = text
    flavor: dict[str, list[str]] = {lang: [] for lang in EXTRAS_LANGUAGES}
    seen: dict[str, set[str]] = {lang: set() for lang in EXTRAS_LANGUAGES}
    for item in species.get("flavor_text_entries") or []:
        lang = _language(item)
        if lang not in flavor or len(flavor[lang]) >= MAX_TEXTS_PER_LANGUAGE:
            continue
        text = clean_flavor_text(item.get("flavor_text"))
        key = _dedupe_key(text)
        if not key or key in seen[lang]:
            continue
        seen[lang].add(key)
        flavor[lang].append(text)
    return {
        "v": EXTRAS_VERSION,
        "dex_id": int(dex_id),
        # PokéAPI gives hectograms and decimetres.
        "weight_kg": round(weight / 10, 1) if isinstance(weight, (int, float)) and weight > 0 else None,
        "height_m": round(height / 10, 1) if isinstance(height, (int, float)) and height > 0 else None,
        "genus": genus,
        "flavor": {lang: texts for lang, texts in flavor.items() if texts},
        "fetched_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }


# ── Disk cache ───────────────────────────────────────────────────────────────

_index_lock = threading.Lock()
_index: set[int] | None = None
_index_read_at = 0.0


def clear_index() -> None:
    """Forget the cached-species index (tests, or after the directory changed underneath)."""
    global _index
    with _index_lock:
        _index = None


def cached_species_ids() -> frozenset[int]:
    """National Pokédex numbers whose extras are on disk."""
    global _index, _index_read_at
    now = time.monotonic()
    with _index_lock:
        if _index is None or now - _index_read_at > INDEX_TTL_SECONDS:
            found = set()
            try:
                for name in os.listdir(extras_dir()):
                    stem, dot, ext = name.partition(".")
                    if dot and ext == "json" and stem.isdigit() and 1 <= int(stem) <= MAX_DEX_ID:
                        found.add(int(stem))
            except OSError:
                pass
            _index = found
            _index_read_at = now
        return frozenset(_index)


def _remember(dex_id: int) -> None:
    with _index_lock:
        if _index is not None:
            _index.add(dex_id)


def load_extras(dex_id) -> dict | None:
    """The cached record, or None when it is missing or unreadable."""
    path = extras_path(dex_id)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("dex_id") != int(dex_id):
        return None
    return data


def _write_json_atomic(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def _get_json(client: httpx.Client, url: str, timeout: float | None) -> dict | None:
    try:
        response = client.get(url, timeout=timeout) if timeout else client.get(url)
    except httpx.HTTPError as exc:
        raise ExtrasUnavailable(str(exc)) from exc
    if response.status_code == 404:
        return None
    if response.status_code >= 400:
        raise ExtrasUnavailable(f"PokéAPI answered {response.status_code} for {url}")
    try:
        data = response.json()
    except ValueError as exc:
        raise ExtrasUnavailable(f"PokéAPI sent invalid JSON for {url}") from exc
    return data if isinstance(data, dict) else None


def fetch_extras(
    dex_id,
    *,
    refresh: bool = False,
    client: httpx.Client | None = None,
    timeout: float | None = None,
) -> dict | None:
    """The species' extras: from disk, else from PokéAPI (then written to disk).

    Returns None when PokéAPI has no such species. Raises ExtrasUnavailable when PokéAPI is
    unreachable or failing, so callers can fall back to something already cached.
    """
    dex_id = validate_species_id(dex_id)
    if not refresh:
        cached = load_extras(dex_id)
        if cached:
            return cached
    owns_client = client is None
    client = client or httpx.Client(
        timeout=timeout or 30.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True,
    )
    try:
        pokemon = _get_json(client, f"{POKEAPI_BASE}/pokemon/{dex_id}", timeout)
        species = _get_json(client, f"{POKEAPI_BASE}/pokemon-species/{dex_id}", timeout) if pokemon else None
    finally:
        if owns_client:
            client.close()
    if not pokemon or not species:
        return None
    extras = parse_extras(dex_id, pokemon, species)
    _write_json_atomic(extras_path(dex_id), extras)
    _remember(dex_id)
    return extras
