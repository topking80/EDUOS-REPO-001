-- SPORTS-01: MaxPreps and Hudl, by link and by file, with family opt-in.
--
--   * A team links its MaxPreps and Hudl pages (those two sites only); everyone
--     who sees the team sees the links.
--   * The team's coaches (or the school's leaders) download files to upload to
--     MaxPreps or Hudl themselves: the schedule with published results, and the
--     roster. No vendor gets access to EduOS.
--   * A roster file holds only athletes whose family opted in for that service
--     (name, jersey, grade, position). A family opts in or out per child and
--     service, any time. Every export is logged with how many were left out.

CREATE TABLE activity_external_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  activity_id uuid NOT NULL REFERENCES school_activities(id),
  service text NOT NULL CHECK (service IN ('maxpreps','hudl')),
  url text NOT NULL CHECK (length(url) <= 500 AND url ~ '^https://([a-z0-9-]+\.)*(maxpreps\.com|hudl\.com)(/[^\s]*)?$'),
  added_by uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE UNIQUE INDEX activity_external_links_one ON activity_external_links(activity_id, service) WHERE removed_at IS NULL;

CREATE TABLE athlete_sharing_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  service text NOT NULL CHECK (service IN ('maxpreps','hudl')),
  granted_by uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX athlete_sharing_consents_open ON athlete_sharing_consents(student_id, service) WHERE revoked_at IS NULL;

CREATE TABLE sports_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  activity_id uuid NOT NULL REFERENCES school_activities(id),
  service text NOT NULL CHECK (service IN ('maxpreps','hudl')),
  kind text NOT NULL CHECK (kind IN ('roster','schedule')),
  included integer NOT NULL CHECK (included >= 0),
  withheld integer NOT NULL DEFAULT 0 CHECK (withheld >= 0),
  exported_by uuid NOT NULL REFERENCES users(id),
  exported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sports_exports_activity ON sports_exports(district_id, activity_id, exported_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activity_external_links','athlete_sharing_consents','sports_exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The team's coaches and advisors, or the school's principal / vice principal.
CREATE FUNCTION eduos_manages_team(p_activity uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_is_activity_staff(p_activity) OR EXISTS (SELECT 1 FROM school_activities a WHERE a.id = p_activity AND a.district_id = eduos_ctx_district()
    AND coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal') AND a.school_id = eduos_ctx_school())
$$;
-- A parent or guardian of the student.
CREATE FUNCTION eduos_is_family_of(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM student_user_links l WHERE l.student_id = p_student AND l.user_id = eduos_ctx_user() AND l.district_id = eduos_ctx_district()
    AND l.relationship IN ('parent','guardian') AND l.status = 'active')
$$;

-- Links: everyone in the district reads; the team's managers write.
CREATE POLICY scope_insert ON activity_external_links AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_manages_team(activity_id) AND added_by = eduos_ctx_user()));
CREATE POLICY scope_update ON activity_external_links AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_manages_team(activity_id));

-- Opt-ins: the family reads and changes them; the school's staff read them.
CREATE POLICY scope_read ON athlete_sharing_consents AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_is_family_of(student_id)
  OR (coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal','teacher','coach') AND school_id = eduos_ctx_school()));
CREATE POLICY scope_insert ON athlete_sharing_consents AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_is_family_of(student_id) AND granted_by = eduos_ctx_user()));
CREATE POLICY scope_update ON athlete_sharing_consents AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_is_family_of(student_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_is_family_of(student_id) AND revoked_by = eduos_ctx_user()));

-- The export log: the team's managers and the school's leaders.
CREATE POLICY scope_read ON sports_exports AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_manages_team(activity_id)
  OR coalesce(eduos_ctx_role(), '') = 'superintendent');
CREATE POLICY scope_insert ON sports_exports AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_manages_team(activity_id) AND exported_by = eduos_ctx_user()));
