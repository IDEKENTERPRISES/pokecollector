import datetime
import logging
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from api.auth import get_current_user, multi_user_enabled
from database import get_db
from models import User
from services.auth import verify_password
from services.postgres_cli import parse_database_url
from services.restore_sql_guard import RestoreSqlRejected, check_restore_sql

router = APIRouter()
logger = logging.getLogger(__name__)

BACKUP_DIR = "/app/backups"
DATABASE_URL = os.getenv("DATABASE_URL", "")
RESTORE_CHUNK_SIZE = 1024 * 1024
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
        "user_xp_ledger",
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


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    password: str | None = Form(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Restore database from a SQL dump file.

    Restoring replaces the whole database and runs the uploaded file through psql, so
    when logins are enabled the administrator must confirm their password, and the file
    must be plain pg_dump output (see services.restore_sql_guard).
    """
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if multi_user_enabled(db) and not (
        password and verify_password(password, current_user.hashed_password)
    ):
        raise HTTPException(status_code=403, detail="Enter your password to restore a backup")
    params = get_db_params()
    if not params:
        raise HTTPException(status_code=500, detail="Database URL not configured")

    if not (file.filename or "").lower().endswith(".sql"):
        raise HTTPException(status_code=400, detail="Only .sql files are accepted")

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
        result = subprocess.run(
            [
                "psql",
                "-h", params["host"],
                "-p", params["port"],
                "-U", params["user"],
                "-d", params["dbname"],
                "--no-psqlrc",
                "-v", "ON_ERROR_STOP=1",
                "--single-transaction",
                "-f", str(restore_path),
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            logger.error("psql restore failed: %s", result.stderr)
            raise HTTPException(
                status_code=500,
                detail=f"Restore failed: {_first_error_line(result.stderr)}",
            )

        _clear_idempotency_keys()
        return {"message": "Database restored successfully"}

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Restore timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="psql not found")
    finally:
        if restore_path is not None:
            try:
                restore_path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove temporary restore file %s", restore_path, exc_info=True)


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
