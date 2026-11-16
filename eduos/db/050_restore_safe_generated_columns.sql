-- Backups must restore (EDUOS-DB-02 drill, 2026-11-16). pg_restore runs with
-- an empty search_path, so a function used by a generated column has to name
-- the schema of everything it calls. eduos_redact_compact() (043), behind
-- students.redact_number_compact, called eduos_redact_tokens() unqualified,
-- and every restore of a database with students failed there. Same result,
-- schema-qualified; stored values stay valid.
CREATE OR REPLACE FUNCTION eduos_redact_compact(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string(public.eduos_redact_tokens(p), '') $$;
