"""Fun facts for the Pokémon of the day, built from PokéAPI data.

The owner asked for "something about their attacks, or a fun fact from the series", never the
Pokédex stats (height and weight are always on the card already). No per-species trivia dataset
with a usable licence exists (Bulbapedia's trivia is CC BY-NC-SA and only available as wiki
text), so every fact is built from PokéAPI, whose fair-use policy asks for local caching:

* signature move: a move that only this species' evolution family learns, with its in-game
  description; otherwise the strongest move it learns by level, with the level;
* ability: the hidden ability when it has one, with its description;
* evolution: how it evolves (level, item, trade, friendship, ...) or what it evolves from;
* trait: Mythical, Legendary, Baby, a single gender, or an extreme catch rate;
* Pokédex: one entry from the games, the series' own lore, never one quoting a size.

The shared resources (moves, abilities, evolution chains, items) are reduced to small JSON files
under ``<POKEDEX_IMAGE_CACHE_DIR>/facts/<kind>/<key>.json``, beside the per-species extras;
nothing fetched is committed to the repository.
"""

from __future__ import annotations

import json
import random
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from services import pokedex_extras, pokedex_images
from services.pokedex import MAX_DEX_ID, pokedex_by_id
from services.pokedex_extras import (
    EXTRAS_LANGUAGES,
    ExtrasUnavailable,
    _get_json,
    _language,
    _write_json_atomic,
    clean_flavor_text,
    resource_id,
)

POKEAPI_BASE = pokedex_extras.POKEAPI_BASE
RESOURCE_KINDS = ("move", "ability", "evolution-chain", "item")
_KEY = re.compile(r"^[a-z0-9-]{1,64}$")
# On demand (a request is waiting) only the strongest level-up moves are looked up; the
# background warm-up looks up every move, which is what finds the signature moves.
QUICK_MOVES = 3
FETCH_WORKERS = 4


# ── Shared resource cache ────────────────────────────────────────────────────

def resource_path(kind: str, key) -> Path:
    key = str(key)
    if kind not in RESOURCE_KINDS or not _KEY.match(key):
        raise ValueError(f"Bad PokéAPI resource: {kind}/{key}")
    return pokedex_images.CACHE_ROOT / "facts" / kind / f"{key}.json"


def load_resource(kind: str, key) -> dict | None:
    try:
        return json.loads(resource_path(kind, key).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _names(data: dict) -> dict:
    names = {}
    for item in data.get("names") or []:
        lang = _language(item)
        if lang in EXTRAS_LANGUAGES and item.get("name") and lang not in names:
            names[lang] = item["name"]
    return names


def _latest_flavor(data: dict) -> dict:
    """The newest in-game description in each language."""
    flavor = {}
    for item in data.get("flavor_text_entries") or []:
        lang = _language(item)
        text = clean_flavor_text(item.get("flavor_text"))
        if lang in EXTRAS_LANGUAGES and text:
            flavor[lang] = text  # entries run from the oldest game to the newest
    return flavor


def reduce_move(data: dict) -> dict:
    return {
        "names": _names(data),
        "type": (data.get("type") or {}).get("name"),
        "power": data.get("power"),
        "flavor": _latest_flavor(data),
        "learners": sorted({
            dex_id for dex_id in (resource_id(item) for item in data.get("learned_by_pokemon") or [])
            if dex_id and dex_id <= MAX_DEX_ID
        }),
    }


def reduce_ability(data: dict) -> dict:
    return {"names": _names(data), "flavor": _latest_flavor(data)}


def reduce_item(data: dict) -> dict:
    return {"names": _names(data)}


def _how(detail: dict) -> dict:
    how = {"trigger": (detail.get("trigger") or {}).get("name")}
    for field, key in (("min_level", "level"), ("min_happiness", "happiness"), ("time_of_day", "time")):
        if detail.get(field):
            how[key] = detail[field]
    for field, key in (("item", "item"), ("held_item", "held_item"), ("known_move", "move")):
        if (detail.get(field) or {}).get("name"):
            how[key] = detail[field]["name"]
    return how


def reduce_chain(data: dict) -> dict:
    """Every species in the family and each evolution step with how it happens."""
    species, links = [], []

    def walk(node: dict, parent: int | None) -> None:
        dex_id = resource_id(node.get("species"))
        if not dex_id:
            return
        species.append(dex_id)
        if parent:
            details = node.get("evolution_details") or [{}]
            links.append({"from": parent, "to": dex_id, "how": _how(details[0])})
        for child in node.get("evolves_to") or []:
            walk(child, dex_id)

    walk(data.get("chain") or {}, None)
    return {"species": species, "links": links}


REDUCERS = {"move": reduce_move, "ability": reduce_ability, "evolution-chain": reduce_chain, "item": reduce_item}


def fetch_resource(kind: str, key, *, client: httpx.Client, timeout: float | None = None) -> dict | None:
    """From disk, else from PokéAPI (then written to disk). Raises ExtrasUnavailable."""
    cached = load_resource(kind, key)
    if cached is not None:
        return cached
    data = _get_json(client, f"{POKEAPI_BASE}/{kind}/{key}", timeout)
    if data is None:
        return None
    reduced = REDUCERS[kind](data)
    _write_json_atomic(resource_path(kind, key), reduced)
    return reduced


def bundle_requests(extras: dict, *, depth: str = "quick") -> list[tuple[str, str]]:
    """The shared resources a species' facts need that are not cached yet."""
    wanted = []
    if extras.get("chain_id"):
        wanted.append(("evolution-chain", str(extras["chain_id"])))
    for ability in extras.get("abilities") or []:
        wanted.append(("ability", ability["name"]))
    moves = extras.get("moves") or {}
    names = [name for name, _level in (moves.get("level") or [])[:QUICK_MOVES]]
    if depth == "full":
        names += moves.get("all") or []
    wanted += [("move", name) for name in dict.fromkeys(names)]
    chain = load_resource("evolution-chain", extras["chain_id"]) if extras.get("chain_id") else None
    for link in (chain or {}).get("links") or []:
        for key in ("item", "held_item"):
            if link["how"].get(key):
                wanted.append(("item", link["how"][key]))
    return [(kind, key) for kind, key in dict.fromkeys(wanted) if _KEY.match(key) and load_resource(kind, key) is None]


def fetch_bundle(dex_id: int, *, client: httpx.Client, depth: str = "quick", timeout: float | None = None,
                 pause=None) -> dict | None:
    """Everything the species' facts need: its extras, then its shared resources (twice, because
    the evolution chain names the items). ``pause`` paces the background warm-up."""
    extras = pokedex_extras.fetch_extras(dex_id, client=client, timeout=timeout)
    if not extras:
        return None
    for _round in range(2):
        wanted = bundle_requests(extras, depth=depth)
        if not wanted:
            break
        if pause:
            for kind, key in wanted:
                fetch_resource(kind, key, client=client, timeout=timeout)
                pause()
        else:
            with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
                for future in [pool.submit(fetch_resource, kind, key, client=client, timeout=timeout)
                               for kind, key in wanted]:
                    future.result()
    return extras


# ── Building the facts ───────────────────────────────────────────────────────

_TEXT = {
    "en": {
        "level": "at level {level}",
        "item": "with {article} {item}",
        "trade": "when traded",
        "trade_item": "when traded holding {article} {item}",
        "happiness": "with high friendship",
        "move": "after learning {move}",
        "special": "under special conditions",
        "day": "during the day",
        "night": "at night",
        "into": "Evolves into {to} {how}.",
        "into_many": "Can evolve into {count} different Pokémon, such as {first} and {second}.",
        "from": "Evolves from {from} {how}.",
        "learns": "Learns it at level {level}.",
        "mythical": "A Mythical Pokémon: so rare it usually only appears at special events.",
        "legendary": "A Legendary Pokémon.",
        "baby": "A Baby Pokémon that hatches from an Egg.",
        "genderless": "It has no gender.",
        "female": "Every one of them is female.",
        "male": "Every one of them is male.",
        "hard": "With a catch rate of {rate}, it is one of the hardest Pokémon to catch.",
        "easy": "With a catch rate of {rate}, it is one of the easiest Pokémon to catch.",
        "egg": "Its Egg hatches after about {steps} steps.",
    },
    "de": {
        "level": "ab Level {level}",
        "item": "mit {item}",
        "trade": "durch Tausch",
        "trade_item": "durch Tausch, wenn es {item} trägt",
        "happiness": "bei hoher Freundschaft",
        "move": "sobald es {move} beherrscht",
        "special": "unter besonderen Bedingungen",
        "day": "tagsüber",
        "night": "nachts",
        "into": "Entwickelt sich {how} zu {to}.",
        "into_many": "Kann sich zu {count} verschiedenen Pokémon entwickeln, etwa {first} und {second}.",
        "from": "Entwickelt sich aus {from} ({how}).",
        "learns": "Erlernt sie ab Level {level}.",
        "mythical": "Ein Mysteriöses Pokémon: so selten, dass es meist nur bei besonderen Events erscheint.",
        "legendary": "Ein Legendäres Pokémon.",
        "baby": "Ein Baby-Pokémon, das aus einem Ei schlüpft.",
        "genderless": "Es hat kein Geschlecht.",
        "female": "Es gibt nur weibliche Exemplare.",
        "male": "Es gibt nur männliche Exemplare.",
        "hard": "Mit einer Fangrate von {rate} gehört es zu den am schwersten zu fangenden Pokémon.",
        "easy": "Mit einer Fangrate von {rate} gehört es zu den am leichtesten zu fangenden Pokémon.",
        "egg": "Sein Ei schlüpft nach etwa {steps} Schritten.",
    },
}

# Pokédex entries that quote a size or weight repeat the card's stats.
_STATS_WORDS = re.compile(
    r"\b(kg|kilograms?|pounds?|lbs?|tons?|feet|foot|ft|meters?|metres?|inch(es)?|weighs?|weight|"
    r"kilo|pfund|tonnen?|metern?|wiegt|gewicht)\b",
    re.IGNORECASE,
)
_CAPITALS = re.compile(r"\b[A-ZÄÖÜ]{3,}\b")


def _species_name(dex_id: int, lang: str) -> str:
    entry = pokedex_by_id().get(dex_id) or {}
    return entry.get(f"name_{lang}") or entry.get("name_en") or str(dex_id)


def _localised(resource: dict | None, field: str, lang: str) -> str | None:
    values = (resource or {}).get(field) or {}
    return values.get(lang) or values.get("en")


def polish(text: str, dex_id: int) -> str:
    """Older games wrote names in capitals ("Whenever PIKACHU…"): use the normal spelling."""
    entry = pokedex_by_id().get(dex_id) or {}
    for key in ("name_en", "name_de"):
        name = entry.get(key) or ""
        if len(name) >= 3:
            text = re.sub(rf"\b{re.escape(name.upper())}\b", name, text)
    return text


def _how_phrase(how: dict, lang: str) -> str:
    text = _TEXT[lang]
    trigger = how.get("trigger")

    def item_name(key):
        return _localised(load_resource("item", how[key]), "names", lang) or how[key].replace("-", " ").title()

    def article(word):
        return "an" if word[:1].upper() in "AEIOU" else "a"

    if trigger == "trade":
        if how.get("held_item"):
            name = item_name("held_item")
            return text["trade_item"].format(article=article(name), item=name)
        return text["trade"]
    if how.get("item"):
        name = item_name("item")
        return text["item"].format(article=article(name), item=name)
    parts = []
    if how.get("level"):
        parts.append(text["level"].format(level=how["level"]))
    elif how.get("happiness"):
        parts.append(text["happiness"])
    elif how.get("move"):
        move = _localised(load_resource("move", how["move"]), "names", lang) or how["move"].replace("-", " ").title()
        parts.append(text["move"].format(move=move))
    if how.get("time") in ("day", "night"):
        parts.append(text[how["time"]])
    return " ".join(parts) if parts else text["special"]


def evolution_fact(dex_id: int, chain: dict | None, lang: str) -> str | None:
    if not chain:
        return None
    text = _TEXT[lang]
    onward = [link for link in chain.get("links") or [] if link["from"] == dex_id]
    if len(onward) == 1:
        link = onward[0]
        return text["into"].format(to=_species_name(link["to"], lang), how=_how_phrase(link["how"], lang))
    if len(onward) > 1:
        names = [_species_name(link["to"], lang) for link in onward]
        return text["into_many"].format(count=len(onward), first=names[0], second=names[1])
    back = next((link for link in chain.get("links") or [] if link["to"] == dex_id), None)
    if back:
        return text["from"].format(**{"from": _species_name(back["from"], lang), "how": _how_phrase(back["how"], lang)})
    return None


def trait_fact(traits: dict | None, lang: str) -> str | None:
    traits = traits or {}
    text = _TEXT[lang]
    for key in ("mythical", "legendary", "baby"):
        if traits.get(key):
            return text[key]
    gender = traits.get("gender_rate")
    if gender == -1:
        return text["genderless"]
    if gender == 8:
        return text["female"]
    if gender == 0:
        return text["male"]
    rate = traits.get("capture_rate")
    if isinstance(rate, int) and rate <= 3:
        return text["hard"].format(rate=rate)
    if isinstance(rate, int) and rate >= 255:
        return text["easy"].format(rate=rate)
    counter = traits.get("hatch_counter")
    if isinstance(counter, int) and counter >= 30:
        steps = f"{(counter + 1) * 255:,}".replace(",", "." if lang == "de" else ",")
        return text["egg"].format(steps=steps)
    return None


def move_fact(dex_id: int, extras: dict, chain: dict | None, lang: str) -> dict | None:
    family = set((chain or {}).get("species") or []) | {dex_id}
    moves = extras.get("moves") or {}
    signature = []
    for name in moves.get("all") or []:
        move = load_resource("move", name)
        if move and move.get("learners") and set(move["learners"]) <= family and move.get("flavor"):
            signature.append(move)
    if signature:
        move = max(signature, key=lambda item: item.get("power") or 0)
        return {"kind": "signature-move", "title": _localised(move, "names", lang),
                "text": _localised(move, "flavor", lang)}
    for name, level in moves.get("level") or []:
        move = load_resource("move", name)
        if move and move.get("flavor"):
            return {"kind": "move", "title": _localised(move, "names", lang),
                    "text": f"{_localised(move, 'flavor', lang)} {_TEXT[lang]['learns'].format(level=level)}"}
    return None


def ability_fact(extras: dict, lang: str) -> dict | None:
    abilities = sorted(extras.get("abilities") or [], key=lambda item: not item.get("hidden"))
    for ability in abilities:
        resource = load_resource("ability", ability["name"])
        if resource and resource.get("flavor"):
            return {"kind": "hidden-ability" if ability.get("hidden") else "ability",
                    "title": _localised(resource, "names", lang), "text": _localised(resource, "flavor", lang)}
    return None


def pokedex_fact(dex_id: int, extras: dict, lang: str, rng: random.Random) -> str | None:
    flavor = extras.get("flavor") or {}
    for candidate in dict.fromkeys((lang, "en")):
        texts = [polish(text, dex_id) for text in flavor.get(candidate) or [] if isinstance(text, str) and text]
        texts = [text for text in texts if not _STATS_WORDS.search(text)]
        if texts:
            plain = [text for text in texts if not _CAPITALS.search(text)] or texts
            short = [text for text in plain if len(text) <= 180] or plain
            return rng.choice(short)
    return None


def build_facts(dex_id: int, extras: dict | None, lang: str, *, seed: str = "") -> list[dict]:
    """Up to five facts, attacks first. Reads only the local cache; deterministic for a seed."""
    if not extras:
        return []
    lang = lang if lang in _TEXT else "en"
    chain = load_resource("evolution-chain", extras["chain_id"]) if extras.get("chain_id") else None
    rng = random.Random(f"{seed}:{dex_id}:{lang}")
    facts = [move_fact(dex_id, extras, chain, lang), ability_fact(extras, lang)]
    for kind, text in (("evolution", evolution_fact(dex_id, chain, lang)),
                       ("trait", trait_fact(extras.get("traits"), lang)),
                       ("pokedex", pokedex_fact(dex_id, extras, lang, rng))):
        if text:
            facts.append({"kind": kind, "text": text})
    return [{key: value for key, value in fact.items() if value} for fact in facts if fact and fact.get("text")]
