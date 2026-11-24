-- SAFE-04: National Weather Service warnings prompt a shelter; a person decides.
--
-- When the superintendent turns it on, EduOS asks the National Weather
-- Service (api.weather.gov) for active alerts at each school's location every
-- couple of minutes. Only the school's coordinates are sent: no student,
-- staff or school data. A warning that matches a hazard (tornado, severe
-- thunderstorm, hurricane, flooding, winter storm, extreme heat, hazardous
-- materials) alerts the school's principal, vice principals and the
-- superintendent, and shows a "Start shelter" prompt. EduOS never starts an
-- alert itself: someone starts it (with the two-step confirm) or dismisses
-- the prompt with a note. Watches and advisories are shown for information.

CREATE TABLE district_weather_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  enabled boolean NOT NULL DEFAULT false,
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now()
);

-- Where a school is, for weather only (four decimals: about 10 m).
CREATE TABLE school_weather_points (
  school_id uuid PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  lat numeric(7,4) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon numeric(8,4) NOT NULL CHECK (lon BETWEEN -180 AND 180),
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id)
);

CREATE TABLE school_weather_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  nws_id text NOT NULL CHECK (length(nws_id) BETWEEN 1 AND 300),
  event text NOT NULL CHECK (length(event) BETWEEN 1 AND 100),
  level text NOT NULL CHECK (level IN ('warning','watch','advisory','statement')),
  hazard text CHECK (hazard IS NULL OR hazard IN ('tornado','severe_thunderstorm','lightning','hurricane','flood','winter_storm','extreme_heat','earthquake','hazmat')),
  severity text CHECK (severity IS NULL OR length(severity) <= 20),
  headline text CHECK (headline IS NULL OR length(headline) <= 300),
  area text CHECK (area IS NULL OR length(area) <= 500),
  instruction text CHECK (instruction IS NULL OR length(instruction) <= 1000),
  onset timestamptz,
  expires timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  decision text CHECK (decision IS NULL OR decision IN ('started','dismissed')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  incident_id uuid,
  CHECK ((decision IS NULL) = (decided_by IS NULL)),
  CHECK (decision IS DISTINCT FROM 'started' OR incident_id IS NOT NULL),
  UNIQUE (school_id, nws_id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, incident_id) REFERENCES safety_incidents(district_id, id)
);
CREATE INDEX school_weather_alerts_open ON school_weather_alerts(district_id, school_id) WHERE ended_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['district_weather_settings','school_weather_points','school_weather_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The superintendent turns it on; the principal (a vice principal acts as
-- one) sets their school's location and decides prompts there.
CREATE FUNCTION eduos_weather_lead(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') = 'superintendent' OR (coalesce(eduos_ctx_role(), '') = 'principal' AND p_school = eduos_ctx_school())
$$;
CREATE POLICY scope_read ON district_weather_settings AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR coalesce(eduos_ctx_role(), '') IN ('superintendent','principal'));
CREATE POLICY scope_write ON district_weather_settings AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND set_by = eduos_ctx_user()));
CREATE POLICY scope_update ON district_weather_settings AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent') WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent');
CREATE POLICY scope_read ON school_weather_points AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_weather_lead(school_id));
CREATE POLICY scope_insert ON school_weather_points AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_weather_lead(school_id) AND set_by = eduos_ctx_user()));
CREATE POLICY scope_update ON school_weather_points AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_weather_lead(school_id)) WITH CHECK (eduos_is_table_owner() OR eduos_weather_lead(school_id));
CREATE POLICY scope_delete ON school_weather_points AS RESTRICTIVE FOR DELETE USING (eduos_is_table_owner() OR eduos_weather_lead(school_id));
-- Alerts are written by the sweep (functions below); leaders read and decide.
CREATE POLICY scope_read ON school_weather_alerts AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_weather_lead(school_id));
CREATE POLICY functions_insert ON school_weather_alerts AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_update ON school_weather_alerts AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_weather_lead(school_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_weather_lead(school_id) AND decided_by = eduos_ctx_user()));

-- The sweep: every school with a location in a district that turned it on.
-- Schools are tenant-isolated, so each district is read in its own context.
CREATE FUNCTION eduos_weather_targets() RETURNS TABLE(district_id uuid, school_id uuid, school_name text, lat numeric, lon numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dist uuid;
BEGIN
  FOR dist IN SELECT w.district_id FROM district_weather_settings w JOIN districts d ON d.id = w.district_id AND d.status = 'active'
               WHERE w.enabled ORDER BY w.district_id LOOP
    PERFORM set_config('app.district_id', dist::text, true);
    RETURN QUERY SELECT p.district_id, p.school_id, s.name, p.lat, p.lon
      FROM school_weather_points p JOIN schools s ON s.id = p.school_id AND s.status = 'active'
     WHERE p.district_id = dist ORDER BY p.school_id;
  END LOOP;
  PERFORM set_config('app.district_id', '', true);
END $$;
REVOKE ALL ON FUNCTION eduos_weather_targets() FROM PUBLIC;

-- Record what NWS says now for one school. p_alerts: [{id, event, level,
-- hazard, severity, headline, area, instruction, onset, expires}]. Alerts no
-- longer listed end. Returns the warnings seen for the first time (to notify).
CREATE FUNCTION eduos_weather_record(p_district uuid, p_school uuid, p_alerts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a jsonb; fresh jsonb := '[]'::jsonb; ids text[] := ARRAY[]::text[]; rid uuid; ins boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_weather_points p JOIN district_weather_settings w ON w.district_id = p.district_id AND w.enabled
                  WHERE p.school_id = p_school AND p.district_id = p_district) THEN RETURN '[]'::jsonb; END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) LOOP
    ids := ids || (a->>'id');
    INSERT INTO school_weather_alerts(district_id, school_id, nws_id, event, level, hazard, severity, headline, area, instruction, onset, expires)
      VALUES (p_district, p_school, left(a->>'id', 300), left(a->>'event', 100), a->>'level', a->>'hazard', left(a->>'severity', 20),
              left(a->>'headline', 300), left(a->>'area', 500), left(a->>'instruction', 1000), (a->>'onset')::timestamptz, (a->>'expires')::timestamptz)
      ON CONFLICT (school_id, nws_id) DO UPDATE SET last_seen_at = now(), expires = EXCLUDED.expires, headline = EXCLUDED.headline, ended_at = NULL
      RETURNING id, (xmax = 0) INTO rid, ins;
    IF ins AND a->>'level' = 'warning' AND a->>'hazard' IS NOT NULL THEN
      fresh := fresh || jsonb_build_object('id', rid, 'event', a->>'event', 'hazard', a->>'hazard', 'headline', a->>'headline', 'expires', a->>'expires');
    END IF;
  END LOOP;
  UPDATE school_weather_alerts SET ended_at = now() WHERE school_id = p_school AND district_id = p_district AND ended_at IS NULL AND NOT (nws_id = ANY (ids));
  RETURN fresh;
END $$;
REVOKE ALL ON FUNCTION eduos_weather_record(uuid, uuid, jsonb) FROM PUBLIC;

-- Who a new warning alerts: the school's principal and vice principals, and
-- the district's superintendents.
CREATE FUNCTION eduos_weather_recipients(p_district uuid, p_school uuid) RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
   WHERE m.district_id = p_district AND m.status = 'active'
     AND ((m.role IN ('principal','vice_principal') AND m.school_id = p_school) OR m.role = 'superintendent')
     AND p_district = nullif(current_setting('app.district_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION eduos_weather_recipients(uuid, uuid) FROM PUBLIC;
