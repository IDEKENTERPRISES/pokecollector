"""Extra READ-ONLY scan-diagnostics roots (``SCAN_TRACE_READONLY_DIRS``).

The test stack (nonprod) can read another stack's diagnostics folder (prod's) through a read-only mount, so the Scanner lab
can measure the matcher on scans of real trainers without copying a single photo. The variable is a list of ``label=path``
entries separated by commas, semicolons or new lines, for example ``prod=/app/data/scan-traces-prod``.

Rules this module enforces for the rest of the code:
  * a read-only root is only ever read: ``ensure_writable`` refuses any path inside one, and the low-level writers and
    deleters in ``scan_trace`` call it, so no code path can write, rename or delete there;
  * every problem with a root (missing, no permission, half-written file) means "skip it", never an error;
  * a trace from such a root belongs to its own source (``source_of``): its user, job and item ids mean nothing in the local
    database, so nothing may look them up there.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

READONLY_DIRS_ENV = "SCAN_TRACE_READONLY_DIRS"
LOCAL = "local"
HELD_BACK_FRACTION = 0.30  # of the read-only sources' scans: measured and reported, never used to choose or tune anything
_LABEL = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_SPLIT = re.compile(r"[,;\n]+")

# Set on a trace's data by ``ocr_check.labelled_traces``; only in memory, never written anywhere.
SOURCE_KEY = "_source"
HELD_BACK_KEY = "_held_back"


class ReadOnlyTraceRoot(PermissionError):
    """Raised when something tries to change a file inside a read-only root."""


@dataclass(frozen=True)
class ReadOnlyRoot:
    label: str
    path: Path


def parse_roots(raw: str | None) -> list[ReadOnlyRoot]:
    """``label=path`` entries; a bad entry (no label, odd label, ``local``, duplicate, empty path) is skipped."""
    roots: list[ReadOnlyRoot] = []
    seen: set[str] = set()
    for entry in _SPLIT.split(raw or ""):
        entry = entry.strip()
        if not entry:
            continue
        label, sep, path = entry.partition("=")
        label, path = label.strip().casefold(), path.strip()
        if not sep or not path or not _LABEL.match(label) or label == LOCAL or label in seen:
            logger.warning("Ignoring a bad %s entry", READONLY_DIRS_ENV)
            continue
        seen.add(label)
        roots.append(ReadOnlyRoot(label, Path(path)))
    return roots


def readonly_roots() -> list[ReadOnlyRoot]:
    return parse_roots(os.environ.get(READONLY_DIRS_ENV))


def _resolved(path: Path) -> Path:
    try:
        return path.resolve()
    except (OSError, RuntimeError):
        return Path(os.path.abspath(path))


def _inside(path: Path, root: Path) -> bool:
    for candidate, base in ((Path(os.path.abspath(path)), Path(os.path.abspath(root))), (_resolved(path), _resolved(root))):
        if candidate == base or base in candidate.parents:
            return True
    return False


def is_readonly_path(path: Path | str | None) -> bool:
    """Whether ``path`` is a read-only root or inside one."""
    if path is None:
        return False
    target = Path(path)
    return any(_inside(target, root.path) for root in readonly_roots())


def ensure_writable(path: Path | str) -> None:
    """Raise ``ReadOnlyTraceRoot`` when ``path`` is in a read-only root. Called before every write, rename or delete in a trace root."""
    if is_readonly_path(path):
        raise ReadOnlyTraceRoot(f"{path} is in a read-only diagnostics root")


def usable_roots(local_dir: Path | None) -> list[ReadOnlyRoot]:
    """The read-only roots to read: not the local root itself (or inside it) and not a folder that is not there."""
    out = []
    for root in readonly_roots():
        if local_dir is not None and (_inside(root.path, local_dir) or _inside(local_dir, root.path)):
            logger.warning("The read-only diagnostics root %s overlaps the local one: skipped", root.label)
            continue
        out.append(root)
    return out


def source_of(data: dict) -> str:
    return str(data.get(SOURCE_KEY) or LOCAL)


def is_held_back(data: dict) -> bool:
    return bool(data.get(HELD_BACK_KEY))


def identity(label: str, data: dict, path: Path) -> str:
    """What a scan is, independent of the file name of an attempt: its source plus user, job and item (else its path under the root)."""
    user, job, item = data.get("user_id"), data.get("job_id"), data.get("item_id")
    if job is not None and item is not None:
        return f"{label}|{user}|{job}|{item}"
    return f"{label}|{path.parent.parent.name}/{path.parent.name}/{path.stem}"


def hold_back(label: str, data: dict, path: Path, fraction: float = HELD_BACK_FRACTION) -> bool:
    """A stable split: the same scan always lands on the same side (a hash of its identity), about ``fraction`` of them held back."""
    digest = hashlib.sha256(identity(label, data, path).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float(1 << 64) < fraction


GROUP_LOCAL = "local"
GROUP_TUNING = "prod_tuning"
GROUP_HELD_BACK = "prod_held_back"


def group_of(data: dict) -> str:
    """``local`` (the owner's own scans), ``<label>_tuning`` or ``<label>_held_back`` for a read-only source."""
    source = source_of(data)
    if source == LOCAL:
        return GROUP_LOCAL
    return f"{source}_{'held_back' if is_held_back(data) else 'tuning'}"


def group_label(group: str) -> str:
    if group == GROUP_LOCAL:
        return "From this server (your own scans)"
    if group.endswith("_held_back"):
        return f"From {group[: -len('_held_back')]}: held back"
    return f"From {group[: -len('_tuning')]}: for tuning"


# ── The one line the lab shows per read-only source ─────────────────────────

def _why_unreadable(root: Path) -> str | None:
    try:
        if not root.exists():
            return "the folder is not there (is the prod folder mounted, and has prod saved any scans yet?)"
        if not root.is_dir():
            return "the path is not a folder"
        list(os.scandir(root))
    except PermissionError:
        return "no permission to read it (the folder belongs to another user; ask the owner to check its access)"
    except OSError as exc:
        return f"it could not be read ({exc.__class__.__name__})"
    return None


def source_status(root: ReadOnlyRoot) -> dict:
    """Readable or not (and why, in plain words), how many scans, how many confirmed, the newest scan's date. Never raises."""
    reason = _why_unreadable(root.path)
    out = {"label": root.label, "readable": reason is None, "reason": reason, "scans": 0, "confirmed": 0, "newest": None}
    if reason is not None:
        return out
    newest = None
    try:
        for path in root.path.glob("user-*/*/*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            out["scans"] += 1
            if data.get("ground_truth"):
                out["confirmed"] += 1
            stamp = str(data.get("created_at") or "")
            if stamp and (newest is None or stamp > newest):
                newest = stamp
    except OSError:
        out["readable"], out["reason"] = False, "it could not be read all the way through"
    if newest:
        try:
            out["newest"] = datetime.fromisoformat(newest.replace("Z", "+00:00")).astimezone(timezone.utc).date().isoformat()
        except ValueError:
            out["newest"] = newest[:10]
    return out
