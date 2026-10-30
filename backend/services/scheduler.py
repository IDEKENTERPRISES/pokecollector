from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.date import DateTrigger
import logging
import datetime
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)
# Give the persistent scan queue a short recovery window without changing other jobs.
scheduler = BackgroundScheduler()
_SCAN_QUEUE_MISFIRE_GRACE_SECONDS = 60
# Progress evaluation and the notification flush only act on dirty users / due rows,
# so a short interval is cheap and makes a badge or push land within seconds.
_PROGRESS_NOTIFICATION_INTERVAL_SECONDS = 30

_DEFAULT_FULL_SYNC_DAYS = 5
_DEFAULT_PRICE_SYNC_MINUTES = 30


def _get_full_sync_interval_days() -> int:
    """Read full sync interval from DB settings."""
    try:
        from database import SessionLocal
        from models import Setting
        with SessionLocal() as db:
            row = db.query(Setting).filter(Setting.key == "full_sync_interval_days").first()
            if row:
                return int(row.value)
    except Exception:
        pass
    return _DEFAULT_FULL_SYNC_DAYS


def _get_price_sync_interval_minutes() -> int:
    """Read price sync interval from DB settings."""
    try:
        from database import SessionLocal
        from models import Setting
        with SessionLocal() as db:
            row = db.query(Setting).filter(Setting.key == "price_sync_interval_minutes").first()
            if row:
                return int(row.value)
    except Exception:
        pass
    return _DEFAULT_PRICE_SYNC_MINUTES


def run_full_sync():
    """Full sync job — syncs sets + cards + prices."""
    from database import SessionLocal
    from services.sync_service import perform_full_sync

    db = SessionLocal()
    try:
        logger.info("Starting scheduled full sync...")
        perform_full_sync(db)
        logger.info("Scheduled full sync completed successfully")
    except Exception as e:
        logger.error(f"Scheduled full sync failed: {e}")
    finally:
        db.close()


def run_price_sync():
    """Price-only sync job."""
    from database import SessionLocal
    from services.sync_service import perform_price_sync

    db = SessionLocal()
    try:
        logger.info("Starting scheduled price sync...")
        perform_price_sync(db)
        logger.info("Scheduled price sync completed successfully")
    except Exception as e:
        logger.error(f"Scheduled price sync failed: {e}")
    finally:
        db.close()


def run_scan_queue_maintenance():
    """Recover, process, and expire persistent background scans."""
    import asyncio

    from database import SessionLocal
    from services.gemini_rate_limit import purge_stale_quota_states
    from services.provider_rate_limit import purge_stale_provider_limit_states
    from services.scan_queue import (
        drain_scan_queue,
        purge_expired_scan_jobs,
        recover_expired_leases,
    )
    from services.scan_storage import purge_orphaned_scan_directories

    db = SessionLocal()
    try:
        recovered = recover_expired_leases(db)
        removed = purge_expired_scan_jobs(db)
        orphans = purge_orphaned_scan_directories(db)
        stale_quotas = purge_stale_quota_states()
        stale_provider_limits = purge_stale_provider_limit_states()
        if recovered or removed or orphans or stale_quotas or stale_provider_limits:
            logger.info(
                "Scan queue maintenance recovered %s lease(s), expired %s job(s), "
                "removed %s orphaned upload directory/directories, and purged %s "
                "inactive Gemini quota state(s) and %s provider limit state(s)",
                recovered,
                removed,
                orphans,
                stale_quotas,
                stale_provider_limits,
            )
    except Exception:
        db.rollback()
        logger.exception("Scan queue recovery/expiry failed")
    finally:
        db.close()

    try:
        asyncio.run(drain_scan_queue(max_items=50))
    except Exception:
        logger.exception("Scan queue processing failed")


def run_idempotency_cleanup():
    """Delete expired Idempotency-Key rows."""
    from database import SessionLocal
    from services.idempotency import purge_expired_idempotency_keys

    db = SessionLocal()
    try:
        removed = purge_expired_idempotency_keys(db)
        if removed:
            logger.info("Idempotency cleanup removed %s expired key(s)", removed)
    except Exception:
        db.rollback()
        logger.exception("Idempotency key cleanup failed")
    finally:
        db.close()


def run_pokedex_metadata_backfill():
    """One-time startup backfill for Pokédex mappings added to existing card rows."""
    from database import SessionLocal
    from services.pokedex_backfill import run_pokedex_metadata_backfill as run_backfill
    from services.pokedex_backfill import startup_pokedex_backfill_batch_delay_seconds
    from services.pokedex_backfill import startup_pokedex_backfill_batch_limit

    db = SessionLocal()
    try:
        logger.info("Starting one-time Pokédex metadata backfill...")
        result = run_backfill(
            db,
            batch_limit=startup_pokedex_backfill_batch_limit(),
            batch_delay_seconds=startup_pokedex_backfill_batch_delay_seconds(),
        )
        if result.get("skipped"):
            logger.info("Pokédex metadata backfill skipped: %s", result.get("reason"))
        elif result.get("completed"):
            logger.info(
                "Pokédex metadata backfill completed: attempted=%s updated=%s missing=%s failed=%s batches=%s",
                result["attempted"],
                result["updated"],
                result["missing"],
                result["failed"],
                result["batches"],
            )
        else:
            logger.warning(
                "Pokédex metadata backfill stopped before completion: attempted=%s updated=%s missing=%s failed=%s batches=%s",
                result["attempted"],
                result["updated"],
                result["missing"],
                result["failed"],
                result["batches"],
            )
    except Exception as e:
        logger.error("Pokédex metadata backfill failed: %s", e)
    finally:
        db.close()


# Keep legacy alias
def run_sync():
    """Legacy alias for run_full_sync."""
    run_full_sync()


def run_progress_dirty_job():
    """Evaluate users whose data changed (at most 25 a run)."""
    from database import SessionLocal
    from services.progress.evaluator import evaluate_dirty_users

    db = SessionLocal()
    try:
        evaluate_dirty_users(db)
    except Exception:
        db.rollback()
        logger.exception("Progress dirty job failed")
    finally:
        db.close()


def run_progress_nightly_job():
    """Mark every active user dirty: the safety net for anything the listeners missed."""
    from database import SessionLocal
    from services.progress.state import mark_all_users_dirty_safely

    db = SessionLocal()
    try:
        mark_all_users_dirty_safely(db)
    finally:
        db.close()


def run_notification_job():
    """Send due notifications: instant ones after quiet hours, and the daily digest."""
    from database import SessionLocal
    from services.notifications import flush_due

    db = SessionLocal()
    try:
        from services.recap import queue_weekly_recaps

        queue_weekly_recaps(db)
        flush_due(db)
    except Exception:
        db.rollback()
        logger.exception("Notification job failed")
    finally:
        db.close()


def run_swap_expiry_job():
    """Expire swap offers nobody touched for 14 days: one indexed UPDATE."""
    from database import SessionLocal
    from services.swaps import expire_stale

    db = SessionLocal()
    try:
        if expire_stale(db):
            db.commit()
    except Exception:
        db.rollback()
        logger.exception("Swap offer expiry job failed")
    finally:
        db.close()


def run_challenge_close_job():
    """Close the finished challenge week (just after Monday 00:00 UK time, and again at start-up after downtime)."""
    from database import SessionLocal
    from services.challenge import close_due_weeks

    db = SessionLocal()
    try:
        close_due_weeks(db)
    except Exception:
        db.rollback()
        logger.exception("Challenge close job failed")
    finally:
        db.close()


def start_scheduler():
    """Start the background scheduler with separate full and small price sync jobs."""
    if not scheduler.running:
        now_utc = datetime.datetime.now(datetime.timezone.utc)

        # Only run full sync immediately on first boot if DB has no cards
        from database import SessionLocal
        from models import Card
        from services.pokedex_backfill import (
            missing_pokedex_metadata_count,
            pokedex_metadata_backfill_completed,
            startup_pokedex_backfill_enabled,
        )
        with SessionLocal() as db:
            needs_initial_sync = db.query(Card).count() == 0
            needs_pokedex_backfill = (
                startup_pokedex_backfill_enabled()
                and not pokedex_metadata_backfill_completed(db)
                and missing_pokedex_metadata_count(db) > 0
            )

        full_interval_days = _get_full_sync_interval_days()
        price_interval_minutes = _get_price_sync_interval_minutes()

        # Job 1: Full sync (sets + cards + tracked prices)
        full_next_run = now_utc if needs_initial_sync else now_utc + datetime.timedelta(days=full_interval_days)
        scheduler.add_job(
            run_full_sync,
            trigger=IntervalTrigger(days=full_interval_days),
            id="full_sync_job",
            name="Pokemon TCG Full Sync",
            replace_existing=True,
            next_run_time=full_next_run,
        )

        # Recurring auto sync: small price sync.
        scheduler.add_job(
            run_price_sync,
            trigger=IntervalTrigger(minutes=price_interval_minutes),
            id="price_sync_job",
            name="Pokemon TCG Price Sync",
            replace_existing=True,
            next_run_time=now_utc + datetime.timedelta(minutes=price_interval_minutes),
        )

        scheduler.add_job(
            run_scan_queue_maintenance,
            trigger=IntervalTrigger(minutes=1),
            id="scan_queue_maintenance_job",
            name="Persistent Scan Queue",
            replace_existing=True,
            next_run_time=now_utc + datetime.timedelta(seconds=45),
            misfire_grace_time=_SCAN_QUEUE_MISFIRE_GRACE_SECONDS,
            coalesce=True,
        )

        scheduler.add_job(
            run_idempotency_cleanup,
            trigger=IntervalTrigger(hours=1),
            id="idempotency_key_cleanup_job",
            name="Idempotency Key Cleanup",
            replace_existing=True,
            next_run_time=now_utc + datetime.timedelta(minutes=5),
        )

        scheduler.add_job(
            run_progress_dirty_job,
            trigger=IntervalTrigger(seconds=_PROGRESS_NOTIFICATION_INTERVAL_SECONDS),
            id="progress_dirty_job",
            name="Progress Evaluation",
            replace_existing=True,
            next_run_time=now_utc + datetime.timedelta(seconds=_PROGRESS_NOTIFICATION_INTERVAL_SECONDS),
            misfire_grace_time=_SCAN_QUEUE_MISFIRE_GRACE_SECONDS,
            coalesce=True,
            max_instances=1,
        )

        scheduler.add_job(
            run_notification_job,
            trigger=IntervalTrigger(seconds=_PROGRESS_NOTIFICATION_INTERVAL_SECONDS),
            id="notification_job",
            name="Notifications and Daily Digest",
            replace_existing=True,
            next_run_time=now_utc + datetime.timedelta(seconds=_PROGRESS_NOTIFICATION_INTERVAL_SECONDS),
            misfire_grace_time=_SCAN_QUEUE_MISFIRE_GRACE_SECONDS,
            coalesce=True,
            max_instances=1,
        )

        scheduler.add_job(
            run_swap_expiry_job,
            trigger=IntervalTrigger(seconds=_PROGRESS_NOTIFICATION_INTERVAL_SECONDS),
            id="swap_expiry_job",
            name="Swap Offer Expiry",
            replace_existing=True,
            next_run_time=now_utc + datetime.timedelta(seconds=_PROGRESS_NOTIFICATION_INTERVAL_SECONDS),
            misfire_grace_time=_SCAN_QUEUE_MISFIRE_GRACE_SECONDS,
            coalesce=True,
            max_instances=1,
        )

        scheduler.add_job(
            run_challenge_close_job,
            trigger=CronTrigger(day_of_week="mon", hour=0, minute=5, timezone=ZoneInfo("Europe/London")),
            id="challenge_close_job",
            name="Weekly Challenge Close",
            replace_existing=True,
            misfire_grace_time=6 * 3600,
            coalesce=True,
            max_instances=1,
        )
        # A server that was down at Monday 00:05 catches up shortly after it starts.
        scheduler.add_job(
            run_challenge_close_job,
            trigger=DateTrigger(run_date=now_utc + datetime.timedelta(seconds=90)),
            id="challenge_close_startup_job",
            name="Weekly Challenge Close (catch-up)",
            replace_existing=True,
        )

        scheduler.add_job(
            run_progress_nightly_job,
            trigger=CronTrigger(hour=3, minute=30),
            id="progress_nightly_job",
            name="Progress Nightly Safety Net",
            replace_existing=True,
            coalesce=True,
        )

        if needs_pokedex_backfill:
            scheduler.add_job(
                run_pokedex_metadata_backfill,
                trigger=DateTrigger(run_date=now_utc + datetime.timedelta(seconds=30)),
                id="pokedex_metadata_backfill_job",
                name="One-time Pokédex Metadata Backfill",
                replace_existing=True,
            )

        scheduler.start()
        logger.info(
            f"Scheduler started — full sync every {full_interval_days} days "
            f"({'immediately' if needs_initial_sync else f'in {full_interval_days} days'}), "
            f"small price sync every {price_interval_minutes} minutes"
            f"{', one-time Pokédex metadata backfill scheduled' if needs_pokedex_backfill else ''}"
        )
    else:
        logger.info("Scheduler already running")


def stop_scheduler():
    """Stop the background scheduler."""
    if scheduler.running:
        scheduler.shutdown()
        logger.info("Scheduler stopped")


def reschedule_full_sync(interval_days: int):
    """Reschedule the full sync job with a new interval."""
    if scheduler.running:
        scheduler.reschedule_job(
            "full_sync_job",
            trigger=IntervalTrigger(days=interval_days),
        )
        logger.info(f"Full sync rescheduled to every {interval_days} days")


def reschedule_price_sync(interval_minutes: int):
    """Reschedule the price sync job with a new interval."""
    if scheduler.running:
        scheduler.reschedule_job(
            "price_sync_job",
            trigger=IntervalTrigger(minutes=interval_minutes),
        )
        logger.info(f"Price sync rescheduled to every {interval_minutes} minutes")
