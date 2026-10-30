"""Activity feed: which trainer events are shareable, and how they are shown to other trainers.

docs/ENGAGEMENT_DESIGN.md §7 P12. Events come from `user_events` (written only by the progress evaluator
and the goal engine). Each trainer picks per kind what to share, and whether values are shared. The picks
are applied when the feed is read, so turning a kind off hides that trainer's past events of that kind too.
"""
import datetime

from sqlalchemy import and_, false, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import (
    Card,
    EventComment,
    EventReaction,
    Set,
    User,
    UserAchievement,
    UserEvent,
    UserSetting,
)
from services.card_values import effective_market_price, normalize_price_field
from services.progress.evaluator import (
    EVENT_ACHIEVEMENT_UNLOCKED,
    EVENT_BIG_PULL,
    EVENT_GOAL_COMPLETED,
    EVENT_SET_COMPLETED,
)

# Event kinds that may appear in the feed, and whether a trainer shares them until they choose.
# Anything not listed here (future kinds, debug kinds) never appears.
FEED_KINDS = {
    EVENT_SET_COMPLETED: True,
    EVENT_ACHIEVEMENT_UNLOCKED: True,
    EVENT_GOAL_COMPLETED: False,
    EVENT_BIG_PULL: False,
}

SHARE_VALUES_KEY = "feed_share_values"
SHARE_PREFIX = "feed_share_"

# The one place the reaction kinds are defined. The ids are stable; the app owns the artwork and labels.
REACTION_KINDS = ("cheer", "wow", "fire", "heart")

# Badges that state an amount of money. They stay out of the feed unless the trainer shares values.
VALUE_METRICS = {"total_value", "positive_pnl_flag"}

COMMENT_MAX_LENGTH = 280
MAX_COMMENTS_SHOWN = 200

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 50


def share_key(kind: str) -> str:
    return f"{SHARE_PREFIX}{kind}"


def preference_keys() -> list[str]:
    return [share_key(kind) for kind in FEED_KINDS] + [SHARE_VALUES_KEY]


def boolean_keys() -> set[str]:
    return set(preference_keys())


def default_settings() -> dict[str, str]:
    """Defaults merged into the settings API response."""
    defaults = {share_key(kind): "true" if shared else "false" for kind, shared in FEED_KINDS.items()}
    defaults[SHARE_VALUES_KEY] = "false"
    return defaults


def is_truthy(value) -> bool:
    return str(value).strip().lower() in {"true", "1", "yes", "on"}


def _value_badge_ids() -> list[str]:
    from services.achievements import registry

    return [entry["id"] for entry in registry() if entry.get("metric") in VALUE_METRICS]


def _preference_rows(db: Session) -> dict[int, dict[str, bool]]:
    rows: dict[int, dict[str, bool]] = {}
    for user_id, key, value in db.query(UserSetting.user_id, UserSetting.key, UserSetting.value).filter(
        UserSetting.key.in_(preference_keys())
    ):
        rows.setdefault(user_id, {})[key] = is_truthy(value)
    return rows


def trainers_sharing(db: Session, prefs: dict[int, dict[str, bool]] | None = None) -> dict:
    """Trainer ids per preference: `{"on": {kind: set(ids)}, "off": {kind: set(ids)}, "values": set(ids)}`.

    A trainer without a stored row follows the default, so only deviations are listed:
    `off` holds trainers who switched a default-on kind off, `on` those who switched a default-off kind on.
    """
    prefs = _preference_rows(db) if prefs is None else prefs
    on: dict[str, set[int]] = {kind: set() for kind in FEED_KINDS}
    off: dict[str, set[int]] = {kind: set() for kind in FEED_KINDS}
    for user_id, row in prefs.items():
        for kind, default in FEED_KINDS.items():
            value = row.get(share_key(kind))
            if value is None or value == default:
                continue
            (on if value else off)[kind].add(user_id)
    values = {user_id for user_id, row in prefs.items() if row.get(SHARE_VALUES_KEY)}
    return {"on": on, "off": off, "values": values}


def shareable_events(db: Session, viewer_id: int, include_own: bool = False):
    """Query of the events the viewer may see: other active trainers' events they currently share.

    With `include_own` the viewer's own events join them, under the viewer's own sharing choices
    (switching a kind off hides your own past events from your feed too).

    Backfilled and silent unlocks never qualify: an unlock needs a `user_achievements` row that is not
    backfilled. Value badges need the trainer to share values.
    """
    sharing = trainers_sharing(db)
    kind_clauses = []
    for kind, default in FEED_KINDS.items():
        if default:
            off = sharing["off"][kind]
            clause = UserEvent.kind == kind
            if off:
                clause = and_(clause, UserEvent.user_id.notin_(sorted(off)))
        else:
            on = sharing["on"][kind]
            if not on:
                continue
            clause = and_(UserEvent.kind == kind, UserEvent.user_id.in_(sorted(on)))
        kind_clauses.append(clause)
    query = (
        db.query(UserEvent)
        .join(User, User.id == UserEvent.user_id)
        .outerjoin(
            UserAchievement,
            and_(
                UserAchievement.user_id == UserEvent.user_id,
                UserAchievement.achievement_id == UserEvent.subject_key,
            ),
        )
        .filter(User.is_active == True)  # noqa: E712
    )
    if not include_own:
        query = query.filter(UserEvent.user_id != viewer_id)
    if not kind_clauses:
        return query.filter(false())
    query = query.filter(or_(*kind_clauses))
    query = query.filter(or_(
        UserEvent.kind != EVENT_ACHIEVEMENT_UNLOCKED,
        and_(UserAchievement.id.isnot(None), UserAchievement.backfilled == False),  # noqa: E712
    ))
    value_badges = _value_badge_ids()
    if value_badges:
        sharing_values = sharing["values"]
        value_clause = and_(
            UserEvent.kind == EVENT_ACHIEVEMENT_UNLOCKED, UserEvent.subject_key.in_(value_badges)
        )
        if sharing_values:
            value_clause = and_(value_clause, UserEvent.user_id.notin_(sorted(sharing_values)))
        query = query.filter(~value_clause)
    return query


def _cursor_filter(db: Session, query, before: int | None):
    if before is None:
        return query
    occurred_at = db.query(UserEvent.occurred_at).filter(UserEvent.id == before).scalar()
    if occurred_at is None:
        return query.filter(UserEvent.id < before)
    return query.filter(or_(
        UserEvent.occurred_at < occurred_at,
        and_(UserEvent.occurred_at == occurred_at, UserEvent.id < before),
    ))


def _card_summary(card: Card | None, fallback_id=None, fallback_name=None) -> dict:
    """The few card fields the app's card tiles and images use. Never prices, never a custom image URL."""
    if card is None:
        return {"id": fallback_id, "name": fallback_name}
    summary = {
        "id": card.id,
        "name": card.name,
        "number": card.number,
        "set_id": card.set_id,
        "lang": card.lang,
        "rarity": card.rarity,
        "data_source_lang": card.data_source_lang,
        "image_source_lang": card.image_source_lang,
    }
    if card.is_custom:
        # A custom card belongs to its owner: name only, no pictures.
        summary.update({"images_small": None, "images_large": None})
    else:
        summary.update({"images_small": card.images_small, "images_large": card.images_large})
    return summary


def _display(db: Session, event: UserEvent, cards: dict, set_names: dict, show_values: bool, price_field: str) -> dict:
    payload = event.payload or {}
    if event.kind == EVENT_SET_COMPLETED:
        return {
            "set_key": event.subject_key,
            "set_name": payload.get("set_name"),
            "lang": payload.get("lang"),
            "total": payload.get("total"),
        }
    if event.kind == EVENT_ACHIEVEMENT_UNLOCKED:
        from services.achievements import registry_by_id

        config = registry_by_id().get(payload.get("achievement_id") or event.subject_key) or {}
        return {
            "achievement_id": payload.get("achievement_id") or event.subject_key,
            "name": config.get("name") or None,
            "name_key": payload.get("name_key") or config.get("name_key"),
            "tier": payload.get("tier") or config.get("tier"),
            "track": payload.get("track") or config.get("track"),
            "art": config.get("art"),
        }
    if event.kind == EVENT_GOAL_COMPLETED:
        return {"goal_id": payload.get("goal_id"), "goal_kind": payload.get("goal_kind"), "title": payload.get("title")}
    # big_pull
    card = cards.get(payload.get("card_id"))
    display = {
        "card": _card_summary(card, payload.get("card_id"), payload.get("name")),
        "variant": payload.get("variant"),
    }
    if card is not None and card.set_id:
        display["set_name"] = set_names.get((card.set_id, card.lang))
    if show_values and card is not None:
        price = effective_market_price(card, payload.get("variant"), price_field)
        display["amount"] = round(price, 2) if price is not None else None
    return display


def reaction_summary(db: Session, event_ids: list[int], viewer_id: int) -> dict[int, dict]:
    counts: dict[int, dict[str, int]] = {event_id: {kind: 0 for kind in REACTION_KINDS} for event_id in event_ids}
    mine: dict[int, list[str]] = {event_id: [] for event_id in event_ids}
    if event_ids:
        for event_id, kind, user_id in db.query(
            EventReaction.event_id, EventReaction.kind, EventReaction.user_id
        ).filter(EventReaction.event_id.in_(event_ids)):
            if kind not in counts[event_id]:
                continue
            counts[event_id][kind] += 1
            if user_id == viewer_id:
                mine[event_id].append(kind)
    return {
        event_id: {"counts": counts[event_id], "mine": [k for k in REACTION_KINDS if k in mine[event_id]]}
        for event_id in event_ids
    }


def comment_counts(db: Session, event_ids: list[int]) -> dict[int, int]:
    counts = {event_id: 0 for event_id in event_ids}
    if event_ids:
        rows = (
            db.query(EventComment.event_id, func.count(EventComment.id))
            .join(User, User.id == EventComment.user_id)
            .filter(EventComment.event_id.in_(event_ids), User.is_active == True)  # noqa: E712
            .group_by(EventComment.event_id)
        )
        for event_id, count in rows:
            counts[event_id] = count
    return counts


def serialize_events(db: Session, events: list[UserEvent], viewer_id: int, price_field: str = "price_trend") -> list[dict]:
    if not events:
        return []
    price_field = normalize_price_field(price_field)
    users = {u.id: u for u in db.query(User).filter(User.id.in_({e.user_id for e in events}))}
    sharing_values = trainers_sharing(db)["values"]
    card_ids = {(e.payload or {}).get("card_id") for e in events if e.kind == EVENT_BIG_PULL}
    card_ids.discard(None)
    cards = {c.id: c for c in db.query(Card).filter(Card.id.in_(card_ids))} if card_ids else {}
    set_ids = {c.set_id for c in cards.values() if c.set_id}
    set_names = {
        (s.tcg_set_id, s.lang): s.name for s in db.query(Set).filter(Set.tcg_set_id.in_(set_ids))
    } if set_ids else {}
    reactions = reaction_summary(db, [e.id for e in events], viewer_id)
    comments = comment_counts(db, [e.id for e in events])
    items = []
    for event in events:
        user = users.get(event.user_id)
        items.append({
            "id": event.id,
            "kind": event.kind,
            "occurred_at": event.occurred_at.isoformat() if event.occurred_at else None,
            "trainer": {
                "id": event.user_id,
                "username": user.username if user else None,
                "avatar_id": user.avatar_id if user else None,
            },
            "display": _display(db, event, cards, set_names, event.user_id in sharing_values, price_field),
            "mine": event.user_id == viewer_id,
            "reactions": reactions[event.id],
            "comment_count": comments[event.id],
        })
    return items


def feed_page(
    db: Session, viewer_id: int, before: int | None = None, limit: int = DEFAULT_PAGE_SIZE,
    price_field: str = "price_trend",
) -> dict:
    limit = max(1, min(int(limit), MAX_PAGE_SIZE))
    query = _cursor_filter(db, shareable_events(db, viewer_id, include_own=True), before)
    rows = query.order_by(UserEvent.occurred_at.desc(), UserEvent.id.desc()).limit(limit + 1).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": serialize_events(db, rows, viewer_id, price_field),
        "next_before": rows[-1].id if more and rows else None,
        "reaction_kinds": list(REACTION_KINDS),
    }


def visible_event(db: Session, viewer_id: int, event_id: int, include_own: bool = False) -> UserEvent | None:
    """An event the viewer may see. Reactions are for other trainers' events; comments also go under your own."""
    return shareable_events(db, viewer_id, include_own).filter(UserEvent.id == event_id).first()


def add_reaction(db: Session, event_id: int, user_id: int, kind: str) -> bool:
    """Idempotent: returns True when the reaction is new."""
    if db.query(EventReaction.id).filter_by(event_id=event_id, user_id=user_id, kind=kind).first():
        return False
    try:
        with db.begin_nested():
            db.add(EventReaction(event_id=event_id, user_id=user_id, kind=kind, created_at=datetime.datetime.utcnow()))
        return True
    except IntegrityError:
        return False


def remove_reaction(db: Session, event_id: int, user_id: int, kind: str) -> bool:
    return bool(
        db.query(EventReaction).filter_by(event_id=event_id, user_id=user_id, kind=kind).delete(
            synchronize_session=False
        )
    )


def clean_comment(text) -> str:
    """Plain text, trimmed. Raises ValueError when it is empty or longer than COMMENT_MAX_LENGTH."""
    cleaned = str(text or "").strip()
    if not cleaned:
        raise ValueError("A comment cannot be empty")
    if len(cleaned) > COMMENT_MAX_LENGTH:
        raise ValueError(f"A comment can have at most {COMMENT_MAX_LENGTH} characters")
    return cleaned


def serialize_comment(comment: EventComment, author: User | None, viewer_id: int, event_owner_id: int) -> dict:
    return {
        "id": comment.id,
        "event_id": comment.event_id,
        "text": comment.text,
        "created_at": comment.created_at.isoformat() if comment.created_at else None,
        "author": {
            "id": comment.user_id,
            "username": author.username if author else None,
            "avatar_id": author.avatar_id if author else None,
        },
        "mine": comment.user_id == viewer_id,
        "can_delete": comment.user_id == viewer_id or event_owner_id == viewer_id,
    }


def list_comments(db: Session, event: UserEvent, viewer_id: int) -> list[dict]:
    """Oldest first, so a thread reads top to bottom. Comments by deactivated trainers are left out."""
    rows = (
        db.query(EventComment, User)
        .join(User, User.id == EventComment.user_id)
        .filter(EventComment.event_id == event.id, User.is_active == True)  # noqa: E712
        .order_by(EventComment.created_at.asc(), EventComment.id.asc())
        .limit(MAX_COMMENTS_SHOWN)
        .all()
    )
    return [serialize_comment(comment, author, viewer_id, event.user_id) for comment, author in rows]


def add_comment(db: Session, event: UserEvent, user_id: int, text: str) -> EventComment:
    comment = EventComment(
        event_id=event.id, user_id=user_id, text=clean_comment(text), created_at=datetime.datetime.utcnow()
    )
    db.add(comment)
    db.flush()
    return comment


def delete_comment(db: Session, event: UserEvent, comment_id: int, viewer_id: int) -> str:
    """'deleted', 'missing' or 'forbidden'. The author or the event's owner may delete."""
    comment = db.query(EventComment).filter_by(id=comment_id, event_id=event.id).first()
    if comment is None:
        return "missing"
    if comment.user_id != viewer_id and event.user_id != viewer_id:
        return "forbidden"
    db.delete(comment)
    return "deleted"
