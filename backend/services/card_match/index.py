"""The picture index: one unit vector per catalogue card picture, searched with numpy cosine.

On disk, per model, under ``<data dir>/index/<model>/``:
  - ``vectors.npy``  float32 matrix (n, dim), rows are unit vectors;
  - ``entries.json`` ``{"model", "dim", "lang", "built_at", "build_seconds", "entries": [[card id, picture key], ...]}``
    in the same row order. The picture key is ``card_picture_packs.card_image_key`` (it carries a hash
    of the source URL), so a card whose picture URL changed is re-embedded and an unchanged one is not.

Pictures come from the server's own cache (``image_cache``, filled by ``CardPictureWarmer``), never
from the network. Builds are incremental and checkpointed, so a stopped build continues.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np

from . import config
from .images import decode_rgb

logger = logging.getLogger(__name__)

CHECKPOINT_EVERY = 1000
LOAD_CHUNK = 32


def index_dir(model: str, data_dir: Path | None = None) -> Path:
    return (data_dir or config.data_dir()) / "index" / model


def tcg_card_id(db_card_id: str) -> str:
    """``sv1-1_en`` -> ``sv1-1`` (the id TCGdex and the diagnostics traces use)."""
    return db_card_id.rsplit("_", 1)[0] if "_" in db_card_id else db_card_id


class CardIndex:
    """An index held in memory."""

    def __init__(self, model: str, vectors: np.ndarray, entries: list[tuple[str, str]], meta: dict | None = None) -> None:
        self.model = model
        self.vectors = np.ascontiguousarray(vectors, dtype=np.float32)
        self.entries = entries
        self.meta = meta or {}

    def __len__(self) -> int:
        return len(self.entries)

    @property
    def card_ids(self) -> list[str]:
        return [card_id for card_id, _key in self.entries]

    def search(self, queries: np.ndarray, k: int = 20) -> list[list[tuple[str, float]]]:
        """Top-k (card id, cosine) per query row, best first."""
        queries = np.atleast_2d(np.asarray(queries, dtype=np.float32))
        if len(self.entries) == 0:
            return [[] for _ in queries]
        scores = queries @ self.vectors.T
        k = min(k, scores.shape[1])
        out = []
        for row in scores:
            top = np.argpartition(-row, k - 1)[:k]
            top = top[np.argsort(-row[top])]
            out.append([(self.entries[i][0], float(row[i])) for i in top])
        return out

    def search_merged(self, queries: np.ndarray, k: int = 20) -> list[tuple[str, float]]:
        """Search several views of one card (for example 0 and 180 degrees); a card keeps its best score."""
        best: dict[str, float] = {}
        for hits in self.search(queries, k):
            for card_id, score in hits:
                if score > best.get(card_id, -2.0):
                    best[card_id] = score
        return sorted(best.items(), key=lambda item: -item[1])[:k]


def _atomic_write(path: Path, write: Callable[[Path], None]) -> None:
    temp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    write(temp)
    os.replace(temp, path)


def save_index(index: CardIndex, data_dir: Path | None = None, *, lang: str = "en", build_seconds: float | None = None) -> Path:
    directory = index_dir(index.model, data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    meta = {
        "model": index.model,
        "dim": int(index.vectors.shape[1]) if index.vectors.ndim == 2 else 0,
        "lang": lang,
        "built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "build_seconds": build_seconds,
        "count": len(index.entries),
        "entries": [list(entry) for entry in index.entries],
    }

    def write_vectors(temp: Path) -> None:
        with temp.open("wb") as handle:
            np.save(handle, index.vectors)

    _atomic_write(directory / "vectors.npy", write_vectors)
    _atomic_write(directory / "entries.json", lambda temp: temp.write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8"))
    with _loaded_lock:
        _loaded.pop(f"{directory}", None)
    return directory


def load_index(model: str, data_dir: Path | None = None) -> CardIndex | None:
    directory = index_dir(model, data_dir)
    try:
        meta = json.loads((directory / "entries.json").read_text(encoding="utf-8"))
        vectors = np.load(directory / "vectors.npy")
    except (OSError, ValueError):
        return None
    entries = [(card_id, key) for card_id, key in meta.get("entries", [])]
    if vectors.ndim != 2 or vectors.shape[0] != len(entries):
        logger.warning("Card-match index for %s is inconsistent; ignoring it", model)
        return None
    meta.pop("entries", None)
    return CardIndex(model, vectors, entries, meta)


_loaded: dict[str, tuple[tuple, CardIndex]] = {}
_loaded_lock = threading.Lock()


def get_index(model: str, data_dir: Path | None = None) -> CardIndex | None:
    """The index for a model, kept in memory and reloaded when the files change."""
    directory = index_dir(model, data_dir)
    try:
        stamp = ((directory / "entries.json").stat().st_mtime_ns, (directory / "vectors.npy").stat().st_mtime_ns)
    except OSError:
        return None
    cache_key = f"{directory}"
    with _loaded_lock:
        cached = _loaded.get(cache_key)
        if cached and cached[0] == stamp:
            return cached[1]
        index = load_index(model, data_dir)
        if index is not None:
            _loaded[cache_key] = (stamp, index)
        return index


def index_status(model: str, data_dir: Path | None = None) -> dict:
    """Small summary for the admin page (reads the ids file, not the matrix)."""
    directory = index_dir(model, data_dir)
    try:
        meta = json.loads((directory / "entries.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"model": model, "built": False, "count": 0}
    size = sum(path.stat().st_size for path in directory.glob("*") if path.is_file())
    return {
        "model": model, "built": True, "count": meta.get("count", 0), "dim": meta.get("dim"), "lang": meta.get("lang"),
        "built_at": meta.get("built_at"), "build_seconds": meta.get("build_seconds"), "size_bytes": size,
    }


def picture_query(db, lang: str = "en"):
    """Physical (not digital-only, e.g. TCG Pocket) synced cards of a language that have a catalogue picture."""
    from models import Card
    from services import offline_carddb

    return (
        offline_carddb._card_query(db, lang)
        .filter(Card.is_digital == False, Card.images_small.isnot(None), Card.images_small != "")  # noqa: E712
    )


def wanted_pictures(db, lang: str = "en") -> list[tuple[str, str]]:
    """(card id, picture key) for every card the index should hold, in id order."""
    from models import Card
    from services import card_picture_packs

    rows = picture_query(db, lang).with_entities(Card.id, Card.images_small).order_by(Card.id.asc()).all()
    return [(card_id, card_picture_packs.card_image_key(card_id, url)) for card_id, url in rows]


def cached_picture_bytes(db, keys: list[str]) -> dict[str, bytes]:
    from models import ImageCache

    rows = db.query(ImageCache.image_key, ImageCache.data).filter(ImageCache.image_key.in_(keys)).all()
    return {key: data for key, data in rows}


def build_index(
    session_factory,
    embedder,
    *,
    data_dir: Path | None = None,
    lang: str = "en",
    batch_size: int = 16,
    progress: Callable[[dict], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> dict:
    """Embed every cached picture that has no vector yet, drop vectors for cards that are gone, save.
    Returns the build statistics. Saves a checkpoint every ``CHECKPOINT_EVERY`` new vectors."""
    started = time.monotonic()
    report = progress or (lambda _state: None)
    db = session_factory()
    try:
        wanted = wanted_pictures(db, lang)
        existing = load_index(embedder.name, data_dir)
        reusable: dict[tuple[str, str], np.ndarray] = {}
        if existing is not None and existing.vectors.shape[1] == embedder.dim:
            reusable = {entry: existing.vectors[row] for row, entry in enumerate(existing.entries)}
        done: dict[tuple[str, str], np.ndarray] = {entry: reusable[entry] for entry in wanted if entry in reusable}
        todo = [entry for entry in wanted if entry not in done]
        stats = {
            "total": len(wanted), "reused": len(done), "embedded": 0, "not_cached": 0, "failed": 0,
            "stopped": False, "model": embedder.name,
        }
        report({**stats, "phase": "embedding", "todo": len(todo)})

        def snapshot(final: bool = False) -> None:
            entries = [entry for entry in wanted if entry in done]
            vectors = np.stack([done[entry] for entry in entries]) if entries else np.zeros((0, embedder.dim), dtype=np.float32)
            save_index(CardIndex(embedder.name, vectors, entries), data_dir, lang=lang,
                       build_seconds=round(time.monotonic() - started, 1) if final else None)

        embed_seconds = 0.0
        since_checkpoint = 0
        for start in range(0, len(todo), LOAD_CHUNK):
            if should_stop and should_stop():
                stats["stopped"] = True
                break
            chunk = todo[start:start + LOAD_CHUNK]
            blobs = cached_picture_bytes(db, [key for _card_id, key in chunk])
            ready, images = [], []
            for entry in chunk:
                data = blobs.get(entry[1])
                if data is None:
                    stats["not_cached"] += 1
                    continue
                try:
                    images.append(decode_rgb(data))
                    ready.append(entry)
                except Exception:  # an unreadable cached picture must not stop the build
                    logger.info("Card-match: cannot read picture %s", entry[1])
                    stats["failed"] += 1
            for sub in range(0, len(images), batch_size):
                tick = time.monotonic()
                vectors = embedder.embed(images[sub:sub + batch_size])
                embed_seconds += time.monotonic() - tick
                for entry, vector in zip(ready[sub:sub + batch_size], vectors):
                    done[entry] = vector
                stats["embedded"] += len(vectors)
                since_checkpoint += len(vectors)
            report({**stats, "phase": "embedding", "todo": len(todo), "indexed": len(done)})
            if since_checkpoint >= CHECKPOINT_EVERY:
                snapshot()
                since_checkpoint = 0
        snapshot(final=True)
        stats.update(
            indexed=len(done), seconds=round(time.monotonic() - started, 1), embed_seconds=round(embed_seconds, 1),
            ms_per_picture=round(1000 * embed_seconds / stats["embedded"], 1) if stats["embedded"] else None,
        )
        return stats
    finally:
        db.close()
