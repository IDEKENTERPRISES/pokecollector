"""Small delights (engagement P8): On this day, the Showcase 6 and Collection DNA."""
from __future__ import annotations

import datetime
import json
from collections import Counter, defaultdict
from urllib.parse import quote

from sqlalchemy.orm import Session, joinedload

from models import Card, CollectionItem, Set as CardSet, UserSetting
from services.card_values import effective_market_price
from services.card_visibility import visible_any_card_filter
from services.progress.daily import local_today, user_zone

SHOWCASE_KEY = "showcase"
SHOWCASE_MAX = 6
OTD_THUMBS_PER_YEAR = 4
DNA_TOP = 8
DNA_TYPES = {
    "colorless", "darkness", "dragon", "fairy", "fighting", "fire", "grass",
    "lightning", "metal", "psychic", "water",
}
_TYPE_ALIASES = {"electric": "lightning", "dark": "darkness", "steel": "metal"}


class ShowcaseError(ValueError):
    pass


def _image(card_id: str) -> str:
    return f"/api/images/card/{quote(card_id, safe='')}/small"


def _card_summary(card: Card) -> dict:
    return {"card_id": card.id, "name": card.name, "image": _image(card.id)}


def _acquired(item: CollectionItem) -> datetime.datetime | None:
    return item.acquired_at or item.added_at


def on_this_day(db: Session, user_id: int, now: datetime.datetime | None = None) -> dict:
    """Cards acquired on today's month and day (user's local time) in earlier years."""
    zone = user_zone(db, user_id)
    today = local_today(zone, now)
    items = (
        db.query(CollectionItem)
        .join(Card, Card.id == CollectionItem.card_id)
        .options(joinedload(CollectionItem.card))
        .filter(CollectionItem.user_id == user_id, visible_any_card_filter(db, user_id, "all"))
        .all()
    )
    years: dict[int, list[CollectionItem]] = defaultdict(list)
    for item in items:
        stamp = _acquired(item)
        if stamp is None or item.card is None:
            continue
        local = stamp.replace(tzinfo=datetime.timezone.utc).astimezone(zone).date()
        if local.year < today.year and (local.month, local.day) == (today.month, today.day):
            years[local.year].append(item)
    rows = []
    for year in sorted(years, reverse=True):
        group = years[year]
        rows.append({
            "year": year,
            "count": sum(int(i.quantity or 1) for i in group),
            "cards": [{**_card_summary(i.card), "item_id": i.id} for i in group[:OTD_THUMBS_PER_YEAR]],
        })
    return {
        "date": today.isoformat(),
        "month": today.month,
        "day": today.day,
        "total": sum(r["count"] for r in rows),
        "years": rows,
    }


# ---- Showcase ----

def _stored_ids(db: Session, user_id: int) -> list[int]:
    row = db.query(UserSetting).filter(UserSetting.user_id == user_id, UserSetting.key == SHOWCASE_KEY).first()
    if not row:
        return []
    try:
        data = json.loads(row.value)
    except (TypeError, ValueError):
        return []
    return [i for i in data if isinstance(i, int) and not isinstance(i, bool)] if isinstance(data, list) else []


def showcase_items(db: Session, user_id: int) -> list[CollectionItem]:
    """The user's showcased copies in order; ids that no longer exist (or aren't theirs) are skipped."""
    ids = _stored_ids(db, user_id)[:SHOWCASE_MAX]
    if not ids:
        return []
    found = {
        item.id: item
        for item in db.query(CollectionItem).options(joinedload(CollectionItem.card))
        .filter(CollectionItem.user_id == user_id, CollectionItem.id.in_(ids)).all()
        if item.card is not None and not item.card.is_custom
    }
    return [found[i] for i in ids if i in found]


def serialize_showcase(items: list[CollectionItem], show_values: bool) -> list[dict]:
    rows = []
    for item in items:
        card = item.card
        rows.append({
            "id": item.id,
            "card_id": card.id,
            "name": card.name,
            "image": _image(card.id),
            "set_name": card.set_ref.name if card.set_ref else None,
            "variant": item.variant,
            "market_value": effective_market_price(card, item.variant, "price_trend") if show_values else None,
        })
    return rows


def save_showcase(db: Session, user_id: int, ids) -> list[int]:
    if not isinstance(ids, list) or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
        raise ShowcaseError("ids must be a list of collection item ids")
    unique = list(dict.fromkeys(ids))
    if len(unique) > SHOWCASE_MAX:
        raise ShowcaseError(f"A showcase holds at most {SHOWCASE_MAX} cards")
    owned = {
        row[0] for row in db.query(CollectionItem.id)
        .filter(CollectionItem.user_id == user_id, CollectionItem.id.in_(unique)).all()
    } if unique else set()
    if len(owned) != len(unique):
        raise ShowcaseError("Only copies in your own collection can be showcased")
    row = db.query(UserSetting).filter(UserSetting.user_id == user_id, UserSetting.key == SHOWCASE_KEY).first()
    value = json.dumps(unique)
    if row:
        row.value = value
    else:
        db.add(UserSetting(user_id=user_id, key=SHOWCASE_KEY, value=value))
    db.commit()
    return unique


# ---- Collection DNA ----

def _era(release_date: str | None) -> str | None:
    year = (release_date or "")[:4]
    return year if year.isdigit() else None


def collection_dna(db: Session, user_id: int) -> dict:
    items = (
        db.query(CollectionItem)
        .join(Card, Card.id == CollectionItem.card_id)
        .options(joinedload(CollectionItem.card).joinedload(Card.set_ref))
        .filter(CollectionItem.user_id == user_id, visible_any_card_filter(db, user_id, "all"))
        .all()
    )
    types: Counter = Counter()
    artists: Counter = Counter()
    eras: Counter = Counter()
    dex: Counter = Counter()
    dex_names: dict[int, Counter] = defaultdict(Counter)
    total = 0
    for item in items:
        card = item.card
        if card is None:
            continue
        qty = int(item.quantity or 1)
        total += qty
        for raw in (card.types or [])[:1]:
            key = _TYPE_ALIASES.get(str(raw).lower(), str(raw).lower())
            types[key if key in DNA_TYPES else "colorless"] += qty
        if card.artist:
            artists[card.artist.strip()] += qty
        era = _era(card.set_ref.release_date if card.set_ref else None)
        if era:
            eras[era] += qty
        for dex_id in (card.dex_ids or [])[:1]:
            if isinstance(dex_id, int):
                dex[dex_id] += qty
                dex_names[dex_id][card.name] += qty
    return {
        "total_cards": total,
        "types": [{"type": k, "count": v} for k, v in sorted(types.items(), key=lambda kv: (-kv[1], kv[0]))],
        "illustrators": [
            {"name": k, "count": v}
            for k, v in sorted(artists.items(), key=lambda kv: (-kv[1], kv[0]))[:DNA_TOP]
        ],
        "eras": [{"year": int(k), "count": v} for k, v in sorted(eras.items())],
        "pokemon": [
            {"dex_id": k, "name": dex_names[k].most_common(1)[0][0], "count": v}
            for k, v in sorted(dex.items(), key=lambda kv: (-kv[1], kv[0]))[:DNA_TOP]
        ],
    }
