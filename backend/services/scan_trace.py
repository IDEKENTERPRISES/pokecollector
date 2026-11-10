"""Consent-controlled structured scanner diagnostics for offline analysis.

Tracing is available only when ``SCAN_TRACE_DIR`` is configured and is enabled
separately by each user. One JSON file is written per scan attempt with the
sanitized source image alongside it. Files remain until that user explicitly
deletes them (or their account is deleted), or until the optional retention
period (``SCAN_TRACE_KEEP_DAYS``) passes. With ``SCAN_TRACE_REQUIRED`` on, tracing
is on for every trainer who is not an admin and only an admin can delete theirs.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import uuid
from pathlib import Path
from typing import Any

from models import User, UserSetting

logger = logging.getLogger(__name__)

SCAN_DIAGNOSTICS_SETTING_KEY = "scan_diagnostics_enabled"
SCAN_TRACE_REQUIRED_ENV = "SCAN_TRACE_REQUIRED"
SCAN_TRACE_KEEP_DAYS_ENV = "SCAN_TRACE_KEEP_DAYS"
SCAN_TRACE_STORAGE_ENV = "SCAN_TRACE_STORAGE_DIR"
SCAN_TRACE_DEFAULT_ON_ENV = "SCAN_TRACE_DEFAULT_ON"

_SENSITIVE_ERROR_PATTERNS = (
    (re.compile(r"AIza[0-9A-Za-z_-]{20,}"), "[REDACTED_API_KEY]"),
    # OpenAI-style keys. Upstream error text is passed through to the user and
    # recorded here, and some endpoints echo the offending key back in it, so the
    # bare form has to be caught and not only the Authorization header below.
    (re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}"), "[REDACTED_API_KEY]"),
    (
        re.compile(r"(?i)((?:authorization|x-goog-api-key)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+"),
        r"\1[REDACTED]",
    ),
    (
        re.compile(r"(?i)([?&](?:key|api_key|token)=)[^&\s]+"),
        r"\1[REDACTED]",
    ),
    (
        re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
        "[REDACTED_TOKEN]",
    ),
    (re.compile(r"\b\d{6,}:[A-Za-z0-9_-]{20,}\b"), "[REDACTED_TOKEN]"),
)

CANDIDATE_FIELDS = (
    "tcg_card_id",
    "name",
    "number",
    "set",
    "set_abbreviation",
    "printed_total",
    "artist",
    "hp",
    "regulation_mark",
    "image",
    "lang",
)


SHADOW_DIR = "shadow"
SHADOW_SUFFIX = ".shadow"
# Guards every read-modify-write of a trace file and of a shadow record, so a shadow result that lands
# while the real path is saving its trace is merged into it exactly once, whichever finishes first.
_TRACE_LOCK = threading.Lock()


def trace_root() -> Path | None:
    raw = (os.environ.get("SCAN_TRACE_DIR") or "").strip()
    return Path(raw) if raw else None


def trace_storage_root() -> Path | None:
    """Stable cleanup root, retained even while new collection is disabled."""
    raw = (os.environ.get(SCAN_TRACE_STORAGE_ENV) or "").strip()
    return Path(raw) if raw else trace_root()


def _ensure_private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path


def _root_is_writable(root: Path | None) -> bool:
    if root is None:
        return False
    try:
        _ensure_private_dir(root)
        return os.access(root, os.W_OK | os.X_OK)
    except OSError:
        return False


def trace_available() -> bool:
    return _root_is_writable(trace_root())


def trace_deletion_available() -> bool:
    return _root_is_writable(trace_storage_root())


def diagnostics_default_on() -> bool:
    """A test server can collect diagnostics from everyone unless they switch it off (SCAN_TRACE_DEFAULT_ON)."""
    return _env_flag(SCAN_TRACE_DEFAULT_ON_ENV)


def _env_flag(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in {"1", "true", "yes", "on"}


def trace_required() -> bool:
    """A server (prod) can collect diagnostics from every trainer who is not an admin (SCAN_TRACE_REQUIRED).

    Only in effect while tracing itself is available (``SCAN_TRACE_DIR`` set and writable)."""
    return _env_flag(SCAN_TRACE_REQUIRED_ENV) and trace_available()


def trace_keep_days() -> int | None:
    """How many days diagnostics are kept (SCAN_TRACE_KEEP_DAYS); None means forever (empty, 0 or not a number)."""
    raw = (os.environ.get(SCAN_TRACE_KEEP_DAYS_ENV) or "").strip()
    try:
        days = int(raw)
    except ValueError:
        return None
    return days if days > 0 else None


def _is_admin_user(db, user_id: int) -> bool:
    row = db.query(User.role).filter(User.id == int(user_id)).first()
    return row is not None and row.role == "admin"


def diagnostics_locked(db, user_id: int) -> bool:
    """True when this trainer cannot switch diagnostics off or delete them: required mode, and not an admin."""
    return trace_required() and not _is_admin_user(db, user_id)


def user_trace_enabled(db, user_id: int) -> bool:
    if not trace_available():
        return False
    if diagnostics_locked(db, user_id):
        # A stored "off" or an old revocation marker must not silently stop collection. The marker is only ever
        # written when an account is deleted, so for an account that exists it is a leftover (a reused id) and
        # is cleared here, the first time that trainer scans on a required server.
        if _is_revoked(int(user_id)):
            clear_user_trace_revocation(int(user_id))
        return True
    row = (
        db.query(UserSetting.value)
        .filter(
            UserSetting.user_id == int(user_id),
            UserSetting.key == SCAN_DIAGNOSTICS_SETTING_KEY,
        )
        .first()
    )
    if row is None:
        return diagnostics_default_on()
    return str(row.value).lower() == "true"


def _safe(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(value))


def _user_dir(user_id: int, root: Path | None = None) -> Path | None:
    root = root or trace_root()
    if root is None:
        return None
    return root / f"user-{int(user_id)}"


def _cleanup_roots(extra_root: Path | None = None) -> list[Path]:
    roots: list[Path] = []
    for root in (extra_root, trace_root(), trace_storage_root()):
        if root is not None and root not in roots:
            roots.append(root)
    return roots


def _revocation_path(root: Path, user_id: int) -> Path:
    return root / f".revoked-user-{int(user_id)}"


def _is_revoked(user_id: int, extra_root: Path | None = None) -> bool:
    return any(
        _revocation_path(root, user_id).exists()
        for root in _cleanup_roots(extra_root)
    )


def _write_private(path: Path, content: bytes | str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        if isinstance(content, bytes):
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
        else:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(content)
    except Exception:
        try:
            path.unlink(missing_ok=True)
        finally:
            raise


def redact_sensitive(message: str) -> str:
    """Public wrapper: strip known credential shapes from text before it is
    stored, returned to a caller, or logged."""
    return _redact_error(message)


def _redact_error(message: str) -> str:
    redacted = str(message)
    for pattern, replacement in _SENSITIVE_ERROR_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def _redact_value(value: Any, secrets: tuple[str, ...]) -> Any:
    """Recursively sanitize provider-controlled diagnostic data.

    Pattern redaction catches known credential formats. Exact-value replacement
    also protects arbitrary keys used by compatible endpoints, including keys
    echoed inside otherwise successful response content or usage metadata.
    """
    if isinstance(value, str):
        redacted = _redact_error(value)
        for secret in secrets:
            redacted = redacted.replace(secret, "[REDACTED_API_KEY]")
        return redacted
    if isinstance(value, dict):
        return {
            _redact_value(key, secrets) if isinstance(key, str) else key:
            _redact_value(item, secrets)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_redact_value(item, secrets) for item in value]
    return value


class ScanTrace:
    """Collect one scanner attempt without ever recording credentials."""

    def __init__(
        self,
        *,
        enabled: bool,
        user_id: int,
        mode: str,
        job_id: int | None = None,
        item_id: int | None = None,
        filename: str | None = None,
        provider: str | None = None,
        model: str | None = None,
    ):
        self.enabled = bool(enabled)
        self.user_id = int(user_id)
        self._root = trace_root() if self.enabled else None
        self.trace_id = uuid.uuid4().hex[:12]
        self.data: dict[str, Any] = {
            "schema_version": 1,
            "trace_id": self.trace_id,
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "mode": mode,
            "job_id": job_id,
            "item_id": item_id,
            "filename": filename,
            "provider": provider,
            "model": model,
            "extraction": {},
            "search": {"tcgdex": [], "prefilter": None},
            "candidates": [],
            "decision": {"mechanism": None, "selected": None},
            "ground_truth": None,
            "correct": None,
        }
        self._image: bytes | None = None
        self._secrets: list[str] = []

    def add_secret(self, value: str | None) -> None:
        """Register a request credential for exact-value diagnostic redaction."""
        secret = str(value or "").strip()
        if len(secret) >= 4 and secret not in self._secrets:
            self._secrets.append(secret)

    def _sanitize(self, value: Any) -> Any:
        return _redact_value(value, tuple(self._secrets))

    def set_image(self, image_bytes: bytes | None) -> None:
        if not self.enabled or not image_bytes:
            return
        self._image = image_bytes
        self.data["image_sha256"] = hashlib.sha256(image_bytes).hexdigest()
        self.data["image_bytes"] = len(image_bytes)

    def record_extraction(
        self,
        *,
        prompt=None,
        raw_response=None,
        parsed=None,
        usage=None,
    ) -> None:
        if not self.enabled:
            return
        section = self.data["extraction"]
        if prompt is not None:
            section["prompt"] = self._sanitize(prompt)
        if raw_response is not None:
            section["raw_response"] = self._sanitize(raw_response)
        if parsed is not None:
            section["parsed"] = self._sanitize(parsed)
        if usage is not None:
            section["usage"] = self._sanitize(usage)

    def record_cached_extraction(self, parsed) -> None:
        """Record reuse of a paid extraction from an earlier queue attempt."""
        if not self.enabled:
            return
        self.record_extraction(parsed=parsed)
        self.data["extraction"]["source"] = "queue_cache"

    def record_visual_verification(self, *, raw_response: str, selected: int | None) -> None:
        if self.enabled:
            self.data["visual_verification"] = {
                "raw_response": self._sanitize(raw_response),
                "selected_position": selected,
            }

    def record_tcgdex(
        self,
        *,
        language: str,
        query: str,
        status: int | None,
        count: int | None,
        error: str | None = None,
        source: str = "local",
    ) -> None:
        if not self.enabled:
            return
        entry = {
            "language": language,
            "query": query,
            "status": status,
            "results": count,
            # "local" (the synced cards table) or "api_fallback" (live
            # TCGdex, reached when the pair has no name-compatible local rows
            # or none matches a recognized collector number) — lets offline
            # trace analysis measure incomplete-sync fallbacks.
            "source": source,
        }
        if error:
            entry["error"] = error
        self.data["search"]["tcgdex"].append(entry)

    def record_prefilter(self, target, matched: int, total: int) -> None:
        if self.enabled:
            self.data["search"]["prefilter"] = {
                "target": target,
                "matched": matched,
                "of": total,
            }

    def record_candidates(self, candidates: list[dict], rank_key=None) -> None:
        if not self.enabled:
            return
        snapshot = []
        for position, card in enumerate(candidates):
            entry = {field: card.get(field) for field in CANDIDATE_FIELDS}
            entry["position"] = position
            if rank_key is not None:
                try:
                    entry["rank_key"] = list(rank_key(card))
                except Exception:
                    pass
            snapshot.append(entry)
        self.data["candidates"] = snapshot

    def record_phash(
        self,
        scores: list[tuple[int, str]],
        *,
        accepted: str | None,
        reason: str,
    ) -> None:
        if self.enabled:
            self.data["phash"] = {
                "distances": [
                    {"distance": distance, "tcg_card_id": card_id}
                    for distance, card_id in scores
                ],
                "accepted": accepted,
                "reason": reason,
            }

    def reject_phash(self, reason: str) -> None:
        if self.enabled and isinstance(self.data.get("phash"), dict):
            self.data["phash"]["accepted"] = None
            self.data["phash"]["reason"] = reason

    def record_decision(self, mechanism: str, selected: str | None = None) -> None:
        if self.enabled:
            self.data["decision"] = {
                "mechanism": mechanism,
                "selected": selected,
            }

    def record_picture_match(self, info: dict) -> None:
        """Which path the picture matcher took for this scan (docs/CARD_MATCH.md, "Picture match first")."""
        if self.enabled:
            self.data["picture_match"] = dict(info)

    def record_error(self, message: str) -> None:
        if self.enabled:
            self.data["error"] = self._sanitize(message)

    def save(self) -> Path | None:
        with _TRACE_LOCK:
            if self.enabled and self.data.get("job_id") and self.data.get("item_id"):
                shadow = _read_shadow_file(self.user_id, self.data["job_id"], self.data["item_id"], self._root)
                if shadow:
                    self.data["shadow"] = shadow
                    apply_shadow_agreement(self.data)
            return self._save_unlocked()

    def _save_unlocked(self) -> Path | None:
        user_dir = _user_dir(self.user_id, self._root)
        if (
            not self.enabled
            or self._root is None
            or user_dir is None
            or _is_revoked(self.user_id, self._root)
        ):
            return None
        image_temp: Path | None = None
        json_temp: Path | None = None
        try:
            _ensure_private_dir(self._root)
            _ensure_private_dir(user_dir)
            day = user_dir / datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
            _ensure_private_dir(day)
            stem = "-".join(
                filter(
                    None,
                    [
                        f"job{_safe(self.data['job_id'])}" if self.data.get("job_id") else None,
                        f"item{_safe(self.data['item_id'])}" if self.data.get("item_id") else None,
                        self.trace_id,
                    ],
                )
            )
            if self._image:
                image_path = day / f"{stem}.jpg"
                image_temp = day / f".{stem}.{uuid.uuid4().hex}.jpg.tmp"
                _write_private(image_temp, self._image)
                self.data["image_file"] = image_path.name
            path = day / f"{stem}.json"
            json_temp = day / f".{stem}.{uuid.uuid4().hex}.json.tmp"
            _write_private(
                json_temp,
                json.dumps(
                    self._sanitize(self.data),
                    indent=2,
                    ensure_ascii=False,
                    default=str,
                ),
            )
            if _is_revoked(self.user_id, self._root):
                if image_temp:
                    image_temp.unlink(missing_ok=True)
                json_temp.unlink(missing_ok=True)
                return None
            if image_temp:
                image_temp.replace(image_path)
            json_temp.replace(path)
            return path
        except Exception:
            if image_temp:
                image_temp.unlink(missing_ok=True)
            if json_temp:
                json_temp.unlink(missing_ok=True)
            logger.exception("Failed to write scan diagnostics")
            return None


def create_scan_trace(
    db,
    user_id: int,
    *,
    mode: str,
    job_id: int | None = None,
    item_id: int | None = None,
    filename: str | None = None,
    provider: str | None = None,
    model: str | None = None,
) -> ScanTrace:
    return ScanTrace(
        enabled=user_trace_enabled(db, user_id),
        user_id=user_id,
        mode=mode,
        job_id=job_id,
        item_id=item_id,
        filename=filename,
        provider=provider,
        model=model,
    )


# ── Matcher shadow mode (docs/CARD_MATCH.md) ─────────────────────────────────

def apply_shadow_agreement(data: dict) -> None:
    """Fill in how the matcher's shadow result compares with what the current path decided.

    ``agreement`` is one of ``same``, ``different`` (both decided), ``matcher_only``, ``current_only``,
    ``neither``; ``agrees`` is True/False only when both decided. Runs when the trace is saved and again
    if the shadow result arrives afterwards.
    """
    shadow = data.get("shadow")
    if not isinstance(shadow, dict) or shadow.get("status") != "ok":
        return
    matcher = (shadow.get("decision") or {}).get("tcg_card_id")
    current = ollama_selected(data)
    if matcher and current:
        agreement = "same" if matcher == current else "different"
    elif matcher:
        agreement = "matcher_only"
    elif current:
        agreement = "current_only"
    else:
        agreement = "neither"
    ranks = [match.get("tcg_card_id") for match in shadow.get("matches") or []]
    shadow["agreement"] = agreement
    shadow["agrees"] = (matcher == current) if matcher and current else None
    shadow["current_selected"] = current
    shadow["current_rank_in_matcher"] = ranks.index(current) + 1 if current in ranks else None
    if data.get("ground_truth"):
        label_shadow(data)


def ollama_ran(data: dict) -> bool:
    """Whether Ollama (today's scanner path) really looked at this scan. With "Picture match first" a scan the picture
    matcher decided, or sent straight to the inbox, never reached Ollama; only ``unsure_ollama`` did."""
    picture = data.get("picture_match")
    return not isinstance(picture, dict) or not picture.get("path") or picture.get("path") == "unsure_ollama"


def ollama_selected(data: dict) -> str | None:
    """What Ollama picked, or None when it did not decide or never ran. ``decision.selected`` also holds a picture-first
    decision (mechanism ``picture_match``), which is the matcher's pick, not Ollama's."""
    decision = data.get("decision") or {}
    if decision.get("mechanism") == "picture_match" or not ollama_ran(data):
        return None
    return decision.get("selected")


def label_shadow(data: dict) -> None:
    """Score the shadow result against the trainer's confirmed card (``data['ground_truth']``)."""
    shadow = data.get("shadow")
    truth = data.get("ground_truth")
    if not isinstance(shadow, dict) or shadow.get("status") != "ok" or not truth:
        return
    matcher = (shadow.get("decision") or {}).get("tcg_card_id")
    ranks = [match.get("tcg_card_id") for match in shadow.get("matches") or []]
    shadow["ground_truth_rank"] = ranks.index(truth) + 1 if truth in ranks else None
    # Like the current path's ``correct``: an abstention is not counted as a wrong decision.
    shadow["correct"] = (matcher == truth) if matcher else None
    # The index holds English printings only; the language of the confirmed card tells the lab whether
    # this scan is a fair test of the matcher.
    shadow["truth_lang"] = next(
        (candidate.get("lang") for candidate in data.get("candidates") or [] if candidate.get("tcg_card_id") == truth),
        None,
    ) or (data.get("confirmation") or {}).get("lang")


def _shadow_file(user_id: int, job_id, item_id, root: Path | None = None) -> Path | None:
    user_dir = _user_dir(user_id, root)
    if user_dir is None:
        return None
    return user_dir / SHADOW_DIR / f"job{_safe(job_id)}-item{_safe(item_id)}{SHADOW_SUFFIX}"


def _read_shadow_file(user_id: int, job_id, item_id, root: Path | None = None) -> dict | None:
    path = _shadow_file(user_id, job_id, item_id, root)
    if path is None:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


CARD_SUFFIX = ".card.jpg"


def _shadow_card_file(user_id: int, job_id, item_id, root: Path | None = None) -> Path | None:
    user_dir = _user_dir(user_id, root)
    if user_dir is None:
        return None
    return user_dir / SHADOW_DIR / f"job{_safe(job_id)}-item{_safe(item_id)}{CARD_SUFFIX}"


def record_shadow_card(user_id: int, job_id: int, item_id: int, jpeg: bytes) -> bool:
    """Keep the flat card the picture matcher read its text from (up to about 1000 px wide) beside the shadow
    record, so the labelled benchmark and the Misses view can show and re-read exactly what the live run saw.
    The caller has checked the trainer's consent. Returns whether it was stored."""
    root = trace_root()
    if root is None or not jpeg or _is_revoked(user_id, root):
        return False
    path = _shadow_card_file(user_id, job_id, item_id, root)
    if path is None:
        return False
    with _TRACE_LOCK:
        temp: Path | None = None
        try:
            _ensure_private_dir(root)
            _ensure_private_dir(path.parent.parent)
            _ensure_private_dir(path.parent)
            temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
            _write_private(temp, jpeg)
            if _is_revoked(user_id, root):
                temp.unlink(missing_ok=True)
                return False
            temp.replace(path)
            return True
        except Exception:
            if temp:
                temp.unlink(missing_ok=True)
            logger.exception("Failed to write the matcher's flat card")
            return False


def stored_card_path(trace_path: Path, data: dict) -> Path | None:
    """The flat card stored for a trace (``user-N/<day>/<trace>.json``), or None for older traces."""
    job_id, item_id = data.get("job_id"), data.get("item_id")
    if not job_id or not item_id:
        return None
    path = trace_path.parent.parent / SHADOW_DIR / f"job{_safe(job_id)}-item{_safe(item_id)}{CARD_SUFFIX}"
    return path if path.is_file() else None


def has_shadow(user_id: int, job_id: int, item_id: int) -> bool:
    for root in _cleanup_roots():
        path = _shadow_file(user_id, job_id, item_id, root)
        if path is not None and path.is_file():
            return True
    return False


def record_shadow(user_id: int, job_id: int, item_id: int, shadow: dict) -> bool:
    """Store the matcher's shadow result for one scan photo (the caller has checked the trainer's consent).

    Written beside the traces as ``user-N/shadow/jobJ-itemI.shadow`` and merged into the scan's trace when
    that is saved; traces already saved for the item are updated now. Returns whether anything was stored.
    """
    root = trace_root()
    if root is None or _is_revoked(user_id, root):
        return False
    path = _shadow_file(user_id, job_id, item_id, root)
    if path is None:
        return False
    with _TRACE_LOCK:
        temp: Path | None = None
        try:
            _ensure_private_dir(root)
            _ensure_private_dir(path.parent.parent)
            _ensure_private_dir(path.parent)
            temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
            _write_private(temp, json.dumps(_redact_value(shadow, ()), indent=2, ensure_ascii=False, default=str))
            if _is_revoked(user_id, root):
                temp.unlink(missing_ok=True)
                return False
            temp.replace(path)
        except Exception:
            if temp:
                temp.unlink(missing_ok=True)
            logger.exception("Failed to write shadow diagnostics")
            return False
        stored = _read_shadow_file(user_id, job_id, item_id, root) or shadow
        user_dir = _user_dir(user_id, root)
        for trace_path in sorted(user_dir.glob(f"*/job{_safe(job_id)}-item{_safe(item_id)}-*.json")):
            patch_temp: Path | None = None
            try:
                data = json.loads(trace_path.read_text(encoding="utf-8"))
                data["shadow"] = json.loads(json.dumps(stored))
                apply_shadow_agreement(data)
                patch_temp = trace_path.with_name(f".{trace_path.name}.{uuid.uuid4().hex}.tmp")
                _write_private(patch_temp, json.dumps(data, indent=2, ensure_ascii=False, default=str))
                patch_temp.replace(trace_path)
            except Exception:
                if patch_temp:
                    patch_temp.unlink(missing_ok=True)
                logger.exception("Failed to add shadow diagnostics to %s", trace_path)
    return True


# How the trainer's confirmed card was chosen (shown as counts in the Scanner lab).
CONFIRMATION_SOURCES = (
    "scanner_decision",  # the scanner's own pick, accepted
    "matcher_candidate",  # picked from the picture matcher's candidates
    "ollama_candidate",  # picked from Ollama's candidates
    "manual_search",  # found by search because no scanner offered it
    "manual_no_result",  # found by search on a scan that had no result at all
)


def classify_confirmation(data: dict, card_id: str, *, manual: bool = False, had_matches: bool = True) -> str:
    """Which of ``CONFIRMATION_SOURCES`` the confirmed ``card_id`` is, for one trace."""
    if manual:
        return "manual_search" if had_matches else "manual_no_result"
    decision = data.get("decision") or {}
    if decision.get("selected") and decision.get("selected") == card_id:
        return "scanner_decision"
    candidates = [candidate.get("tcg_card_id") for candidate in data.get("candidates") or []]
    matcher_ids = [match.get("tcg_card_id") for match in (data.get("shadow") or {}).get("matches") or []]
    mechanism = str(decision.get("mechanism") or "").lower()
    if card_id in candidates:
        return "matcher_candidate" if ("matcher" in mechanism or "picture" in mechanism) else "ollama_candidate"
    if card_id in matcher_ids:
        return "matcher_candidate"
    return "ollama_candidate"


def record_manual_trace(
    db,
    user_id: int,
    job_id: int,
    item_id: int,
    card_id: str,
    *,
    image_bytes: bytes | None,
    lang: str | None = None,
) -> bool:
    """A scan no scanner produced anything for still teaches the lab: store its photo with the card the
    trainer found by search (only with the trainer's diagnostics consent)."""
    trace = create_scan_trace(db, user_id, mode="manual", job_id=job_id, item_id=item_id)
    if not trace.enabled:
        return False
    trace.set_image(image_bytes)
    trace.data["ground_truth"] = card_id
    trace.data["correct"] = None
    trace.data["confirmation"] = {"source": "manual_no_result", "lang": lang}
    trace.save()
    return True


def record_ground_truth(
    user_id: int,
    job_id: int,
    item_id: int,
    card_id: str,
    *,
    manual: bool = False,
    had_matches: bool = True,
    lang: str | None = None,
) -> int:
    """Label all attempts for one reviewed item with the user's confirmed card."""
    if not card_id:
        return 0
    updated = 0
    pattern = f"job{_safe(job_id)}-item{_safe(item_id)}-*.json"
    paths: set[Path] = set()
    for root in _cleanup_roots():
        user_dir = _user_dir(user_id, root)
        if user_dir is not None and user_dir.is_dir():
            paths.update(user_dir.glob(f"*/{pattern}"))
    for path in sorted(paths):
        temp: Path | None = None
        try:
            with _TRACE_LOCK:
                data = json.loads(path.read_text(encoding="utf-8"))
                data["ground_truth"] = card_id
                data["confirmation"] = {
                    "source": classify_confirmation(data, card_id, manual=manual, had_matches=had_matches),
                    "lang": lang,
                }
                selected = (data.get("decision") or {}).get("selected")
                # A trace that deliberately abstained did not make a top-1 choice.
                # Keep it labelled for retrieval analysis without counting it as an
                # incorrect automatic decision.
                data["correct"] = (selected == card_id) if selected else None
                candidates = [
                    candidate.get("tcg_card_id")
                    for candidate in data.get("candidates") or []
                ]
                data["ground_truth_rank"] = (
                    candidates.index(card_id) + 1 if card_id in candidates else None
                )
                label_shadow(data)
                temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
                _write_private(
                    temp,
                    json.dumps(data, indent=2, ensure_ascii=False, default=str),
                )
                temp.replace(path)
                updated += 1
        except Exception:
            if temp:
                temp.unlink(missing_ok=True)
            logger.exception("Failed to label scan diagnostics at %s", path)
    return updated


def _delete_user_dir(root: Path, user_id: int) -> dict[str, int]:
    user_dir = _user_dir(user_id, root)
    if user_dir is None or not user_dir.exists():
        return {"traces": 0, "images": 0}
    traces = sum(1 for path in user_dir.rglob("*.json") if path.is_file())
    images = sum(1 for path in user_dir.rglob("*.jpg") if path.is_file())
    if user_dir.is_symlink():
        user_dir.unlink()
    else:
        shutil.rmtree(user_dir)
    return {"traces": traces, "images": images}


def delete_user_traces(user_id: int) -> dict[str, int]:
    """Delete this user's data from all active and stable cleanup roots."""
    deleted = {"traces": 0, "images": 0}
    try:
        for root in _cleanup_roots():
            result = _delete_user_dir(root, user_id)
            deleted["traces"] += result["traces"]
            deleted["images"] += result["images"]
    except Exception:
        logger.exception("Failed to delete scan diagnostics for user %s", user_id)
        raise
    return deleted


_DAY_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_USER_DIR = re.compile(r"^user-\d+$")


def purge_old_traces(keep_days: int | None = None, *, today: datetime.date | None = None) -> dict[str, int]:
    """Delete diagnostics older than ``keep_days`` (default SCAN_TRACE_KEEP_DAYS; none set = keep everything).

    Works only inside the trace roots, on ``user-N/<YYYY-MM-DD>/`` day folders older than the cutoff (traces and
    their photos) and on the matcher's records and flat cards in ``user-N/shadow/`` whose file is older than the
    cutoff, then removes day and shadow folders left empty. Safe to run twice. Returns counts only."""
    days = trace_keep_days() if keep_days is None else (keep_days if keep_days > 0 else None)
    removed = {"scans": 0, "shadow_files": 0}
    if days is None:
        return removed
    today = today or datetime.datetime.now(datetime.timezone.utc).date()
    cutoff_date = today - datetime.timedelta(days=days)
    cutoff_ts = datetime.datetime.combine(cutoff_date, datetime.time.min, tzinfo=datetime.timezone.utc).timestamp()
    seen: set[Path] = set()
    for root in _cleanup_roots():
        try:
            resolved_root = root.resolve()
            if resolved_root in seen or not root.is_dir() or root.is_symlink():
                continue
            seen.add(resolved_root)
            user_dirs = [p for p in root.iterdir() if _USER_DIR.match(p.name) and p.is_dir() and not p.is_symlink()]
        except OSError:
            logger.exception("Could not read the scan diagnostics folder for cleanup")
            continue
        for user_dir in user_dirs:
            try:
                children = list(user_dir.iterdir())
            except OSError:
                continue
            for child in children:
                if child.is_symlink() or not child.is_dir():
                    continue
                try:
                    if _DAY_DIR.match(child.name):
                        if datetime.date.fromisoformat(child.name) >= cutoff_date:
                            continue
                        removed["scans"] += sum(1 for f in child.glob("*.json") if f.is_file())
                        shutil.rmtree(child)
                    elif child.name == SHADOW_DIR:
                        with _TRACE_LOCK:
                            for f in list(child.iterdir()):
                                if f.is_file() and not f.is_symlink() and f.stat().st_mtime < cutoff_ts:
                                    f.unlink(missing_ok=True)
                                    if not f.name.startswith("."):
                                        removed["shadow_files"] += 1
                            if not any(child.iterdir()):
                                child.rmdir()
                except (OSError, ValueError):
                    logger.exception("Could not clean up old scan diagnostics in %s", child.name)
    if removed["scans"] or removed["shadow_files"]:
        logger.info(
            "Scan diagnostics cleanup removed %s scan(s) and %s matcher file(s) older than %s days",
            removed["scans"], removed["shadow_files"], days,
        )
    return removed


def revoke_user_traces(user_id: int) -> dict[str, int]:
    """Permanently prevent a deleted account's in-flight traces from returning."""
    roots = _cleanup_roots()
    created_markers: list[Path] = []
    try:
        for root in roots:
            _ensure_private_dir(root)
            marker = _revocation_path(root, user_id)
            if not marker.exists():
                _write_private(marker, "account deleted\n")
                created_markers.append(marker)
        deleted = {"traces": 0, "images": 0}
        for root in roots:
            result = _delete_user_dir(root, user_id)
            deleted["traces"] += result["traces"]
            deleted["images"] += result["images"]
        return deleted
    except Exception:
        for marker in created_markers:
            marker.unlink(missing_ok=True)
        logger.exception("Failed to revoke scan diagnostics for user %s", user_id)
        raise


def clear_user_trace_revocation(user_id: int) -> None:
    """Undo a tombstone only when account deletion itself rolls back."""
    for root in _cleanup_roots():
        _revocation_path(root, user_id).unlink(missing_ok=True)
