-- Per-school opt-in to pass active NWS weather advisories to teachers.
--
-- District weather settings (db/124) only turn on the NWS check and show
-- prompts to principals and the superintendent. Teachers do not see those
-- alerts unless this school-level setting is on. It defaults to off.
-- The principal, a vice principal at that school, or the superintendent
-- can change it; the change is written to EDAL by the API.

CREATE TABLE school_weather_share_settings (
  school_id uuid PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  pass_on boolean NOT NULL DEFAULT false,
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id)
);

ALTER TABLE school_weather_share_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_weather_share_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON school_weather_share_settings
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);

CREATE FUNCTION eduos_weather_share_manager(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') = 'superintendent'
      OR (coalesce(eduos_ctx_role(), '') IN ('principal', 'vice_principal') AND p_school = eduos_ctx_school())
$$;
REVOKE ALL ON FUNCTION eduos_weather_share_manager(uuid) FROM PUBLIC;

-- Teachers can see whether their own school is passing advisories on.
-- Leaders can see schools in their scope (superintendent: the district).
CREATE POLICY scope_read ON school_weather_share_settings AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner()
      OR school_id = eduos_ctx_school()
      OR coalesce(eduos_ctx_role(), '') = 'superintendent');
CREATE POLICY scope_insert ON school_weather_share_settings AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_weather_share_manager(school_id) AND set_by = eduos_ctx_user()));
CREATE POLICY scope_update ON school_weather_share_settings AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_weather_share_manager(school_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_weather_share_manager(school_id) AND set_by = eduos_ctx_user()));

-- Teachers cannot read school_weather_alerts directly (leaders only, db/124).
-- This returns active, non-expired alerts for their school only when pass_on
-- is true.
CREATE FUNCTION eduos_teacher_weather_advisories(p_school uuid)
RETURNS TABLE (
  id uuid,
  event text,
  level text,
  hazard text,
  severity text,
  headline text,
  area text,
  instruction text,
  onset timestamptz,
  expires timestamptz,
  first_seen_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.event, a.level, a.hazard, a.severity, a.headline, a.area, a.instruction, a.onset, a.expires, a.first_seen_at
    FROM school_weather_alerts a
    JOIN school_weather_share_settings s ON s.school_id = a.school_id AND s.pass_on IS TRUE
   WHERE a.school_id = p_school
     AND a.ended_at IS NULL
     AND (a.expires IS NULL OR a.expires > now())
     AND p_school = eduos_ctx_school()
     AND coalesce(eduos_ctx_role(), '') = 'teacher'
   ORDER BY (a.level = 'warning') DESC, a.first_seen_at DESC
   LIMIT 20
$$;
REVOKE ALL ON FUNCTION eduos_teacher_weather_advisories(uuid) FROM PUBLIC;
