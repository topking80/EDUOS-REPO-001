-- SAFE-03: severe weather (and other hazards) and each room's shelter area.
--
-- A shelter or hold can name its hazard: tornado, severe thunderstorm,
-- lightning, hurricane, flooding, winter storm, extreme heat, earthquake or a
-- hazardous-materials release. Staff, students and classroom screens get that
-- hazard's instructions (src/safety-model.js).
--
-- The principal (or a vice principal) records where each room goes for each
-- hazard, with a school-wide default. During a shelter, staff see their
-- room's area on the room card and the room's screen shows it. Changing an
-- area ends the old one, so the history stays.

ALTER TABLE safety_incidents
  ADD COLUMN hazard text CHECK (hazard IS NULL OR hazard IN ('tornado','severe_thunderstorm','lightning','hurricane','flood','winter_storm','extreme_heat','earthquake','hazmat')),
  ADD CONSTRAINT safety_incidents_hazard_kind CHECK (hazard IS NULL OR kind IN ('shelter','hold'));

CREATE TABLE school_shelter_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  room_id uuid,                                   -- NULL: the school-wide default for the hazard
  hazard text NOT NULL CHECK (hazard IN ('tornado','severe_thunderstorm','lightning','hurricane','flood','winter_storm','extreme_heat','earthquake','hazmat')),
  area text NOT NULL CHECK (length(btrim(area)) BETWEEN 2 AND 120),
  route text CHECK (route IS NULL OR length(route) <= 300),
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  ended_by uuid REFERENCES users(id),
  ended_at timestamptz,
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, room_id) REFERENCES classroom_rooms(district_id, id)
);
CREATE UNIQUE INDEX school_shelter_areas_current ON school_shelter_areas(school_id, coalesce(room_id, '00000000-0000-0000-0000-000000000000'::uuid), hazard) WHERE ended_at IS NULL;

ALTER TABLE school_shelter_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_shelter_areas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON school_shelter_areas
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);
-- Everyone who reports or views rooms in an alert reads the school's areas;
-- the principal (a vice principal acts as one) and the superintendent set them.
CREATE FUNCTION eduos_shelter_area_manager(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') = 'superintendent' OR (coalesce(eduos_ctx_role(), '') = 'principal' AND p_school = eduos_ctx_school())
$$;
CREATE POLICY scope_read ON school_shelter_areas AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_safety_room_reporter(school_id) OR eduos_safety_room_viewer(school_id) OR eduos_shelter_area_manager(school_id));
CREATE POLICY scope_insert ON school_shelter_areas AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_shelter_area_manager(school_id) AND set_by = eduos_ctx_user()));
CREATE POLICY scope_update ON school_shelter_areas AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_shelter_area_manager(school_id)) WITH CHECK (eduos_is_table_owner() OR eduos_shelter_area_manager(school_id));

-- A room's area for a hazard, else the school default.
CREATE FUNCTION eduos_shelter_area_for(p_district uuid, p_school uuid, p_room uuid, p_hazard text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.area FROM school_shelter_areas a
   WHERE a.district_id = p_district AND a.school_id = p_school AND a.hazard = p_hazard AND a.ended_at IS NULL
     AND (a.room_id = p_room OR a.room_id IS NULL)
   ORDER BY a.room_id NULLS LAST LIMIT 1
$$;
REVOKE ALL ON FUNCTION eduos_shelter_area_for(uuid, uuid, uuid, text) FROM PUBLIC;

-- Screens show their room's shelter area for the hazard.
CREATE OR REPLACE FUNCTION eduos_classroom_agent_safety(p_device uuid, p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d classroom_devices%ROWTYPE; i safety_incidents%ROWTYPE; clear timestamptz;
BEGIN
  IF p_device IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  SELECT * INTO d FROM classroom_devices WHERE id = p_device AND token_hash = p_token_hash AND status = 'approved';
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- The device's request has no session: read in the device's own district
  -- (safety incidents are tenant-isolated), as the kiosk check-in does (db/111).
  PERFORM set_config('app.district_id', d.district_id::text, true);
  SELECT * INTO i FROM safety_incidents WHERE district_id = d.district_id AND school_id = d.school_id AND status IN ('active','reunification')
   ORDER BY confirmed_at DESC LIMIT 1;
  IF FOUND THEN
    UPDATE classroom_devices SET safety_incident_id = i.id, safety_seen_at = now(), last_seen_at = now() WHERE id = d.id;
    RETURN jsonb_build_object('incident', jsonb_build_object('id', i.id, 'kind', i.kind, 'hazard', i.hazard, 'isDrill', i.is_drill, 'status', i.status,
      'shelterArea', CASE WHEN i.hazard IS NOT NULL THEN eduos_shelter_area_for(d.district_id, d.school_id, d.room_id, i.hazard) END,
      'startedAt', i.confirmed_at, 'reunificationPoint', CASE WHEN i.status = 'reunification' THEN i.reunification_point END), 'deviceKind', d.kind);
  END IF;
  -- An all clear in the last ten minutes, so a device can show it briefly.
  SELECT max(closed_at) INTO clear FROM safety_incidents WHERE district_id = d.district_id AND school_id = d.school_id
    AND status = 'closed' AND closed_at > now() - interval '10 minutes';
  RETURN jsonb_build_object('incident', NULL, 'allClearAt', clear, 'deviceKind', d.kind);
END $$;
REVOKE ALL ON FUNCTION eduos_classroom_agent_safety(uuid, text) FROM PUBLIC;
