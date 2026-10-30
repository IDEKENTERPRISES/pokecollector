from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.middleware import SlowAPIMiddleware
from slowapi.errors import RateLimitExceeded
import logging
import os
import time
from pathlib import Path

from services.request_origin import allowed_origins_from_env, is_cross_site_unauthenticated_write
from services.client_ip import client_ip
from services.api_info import API_FEATURES, API_LEVEL

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Rate limiter: keyed on the real client address (the TCP peer is always a proxy), with
# a per-client default that the polling web UI and mobile app stay comfortably under.
limiter = Limiter(
    key_func=client_ip,
    default_limits=[os.environ.get("RATE_LIMIT_DEFAULT", "").strip() or "300/minute"],
)


def read_app_version() -> str:
    """Read the release version from the repository VERSION file."""
    env_version = os.environ.get("APP_VERSION")
    if env_version:
        return env_version

    for candidate in (
        Path(__file__).resolve().parent.parent / "VERSION",
        Path(__file__).resolve().parent / "VERSION",
        Path("/app/VERSION"),
    ):
        try:
            version = candidate.read_text(encoding="utf-8").strip()
            if version:
                return version
        except OSError:
            continue
    return "0.0.0"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Starting Pokemon TCG Collection API...")
    if ":changeme@" in os.environ.get("DATABASE_URL", ""):
        logger.warning(
            "The database is using the default password 'changeme'. Set POSTGRES_PASSWORD "
            "to something unique (the database port is not published, but defaults are guessable)."
        )
    from api.auth import env_user_mode
    _forced_mode = env_user_mode(warn_invalid=True)
    if _forced_mode == "single":
        logger.warning(
            "USER_MODE=single: single-user mode is forced and the login screen is disabled "
            "regardless of the stored setting. This is a local recovery hatch - unset it once "
            "you have regained access, and do not leave it set on a public install."
        )
    elif _forced_mode == "multi":
        logger.info("USER_MODE=multi: multi-user mode is forced; the in-app toggle is disabled.")
    current_version = read_app_version()
    from database import DATABASE_URL, SessionLocal, engine, init_db
    from services.auth import bootstrap_admin
    from services.pre_upgrade_backup import maybe_create_pre_upgrade_backup, record_successful_app_version
    maybe_create_pre_upgrade_backup(engine, DATABASE_URL, current_version)
    init_db()
    logger.info("Database initialized")

    db = SessionLocal()
    try:
        bootstrap_admin(db)
        from services.public_profile import migrate_public_profile_handles
        public_handle_migration = migrate_public_profile_handles(db)
        if public_handle_migration["migrated"] or public_handle_migration["disabled"]:
            logger.info(
                "Public trainer-name URL migration updated %s profiles and disabled %s invalid/conflicting profiles",
                public_handle_migration["migrated"],
                public_handle_migration["disabled"],
            )
        from models import Setting
        from services.debug_logging import configure_debug_logging
        debug_setting = db.query(Setting).filter(Setting.key == "debug_mode").first()
        configure_debug_logging(debug_setting is not None and debug_setting.value == "true")
        record_successful_app_version(engine, current_version)
    finally:
        db.close()

    from services.progress.listeners import register_progress_listeners
    register_progress_listeners()
    from services.binder_slots import register_binder_slot_listeners
    register_binder_slot_listeners()

    from services.scheduler import start_scheduler
    start_scheduler()

    yield

    # Shutdown
    from services.scheduler import stop_scheduler
    stop_scheduler()
    logger.info("Shutdown complete")


app = FastAPI(
    title="Pokemon TCG Collection API",
    version=read_app_version(),
    description="Complete Pokemon TCG collection management system",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


@app.middleware("http")
async def prevent_failed_public_response_caching(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/public") and response.status_code >= 400:
        response.headers["Cache-Control"] = "no-store"
    return response


# The bundled UI is same-origin behind nginx and native clients send no Origin, so
# CORS stays closed unless CORS_ORIGINS lists specific origins.
ALLOWED_ORIGINS = allowed_origins_from_env()


@app.middleware("http")
async def block_cross_site_writes(request: Request, call_next):
    # Single-user mode treats token-less requests as the administrator. Refuse
    # browser writes from other sites that would otherwise ride on that.
    if is_cross_site_unauthenticated_write(request.method, request.headers, ALLOWED_ORIGINS):
        return JSONResponse(
            status_code=403,
            content={"detail": "Cross-site request blocked."},
        )
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Expected-User-Id"],
)



@app.middleware("http")
async def debug_request_logging(request: Request, call_next):
    from services.debug_logging import is_debug_logging_enabled

    if not is_debug_logging_enabled():
        return await call_next(request)

    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("Request failed: %s %s", request.method, request.url.path)
        raise

    duration_ms = (time.perf_counter() - started) * 1000
    logger.debug(
        "Request: %s %s -> %s %.1fms",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    return response

# Include routers
from api import auth, cards, collection, sets, wishlist, binders, decks, dashboard, analytics, sync, products, trades, export, backup, settings, images, social, pokedex, public, profile, scan_jobs, community, push, offline_carddb, progress, goals
from api.github import router as github_router
from api.invites import router as invites_router
from api.recognize import router as recognize_router

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(invites_router, prefix="/api/auth", tags=["invites"])

# Failed logins are throttled per client address and per username inside the login
# handler itself (see services/login_throttle.py).
app.include_router(cards.router, prefix="/api/cards", tags=["cards"])
app.include_router(recognize_router, prefix="/api/cards", tags=["recognize"])
app.include_router(scan_jobs.router, prefix="/api/cards", tags=["scan-jobs"])
app.include_router(collection.router, prefix="/api/collection", tags=["collection"])
app.include_router(sets.router, prefix="/api/sets", tags=["sets"])
app.include_router(wishlist.router, prefix="/api/wishlist", tags=["wishlist"])
app.include_router(binders.router, prefix="/api/binders", tags=["binders"])
app.include_router(decks.router, prefix="/api/decks", tags=["decks"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["dashboard"])
app.include_router(analytics.router, prefix="/api/analytics", tags=["analytics"])
app.include_router(sync.router, prefix="/api/sync", tags=["sync"])
app.include_router(products.router, prefix="/api/products", tags=["products"])
app.include_router(trades.router, prefix="/api/trades", tags=["trades"])
app.include_router(export.router, prefix="/api/export", tags=["export"])
app.include_router(backup.router, prefix="/api/backup", tags=["backup"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(images.router, prefix="/api/images", tags=["images"])
app.include_router(social.router, prefix="/api/social", tags=["social"])
app.include_router(pokedex.router, prefix="/api/pokedex", tags=["pokedex"])
app.include_router(public.router, prefix="/api/public", tags=["public"])
app.include_router(profile.router, prefix="/api/profile", tags=["profile"])
app.include_router(github_router, prefix="/api/github", tags=["github"])
app.include_router(community.router, prefix="/api/community", tags=["community"])
app.include_router(push.router, prefix="/api/push", tags=["push"])
app.include_router(offline_carddb.router, prefix="/api/offline/carddb", tags=["offline-carddb"])
app.include_router(progress.router, prefix="/api/progress", tags=["progress"])
app.include_router(goals.router, prefix="/api/goals", tags=["goals"])


@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "service": "pokemon-tcg-collection",
        "version": read_app_version(),
        "api_level": API_LEVEL,
        "features": list(API_FEATURES),
    }
