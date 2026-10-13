"""Vet an uploaded SQL dump before it is handed to ``psql``.

``psql -f`` is a scripting language, not just a SQL client: a line such as
``\\! command`` runs a shell command inside the backend container, and statements like
``COPY ... FROM PROGRAM`` do the same inside the database container. A restore upload is
therefore remote code execution for anyone who can post one.

The app only ever needs to restore dumps that ``pg_dump`` wrote for it, so this accepts
exactly that shape and nothing else:

* No backslash anywhere outside ``COPY ... FROM stdin`` data blocks, apart from the
  ``\\restrict`` / ``\\unrestrict`` lines newer ``pg_dump`` versions emit. Rejecting every
  backslash (rather than only recognising meta-commands) means string-escape rules,
  ``E''`` strings and client-encoding tricks cannot matter.
* Every statement must be one of the kinds a schema/data dump contains (SET, CREATE/ALTER/
  DROP of tables, sequences, indexes, views and types, COMMENT, ``pg_catalog.setval``, and
  a strictly formed ``COPY ... FROM stdin``). Functions, triggers, roles, DO blocks,
  other extensions and ``COPY ... PROGRAM`` are refused.
* No ``pg_*`` / ``lo_*`` / ``dblink*`` identifiers (file access, sleeping, server programs).

Quotes, comments and dollar-quoted bodies are tracked so a ``COPY`` line hidden inside a
string cannot switch the checker into "data" mode while ``psql`` still sees commands.

This is defence in depth. It does not make restoring an untrusted dump safe on a
superuser database role, which is why the endpoint also asks for the admin's password.
"""

from __future__ import annotations

import re
from pathlib import Path


class RestoreSqlRejected(ValueError):
    """The dump contains something other than plain ``pg_dump`` output."""


# PostgreSQL identifiers may contain "$", but a dollar-quote tag may not.
_DOLLAR_DELIM = re.compile(r"\$([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)?\$")
_IDENT = re.compile(r"[A-Za-z_\x80-\xff][A-Za-z0-9_$\x80-\xff]*")
_RESTRICT_LINE = re.compile(r"^\\(restrict|unrestrict) [A-Za-z0-9]+\s*$")

# The only COPY form pg_dump writes: one line, optional column list, stdin source.
_COPY_STDIN = re.compile(r'^COPY [A-Z0-9_."]+( \([A-Z0-9_", ]*\))? FROM STDIN$')

_ALLOWED_STATEMENTS = [
    re.compile(r"^SET (?!ROLE\b|SESSION\b|LOCAL\b)[A-Z_][A-Z0-9_.]* (=|TO) .+$"),
    re.compile(r"^SELECT PG_CATALOG\.(SETVAL|SET_CONFIG)\([^()]*\)$"),
    re.compile(r"^DROP (TABLE|SEQUENCE|INDEX|VIEW|MATERIALIZED VIEW|TYPE)\b"),
    re.compile(r"^CREATE (UNLOGGED )?TABLE\b"),
    re.compile(r"^CREATE SEQUENCE\b"),
    re.compile(r"^CREATE (UNIQUE )?INDEX\b"),
    re.compile(r"^CREATE (MATERIALIZED )?VIEW\b"),
    re.compile(r"^CREATE TYPE\b"),
    re.compile(r"^CREATE EXTENSION (IF NOT EXISTS )?(UNACCENT|PG_TRGM|PLPGSQL)( WITH SCHEMA [A-Z_]+)?$"),
    re.compile(r"^ALTER (TABLE|SEQUENCE|INDEX|TYPE|VIEW)\b"),
    re.compile(r"^COMMENT ON\b"),
]

_SAFE_IDENT_EXACT = {"pg_catalog", "pg_temp", "pg_trgm"}
_BANNED_IDENT_PREFIXES = ("pg_", "lo_", "dblink")
_BANNED_WORDS = {"program"}
_CLIENT_ENCODING = re.compile(r"^SET CLIENT_ENCODING (=|TO) '(UTF8|UTF-8|SQL_ASCII|LATIN1)'$", re.I)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _check_identifier(name: str, line_no: int) -> None:
    lowered = name.lower()
    if lowered in _BANNED_WORDS:
        raise RestoreSqlRejected(f"line {line_no}: '{name}' is not allowed in a restore file")
    if lowered in _SAFE_IDENT_EXACT:
        return
    if lowered.startswith(_BANNED_IDENT_PREFIXES):
        raise RestoreSqlRejected(f"line {line_no}: '{name}' is not allowed in a restore file")


class _Scanner:
    def __init__(self) -> None:
        self.block_comment_depth = 0
        self.in_single = False
        self.in_double = False
        self.double_chars: list[str] = []
        self.dollar_tag: str | None = None
        self.in_copy_data = False
        self.statement: list[str] = []
        self.raw_statement: list[str] = []
        self.statement_line = 0

    # -- statements -----------------------------------------------------------------

    def _finish_statement(self, line_no: int) -> bool:
        """Validate the completed statement. Returns True if COPY data follows."""
        raw = _normalize("".join(self.raw_statement))
        text = _normalize("".join(self.statement)).upper()
        self.statement = []
        self.raw_statement = []
        if not text:
            return False
        if text.startswith("SET CLIENT_ENCODING") and not _CLIENT_ENCODING.match(raw):
            raise RestoreSqlRejected(f"line {self.statement_line}: unsupported client_encoding")
        if _COPY_STDIN.match(text):
            return True
        if any(pattern.match(text) for pattern in _ALLOWED_STATEMENTS):
            return False
        keyword = text.split(" ", 1)[0]
        raise RestoreSqlRejected(
            f"line {self.statement_line}: a {keyword} statement is not allowed in a restore file"
        )

    def _add(self, char: str, line_no: int) -> None:
        if not self.statement and not char.isspace():
            self.statement_line = line_no
        self.statement.append(char)

    # -- one line of non-COPY text --------------------------------------------------

    def feed_line(self, line: str, line_no: int) -> None:
        if "\x00" in line:
            raise RestoreSqlRejected(f"line {line_no}: binary data is not allowed in a restore file")

        if (
            not "".join(self.statement).strip()
            and not self.in_single
            and not self.in_double
            and self.dollar_tag is None
            and self.block_comment_depth == 0
            and _RESTRICT_LINE.match(line)
        ):
            return

        index = 0
        length = len(line)
        copy_follows = False
        while index < length:
            char = line[index]

            if self.block_comment_depth:
                if char == "\\":
                    raise RestoreSqlRejected(f"line {line_no}: backslashes are not allowed in a restore file")
                if line.startswith("/*", index):
                    self.block_comment_depth += 1
                    index += 2
                elif line.startswith("*/", index):
                    self.block_comment_depth -= 1
                    index += 2
                else:
                    index += 1
                continue

            if self.in_single:
                if char == "\\":
                    raise RestoreSqlRejected(f"line {line_no}: backslashes are not allowed in a restore file")
                self.raw_statement.append(char)
                if char == "'":
                    if line.startswith("''", index):
                        self.raw_statement.append("'")
                        index += 2
                        continue
                    self.in_single = False
                index += 1
                continue

            if self.in_double:
                if char == "\\":
                    raise RestoreSqlRejected(f"line {line_no}: backslashes are not allowed in a restore file")
                if char == '"':
                    if line.startswith('""', index):
                        self.double_chars.append('"')
                        index += 2
                        continue
                    self.in_double = False
                    _check_identifier("".join(self.double_chars), line_no)
                    self.double_chars = []
                else:
                    self.double_chars.append(char)
                index += 1
                continue

            if self.dollar_tag is not None:
                if char == "\\":
                    raise RestoreSqlRejected(f"line {line_no}: backslashes are not allowed in a restore file")
                closing = f"${self.dollar_tag}$"
                if line.startswith(closing, index):
                    self.dollar_tag = None
                    index += len(closing)
                else:
                    index += 1
                continue

            # Normal state.
            if char == "\\":
                raise RestoreSqlRejected(
                    f"line {line_no}: psql commands (backslash) are not allowed in a restore file"
                )
            if line.startswith("--", index):
                if "\\" in line[index:]:
                    raise RestoreSqlRejected(f"line {line_no}: backslashes are not allowed in a restore file")
                self._add(" ", line_no)
                break
            if line.startswith("/*", index):
                self.block_comment_depth = 1
                self._add(" ", line_no)
                index += 2
                continue
            if char == "'":
                self.in_single = True
                self._add("''", line_no)
                self.raw_statement.append("'")
                index += 1
                continue
            if char == '"':
                self.in_double = True
                self.double_chars = []
                self._add('"x"', line_no)
                index += 1
                continue
            if char == "$":
                match = _DOLLAR_DELIM.match(line, index)
                if match:
                    self.dollar_tag = match.group(1) or ""
                    self._add("''", line_no)
                    index = match.end()
                    continue
                self._add(char, line_no)
                index += 1
                continue
            ident = _IDENT.match(line, index)
            if ident:
                word = ident.group(0)
                _check_identifier(word, line_no)
                self._add(word, line_no)
                self.raw_statement.append(word)
                index = ident.end()
                continue
            if char == ";":
                is_copy = self._finish_statement(line_no)
                rest = line[index + 1:]
                if is_copy:
                    if rest.strip():
                        raise RestoreSqlRejected(f"line {line_no}: unexpected text after COPY")
                    copy_follows = True
                index += 1
                continue
            self._add(char, line_no)
            self.raw_statement.append(char)
            index += 1

        if copy_follows:
            self.in_copy_data = True


def check_restore_sql(path: str | Path) -> None:
    """Raise ``RestoreSqlRejected`` unless the file looks like plain ``pg_dump`` output."""
    scanner = _Scanner()
    line_no = 0
    with open(path, "rb") as handle:
        for raw_line in handle:
            line_no += 1
            line = raw_line.decode("latin-1")
            if scanner.in_copy_data:
                if line.startswith("\\."):
                    if line[2:].strip():
                        raise RestoreSqlRejected(f"line {line_no}: unexpected text after the end of COPY data")
                    scanner.in_copy_data = False
                continue
            scanner.feed_line(line, line_no)

    if scanner.in_copy_data:
        raise RestoreSqlRejected("the file ends inside a COPY data block")
    if (
        scanner.in_single
        or scanner.in_double
        or scanner.dollar_tag is not None
        or scanner.block_comment_depth
    ):
        raise RestoreSqlRejected("the file ends inside an unterminated quote or comment")
    if "".join(scanner.statement).strip():
        raise RestoreSqlRejected("the file ends in the middle of a statement")
