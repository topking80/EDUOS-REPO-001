-- SEC-01 part 3 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §5.1): attendance
-- gets per-student row security. attendance_events had only district
-- isolation since db/001. It has no school column, so the student's current
-- school decides. Matching the routes that read or write it (home, teacher
-- dashboard, student 360, family summary, acknowledge, room roll, arrival
-- and its exceptions, the operations brief, SIS import, records export):
--
--   read:   superintendent and district IT, district-wide;
--           principal (and vice principal), teacher and librarian at the student's school;
--           a bus driver, for students assigned to one of their routes (the arrival list shows
--             only whether attendance is recorded);
--           the student and their parents or guardians.
--   write:  superintendent and district IT (SIS import), principal and teacher at the student's
--           school (marking, arrival handoffs); a parent may only acknowledge their own child's
--           marks (family_acknowledged_*), which a trigger enforces.
--   delete: the owner only (records deletion runs as a definer).

CREATE FUNCTION eduos_can_see_attendance(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_owner_session()
    OR eduos_ctx_role() IN ('superintendent', 'it_admin')
    OR (eduos_ctx_role() IN ('principal', 'teacher', 'librarian') AND EXISTS (
          SELECT 1 FROM students s WHERE s.id = p_student AND s.district_id = eduos_ctx_district() AND s.school_id = eduos_ctx_school()))
    OR (eduos_ctx_role() = 'driver' AND EXISTS (
          SELECT 1 FROM transport_rider_assignments ra JOIN transport_routes r ON r.id = ra.route_id AND r.district_id = ra.district_id
           WHERE ra.student_id = p_student AND ra.district_id = eduos_ctx_district() AND r.driver_user_id = eduos_ctx_user()))
    OR (eduos_ctx_role() IN ('pupil', 'parent') AND eduos_is_linked_student(p_student))
$$;
CREATE FUNCTION eduos_can_write_attendance(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_owner_session()
    OR eduos_ctx_role() IN ('superintendent', 'it_admin')
    OR (eduos_ctx_role() IN ('principal', 'teacher') AND EXISTS (
          SELECT 1 FROM students s WHERE s.id = p_student AND s.district_id = eduos_ctx_district() AND s.school_id = eduos_ctx_school()))
$$;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION eduos_can_see_attendance(uuid), eduos_can_write_attendance(uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN
    GRANT EXECUTE ON FUNCTION eduos_can_see_attendance(uuid), eduos_can_write_attendance(uuid) TO eduos_app;
  END IF;
END $$;

-- The read policy is written inline (a CASE on the role with uncorrelated
-- subqueries) rather than as a call per row, so a whole school day stays fast:
-- each subquery runs once (test/integration/performance.test.js). It says the
-- same as eduos_can_see_attendance, which the tests compare it with.
CREATE POLICY attendance_read ON attendance_events AS RESTRICTIVE FOR SELECT
  USING (CASE
    WHEN eduos_is_table_owner() THEN true
    WHEN eduos_ctx_role() IN ('superintendent', 'it_admin') THEN true
    WHEN eduos_ctx_role() IN ('principal', 'teacher', 'librarian') THEN
      student_id IN (SELECT s.id FROM students s WHERE s.district_id = eduos_ctx_district() AND s.school_id = eduos_ctx_school())
    WHEN eduos_ctx_role() = 'driver' THEN
      student_id IN (SELECT ra.student_id FROM transport_rider_assignments ra JOIN transport_routes r ON r.id = ra.route_id AND r.district_id = ra.district_id
                      WHERE ra.district_id = eduos_ctx_district() AND r.driver_user_id = eduos_ctx_user())
    WHEN eduos_ctx_role() IN ('pupil', 'parent') THEN eduos_is_linked_student(student_id)
    ELSE false END);
CREATE POLICY attendance_insert ON attendance_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_can_write_attendance(student_id));
CREATE POLICY attendance_update ON attendance_events AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_can_write_attendance(student_id) OR (eduos_ctx_role() = 'parent' AND eduos_is_linked_student(student_id)))
  WITH CHECK (eduos_is_table_owner() OR eduos_can_write_attendance(student_id) OR (eduos_ctx_role() = 'parent' AND eduos_is_linked_student(student_id)));
CREATE POLICY attendance_delete ON attendance_events AS RESTRICTIVE FOR DELETE USING (eduos_is_table_owner());

-- A parent only acknowledges, as themselves; nothing else about the mark changes.
CREATE FUNCTION eduos_attendance_family_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF eduos_owner_session() OR coalesce(eduos_ctx_role(), '') <> 'parent' THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - 'family_acknowledged_at' - 'family_acknowledged_by') IS DISTINCT FROM (to_jsonb(OLD) - 'family_acknowledged_at' - 'family_acknowledged_by')
     OR NEW.family_acknowledged_by IS DISTINCT FROM eduos_ctx_user() OR NEW.family_acknowledged_at IS NULL THEN
    RAISE EXCEPTION 'families can only acknowledge attendance, as themselves' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eduos_attendance_family_guard() FROM PUBLIC;
CREATE TRIGGER attendance_events_family_guard BEFORE UPDATE ON attendance_events FOR EACH ROW EXECUTE FUNCTION eduos_attendance_family_guard();
