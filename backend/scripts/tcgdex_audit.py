"""Audit which TCGdex requests a full sync makes that do not return 200, and why.

Run inside the backend container (reads the ids a sync would request from the real DB):

    docker exec <backend-container> python -m scripts.tcgdex_audit --langs en,ja

or anywhere without a database (uses TCGdex's own set and card lists only):

    python -m scripts.tcgdex_audit --langs en,ja --no-db --sample 300

What it checks per language:
  1. GET /sets, /series and /series/{id} (the lists a sync starts with)
  2. GET /sets/{id} for every set, the way the sync sends it (id percent-encoded), and the old
     unencoded way for ids with reserved characters ("SM1+")
  3. GET /cards/{id} for the ids a sync asks for: TCGdex's own card lists, plus (with the DB) the
     stored cards that still lack details and the tracked collection/wishlist/binder cards
  4. the ids seen in the owner's log (ja SM1+..SM5+, en neo4-001..010)

Failures are grouped by cause:
  unencoded_characters   404 only because "+" etc. was not percent-encoded; the encoded id is 200
  padded_number          404 for "neo4-001"; TCGdex's id is "neo4-1"
  set_without_cards      the set answers 200 but lists no cards in this language
  card_missing_upstream  404 and no padded/unpadded twin; TCGdex has no such card in this language
  transient              5xx, 429 or timeouts that persisted through the retries
  other                  anything else

It is polite on purpose: at most 4 workers, one request started every --delay seconds overall,
retries with backoff, Retry-After honoured. Nothing is written to the database.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import random
import sys
import tempfile
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import httpx

TCGDEX_BASE = "https://api.tcgdex.net/v2"
MAX_WORKERS = 4
CAUSES = (
    "unencoded_characters",
    "padded_number",
    "set_without_cards",
    "card_missing_upstream",
    "transient",
    "other",
)
# Ids from the owner's sync log of 2026-10-23.
LOG_SET_IDS = {"ja": ["SM1+", "sm2+", "SM3+", "SM4+", "SM5+"]}
LOG_CARD_IDS = {"en": [f"neo4-{n:03d}" for n in range(1, 11)]}


def segment(value: str) -> str:
    return quote(str(value), safe="")


def unpadded_card_id(card_id: str) -> str | None:
    """Same rule as services.pokemon_api.unpadded_card_id (kept here so the audit has no app imports)."""
    set_part, sep, local = str(card_id).rpartition("-")
    if not sep or not set_part or not local.isdigit() or len(local) < 2 or not local.startswith("0"):
        return None
    stripped = local.lstrip("0") or "0"
    return f"{set_part}-{stripped}" if stripped != local else None


@dataclass
class Row:
    kind: str  # list | set | card
    lang: str
    id: str
    origin: str  # tcgdex-list | db-missing-details | db-tracked | owner-log | upstream
    url: str
    status: int | None
    cause: str
    note: str = ""


class Throttle:
    """Start at most one request per ``interval`` seconds across all workers."""

    def __init__(self, interval: float):
        self.interval = max(0.0, interval)
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next)
            self._next = slot + self.interval
        if slot > now:
            time.sleep(slot - now)


class Fetcher:
    def __init__(self, client: httpx.Client, *, delay: float = 0.15, retries: int = 2, backoff: float = 1.0):
        self.client = client
        self.throttle = Throttle(delay)
        self.retries = retries
        self.backoff = backoff
        self.requests = 0
        self._count_lock = threading.Lock()

    def get(self, url: str) -> tuple[int | None, object | None, str]:
        """(status, json or None, error). Retries 5xx, 429 and network errors; status None = gave up on errors."""
        error = ""
        for attempt in range(self.retries + 1):
            self.throttle.wait()
            with self._count_lock:
                self.requests += 1
            try:
                response = self.client.get(url)
            except httpx.HTTPError as exc:
                error = f"{type(exc).__name__}: {exc}"
                status = None
            else:
                status = response.status_code
                if status == 200:
                    try:
                        return status, response.json(), ""
                    except ValueError:
                        return status, None, "invalid JSON"
                if status < 500 and status != 429:
                    return status, None, ""
                error = f"HTTP {status}"
                retry_after = response.headers.get("retry-after", "")
                if retry_after.isdigit():
                    time.sleep(min(int(retry_after), 30))
            if attempt < self.retries:
                time.sleep(self.backoff * (2 ** attempt))
        return status, None, error


def _transient(status: int | None) -> bool:
    return status is None or status == 429 or status >= 500


def _status_cause(status: int | None) -> str:
    if status == 200:
        return "ok"
    return "transient" if _transient(status) else "other"


class Audit:
    def __init__(self, fetcher: Fetcher, *, base: str = TCGDEX_BASE, workers: int = MAX_WORKERS, progress=None):
        self.f = fetcher
        self.base = base.rstrip("/")
        self.workers = max(1, min(MAX_WORKERS, workers))
        self.rows: list[Row] = []
        self.ok: Counter = Counter()
        self.progress = progress or (lambda message: None)
        self._lock = threading.Lock()

    def _add(self, row: Row) -> None:
        with self._lock:
            if row.cause == "ok":
                self.ok[(row.kind, row.lang)] += 1
            else:
                self.rows.append(row)

    def _map(self, fn, items, label: str) -> None:
        items = list(items)
        done = 0
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            for _ in pool.map(fn, items):
                done += 1
                if done % 500 == 0:
                    self.progress(f"  {label}: {done}/{len(items)}")

    # -- lists -------------------------------------------------------------------------------
    def check_lists(self, lang: str) -> tuple[list[dict], list[str]]:
        """GET /sets and the series lists. Returns (sets, series ids)."""
        base = f"{self.base}/{lang}"
        status, sets, error = self.f.get(f"{base}/sets")
        self._add(Row("list", lang, "sets", "tcgdex-list", f"{base}/sets", status, _status_cause(status), error))
        sets = sets if isinstance(sets, list) else []
        status, series, error = self.f.get(f"{base}/series")
        self._add(Row("list", lang, "series", "tcgdex-list", f"{base}/series", status, _status_cause(status), error))
        series_ids = [s["id"] for s in series if isinstance(s, dict) and s.get("id")] if isinstance(series, list) else []

        def one_series(series_id: str) -> None:
            url = f"{base}/series/{segment(series_id)}"
            st, _body, err = self.f.get(url)
            self._add(Row("list", lang, f"series/{series_id}", "tcgdex-list", url, st, _status_cause(st), err))

        self._map(one_series, series_ids, f"{lang} series")
        return sets, series_ids

    # -- sets --------------------------------------------------------------------------------
    def check_sets(self, lang: str, set_ids: list[tuple[str, str]]) -> dict[str, list[str]]:
        """GET /sets/{id}; returns {set id: upstream card ids} for sets that answered 200."""
        base = f"{self.base}/{lang}"
        cards_by_set: dict[str, list[str]] = {}

        def one(item: tuple[str, str]) -> None:
            set_id, origin = item
            url = f"{base}/sets/{segment(set_id)}"
            status, body, error = self.f.get(url)
            if status == 200 and isinstance(body, dict):
                cards = [c.get("id") for c in body.get("cards") or [] if isinstance(c, dict) and c.get("id")]
                with self._lock:
                    cards_by_set[set_id] = cards
                total = ((body.get("cardCount") or {}).get("total")) or 0
                if not cards:
                    note = f"cardCount.total={total}, no cards listed in {lang}"
                    self._add(Row("set", lang, set_id, origin, url, status, "set_without_cards", note))
                else:
                    self._add(Row("set", lang, set_id, origin, url, status, "ok"))
            else:
                self._add(Row("set", lang, set_id, origin, url, status, _status_cause(status), error))
            if segment(set_id) != set_id:
                # What the sync sent before ids were encoded.
                old_url = f"{base}/sets/{set_id}"
                old_status, _body, old_error = self.f.get(old_url)
                if old_status == 200:
                    self._add(Row("set-unencoded", lang, set_id, origin, old_url, old_status, "ok"))
                elif status == 200:
                    note = "encoded id is 200; the raw id was read with '+' as a space or otherwise mangled"
                    self._add(Row("set-unencoded", lang, set_id, origin, old_url, old_status, "unencoded_characters", note))
                else:
                    self._add(Row("set-unencoded", lang, set_id, origin, old_url, old_status, _status_cause(old_status), old_error))

        self._map(one, sorted(set(set_ids)), f"{lang} sets")
        return cards_by_set

    # -- cards -------------------------------------------------------------------------------
    def check_cards(self, lang: str, card_ids: list[tuple[str, str]], upstream_ids: set[str]) -> None:
        base = f"{self.base}/{lang}"

        def one(item: tuple[str, str]) -> None:
            card_id, origin = item
            url = f"{base}/cards/{segment(card_id)}"
            status, _body, error = self.f.get(url)
            if status == 200:
                self._add(Row("card", lang, card_id, origin, url, status, "ok"))
                return
            if status != 404:
                self._add(Row("card", lang, card_id, origin, url, status, _status_cause(status), error))
                return
            twin = unpadded_card_id(card_id)
            if twin and twin in upstream_ids:
                note = f"TCGdex's id is {twin}"
                self._add(Row("card", lang, card_id, origin, url, status, "padded_number", note))
            elif twin:
                twin_status, _b, _e = self.f.get(f"{base}/cards/{segment(twin)}")
                if twin_status == 200:
                    self._add(Row("card", lang, card_id, origin, url, status, "padded_number", f"TCGdex's id is {twin}"))
                else:
                    note = f"{twin} is {twin_status} too"
                    self._add(Row("card", lang, card_id, origin, url, status, "card_missing_upstream", note))
            else:
                listed = "listed in its set but" if card_id in upstream_ids else "not in any set list and"
                self._add(Row("card", lang, card_id, origin, url, status, "card_missing_upstream", f"{listed} 404"))

        self._map(one, card_ids, f"{lang} cards")


# -- ids a sync would request from the database ----------------------------------------------
def load_db_ids(lang: str) -> tuple[list[str], list[tuple[str, str]]]:
    """(tcg set ids, [(tcg card id, origin)]) stored for ``lang``: sets, cards lacking details, tracked cards."""
    from database import SessionLocal
    from models import BinderCard, Card, CollectionItem, Set, WishlistItem
    from services.card_metadata import _missing_metadata_filter

    db = SessionLocal()
    try:
        set_ids = [
            (tcg or sid) for sid, tcg in db.query(Set.id, Set.tcg_set_id).filter(Set.lang == lang).all()
        ]
        missing = [
            tcg for (tcg,) in db.query(Card.tcg_card_id)
            .filter(Card.lang == lang, _missing_metadata_filter()).all() if tcg
        ]
        tracked: set[str] = set()
        for model in (CollectionItem, WishlistItem, BinderCard):
            rows = db.query(Card.tcg_card_id).join(model, model.card_id == Card.id).filter(
                Card.lang == lang, Card.is_custom == False  # noqa: E712
            ).distinct().all()
            tracked.update(tcg for (tcg,) in rows if tcg)
        cards = [(tcg, "db-tracked") for tcg in sorted(tracked)]
        cards += [(tcg, "db-missing-details") for tcg in sorted(set(missing) - tracked)]
        return sorted(set(set_ids)), cards
    finally:
        db.close()


def run_audit(
    langs: list[str],
    *,
    use_db: bool = True,
    sample: int = 0,
    all_cards: bool = False,
    delay: float = 0.15,
    workers: int = 2,
    base: str = TCGDEX_BASE,
    client: httpx.Client | None = None,
    progress=print,
    seed: int = 1,
) -> Audit:
    own_client = client is None
    client = client or httpx.Client(timeout=30.0, follow_redirects=True, headers={"User-Agent": "pokecollector-audit"})
    rng = random.Random(seed)
    try:
        audit = Audit(Fetcher(client, delay=delay), base=base, workers=workers, progress=progress)
        for lang in langs:
            progress(f"[{lang}] lists")
            sets, _series = audit.check_lists(lang)
            upstream_set_ids = [(s["id"], "tcgdex-list") for s in sets if isinstance(s, dict) and s.get("id")]
            db_set_ids: list[tuple[str, str]] = []
            db_cards: list[tuple[str, str]] = []
            if use_db:
                try:
                    set_ids, db_cards = load_db_ids(lang)
                    db_set_ids = [(sid, "db") for sid in set_ids]
                except Exception as exc:  # no database reachable: audit TCGdex's own lists only
                    progress(f"[{lang}] database not used: {type(exc).__name__}: {exc}")
            log_sets = [(sid, "owner-log") for sid in LOG_SET_IDS.get(lang, [])]
            seen: dict[str, str] = {}
            for sid, origin in [*log_sets, *db_set_ids, *upstream_set_ids]:
                seen.setdefault(sid, origin)
            progress(f"[{lang}] {len(seen)} sets")
            cards_by_set = audit.check_sets(lang, list(seen.items()))

            upstream_cards = sorted({cid for ids in cards_by_set.values() for cid in ids})
            candidates: dict[str, str] = {}
            for cid in LOG_CARD_IDS.get(lang, []):
                candidates.setdefault(cid, "owner-log")
            for cid, origin in db_cards:
                candidates.setdefault(cid, origin)
            pool = [cid for cid in upstream_cards if cid not in candidates]
            if not all_cards and sample and len(pool) > sample:
                pool = rng.sample(pool, sample)
            for cid in pool:
                candidates.setdefault(cid, "tcgdex-list")
            progress(f"[{lang}] {len(candidates)} card ids ({len(upstream_cards)} in TCGdex's own lists)")
            audit.check_cards(lang, list(candidates.items()), set(upstream_cards))
        return audit
    finally:
        if own_client:
            client.close()


def summarize(audit: Audit, langs: list[str]) -> str:
    by_cause: dict[str, list[Row]] = defaultdict(list)
    for row in audit.rows:
        by_cause[row.cause].append(row)
    lines = ["", "TCGdex audit summary", "====================", f"requests sent: {audit.f.requests}"]
    for lang in langs:
        ok_sets = audit.ok[("set", lang)]
        ok_cards = audit.ok[("card", lang)]
        lines.append(f"[{lang}] 200 OK: {ok_sets} sets, {ok_cards} cards")
    lines.append("")
    lines.append("Not 200, by cause (per language):")
    for cause in CAUSES:
        rows = by_cause.get(cause, [])
        per_lang = Counter(r.lang for r in rows)
        detail = ", ".join(f"{lang}={per_lang.get(lang, 0)}" for lang in langs)
        lines.append(f"  {cause:<22} {len(rows):>6}   ({detail})")
        for row in rows[:3]:
            status = row.status if row.status is not None else "no response"
            lines.append(f"      e.g. {row.lang}/{row.kind} {row.id}  [{status}] {row.note}".rstrip())
    return "\n".join(lines)


def write_csv(audit: Audit, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = out_dir / f"tcgdex_audit_{stamp}.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["cause", "lang", "kind", "id", "origin", "status", "url", "note"])
        for row in sorted(audit.rows, key=lambda r: (r.cause, r.lang, r.kind, r.id)):
            writer.writerow([row.cause, row.lang, row.kind, row.id, row.origin, row.status or "", row.url, row.note])
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check which TCGdex requests of a full sync do not return 200, and why.")
    parser.add_argument("--langs", default="en,ja", help="comma separated TCGdex languages (default en,ja)")
    parser.add_argument("--no-db", action="store_true", help="do not read ids from the database")
    parser.add_argument("--sample", type=int, default=0, help="check only N random ids of TCGdex's own card lists per language (0 = every id); ids from the database and the owner log are always all checked")
    parser.add_argument("--delay", type=float, default=0.15, help="seconds between request starts, overall (default 0.15)")
    parser.add_argument("--workers", type=int, default=2, help=f"parallel requests, at most {MAX_WORKERS} (default 2)")
    parser.add_argument("--out-dir", default=tempfile.gettempdir(), help="where to write the CSV (default: the temp dir)")
    args = parser.parse_args(argv)

    langs = [lang.strip() for lang in args.langs.split(",") if lang.strip()]
    if not langs:
        parser.error("--langs is empty")
    if args.workers > MAX_WORKERS:
        print(f"--workers capped at {MAX_WORKERS}", file=sys.stderr)
    audit = run_audit(
        langs,
        use_db=not args.no_db,
        sample=args.sample,
        delay=args.delay,
        workers=args.workers,
        progress=lambda message: print(message, file=sys.stderr, flush=True),
    )
    print(summarize(audit, langs))
    print(f"\nCSV: {write_csv(audit, Path(args.out_dir))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
