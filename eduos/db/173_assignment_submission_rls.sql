-- Student work and grades get the same row security as the tables beside them.
--
-- assignment_submissions (a learner's response, score, rubric scores and teacher
-- feedback) has had only district isolation since migration 002, while
-- quiz_attempts, course_final_grades and standard_mastery restrict each row to
-- the learner, their family and the staff who teach or lead at their school.
-- The routes already filtered by learner; the database now backs that up.
--
-- Who sees a submission row:
--   the learner (an active pupil link) and their parents or guardians;
--   staff who can manage the assignment (its teacher or course teacher, the
--   school's principal or vice principal, the superintendent);
--   staff who teach the learner at the assignment's school (eduos_learning_staff).
-- Who writes one: the same people except parents. Learners can only submit or
-- resubmit; a trigger refuses a learner or parent write that carries a grade.
-- Deletion stays with the owner (records deletion runs as a definer function).

CREATE FUNCTION eduos_can_see_submission(p_assignment uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_owner_session() OR eduos_is_linked_student(p_student) OR eduos_can_manage_assignment(p_assignment)
    OR EXISTS (SELECT 1 FROM assignments a WHERE a.id = p_assignment AND a.district_id = eduos_ctx_district() AND eduos_learning_staff(a.school_id, p_student))
$$;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION eduos_can_see_submission(uuid, uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN GRANT EXECUTE ON FUNCTION eduos_can_see_submission(uuid, uuid) TO eduos_app; END IF;
END $$;

CREATE POLICY scope_read ON assignment_submissions AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_see_submission(assignment_id, student_id));
CREATE POLICY scope_insert ON assignment_submissions AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() <> 'parent' AND eduos_can_see_submission(assignment_id, student_id)));
CREATE POLICY scope_update ON assignment_submissions AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR (eduos_ctx_role() <> 'parent' AND eduos_can_see_submission(assignment_id, student_id)))
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() <> 'parent' AND eduos_can_see_submission(assignment_id, student_id)));
CREATE POLICY scope_delete ON assignment_submissions AS RESTRICTIVE FOR DELETE USING (eduos_is_table_owner());

-- A learner submits or resubmits; only staff (or a definer such as tool score
-- passback) put a grade on the row.
CREATE FUNCTION eduos_submission_learner_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF eduos_owner_session() OR coalesce(eduos_ctx_role(), '') NOT IN ('pupil', 'parent') THEN RETURN NEW; END IF;
  IF NEW.graded_at IS NOT NULL OR NEW.graded_by IS NOT NULL OR NEW.score IS NOT NULL OR NEW.feedback IS NOT NULL
     OR NEW.returned_at IS NOT NULL OR (TG_OP = 'INSERT' AND (NEW.points_earned IS NOT NULL OR NEW.rubric_scores IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND (NEW.points_earned IS DISTINCT FROM OLD.points_earned OR NEW.rubric_scores IS DISTINCT FROM OLD.rubric_scores OR NEW.grade_source IS DISTINCT FROM OLD.grade_source)) THEN
    RAISE EXCEPTION 'learners and families cannot grade work' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eduos_submission_learner_guard() FROM PUBLIC;
CREATE TRIGGER assignment_submissions_learner_guard BEFORE INSERT OR UPDATE ON assignment_submissions
  FOR EACH ROW EXECUTE FUNCTION eduos_submission_learner_guard();
