-- A teacher can grade work without returning it yet (returnToStudent: false on
-- POST /api/learning/assignments/:id/grade). Until now learner and family views
-- showed that grade and feedback anyway. held_at marks a grade the teacher is
-- holding back; learners and families don't see its score, feedback or rubric
-- until POST /api/learning/assignments/:id/return releases it, and its rubric
-- evidence reaches standards mastery only then.
--
-- Existing rows are left visible (held_at NULL): nothing recorded which older
-- grades were held, and they have been visible all along.
ALTER TABLE assignment_submissions ADD COLUMN held_at timestamptz;
ALTER TABLE assignment_submissions ADD CONSTRAINT assignment_submissions_held_graded CHECK (held_at IS NULL OR graded_at IS NOT NULL);

-- Learners and families never set or clear a hold (extends the 173 guard).
CREATE OR REPLACE FUNCTION eduos_submission_learner_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF eduos_owner_session() OR coalesce(eduos_ctx_role(), '') NOT IN ('pupil', 'parent') THEN RETURN NEW; END IF;
  IF NEW.graded_at IS NOT NULL OR NEW.graded_by IS NOT NULL OR NEW.score IS NOT NULL OR NEW.feedback IS NOT NULL
     OR NEW.returned_at IS NOT NULL OR (TG_OP = 'INSERT' AND (NEW.points_earned IS NOT NULL OR NEW.rubric_scores IS NOT NULL OR NEW.held_at IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND (NEW.points_earned IS DISTINCT FROM OLD.points_earned OR NEW.rubric_scores IS DISTINCT FROM OLD.rubric_scores
         OR NEW.grade_source IS DISTINCT FROM OLD.grade_source OR (NEW.held_at IS DISTINCT FROM OLD.held_at AND NEW.held_at IS NOT NULL))) THEN
    RAISE EXCEPTION 'learners and families cannot grade work' USING ERRCODE = '42501';
  END IF;
  -- Resubmitting clears the grade, so it clears any hold with it.
  IF TG_OP = 'UPDATE' AND NEW.graded_at IS NULL THEN NEW.held_at := NULL; END IF;
  RETURN NEW;
END $$;
