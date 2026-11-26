-- Clubs & sports follow-up to db/152 (moved here from an edit to 152, which
-- districts may already have applied).
-- * School nurses may record (and so read) physical clearance dates at their
--   school (t51u).
-- * eduos_guardian_of_member: true when the current parent/guardian is linked
--   to the given pupil user (used by the classroom and club family views).

-- Who may record a learner's physical clearance dates: school lead,
-- athletic director, or school nurse at that school.
CREATE FUNCTION eduos_can_record_physical(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_is_school_lead(p_school) OR eduos_is_athletic_director(p_school)
      OR (eduos_ctx_role()='nurse' AND p_school=eduos_ctx_school())
$$;
REVOKE ALL ON FUNCTION eduos_can_record_physical(uuid) FROM PUBLIC;

-- Who may see a learner's clearance: anyone who can record it, a coach of a
-- team the learner is rostered on, or the learner's own family.
CREATE OR REPLACE FUNCTION eduos_can_read_physical(p_school uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_can_record_physical(p_school) OR eduos_is_linked_student(p_student)
      OR EXISTS(SELECT 1 FROM activity_roster_entries r WHERE r.district_id=eduos_ctx_district() AND r.student_id=p_student
                AND r.status='active' AND eduos_is_activity_staff(r.activity_id, ARRAY['coach']))
$$;
REVOKE ALL ON FUNCTION eduos_can_read_physical(uuid,uuid) FROM PUBLIC;

-- True when the current parent/guardian user is linked to the pupil user.
CREATE FUNCTION eduos_guardian_of_member(p_pupil_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role()='parent' AND EXISTS(
    SELECT 1 FROM student_user_links gp
    JOIN student_user_links kp ON kp.student_id=gp.student_id AND kp.district_id=gp.district_id
    WHERE gp.district_id=eduos_ctx_district() AND gp.user_id=eduos_ctx_user()
      AND gp.relationship IN ('parent','guardian') AND gp.status='active'
      AND kp.user_id=p_pupil_user AND kp.relationship='pupil' AND kp.status='active')
$$;
REVOKE ALL ON FUNCTION eduos_guardian_of_member(uuid) FROM PUBLIC;

DROP POLICY physical_insert ON student_physical_clearances;
CREATE POLICY physical_insert ON student_physical_clearances AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_can_record_physical(school_id));
