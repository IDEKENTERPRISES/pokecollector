"""Chase goals (P10): rules over the catalogue whose progress is computed live.

A goal never stores its cards. It stores a rule (`kind` + `params`) and is resolved against the
catalogue each time, so a new release that matches the rule grows the goal by itself. A resolved goal
is a list of *units* (a card, a card in one printing, a Pokémon, an illustration); a unit is owned
when any of its candidate (card, variant) pairs is in the trainer's collection. Everything is done
with a handful of set-based queries, never one per card.
"""
from __future__ import annotations

import datetime
import json
from functools import lru_cache
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import Session, load_only

from models import Card, CollectionItem, Set, UserGoal, WishlistItem
from services.card_values import effective_market_price
from services.card_visibility import get_configured_sync_languages
from services.digital_sets import digital_sets_enabled

KINDS = ("set", "set_master", "generation", "family", "artist", "custom")
THRESHOLDS = (50, 75, 90, 100)
MAX_GOALS = 50
MAX_CUSTOM_CARDS = 2000
CHEAPEST_LIMIT = 10
DETAIL_LIMIT = 200
NAME_MAX = 80

_VARIANT_FLAGS = (
    ("variants_normal", "Normal"), ("variants_reverse", "Reverse Holo"),
    ("variants_holo", "Holo"), ("variants_first_edition", "First Edition"),
)

_CARD_COLUMNS = (
    Card.id, Card.tcg_card_id, Card.name, Card.set_id, Card.number, Card.lang, Card.artist, Card.dex_ids,
    Card.images_small, Card.images_large, Card.custom_image_url, Card.is_digital, Card.is_custom,
    Card.cardmarket_products,
    Card.variants_normal, Card.variants_reverse, Card.variants_holo, Card.variants_first_edition,
    Card.price_market, Card.price_low, Card.price_trend, Card.price_avg1, Card.price_avg7, Card.price_avg30,
    Card.price_market_holo, Card.price_low_holo, Card.price_trend_holo,
    Card.price_avg1_holo, Card.price_avg7_holo, Card.price_avg30_holo,
)


class GoalError(ValueError):
    """The goal's kind or params are not acceptable."""


@lru_cache(maxsize=1)
def families() -> tuple[dict, ...]:
    path = Path(__file__).resolve().parent.parent / "data" / "pokemon_families.json"
    return tuple(json.loads(path.read_text(encoding="utf-8")))


def family_by_id() -> dict[str, dict]:
    return {entry["id"]: entry for entry in families()}


def generations() -> dict[int, dict]:
    """Generation number -> {region, dex_ids} from the static Pokédex."""
    from services.pokedex import load_pokedex

    result: dict[int, dict] = {}
    for entry in load_pokedex():
        gen = int(entry["generation"])
        bucket = result.setdefault(gen, {"region": entry.get("region"), "dex_ids": []})
        bucket["dex_ids"].append(int(entry["dex_id"]))
    return result


# --- params -------------------------------------------------------------------------------------


def _clean_name(value) -> str | None:
    text = " ".join(str(value or "").split())
    return text[:NAME_MAX] if text else None


def clean_params(db: Session, kind: str, params: dict | None) -> dict:
    """Validate and normalise a goal's params. Raises GoalError."""
    params = params or {}
    if kind not in KINDS:
        raise GoalError("Unknown goal kind")
    if kind in ("set", "set_master"):
        set_id = str(params.get("set_id") or "").strip()
        lang = str(params.get("lang") or "en").strip() or "en"
        if not set_id:
            raise GoalError("A set goal needs a set")
        if not db.query(Set.id).filter(Set.tcg_set_id == set_id, Set.lang == lang).first():
            raise GoalError("That set does not exist")
        return {"set_id": set_id, "lang": lang}
    if kind == "generation":
        try:
            generation = int(params.get("generation"))
        except (TypeError, ValueError):
            raise GoalError("A generation goal needs a generation number")
        if generation not in generations():
            raise GoalError("That generation does not exist")
        return {"generation": generation}
    if kind == "family":
        family = str(params.get("family") or "").strip()
        if family not in family_by_id():
            raise GoalError("That evolution family does not exist")
        # "every": every printing of the line; otherwise one card of each Pokémon in it.
        return {"family": family, "every": True} if params.get("every") is True else {"family": family}
    if kind == "artist":
        artist = _clean_name(params.get("artist"))
        if not artist:
            raise GoalError("An artist goal needs an illustrator")
        if not db.query(Card.id).filter(func.lower(Card.artist) == artist.lower()).first():
            raise GoalError("No card by that illustrator")
        return {"artist": artist}
    ids = params.get("card_ids")
    if not isinstance(ids, list):
        raise GoalError("A custom goal needs a list of cards")
    card_ids = list(dict.fromkeys(str(card_id) for card_id in ids if card_id))
    if not card_ids:
        raise GoalError("A custom goal needs at least one card")
    if len(card_ids) > MAX_CUSTOM_CARDS:
        raise GoalError("Too many cards in one goal")
    known = set()
    for start in range(0, len(card_ids), 500):
        known.update(c for (c,) in db.query(Card.id).filter(Card.id.in_(card_ids[start:start + 500])))
    card_ids = [card_id for card_id in card_ids if card_id in known]
    if not card_ids:
        raise GoalError("None of those cards exist")
    cleaned = {"card_ids": card_ids}
    name = _clean_name(params.get("name"))
    if name:
        cleaned["name"] = name
    return cleaned


# --- context ------------------------------------------------------------------------------------


class GoalContext:
    """What every goal of one request shares: languages, price field, the trainer's collection, species cards."""

    def __init__(self, db: Session, user_id: int, price_field: str | None = None):
        from services.sync_service import _user_price_field

        self.db = db
        self.user_id = user_id
        self.price_field = price_field or _user_price_field(db, user_id)
        self.languages = set(get_configured_sync_languages(db))
        self.digital = digital_sets_enabled(db)
        self._owned: tuple[set, set] | None = None
        self._species: dict[int, list] | None = None

    def card_query(self):
        query = self.db.query(*_CARD_COLUMNS)
        if not self.digital:
            query = query.filter(Card.is_digital == False)  # noqa: E712
        return query

    def owned(self) -> tuple[set, set]:
        """(card ids owned in any variant, (card id, variant) pairs owned)."""
        if self._owned is None:
            rows = self.db.query(CollectionItem.card_id, CollectionItem.variant).filter(
                CollectionItem.user_id == self.user_id
            ).distinct().all()
            self._owned = ({card_id for card_id, _ in rows}, {(card_id, variant or "Normal") for card_id, variant in rows})
        return self._owned

    def species_cards(self) -> dict[int, list]:
        """National Pokédex number -> printings in the server's catalogue languages (one query for all goals)."""
        if self._species is None:
            from services.pokedex import normalize_dex_ids

            query = self.card_query().filter(
                Card.is_custom == False, Card.dex_ids.isnot(None), Card.lang.in_(self.languages)  # noqa: E712
            )
            species: dict[int, list] = {}
            for row in query.all():
                for dex_id in normalize_dex_ids(row.dex_ids):
                    species.setdefault(dex_id, []).append(row)
            self._species = species
        return self._species


# --- resolving ----------------------------------------------------------------------------------


def _variants_of(row) -> list[str]:
    needs = [name for flag, name in _VARIANT_FLAGS if getattr(row, flag)]
    return needs or ["Normal"]


def _species_units(ctx: GoalContext, dex_ids) -> list[tuple]:
    species = ctx.species_cards()
    return [(("dex", dex_id), [(row, None) for row in species[dex_id]]) for dex_id in dex_ids if species.get(dex_id)]


def resolve_units(ctx: GoalContext, goal) -> list[tuple]:
    """The goal's units as (key, [(card row, variant or None), ...]); a unit is owned when any pair is."""
    kind, params = goal.kind, goal.params or {}
    if kind in ("set", "set_master"):
        rows = ctx.card_query().filter(
            Card.is_custom == False, Card.set_id == params.get("set_id"), Card.lang == params.get("lang")  # noqa: E712
        ).order_by(Card.id).all()
        if kind == "set":
            return [(row.id, [(row, None)]) for row in rows]
        return [((row.id, variant), [(row, variant)]) for row in rows for variant in _variants_of(row)]
    if kind == "generation":
        return _species_units(ctx, generations().get(int(params.get("generation") or 0), {}).get("dex_ids", []))
    if kind == "family":
        dex_ids = (family_by_id().get(params.get("family")) or {}).get("dex_ids", [])
        if not params.get("every"):
            return _species_units(ctx, dex_ids)
        species = ctx.species_cards()
        rows = {row.id: row for dex_id in dex_ids for row in species.get(dex_id, [])}
        grouped: dict[tuple, list] = {}
        for row in sorted(rows.values(), key=lambda row: row.id):  # the same print in two languages is one unit
            grouped.setdefault((row.set_id, row.number), []).append((row, None))
        return list(grouped.items())
    if kind == "artist":
        artist = str(params.get("artist") or "").lower()
        rows = ctx.card_query().filter(
            Card.is_custom == False, func.lower(Card.artist) == artist, Card.lang.in_(ctx.languages)  # noqa: E712
        ).order_by(Card.id).all()
        grouped: dict[tuple, list] = {}
        for row in rows:  # the same illustration in two languages is one unit
            grouped.setdefault((row.set_id, row.number), []).append((row, None))
        return list(grouped.items())
    if kind == "custom":
        ids = list(params.get("card_ids") or [])
        rows: dict[str, object] = {}
        for start in range(0, len(ids), 500):
            for row in ctx.card_query().filter(Card.id.in_(ids[start:start + 500])).all():
                rows[row.id] = row
        return [(card_id, [(rows[card_id], None)]) for card_id in ids if card_id in rows]
    return []


def _unit_owned(ctx: GoalContext, candidates) -> bool:
    card_ids, pairs = ctx.owned()
    for row, variant in candidates:
        if (row.id in card_ids) if variant is None else ((row.id, variant) in pairs):
            return True
    return False


def _unit_best(ctx: GoalContext, candidates):
    """The cheapest priced candidate (price, row, variant), else the first one with price None."""
    best = None
    for row, variant in candidates:
        price = effective_market_price(row, variant, ctx.price_field)
        if price and price > 0 and (best is None or (price, row.id) < (best[0], best[1].id)):
            best = (price, row, variant)
    if best is not None:
        return best
    row, variant = candidates[0]
    return (None, row, variant)


def _card_entry(row, variant, price) -> dict:
    return {
        "id": row.id, "card_id": row.id, "name": row.name, "set_id": row.set_id, "number": row.number, "lang": row.lang,
        "variant": variant, "price": round(price, 2) if price else None,
        "images_small": row.images_small, "images_large": row.images_large,
        "custom_image_url": row.custom_image_url, "cardmarket_products": row.cardmarket_products,
    }


def progress_for(ctx: GoalContext, goal, detail: bool = False) -> dict:
    """Owned vs needed, percent, cost to finish and the cheapest missing cards of one goal."""
    units = resolve_units(ctx, goal)
    total = len(units)
    owned = 0
    cost = 0.0
    unpriced = 0
    missing = []
    for key, candidates in units:
        if _unit_owned(ctx, candidates):
            owned += 1
            continue
        price, row, variant = _unit_best(ctx, candidates)
        if price is None:
            unpriced += 1
        else:
            cost += price
        missing.append((price, row, variant))
    missing.sort(key=lambda entry: (entry[0] is None, entry[0] or 0.0, entry[1].id))
    limit = DETAIL_LIMIT if detail else CHEAPEST_LIMIT
    percent = round(owned * 100 / total, 1) if total else 0.0
    return {
        "owned": owned,
        "total": total,
        "missing": total - owned,
        "percent": percent,
        "cost_to_finish": round(cost, 2),
        "unpriced_missing": unpriced,
        "cheapest_missing": [_card_entry(row, variant, price) for price, row, variant in missing[:limit]],
    }


def missing_cards(ctx: GoalContext, goal) -> list:
    """One (card row, variant) per missing unit, cheapest first (the card a wishlist or binder would hold)."""
    out = []
    for key, candidates in resolve_units(ctx, goal):
        if _unit_owned(ctx, candidates):
            continue
        price, row, variant = _unit_best(ctx, candidates)
        out.append((price, row, variant))
    out.sort(key=lambda entry: (entry[0] is None, entry[0] or 0.0, entry[1].id))
    return out


def all_cards(ctx: GoalContext, goal) -> list:
    """One (card row, variant) per unit, owned or not (what a Planned Binder from the goal holds)."""
    out, seen = [], set()
    for key, candidates in resolve_units(ctx, goal):
        if _unit_owned(ctx, candidates):
            row, variant = next(
                (c for c in candidates if (c[0].id in ctx.owned()[0] if c[1] is None else (c[0].id, c[1]) in ctx.owned()[1])),
                candidates[0],
            )
        else:
            _, row, variant = _unit_best(ctx, candidates)
        if row.id not in seen:
            seen.add(row.id)
            out.append((row, variant))
    return out


# --- titles and serialisation -------------------------------------------------------------------


def goal_title(db: Session, goal) -> str:
    kind, params = goal.kind, goal.params or {}
    if kind in ("set", "set_master"):
        row = db.query(Set.name).filter(Set.tcg_set_id == params.get("set_id"), Set.lang == params.get("lang")).first()
        name = row[0] if row else str(params.get("set_id") or "")
        return f"{name} (master set)" if kind == "set_master" else name
    if kind == "generation":
        gen = int(params.get("generation") or 0)
        region = generations().get(gen, {}).get("region")
        return f"Generation {gen}" + (f" · {region}" if region else "")
    if kind == "family":
        name = (family_by_id().get(params.get("family")) or {}).get("name") or str(params.get("family"))
        return f"{name} (every card)" if params.get("every") else name
    if kind == "artist":
        return str(params.get("artist") or "")
    return params.get("name") or "Custom goal"


def serialize(db: Session, goal, progress: dict | None = None) -> dict:
    data = {
        "id": goal.id,
        "kind": goal.kind,
        "params": goal.params or {},
        "title": goal_title(db, goal),
        "pinned": bool(goal.pinned),
        "created_at": goal.created_at.isoformat() if goal.created_at else None,
        "completed_at": goal.completed_at.isoformat() if goal.completed_at else None,
    }
    if progress is not None:
        data["progress"] = progress
    return data


def thresholds_reached(percent: float) -> list[int]:
    return [t for t in THRESHOLDS if percent >= t]


# --- actions ------------------------------------------------------------------------------------


def wishlist_plan(ctx: GoalContext, goal) -> list:
    """Missing cards not yet on the trainer's wishlist."""
    cards = [row for _, row, _ in missing_cards(ctx, goal)]
    unique = list(dict.fromkeys(row.id for row in cards))
    on_list = set()
    for start in range(0, len(unique), 500):
        on_list.update(
            c for (c,) in ctx.db.query(WishlistItem.card_id).filter(
                WishlistItem.user_id == ctx.user_id, WishlistItem.card_id.in_(unique[start:start + 500])
            )
        )
    return [card_id for card_id in unique if card_id not in on_list]


def add_to_wishlist(ctx: GoalContext, goal) -> dict:
    to_add = wishlist_plan(ctx, goal)
    now = datetime.datetime.utcnow()
    for card_id in to_add:
        ctx.db.add(WishlistItem(card_id=card_id, user_id=ctx.user_id, quantity=1, created_at=now))
    return {"added": len(to_add)}


# --- milestones ---------------------------------------------------------------------------------


def evaluate_goals(db: Session, user_id: int, now: datetime.datetime, ctx: GoalContext | None = None) -> list[int]:
    """Record the 50/75/90/100 % thresholds each goal has reached and queue one push per new crossing.

    A goal whose `milestones` is still NULL is backfilled silently: its current thresholds are recorded
    without a push. Only the highest threshold crossed at once is announced. Reaching 100 % sets
    `completed_at`. Returns the ids of the goals announced. The caller commits.
    """
    from services import notifications

    goals = db.query(UserGoal).filter(UserGoal.user_id == user_id).order_by(UserGoal.id).all()
    if not goals:
        return []
    ctx = ctx or GoalContext(db, user_id)
    announced = []
    for goal in goals:
        percent = progress_for(ctx, goal)["percent"]
        reached = thresholds_reached(percent)
        known = goal.milestones
        if known is None:
            goal.milestones = reached
        else:
            fresh = [t for t in reached if t not in known]
            if fresh:
                goal.milestones = sorted(set(known) | set(reached))
                top = max(fresh)
                try:
                    with db.begin_nested():
                        queued = notifications.enqueue(
                            db, user_id, "goal_milestones", f"goal:{goal.id}:{top}", now=now,
                            details={"goal_id": goal.id, "title": goal_title(db, goal), "percent": top},
                        )
                    if queued:
                        announced.append(goal.id)
                except Exception:
                    import logging

                    logging.getLogger(__name__).exception("Could not queue the goal push for user %s", user_id)
        if 100 in (goal.milestones or []) and goal.completed_at is None:
            goal.completed_at = now
    db.flush()
    return announced
