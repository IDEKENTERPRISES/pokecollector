"""Progress evaluator: achievements, completed sets and big pulls for one user."""
import datetime
import logging

from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import (
    Card,
    CollectionItem,
    ProgressState,
    Set,
    User,
    UserAchievement,
    UserEvent,
)
from services.card_values import effective_market_price
from services.digital_sets import digital_sets_enabled
from services.progress.state import BIG_PULL_EUR, BIG_PULL_MAX_AGE, DIRTY_BATCH_SIZE, _now, mark_users_dirty
from services.tcgdex_languages import has_lang_suffix

logger = logging.getLogger(__name__)

EVENT_SET_COMPLETED = "set_completed"
EVENT_ACHIEVEMENT_UNLOCKED = "achievement_unlocked"
EVENT_BIG_PULL = "big_pull"
EVENT_GOAL_COMPLETED = "goal_completed"


def record_event(
    db: Session,
    user_id: int,
    kind: str,
    dedupe_key: str,
    subject_key: str | None = None,
    payload: dict | None = None,
    occurred_at: datetime.datetime | None = None,
) -> bool:
    """Insert a user event unless its dedupe_key already exists. Returns True if new."""
    exists = db.query(UserEvent.id).filter(
        UserEvent.user_id == user_id, UserEvent.dedupe_key == dedupe_key
    ).first()
    if exists:
        return False
    try:
        with db.begin_nested():
            db.add(UserEvent(
                user_id=user_id,
                kind=kind,
                occurred_at=occurred_at or _now(),
                subject_key=subject_key,
                payload=payload or {},
                dedupe_key=dedupe_key,
            ))
        return True
    except IntegrityError:
        return False


def _set_key(set_id: str, lang: str) -> str:
    return set_id if has_lang_suffix(set_id) else f"{set_id}_{lang}"


def _completed_sets(db: Session, user_id: int) -> dict[str, dict]:
    """Complete set keys mapped to payload info, counted like _load_user_stats."""
    owned_query = db.query(Card.set_id, Card.lang, Card.id).join(
        CollectionItem, CollectionItem.card_id == Card.id
    ).filter(
        CollectionItem.user_id == user_id,
        Card.is_custom == False,  # noqa: E712
        Card.set_id.isnot(None),
    )
    if not digital_sets_enabled(db):
        owned_query = owned_query.filter(Card.is_digital == False)  # noqa: E712
    owned: dict[tuple, set] = {}
    for set_id, lang, card_id in owned_query.distinct().all():
        owned.setdefault((set_id, lang), set()).add(card_id)
    if not owned:
        return {}

    set_ids = {set_id for set_id, _ in owned}
    sizes = {
        (row.set_id, row.lang): row.card_count
        for row in db.query(Card.set_id, Card.lang, func.count(Card.id).label("card_count")).filter(
            Card.set_id.in_(set_ids), Card.is_custom == False  # noqa: E712
        ).group_by(Card.set_id, Card.lang).all()
    }
    names = {
        (row.tcg_set_id, row.lang): row.name
        for row in db.query(Set.tcg_set_id, Set.lang, Set.name).filter(Set.tcg_set_id.in_(set_ids)).all()
    }
    complete = {}
    for (set_id, lang), cards in owned.items():
        total = sizes.get((set_id, lang), 0)
        if total > 0 and len(cards) >= total:
            complete[_set_key(set_id, lang)] = {
                "set_name": names.get((set_id, lang)) or set_id,
                "lang": lang,
                "total": total,
            }
    return complete


def _evaluate_achievements(
    db: Session, user_id: int, stats: dict, first: bool, known_version: int, now
) -> list[str]:
    """Insert rows for newly reached badges. Returns the ids that deserve a celebration.

    Badges unlock silently (backfilled, already seen) on the first evaluation, and, after the
    registry grew, for the entries added since the version this trainer's state was last at.
    """
    from services.achievements import registry

    have = {
        row.achievement_id
        for row in db.query(UserAchievement.achievement_id).filter(UserAchievement.user_id == user_id)
    }
    celebrate: list[str] = []
    for config in registry():
        if config["id"] in have:
            continue
        if (stats.get(config["metric"]) or 0) < config["target"]:
            continue
        silent = first or config.get("since", 1) > known_version
        db.add(UserAchievement(
            user_id=user_id,
            achievement_id=config["id"],
            unlocked_at=now,
            seen_at=now if silent else None,
            backfilled=silent,
        ))
        if not silent:
            celebrate.append(config["id"])
            record_event(
                db, user_id, EVENT_ACHIEVEMENT_UNLOCKED,
                dedupe_key=f"{EVENT_ACHIEVEMENT_UNLOCKED}:{config['id']}",
                subject_key=config["id"],
                payload={"achievement_id": config["id"], "badge_id": config.get("badge_id"),
                         "name_key": config.get("name_key"), "tier": config.get("tier"),
                         "track": config.get("track")},
                occurred_at=now,
            )
    db.flush()
    return celebrate


def _push_unlocks(db: Session, user_id: int, achievement_ids: list[str], now) -> None:
    """One push per genuine unlock, naming the badge unless the trainer chose content-light; never for backfills."""
    from services import notifications

    for achievement_id in achievement_ids:
        try:
            with db.begin_nested():
                queued = notifications.enqueue(
                    db, user_id, "badges", f"badge:{achievement_id}", now=now,
                    details={"badge_id": achievement_id},
                )
                if queued:
                    db.query(UserAchievement).filter_by(
                        user_id=user_id, achievement_id=achievement_id
                    ).update({"notified_at": now})
        except Exception:
            logger.exception("Could not queue the badge push for user %s", user_id)


def _evaluate_sets(db: Session, user_id: int, state: ProgressState, first: bool, now) -> None:
    complete = _completed_sets(db, user_id)
    known = set(state.completed_sets or [])
    if not first:
        for key in sorted(set(complete) - known):
            record_event(
                db, user_id, EVENT_SET_COMPLETED,
                # Once per set ever: a set that flaps complete/incomplete stays quiet.
                dedupe_key=f"{EVENT_SET_COMPLETED}:{key}",
                subject_key=key, payload=complete[key], occurred_at=now,
            )
    state.completed_sets = sorted(complete)


def _evaluate_big_pulls(
    db: Session, user_id: int, state: ProgressState, price_field: str, first: bool, now
) -> None:
    last_seen = state.last_seen_collection_id or 0
    max_id = db.query(func.max(CollectionItem.id)).filter(CollectionItem.user_id == user_id).scalar() or 0
    if not first:
        cutoff = now - BIG_PULL_MAX_AGE
        rows = db.query(CollectionItem, Card).join(Card, CollectionItem.card_id == Card.id).filter(
            CollectionItem.user_id == user_id,
            CollectionItem.id > last_seen,
        ).order_by(CollectionItem.id.asc()).all()
        for item, card in rows:
            if item.added_at is not None and item.added_at < cutoff:
                continue
            price = effective_market_price(card, item.variant, price_field)
            if price is None or price < BIG_PULL_EUR:
                continue
            record_event(
                db, user_id, EVENT_BIG_PULL,
                dedupe_key=f"{EVENT_BIG_PULL}:{item.id}",
                subject_key=str(item.id),
                payload={"card_id": card.id, "name": card.name, "variant": item.variant},
                occurred_at=now,
            )
    state.last_seen_collection_id = max(last_seen, max_id)


def _evaluate_daily(db: Session, user_id: int) -> None:
    """Quests for today and yesterday, streak XP, and XP for badges and finished sets (all idempotent)."""
    from services.achievements import registry_by_id
    from services.progress import xp
    from services.progress.daily import award_streak_xp, local_today, sync_daily, user_streak, user_zone

    today = local_today(user_zone(db, user_id))
    for day in (today - datetime.timedelta(days=1), today):
        sync_daily(db, user_id, day)
    award_streak_xp(db, user_id, user_streak(db, user_id, today))
    known = registry_by_id()
    for (achievement_id,) in db.query(UserAchievement.achievement_id).filter(UserAchievement.user_id == user_id):
        config = known.get(achievement_id)
        if config:
            xp.award(db, user_id, xp.SOURCE_BADGE, achievement_id, xp.BADGE_XP.get(config.get("tier"), 20))
    for set_key in _completed_sets(db, user_id):
        xp.award(db, user_id, xp.SOURCE_SET, set_key, xp.SET_XP)
    db.flush()


def _evaluate_goals(db: Session, user_id: int, now) -> None:
    """Goal milestones; a failing goal never blocks the rest of the evaluation."""
    from services import goals

    try:
        with db.begin_nested():
            goals.evaluate_goals(db, user_id, now)
    except Exception:
        logger.exception("Goal evaluation failed for user %s", user_id)


def _evaluate_challenge(db: Session, user_id: int, now) -> None:
    """The weekly challenge count; a failure here never blocks the rest of the evaluation."""
    from services import challenge

    try:
        with db.begin_nested():
            challenge.update_progress(db, user_id, now)
    except Exception:
        logger.exception("Challenge progress failed for user %s", user_id)


def evaluate_user(db: Session, user_id: int) -> bool:
    """Evaluate one user in a single transaction. Returns False if the user is gone."""
    from api.social import _load_user_stats  # lazy, not moved: keeps the upstream diff small
    from services.sync_service import _user_price_field

    started = _now()
    try:
        state = db.get(ProgressState, user_id)
        if state is not None:
            db.refresh(state)
        first = state is None or state.evaluated_at is None
        user = db.query(User).filter(User.id == user_id, User.is_active == True).first()  # noqa: E712
        if user is None:
            db.rollback()
            return False
        if state is None:
            state = ProgressState(
                user_id=user_id, completed_sets=[], last_seen_collection_id=0, state_version=1
            )
            db.add(state)
        known_version = state.state_version or 1

        price_field = _user_price_field(db, user_id)
        stats = _load_user_stats(db, [user_id], price_field).get(user_id) or {}
        from services.achievements import REGISTRY_VERSION, metrics_for

        stats = metrics_for(db, user_id, stats)
        celebrate = _evaluate_achievements(db, user_id, stats, first, known_version, started)
        _push_unlocks(db, user_id, celebrate, started)
        state.state_version = max(known_version, REGISTRY_VERSION)
        _evaluate_sets(db, user_id, state, first, started)
        _evaluate_big_pulls(db, user_id, state, price_field, first, started)
        _evaluate_daily(db, user_id)
        _evaluate_goals(db, user_id, started)
        _evaluate_challenge(db, user_id, started)

        state.evaluated_at = started
        db.flush()
        # Clear the flag in SQL, only if nothing marked the user dirty after we started: the
        # listener may have committed a newer dirty_at in another transaction meanwhile.
        db.execute(
            update(ProgressState)
            .where(ProgressState.user_id == user_id, ProgressState.dirty_at <= started)
            .values(dirty_at=None)
            .execution_options(synchronize_session=False)
        )
        db.commit()
        return True
    except Exception:
        db.rollback()
        raise


def evaluate_users(db: Session, user_ids) -> int:
    """Evaluate several users; one user's failure never blocks the others."""
    done = 0
    for user_id in user_ids:
        try:
            if evaluate_user(db, user_id):
                done += 1
        except Exception:
            db.rollback()
            logger.exception("Progress evaluation failed for user %s", user_id)
            _requeue_failed_user(db, user_id)
    return done


def _requeue_failed_user(db: Session, user_id: int) -> None:
    """Send a failing user to the back of the queue so it cannot starve the others."""
    try:
        with Session(bind=db.get_bind()) as fresh:
            mark_users_dirty(fresh, [user_id])
    except Exception:
        logger.exception("Could not requeue user %s after a failed evaluation", user_id)


def evaluate_dirty_users(db: Session, limit: int = DIRTY_BATCH_SIZE) -> int:
    ids = [
        user_id for (user_id,) in db.query(ProgressState.user_id)
        .filter(ProgressState.dirty_at.isnot(None))
        .order_by(ProgressState.dirty_at.asc()).limit(limit).all()
    ]
    return evaluate_users(db, ids)
