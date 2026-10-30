"""The weekly challenge (docs/SOCIAL_DESIGN.md §7): one goal a week for every trainer, counted from data.

The week runs Monday 00:00 to Sunday 23:59 in UK time (Europe/London, so BST and GMT), one deadline for
everyone. The podium is the highest count by Sunday night, ties to whoever reached that count first;
everyone who reaches the target still earns the finisher badge and XP. Progress is counted by the progress
evaluator for dirty trainers; a scheduler job closes the week just after Monday 00:00 and can be run any
time later (after downtime) because it only acts on weeks that are over and not yet closed.

Functions here do not commit unless named `close_*`.
"""
from __future__ import annotations

import datetime
import hashlib
import logging
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import (
    Binder,
    BinderCard,
    Card,
    ChallengeProgress,
    ChallengeWeek,
    CollectionItem,
    User,
    UserAchievement,
    UserDailyActivity,
    UserSetting,
)

logger = logging.getLogger(__name__)

TIME_ZONE_NAME = "Europe/London"
UK = ZoneInfo(TIME_ZONE_NAME)
UTC = datetime.timezone.utc

FINISHER_XP = 50
PODIUM_PLACES = 3
# The result card shows from Monday 00:00 to Tuesday 23:59 (UK).
RESULT_DAYS = 2
EVENT_CHALLENGE_FINISHED = "challenge_finished"

ON_BOARD_KEY = "challenge_on_board"
BADGE_FAMILY = "challenge"
# Challenges finished -> badge id; the entries live in services/achievements.py.
BADGE_STEPS = ((1, "challenge_1"), (5, "challenge_5"), (20, "challenge_20"))


def boolean_keys() -> set[str]:
    return {ON_BOARD_KEY}


def default_settings() -> dict[str, str]:
    return {ON_BOARD_KEY: "true"}


# --- the week -------------------------------------------------------------------------------


@dataclass(frozen=True)
class Week:
    key: str  # "2026-W44"
    monday: datetime.date  # the UK-time Monday
    start: datetime.datetime  # naive UTC, inclusive
    end: datetime.datetime  # naive UTC, exclusive: the next Monday 00:00 UK

    @property
    def sunday(self) -> datetime.date:
        return self.monday + datetime.timedelta(days=6)

    @property
    def index(self) -> int:
        """Weeks since Monday 1970-01-05."""
        return (self.monday - datetime.date(1970, 1, 5)).days // 7

    def previous(self) -> "Week":
        return week_of_monday(self.monday - datetime.timedelta(days=7))


def _utc_naive(day: datetime.date) -> datetime.datetime:
    local = datetime.datetime(day.year, day.month, day.day, tzinfo=UK)
    return local.astimezone(UTC).replace(tzinfo=None)


def week_of_monday(monday: datetime.date) -> Week:
    iso = monday.isocalendar()
    return Week(
        key=f"{iso[0]}-W{iso[1]:02d}", monday=monday,
        start=_utc_naive(monday), end=_utc_naive(monday + datetime.timedelta(days=7)),
    )


def week_at(now: datetime.datetime) -> Week:
    """The UK-time week a naive UTC instant falls in."""
    local = now.replace(tzinfo=UTC).astimezone(UK).date()
    return week_of_monday(local - datetime.timedelta(days=local.weekday()))


def week_by_key(key: str) -> Week:
    year, _, number = key.partition("-W")
    return week_of_monday(datetime.date.fromisocalendar(int(year), int(number), 1))


def _aware(value: datetime.datetime | None) -> str | None:
    """A stored naive UTC time as an ISO string with its UK offset."""
    if value is None:
        return None
    return value.replace(tzinfo=UTC).astimezone(UK).isoformat()


# --- the catalogue ----------------------------------------------------------------------------
#
# Every goal is something effort buys, not money: it needs the trainer to do a thing on several days
# or to sort cards they already own, and it asks for about the same effort from a collection of 30
# cards as from one of 3,000. Cards added alone is left out on purpose: a purchase would win it.


def _eligible_added(db: Session, user_id: int, week: Week):
    """Collection rows added this week, leaving out old collections brought in (acquired before the week)."""
    return db.query(CollectionItem.card_id, CollectionItem.acquired_at).filter(
        CollectionItem.user_id == user_id, CollectionItem.card_id.isnot(None),
        CollectionItem.added_at >= week.start, CollectionItem.added_at < week.end,
    ).all()


def _new_cards(db: Session, user_id: int, week: Week) -> set[str]:
    return {
        card_id for card_id, acquired in _eligible_added(db, user_id, week)
        if acquired is None or acquired >= week.start
    }


def _count_binder_cards(db: Session, user_id: int, week: Week) -> int:
    return db.query(BinderCard.id).join(Binder, Binder.id == BinderCard.binder_id).filter(
        Binder.user_id == user_id, Binder.binder_type.notin_(("deck", "physical_deck")),
        BinderCard.added_at >= week.start, BinderCard.added_at < week.end,
    ).count()


def _activity_rows(db: Session, user_id: int, week: Week):
    return db.query(UserDailyActivity).filter(
        UserDailyActivity.user_id == user_id,
        UserDailyActivity.local_date >= week.monday, UserDailyActivity.local_date <= week.sunday,
    ).all()


def _count_open_days(db: Session, user_id: int, week: Week) -> int:
    return len(_activity_rows(db, user_id, week))


def _count_quests(db: Session, user_id: int, week: Week) -> int:
    total = 0
    for row in _activity_rows(db, user_id, week):
        total += len(((row.data or {}).get("quests") or {}).get("done") or [])
    return total


def _count_wtp_days(db: Session, user_id: int, week: Week) -> int:
    return sum(1 for row in _activity_rows(db, user_id, week) if (row.data or {}).get("wtp"))


def _count_new_species(db: Session, user_id: int, week: Week) -> int:
    """Pokédex entries on cards added this week that none of the trainer's earlier cards had."""
    from services.pokedex import normalize_dex_ids

    added = _new_cards(db, user_id, week)
    if not added:
        return 0
    fresh: set[int] = set()
    for (dex_ids,) in db.query(Card.dex_ids).filter(Card.id.in_(added), Card.is_custom == False):  # noqa: E712
        fresh.update(normalize_dex_ids(dex_ids))
    if not fresh:
        return 0
    known: set[int] = set()
    for (dex_ids,) in db.query(Card.dex_ids).join(CollectionItem, CollectionItem.card_id == Card.id).filter(
        CollectionItem.user_id == user_id, CollectionItem.added_at < week.start, Card.is_custom == False,  # noqa: E712
    ).yield_per(1000):
        known.update(normalize_dex_ids(dex_ids))
        if fresh <= known:
            return 0
    return len(fresh - known)


def _count_sets_touched(db: Session, user_id: int, week: Week) -> int:
    added = _new_cards(db, user_id, week)
    if not added:
        return 0
    return len({
        (set_id, lang) for set_id, lang in db.query(Card.set_id, Card.lang).filter(
            Card.id.in_(added), Card.is_custom == False, Card.set_id.isnot(None))  # noqa: E712
    })


# id, target, tile type (an energy type the app already has a gradient for), counter.
# The strings live in en.js under `challenge.<id>`; P13b adds them with the screens.
CATALOGUE = (
    {"id": "binder_cards", "target": 15, "type": "water", "count": _count_binder_cards},
    {"id": "open_days", "target": 5, "type": "fire", "count": _count_open_days},
    {"id": "quests_done", "target": 8, "type": "grass", "count": _count_quests},
    {"id": "wtp_days", "target": 4, "type": "psychic", "count": _count_wtp_days},
    {"id": "new_species", "target": 5, "type": "lightning", "count": _count_new_species},
    {"id": "sets_touched", "target": 3, "type": "dragon", "count": _count_sets_touched},
)
CATALOGUE_BY_ID = {entry["id"]: entry for entry in CATALOGUE}


def _block_order(block: int) -> list[str]:
    ids = [entry["id"] for entry in CATALOGUE]
    return sorted(ids, key=lambda cid: hashlib.sha256(f"challenge:{block}:{cid}".encode()).hexdigest())


def challenge_id_for(week: Week) -> str:
    """The same challenge for a week on every machine. The weeks are dealt in shuffled rounds of the whole
    catalogue, so every goal comes round once per round and none repeats two weeks running: when a round
    would open with the goal the last one ended on, its first two swap."""
    size = len(CATALOGUE)
    block, offset = divmod(week.index, size)
    order = _block_order(block)
    if block > 0 and order[0] == _block_order(block - 1)[-1]:
        order[0], order[1] = order[1], order[0]
    return order[offset]


def challenge_dict(challenge_id: str) -> dict:
    entry = CATALOGUE_BY_ID[challenge_id]
    return {
        "id": entry["id"], "title_key": f"challenge.{entry['id']}", "target": entry["target"], "type": entry["type"],
    }


def count_progress(db: Session, user_id: int, week: Week, challenge_id: str) -> int:
    return int(CATALOGUE_BY_ID[challenge_id]["count"](db, user_id, week))


# --- who takes part ---------------------------------------------------------------------------


def on_board(db: Session, user_id: int) -> bool:
    row = db.query(UserSetting.value).filter(UserSetting.user_id == user_id, UserSetting.key == ON_BOARD_KEY).first()
    return not (row and str(row[0]).strip().lower() in {"false", "0", "no", "off"})


def _off_board_ids(db: Session) -> set[int]:
    return {
        user_id for user_id, value in db.query(UserSetting.user_id, UserSetting.value).filter(
            UserSetting.key == ON_BOARD_KEY)
        if str(value).strip().lower() in {"false", "0", "no", "off"}
    }


def ensure_week(db: Session, week: Week) -> ChallengeWeek:
    """The week's row, created with the deterministic pick. A stored pick wins, so a later catalogue edit never
    changes a week that has begun."""
    row = db.get(ChallengeWeek, week.key)
    if row is not None:
        return row
    try:
        with db.begin_nested():
            row = ChallengeWeek(week=week.key, challenge_id=challenge_id_for(week), trainer_count=0, finished_count=0)
            db.add(row)
    except IntegrityError:
        row = db.get(ChallengeWeek, week.key)
    return row


def _stored_challenge(row: ChallengeWeek, week: Week) -> str:
    return row.challenge_id if row.challenge_id in CATALOGUE_BY_ID else challenge_id_for(week)


# --- progress ---------------------------------------------------------------------------------


def _apply_count(db: Session, user_id: int, week: Week, challenge_id: str, now: datetime.datetime):
    """Store the trainer's count for the week. Rows exist only once there is something to count, and a count
    that changes (up or down) gets a new `reached_at`, capped at the week's end."""
    progress = count_progress(db, user_id, week, challenge_id)
    row = db.query(ChallengeProgress).filter_by(week=week.key, user_id=user_id).first()
    if row is None:
        if progress <= 0:
            return None
        row = ChallengeProgress(week=week.key, user_id=user_id, progress=0)
        db.add(row)
    stamp = min(now, week.end)
    if row.progress != progress or row.reached_at is None and progress > 0:
        row.progress = progress
        row.reached_at = stamp if progress > 0 else None
    target = CATALOGUE_BY_ID[challenge_id]["target"]
    if row.finished_at is None and progress >= target:
        row.finished_at = row.reached_at or stamp
    return row


def update_progress(db: Session, user_id: int, now: datetime.datetime | None = None) -> bool:
    """Evaluator hook: refresh this trainer's count for the current week. Returns False when they don't take part
    (social off, single-user mode, or not an active trainer)."""
    from services.social_feature import social_enabled

    now = now or datetime.datetime.utcnow()
    if not db.query(User.id).filter(User.id == user_id, User.is_active == True).first():  # noqa: E712
        return False
    if not social_enabled(db):
        return False
    week = week_at(now)
    row = ensure_week(db, week)
    _apply_count(db, user_id, week, _stored_challenge(row, week), now)
    db.flush()
    return True


# --- closing the week ---------------------------------------------------------------------------


def _ranked(rows, off_board: set[int]):
    """Podium order: highest count, then reached first, then the older account. Off-board and empty rows don't place."""
    far = datetime.datetime.max
    return sorted(
        (r for r in rows if r.progress > 0 and r.user_id not in off_board),
        key=lambda r: (-r.progress, r.reached_at or far, r.user_id),
    )


def close_week(db: Session, week: Week, now: datetime.datetime | None = None) -> bool:
    """Close one finished week once: recount everybody, store the places, give finishers XP, an event and a
    badge check. Returns False when it was already closed. Commits."""
    from services.progress import xp
    from services.progress.evaluator import record_event
    from services.progress.state import _upsert_dirty

    now = now or datetime.datetime.utcnow()
    if week.end > now:
        return False
    row = ensure_week(db, week)
    if row.closed_at is not None:
        return False
    challenge_id = _stored_challenge(row, week)
    target = CATALOGUE_BY_ID[challenge_id]["target"]
    off_board = _off_board_ids(db)

    trainers = [uid for (uid,) in db.query(User.id).filter(User.is_active == True)]  # noqa: E712
    for user_id in trainers:
        _apply_count(db, user_id, week, challenge_id, now)
    db.flush()

    rows = db.query(ChallengeProgress).filter(
        ChallengeProgress.week == week.key, ChallengeProgress.user_id.in_(trainers)).all()
    for place, entry in enumerate(_ranked(rows, off_board)[:PODIUM_PLACES], start=1):
        entry.place = place
    finishers = [r for r in rows if r.finished_at is not None]
    for entry in sorted(finishers, key=lambda r: (r.finished_at, r.user_id)):
        xp.award(db, entry.user_id, xp.SOURCE_CHALLENGE, week.key, FINISHER_XP)
        if entry.user_id not in off_board:
            record_event(
                db, entry.user_id, EVENT_CHALLENGE_FINISHED,
                dedupe_key=f"{EVENT_CHALLENGE_FINISHED}:{week.key}", subject_key=week.key,
                payload={"week": week.key, "challenge_id": challenge_id,
                         "title_key": f"challenge.{challenge_id}", "place": entry.place},
                occurred_at=min(entry.finished_at, week.end),
            )
    # The badge family counts closed weeks, so the evaluator grants it (and its unlock sheet and push) on its next pass.
    if finishers:
        _upsert_dirty(db, sorted({r.user_id for r in finishers}), now)
    row.trainer_count = len([uid for uid in trainers if uid not in off_board])
    row.finished_count = len([r for r in finishers if r.user_id not in off_board])
    row.closed_at = now
    db.commit()
    return True


def weeks_to_close(db: Session, now: datetime.datetime) -> list[Week]:
    """Finished weeks without a closed row: last week always, and older ones that still hold progress."""
    current = week_at(now)
    keys = {current.previous().key}
    keys |= {key for (key,) in db.query(ChallengeProgress.week).distinct() if key < current.key}
    closed = {key for (key,) in db.query(ChallengeWeek.week).filter(ChallengeWeek.closed_at.isnot(None))}
    return sorted((week_by_key(k) for k in keys - closed), key=lambda w: w.monday)


def close_due_weeks(db: Session, now: datetime.datetime | None = None) -> int:
    """Scheduler entry point: idempotent, and catches up after downtime. Does nothing while social is off."""
    from services.social_feature import social_enabled

    now = now or datetime.datetime.utcnow()
    if not social_enabled(db):
        return 0
    closed = 0
    for week in weeks_to_close(db, now):
        try:
            if close_week(db, week, now):
                closed += 1
        except Exception:
            db.rollback()
            logger.exception("Could not close challenge week %s", week.key)
    return closed


# --- badges -------------------------------------------------------------------------------------


def finished_count(db: Session, user_id: int) -> int:
    """Challenges the trainer finished in weeks that have closed (the metric of the `challenge` badges)."""
    return db.query(ChallengeProgress.id).join(ChallengeWeek, ChallengeWeek.week == ChallengeProgress.week).filter(
        ChallengeProgress.user_id == user_id, ChallengeProgress.finished_at.isnot(None),
        ChallengeWeek.closed_at.isnot(None),
    ).count()


# --- the API ------------------------------------------------------------------------------------


def _trainer(user: User) -> dict:
    return {"id": user.id, "username": user.username, "avatar_id": user.avatar_id}


def _entry(row: ChallengeProgress, user: User, place) -> dict:
    return {
        "user": _trainer(user), "progress": row.progress,
        "finished_at": _aware(row.finished_at), "place": place,
    }


def _me(row: ChallengeProgress | None, place, is_on_board: bool) -> dict:
    return {
        "progress": row.progress if row else 0,
        "finished_at": _aware(row.finished_at) if row else None,
        "place": place, "on_board": is_on_board,
    }


def _last_badge(db: Session, user_id: int, finished_last: bool):
    """The badge step the just-closed week completed for this trainer, when it did."""
    if not finished_last:
        return None
    total = finished_count(db, user_id)
    from services.achievements import registry_by_id

    for steps, badge_id in BADGE_STEPS:
        if total == steps:
            config = registry_by_id().get(badge_id)
            held = db.query(UserAchievement.id).filter_by(user_id=user_id, achievement_id=badge_id).first()
            if config and held:
                return {"id": badge_id, "tier": config["tier"]}
    return None


def _last_result(db: Session, user_id: int, week: Week, is_on_board: bool) -> dict | None:
    row = db.get(ChallengeWeek, week.key)
    if row is None or row.closed_at is None:
        return None
    challenge_id = _stored_challenge(row, week)
    rows = db.query(ChallengeProgress).filter_by(week=week.key).all()
    users = {u.id: u for u in db.query(User).filter(User.id.in_({r.user_id for r in rows}), User.is_active == True)}  # noqa: E712
    podium = [
        _entry(r, users[r.user_id], r.place)
        for r in sorted((r for r in rows if r.place and r.user_id in users), key=lambda r: r.place)
    ]
    mine = next((r for r in rows if r.user_id == user_id), None)
    return {
        "week": week.key, "challenge": challenge_dict(challenge_id), "podium": podium,
        "me": _me(mine, mine.place if mine else None, is_on_board),
        "finished_count": row.finished_count, "trainer_count": row.trainer_count,
        "badge": _last_badge(db, user_id, bool(mine and mine.finished_at)),
    }


def challenge_view(db: Session, viewer_id: int, now: datetime.datetime | None = None) -> dict:
    now = now or datetime.datetime.utcnow()
    week = week_at(now)
    row = ensure_week(db, week)
    challenge_id = _stored_challenge(row, week)
    off_board = _off_board_ids(db)
    users = {u.id: u for u in db.query(User).filter(User.is_active == True)}  # noqa: E712
    rows = {r.user_id: r for r in db.query(ChallengeProgress).filter_by(week=week.key) if r.user_id in users}

    # The viewer's own count is refreshed on read, so it is right even before the evaluator's next pass.
    if viewer_id in users:
        fresh = _apply_count(db, viewer_id, week, challenge_id, now)
        if fresh is not None:
            rows[viewer_id] = fresh
    standings = _ranked(rows.values(), off_board)
    places = {r.user_id: i for i, r in enumerate(standings[:PODIUM_PLACES], start=1)}

    visible = [uid for uid in users if uid not in off_board]
    far = datetime.datetime.max
    order = sorted(visible, key=lambda uid: (
        -(rows[uid].progress if uid in rows else 0), (rows[uid].reached_at if uid in rows else None) or far,
        users[uid].username.lower(), uid))
    board = []
    for uid in order:
        r = rows.get(uid)
        if r is None:
            r = ChallengeProgress(week=week.key, user_id=uid, progress=0)
        board.append(_entry(r, users[uid], places.get(uid)))
    me_on_board = viewer_id not in off_board
    previous = week.previous()
    local = now.replace(tzinfo=UTC).astimezone(UK).date()
    in_result_window = (local - week.monday).days < RESULT_DAYS
    result = {
        "week": week.key,
        "starts_at": _aware(week.start), "ends_at": _aware(week.end - datetime.timedelta(minutes=1)),
        "time_zone": TIME_ZONE_NAME,
        "challenge": challenge_dict(challenge_id),
        "me": _me(rows.get(viewer_id), places.get(viewer_id), me_on_board),
        "board": board,
        "finished_count": len([uid for uid in visible if uid in rows and rows[uid].finished_at is not None]),
        "trainer_count": len(visible),
        "last": _last_result(db, viewer_id, previous, me_on_board) if in_result_window else None,
    }
    db.commit()
    return result
