-- SAFE-01: room status during an emergency.
--
-- During a lockdown (or shelter, hold, evacuation) each adult in a room tells
-- the office where they are and how it stands: secured, not secured, needs
-- help (medical, a threat seen or heard, a missing student, other), or moved
-- out. School leads and the school's resource officers see a board of every
-- room; "needs help" alerts them at once.
--
-- Reports are about rooms, not students: a count of students and adults, and
-- a short note. Nobody's location is tracked; a person names the room or
-- the place they're in (place: free text such as "Gym").
--
-- Staff who aren't teachers (librarian, counselor, nurse, coach, maintenance,
-- lunch staff) are in rooms too: they can report, but only at their own
-- school and only while an incident there is live.

CREATE TABLE safety_room_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  room_id uuid,
  place text CHECK (place IS NULL OR length(btrim(place)) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN ('secured','not_secured','needs_help','moved')),
  need text CHECK (need IS NULL OR need IN ('medical','threat','missing_student','other')),
  students integer CHECK (students IS NULL OR students BETWEEN 0 AND 500),
  adults integer CHECK (adults IS NULL OR adults BETWEEN 0 AND 50),
  note text CHECK (note IS NULL OR length(note) <= 200),
  reported_by uuid NOT NULL REFERENCES users(id),
  reporter_role text NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  observed_at timestamptz,
  queued boolean NOT NULL DEFAULT false,
  CHECK (room_id IS NOT NULL OR place IS NOT NULL),
  CHECK ((status = 'needs_help') = (need IS NOT NULL)),
  FOREIGN KEY (district_id, incident_id) REFERENCES safety_incidents(district_id, id),
  FOREIGN KEY (district_id, room_id) REFERENCES classroom_rooms(district_id, id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE INDEX safety_room_reports_incident ON safety_room_reports(incident_id, reported_at DESC);
CREATE TRIGGER safety_room_reports_append_only BEFORE UPDATE OR DELETE ON safety_room_reports
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- The room and the incident must both be at the report's school.
CREATE FUNCTION eduos_safety_room_report_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM safety_incidents i WHERE i.id = NEW.incident_id AND i.district_id = NEW.district_id AND i.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'incident is not at this school' USING ERRCODE = '23514';
  END IF;
  IF NEW.room_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM classroom_rooms r WHERE r.id = NEW.room_id AND r.district_id = NEW.district_id
      AND r.school_id = NEW.school_id AND r.archived_at IS NULL) THEN
    RAISE EXCEPTION 'room is not at this school' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER safety_room_reports_guard BEFORE INSERT ON safety_room_reports
  FOR EACH ROW EXECUTE FUNCTION eduos_safety_room_report_guard();

ALTER TABLE safety_room_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety_room_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON safety_room_reports
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);

-- Adults who may report a room: staff at that school.
CREATE FUNCTION eduos_safety_room_reporter(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') IN ('teacher','principal','vice_principal','sro','librarian','counselor','nurse','coach','maintenance','lunch_staff')
     AND p_school = eduos_ctx_school()
$$;
-- Who sees the room board: the superintendent, and the school's principal,
-- vice principals and resource officers.
CREATE FUNCTION eduos_safety_room_viewer(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') = 'superintendent'
      OR (coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal','sro') AND p_school = eduos_ctx_school())
$$;

CREATE POLICY scope_read ON safety_room_reports AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_safety_room_viewer(school_id) OR reported_by = eduos_ctx_user());
CREATE POLICY scope_insert ON safety_room_reports AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (reported_by = eduos_ctx_user() AND reporter_role = eduos_ctx_role()
    AND eduos_safety_room_reporter(school_id) AND eduos_safety_live(incident_id)));

-- The rooms at an incident's school, for anyone who may report or view there.
-- (Room records are otherwise readable only by teachers and leads.)
CREATE FUNCTION eduos_safety_school_rooms(p_incident uuid)
RETURNS TABLE(id uuid, name text, building text, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.name, r.building, r.kind FROM safety_incidents i JOIN classroom_rooms r ON r.school_id = i.school_id AND r.district_id = i.district_id
   WHERE i.id = p_incident AND i.district_id = eduos_ctx_district() AND r.archived_at IS NULL
     AND (eduos_safety_room_reporter(i.school_id) OR eduos_safety_room_viewer(i.school_id))
   ORDER BY r.building NULLS FIRST, r.name
$$;

-- The room the caller is timetabled in right now (school time zone), if any.
CREATE FUNCTION eduos_safety_my_room_now() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH z AS (SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = s.timezone) THEN s.timezone ELSE 'UTC' END AS tz
               FROM schools s WHERE s.id = eduos_ctx_school()),
       l AS (SELECT now() AT TIME ZONE z.tz AS ln FROM z)
  SELECT t.room_id FROM classroom_room_teachers t, l
   WHERE t.teacher_user_id = eduos_ctx_user() AND t.school_id = eduos_ctx_school() AND t.district_id = eduos_ctx_district()
     AND t.ended_at IS NULL AND extract(isodow FROM l.ln)::smallint = ANY (t.weekdays) AND l.ln::time BETWEEN t.starts AND t.ends
   ORDER BY t.starts LIMIT 1
$$;

-- Who is alerted when a room needs help: the school's principal, vice
-- principals and resource officers. Only a reporter at that school may ask.
CREATE FUNCTION eduos_safety_room_alert_recipients(p_incident uuid) RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT m.user_id FROM safety_incidents i JOIN memberships m ON m.school_id = i.school_id AND m.district_id = i.district_id
   WHERE i.id = p_incident AND i.district_id = eduos_ctx_district() AND eduos_safety_room_reporter(i.school_id)
     AND m.role IN ('principal','vice_principal','sro') AND m.status = 'active'
$$;
