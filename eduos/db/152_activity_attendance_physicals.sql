-- Clubs & sports operations: attendance at an activity's meetings, practices
-- and games, and the athletic physical clearance on file for each learner.
-- Numbered 152: 138 is on main, 139-140 are on tc/12/tc/13, 150-151 are used.
--
-- Promises kept here: attendance is taken by the activity's staff (or the
-- school lead / athletic director) for learners who are actually on that
-- activity; a physical clearance holds only dates (cleared on / expires on),
-- never medical details, and is recorded by the school lead or the athletic
-- director. Clearance rows are append-only; the latest one is the answer.

CREATE TABLE activity_event_attendance (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 activity_id uuid NOT NULL REFERENCES school_activities(id) ON DELETE CASCADE,
 event_id uuid NOT NULL REFERENCES school_events(id) ON DELETE CASCADE,
 student_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('present','late','excused','absent')),
 marked_by uuid NOT NULL REFERENCES users(id),
 marked_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id) ON DELETE CASCADE,
 UNIQUE(district_id,event_id,student_id)
);
CREATE INDEX activity_event_attendance_activity ON activity_event_attendance(district_id,activity_id,event_id);
CREATE INDEX activity_event_attendance_student ON activity_event_attendance(district_id,student_id);

CREATE FUNCTION eduos_activity_attendance_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_events e JOIN school_activities a ON a.id=e.activity_id AND a.district_id=e.district_id
                 WHERE e.id=NEW.event_id AND e.district_id=NEW.district_id AND e.activity_id=NEW.activity_id AND a.school_id=NEW.school_id) THEN
    RAISE EXCEPTION 'event is not on this activity' USING ERRCODE='23503';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM activity_roster_entries r WHERE r.district_id=NEW.district_id AND r.activity_id=NEW.activity_id
                   AND r.student_id=NEW.student_id AND r.status='active')
     AND NOT EXISTS (SELECT 1 FROM activity_memberships m JOIN student_user_links l ON l.user_id=m.user_id AND l.district_id=m.district_id
                   AND l.relationship='pupil' AND l.status='active'
                   WHERE m.district_id=NEW.district_id AND m.activity_id=NEW.activity_id AND m.status='active' AND l.student_id=NEW.student_id) THEN
    RAISE EXCEPTION 'learner is not on this activity' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION eduos_activity_attendance_bind() FROM PUBLIC;
CREATE TRIGGER activity_event_attendance_bind BEFORE INSERT OR UPDATE ON activity_event_attendance
  FOR EACH ROW EXECUTE FUNCTION eduos_activity_attendance_bind();

CREATE TABLE student_physical_clearances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 student_id uuid NOT NULL,
 cleared_on date NOT NULL,
 expires_on date NOT NULL,
 recorded_by uuid NOT NULL REFERENCES users(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id) ON DELETE CASCADE,
 CHECK(expires_on > cleared_on AND expires_on <= cleared_on + 800)
);
CREATE INDEX student_physical_clearances_latest ON student_physical_clearances(district_id,student_id,recorded_at DESC);
CREATE TRIGGER student_physical_clearances_append_only BEFORE UPDATE OR DELETE ON student_physical_clearances
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Who may see a learner's clearance: the school lead, the athletic director,
-- a coach of a team the learner is rostered on, or the learner's own family.
CREATE FUNCTION eduos_can_read_physical(p_school uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_is_school_lead(p_school) OR eduos_is_athletic_director(p_school) OR eduos_is_linked_student(p_student)
      OR EXISTS(SELECT 1 FROM activity_roster_entries r WHERE r.district_id=eduos_ctx_district() AND r.student_id=p_student
                AND r.status='active' AND eduos_is_activity_staff(r.activity_id, ARRAY['coach']))
$$;
REVOKE ALL ON FUNCTION eduos_can_read_physical(uuid,uuid) FROM PUBLIC;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['activity_event_attendance','student_physical_clearances'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON %I
      USING (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid
       AND (school_id=nullif(current_setting(''app.school_id'',true),'''')::uuid OR current_setting(''app.role'',true) IN (''superintendent'',''it_admin'') OR eduos_is_table_owner()))
      WITH CHECK (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid
       AND (school_id=nullif(current_setting(''app.school_id'',true),'''')::uuid OR current_setting(''app.role'',true) IN (''superintendent'',''it_admin'') OR eduos_is_table_owner()))',
   t||'_tenant_scope',t);
 END LOOP;
END $$;
CREATE POLICY attendance_read ON activity_event_attendance AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_read_roster(activity_id, school_id, student_id));
CREATE POLICY attendance_insert ON activity_event_attendance AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_can_manage_roster(activity_id, school_id));
CREATE POLICY attendance_update ON activity_event_attendance AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_can_manage_roster(activity_id, school_id));
CREATE POLICY physical_read ON student_physical_clearances AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_read_physical(school_id, student_id));
CREATE POLICY physical_insert ON student_physical_clearances AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_is_school_lead(school_id) OR eduos_is_athletic_director(school_id));
