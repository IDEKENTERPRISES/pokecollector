"""Card pictures for the offline card database (F14b): one pack per set, and the server-side warm-up.

The phone used to fetch about 20,000 small pictures one at a time, and the server fetched each one
from TCGdex the first time it was asked. Now:
  - ``CardPictureWarmer`` fetches every card's small picture into ``image_cache`` ahead of time
    (about 5 requests a second, one run at a time, resumable because cached pictures are skipped);
  - ``pack_for_set`` concatenates a set's cached pictures into one file the phone unpacks.

Pack format (``application/octet-stream``): a 4-byte big-endian length N, N bytes of JSON header
``{"v": 1, "items": [{"id", "o", "l", "t"}], "missing": [card ids]}``, then the picture bytes.
``o`` is the offset into the bytes after the header, ``l`` the length, ``t`` the content type.
The ETag is a hash of the pictures' cache keys (which carry the hash of each source URL), sizes and
fetch times, so it changes exactly when a picture does, without reading the picture bytes. Built
packs are kept on disk named after their ETag.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import struct
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from sqlalchemy import func
from sqlalchemy.orm import Session

from models import Card, ImageCache, Set
from services import offline_carddb

logger = logging.getLogger(__name__)

PACK_VERSION = 1
PACK_DIR = Path(os.environ.get("CARD_PICTURE_PACK_DIR", "/app/data/card-picture-packs"))
WARM_REQUESTS_PER_SECOND = 5
# Give up a run when the upstream keeps failing; the next run continues where this one stopped.
MAX_CONSECUTIVE_FAILURES = 25
_KEY_CHUNK = 500


def card_image_key(card_id: str, images_small: str) -> str:
    """The ``image_cache`` key api/images.py uses for a catalogue card's small picture."""
    return f"card:{card_id}:small:{hashlib.sha1(images_small.encode('utf-8')).hexdigest()}"


def _set_cards(db: Session, lang: str, set_id: str) -> list[tuple[str, str]]:
    """(card id, images_small) for the cards of one set that have a catalogue picture, in id order."""
    tcg_set_id = _tcg_set_id(db, lang, set_id)
    rows = (
        offline_carddb._card_query(db, lang)
        .filter(Card.set_id == tcg_set_id, Card.images_small.isnot(None), Card.images_small != "")
        .with_entities(Card.id, Card.images_small)
        .order_by(Card.id.asc())
        .all()
    )
    return [(card_id, url) for card_id, url in rows]


def _tcg_set_id(db: Session, lang: str, set_id: str) -> str:
    set_obj = db.query(Set).filter(Set.id == set_id, Set.lang == lang).first()
    return (set_obj.tcg_set_id or set_obj.id) if set_obj else set_id


def _cached_rows(db: Session, keys: list[str]) -> dict[str, tuple[int, int, str, str]]:
    """key -> (rowid, length, content type, cached_at) for the keys that are cached (no bytes read)."""
    found: dict[str, tuple[int, int, str, str]] = {}
    for start in range(0, len(keys), _KEY_CHUNK):
        chunk = keys[start:start + _KEY_CHUNK]
        rows = (
            db.query(ImageCache.image_key, ImageCache.id, func.length(ImageCache.data), ImageCache.content_type, ImageCache.cached_at)
            .filter(ImageCache.image_key.in_(chunk))
            .all()
        )
        for key, row_id, length, content_type, cached_at in rows:
            found[key] = (row_id, int(length or 0), content_type or "image/webp", str(cached_at))
    return found


def pack_for_set(db: Session, lang: str, set_id: str, *, pack_dir: Path | None = None) -> dict | None:
    """``{"etag", "bytes", "count", "missing"}`` for a set, building and keeping the pack on disk
    when it is not there yet. None when the set does not exist."""
    if offline_carddb.set_payload(db, lang, set_id) is None:
        return None
    cards = _set_cards(db, lang, set_id)
    keys = {card_id: card_image_key(card_id, url) for card_id, url in cards}
    cached = _cached_rows(db, list(keys.values()))
    present = [(card_id, keys[card_id]) for card_id, _url in cards if keys[card_id] in cached]
    missing = [card_id for card_id, _url in cards if keys[card_id] not in cached]

    digest = hashlib.sha256(f"v{PACK_VERSION}".encode())
    for card_id, key in present:
        _row_id, length, content_type, cached_at = cached[key]
        digest.update(f"|{key}:{length}:{content_type}:{cached_at}".encode())
    digest.update(("|missing:" + ",".join(missing)).encode())
    etag = digest.hexdigest()[:40]

    directory = pack_dir or PACK_DIR
    path = directory / lang / f"{set_id}-{etag}.pack"
    data = _read_pack(path)
    if data is None:
        data = _build_pack(db, present, cached, missing)
        _write_pack(directory / lang, set_id, path, data)
    return {"etag": etag, "data": data, "count": len(present), "missing": missing}


def _read_pack(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        return None


def _write_pack(directory: Path, set_id: str, path: Path, data: bytes) -> None:
    """Keep the pack on disk (best effort) and drop this set's older packs."""
    try:
        directory.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(f".tmp{os.getpid()}{threading.get_ident()}")
        temp.write_bytes(data)
        os.replace(temp, path)
        for old in directory.glob(f"{set_id}-*.pack"):
            if old != path:
                old.unlink(missing_ok=True)
    except OSError as exc:
        logger.info("Card picture pack for %s was not kept on disk (%s)", set_id, exc)


def _build_pack(db: Session, present: list[tuple[str, str]], cached, missing: list[str]) -> bytes:
    items = []
    body = bytearray()
    for card_id, key in present:
        row = db.query(ImageCache.data, ImageCache.content_type).filter(ImageCache.image_key == key).first()
        if row is None:  # removed between the two reads: report it as missing
            missing.append(card_id)
            continue
        data, content_type = row
        items.append({"id": card_id, "o": len(body), "l": len(data), "t": content_type or "image/webp"})
        body += data
    header = json.dumps({"v": PACK_VERSION, "items": items, "missing": missing}, separators=(",", ":"), ensure_ascii=False).encode()
    return struct.pack(">I", len(header)) + header + bytes(body)


def unpack(data: bytes) -> dict:
    """Parse a pack into ``{"items": [(id, content_type, bytes)], "missing": [...]}`` (tests, tooling)."""
    (size,) = struct.unpack(">I", data[:4])
    header = json.loads(data[4:4 + size])
    body = data[4 + size:]
    items = [(item["id"], item["t"], body[item["o"]:item["o"] + item["l"]]) for item in header["items"]]
    return {"items": items, "missing": header["missing"]}


# ── The warm-up ──────────────────────────────────────────────────────────────

class CardPictureWarmer:
    """Fetches every synced card's small picture into the server's cache, 5 a second, one run at a
    time. Pictures already cached are skipped, so a stopped run (or a restart) is resumed by
    starting again."""

    def __init__(self, sleep: Callable[[float], None] = time.sleep) -> None:
        self._sleep = sleep
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._state = self._idle_state()

    @staticmethod
    def _idle_state() -> dict:
        return {
            "running": False, "total": 0, "cached": 0, "done": 0, "failed": 0, "error": None,
            "started_at": None, "finished_at": None,
        }

    def status(self) -> dict:
        with self._lock:
            return dict(self._state)

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, *, background: bool = True) -> dict:
        """Start a run unless one is going. Returns the status either way."""
        with self._lock:
            if self.is_running() or self._state["running"]:
                return dict(self._state)
            self._state = {
                **self._idle_state(), "running": True,
                "started_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            }
            if background:
                self._thread = threading.Thread(target=self.run, name="card-picture-warmer", daemon=True)
                self._thread.start()
        return self.status()

    def _set(self, **changes) -> None:
        with self._lock:
            self._state.update(changes)

    def _add(self, **counts) -> None:
        with self._lock:
            for key, value in counts.items():
                self._state[key] += value

    def _pause(self) -> None:
        self._sleep(1 / WARM_REQUESTS_PER_SECOND)

    def run(self, *, session_factory=None, fetch=None) -> None:
        """Fill the cache synchronously (the thread's target; tests call it directly). `fetch(db, key,
        url)` stores one picture and raises on a failure."""
        try:
            if session_factory is None:
                from database import SessionLocal as session_factory
            if fetch is None:
                from api.images import _get_or_fetch as fetch
            db = session_factory()
            try:
                self._warm(db, fetch)
            finally:
                db.close()
        except Exception as exc:
            logger.exception("Card picture warm-up stopped")
            self._set(error=str(exc) or "error")
        finally:
            self._set(running=False, finished_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat())

    def _warm(self, db: Session, fetch) -> None:
        if not offline_carddb.offline_carddb_enabled():
            return
        wanted: list[tuple[str, str]] = []
        for lang in offline_carddb.languages(db):
            wanted += [(card_image_key(card_id, url), url) for card_id, url in _language_cards(db, lang)]
        keys = [key for key, _url in wanted]
        cached = set(_cached_rows(db, keys))
        todo = [(key, url) for key, url in wanted if key not in cached]
        self._set(total=len(wanted), cached=len(cached))
        consecutive = 0
        for key, url in todo:
            try:
                fetch(db, key, url)
                self._add(done=1, cached=1)
                consecutive = 0
            except Exception as exc:
                logger.info("Card picture %s failed (%s)", key, exc)
                self._add(failed=1)
                consecutive += 1
                if consecutive >= MAX_CONSECUTIVE_FAILURES:
                    self._set(error="upstream unavailable")
                    return
            self._pause()


def _language_cards(db: Session, lang: str) -> list[tuple[str, str]]:
    return (
        offline_carddb._card_query(db, lang)
        .filter(Card.images_small.isnot(None), Card.images_small != "")
        .with_entities(Card.id, Card.images_small)
        .order_by(Card.id.asc())
        .all()
    )


card_picture_warmer = CardPictureWarmer()


def schedule_after_sync() -> None:
    """Called after a card sync: fill in the pictures of any cards it added. Quick when nothing is missing."""
    if os.getenv("CARD_PICTURE_PREWARM_AFTER_SYNC", "true").strip().lower() in {"0", "false", "no", "off"}:
        return
    try:
        card_picture_warmer.start()
    except Exception:
        logger.exception("Could not start the card picture warm-up")
