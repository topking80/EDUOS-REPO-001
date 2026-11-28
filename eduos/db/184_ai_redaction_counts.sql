-- SEC-06 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §4.1): each AI usage row
-- records what redaction removed before an external call, as kinds and
-- counts only (src/redaction-counts.js), e.g. {"student_name": 2, "email": 1}.
-- The check allows only the fixed kinds with whole-number counts, so no text
-- can be stored here. Local calls (nothing leaves) keep the empty object.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS redactions jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION eduos_redaction_counts_ok(j jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT jsonb_typeof(j) = 'object' AND NOT EXISTS (
    SELECT 1 FROM jsonb_each(j) e
     WHERE e.key NOT IN ('student_name','student_number','titled_name','email','phone','address',
                         'birth_date','url','id_number','long_number','secret')
        OR jsonb_typeof(e.value) <> 'number'
        OR e.value::text !~ '^[0-9]{1,6}$')
$$;
REVOKE ALL ON FUNCTION eduos_redaction_counts_ok(jsonb) FROM PUBLIC;

ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_redactions_counts_only;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_redactions_counts_only CHECK (eduos_redaction_counts_ok(redactions));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN
    GRANT UPDATE (redactions) ON ai_usage TO eduos_app;
    GRANT EXECUTE ON FUNCTION eduos_redaction_counts_ok(jsonb) TO eduos_app;
  END IF;
END $$;
