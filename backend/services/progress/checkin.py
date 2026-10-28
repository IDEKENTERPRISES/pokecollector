"""Daily check-in: stores the phone's time zone and the local days the app was opened."""
import datetime
import logging
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

from models import UserDailyActivity, UserSetting

logger = logging.getLogger(__name__)

MAX_DATES = 14
MAX_AGE_DAYS = 14
TIME_ZONE_KEY = "time_zone"


class CheckinError(ValueError):
    """The check-in payload was invalid."""


def validate_time_zone(name) -> ZoneInfo:
    if not isinstance(name, str) or not name.strip() or len(name) > 64:
        raise CheckinError("time_zone must be an IANA time zone name")
    try:
        return ZoneInfo(name.strip())
    except (ZoneInfoNotFoundError, ValueError, OSError):
        raise CheckinError("time_zone must be an IANA time zone name")


def parse_dates(values, today_utc: datetime.date) -> list[datetime.date]:
    if not isinstance(values, list) or not values:
        raise CheckinError("dates must be a non-empty list")
    if len(values) > MAX_DATES:
        raise CheckinError(f"at most {MAX_DATES} dates are accepted")
    dates = set()
    for value in values:
        try:
            parsed = datetime.date.fromisoformat(value)
        except (TypeError, ValueError):
            raise CheckinError("dates must be YYYY-MM-DD")
        # One day of slack for time zones ahead of UTC.
        if parsed > today_utc + datetime.timedelta(days=1):
            raise CheckinError("dates cannot be in the future")
        if parsed < today_utc - datetime.timedelta(days=MAX_AGE_DAYS):
            raise CheckinError(f"dates cannot be older than {MAX_AGE_DAYS} days")
        dates.add(parsed)
    return sorted(dates)


def record_checkin(
    db: Session, user_id: int, time_zone, date_values, now: datetime.datetime | None = None
) -> dict:
    now = now or datetime.datetime.utcnow()
    zone = validate_time_zone(time_zone)
    dates = parse_dates(date_values, now.date())
    today_local = now.replace(tzinfo=datetime.timezone.utc).astimezone(zone).date()

    setting = db.query(UserSetting).filter(
        UserSetting.user_id == user_id, UserSetting.key == TIME_ZONE_KEY
    ).first()
    if setting is None:
        db.add(UserSetting(user_id=user_id, key=TIME_ZONE_KEY, value=zone.key))
    else:
        setting.value = zone.key

    existing = {
        row.local_date: row
        for row in db.query(UserDailyActivity).filter(
            UserDailyActivity.user_id == user_id, UserDailyActivity.local_date.in_(dates)
        ).all()
    }
    for local_date in dates:
        row = existing.get(local_date)
        is_today = local_date == today_local
        if row is None:
            db.add(UserDailyActivity(
                user_id=user_id, local_date=local_date, first_seen_at=now, last_seen_at=now,
                opens=1, offline=not is_today, data={},
            ))
        elif is_today:
            row.opens = (row.opens or 0) + 1
            row.last_seen_at = now
    db.flush()
    days_recorded = db.query(UserDailyActivity).filter(UserDailyActivity.user_id == user_id).count()
    db.commit()
    return {"local_date": today_local.isoformat(), "days_recorded": days_recorded}
