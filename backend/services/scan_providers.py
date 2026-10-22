"""Vision providers for the card scanner.

Gemini stays the default and its request path is untouched: this module calls the
existing post_gemini_generate() rather than reimplementing it, so Gemini keeps its
own retry, rate limiting and quota handling exactly as before.

The second provider speaks the OpenAI chat-completions API, which covers hosted
OpenAI and any compatible local server (Ollama, llama.cpp, LM Studio).

Two rules shape the design:

- The base URL is read from the environment only. A user-supplied backend URL would
  let any account point the server at an arbitrary host, which is a server-side
  request forgery. Administrators configure the endpoint; users only choose between
  the providers the administrator has made available.
- Gemini retains its existing paced per-key limiter. Other providers persist only
  upstream blocks: hosted scopes use a non-reversible key fingerprint and keyless
  local scopes use the administrator-controlled endpoint.
"""

import base64
import datetime
import json
import logging
import math
import os
import re
from contextlib import nullcontext
from email.utils import parsedate_to_datetime

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import Setting, User, UserSetting

logger = logging.getLogger(__name__)

GEMINI = "gemini"
OPENAI = "openai"
SCANNER_PROVIDER_SETTING = "scanner_provider"
SCANNER_MODEL_SETTINGS = {
    GEMINI: "scanner_model_gemini",
    OPENAI: "scanner_model_openai",
}
SCANNER_REQUEST_TIMEOUT_SETTINGS = {
    GEMINI: "scanner_request_timeout_gemini",
    OPENAI: "scanner_request_timeout_openai",
}
SCANNER_REQUEST_TIMEOUT_OPTIONS = (30, 60, 120, 180)
DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS = SCANNER_REQUEST_TIMEOUT_OPTIONS[0]
MAX_SCANNER_REQUEST_TIMEOUT_SECONDS = SCANNER_REQUEST_TIMEOUT_OPTIONS[-1]
SCANNER_CUSTOM_MODEL_SETTINGS = {
    GEMINI: "scanner_custom_model_gemini",
    OPENAI: "scanner_custom_model_openai",
}
SCANNER_CAPABILITY_SETTINGS = {
    GEMINI: "scanner_capability_gemini",
    OPENAI: "scanner_capability_openai",
}
SCANNER_CAPABILITY_FULL = "full"
SCANNER_CAPABILITY_DEGRADED = "degraded"
SCANNER_CAPABILITY_VERSION = 1

# Opt-in, off by default: retry with Gemini when the OpenAI-compatible
# provider could not confidently identify a card on its own. Gemini-as-primary
# has nothing to fall back to, so this only ever applies the other direction.
SCANNER_GEMINI_FALLBACK_SETTING_KEY = "scanner_gemini_fallback"

DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
# The OpenAI counterpart to DEFAULT_GEMINI_MODEL: what an installation uses when
# no model is configured. Chosen on measured card-scanning behaviour rather than
# headline price, and overridable per installation and per user.
DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
SCANNER_PROVIDER_GUIDE_URL = (
    "https://github.com/Git-Romer/pokecollector/blob/main/docs/scanner-providers.md"
)
GEMINI_API_KEY_HELP_URL = "https://aistudio.google.com/apikey"
OPENAI_API_KEY_HELP_URL = "https://platform.openai.com/api-keys"

OPENAI_TRANSIENT_STATUS_CODES = {408, 425, 500, 502, 503, 504}
MODEL_PATTERN = re.compile(r"[A-Za-z0-9._:/-]{1,100}")


def openai_base_url() -> str:
    """Where OpenAI-compatible requests go, set by the administrator.

    Stripped before the fallback, because a value of only whitespace is truthy and
    would otherwise pass through as an empty base URL.
    """
    configured = (os.environ.get("OPENAI_BASE_URL") or "").strip().rstrip("/")
    return configured or DEFAULT_OPENAI_BASE_URL


def openai_chat_completions_url() -> str:
    return f"{openai_base_url()}/chat/completions"


def openai_model() -> str:
    return (os.environ.get("OPENAI_MODEL") or "").strip() or DEFAULT_OPENAI_MODEL


def _env_bool(name: str, default: bool) -> bool:
    value = (os.environ.get(name) or "").strip().lower()
    if not value:
        return default
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def global_scanner_config_enabled() -> bool:
    """One scanner configuration for everyone, set by administrators (SCANNER_GLOBAL_CONFIG)."""
    return _env_bool("SCANNER_GLOBAL_CONFIG", False)


def gemini_enabled() -> bool:
    """Gemini can be switched off for the whole installation (GEMINI_SCANNER_ENABLED)."""
    return _env_bool("GEMINI_SCANNER_ENABLED", True)


# Global mode keeps the same keys as the per-user settings, in the Setting table under this
# prefix, so every reader below only differs in where it looks.
GLOBAL_SCANNER_PREFIX = "scanner_global."


def global_scanner_key(key: str) -> str:
    return f"{GLOBAL_SCANNER_PREFIX}{key}"


def scanner_setting_row(db: Session, user_id: int | None, key: str):
    """The row holding a scanner setting: the global one in global mode, else the user's own."""
    if global_scanner_config_enabled():
        return db.query(Setting).filter(Setting.key == global_scanner_key(key)).first()
    if user_id is None:
        return None
    return (
        db.query(UserSetting)
        .filter(UserSetting.user_id == user_id, UserSetting.key == key)
        .first()
    )


def scanner_setting_value(db: Session, user_id: int | None, key: str) -> str:
    row = scanner_setting_row(db, user_id, key)
    return ((row.value if row else "") or "")


def upsert_scanner_setting(db: Session, user_id: int, key: str, value: str) -> None:
    row = scanner_setting_row(db, user_id, key)
    if row:
        row.value = value
    elif global_scanner_config_enabled():
        db.add(Setting(key=global_scanner_key(key), value=value))
    else:
        db.add(UserSetting(user_id=user_id, key=key, value=value))


NEUTRAL_SCAN_ERROR = "Scanning isn't available right now. Ask your admin."

# Words that mark an error as being about the scanner setup rather than the photo.
_CONFIG_ERROR_MARKERS = (
    "api key",
    "api-key",
    "settings",
    "einstellungen",
    "scanner model",
    "billing",
    "quota",
    "no longer enabled",
    "isn't set up",
    "endpoint",
    "gemini",
    "openai",
    "administrator",
)


def scanner_config_hidden(db: Session, user_id: int | None) -> bool:
    """In global mode only administrators may know how the scanner is configured."""
    if user_id is None or not global_scanner_config_enabled():
        return False
    user = db.query(User).filter(User.id == user_id).first()
    return user is not None and user.role != "admin"


def user_scan_error(db: Session, user_id: int | None, detail):
    """The message a user may see: a neutral one when it would reveal the scanner setup."""
    if not isinstance(detail, str) or not scanner_config_hidden(db, user_id):
        return detail
    lowered = detail.lower()
    return NEUTRAL_SCAN_ERROR if any(marker in lowered for marker in _CONFIG_ERROR_MARKERS) else detail


def config_error(db: Session, user_id: int | None, status_code: int, detail: str) -> HTTPException:
    """An HTTPException about the scanner setup, neutral for users who must not see it."""
    return HTTPException(
        status_code=status_code,
        detail=NEUTRAL_SCAN_ERROR if scanner_config_hidden(db, user_id) else detail,
    )


def global_scanner_config_exists(db: Session) -> bool:
    """Whether an administrator has saved a global scanner provider yet."""
    return (
        db.query(Setting)
        .filter(Setting.key == global_scanner_key(SCANNER_PROVIDER_SETTING))
        .first()
        is not None
    )


def openai_enabled() -> bool:
    """OpenAI-compatible scanning is opt-in at installation level."""
    return _env_bool("OPENAI_SCANNER_ENABLED", False)


def openai_requires_key() -> bool:
    default = openai_base_url() == DEFAULT_OPENAI_BASE_URL
    return _env_bool("OPENAI_API_KEY_REQUIRED", default)


def provider_label(provider: str) -> str:
    """Return an administrator-controlled display label, never raw markup."""
    if provider == GEMINI:
        return "Gemini"
    fallback = "OpenAI" if openai_base_url() == DEFAULT_OPENAI_BASE_URL else "OpenAI-compatible"
    configured = " ".join((os.environ.get("OPENAI_PROVIDER_LABEL") or "").split())
    if not configured or len(configured) > 60 or any(ord(char) < 32 for char in configured):
        return fallback
    return configured


def provider_key_help_url(provider: str) -> str | None:
    if provider == GEMINI:
        return GEMINI_API_KEY_HELP_URL
    if openai_base_url() == DEFAULT_OPENAI_BASE_URL:
        return OPENAI_API_KEY_HELP_URL
    return None


def _allowed_models(env_name: str, installation_model: str) -> list[str]:
    values = [part.strip() for part in (os.environ.get(env_name) or "").split(",")]
    models = []
    for value in [installation_model, *values]:
        if value and MODEL_PATTERN.fullmatch(value) and value not in models:
            models.append(value)
    return models


def installation_model(provider: str) -> str:
    if provider == GEMINI:
        from api.recognize import get_gemini_model

        return get_gemini_model()
    return openai_model()


def allowed_models(provider: str) -> list[str]:
    if provider == GEMINI:
        return _allowed_models("GEMINI_ALLOWED_MODELS", installation_model(provider))
    return _allowed_models("OPENAI_ALLOWED_MODELS", installation_model(provider))


def enabled_providers() -> tuple[str, ...]:
    providers = []
    if gemini_enabled():
        providers.append(GEMINI)
    if openai_enabled():
        providers.append(OPENAI)
    return tuple(providers)


def _capability_endpoint_fingerprint(provider: str) -> str:
    """Bind capability proof to an endpoint without storing endpoint credentials."""
    from services.auth import secret_fingerprint

    endpoint = "google-gemini-api" if provider == GEMINI else openai_base_url()
    return secret_fingerprint("scanner-capability-endpoint", f"{provider}\0{endpoint}")


def scanner_capability_proof(provider: str, model: str, mode: str) -> str:
    if mode not in {SCANNER_CAPABILITY_FULL, SCANNER_CAPABILITY_DEGRADED}:
        raise ValueError("Unsupported scanner capability mode")
    return json.dumps(
        {
            "version": SCANNER_CAPABILITY_VERSION,
            "model": model,
            "endpoint_fingerprint": _capability_endpoint_fingerprint(provider),
            "mode": mode,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def scanner_capability_mode(
    db: Session,
    user_id: int | None,
    provider: str,
    model: str,
) -> str | None:
    """Return the capability proved for this exact provider, model, and endpoint.

    Gemini keeps its established automatic visual-verification behaviour. An
    OpenAI-compatible endpoint is opt-in and must carry a reusable proof so an
    administrator changing OPENAI_BASE_URL cannot accidentally reuse a result
    obtained from a different server.
    """
    if provider == GEMINI:
        return SCANNER_CAPABILITY_FULL
    if user_id is None and not global_scanner_config_enabled():
        return None
    try:
        proof = json.loads(
            scanner_setting_value(db, user_id, SCANNER_CAPABILITY_SETTINGS[provider]) or ""
        )
    except (TypeError, ValueError):
        return None
    if not isinstance(proof, dict):
        return None
    if proof.get("version") != SCANNER_CAPABILITY_VERSION:
        return None
    if proof.get("model") != model:
        return None
    if proof.get("endpoint_fingerprint") != _capability_endpoint_fingerprint(provider):
        return None
    mode = proof.get("mode")
    return mode if mode in {SCANNER_CAPABILITY_FULL, SCANNER_CAPABILITY_DEGRADED} else None


def require_scanner_capability_mode(
    db: Session,
    user_id: int | None,
    provider: str,
    model: str,
) -> str:
    """Require a proof for compatible providers before any scan reaches them."""
    mode = scanner_capability_mode(db, user_id, provider, model)
    if provider == OPENAI and mode is None:
        raise config_error(
            db,
            user_id,
            409,
            "The scanner provider or endpoint changed. Test and save it again "
            "in Scanner Settings before scanning.",
        )
    return mode or SCANNER_CAPABILITY_FULL


def resolve_model(db: Session, user_id: int | None, provider: str) -> str:
    """Resolve a provider-specific model, constrained by the admin allowlist."""
    models = allowed_models(provider)
    is_global = global_scanner_config_enabled()
    if user_id is None and not is_global:
        return models[0] if models else ""
    selected = scanner_setting_value(db, user_id, SCANNER_MODEL_SETTINGS[provider]).strip()
    if selected in models:
        return selected

    custom_model = scanner_setting_value(
        db, user_id, SCANNER_CUSTOM_MODEL_SETTINGS[provider]
    ).strip()
    if custom_model == selected and MODEL_PATTERN.fullmatch(custom_model):
        # A global custom model was saved by an administrator; a per-user one only counts
        # while its owner is still one.
        if is_global:
            return custom_model
        user = db.query(User).filter(User.id == user_id).first()
        if user and user.role == "admin":
            return custom_model
    return models[0] if models else ""


def normalize_scanner_request_timeout(value: object) -> int:
    """Accept only the bounded timeout choices exposed by Scanner Settings."""
    try:
        timeout = int(str(value).strip())
    except (TypeError, ValueError) as exc:
        raise ValueError("Choose a supported scanner response timeout.") from exc
    if timeout not in SCANNER_REQUEST_TIMEOUT_OPTIONS:
        raise ValueError("Choose a supported scanner response timeout.")
    return timeout


def resolve_scanner_request_timeout(
    db: Session,
    user_id: int | None,
    provider: str,
) -> int:
    """Return a safe provider-specific timeout, defaulting legacy/bad rows."""
    if user_id is None and not global_scanner_config_enabled():
        return DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS
    try:
        return normalize_scanner_request_timeout(
            scanner_setting_value(db, user_id, SCANNER_REQUEST_TIMEOUT_SETTINGS[provider]) or None
        )
    except ValueError:
        return DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS


def configured_provider_name(db: Session, user_id: int | None) -> str | None:
    """Return a recognized stored provider without applying availability fallback."""
    if user_id is None and not global_scanner_config_enabled():
        return None
    value = scanner_setting_value(db, user_id, SCANNER_PROVIDER_SETTING).strip().lower()
    return value if value in {GEMINI, OPENAI} else None


def gemini_fallback_enabled(db: Session, user_id: int | None) -> bool:
    """Whether this user opted in to retrying an unconfident OpenAI-provider
    scan with Gemini. Off by default; only meaningful for OPENAI as primary."""
    if not gemini_enabled():
        return False
    if user_id is None and not global_scanner_config_enabled():
        return False
    return scanner_setting_value(db, user_id, SCANNER_GEMINI_FALLBACK_SETTING_KEY) == "true"


def resolve_provider_name(
    db: Session,
    user_id: int | None,
    *,
    require_enabled: bool = False,
) -> str:
    """Which provider this user selected, defaulting legacy values to Gemini.

    An unrecognised stored value falls back rather than raising: settings validation
    rejects bad input at write time, and a scan is the wrong place to fail over a
    configuration typo. A recognised provider that an administrator later disables
    may fall back only while rendering Settings. Runtime provider resolution fails
    closed so a card photo can never be rerouted to another provider silently.
    """
    enabled = enabled_providers()
    if not enabled:
        if require_enabled:
            raise config_error(
                db,
                user_id,
                409,
                "Scanning isn't set up. Ask an administrator to enable a scanner provider.",
            )
        return GEMINI
    value = configured_provider_name(db, user_id)
    if value is None:
        return enabled[0]
    if value not in enabled:
        if require_enabled:
            raise config_error(
                db,
                user_id,
                409,
                "Your selected scanner provider is no longer enabled. Choose and "
                "test an available provider in Scanner Settings before scanning.",
            )
        return enabled[0]
    return value


class ProviderRateLimitError(HTTPException):
    """A 429 carrying the retry metadata scan_queue reads off the exception.

    scan_queue._scan_error_from_http() pulls retry_after_seconds and
    retry_reason by getattr, so a plain HTTPException would be retried with no
    backoff at all.
    """

    def __init__(
        self, *, retry_after_seconds: float | None, detail: str, reason: str = "rate_limit"
    ):
        self.retry_after_seconds = (
            float(retry_after_seconds) if retry_after_seconds else None
        )
        self.retry_reason = reason
        headers = None
        if self.retry_after_seconds:
            headers = {"Retry-After": str(max(1, int(self.retry_after_seconds + 0.999)))}
        super().__init__(status_code=429, detail=detail, headers=headers)


class ProviderRequestRejectedError(HTTPException):
    """A safe provider rejection with an internal, machine-readable reason."""

    def __init__(self, *, detail: str, reason: str = "request_rejected"):
        self.rejection_reason = reason
        super().__init__(status_code=400, detail=detail)


def openai_error_code(resp: httpx.Response) -> tuple[str, str]:
    """Return bounded machine-readable classification, never provider prose."""
    try:
        payload = resp.json()
    except Exception:
        return "", ""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            error_type = str(error.get("type") or "")[:80]
            code = str(error.get("code") or "")[:80]
            safe = re.compile(r"[A-Za-z0-9_.-]{0,80}")
            return (
                error_type if safe.fullmatch(error_type) else "",
                code if safe.fullmatch(code) else "",
            )
    return "", ""


def openai_rejection_reason(resp: httpx.Response) -> str:
    """Classify only known-safe rejection shapes without returning provider prose."""
    error_type, error_code = openai_error_code(resp)
    machine_values = {error_type.lower(), error_code.lower()}
    if machine_values & {
        "multiple_images_not_supported",
        "multiple_images_unsupported",
        "too_many_images",
    }:
        return "multiple_images_unsupported"
    try:
        payload = resp.json()
    except Exception:
        return "request_rejected"
    message = ""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "")
        elif isinstance(error, str):
            message = error
    normalized = " ".join(message.lower()[:2000].split())
    multi_image_markers = (
        "multiple images are not supported",
        "multiple images not supported",
        "does not support multiple images",
        "doesn't support multiple images",
        "only one image is supported",
        "supports only one image",
        "at most one image",
        "more than one image",
        "too many images",
        "multi-image input is not supported",
    )
    return (
        "multiple_images_unsupported"
        if any(marker in normalized for marker in multi_image_markers)
        else "request_rejected"
    )


# Match the queue's 14-day retention ceiling and keep hostile values inside what
# timedelta and the Retry-After header can safely represent.
MAX_RETRY_AFTER_SECONDS = 14 * 24 * 60 * 60


def openai_retry_after_seconds(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if raw:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            try:
                target = parsedate_to_datetime(raw)
                if target.tzinfo is None:
                    target = target.replace(tzinfo=datetime.timezone.utc)
                date_header = resp.headers.get("date")
                baseline = parsedate_to_datetime(date_header) if date_header else None
                if baseline is None:
                    baseline = datetime.datetime.now(datetime.timezone.utc)
                elif baseline.tzinfo is None:
                    baseline = baseline.replace(tzinfo=datetime.timezone.utc)
                value = (target - baseline).total_seconds()
            except (TypeError, ValueError, OverflowError):
                value = 0
        if math.isfinite(value) and value > 0:
            return min(value, MAX_RETRY_AFTER_SECONDS)

    resets = []
    for name in ("x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"):
        value = _parse_reset_duration(resp.headers.get(name, ""))
        if value:
            resets.append(value)
    return min(max(resets), MAX_RETRY_AFTER_SECONDS) if resets else None


def _parse_reset_duration(raw: str) -> float | None:
    raw = str(raw or "").strip().lower()
    if not raw:
        return None
    factors = {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}
    parts = list(re.finditer(r"(\d+(?:\.\d+)?)(ms|s|m|h|d)", raw))
    if not parts or "".join(part.group(0) for part in parts) != raw:
        return None
    total = sum(float(part.group(1)) * factors[part.group(2)] for part in parts)
    return total if math.isfinite(total) and total > 0 else None


def _openai_content(parts: list[dict]) -> list[dict]:
    """Turn neutral parts into OpenAI content blocks.

    Neutral part shapes, shared with the Gemini serialiser:
        {"text": "..."}
        {"image": {"mime_type": "image/jpeg", "data": "<base64>"}}
    """
    content = []
    for part in parts:
        if "text" in part:
            content.append({"type": "text", "text": part["text"]})
        elif "image" in part:
            image = part["image"]
            mime = image.get("mime_type") or "image/jpeg"
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{image['data']}"},
            })
    return content


def _gemini_parts(parts: list[dict]) -> list[dict]:
    """Turn neutral parts into Gemini parts, the shape it already expects."""
    converted = []
    for part in parts:
        if "text" in part:
            converted.append({"text": part["text"]})
        elif "image" in part:
            image = part["image"]
            converted.append({"inline_data": {
                "mime_type": image.get("mime_type") or "image/jpeg",
                "data": image["data"],
            }})
    return converted


def image_part(mime_type: str | None, data_b64: str) -> dict:
    return {"image": {"mime_type": mime_type or "image/jpeg", "data": data_b64}}


def text_part(text: str) -> dict:
    return {"text": text}


def image_part_from_bytes(mime_type: str | None, raw: bytes) -> dict:
    return image_part(mime_type, base64.b64encode(raw).decode())


async def post_openai_chat(
    client: httpx.AsyncClient,
    url: str,
    api_key: str,
    payload: dict,
    *,
    max_attempts: int = 3,
) -> httpx.Response:
    """Call a compatible endpoint and normalize its errors for the shared queue."""
    import asyncio
    from services.provider_rate_limit import (
        ProviderScopeBlockedError,
        penalize_provider_scope,
        provider_scope_fingerprint,
        raise_if_provider_blocked,
        record_provider_scope_success,
    )

    last_error = None
    scope = provider_scope_fingerprint(OPENAI, url, api_key)
    for attempt in range(max_attempts):
        try:
            try:
                raise_if_provider_blocked(scope)
            except ProviderScopeBlockedError as exc:
                raise ProviderRateLimitError(
                    retry_after_seconds=exc.retry_after_seconds,
                    detail="The scanner provider is rate limited. Please try again shortly.",
                    reason=exc.reason,
                ) from None
            headers = {"Content-Type": "application/json"}
            # Sent only when there is one. A local server rejects, or ignores, an
            # Authorization header carrying an empty bearer token.
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            request_started_at = datetime.datetime.utcnow()
            resp = await client.post(url, headers=headers, json=payload)

            if resp.status_code == 429:
                error_type, error_code = openai_error_code(resp)
                classification = {error_type.lower(), error_code.lower()}
                if classification & {
                    "insufficient_quota",
                    "billing_hard_limit_reached",
                    "billing_not_active",
                    "account_deactivated",
                }:
                    raise ProviderRequestRejectedError(
                        detail=(
                            "The scanner provider has no usable billing quota. "
                            "Check the provider account or choose another provider."
                        ),
                        reason="billing",
                    )
                delay = penalize_provider_scope(
                    scope,
                    OPENAI,
                    seconds=openai_retry_after_seconds(resp),
                    reason="rate_limit",
                )
                raise ProviderRateLimitError(
                    retry_after_seconds=delay,
                    detail="The scanner provider is rate limited. Please try again shortly.",
                )
            if resp.status_code in {401, 403}:
                if openai_requires_key():
                    detail = "The OpenAI API key was rejected. Please check it in Settings."
                else:
                    detail = "The scanner endpoint rejected the request."
                raise ProviderRequestRejectedError(detail=detail, reason="authentication")
            if resp.status_code in {400, 409, 422}:
                raise ProviderRequestRejectedError(
                    detail=(
                        "The scanner provider rejected this request. The image or "
                        "model options may not be supported."
                    ),
                    reason=openai_rejection_reason(resp),
                )
            if resp.status_code == 413:
                raise ProviderRequestRejectedError(
                    detail="The scanner provider rejected the request because it was too large.",
                    reason="request_too_large",
                )
            if resp.status_code == 404:
                raise ProviderRequestRejectedError(
                    detail=(
                        f"The scanner model \"{payload.get('model', '')}\" was not "
                        "found. Choose an available model in Scanner Settings, or "
                        "ask an administrator to check the endpoint."
                    ),
                    reason="model_not_found",
                )
            if resp.status_code in OPENAI_TRANSIENT_STATUS_CODES:
                if attempt < max_attempts - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                raise HTTPException(
                    status_code=503,
                    detail="The scanner provider is temporarily unavailable. Please try again shortly.",
                )
            if resp.is_error:
                if 400 <= resp.status_code < 500:
                    raise ProviderRequestRejectedError(
                        detail=f"The scanner provider rejected the request ({resp.status_code}).",
                    )
                raise HTTPException(
                    status_code=503,
                    detail="The scanner provider is temporarily unavailable. Please try again shortly.",
                )
            try:
                record_provider_scope_success(
                    scope, request_started_at=request_started_at
                )
            except Exception:
                # Rate-limit bookkeeping must never turn a valid provider response
                # into a failed scan. No endpoint, credential, or upstream text is
                # included in this diagnostic.
                logger.warning("Could not reset scanner provider rate-limit state")
            return resp
        except HTTPException:
            raise
        except httpx.RequestError as exc:
            last_error = exc
            if attempt < max_attempts - 1:
                await asyncio.sleep(2 ** attempt)
                continue
            raise HTTPException(
                status_code=503,
                detail="The scanner endpoint could not be reached. Check the connection and try again.",
            )

    raise HTTPException(status_code=500, detail=f"The scanner request failed: {last_error}")


def extract_openai_text(payload: dict) -> str:
    """Pull the assistant message out of a chat-completions response."""
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("No message content in the scanner response") from exc

    if content is None:
        return ""
    # Not stripped here, to match the Gemini adapter: call sites decide.
    if isinstance(content, str):
        return content
    # Newer OpenAI-compatible servers may answer with a list of content parts
    # rather than a bare string. Returning that unchecked would fail later on
    # .strip() and surface as a 500.
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict)
        )
    raise ValueError(f"Unexpected message content type: {type(content).__name__}")


class ScanProvider:
    """One provider's calling convention, so call sites stay provider-agnostic."""

    def __init__(self, name: str, chosen_model: str = ""):
        self.name = name
        # Resolved once, because the request payload needs it and generate_text
        # has no database session of its own.
        self._chosen_model = (chosen_model or "").strip()

    @property
    def is_gemini(self) -> bool:
        return self.name == GEMINI

    def model(self) -> str:
        return self._chosen_model or installation_model(self.name)

    def installation_model(self) -> str:
        """The model used when this user has not named one."""
        return installation_model(self.name)

    def credential(self, db: Session, user_id: int | None) -> str:
        from api.recognize import get_gemini_key

        if self.is_gemini:
            return get_gemini_key(db, user_id=user_id)
        return scanner_setting_value(db, user_id, "openai_api_key").strip()

    def requires_credential(self) -> bool:
        return True if self.is_gemini else openai_requires_key()

    def missing_credential_message(self) -> str:
        if self.is_gemini:
            return "Kein Gemini API Key konfiguriert. Bitte in den Einstellungen eintragen."
        return "No OpenAI API key configured. Add one in Settings first."

    def rate_limit_scope(self, priority: str):
        """Gemini's queue priority scope, and nothing for other providers."""
        if self.is_gemini:
            from services.gemini_rate_limit import gemini_priority_scope

            return gemini_priority_scope(priority)
        return nullcontext()

    async def generate_text(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        parts: list[dict],
        *,
        max_attempts: int = 3,
    ) -> tuple[str, dict | None]:
        """Run one multimodal request and return (text, usage).

        Usage is whatever the provider reports, or None. Callers record it for
        diagnostics and must not depend on its shape.
        """
        if self.is_gemini:
            from api.recognize import build_gemini_generate_url, post_gemini_generate

            response = await post_gemini_generate(
                client,
                # The chosen model has to reach the URL, or the request runs on
                # the installation model while diagnostics record the user's.
                build_gemini_generate_url(self.model()),
                api_key,
                {"contents": [{"parts": _gemini_parts(parts)}]},
                max_attempts=max_attempts,
            )
            payload = response.json()
            # Returned exactly as received. Upstream stripped at the extraction
            # and composite call sites but recorded visual verification
            # unstripped, so stripping here would change what Gemini writes into
            # diagnostics. Call sites strip where they always did.
            text = payload["candidates"][0]["content"]["parts"][0]["text"]
            return text, payload.get("usageMetadata")

        response = await post_openai_chat(
            client,
            openai_chat_completions_url(),
            api_key,
            {
                "model": self.model(),
                "messages": [{"role": "user", "content": _openai_content(parts)}],
            },
            max_attempts=max_attempts,
        )
        try:
            payload = response.json()
            return extract_openai_text(payload), payload.get("usage")
        except (ValueError, TypeError) as exc:
            # A structurally incompatible success will not heal through queue
            # retries. Classify it as a permanent configuration problem rather
            # than a transient 502 that can loop until the job expires.
            raise HTTPException(
                status_code=400,
                detail=(
                    "The scanner endpoint returned an incompatible response. "
                    "Check that it supports OpenAI Chat Completions."
                ),
            ) from exc


def get_provider(db: Session, user_id: int | None) -> ScanProvider:
    name = resolve_provider_name(db, user_id, require_enabled=True)
    model = resolve_model(db, user_id, name)
    if not model:
        raise config_error(
            db,
            user_id,
            400,
            "No valid scanner model is configured. Ask an administrator to check Scanner Settings.",
        )
    return ScanProvider(name, model)
