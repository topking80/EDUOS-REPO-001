-- SEC-01 part 5 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §5.1): the tables
-- that say who belongs to a student. student_user_links (which accounts are a
-- student's family or the student) and teacher_student_rosters (which teacher
-- has which student) had only district isolation, so any pupil or parent could
-- list every family and every class in the district.
--
-- Pupils and parents now see only:
--   their own links (any status, so a revoked guardian still sees why), and
--   the links and roster rows of the students they're actively linked to
--   (co-guardians for pick-up, their child's teachers).
-- Staff and system roles keep district-wide reads, as for students (db/179);
-- narrowing staff is SEC-08. The helpers that other policies call
-- (eduos_is_linked_student, eduos_on_my_roster, ...) are definers and are
-- unaffected; policies that read these tables as the caller only ever look at
-- the caller's own rows or their own students' rows, which stay visible.
-- Context checks are (SELECT ...) InitPlans so whole-school queries stay fast.
CREATE POLICY link_read ON student_user_links AS RESTRICTIVE FOR SELECT
  USING (CASE
    WHEN (SELECT eduos_is_table_owner()) THEN true
    WHEN (SELECT eduos_ctx_role()) IN ('pupil', 'parent') THEN user_id = (SELECT eduos_ctx_user()) OR eduos_is_linked_student(student_id)
    ELSE true END);
CREATE POLICY roster_read ON teacher_student_rosters AS RESTRICTIVE FOR SELECT
  USING (CASE
    WHEN (SELECT eduos_is_table_owner()) THEN true
    WHEN (SELECT eduos_ctx_role()) IN ('pupil', 'parent') THEN eduos_is_linked_student(student_id)
    ELSE true END);

-- Families never write rosters; a family's only write to links is accepting an
-- invitation, which creates their own link (src/server.js guardian accept).
CREATE POLICY roster_write ON teacher_student_rosters AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent'));
CREATE POLICY roster_update ON teacher_student_rosters AS RESTRICTIVE FOR UPDATE
  USING ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent'));
CREATE POLICY link_write ON student_user_links AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent')
    OR ((SELECT eduos_ctx_role()) = 'parent' AND user_id = (SELECT eduos_ctx_user()) AND relationship IN ('parent', 'guardian')));
CREATE POLICY link_update ON student_user_links AS RESTRICTIVE FOR UPDATE
  USING ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent')
    OR ((SELECT eduos_ctx_role()) = 'parent' AND user_id = (SELECT eduos_ctx_user())))
  WITH CHECK ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent')
    OR ((SELECT eduos_ctx_role()) = 'parent' AND user_id = (SELECT eduos_ctx_user()) AND relationship IN ('parent', 'guardian')));
