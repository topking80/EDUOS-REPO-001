-- A vice principal's Transport tab: their school's bus runs (release gate,
-- 2026-11-16 audit). The role holds transport:read, but the row policies named
-- only principals, teachers and drivers, so the leader view came back empty.
-- Read-only: the vice principal reads their own school's routes, stops, runs,
-- rider assignments and check-ins; nothing else changes (inserts and updates
-- stay with the principal, the superintendent and the run's driver).
CREATE OR REPLACE FUNCTION eduos_transport_staff(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_is_table_owner() OR eduos_ctx_role()='superintendent'
      OR (eduos_ctx_role() IN ('principal','vice_principal','teacher','driver') AND p_school=eduos_ctx_school())
$$;

DROP POLICY scope_read ON transport_rider_assignments;
CREATE POLICY scope_read ON transport_rider_assignments AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_staff_can_see_student(school_id, student_id)
         OR (eduos_ctx_role()='vice_principal' AND school_id=eduos_ctx_school())
         OR (eduos_ctx_role()='driver' AND school_id=eduos_ctx_school() AND eduos_drives_route(route_id))
         OR eduos_is_linked_student(student_id));

DROP POLICY scope_read ON transport_checkins;
CREATE POLICY scope_read ON transport_checkins AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_staff_can_see_student(school_id, student_id)
         OR (eduos_ctx_role()='vice_principal' AND school_id=eduos_ctx_school())
         OR eduos_drives_run(run_id) OR eduos_is_linked_student(student_id));
