"""Card detail metadata enrichment shared by sync and search."""

from __future__ import annotations

import datetime
import logging
from typing import Iterable

from sqlalchemy import JSON, and_, case, func, or_, true
from sqlalchemy.orm import Session

from models import Card, Set
from services import pokemon_api
from services.card_fallbacks import apply_cross_language_fallbacks
from services.card_upsert import upsert_card
from services.card_visibility import get_configured_sync_languages, language_is_syncable, sync_deselected_languages_enabled
from services.sync_retry import is_transient_error

logger = logging.getLogger(__name__)

DEFAULT_METADATA_ENRICHMENT_PER_FULL_SYNC = 500
METADATA_ENRICHMENT_PER_SEARCH_PAGE = 20
METADATA_ENRICHMENT_COOLDOWN = datetime.timedelta(days=7)
POKEMON_SUPERTYPE_VALUES = ("pokemon", "pokémon")
ELEMENTAL_SUPERTYPE_VALUES = (*POKEMON_SUPERTYPE_VALUES, "energy")


def _json_value_missing(column):
    """Match both SQL NULL and legacy JSON literal null values.

    SQLAlchemy JSON/JSONB columns historically persisted Python ``None`` as
    JSON ``null`` unless ``none_as_null`` was enabled. ``IS NULL`` alone does
    not match those rows, so metadata backfills must handle both forms.
    """
    return or_(column.is_(None), column == JSON.NULL)

_ANY_METADATA_FIELDS = (
    "rarity",
    "types",
    "supertype",
    "subtypes",
    "hp",
    "artist",
    "stage",
    "trainer_type",
    "energy_type",
    "regulation_mark",
)

_KEY_METADATA_FIELDS = (
    "rarity",
    "supertype",
    "subtypes",
)


def _has_value(value) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict, tuple, set)):
        return bool(value)
    return True


def _card_missing_key_metadata(card: Card) -> bool:
    if not any(_has_value(getattr(card, field, None)) for field in _ANY_METADATA_FIELDS):
        return True
    if any(not _has_value(getattr(card, field, None)) for field in _KEY_METADATA_FIELDS):
        return True
    supertype = (card.supertype or "").strip().casefold()
    if supertype in ELEMENTAL_SUPERTYPE_VALUES and not _has_value(card.types):
        return True
    if supertype in POKEMON_SUPERTYPE_VALUES and (
        card.dex_ids is None or card.cardmarket_products is None
    ):
        return True
    return False


def _as_utc_naive(value: datetime.datetime) -> datetime.datetime:
    if value.tzinfo is not None and value.utcoffset() is not None:
        return value.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return value


def _metadata_enrichment_attempt_is_due(
    card: Card,
    *,
    now: datetime.datetime | None = None,
) -> bool:
    attempted_at = card.last_metadata_enrichment_attempt_at
    if attempted_at is None:
        return True
    checked_at = _as_utc_naive(now or datetime.datetime.utcnow())
    return checked_at - _as_utc_naive(attempted_at) >= METADATA_ENRICHMENT_COOLDOWN


def card_needs_metadata_enrichment(card: Card, *, now: datetime.datetime | None = None) -> bool:
    """Return true for brief or partially populated rows missing important base metadata.

    Cards still missing fields but attempted within METADATA_ENRICHMENT_COOLDOWN
    are skipped. Metadata attempts use their own timestamp so catalogue, image,
    and price updates cannot postpone or prematurely trigger another attempt.
    """
    if not card or card.is_custom or not (card.tcg_card_id or card.id):
        return False
    if not _card_missing_key_metadata(card):
        return False
    return _metadata_enrichment_attempt_is_due(card, now=now)


def _card_detail_id(card: Card) -> str | None:
    if card.tcg_card_id:
        return card.tcg_card_id
    if not card.id:
        return None
    tcg_id, _lang = pokemon_api.strip_lang_suffix(card.id)
    return tcg_id


def _clear_missing_set_reference(db: Session, parsed: dict) -> None:
    set_id = parsed.get("set_id")
    if not set_id:
        return
    set_exists = db.query(Set.id).filter((Set.tcg_set_id == set_id) | (Set.id == set_id)).first()
    if not set_exists:
        parsed["set_id"] = None


def enrich_card_metadata(db: Session, card: Card) -> Card | None:
    """Fetch full TCGdex detail for one card and upsert enriched metadata."""
    detail_id = _card_detail_id(card)
    if not detail_id:
        return None
    card_lang = card.lang or "en"
    card_data = pokemon_api.get_card(detail_id, lang=card_lang)
    if not card_data:
        return None

    parsed = pokemon_api.parse_card_for_db(card_data, lang=card_lang)
    parsed = pokemon_api.keep_row_identity(parsed, card.id, detail_id)
    parsed = apply_cross_language_fallbacks(db, parsed)
    _clear_missing_set_reference(db, parsed)
    return upsert_card(db, parsed)


def enrich_cards_metadata(
    db: Session,
    cards: Iterable[Card],
    *,
    limit: int,
    commit_every: int = 50,
    force: bool = False,
    ignore_cooldown: bool = False,
    on_progress=None,
) -> dict:
    """Enrich up to limit cards, atomically claiming each upstream attempt.

    ``force`` bypasses the generic missing-metadata predicate for specialized
    backfills. ``ignore_cooldown`` also bypasses the seven-day retry window,
    while an optimistic timestamp comparison still rejects stale concurrent
    claims. ``commit_every`` remains accepted for compatibility; claims and
    results are committed per card so they are visible to concurrent workers.

    A transient upstream failure (5xx, 429, timeout, connection error) gives the
    claim back, so it does not start the seven-day cooldown, and lists the card
    in ``transient`` as ``(card_id, exception)`` for the caller to retry.
    ``on_progress(done, total)`` is called after each selected card.
    """
    del commit_every
    result = {
        "attempted": 0,
        "updated": 0,
        "missing": 0,
        "failed": 0,
        "deferred": 0,
        "ids": [],
        "transient": [],
    }
    selected: list[tuple[str, datetime.datetime | None]] = []
    selected_languages = set(get_configured_sync_languages(db))
    for card in cards:
        if len(selected) >= limit:
            break
        if not card or card.is_custom or not (card.tcg_card_id or card.id):
            continue
        if not language_is_syncable(db, card.lang, selected_languages):
            continue
        if not ignore_cooldown and not _metadata_enrichment_attempt_is_due(card):
            continue
        if force or _card_missing_key_metadata(card):
            selected.append((card.id, card.last_metadata_enrichment_attempt_at))

    for index, (card_id, observed_attempt_at) in enumerate(selected, start=1):
        if on_progress:
            on_progress(index - 1, len(selected))
        attempted_at = datetime.datetime.utcnow()
        cooldown_cutoff = attempted_at - METADATA_ENRICHMENT_COOLDOWN
        if ignore_cooldown:
            claim_filter = (
                Card.last_metadata_enrichment_attempt_at.is_(None)
                if observed_attempt_at is None
                else Card.last_metadata_enrichment_attempt_at == observed_attempt_at
            )
        else:
            claim_filter = or_(
                Card.last_metadata_enrichment_attempt_at.is_(None),
                Card.last_metadata_enrichment_attempt_at <= cooldown_cutoff,
            )
        claimed = (
            db.query(Card)
            .filter(
                Card.id == card_id,
                claim_filter,
            )
            .update(
                {Card.last_metadata_enrichment_attempt_at: attempted_at},
                synchronize_session=False,
            )
        )
        if not claimed:
            db.rollback()
            result["deferred"] += 1
            continue

        # Persist the claim before the network request so another search or
        # sync worker cannot fetch the same incomplete card concurrently.
        db.commit()
        claimed_card = db.query(Card).filter(Card.id == card_id).first()
        if not claimed_card:
            continue

        result["attempted"] += 1
        try:
            enriched = enrich_card_metadata(db, claimed_card)
            if enriched:
                result["updated"] += 1
                result["ids"].append(enriched.id)
            else:
                result["missing"] += 1
            db.commit()
        except Exception as exc:
            db.rollback()
            result["failed"] += 1
            logger.warning("Failed to enrich card metadata for %s: %s", card_id, exc)
            if is_transient_error(exc):
                # Not the card's fault: give the claim back so the next attempt is not
                # locked out for the cooldown.
                result["transient"].append((card_id, exc))
                try:
                    # Only if the claim is still ours: never overwrite a concurrent worker's.
                    db.query(Card).filter(
                        Card.id == card_id,
                        Card.last_metadata_enrichment_attempt_at == attempted_at,
                    ).update(
                        {Card.last_metadata_enrichment_attempt_at: observed_attempt_at},
                        synchronize_session=False,
                    )
                    db.commit()
                except Exception:
                    db.rollback()
                    logger.exception("Could not release the metadata claim for %s", card_id)

    if on_progress and selected:
        on_progress(len(selected), len(selected))
    return result


def enrich_card_metadata_ids_in_background(card_ids: Iterable[str]) -> None:
    """Enrich search results after the response using an independent DB session."""
    unique_ids = list(dict.fromkeys(card_id for card_id in card_ids if card_id))
    if not unique_ids:
        return

    from database import SessionLocal

    db = SessionLocal()
    try:
        cards = db.query(Card).filter(Card.id.in_(unique_ids)).all()
        cards_by_id = {card.id: card for card in cards}
        ordered_cards = [cards_by_id[card_id] for card_id in unique_ids if card_id in cards_by_id]
        enrich_cards_metadata(
            db,
            ordered_cards,
            limit=min(len(ordered_cards), METADATA_ENRICHMENT_PER_SEARCH_PAGE),
        )
    except Exception:
        db.rollback()
        logger.exception("Background card metadata enrichment failed")
    finally:
        db.close()


def _missing_metadata_filter():
    """Catalogue rows that still only have brief set-list data (no cooldown applied)."""
    return and_(
        Card.is_custom == False,
        Card.tcg_card_id.isnot(None),
        or_(
            Card.rarity.is_(None),
            Card.supertype.is_(None),
            Card.subtypes.is_(None),
            and_(Card.types.is_(None), func.lower(Card.supertype).in_(ELEMENTAL_SUPERTYPE_VALUES)),
            and_(
                or_(_json_value_missing(Card.dex_ids), _json_value_missing(Card.cardmarket_products)),
                func.lower(Card.supertype).in_(POKEMON_SUPERTYPE_VALUES),
            ),
        ),
    )


def _syncable_language_filter(db: Session):
    """Only cards in selected languages are enriched (unless SYNC_DESELECTED_LANGUAGES is on)."""
    if sync_deselected_languages_enabled():
        return true()
    return Card.lang.in_(get_configured_sync_languages(db))


def count_cards_missing_metadata(db: Session) -> dict:
    """How many selected-language catalogue cards still lack full details, and per language.

    ``due`` excludes cards attempted inside the 7-day cooldown.
    """
    cooldown_cutoff = datetime.datetime.utcnow() - METADATA_ENRICHMENT_COOLDOWN
    base = db.query(Card.lang, func.count(Card.id)).filter(
        _missing_metadata_filter(), _syncable_language_filter(db)
    )
    per_language = {lang or "en": count for lang, count in base.group_by(Card.lang).all()}
    due = db.query(func.count(Card.id)).filter(
        _missing_metadata_filter(),
        _syncable_language_filter(db),
        or_(
            Card.last_metadata_enrichment_attempt_at.is_(None),
            Card.last_metadata_enrichment_attempt_at <= cooldown_cutoff,
        ),
    ).scalar() or 0
    return {"missing": sum(per_language.values()), "due": int(due), "per_language": per_language}


def enrich_missing_card_metadata(
    db: Session,
    *,
    limit: int = DEFAULT_METADATA_ENRICHMENT_PER_FULL_SYNC,
    on_progress=None,
) -> dict:
    """Enrich a bounded batch of catalogue cards that still only have brief set-list data."""
    cooldown_cutoff = datetime.datetime.utcnow() - METADATA_ENRICHMENT_COOLDOWN
    candidates = (
        db.query(Card)
        .filter(
            _missing_metadata_filter(),
            _syncable_language_filter(db),
            or_(
                Card.last_metadata_enrichment_attempt_at.is_(None),
                Card.last_metadata_enrichment_attempt_at <= cooldown_cutoff,
            ),
        )
        .order_by(
            case((Card.last_metadata_enrichment_attempt_at.is_(None), 0), else_=1),
            Card.last_metadata_enrichment_attempt_at.asc(),
            Card.id.asc(),
        )
        .limit(limit)
        .all()
    )
    return enrich_cards_metadata(db, candidates, limit=limit, force=True, on_progress=on_progress)
