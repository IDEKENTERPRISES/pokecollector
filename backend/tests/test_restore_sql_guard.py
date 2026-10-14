import os
import tempfile
import unittest

from services.restore_sql_guard import RestoreSqlRejected, check_restore_sql

# Shaped like real `pg_dump --clean --if-exists` output (PostgreSQL 18).
REAL_DUMP = r"""--
-- PostgreSQL database dump
--

\restrict AbC123xyz

-- Dumped from database version 18.0
SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET row_security = off;

ALTER TABLE IF EXISTS ONLY public.collection DROP CONSTRAINT IF EXISTS collection_card_id_fkey;
DROP INDEX IF EXISTS public.idx_collection_grouping;
DROP TABLE IF EXISTS public.collection;
DROP SEQUENCE IF EXISTS public.collection_id_seq;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';

SET default_tablespace = '';
SET default_table_access_method = heap;

CREATE TABLE public.collection (
    id integer NOT NULL,
    card_id character varying,
    quantity integer DEFAULT 1,
    variant character varying DEFAULT 'Normal'::character varying NOT NULL,
    added_at timestamp without time zone DEFAULT now(),
    CONSTRAINT ck_collection_variant CHECK (((variant)::text = ANY ((ARRAY['Normal'::character varying, 'Holo'::character varying])::text[])))
);

ALTER TABLE public.collection OWNER TO pokemon;

CREATE SEQUENCE public.collection_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.collection_id_seq OWNED BY public.collection.id;
ALTER TABLE ONLY public.collection ALTER COLUMN id SET DEFAULT nextval('public.collection_id_seq'::regclass);

COPY public.collection (id, card_id, quantity, variant, added_at) FROM stdin;
1	sv1-25_en	2	Normal	2025-03-04 21:15:00
2	sv1-26_en	1	Holo	\N
3	note with an escaped backslash \\ and tab\there	1	Normal	\N
\.

SELECT pg_catalog.setval('public.collection_id_seq', 3, true);

ALTER TABLE ONLY public.collection
    ADD CONSTRAINT collection_pkey PRIMARY KEY (id);

CREATE INDEX idx_collection_grouping ON public.collection USING btree (card_id, variant);
CREATE INDEX idx_cards_dex_ids ON public.cards USING gin (dex_ids);

ALTER TABLE ONLY public.collection
    ADD CONSTRAINT collection_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.cards(id) ON DELETE SET NULL;

\unrestrict AbC123xyz
"""


class RestoreSqlGuardTests(unittest.TestCase):
    def _check(self, sql: str, encoding: str = "utf-8"):
        handle = tempfile.NamedTemporaryFile("wb", suffix=".sql", delete=False)
        try:
            handle.write(sql.encode(encoding))
            handle.close()
            check_restore_sql(handle.name)
        finally:
            os.unlink(handle.name)

    def assertRejected(self, sql: str, fragment: str | None = None):
        with self.assertRaises(RestoreSqlRejected) as raised:
            self._check(sql)
        if fragment:
            self.assertIn(fragment, str(raised.exception))

    def test_accepts_a_real_pg_dump(self):
        self._check(REAL_DUMP)

    def test_accepts_copy_data_containing_backslashes_and_statement_lookalikes(self):
        self._check(
            "COPY public.cards (id, name) FROM stdin;\n"
            "1\t\\! not a command, just data\n"
            "2\tDROP TABLE users;\n"
            "\\.\n"
        )

    # -- psql meta-commands -------------------------------------------------------

    def test_rejects_shell_escape(self):
        self.assertRejected("SET statement_timeout = 0;\n\\! id\n", "backslash")

    def test_rejects_shell_escape_mid_line(self):
        self.assertRejected("SET statement_timeout = 0; \\! id\n", "backslash")

    def test_rejects_other_meta_commands(self):
        for command in (r"\copy x from '/etc/passwd'", r"\i /tmp/x.sql", r"\o |sh", r"\gexec", r"\set"):
            with self.subTest(command=command):
                self.assertRejected(f"{command}\n")

    def test_rejects_forged_restrict_lines_with_extra_content(self):
        self.assertRejected("\\restrict abc; \\! id\n")
        self.assertRejected("\\restrict abc\n\\! id\n")

    def test_copy_line_hidden_in_a_string_does_not_switch_to_data_mode(self):
        self.assertRejected(
            "SET search_path = '\n"
            "COPY public.cards (id) FROM stdin;\n"
            "';\n"
            "\\! id\n"
        )

    def test_copy_line_hidden_in_a_comment_does_not_switch_to_data_mode(self):
        self.assertRejected(
            "/*\nCOPY public.cards (id) FROM stdin;\n*/\n\\! id\n"
        )

    def test_copy_line_hidden_in_dollar_quote_does_not_switch_to_data_mode(self):
        self.assertRejected(
            "COMMENT ON TABLE public.cards IS $x$\n"
            "COPY public.cards (id) FROM stdin;\n"
            "$x$;\n"
            "\\! id\n"
        )

    def test_copy_data_ends_at_a_line_starting_with_backslash_dot(self):
        self.assertRejected(
            "COPY public.cards (id) FROM stdin;\n1\n\\.\n\\! id\n"
        )
        self.assertRejected(
            "COPY public.cards (id) FROM stdin;\n1\n\\.  \n\\! id\n"
        )
        self.assertRejected(
            "COPY public.cards (id) FROM stdin;\n1\n\\.x\n\\! id\n"
        )

    def test_backslash_in_strings_comments_and_identifiers_is_rejected(self):
        self.assertRejected("COMMENT ON TABLE public.cards IS 'a\\'; \\! id --';\n")
        self.assertRejected("-- note \\! id\nSET statement_timeout = 0;\n")
        self.assertRejected('CREATE TABLE "a\\b" (id integer);\n')

    # -- SQL that runs code or reads files ---------------------------------------

    def test_rejects_copy_to_program_and_other_copy_forms(self):
        self.assertRejected("COPY public.cards FROM PROGRAM 'id';\n")
        self.assertRejected("COPY (SELECT 1) TO PROGRAM 'id';\n")
        self.assertRejected("COPY public.cards FROM '/etc/passwd';\n")
        self.assertRejected("COPY public.cards TO STDOUT;\n")
        self.assertRejected("COPY public.cards (id) FROM stdin WITH (FORMAT binary);\n")

    def test_rejects_code_creating_statements(self):
        for statement in (
            "DO $$ BEGIN PERFORM 1; END $$;",
            "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1';",
            "CREATE TRIGGER t BEFORE INSERT ON public.cards FOR EACH ROW EXECUTE FUNCTION f();",
            "CREATE EXTENSION plpython3u;",
            "CREATE EXTENSION dblink;",
            "CREATE ROLE evil SUPERUSER;",
            "ALTER ROLE pokemon SUPERUSER;",
            "ALTER SYSTEM SET archive_command = 'id';",
            "SET ROLE postgres;",
            "SET SESSION AUTHORIZATION postgres;",
            "GRANT ALL ON public.cards TO PUBLIC;",
            "INSERT INTO public.users VALUES (1);",
            "UPDATE public.users SET role = 'admin';",
            "DELETE FROM public.users;",
            "TRUNCATE public.cards;",
            "SELECT 1;",
            "SELECT pg_read_file('/etc/passwd');",
            "SELECT pg_catalog.setval('x', (SELECT 1), true);",
        ):
            with self.subTest(statement=statement):
                self.assertRejected(statement + "\n")

    def test_rejects_dangerous_functions_hidden_inside_allowed_statements(self):
        self.assertRejected("CREATE TABLE t (a text DEFAULT pg_read_file('/etc/passwd'));\n")
        self.assertRejected('CREATE TABLE t (a text DEFAULT "pg_read_file"(\'/etc/passwd\'));\n')
        self.assertRejected("CREATE VIEW v AS SELECT lo_import('/etc/passwd');\n")
        self.assertRejected("CREATE VIEW v AS SELECT pg_sleep(100);\n")
        self.assertRejected("CREATE VIEW v AS SELECT dblink('x','y');\n")

    def test_rejects_non_utf8_client_encoding(self):
        self.assertRejected("SET client_encoding = 'SJIS';\n")

    # -- structural problems ------------------------------------------------------

    def test_rejects_unterminated_input(self):
        self.assertRejected("SET statement_timeout = 0")
        self.assertRejected("SET search_path = 'abc;\n")
        self.assertRejected("COPY public.cards (id) FROM stdin;\n1\n")
        self.assertRejected("/* never closed\n")

    def test_rejects_null_bytes(self):
        self.assertRejected("SET statement_timeout = 0;\x00\n")

    def test_accepts_crlf_line_endings(self):
        self._check(REAL_DUMP.replace("\n", "\r\n"))

    def test_accepts_non_ascii_data(self):
        self._check("COPY public.cards (id, name) FROM stdin;\n1\tプリン é\n\\.\n")


if __name__ == "__main__":
    unittest.main()
