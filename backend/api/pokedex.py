from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from services.client_ip import client_ip
from services.display_language import get_tcgdex_display_language
from services.pokedex import MAX_DEX_ID, aggregate_pokedex, pokedex_summary, species_detail
from services.pokedex_forms import FORM_FAMILY_PATTERN, get_entry
from services.pokedex_images import cache_path, fetch_image, media_type
from services.pokedex_splash import (
    FALLBACKS,
    parse_day,
    schedule_prewarm,
    splash_cache_warmer,
    splash_entry,
    splash_throttle,
)
from services.tcgdex_languages import is_supported_tcgdex_language, normalize_tcgdex_language

router = APIRouter()


def _language(db: Session, user_id: int, requested: str | None) -> str:
    value = normalize_tcgdex_language(requested or get_tcgdex_display_language(db, user_id))
    return value if is_supported_tcgdex_language(value) else "en"


@router.get("")
def get_pokedex(
    generation: int | None = Query(None, ge=1, le=9),
    region: str | None = None,
    status: str = Query("all", pattern="^(all|owned|missing)$"),
    search: str | None = None,
    mode: str = Query("grouped", pattern="^(grouped|forms)$"),
    form_family: str = Query("all", pattern=FORM_FAMILY_PATTERN),
    lang: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return aggregate_pokedex(
        db,
        current_user.id,
        language=_language(db, current_user.id, lang),
        generation=generation,
        region=region,
        status=status,
        search=search,
        mode=mode,
        form_family=form_family,
    )


@router.get("/summary")
def get_pokedex_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Caught / total species without building the full list (Home and Profile tiles)."""
    return pokedex_summary(db, current_user.id)


def _cached_image(kinds, image_id: int):
    """The first of these images that is cached or can be fetched, as (kind, path)."""
    for kind in kinds:
        try:
            path = cache_path(kind, image_id)
            if not path.is_file():
                path = fetch_image(kind, image_id)
        except Exception:
            path = None
        if path and path.is_file():
            return kind, path
    return None, None


@router.get("/images/{kind}/{entry_id}.png", include_in_schema=False)
def get_species_image(kind: str, entry_id: str):
    """Serve a persistent local image, populating a missing cache entry lazily. The splash's
    shiny kinds fall back along services/pokedex_splash.FALLBACKS when one is missing upstream."""
    entry = get_entry(entry_id)
    if kind not in {"sprites", "artwork", "sprites-shiny", "artwork-shiny"} or not entry:
        raise HTTPException(status_code=404, detail="Image not found")
    image_id = int(entry.get("image_id") or entry["dex_id"])
    served, path = _cached_image((kind, *FALLBACKS.get(kind, ())), image_id)
    if not path:
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=604800"},
    )


@router.get("/images/{kind}/{dex_id}.gif", include_in_schema=False)
def get_species_animation(kind: str, dex_id: int):
    """An animated sprite for the Pokémon of the day, cached like the PNGs above. A species
    without one gets the official artwork, then the static sprite (FALLBACKS)."""
    if kind not in {"showdown", "showdown-shiny", "animated"} or not 1 <= dex_id <= MAX_DEX_ID:
        raise HTTPException(status_code=404, detail="Image not found")
    served, path = _cached_image((kind, *FALLBACKS.get(kind, ())), dex_id)
    if not path:
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(
        path,
        media_type=media_type(served),
        headers={"Cache-Control": "public, max-age=604800"},
    )


@router.get("/splash")
def get_splash(
    request: Request,
    response: Response,
    date: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    lang: str | None = Query(None, max_length=16),
    dex_id: int | None = Query(None, alias="id", ge=1, le=MAX_DEX_ID),
    shiny: bool | None = None,
):
    """The Pokémon of the day for the launch splash and Home (about 1 KB).

    ``date`` is the client's local date; every device gets the same Pokémon for it. Public,
    because it only serves public Pokédex data and runs before sign-in, but throttled per client.
    ``id`` and ``shiny`` pick a species for the DEV preview."""
    retry_after = splash_throttle.hit(client_ip(request))
    if retry_after:
        raise HTTPException(
            status_code=429,
            detail="Too many requests",
            headers={"Retry-After": str(retry_after), "Cache-Control": "no-store"},
        )
    try:
        day = parse_day(date)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid date")
    response.headers["Cache-Control"] = "no-store"
    entry = splash_entry(day=day, lang=lang, requested_id=dex_id, shiny=shiny)
    if dex_id is None:
        schedule_prewarm(day)
    return entry


@router.get("/wtp")
def get_wtp(
    request: Request,
    response: Response,
    date: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    lang: str | None = Query(None, max_length=16),
):
    """The day's Who's That Pokémon puzzle: the silhouette's image and four choices. Public and
    throttled like the splash, so a phone can fetch tomorrow's ahead and play it offline."""
    retry_after = splash_throttle.hit(client_ip(request))
    if retry_after:
        raise HTTPException(
            status_code=429,
            detail="Too many requests",
            headers={"Retry-After": str(retry_after), "Cache-Control": "no-store"},
        )
    try:
        day = parse_day(date)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid date")
    from services.progress.wtp import build_puzzle

    response.headers["Cache-Control"] = "no-store"
    return build_puzzle(day, lang or "en")


@router.get("/splash/cache")
def get_splash_cache(current_user: User = Depends(get_current_user)):
    """Progress of the admin warm-up of the splash cache."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return splash_cache_warmer.status()


@router.post("/splash/cache")
def start_splash_cache(current_user: User = Depends(get_current_user)):
    """Download every species' facts and sprite in the background (about 17 minutes)."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return splash_cache_warmer.start()


@router.get("/{entry_id}")
def get_species(
    entry_id: str,
    lang: str | None = None,
    mode: str | None = Query(None, pattern="^(grouped|forms)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = species_detail(
        db, current_user.id, entry_id,
        language=_language(db, current_user.id, lang), mode=mode,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Pokémon not found")
    return result
