"""Make a restore work when the live database has newer tables than the dump.

``pg_dump --clean --if-exists`` drops and recreates the tables it contains. If the live
database also has tables the dump knows nothing about (created by a newer version of the
app), and those tables have foreign keys to tables in the dump, PostgreSQL refuses:

    cannot drop constraint users_pkey on table users because other objects depend on it

The same happens for a partial (group) backup that holds a table other live tables
reference. The fix is to drop the dependent tables first, inside the restore transaction,
and recreate them (empty) from the models once the restore has succeeded.

Everything here only reads the dump and the catalog; the statements it builds come from
catalog names, quoted as identifiers, never from the text of the uploaded file.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)

SCHEMA = "public"

_IDENT = r'(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)'
_TABLE_REF = rf"(?:(?P<schema>{_IDENT})\s*\.\s*)?(?P<name>{_IDENT})"
_CREATE_TABLE = re.compile(
    rf"^\s*CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?{_TABLE_REF}", re.IGNORECASE
)
_DROP_TABLE = re.compile(rf"^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?{_TABLE_REF}", re.IGNORECASE)
_COPY_START = re.compile(r"^\s*COPY\s+.*\s+FROM\s+stdin\s*;?\s*$", re.IGNORECASE)
_COPY_END = "\\."

# (child_table, parent_table) for every foreign key between tables in the schema.
FkEdge = tuple[str, str]

FK_EDGES_SQL = """
SELECT child.relname, parent.relname
FROM pg_constraint AS con
JOIN pg_class AS child ON child.oid = con.conrelid
JOIN pg_namespace AS child_ns ON child_ns.oid = child.relnamespace
JOIN pg_class AS parent ON parent.oid = con.confrelid
JOIN pg_namespace AS parent_ns ON parent_ns.oid = parent.relnamespace
WHERE con.contype = 'f'
  AND child_ns.nspname = %s
  AND parent_ns.nspname = %s
"""


def _unquote(identifier: str) -> str:
    if identifier.startswith('"'):
        return identifier[1:-1].replace('""', '"')
    return identifier.lower()


def quote_ident(name: str) -> str:
    """Quote a catalog name as a PostgreSQL identifier."""
    return '"' + name.replace('"', '""') + '"'


def parse_dump_tables(path: str | Path) -> set[str]:
    """Names of the ``public`` tables the dump creates or drops (a streaming line scan)."""
    tables: set[str] = set()
    in_copy = False
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if in_copy:
                # COPY data rows are arbitrary text; only the terminator matters.
                if line.rstrip("\r\n") == _COPY_END:
                    in_copy = False
                continue
            if _COPY_START.match(line):
                in_copy = True
                continue
            match = _CREATE_TABLE.match(line) or _DROP_TABLE.match(line)
            if not match:
                continue
            schema = match.group("schema")
            if schema is not None and _unquote(schema) != SCHEMA:
                continue
            tables.add(_unquote(match.group("name")))
    return tables


def compute_dependent_tables(dump_tables: Iterable[str], fk_edges: Iterable[FkEdge]) -> list[str]:
    """Tables outside the dump that reference, directly or transitively, a table inside it."""
    in_dump = set(dump_tables)
    children_of: dict[str, set[str]] = defaultdict(set)
    for child, parent in fk_edges:
        if child != parent:
            children_of[parent].add(child)

    dependents: set[str] = set()
    pending = list(in_dump)
    while pending:
        parent = pending.pop()
        for child in children_of.get(parent, ()):
            if child in in_dump or child in dependents:
                continue
            dependents.add(child)
            pending.append(child)
    return sorted(dependents)


def build_drop_sql(tables: Iterable[str]) -> str | None:
    """One ``DROP TABLE IF EXISTS ... CASCADE`` for the given catalog names, or None."""
    names = sorted(set(tables))
    if not names:
        return None
    targets = ", ".join(f"{quote_ident(SCHEMA)}.{quote_ident(name)}" for name in names)
    return f"DROP TABLE IF EXISTS {targets} CASCADE;"


def fetch_fk_edges(params: dict) -> list[FkEdge]:
    """Read the live foreign keys between ``public`` tables (read-only)."""
    import psycopg2

    connection = psycopg2.connect(
        user=params["user"],
        password=params["password"],
        host=params["host"],
        port=params["port"],
        dbname=params["dbname"],
        connect_timeout=15,
    )
    try:
        connection.set_session(readonly=True, autocommit=True)
        with connection.cursor() as cursor:
            cursor.execute(FK_EDGES_SQL, (SCHEMA, SCHEMA))
            return [(child, parent) for child, parent in cursor.fetchall()]
    finally:
        connection.close()


def plan_restore_drops(dump_path: str | Path, params: dict, fetch_edges=None) -> list[str]:
    """The live tables that must be dropped so the dump can replace the tables it holds.

    Best effort: if the catalog cannot be read the restore proceeds exactly as before
    (and fails with PostgreSQL's own message if something depends on the dump's tables).
    """
    try:
        dump_tables = parse_dump_tables(dump_path)
        if not dump_tables:
            return []
        dependents = compute_dependent_tables(dump_tables, (fetch_edges or fetch_fk_edges)(params))
    except Exception:
        logger.warning("Could not check the live schema for tables that block a restore", exc_info=True)
        return []
    if dependents:
        logger.info(
            "Restore: dropping %d table(s) that are not in the backup but depend on tables "
            "it replaces (they are recreated empty afterwards): %s",
            len(dependents),
            ", ".join(dependents),
        )
    return dependents


def with_drops(command: list[str], dropped: list[str]) -> list[str]:
    """Insert the drops before ``-f <dump>`` so ``--single-transaction`` wraps both in one."""
    drop_sql = build_drop_sql(dropped)
    if drop_sql is None:
        return list(command)
    index = command.index("-f")
    return [*command[:index], "-c", drop_sql, *command[index:]]
