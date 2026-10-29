"""Achievement registry: every badge, its tier, its gym-badge track and the metric it reads.

See docs/ENGAGEMENT_DESIGN.md §7 P6. The first 20 badges stay defined in `api/social.py` (re-exported
here unchanged); the new ones are listed once, in `_NEW`, so the owner can trim them in one place.
A tiered family (bronze/silver/gold steps) is a run of entries sharing a `family`, one entry and one
`user_achievements` row per step.
"""

from __future__ import annotations

from collections import defaultdict
from functools import lru_cache

from sqlalchemy.orm import Session

TIERS = ("bronze", "silver", "gold")
TRACKS = ("collection", "sets", "value", "pokedex", "variety", "explorer", "trader", "daily")

# Stored in progress_state.state_version. Bump it when badges are added; an entry's `since` is the
# registry version that introduced it, and badges a trainer already qualifies for when the version
# rises unlock silently (backfilled) instead of flooding them with sheets and pushes.
REGISTRY_VERSION = 3

ENERGY_TYPES = (
    "grass", "fire", "water", "lightning", "psychic", "fighting",
    "darkness", "metal", "dragon", "fairy", "colorless",
)

# Old badges: track and tier by id. Their definitions stay in api/social.py.
_LEGACY_PLACEMENT = {
    "first_card": ("collection", "bronze"),
    "collector_10": ("collection", "bronze"),
    "collector_50": ("collection", "silver"),
    "collector_100": ("collection", "silver"),
    "collector_500": ("collection", "gold"),
    "collector_1000": ("collection", "gold"),
    "first_set": ("sets", "bronze"),
    "set_master_5": ("sets", "silver"),
    "set_master_10": ("sets", "gold"),
    "big_spender_100": ("value", "bronze"),
    "big_spender_500": ("value", "silver"),
    "big_spender_1000": ("value", "gold"),
    "big_spender_5000": ("value", "gold"),
    "investor": ("value", "silver"),
    "diversifier": ("explorer", "bronze"),
    "diversifier_25": ("explorer", "silver"),
    "wishlist_hunter": ("explorer", "bronze"),
    "first_sale": ("trader", "bronze"),
    "trader": ("trader", "silver"),
    "rare_finder": ("variety", "silver"),
}


# English badge names for the push text. They are the strings of `achievements.*` in
# frontend/src/i18n/en.js, so a notification names the badge exactly as the app does.
_LEGACY_NAMES = {
    "first_card": "First Card",
    "collector_10": "Collector",
    "collector_50": "Avid Collector",
    "collector_100": "Centurion",
    "collector_500": "Grand Collector",
    "collector_1000": "Master Collector",
    "first_set": "First Set",
    "set_master_5": "Set Master",
    "set_master_10": "Set Legend",
    "big_spender_100": "Investor",
    "big_spender_500": "Big Investor",
    "big_spender_1000": "Premium Collector",
    "big_spender_5000": "Elite Collector",
    "investor": "In the Green",
    "diversifier": "Diversity",
    "diversifier_25": "Globe Trotter",
    "wishlist_hunter": "Wish Hunter",
    "first_sale": "First Sale",
    "trader": "Trader",
    "rare_finder": "Rare Finder",
}

# Shown when a badge has no English `name` (an entry added without one).
FALLBACK_BADGE_NAME = "a new badge"


def _entry(id_, key, name, metric, target, track, tier, art, family=None, since=REGISTRY_VERSION):
    return {
        "id": id_,
        "name": name,
        "name_key": f"achievements.{key}",
        "description_key": f"achievements.{key}Desc",
        "badge_id": None,
        "art": art,
        "metric": metric,
        "target": target,
        "track": track,
        "tier": tier,
        "family": family or id_,
        "since": since,
    }


_DEX_STEPS = [(10, "bronze"), (50, "bronze"), (100, "silver"), (250, "silver"), (500, "gold"), (1000, "gold")]
_GEN_NAMES = {1: "Kanto", 2: "Johto", 3: "Hoenn", 4: "Sinnoh", 5: "Unova", 6: "Kalos", 7: "Alola", 8: "Galar", 9: "Paldea"}


def _gen_size(generation: int) -> int:
    from services.pokedex import REGION_RANGES

    low, high = REGION_RANGES[generation]
    return high - low + 1


# --- the new badges: edit this list to trim or extend --------------------------------------
_NEW = (
    [_entry(f"dex_{n}", f"dex{n}", f"Species Seeker {n}", "dex_species", n, "pokedex", tier, "dex",
            family="dex_species")
     for n, tier in _DEX_STEPS]
    + [_entry(f"dex_gen_{g}", f"dexGen{g}", f"{_GEN_NAMES[g]} Complete", f"dex_gen_{g}", _gen_size(g), "pokedex",
              "silver", "region", family="dex_generation")
       for g in sorted(_GEN_NAMES)]
    + [
        _entry("all_types", "allTypes", "Rainbow Collection", "energy_types", len(ENERGY_TYPES), "variety", "gold", "types"),
        _entry("first_holo", "firstHolo", "First Shine", "holo_flag", 1, "variety", "bronze", "holo"),
        _entry("first_full_art", "firstFullArt", "Full Art", "full_art_flag", 1, "variety", "silver", "fullart"),
        _entry("first_scan", "firstScan", "Scan Star", "scans_confirmed", 1, "explorer", "bronze", "scan"),
        _entry("first_trade", "firstTrade", "Trade Partner", "trades_count", 1, "trader", "bronze", "trade"),
        _entry("first_deck", "firstDeck", "Deck Builder", "decks_count", 1, "explorer", "bronze", "deck"),
        _entry("true_master", "trueMaster", "True Master", "master_sets", 1, "sets", "gold", "master"),
    ]
    # The "daily" track (P7, registry version 3): streaks, Who's That Pokémon and quests.
    + [_entry(f"streak_{n}", f"streak{n}", name, "streak_best", n, "daily", tier, "flame", family="streak", since=3)
       for n, name, tier in ((7, "Week Warrior", "bronze"), (30, "Monthly Regular", "silver"), (100, "Eternal Flame", "gold"))]
    + [
        _entry("first_wtp", "firstWtp", "Sharp Eyes", "wtp_wins", 1, "daily", "bronze", "silhouette", since=3),
        _entry("wtp_run_7", "wtpRun7", "Silhouette Master", "wtp_best_run", 7, "daily", "silver", "silhouette", since=3),
        _entry("quests_10", "quests10", "Errand Runner", "quests_done", 10, "daily", "bronze", "quest", family="quests", since=3),
        _entry("quests_50", "quests50", "Quest Seeker", "quests_done", 50, "daily", "silver", "quest", family="quests", since=3),
        _entry("quests_200", "quests200", "Quest Legend", "quests_done", 200, "daily", "gold", "quest", family="quests", since=3),
    ]
)


@lru_cache(maxsize=1)
def _build() -> tuple[dict, ...]:
    from api.social import ACHIEVEMENTS  # lazy: social imports a lot

    legacy = []
    for config in ACHIEVEMENTS:
        track, tier = _LEGACY_PLACEMENT.get(config["id"], ("collection", "bronze"))
        legacy.append({
            **config, "name": _LEGACY_NAMES.get(config["id"], ""), "art": None, "track": track, "tier": tier,
            "family": config["metric"], "since": 1,
        })
    return tuple(legacy + _NEW)


def registry() -> tuple[dict, ...]:
    return _build()


def registry_by_id() -> dict[str, dict]:
    return {entry["id"]: entry for entry in registry()}


def track_summary(unlocked_ids) -> list[dict]:
    """Per gym-badge track: how many badges are earned and the highest tier reached."""
    unlocked = set(unlocked_ids)
    result = {track: {"track": track, "earned": 0, "total": 0, "tier": None} for track in TRACKS}
    for entry in registry():
        row = result[entry["track"]]
        row["total"] += 1
        if entry["id"] in unlocked:
            row["earned"] += 1
            if row["tier"] is None or TIERS.index(entry["tier"]) > TIERS.index(row["tier"]):
                row["tier"] = entry["tier"]
    return [result[track] for track in TRACKS]


# --- metrics ---------------------------------------------------------------------------------


def _owned_card_rows(db: Session, user_id: int):
    from models import Card, CollectionItem
    from services.digital_sets import digital_sets_enabled

    query = db.query(
        Card.id, Card.dex_ids, Card.types, Card.energy_type, Card.rarity, Card.set_id, Card.lang,
        CollectionItem.variant,
    ).join(CollectionItem, CollectionItem.card_id == Card.id).filter(
        CollectionItem.user_id == user_id, Card.is_custom == False,  # noqa: E712
    )
    if not digital_sets_enabled(db):
        query = query.filter(Card.is_digital == False)  # noqa: E712
    return query.yield_per(1000)


def _type_names(types, energy_type) -> set[str]:
    names = set()
    values = list(types) if isinstance(types, (list, tuple)) else ([types] if types else [])
    if energy_type:
        values.append(energy_type)
    for value in values:
        text = str(value).strip().lower()
        for known in ENERGY_TYPES:
            if text == known or text == f"{known} energy":
                names.add(known)
    return names


def extra_stats(db: Session, user_id: int) -> dict:
    """Metrics the old stats loader does not provide. One pass over the owned cards plus small counts."""
    from models import Binder, ScanJobItem, Trade
    from services.pokedex import REGION_RANGES, normalize_dex_ids

    species: set[int] = set()
    types: set[str] = set()
    holo = False
    full_art = False
    owned_variants: dict[str, set[str]] = defaultdict(set)
    owned_by_set: dict[tuple, set[str]] = defaultdict(set)
    for card_id, dex_ids, card_types, energy_type, rarity, set_id, lang, variant in _owned_card_rows(db, user_id):
        species.update(normalize_dex_ids(dex_ids))
        types |= _type_names(card_types, energy_type)
        text = (rarity or "").lower()
        if variant in ("Holo", "Reverse Holo") or "holo" in text:
            holo = True
        if "full art" in text or "ultra rare" in text:
            full_art = True
        owned_variants[card_id].add(variant or "Normal")
        if set_id:
            owned_by_set[(set_id, lang)].add(card_id)

    stats = {
        "dex_species": len(species),
        "energy_types": len(types),
        "holo_flag": 1 if holo else 0,
        "full_art_flag": 1 if full_art else 0,
        "scans_confirmed": db.query(ScanJobItem.id).filter(
            ScanJobItem.user_id == user_id, ScanJobItem.resolved == True,  # noqa: E712
            ScanJobItem.status == "done",
        ).count(),
        "trades_count": db.query(Trade.id).filter(Trade.user_id == user_id).count(),
        "decks_count": db.query(Binder.id).filter(
            Binder.user_id == user_id, Binder.binder_type.in_(("deck", "physical_deck")),
        ).count(),
        "master_sets": _master_sets(db, owned_by_set, owned_variants),
    }
    for generation, (low, high) in REGION_RANGES.items():
        stats[f"dex_gen_{generation}"] = sum(1 for dex_id in species if low <= dex_id <= high)
    return stats


_VARIANT_FLAGS = (
    ("variants_normal", "Normal"), ("variants_reverse", "Reverse Holo"),
    ("variants_holo", "Holo"), ("variants_first_edition", "First Edition"),
)


def _master_sets(db: Session, owned_by_set: dict, owned_variants: dict) -> int:
    """Sets with every card owned in every printing the catalogue lists for it."""
    from sqlalchemy import func

    from models import Card

    if not owned_by_set:
        return 0
    set_ids = {set_id for set_id, _ in owned_by_set}
    sizes = {
        (row.set_id, row.lang): row.card_count
        for row in db.query(Card.set_id, Card.lang, func.count(Card.id).label("card_count")).filter(
            Card.set_id.in_(set_ids), Card.is_custom == False  # noqa: E712
        ).group_by(Card.set_id, Card.lang).all()
    }
    candidates = {key for key, cards in owned_by_set.items() if sizes.get(key) and len(cards) >= sizes[key]}
    if not candidates:
        return 0
    complete_ids = {card_id for key in candidates for card_id in owned_by_set[key]}
    required: dict[str, set[str]] = {}
    for row in db.query(
        Card.id, Card.variants_normal, Card.variants_reverse, Card.variants_holo, Card.variants_first_edition
    ).filter(Card.id.in_(complete_ids)).all():
        needs = {name for flag, name in zip(row[1:], (v for _, v in _VARIANT_FLAGS)) if flag}
        required[row.id] = needs
    count = 0
    for key in candidates:
        if all(required.get(card_id, set()) <= owned_variants[card_id] for card_id in owned_by_set[key]):
            count += 1
    return count


def metrics_for(db: Session, user_id: int, base_stats: dict) -> dict:
    from services.progress.daily import daily_stats

    return {**base_stats, **extra_stats(db, user_id), **daily_stats(db, user_id)}
