import datetime
import json
import logging
import os
import subprocess
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from jose import JWTError
from sqlalchemy.orm import Session

from api.auth import get_current_user, multi_user_enabled, oauth2_scheme
from database import get_db
from models import User
from services.auth import decode_token, verify_password
from services import restore_schema
from services.postgres_cli import parse_database_url
from services.restore_sql_guard import RestoreSqlRejected, check_restore_sql

router = APIRouter()
logger = logging.getLogger(__name__)

BACKUP_DIR = "/app/backups"
DATABASE_URL = os.getenv("DATABASE_URL", "")
RESTORE_CHUNK_SIZE = 1024 * 1024
DEFAULT_RESTORE_TIMEOUT_SECONDS = 3600
RESTORE_STATE_FILENAME = "restore_status.json"
_IDLE_RESTORE_STATE = {
    "state": "idle",
    "started_at": None,
    "finished_at": None,
    "error": None,
    "started_by": None,
    "requires_token": False,
}
_restore_lock = threading.Lock()
_restore_state: dict = dict(_IDLE_RESTORE_STATE)
BACKUP_GROUPS = {
    "collection": [
        "collection",
        "wishlist",
        "binders",
        "binder_cards",
        "binder_slots",
        "printing_detail_tags",
        "collection_printing_detail_tags",
    ],
    "users": [
        "users",
        "user_settings",
        "settings",
        "printing_detail_tags",
        "progress_state",
        "user_events",
        "user_daily_activity",
        "user_achievements",
        "notification_queue",
    ],
    "cards": ["cards", "sets", "price_history", "custom_card_matches"],
    "products": [
        "product_purchases",
        "product_cards",
        "product_ledger_entries",
        "portfolio_snapshots",
        "printing_detail_tags",
        "product_card_printing_detail_tags",
        "product_ledger_printing_detail_tags",
    ],
    "system": ["sync_log"],
    "images": ["image_cache"],
}


def _first_error_line(stderr: str | None) -> str:
    """One short line for the admin; the full output stays in the server log."""
    for line in (stderr or "").splitlines():
        if line.strip():
            return line.strip()[:300]
    return "see the server log for details"


def get_db_params():
    """Parse DATABASE_URL into pg params."""
    return parse_database_url(DATABASE_URL)


@router.get("/download")
def download_backup(
    include: str = Query(
        default="full",
        description="Comma-separated: full,collection,users,cards,products,images",
    ),
    current_user: User = Depends(get_current_user),
):
    """Create and download a PostgreSQL dump."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    os.makedirs(BACKUP_DIR, exist_ok=True)
    params = get_db_params()
    if not params:
        raise HTTPException(status_code=500, detail="Database URL not configured")

    groups = [group.strip() for group in include.split(",") if group.strip()]
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"pokemon_tcg_backup_{timestamp}.sql"
    filepath = os.path.join(BACKUP_DIR, filename)

    env = os.environ.copy()
    env["PGPASSWORD"] = params["password"]

    cmd = [
        "pg_dump",
        "-h", params["host"],
        "-p", params["port"],
        "-U", params["user"],
        "-d", params["dbname"],
        "-f", filepath,
        "--clean",
        "--if-exists",
    ]

    if "full" in groups:
        if "images" not in groups:
            # Keep the cache schema and its owned sequence, but omit the large cache rows.
            cmd.extend(["--exclude-table-data", "image_cache"])
    else:
        tables = []
        for group in groups:
            if group in BACKUP_GROUPS:
                tables.extend(BACKUP_GROUPS[group])
        tables = list(dict.fromkeys(tables))
        if not tables:
            raise HTTPException(status_code=400, detail="No valid backup groups selected")
        for table in tables:
            cmd.extend(["-t", table])

    try:
        result = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            logger.error("pg_dump failed: %s", result.stderr)
            raise HTTPException(status_code=500, detail="Backup failed. See the server log for details.")

        return FileResponse(
            filepath,
            media_type="application/sql",
            filename=filename,
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Backup timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="pg_dump not found")


def _clear_idempotency_keys() -> None:
    """Best-effort: drop every stored Idempotency-Key result after a restore.

    An older dump leaves newer keys whose business rows no longer exist, and
    replaying one would silently drop the add. A visible duplicate is safer.
    """
    try:
        from database import SessionLocal
        from models import IdempotencyKey

        with SessionLocal() as db:
            db.query(IdempotencyKey).delete(synchronize_session=False)
            db.commit()
    except Exception:
        logger.warning("Could not clear idempotency keys after restore", exc_info=True)


def _restore_timeout_seconds() -> int:
    """How long one restore may run (env RESTORE_TIMEOUT_SECONDS, default one hour)."""
    try:
        value = int(os.getenv("RESTORE_TIMEOUT_SECONDS", str(DEFAULT_RESTORE_TIMEOUT_SECONDS)))
    except ValueError:
        return DEFAULT_RESTORE_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_RESTORE_TIMEOUT_SECONDS


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _restore_state_file() -> Path:
    return Path(BACKUP_DIR) / RESTORE_STATE_FILENAME


def _public_restore_state(state: dict) -> dict:
    return {key: state.get(key) for key in ("state", "started_at", "finished_at", "error")}


def _save_restore_state(state: dict) -> None:
    """Best-effort: mirror the state to disk so a page reload (or restart) still sees it."""
    try:
        path = _restore_state_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        logger.warning("Could not write the restore status file", exc_info=True)


def _load_restore_state() -> dict:
    """The current restore state: memory first, then the status file."""
    with _restore_lock:
        if _restore_state["state"] != "idle":
            return dict(_restore_state)
    try:
        saved = json.loads(_restore_state_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return dict(_IDLE_RESTORE_STATE)
    if not isinstance(saved, dict) or saved.get("state") not in ("running", "done", "failed"):
        return dict(_IDLE_RESTORE_STATE)
    if saved["state"] == "running":
        # Nothing in this process is running it, so the server restarted mid-restore
        # and psql went down with it. PostgreSQL rolled the transaction back.
        saved = {
            **saved,
            "state": "failed",
            "finished_at": saved.get("finished_at") or _now_iso(),
            "error": "The server restarted during the restore, so nothing was restored.",
        }
    return {**_IDLE_RESTORE_STATE, **saved}


def _finish_restore(state: str, error: str | None = None) -> None:
    with _restore_lock:
        # Write the file first so a reader never sees "done" in memory with a stale file.
        snapshot = {**_restore_state, "state": state, "finished_at": _now_iso(), "error": error}
        _save_restore_state(snapshot)
        _restore_state.update(snapshot)


def _recreate_schema() -> None:
    """Bring the schema up to date with the models: the code startup runs.

    Recreates any table the restore dropped (empty) and applies the migrations an older
    backup needs. Raises on failure.
    """
    import database

    database.init_db()


def _mark_all_users_dirty() -> None:
    """Best-effort: queue every user for the progress engine after a restore."""
    try:
        from database import SessionLocal
        from services.progress.state import mark_all_users_dirty_safely

        with SessionLocal() as db:
            mark_all_users_dirty_safely(db)
    except Exception:
        logger.warning("Could not mark users dirty after restore", exc_info=True)


def _execute_restore(
    command: list[str], env: dict, timeout: int, dropped_tables: list[str] | None = None
) -> tuple[str, str | None]:
    """Run psql and return (state, error) for the status.

    ``dropped_tables`` are the live tables the command drops (in its transaction) because
    they depend on tables the dump replaces; they are recreated once psql succeeds.
    """
    try:
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        logger.error("psql restore timed out after %s seconds", timeout)
        return "failed", (
            f"Restore timed out after {timeout} seconds and was rolled back. "
            "Raise RESTORE_TIMEOUT_SECONDS or restore from the server (see the deployment docs)."
        )
    except FileNotFoundError:
        return "failed", "psql not found"
    except Exception:
        logger.exception("psql restore crashed")
        return "failed", "Restore failed: see the server log for details"

    if result.returncode != 0:
        logger.error("psql restore failed: %s", result.stderr)
        return "failed", f"Restore failed: {_first_error_line(result.stderr)}"

    # The restore is committed. Recreate what it dropped and bring the schema up to date
    # before anything else touches the database.
    schema_error = None
    try:
        _recreate_schema()
        if dropped_tables:
            logger.info(
                "Restore: recreated %s (dropped before the restore because they depend on "
                "tables in the backup)",
                ", ".join(dropped_tables),
            )
    except Exception:
        logger.exception("Schema update after restore failed")
        schema_error = (
            "The backup was restored, but updating the schema afterwards failed. "
            "Restart the server to finish (see the server log)."
        )
    _mark_all_users_dirty()
    _clear_idempotency_keys()
    if schema_error:
        return "failed", schema_error
    logger.info("Database restore finished")
    return "done", None


def _run_restore_job(
    restore_path: Path, command: list[str], env: dict, timeout: int, params: dict | None = None
) -> None:
    """Background thread: run psql, delete the upload, then record the outcome."""
    state, error = "failed", "Restore failed: see the server log for details"
    try:
        dropped: list[str] = []
        if params:
            # Same transaction as the dump (psql --single-transaction), so a failure
            # rolls the drops back with everything else.
            dropped = restore_schema.plan_restore_drops(restore_path, params)
            command = restore_schema.with_drops(command, dropped)
        state, error = _execute_restore(command, env, timeout, dropped)
    finally:
        try:
            restore_path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not remove temporary restore file %s", restore_path, exc_info=True)
        _finish_restore(state, error)


def _restore_status_user(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Authenticate a status poll without touching the database while a restore runs.

    A full restore drops and recreates the tables inside one transaction, so a normal
    lookup in `users` would wait until the restore commits. While the restore started
    by this administrator is running, the signed token alone is enough to read its status.
    """
    with _restore_lock:
        running = _restore_state["state"] == "running"
        starter = _restore_state.get("started_by")
        needs_token = _restore_state.get("requires_token")
    if running and starter is not None:
        if not needs_token and not token:
            return SimpleNamespace(role="admin", id=starter)
        if token:
            try:
                if str(decode_token(token).get("sub")) == str(starter):
                    return SimpleNamespace(role="admin", id=starter)
            except JWTError:
                pass
    return get_current_user(token=token, db=db, request=request)


@router.post("/restore", status_code=202)
async def restore_backup(
    file: UploadFile = File(...),
    password: str | None = Form(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Start restoring the database from a SQL dump file (a background job).

    Restoring replaces the whole database and runs the uploaded file through psql, so
    when logins are enabled the administrator must confirm their password, and the file
    must be plain pg_dump output (see services.restore_sql_guard). A full restore can
    take longer than a reverse proxy waits, so this returns 202 at once; poll
    GET /restore/status for the outcome.
    """
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    multi_user = multi_user_enabled(db)
    if multi_user and not (
        password and verify_password(password, current_user.hashed_password)
    ):
        raise HTTPException(status_code=403, detail="Enter your password to restore a backup")
    params = get_db_params()
    if not params:
        raise HTTPException(status_code=500, detail="Database URL not configured")

    if not (file.filename or "").lower().endswith(".sql"):
        raise HTTPException(status_code=400, detail="Only .sql files are accepted")

    with _restore_lock:
        if _restore_state["state"] == "running":
            raise HTTPException(status_code=409, detail="A restore is already running")
        # Reserve the slot before the (slow) upload so two uploads cannot both start.
        previous_state = dict(_restore_state)
        _restore_state.update(
            state="running",
            started_at=_now_iso(),
            finished_at=None,
            error=None,
            started_by=getattr(current_user, "id", None),
            requires_token=bool(multi_user),
        )
        job_id = _restore_state["started_at"]

    handed_off = False
    restore_path: Path | None = None
    try:
        restore_dir = Path(BACKUP_DIR)
        restore_dir.mkdir(parents=True, exist_ok=True)
        restore_fd, raw_restore_path = tempfile.mkstemp(
            prefix="restore_",
            suffix=".sql",
            dir=restore_dir,
        )
        restore_path = Path(raw_restore_path)
        uploaded_bytes = 0
        with os.fdopen(restore_fd, "wb") as destination:
            while chunk := await file.read(RESTORE_CHUNK_SIZE):
                destination.write(chunk)
                uploaded_bytes += len(chunk)
        if uploaded_bytes == 0:
            raise HTTPException(status_code=400, detail="Backup file is empty")
        try:
            await run_in_threadpool(check_restore_sql, restore_path)
        except RestoreSqlRejected as exc:
            logger.warning("Rejected restore upload: %s", exc)
            raise HTTPException(
                status_code=400,
                detail=f"This file is not a plain PostgreSQL backup made by this app ({exc}).",
            ) from None

        env = os.environ.copy()
        env["PGPASSWORD"] = params["password"]
        command = [
            "psql",
            "-h", params["host"],
            "-p", params["port"],
            "-U", params["user"],
            "-d", params["dbname"],
            "--no-psqlrc",
            "-v", "ON_ERROR_STOP=1",
            "--single-transaction",
            "-f", str(restore_path),
        ]
        timeout = _restore_timeout_seconds()
        with _restore_lock:
            snapshot = dict(_restore_state)
        _save_restore_state(snapshot)
        thread = threading.Thread(
            target=_run_restore_job,
            args=(restore_path, command, env, timeout, params),
            name="backup-restore",
            daemon=True,
        )
        thread.start()
        handed_off = True
        logger.info("Database restore started (timeout %s s)", timeout)
        return {"message": "Restore started", "job_id": job_id, "state": "running"}
    finally:
        if not handed_off:
            # Rejected or interrupted before psql started: free the slot and the file.
            with _restore_lock:
                _restore_state.clear()
                _restore_state.update(previous_state)
            if restore_path is not None:
                try:
                    restore_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove temporary restore file %s", restore_path, exc_info=True)


@router.get("/restore/status")
def restore_status(current_user: User = Depends(_restore_status_user)):
    """State of the latest restore: idle, running, done or failed (admin only)."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return _public_restore_state(_load_restore_state())


@router.post("/clear-image-cache")
def clear_image_cache(current_user: User = Depends(get_current_user)):
    """Clear the image cache directory (admin only)."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    import shutil
    images_dir = "/app/images"
    if os.path.exists(images_dir):
        shutil.rmtree(images_dir)
        os.makedirs(images_dir, exist_ok=True)
    return {"message": "Image cache cleared"}
