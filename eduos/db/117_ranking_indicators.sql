-- RANK-01: the U.S. News Best High Schools indicators, as a school's own figures.
--
-- For each school year, a school records its figures for the six indicators
-- (and, if it likes, the rank U.S. News published), each with its source. The
-- superintendent verifies each entry (not their own). A change is a new entry;
-- the old one is kept as history. EduOS shows the weights, trends and missing
-- figures. It doesn't compute or predict a rank: no claim without its source
-- and a review.

CREATE TABLE school_ranking_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  data_year text NOT NULL CHECK (data_year ~ '^\d{4}-\d{2}$'),
  indicator text NOT NULL CHECK (indicator IN ('college_readiness','curriculum_breadth','assessment_proficiency','assessment_performance',
    'underserved_performance','graduation_rate','published_rank')),
  vals jsonb NOT NULL CHECK (jsonb_typeof(vals) = 'object' AND octet_length(vals::text) <= 2000),
  source_url text CHECK (source_url IS NULL OR (source_url ~ '^https://\S+$' AND length(source_url) <= 500)),
  source_note text CHECK (source_note IS NULL OR length(btrim(source_note)) BETWEEN 1 AND 300),
  entered_by uuid NOT NULL REFERENCES users(id),
  entered_at timestamptz NOT NULL DEFAULT now(),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  superseded_at timestamptz,
  CHECK (source_url IS NOT NULL OR source_note IS NOT NULL),
  CHECK (verified_by IS NULL OR verified_by <> entered_by),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE UNIQUE INDEX school_ranking_entries_current ON school_ranking_entries(school_id, data_year, indicator) WHERE superseded_at IS NULL;

ALTER TABLE school_ranking_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_ranking_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON school_ranking_entries
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);
-- Read: the superintendent (district), the school's principal and vice principal.
CREATE POLICY scope_read ON school_ranking_entries AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR coalesce(eduos_ctx_role(), '') = 'superintendent'
  OR (coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal') AND school_id = eduos_ctx_school()));
-- Enter: the superintendent or the school's principal.
CREATE POLICY scope_insert ON school_ranking_entries AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (entered_by = eduos_ctx_user() AND verified_by IS NULL
  AND (coalesce(eduos_ctx_role(), '') = 'superintendent' OR (coalesce(eduos_ctx_role(), '') = 'principal' AND school_id = eduos_ctx_school()))));
-- Supersede: whoever may enter; verify: the superintendent only.
CREATE POLICY scope_update ON school_ranking_entries AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR coalesce(eduos_ctx_role(), '') = 'superintendent' OR (coalesce(eduos_ctx_role(), '') = 'principal' AND school_id = eduos_ctx_school()))
  WITH CHECK (eduos_is_table_owner() OR coalesce(eduos_ctx_role(), '') = 'superintendent' OR (coalesce(eduos_ctx_role(), '') = 'principal' AND school_id = eduos_ctx_school()));

-- Only the superintendent verifies, never their own entry; an entry is otherwise
-- only ever superseded (by a corrected one, which needs verifying again).
CREATE FUNCTION eduos_ranking_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.verified_by, NEW.verified_at) IS DISTINCT FROM (OLD.verified_by, OLD.verified_at)
     AND NOT (eduos_is_table_owner() OR (coalesce(eduos_ctx_role(), '') = 'superintendent' AND NEW.verified_by = eduos_ctx_user() AND OLD.verified_by IS NULL)) THEN
    RAISE EXCEPTION 'only the superintendent verifies an entry' USING ERRCODE = '42501';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN RAISE EXCEPTION 'entry is superseded' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_ranking_entries_guard BEFORE UPDATE ON school_ranking_entries FOR EACH ROW EXECUTE FUNCTION eduos_ranking_entry_guard();
