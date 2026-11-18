"""Wipe all user data (Settings > Administrator > Danger zone).

Deletes every user and everything they own, keeps the server's own settings and the card
catalogue, then recreates the single administrator from ``ADMIN_USERNAME`` / ``ADMIN_PASSWORD``.
This is the most destructive operation in the app, so the order is fixed and every step that
can fail runs *before* anything is deleted:

1. refuse unless both environment credentials are set (otherwise the owner is locked out);
2. refuse while a restore, a matcher / Scanner lab job or a scan job is running;
3. read the administrator's scanner settings (they live per user in ``user_settings``);
4. write a ``pre-wipe-<UTC>.sql`` pg_dump to the backups folder (failure aborts, nothing deleted);
5. one transaction, under a lock: delete the ``WIPE_TABLES`` rows, recreate the administrator,
   write the scanner settings back, set a new ``data_epoch`` and write the audit entry;
6. only after the commit, delete the user files on disk.

Every table must be listed in exactly one of ``WIPE_TABLES`` / ``KEEP_TABLES``
(tests/test_data_wipe.py fails when a new table is added and not classified).
"""

from __future__ import annotations

import logging
import os
import secrets
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import (
    Base,
    Card,
    PriceHistory,
    ScanJob,
    ScanJobItem,
    Setting,
    User,
    UserSetting,
)
from services.audit import record_audit
from services.postgres_cli import parse_database_url

logger = logging.getLogger(__name__)

CONFIRM_PHRASE = "WIPE ALL DATA"
DATA_EPOCH_SETTING = "data_epoch"

# --- classification ---------------------------------------------------------------------------

# Everything a user made or owns (or that only exists because users exist). Deleted.
WIPE_TABLES = frozenset({
    "users",
    "user_sessions",
    "invites",
    "user_settings",
    "push_subscriptions",
    "idempotency_keys",
    "collection",
    "collection_card_photos",
    "collection_printing_detail_tags",
    "wishlist",
    "binders",
    "binder_cards",
    "binder_slots",
    "printing_detail_tags",  # user-scoped labels (user_id NOT NULL); the link tables to them go too
    "product_card_printing_detail_tags",
    "product_ledger_printing_detail_tags",
    "trade_item_printing_detail_tags",
    "product_purchases",
    "product_cards",
    "product_ledger_entries",
    "trades",
    "trade_items",
    "portfolio_snapshots",
    "custom_card_matches",  # every row points at a user-made custom card, which is deleted below
    "scan_jobs",
    "scan_job_items",
    "scan_queue_user_state",
    "progress_state",
    "user_events",
    "event_reactions",
    "event_comments",
    "user_goals",
    "user_daily_activity",
    "user_achievements",
    "user_xp_ledger",
    "notification_queue",
    "swap_offers",
    "swap_offer_items",
    "challenge_weeks",  # results of the trainers' weekly challenge (frozen counts); recreated lazily by ensure_week
    "challenge_progress",
    "admin_notifications",
    "banners",
    "banner_dismissals",
})

# Server and catalogue data. Untouched (``cards`` and ``price_history`` lose only user-made custom
# cards and their price rows, see ``_delete_custom_cards``).
KEEP_TABLES = frozenset({
    "settings",
    "sets",
    "cards",
    "price_history",
    "image_cache",
    "sync_log",
    "gemini_quota_state",
    "scanner_provider_limit_state",
    "audit_log",
})

# user_settings keys that make up the scanner's connection setup. Carried over to the new admin.
# Keep in step with scan_providers.py / api/settings.py (MANAGED_SCANNER_KEYS, PER_USER_KEYS);
# tests/test_data_wipe.py compares this list with those.
SCANNER_PREFIXES = ("scanner_",)
SCANNER_EXTRA_KEYS = ("gemini_api_key", "openai_api_key", "scan_diagnostics_enabled")


def is_scanner_key(key: str) -> bool:
    return key in SCANNER_EXTRA_KEYS or any(key.startswith(prefix) for prefix in SCANNER_PREFIXES)


def metadata_table_names() -> set[str]:
    return set(Base.metadata.tables)


def unclassified_tables() -> set[str]:
    return metadata_table_names() - WIPE_TABLES - KEEP_TABLES


def doubly_classified_tables() -> set[str]:
    return set(WIPE_TABLES & KEEP_TABLES)


def unknown_listed_tables() -> set[str]:
    return (WIPE_TABLES | KEEP_TABLES) - metadata_table_names()


# --- errors -------------------------------------------------------------------------------------


class WipeRefused(Exception):
    """The wipe must not start. Nothing was changed."""

    def __init__(self, message: str, status: int = 409, code: str = "refused"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


class WipeBackupFailed(WipeRefused):
    def __init__(self, message: str):
        super().__init__(message, status=500, code="backup_failed")


# --- preconditions ----------------------------------------------------------------------------


def env_admin_credentials(env=None) -> tuple[str, str] | None:
    env = os.environ if env is None else env
    username = (env.get("ADMIN_USERNAME") or "").strip()
    password = env.get("ADMIN_PASSWORD") or ""
    if username and password.strip():
        return username, password
    return None


def env_admin_problem(env=None) -> str | None:
    if env_admin_credentials(env) is not None:
        return None
    return (
        "ADMIN_USERNAME and ADMIN_PASSWORD must both be set on the server. After the wipe the "
        "administrator account is created again from them; without a password you could not sign "
        "in. Set both in the stack's environment, redeploy, then try again."
    )


def busy_reason(db: Session) -> str | None:
    """Why the wipe cannot start right now (a restore, a matcher / Scanner lab job or a scan job)."""
    try:
        from api import backup

        if backup._load_restore_state().get("state") == "running":
            return "A backup restore is running. Wait for it to finish."
    except Exception:
        logger.warning("Could not check the restore state before a wipe", exc_info=True)
        return "The restore state could not be checked. Try again in a moment."
    try:
        from services.card_match import jobs

        if jobs.jobs.is_running():
            return "A matcher or Scanner lab job is running. Stop it or wait for it to finish."
    except Exception:
        logger.warning("Could not check the matcher jobs before a wipe", exc_info=True)
        return "The matcher job state could not be checked. Try again in a moment."
    active_jobs = db.query(ScanJob.id).filter(ScanJob.status.in_(("pending", "running"))).first()
    active_items = db.query(ScanJobItem.id).filter(
        ScanJobItem.status.in_(("pending", "processing", "retrying"))
    ).first()
    if active_jobs is not None or active_items is not None:
        return "A scan job is still running. Wait for it to finish."
    return None


# --- data epoch -------------------------------------------------------------------------------


def _new_epoch() -> str:
    return secrets.token_hex(16)


def get_data_epoch(db: Session) -> str:
    """The id of this database's current "generation" of user data, created on first use.

    A client that stored a different one knows the data was wiped (or the server was rebuilt)."""
    row = db.get(Setting, DATA_EPOCH_SETTING)
    if row is not None and row.value:
        return row.value
    try:
        if row is None:
            db.add(Setting(key=DATA_EPOCH_SETTING, value=_new_epoch()))
        else:
            row.value = _new_epoch()
        db.commit()
    except IntegrityError:  # another worker created it first
        db.rollback()
    row = db.get(Setting, DATA_EPOCH_SETTING)
    return row.value if row is not None else ""


def read_data_epoch(db: Session) -> str | None:
    """The current epoch without creating or committing anything (None when it was never created)."""
    row = db.get(Setting, DATA_EPOCH_SETTING)
    return row.value if row is not None and row.value else None


def _set_data_epoch(db: Session) -> str:
    """Set a new epoch inside the caller's transaction."""
    epoch = _new_epoch()
    row = db.get(Setting, DATA_EPOCH_SETTING)
    if row is None:
        db.add(Setting(key=DATA_EPOCH_SETTING, value=epoch))
    else:
        row.value = epoch
    return epoch


# --- what would go (preview) ------------------------------------------------------------------


def _custom_card_filter():
    return or_(Card.is_custom.is_(True), Card.custom_owner_id.isnot(None))


def count_wipe_rows(db: Session) -> dict[str, int]:
    """Row counts of every wipe table (plus the user-made custom cards inside ``cards``)."""
    counts: dict[str, int] = {}
    for name in sorted(WIPE_TABLES):
        table = Base.metadata.tables[name]
        counts[name] = int(db.execute(select(func.count()).select_from(table)).scalar() or 0)
    custom = int(db.query(func.count(Card.id)).filter(_custom_card_filter()).scalar() or 0)
    if custom:
        counts["cards (custom cards)"] = custom
    return counts


def _dir_stats(path: Path | None, pattern: str = "*") -> dict:
    files = 0
    size = 0
    if path is not None and path.is_dir():
        for item in path.rglob(pattern):
            try:
                if item.is_file():
                    files += 1
                    size += item.stat().st_size
            except OSError:
                continue
    return {"files": files, "bytes": size}


def scan_upload_dir() -> Path | None:
    configured = os.environ.get("SCAN_UPLOAD_DIR", "").strip()
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parent.parent / "data" / "scan-uploads"


def file_preview() -> dict:
    """Only the scan upload folder is deleted. Scan traces (SCAN_TRACE_DIR) and /app/data/card-match are never touched."""
    return {"scan_uploads": _dir_stats(scan_upload_dir())}


# --- scanner settings carry-over --------------------------------------------------------------


def read_scanner_settings(db: Session, user_id: int) -> dict[str, str]:
    rows = db.query(UserSetting).filter(UserSetting.user_id == user_id).all()
    return {row.key: row.value for row in rows if is_scanner_key(row.key)}


def write_scanner_settings(db: Session, user_id: int, values: dict[str, str]) -> None:
    for key, value in values.items():
        db.add(UserSetting(user_id=user_id, key=key, value=value))


# --- backup -----------------------------------------------------------------------------------


def backup_dir() -> Path:
    return Path(os.getenv("BACKUP_DIR", "/app/backups"))


def create_pre_wipe_backup(database_url: str | None = None, directory: Path | None = None, now=None) -> Path:
    """pg_dump to ``pre-wipe-<UTC>.sql`` (a plain dump the Backup / Restore page can restore).

    Written to a temp file and renamed, so a half-written file never looks like a backup.
    Image cache rows are left out, like the download backup's default: the wipe does not touch
    them and they are fetched again on demand. Raises WipeBackupFailed."""
    url = database_url if database_url is not None else os.getenv("DATABASE_URL", "")
    params = parse_database_url(url)
    if not params:
        raise WipeBackupFailed("No PostgreSQL database is configured, so no backup could be made. Nothing was deleted.")
    target_dir = directory or backup_dir()
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    filename = f"pre-wipe-{stamp}.sql"
    final = target_dir / filename
    temp = target_dir / f".{filename}.tmp"
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["PGPASSWORD"] = params["password"]
        command = [
            "pg_dump",
            "-h", params["host"], "-p", params["port"], "-U", params["user"], "-d", params["dbname"],
            "-f", str(temp),
            "--clean", "--if-exists",
            "--exclude-table-data", "image_cache",
        ]
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=900)
        if result.returncode != 0:
            logger.error("pre-wipe pg_dump failed: %s", result.stderr)
            raise RuntimeError("pg_dump failed")
        if not temp.exists() or temp.stat().st_size == 0:
            raise RuntimeError("pg_dump wrote an empty file")
        os.replace(temp, final)
        return final
    except WipeBackupFailed:
        raise
    except Exception as exc:
        logger.error("Pre-wipe backup failed: %s", exc, exc_info=True)
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
        raise WipeBackupFailed(
            "The backup before the wipe could not be made, so nothing was deleted. See the server log."
        ) from None


# --- the wipe ---------------------------------------------------------------------------------


def detach_photos(db: Session, current_epoch: str | None) -> dict:
    """Seam for tests: see services/trace_photos.detach_review_photos."""
    from services import trace_photos

    return trace_photos.detach_review_photos(db, current_epoch)


_wipe_lock = threading.Lock()


def _delete_custom_cards(db: Session) -> int:
    ids = [row[0] for row in db.query(Card.id).filter(_custom_card_filter()).all()]
    if not ids:
        return 0
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        db.execute(delete(PriceHistory).where(PriceHistory.card_id.in_(chunk)))
        db.execute(delete(Card).where(Card.id.in_(chunk)))
    return len(ids)


def _delete_wipe_tables(db: Session) -> None:
    # Child tables first, so foreign keys never block a delete. Rows are deleted one table at a time, so the
    # id sequences keep counting and an id is never reused.
    order = [t for t in reversed(Base.metadata.sorted_tables) if t.name in WIPE_TABLES]
    for table in order:
        db.execute(delete(table))


def _clear_files() -> dict:
    """After the commit: the scan upload folder. Best effort; returns what was removed and what failed.
    Scan traces (photos, corrections, held-back marks) and the card-match folder are never touched."""
    result = {"scan_uploads": 0, "errors": []}

    def empty_dir(path: Path | None) -> int:
        removed = 0
        if path is None or not path.is_dir() or path.is_symlink():
            return 0
        for child in list(path.iterdir()):
            try:
                if child.is_dir() and not child.is_symlink():
                    removed += sum(1 for item in child.rglob("*") if item.is_file())
                    shutil.rmtree(child)
                else:
                    removed += 1
                    child.unlink()
            except OSError as exc:
                result["errors"].append(f"{child.name}: {exc.strerror or exc}")
        return removed

    result["scan_uploads"] = empty_dir(scan_upload_dir())
    return result


def wipe_all_user_data(
    db: Session,
    actor: User,
    *,
    request=None,
    env=None,
    backup=create_pre_wipe_backup,
) -> dict:
    """Run the whole wipe. Raises WipeRefused (nothing deleted) or returns the report."""
    credentials = env_admin_credentials(env)
    if credentials is None:
        raise WipeRefused(env_admin_problem(env), status=409, code="env_admin_missing")
    username, password = credentials

    if not _wipe_lock.acquire(blocking=False):
        raise WipeRefused("A wipe is already running.", code="busy")
    try:
        reason = busy_reason(db)
        if reason:
            raise WipeRefused(reason, code="busy")

        scanner_settings = read_scanner_settings(db, actor.id)
        actor_name = actor.username
        actor_id = actor.id
        counts = count_wipe_rows(db)
        db.rollback()  # end the read transaction before the slow dump

        backup_path = backup()  # raises WipeBackupFailed: nothing has been deleted yet

        # The kept scan traces read their review photo through the scan job rows and the upload folder, which are
        # about to go. Copy the photos beside the traces first (idempotent); a failure aborts before any deletion.
        from services import trace_photos

        try:
            detached = detach_photos(db, read_data_epoch(db))
        except trace_photos.DetachError as exc:
            logger.error("Wipe aborted: could not detach scan trace photos: %s", exc)
            raise WipeRefused(
                "The scan traces could not be made independent of the database (" + str(exc) + "). "
                "Nothing was deleted. See the server log.",
                status=500,
                code="detach_failed",
            ) from None
        db.rollback()

        from services.auth import hash_password

        password_hash = hash_password(password)

        try:
            if db.get_bind().dialect.name == "postgresql":
                if not db.execute(text("SELECT pg_try_advisory_xact_lock(7313091)")).scalar():
                    raise WipeRefused("A wipe is already running.", code="busy")
            _delete_custom_cards(db)
            _delete_wipe_tables(db)
            db.expunge_all()  # the deleted accounts must not linger in the session's identity map
            admin = User(username=username, hashed_password=password_hash, role="admin", is_active=True, must_change_password=False)
            db.add(admin)
            db.flush()
            carried = dict(scanner_settings)
            if not carried.get("gemini_api_key") and "scanner_provider" not in carried:
                # Same as the very first start (bootstrap_admin): an environment key seeds the new account.
                env_key = ((env or os.environ).get("GEMINI_API_KEY") or "").strip()
                if env_key:
                    carried["gemini_api_key"] = env_key
            write_scanner_settings(db, admin.id, carried)
            new_epoch = _set_data_epoch(db)
            record_audit(
                db,
                "data.wipe",
                request=request,
                actor=None,  # the old account no longer exists; the name is kept in details
                target_type="server",
                details={
                    "actor": actor_name,
                    "actor_id": actor_id,
                    "backup_file": backup_path.name,
                    "deleted_rows": counts,
                    "scan_diagnostics": "kept",
                    "trace_photos_detached": detached,
                    "scanner_settings_carried": sorted(scanner_settings),
                    "new_admin": username,
                },
                commit=False,
            )
            db.commit()
            admin_id = admin.id
        except Exception:
            db.rollback()
            raise

        files = _clear_files()
        logger.warning(
            "All user data wiped by %s; backup %s; new administrator %s", actor_name, backup_path.name, username
        )
        return {
            "backup_file": backup_path.name,
            "deleted_rows": counts,
            "files": files,
            "trace_photos_detached": detached,
            "admin_username": username,
            "admin_id": admin_id,
            "data_epoch": new_epoch,
            "scanner_settings_carried": sorted(scanner_settings),
        }
    finally:
        _wipe_lock.release()
