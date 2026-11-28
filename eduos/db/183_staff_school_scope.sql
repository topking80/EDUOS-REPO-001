-- SEC-08 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §6), part 1: staff read
-- students at their own school, not the whole district (db/179 kept them
-- district-wide). District roles and services keep the district:
--   superintendent, district IT, the EDEN hub, the SIS scheduler, and internal
--   jobs that set only a district (no role), such as the integration scheduler
--   (src/integrations/scheduler.js). Every HTTP request carries a role.
-- A bus driver sees students on their routes; pupils and families see their
-- own; every other staff or school system role sees its school.
-- Definers run as the owner and are unaffected.
ALTER POLICY student_read ON students
  USING (CASE
    WHEN (SELECT eduos_is_table_owner()) THEN true
    WHEN coalesce((SELECT eduos_ctx_role()), '') IN ('', 'superintendent', 'it_admin', 'eden_hub', 'sis_scheduler') THEN true
    WHEN (SELECT eduos_ctx_role()) IN ('pupil', 'parent') THEN eduos_is_linked_student(id)
    WHEN (SELECT eduos_ctx_role()) = 'driver' THEN
      id IN (SELECT ra.student_id FROM transport_rider_assignments ra JOIN transport_routes r ON r.id = ra.route_id AND r.district_id = ra.district_id
              WHERE ra.district_id = (SELECT eduos_ctx_district()) AND r.driver_user_id = (SELECT eduos_ctx_user()))
    ELSE school_id = (SELECT eduos_ctx_school()) END);
