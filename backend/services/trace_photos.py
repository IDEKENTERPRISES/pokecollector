"""Review photos of scan traces that outlive the scan job rows (used by the Scanner lab's card finder).

A local scan trace names its scan only by ``item_id``; the finder then reads the whole review photo through the
database (``ScanJobItem.image_path``) from the scan upload folder. A wipe of all user data deletes both, while the
traces (the matcher's real-photo test set) are kept. So before a wipe:

- ``detach_review_photos`` copies each trace's review photo into the trace's own folder (``<stem>.review.jpg``,
  written atomically) and records ``review_photo_file`` (path under the trace root) in the trace JSON;
- every local trace with an ``item_id`` is stamped with the ``data_epoch`` it was made in (``data_epoch``), if it
  has none, so that after the wipe its ``item_id`` can never fetch a new trainer's unrelated scan.

``review_photo_loader`` (called by ``card_match.benchmark.review_photo_loader``) reads the trace-local copy first and
goes to the database only for a trace made in the current data epoch (or a legacy trace in a database that was never
wiped). It is idempotent: a trace that is already done is skipped.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

REVIEW_FILE_KEY = "review_photo_file"  # path of the copy, relative to the trace root, "/" separated
EPOCH_KEY = "data_epoch"
REVIEW_SUFFIX = ".review.jpg"


class DetachError(Exception):
    """A trace could not be made independent of the database. The wipe must not start."""


def trace_roots() -> list[Path]:
    """The writable local trace roots (a read-only root, such as prod's mounted on nonprod, is never touched)."""
    from services import scan_trace

    return list(scan_trace._cleanup_roots())


def iter_local_traces(roots: list[Path]):
    """(path, data) of every readable local scan trace under ``user-N/<day>/*.json``."""
    from services import trace_sources

    for root in roots:
        if not root.is_dir() or root.is_symlink():
            continue
        for path in sorted(root.glob("user-*/*/*.json")):
            if path.name.startswith(".") or not path.is_file() or path.is_symlink():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and trace_sources.source_of(data) == trace_sources.LOCAL:
                yield root, path, data


def _atomic_write(path: Path, content: bytes) -> None:
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except Exception:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _scan_photo(db, data: dict, read_photo):
    """The review photo bytes of this trace's scan, or None when there is none (never made, or past retention).
    The row must belong to the same job as the trace, or its id was reused by someone else's scan."""
    from models import ScanJobItem

    item_id = data.get("item_id")
    row = db.get(ScanJobItem, item_id)
    if row is None or not row.image_path:
        return None
    if data.get("job_id") is not None and row.job_id != data.get("job_id"):
        return None
    try:
        return read_photo(row.image_path)
    except FileNotFoundError:
        return None
    except Exception as exc:
        from services.scan_storage import ScanUploadError

        if isinstance(exc, ScanUploadError):
            return None
        raise


def detach_review_photos(db, current_epoch: str | None, *, roots: list[Path] | None = None, read_photo=None) -> dict:
    """Copy the review photos beside their traces and stamp the epoch. Raises DetachError on the first failure."""
    from services import scan_storage

    read_photo = read_photo or scan_storage.read_review_photo
    result = {"traces": 0, "copied": 0, "already_done": 0, "no_photo": 0}
    for root, path, data in iter_local_traces(roots if roots is not None else trace_roots()):
        if not data.get("item_id"):
            continue
        result["traces"] += 1
        try:
            changed = False
            recorded = data.get(REVIEW_FILE_KEY)
            if recorded and (root / recorded).is_file():
                result["already_done"] += 1
            else:
                photo = _scan_photo(db, data, read_photo)
                if photo:
                    copy = path.with_name(f"{path.stem}{REVIEW_SUFFIX}")
                    _atomic_write(copy, photo)
                    data[REVIEW_FILE_KEY] = copy.relative_to(root).as_posix()
                    result["copied"] += 1
                    changed = True
                else:
                    if recorded:
                        data.pop(REVIEW_FILE_KEY)  # the recorded copy is gone and so is the original
                        changed = True
                    result["no_photo"] += 1
            if not data.get(EPOCH_KEY) and current_epoch:
                data[EPOCH_KEY] = current_epoch
                changed = True
            if changed:
                _atomic_write(path, json.dumps(data, indent=2, ensure_ascii=False, default=str).encode("utf-8"))
        except DetachError:
            raise
        except Exception as exc:
            logger.error("Could not detach the review photo of trace %s", path, exc_info=True)
            raise DetachError(f"Trace {path.name}: {exc}") from None
    return result


def _local_copy(data: dict) -> bytes | None:
    recorded = data.get(REVIEW_FILE_KEY)
    if not recorded or not isinstance(recorded, str):
        return None
    for root in trace_roots():
        try:
            base = root.resolve()
            candidate = (base / recorded).resolve()
        except OSError:
            continue
        if base in candidate.parents and candidate.is_file():
            try:
                return candidate.read_bytes()
            except OSError:
                return None
    return None


def review_photo_loader(session_factory, data: dict):
    """A function that returns the scan's whole review photo (decoded, at most 2048 px) or None. See the module text.
    Returns None itself for another stack's scan (its item id means nothing in this database)."""
    from services import trace_sources

    if trace_sources.source_of(data) != trace_sources.LOCAL:
        return None
    has_copy = bool(data.get(REVIEW_FILE_KEY))
    if not data.get("item_id") and not has_copy:
        return None
    if session_factory is None and not has_copy:
        return None

    def load():
        from services import scan_storage
        from services.card_match.images import decode_rgb

        raw = _local_copy(data)
        if raw is None:
            if session_factory is None or not data.get("item_id"):
                return None
            db = session_factory()
            try:
                from services.data_wipe import read_data_epoch

                stamped = data.get(EPOCH_KEY)
                if stamped and stamped != read_data_epoch(db):
                    return None  # made before a wipe: its item id may now be somebody else's scan
                raw = _scan_photo(db, data, scan_storage.read_review_photo)
            except Exception:
                return None
            finally:
                db.close()
        if not raw:
            return None
        try:
            return decode_rgb(raw, max_side=2048)
        except Exception:
            return None

    return load
