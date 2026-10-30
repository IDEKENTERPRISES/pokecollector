import logging
import os
import re
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel
from api.auth import get_current_user
from sqlalchemy.orm import Session
from database import get_db
from models import CollectionCardPhoto, Setting, UserSetting, User
from services import feed as feed_service, notifications
from services.audit import record_audit
from services.debug_logging import configure_debug_logging, get_debug_log_path
from services.digital_sets import DIGITAL_SETS_SETTING_KEY, refresh_digital_catalogue_flags
from services.exchange_rates import (
    ExchangeRateError,
    fallback_exchange_rate,
    get_cached_currencies,
    normalize_currency_pair,
    parse_frankfurter_currencies,
    parse_frankfurter_v2_rate,
    set_cached_currencies,
    stale_currencies,
)
from services.card_visibility import get_visible_filter_languages
from services.public_profile_feature import PUBLIC_PROFILES_SETTING_KEY
from services.social_feature import SOCIAL_SETTING_KEY
from services.tcgdex_languages import (
    DEFAULT_TCGDEX_SYNC_LANGUAGES,
    supported_tcgdex_language_payload,
    validate_tcgdex_sync_languages,
)
from services.scan_trace import (
    SCAN_DIAGNOSTICS_SETTING_KEY,
    delete_user_traces,
    trace_available,
    trace_deletion_available,
)

from services.scan_providers import (
    DEFAULT_OPENAI_BASE_URL,
    DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS,
    GEMINI,
    OPENAI,
    MODEL_PATTERN,
    SCANNER_CUSTOM_MODEL_SETTINGS,
    SCANNER_CAPABILITY_SETTINGS,
    SCANNER_CAPABILITY_DEGRADED,
    SCANNER_CAPABILITY_FULL,
    SCANNER_MODEL_SETTINGS,
    SCANNER_REQUEST_TIMEOUT_OPTIONS,
    SCANNER_REQUEST_TIMEOUT_SETTINGS,
    ScanProvider,
    ProviderRequestRejectedError,
    allowed_models,
    configured_provider_name,
    enabled_providers,
    gemini_enabled,
    global_scanner_config_enabled,
    global_scanner_config_exists,
    global_scanner_key,
    image_part,
    installation_model,
    openai_base_url,
    openai_enabled,
    openai_requires_key,
    normalize_scanner_request_timeout,
    provider_key_help_url,
    provider_label,
    resolve_model,
    resolve_provider_name,
    resolve_scanner_request_timeout,
    scanner_capability_mode,
    scanner_capability_proof,
    scanner_setting_row,
    scanner_setting_value,
    upsert_scanner_setting,
    SCANNER_GEMINI_FALLBACK_SETTING_KEY,
    SCANNER_PROVIDER_SETTING,
    SCANNER_PROVIDER_GUIDE_URL,
    text_part,
)

router = APIRouter()
logger = logging.getLogger(__name__)
PHOTO_PREFERENCE_SETTING_KEY = "prefer_own_card_photos"

PER_USER_KEYS = {
    "language", "currency", "price_primary", "price_display",
    "set_overview_filters", "hidden_set_ids",
    "telegram_bot_token", "telegram_chat_id", "telegram_enabled",
    "price_alerts_enabled", "price_alert_threshold",
    "gemini_api_key", "trainer_name", "portfolio_display_mode",
    "openai_api_key",
    SCANNER_PROVIDER_SETTING, *SCANNER_MODEL_SETTINGS.values(),
    *SCANNER_REQUEST_TIMEOUT_SETTINGS.values(),
    *SCANNER_CUSTOM_MODEL_SETTINGS.values(),
    *SCANNER_CAPABILITY_SETTINGS.values(),
    SCAN_DIAGNOSTICS_SETTING_KEY, PHOTO_PREFERENCE_SETTING_KEY,
    SCANNER_GEMINI_FALLBACK_SETTING_KEY,
}

MANAGED_SCANNER_KEYS = {
    "gemini_api_key",
    "openai_api_key",
    SCANNER_PROVIDER_SETTING,
    *SCANNER_MODEL_SETTINGS.values(),
    *SCANNER_REQUEST_TIMEOUT_SETTINGS.values(),
    *SCANNER_CUSTOM_MODEL_SETTINGS.values(),
    *SCANNER_CAPABILITY_SETTINGS.values(),
    # Prevent the removed PR prototype settings from being recreated through
    # the legacy generic endpoint.
    "scanner_model",
    "scanner_visual_verification",
}


class ScannerConfigurationUpdate(BaseModel):
    provider: str
    model: str
    api_key: str | None = None
    clear_api_key: bool = False
    custom_model: bool = False
    save_on_success: bool = False
    accept_degraded_visual_verification: bool = False
    request_timeout_seconds: int | None = None


SCANNER_TEST_IMAGE_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYElEQVR4nO3PQQ0AIBDAMMC/"
    "50MEj4ZkVbDtWbN+dnTAqwa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0"
    "BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0C2IYAn6MoAmGAAAAAElFTkSuQmCC"
)
SCANNER_TEST_SECOND_IMAGE_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAX0lEQVR4nO3PQQ0AIBDAsAP/"
    "nkEEj4ZkVbCtOfO1rQNeNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1"
    "oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaBdUYYBf0t7CUEAAAAASUVORK5CYII="
)

# Settings that must not be written through the generic settings endpoints,
# because changing them has constraints the dedicated endpoint owns. Writing
# multi_user_mode directly would bypass the USER_MODE environment lock and the
# confirmation shown by the settings page.
DEDICATED_ENDPOINT_KEYS = {
    "multi_user_mode": {
        "label": "Multi-user mode",
        "endpoint": "/api/auth/mode",
    },
}


def _refuse_dedicated_setting(key: str) -> None:
    dedicated = DEDICATED_ENDPOINT_KEYS.get(key)
    if dedicated:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{dedicated['label']} can only be changed through "
                f"{dedicated['endpoint']}"
            ),
        )


ADMIN_ONLY_KEYS = {
    "full_sync_interval_days", "price_sync_interval_minutes", "multi_user_mode",
    "tcgdex_sync_languages", "debug_mode",
    "cross_language_price_fallback", "cross_language_image_fallback",
    DIGITAL_SETS_SETTING_KEY,
    PUBLIC_PROFILES_SETTING_KEY,
    SOCIAL_SETTING_KEY,
}

DEFAULT_SETTINGS = {
    "trainer_name": "TRAINER",
    "full_sync_interval_days": "5",
    "price_sync_interval_minutes": "30",
    "telegram_enabled": "false",
    "telegram_chat_id": "",
    "price_alerts_enabled": "false",
    "price_alert_threshold": "10",
    "language": "en",
    "currency": "EUR",
    "price_primary": "trend",
    "portfolio_display_mode": "portfolio_value",
    "price_display": '["trend", "avg", "avg1", "avg7", "avg30", "low"]',
    "set_overview_filters": "{}",
    "hidden_set_ids": "[]",
    "tcgdex_sync_languages": "en,de",
    DIGITAL_SETS_SETTING_KEY: "true",
    "cross_language_price_fallback": "true",
    "cross_language_image_fallback": "true",
    "debug_mode": "false",
    PUBLIC_PROFILES_SETTING_KEY: "false",
    SOCIAL_SETTING_KEY: "false",
    SCAN_DIAGNOSTICS_SETTING_KEY: "false",
    PHOTO_PREFERENCE_SETTING_KEY: "false",
    SCANNER_GEMINI_FALLBACK_SETTING_KEY: "false",
}


def _normalize_tcgdex_sync_languages(value) -> str:
    try:
        return validate_tcgdex_sync_languages(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _coerce_setting_value(key: str, value) -> str:
    if key in notifications.boolean_keys() or key in feed_service.boolean_keys():
        return "true" if str(value).lower() in {"true", "1", "yes", "on"} else "false"
    if key.startswith(feed_service.SHARE_PREFIX):
        # Only the known sharing choices: a typo must not store a setting that silently does nothing.
        raise HTTPException(status_code=422, detail=f"{key} is not a feed sharing setting")
    if key == notifications.DIGEST_HOUR_KEY:
        return notifications.normalize_digest_hour(value)
    if key == "tcgdex_sync_languages":
        return _normalize_tcgdex_sync_languages(value)
    if key in {
        "debug_mode", "cross_language_price_fallback",
        "cross_language_image_fallback", DIGITAL_SETS_SETTING_KEY,
        PUBLIC_PROFILES_SETTING_KEY, SOCIAL_SETTING_KEY, SCAN_DIAGNOSTICS_SETTING_KEY,
        PHOTO_PREFERENCE_SETTING_KEY, SCANNER_GEMINI_FALLBACK_SETTING_KEY,
    }:
        return "true" if str(value).lower() in {"true", "1", "yes", "on"} else "false"
    if key == "portfolio_display_mode":
        normalized = str(value).strip().lower()
        if normalized not in {"portfolio_value", "capital_invested"}:
            raise HTTPException(status_code=422, detail="portfolio_display_mode is invalid")
        return normalized
    return str(value)


def _apply_setting_side_effect(db: Session, key: str, value: str) -> None:
    if key == "debug_mode":
        enabled = value == "true"
        configure_debug_logging(enabled)
        logger.info("Debug mode setting changed to %s", enabled)
    elif key == DIGITAL_SETS_SETTING_KEY:
        result = refresh_digital_catalogue_flags(db)
        logger.info(
            "Digital set visibility changed to %s; marked %s digital sets and %s digital cards",
            value == "true",
            result["sets_marked"],
            result["cards_marked"],
        )


def _is_admin(db: Session, user_id: int) -> bool:
    user = db.query(User).filter(User.id == user_id).first()
    return user is not None and user.role == "admin"


def _get_user_settings(db: Session, user_id: int) -> dict:
    """Get all settings for a user: per-user from user_settings, global from settings."""
    result = {}

    # Only load admin-only keys from global settings
    for row in db.query(Setting).all():
        if row.key in ADMIN_ONLY_KEYS:
            result[row.key] = row.value

    # Load this user's own settings
    for row in db.query(UserSetting).filter(UserSetting.user_id == user_id).all():
        if row.key not in MANAGED_SCANNER_KEYS:
            result[row.key] = row.value

    # Env var fallback ONLY for admin — other users get empty defaults
    if _is_admin(db, user_id):
        if "telegram_bot_token" not in result:
            env_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
            if env_token:
                result["telegram_bot_token"] = env_token
        if "telegram_chat_id" not in result:
            env_chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
            if env_chat_id:
                result["telegram_chat_id"] = env_chat_id

    for key, value in DEFAULT_SETTINGS.items():
        result.setdefault(key, value)
    for key, value in notifications.default_settings().items():
        result.setdefault(key, value)
    for key, value in feed_service.default_settings().items():
        result.setdefault(key, value)
    if global_scanner_config_enabled():
        if _is_admin(db, user_id):
            result[SCANNER_GEMINI_FALLBACK_SETTING_KEY] = (
                scanner_setting_value(db, user_id, SCANNER_GEMINI_FALLBACK_SETTING_KEY) or "false"
            )
        else:
            # Not theirs to see: the fallback is part of the scanner setup the admins chose.
            result.pop(SCANNER_GEMINI_FALLBACK_SETTING_KEY, None)
            # Only that the section is not theirs, so the app can leave the Scanner row out.
            result["scanner_managed_by_admin"] = "true"
    elif not gemini_enabled():
        result[SCANNER_GEMINI_FALLBACK_SETTING_KEY] = "false"
    result["scan_diagnostics_available"] = "true" if trace_available() else "false"
    result["scan_diagnostics_deletion_available"] = (
        "true" if trace_deletion_available() else "false"
    )

    return result


@router.get("/")
def get_settings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return _get_user_settings(db, current_user.id)


def _scanner_key_name(provider: str) -> str:
    return "gemini_api_key" if provider == GEMINI else "openai_api_key"


def _scanner_requires_key(provider: str) -> bool:
    return provider == GEMINI or openai_requires_key()


def _user_setting(db: Session, user_id: int, key: str):
    """A scanner setting row: the global one when administrators configure everyone's scanner."""
    return scanner_setting_row(db, user_id, key)


def _require_scanner_writer(current_user: User) -> None:
    if global_scanner_config_enabled() and current_user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="The scanner is configured by an administrator for everyone.",
        )


def _key_hint(value: str) -> str:
    """Never the key itself: only that one is set and how it ends."""
    value = (value or "").strip()
    return f"••{value[-4:]}" if len(value) >= 4 else "••"


def _scanner_audit_snapshot(db: Session, user_id: int) -> dict | None:
    """What the global scanner setup is right now, for a before/after comparison. None outside
    global mode, where nothing is audited. The raw keys stay in memory only to tell "replaced" from
    "unchanged"; _scanner_audit_changes never copies them."""
    if not global_scanner_config_enabled():
        return None
    provider = configured_provider_name(db, user_id)
    model = resolve_model(db, user_id, provider) if provider else None
    return {
        "provider": provider,
        "model": model,
        "request_timeout": (
            resolve_scanner_request_timeout(db, user_id, provider) if provider else None
        ),
        "gemini_fallback": scanner_setting_value(
            db, user_id, SCANNER_GEMINI_FALLBACK_SETTING_KEY
        ) == "true",
        "capability": scanner_capability_mode(db, user_id, provider, model) if provider else None,
        "keys": {
            name: scanner_setting_value(db, user_id, _scanner_key_name(name)).strip()
            for name in (GEMINI, OPENAI)
        },
    }


def _scanner_audit_changes(before: dict, after: dict) -> dict:
    """Each field that changed as {"from", "to"}; keys only as added/replaced/removed with the
    last four characters. Never a key value."""
    changes = {}
    for field in ("provider", "model", "request_timeout", "gemini_fallback", "capability"):
        if before[field] != after[field]:
            changes[field] = {"from": before[field], "to": after[field]}
    keys = {}
    for name in (GEMINI, OPENAI):
        old, new = before["keys"][name], after["keys"][name]
        if old == new:
            continue
        entry = {"action": "added" if not old else ("removed" if not new else "replaced")}
        if old:
            entry["from"] = _key_hint(old)
        if new:
            entry["to"] = _key_hint(new)
        keys[name] = entry
    if keys:
        changes["api_key"] = keys
    return changes


def _audit_scanner_change(
    db: Session,
    current_user: User,
    before: dict | None,
    request=None,
    **extra,
) -> None:
    """Global scanner changes affect everyone, so they are audited with what changed (before and
    after for each field) and never a secret. Nothing is recorded in per-user mode or when
    nothing changed."""
    if before is None or not global_scanner_config_enabled():
        return
    changes = _scanner_audit_changes(before, _scanner_audit_snapshot(db, current_user.id))
    if not changes and not extra:
        return
    record_audit(
        db,
        "scanner.config.updated",
        request=request,
        actor=current_user,
        target_type="scanner",
        details={"changes": changes, **extra},
    )


def _refuse_scanner_key_for_user(key: str, current_user: User) -> None:
    """In global mode no one but an administrator may read or write any scanner config key."""
    if (
        global_scanner_config_enabled()
        and current_user.role != "admin"
        and (key in MANAGED_SCANNER_KEYS or key == SCANNER_GEMINI_FALLBACK_SETTING_KEY)
    ):
        raise HTTPException(
            status_code=403,
            detail="The scanner is configured by an administrator for everyone.",
        )


def _store_gemini_fallback(db: Session, current_user: User, value: str, request=None) -> None:
    """The Gemini fallback opt-in: personal normally, shared (admin only) in global mode."""
    if not gemini_enabled():
        value = "false"
    if global_scanner_config_enabled():
        if current_user.role != "admin":
            raise HTTPException(
                status_code=403,
                detail="The scanner is configured by an administrator for everyone.",
            )
        before = _scanner_audit_snapshot(db, current_user.id)
        upsert_scanner_setting(db, current_user.id, SCANNER_GEMINI_FALLBACK_SETTING_KEY, value)
        _audit_scanner_change(db, current_user, before, request)
        return
    row = db.query(UserSetting).filter(
        UserSetting.user_id == current_user.id,
        UserSetting.key == SCANNER_GEMINI_FALLBACK_SETTING_KEY,
    ).first()
    if row:
        row.value = value
    else:
        db.add(UserSetting(
            user_id=current_user.id, key=SCANNER_GEMINI_FALLBACK_SETTING_KEY, value=value
        ))


def _safe_endpoint_summary(url: str) -> str:
    """Show admins where requests go without reflecting credentials or query data."""
    try:
        parsed = urlsplit(url)
        if not parsed.scheme or not parsed.hostname:
            return "Configured endpoint"
        host = parsed.hostname
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        port = f":{parsed.port}" if parsed.port else ""
        return urlunsplit((parsed.scheme, f"{host}{port}", "", "", ""))
    except (TypeError, ValueError):
        return "Configured endpoint"


def _administrator_scanner_summary() -> dict:
    openai_hosted = openai_base_url() == DEFAULT_OPENAI_BASE_URL
    return {
        "setup_guide_url": SCANNER_PROVIDER_GUIDE_URL,
        "providers": [
            {
                "id": GEMINI,
                "label": provider_label(GEMINI),
                "enabled": gemini_enabled(),
                "endpoint_type": "hosted",
                "endpoint": "Google Gemini API",
                "models": allowed_models(GEMINI),
                "requires_api_key": True,
            },
            {
                "id": OPENAI,
                "label": provider_label(OPENAI),
                "enabled": openai_enabled(),
                "endpoint_type": "hosted" if openai_hosted else "custom",
                "endpoint": _safe_endpoint_summary(openai_base_url()),
                "models": allowed_models(OPENAI),
                "requires_api_key": openai_requires_key(),
            },
        ],
    }


def _scanner_configuration(db: Session, user_id: int, *, is_admin: bool = False) -> dict:
    configured_provider = configured_provider_name(db, user_id)
    provider_unavailable = (
        configured_provider is not None
        and configured_provider not in enabled_providers()
    )
    selected = resolve_provider_name(db, user_id)
    is_global = global_scanner_config_enabled()
    hidden = is_global and not is_admin
    providers = []
    for provider in enabled_providers():
        key_row = _user_setting(db, user_id, _scanner_key_name(provider))
        key_configured = bool(key_row and str(key_row.value or "").strip())
        models = allowed_models(provider)
        provider_data = {
            "id": provider,
            "label": provider_label(provider),
            "models": models,
            "default_model": models[0] if models else "",
            "selected_model": resolve_model(db, user_id, provider),
            "request_timeout_seconds": resolve_scanner_request_timeout(
                db, user_id, provider
            ),
            "requires_api_key": _scanner_requires_key(provider),
            "api_key_configured": key_configured,
            "endpoint_type": (
                "hosted"
                if provider == GEMINI or openai_base_url() == DEFAULT_OPENAI_BASE_URL
                else "custom"
            ),
            "key_help_url": provider_key_help_url(provider),
            "setup_help_url": SCANNER_PROVIDER_GUIDE_URL,
        }
        if is_admin and is_global and key_configured:
            provider_data["api_key_hint"] = _key_hint(key_row.value)
        if is_admin:
            custom_row = _user_setting(
                db, user_id, SCANNER_CUSTOM_MODEL_SETTINGS[provider]
            )
            custom_model = ((custom_row.value if custom_row else "") or "").strip()
            provider_data["custom_model_allowed"] = True
            provider_data["custom_model"] = (
                custom_model if MODEL_PATTERN.fullmatch(custom_model) else ""
            )
        providers.append(provider_data)
    scope = {
        "scope": "global" if is_global else "user",
        "editable": is_admin or not is_global,
        "gemini_enabled": gemini_enabled(),
        "global_configured": global_scanner_config_exists(db) if is_global else None,
        "request_timeout_options": list(SCANNER_REQUEST_TIMEOUT_OPTIONS),
    }
    active = next((item for item in providers if item["id"] == selected), None)
    if hidden:
        # Users who are not administrators get no scanner configuration at all in global mode:
        # no provider, label, model, timeout or key status. Only what the scan screens need.
        capability = (
            scanner_capability_mode(db, user_id, selected, active["selected_model"])
            if active is not None
            else None
        )
        ready_for_scans = (
            active is not None
            and bool(active["selected_model"])
            and (not active["requires_api_key"] or active["api_key_configured"])
            and capability is not None
        )
        return {
            "scope": "global",
            "editable": False,
            "scanning_available": ready_for_scans,
            "visual_verification": (
                "disabled"
                if capability == SCANNER_CAPABILITY_DEGRADED
                else ("automatic" if capability == SCANNER_CAPABILITY_FULL else "unverified")
            ),
        }
    if active is None:
        # No provider is enabled on this installation (for example Gemini is off and the
        # OpenAI-compatible provider is not enabled).
        result = {
            **scope,
            "provider": "",
            "model": "",
            "request_timeout_seconds": DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS,
            "providers": [],
            "status": "unavailable",
            "visual_verification": "unverified",
        }
        if is_admin:
            result["administrator"] = _administrator_scanner_summary()
        return result
    ready = not active["requires_api_key"] or active["api_key_configured"]
    capability_mode = scanner_capability_mode(
        db, user_id, selected, active["selected_model"]
    )
    status = (
        "admin_setup_required"
        if not active["selected_model"]
        else (
            "api_key_required"
            if not ready
            else (
                "retest_required"
                if provider_unavailable or capability_mode is None
                else "ready"
            )
        )
    )
    result = {
        **scope,
        "provider": selected,
        "model": active["selected_model"],
        "request_timeout_seconds": active["request_timeout_seconds"],
        "request_timeout_options": list(SCANNER_REQUEST_TIMEOUT_OPTIONS),
        "providers": providers,
        "status": status,
        "visual_verification": (
            "disabled"
            if capability_mode == SCANNER_CAPABILITY_DEGRADED
            else ("automatic" if capability_mode == SCANNER_CAPABILITY_FULL else "unverified")
        ),
    }
    if is_admin:
        result["administrator"] = _administrator_scanner_summary()
    return result


def _validated_scanner_draft(
    data: ScannerConfigurationUpdate,
    db: Session,
    current_user: User,
    *,
    require_ready: bool = False,
    allow_unverified_custom_model: bool = False,
) -> tuple[str, str, str, bool, int]:
    user_id = current_user.id
    provider = data.provider.strip().lower()
    if provider not in enabled_providers():
        raise HTTPException(status_code=422, detail="This scanner provider is not enabled by the administrator.")
    model = data.model.strip()
    custom_model = model not in allowed_models(provider)
    if custom_model:
        if not data.custom_model or current_user.role != "admin":
            raise HTTPException(status_code=422, detail="Choose one of the models enabled by the administrator.")
        if not MODEL_PATTERN.fullmatch(model):
            raise HTTPException(
                status_code=422,
                detail="Enter a valid custom model identifier.",
            )
        verified = _user_setting(
            db, user_id, SCANNER_CUSTOM_MODEL_SETTINGS[provider]
        )
        verified_model = ((verified.value if verified else "") or "").strip()
        if not allow_unverified_custom_model and verified_model != model:
            raise HTTPException(
                status_code=422,
                detail="A new custom model must pass the scanner image test before it can be saved.",
            )
    if data.api_key is not None and len(data.api_key) > 4096:
        raise HTTPException(status_code=422, detail="API key is too long.")
    existing = _user_setting(db, user_id, _scanner_key_name(provider))
    credential = ((existing.value if existing else "") or "").strip()
    if data.clear_api_key:
        credential = ""
    elif data.api_key is not None:
        credential = data.api_key.strip()
    if require_ready and _scanner_requires_key(provider) and not credential:
        raise HTTPException(status_code=422, detail="An API key is required for this provider.")
    try:
        request_timeout_seconds = (
            resolve_scanner_request_timeout(db, user_id, provider)
            if data.request_timeout_seconds is None
            else normalize_scanner_request_timeout(data.request_timeout_seconds)
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return provider, model, credential, custom_model, request_timeout_seconds


def _upsert_user_setting(db: Session, user_id: int, key: str, value: str) -> None:
    upsert_scanner_setting(db, user_id, key, value)


def _persist_scanner_draft(
    db: Session,
    user_id: int,
    data: ScannerConfigurationUpdate,
    provider: str,
    model: str,
    credential: str,
    custom_model: bool,
    request_timeout_seconds: int,
) -> None:
    _upsert_user_setting(db, user_id, SCANNER_PROVIDER_SETTING, provider)
    _upsert_user_setting(db, user_id, SCANNER_MODEL_SETTINGS[provider], model)
    _upsert_user_setting(
        db,
        user_id,
        SCANNER_CUSTOM_MODEL_SETTINGS[provider],
        model if custom_model else "",
    )
    _upsert_user_setting(
        db,
        user_id,
        SCANNER_REQUEST_TIMEOUT_SETTINGS[provider],
        str(request_timeout_seconds),
    )
    if data.api_key is not None or data.clear_api_key:
        _upsert_user_setting(db, user_id, _scanner_key_name(provider), credential)


def _persist_scanner_capability(
    db: Session,
    user_id: int,
    provider: str,
    model: str,
    mode: str,
) -> None:
    _upsert_user_setting(
        db,
        user_id,
        SCANNER_CAPABILITY_SETTINGS[provider],
        scanner_capability_proof(provider, model, mode),
    )


def _matches_capability_answer(text: str, expected: tuple[str, ...]) -> bool:
    """Accept harmless formatting while still requiring only the requested colors."""
    cleaned = re.sub(r"[*_`~]", "", str(text or "").upper()).strip()
    separator = r"\s*[-\u2013\u2014]\s*"
    answer = separator.join(re.escape(color) for color in expected)
    return re.fullmatch(rf"\s*{answer}\s*[.!?]?\s*", cleaned) is not None


@router.get("/scanner")
def get_scanner_configuration(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    return _scanner_configuration(db, current_user.id, is_admin=current_user.role == "admin")


@router.put("/scanner")
def update_scanner_configuration(
    data: ScannerConfigurationUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    request: Request = None,
):
    _require_scanner_writer(current_user)
    provider, model, credential, custom_model, request_timeout_seconds = _validated_scanner_draft(
        data, db, current_user
    )
    if not (
        data.clear_api_key
        and data.api_key is None
        and provider == resolve_provider_name(db, current_user.id)
        and model == resolve_model(db, current_user.id, provider)
        and request_timeout_seconds
        == resolve_scanner_request_timeout(db, current_user.id, provider)
    ):
        raise HTTPException(
            status_code=409,
            detail="Scanner configuration changes must pass Test and save.",
        )
    before = _scanner_audit_snapshot(db, current_user.id)
    _persist_scanner_draft(
        db,
        current_user.id,
        data,
        provider,
        model,
        credential,
        custom_model,
        request_timeout_seconds,
    )
    _audit_scanner_change(db, current_user, before, request)
    db.commit()
    return _scanner_configuration(db, current_user.id, is_admin=current_user.role == "admin")


@router.post("/scanner/global/adopt")
def adopt_scanner_settings_for_everyone(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    request: Request = None,
):
    """Copy the calling administrator's own scanner settings (key included) into the global
    configuration, once, when global mode is on and nothing has been saved yet."""
    if not global_scanner_config_enabled():
        raise HTTPException(status_code=409, detail="The scanner is not configured globally.")
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    if global_scanner_config_exists(db):
        raise HTTPException(status_code=409, detail="A global scanner configuration already exists.")
    keys = [
        "gemini_api_key",
        "openai_api_key",
        SCANNER_PROVIDER_SETTING,
        SCANNER_GEMINI_FALLBACK_SETTING_KEY,
        *SCANNER_MODEL_SETTINGS.values(),
        *SCANNER_REQUEST_TIMEOUT_SETTINGS.values(),
        *SCANNER_CUSTOM_MODEL_SETTINGS.values(),
        *SCANNER_CAPABILITY_SETTINGS.values(),
    ]
    own = {
        row.key: row.value
        for row in db.query(UserSetting).filter(
            UserSetting.user_id == current_user.id, UserSetting.key.in_(keys)
        )
    }
    provider = (own.get(SCANNER_PROVIDER_SETTING) or "").strip().lower()
    if provider not in enabled_providers():
        raise HTTPException(
            status_code=409,
            detail="Choose, test and save an available scanner provider in your own settings first.",
        )
    if not gemini_enabled():
        own.pop(SCANNER_GEMINI_FALLBACK_SETTING_KEY, None)
    before = _scanner_audit_snapshot(db, current_user.id)
    for key, value in own.items():
        db.add(Setting(key=global_scanner_key(key), value=value))
    _audit_scanner_change(
        db,
        current_user,
        before,
        request,
        source="admin_settings_copied",
        copied_from={"user_id": current_user.id, "username": current_user.username},
    )
    db.commit()
    return _scanner_configuration(db, current_user.id, is_admin=True)


@router.post("/scanner/test")
async def test_scanner_configuration(
    data: ScannerConfigurationUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    request: Request = None,
):
    _require_scanner_writer(current_user)
    if data.accept_degraded_visual_verification and current_user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Only an administrator can accept reduced scanner accuracy.",
        )
    provider, model, credential, custom_model, request_timeout_seconds = _validated_scanner_draft(
        data,
        db,
        current_user,
        require_ready=True,
        allow_unverified_custom_model=True,
    )
    candidate = ScanProvider(provider, model)
    # Use the same selected response budget as real scans so a slow local model
    # is not rejected by the setup test before users can enable it.
    async with httpx.AsyncClient(timeout=request_timeout_seconds) as client:
        multi_error = None
        try:
            text, _usage = await candidate.generate_text(
                client,
                credential,
                [
                    text_part(
                        "Inspect both images in their supplied order. Identify each solid "
                        "fill color using only MAGENTA, GREEN, BLUE, or ORANGE. Reply "
                        "with exactly COLOR-COLOR and no other text."
                    ),
                    image_part("image/png", SCANNER_TEST_IMAGE_B64),
                    image_part("image/png", SCANNER_TEST_SECOND_IMAGE_B64),
                ],
                max_attempts=3,
            )
        except HTTPException as exc:
            if not (
                isinstance(exc, ProviderRequestRejectedError)
                and exc.rejection_reason == "multiple_images_unsupported"
            ):
                raise
            multi_error = exc
            text = ""

        capability_mode = SCANNER_CAPABILITY_FULL
        if not _matches_capability_answer(text, ("MAGENTA", "GREEN")):
            try:
                single_text, _usage = await candidate.generate_text(
                    client,
                    credential,
                    [
                        text_part(
                            "Identify the solid fill color in this image using only "
                            "MAGENTA, GREEN, BLUE, or ORANGE. Reply with exactly the "
                            "color and no other text."
                        ),
                        image_part("image/png", SCANNER_TEST_IMAGE_B64),
                    ],
                    max_attempts=3,
                )
            except HTTPException:
                if multi_error is not None:
                    raise multi_error
                raise
            if not _matches_capability_answer(single_text, ("MAGENTA",)):
                raise HTTPException(
                    status_code=502,
                    detail="The selected model did not complete the scanner image test.",
                )
            if provider != OPENAI:
                raise HTTPException(
                    status_code=502,
                    detail="The selected model did not complete the scanner image test.",
                )
            if current_user.role != "admin":
                raise HTTPException(
                    status_code=502,
                    detail=(
                        "This model cannot compare multiple images. Ask an administrator "
                        "to review the scanner setup."
                    ),
                )
            if not data.accept_degraded_visual_verification:
                return {
                    "status": "degraded_confirmation_required",
                    "saved": False,
                    "visual_verification": False,
                }
            capability_mode = SCANNER_CAPABILITY_DEGRADED

    if data.save_on_success:
        before = _scanner_audit_snapshot(db, current_user.id)
        _persist_scanner_draft(
            db,
            current_user.id,
            data,
            provider,
            model,
            credential,
            custom_model,
            request_timeout_seconds,
        )
        _persist_scanner_capability(
            db,
            current_user.id,
            provider,
            model,
            capability_mode,
        )
        _audit_scanner_change(db, current_user, before, request)
        db.commit()
    return {
        "status": "ready" if capability_mode == SCANNER_CAPABILITY_FULL else "degraded",
        "saved": data.save_on_success,
        "visual_verification": capability_mode == SCANNER_CAPABILITY_FULL,
    }


@router.get("/tcgdex-languages")
def get_tcgdex_languages(current_user: User = Depends(get_current_user)):
    return {
        "languages": supported_tcgdex_language_payload(),
        "default": list(DEFAULT_TCGDEX_SYNC_LANGUAGES),
        "english_fallback": "en",
    }


@router.get("/tcgdex-filter-languages")
def get_tcgdex_filter_languages(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    visible_codes = set(get_visible_filter_languages(db, current_user.id))
    return {
        "languages": [
            language for language in supported_tcgdex_language_payload()
            if language["code"] in visible_codes
        ],
    }


@router.put("/")
def update_settings(
    data: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    request: Request = None,
):
    for scanner_key in data:
        _refuse_scanner_key_for_user(scanner_key, current_user)
    if MANAGED_SCANNER_KEYS.intersection(data):
        raise HTTPException(
            status_code=409,
            detail="Use the atomic scanner configuration endpoint for scanner settings.",
        )
    pending_side_effects = []
    for key, value in data.items():
        _refuse_dedicated_setting(key)
        coerced_value = _coerce_setting_value(key, value)
        if key in ADMIN_ONLY_KEYS:
            if current_user.role != "admin":
                if key in {PUBLIC_PROFILES_SETTING_KEY, SOCIAL_SETTING_KEY}:
                    raise HTTPException(status_code=403, detail="Admin only")
                continue
            row = db.query(Setting).filter(Setting.key == key).first()
            if row:
                row.value = coerced_value
            else:
                db.add(Setting(key=key, value=coerced_value))
            pending_side_effects.append((key, coerced_value))
        elif key == SCANNER_GEMINI_FALLBACK_SETTING_KEY:
            _store_gemini_fallback(db, current_user, coerced_value, request)
        else:
            row = db.query(UserSetting).filter(
                UserSetting.user_id == current_user.id, UserSetting.key == key
            ).first()
            if row:
                row.value = coerced_value
            else:
                db.add(UserSetting(user_id=current_user.id, key=key, value=coerced_value))
    for key, value in pending_side_effects:
        _apply_setting_side_effect(db, key, value)
    db.commit()
    return _get_user_settings(db, current_user.id)


@router.get("/debug-log")
def download_debug_log(current_user: User = Depends(get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    path = get_debug_log_path()
    return Response(
        content=path.read_bytes(),
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="pokecollector-debug.log"',
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@router.delete("/scan-diagnostics")
def delete_scan_diagnostics(
    current_user: User = Depends(get_current_user),
):
    try:
        deleted = delete_user_traces(current_user.id)
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail="Stored scanner diagnostics could not be deleted.",
        ) from exc
    return {"deleted": deleted}


@router.delete("/card-photos")
def delete_card_photos(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete only this user's private collection-card photos."""
    deleted = db.query(CollectionCardPhoto).filter(
        CollectionCardPhoto.user_id == current_user.id,
    ).delete(synchronize_session=False)
    db.commit()
    return {"deleted": int(deleted or 0)}


@router.get("/telegram_status")
def get_telegram_status(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = _get_user_settings(db, current_user.id)
    token = settings.get("telegram_bot_token", "")
    chat_id = settings.get("telegram_chat_id", "")
    return {"configured": bool(token and chat_id)}


@router.get("/exchange-rate")
def get_exchange_rate(
    from_currency: str = Query(alias="from"),
    to_currency: str = Query(alias="to"),
    _current_user: User = Depends(get_current_user),
):
    try:
        source, target = normalize_currency_pair(from_currency, to_currency)
    except ExchangeRateError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None

    fallback_rate = fallback_exchange_rate(source, target)
    if source == target:
        return {"from": source, "to": target, "rate": fallback_rate, "fallback": False}

    try:
        response = httpx.get(
            f"https://api.frankfurter.dev/v2/rate/{source}/{target}",
            timeout=8,
        )
        response.raise_for_status()
        rate = parse_frankfurter_v2_rate(response.json())
        return {"from": source, "to": target, "rate": rate, "fallback": False}
    except Exception as exc:
        logger.warning("Failed to fetch exchange rate %s to %s: %s", source, target, exc)
        if fallback_rate is None:
            raise HTTPException(status_code=502, detail="Exchange rate unavailable") from None
        return {"from": source, "to": target, "rate": fallback_rate, "fallback": True}


@router.get("/currencies")
def get_currencies(_current_user: User = Depends(get_current_user)):
    cached = get_cached_currencies()
    if cached is not None:
        return {"currencies": cached}
    try:
        response = httpx.get("https://api.frankfurter.dev/v2/currencies", timeout=8)
        response.raise_for_status()
        items = parse_frankfurter_currencies(response.json())
        set_cached_currencies(items)
        return {"currencies": items}
    except Exception as exc:
        logger.warning("Failed to fetch currency list: %s", exc)
        items = stale_currencies() or [
            {"code": "EUR", "name": "Euro", "symbol": "€"},
            {"code": "USD", "name": "United States Dollar", "symbol": "$"},
        ]
        return {"currencies": items}


@router.get("/{key}")
def get_setting(key: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _refuse_scanner_key_for_user(key, current_user)
    if key in MANAGED_SCANNER_KEYS:
        raise HTTPException(
            status_code=409,
            detail="Use the scanner configuration endpoint for scanner settings.",
        )
    if key == "sync_interval_hours":
        settings = _get_user_settings(db, current_user.id)
        days = int(settings.get("full_sync_interval_days", "5"))
        return {"key": key, "value": str(days * 24)}
    settings = _get_user_settings(db, current_user.id)
    if key in settings:
        return {"key": key, "value": settings[key]}
    raise HTTPException(status_code=404, detail=f"Setting {key} not found")


@router.post("/{key}")
def set_setting(
    key: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    request: Request = None,
):
    _refuse_scanner_key_for_user(key, current_user)
    if key in MANAGED_SCANNER_KEYS:
        raise HTTPException(
            status_code=409,
            detail="Use the atomic scanner configuration endpoint for scanner settings.",
        )
    _refuse_dedicated_setting(key)
    value = _coerce_setting_value(key, body.get("value", ""))
    if key in ADMIN_ONLY_KEYS:
        if current_user.role != "admin":
            raise HTTPException(status_code=403, detail="Admin only")
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = value
        else:
            db.add(Setting(key=key, value=value))
        pending_side_effect = (key, value)
    elif key == SCANNER_GEMINI_FALLBACK_SETTING_KEY:
        _store_gemini_fallback(db, current_user, value, request)
        value = scanner_setting_value(db, current_user.id, key) or "false"
    else:
        row = db.query(UserSetting).filter(
            UserSetting.user_id == current_user.id, UserSetting.key == key
        ).first()
        if row:
            row.value = value
        else:
            db.add(UserSetting(user_id=current_user.id, key=key, value=value))
    if key in ADMIN_ONLY_KEYS:
        _apply_setting_side_effect(db, *pending_side_effect)
    db.commit()
    return {"key": key, "value": value}
