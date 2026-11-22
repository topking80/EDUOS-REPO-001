-- 099 (LTI-04): LTI Assignment and Grade Services 2.0 (grade passback).
--
-- Accountability (district sets guidelines, schools are accountable, the
-- district keeps oversight):
--   * lti_grade_policy: the district turns grade passback on at all, and
--     decides whether a teacher must review each score before it counts.
--   * lti_school_grade_approvals: a school's principal approves a tool for
--     their school (and can revoke it). District leads see every school and can
--     revoke any approval, but don't approve for a school.
--   * lti_content_links.grades_enabled_*: a teacher turns grades on for one
--     placed activity, only while all of the above hold.
-- Tool scores are kept apart (lti_scores, lti_score_events) and reach the
-- gradebook only as source 'lti': never over a grade a teacher entered.

CREATE TABLE lti_grade_policy (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  enabled boolean NOT NULL DEFAULT false,
  teacher_review_required boolean NOT NULL DEFAULT true,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lti_school_grade_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  app_id uuid NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, app_id) REFERENCES apps(district_id, id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX lti_school_grade_approvals_active ON lti_school_grade_approvals(district_id, school_id, app_id) WHERE revoked_at IS NULL;

ALTER TABLE lti_content_links
  ADD COLUMN grades_enabled_by uuid REFERENCES users(id),
  ADD COLUMN grades_enabled_at timestamptz,
  ADD CONSTRAINT lti_content_links_grades_consistency CHECK ((grades_enabled_by IS NULL) = (grades_enabled_at IS NULL));

CREATE POLICY manage_assignment_update ON lti_content_links AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_can_manage_assignment(assignment_id))
  WITH CHECK (eduos_is_table_owner() OR eduos_can_manage_assignment(assignment_id));

-- Where a gradebook score came from: a teacher, or a tool through AGS.
ALTER TABLE assignment_submissions
  ADD COLUMN grade_source text CHECK (grade_source IS NULL OR grade_source IN ('teacher','lti'));
UPDATE assignment_submissions SET grade_source = 'teacher' WHERE graded_at IS NOT NULL;

-- Latest score per activity and student, and every score the tool sent.
CREATE TABLE lti_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  content_link_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  score_given numeric(9,3) CHECK (score_given IS NULL OR score_given >= 0),
  score_maximum numeric(9,3) CHECK (score_maximum IS NULL OR score_maximum > 0),
  activity_progress text NOT NULL,
  grading_progress text NOT NULL,
  comment text CHECK (comment IS NULL OR length(comment) <= 1000),
  tool_timestamp timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','recorded','dismissed','not_final')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, content_link_id) REFERENCES lti_content_links(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, assignment_id) REFERENCES assignments(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  UNIQUE (district_id, content_link_id, student_id)
);
CREATE TABLE lti_score_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  content_link_id uuid NOT NULL,
  student_id uuid NOT NULL,
  app_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 4096),
  outcome text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lti_score_events_link ON lti_score_events(district_id, content_link_id, received_at DESC);

ALTER TABLE lti_service_access_log DROP CONSTRAINT lti_service_access_log_service_check;
ALTER TABLE lti_service_access_log ADD CONSTRAINT lti_service_access_log_service_check
  CHECK (service IN ('token','nrps_memberships','ags_lineitem','ags_score'));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['lti_grade_policy','lti_school_grade_approvals','lti_scores','lti_score_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'',true),'''')::uuid) WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'',true),'''')::uuid)', t);
  END LOOP;
END $$;
-- The policy: district roles change it; anyone in the district can read it.
CREATE POLICY district_writes ON lti_grade_policy AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_is_district_role());
CREATE POLICY district_updates ON lti_grade_policy AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_district_role());
-- School approvals: a principal approves only for their own school; a
-- principal (own school) or district lead (oversight) revokes.
CREATE POLICY principal_approves ON lti_school_grade_approvals AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (current_setting('app.role', true) = 'principal'
    AND school_id = nullif(current_setting('app.school_id', true), '')::uuid
    AND approved_by = nullif(current_setting('app.user_id', true), '')::uuid));
CREATE POLICY school_or_district_revokes ON lti_school_grade_approvals AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_district_role() OR (current_setting('app.role', true) = 'principal'
    AND school_id = nullif(current_setting('app.school_id', true), '')::uuid));
-- Scores: the teachers who manage the assignment (and district/school leads by
-- that rule) read and review them; tools write only through eduos_lti_record_score.
CREATE POLICY manage_assignment ON lti_scores AS RESTRICTIVE
  USING (eduos_is_table_owner() OR eduos_can_manage_assignment(assignment_id));
CREATE POLICY manage_assignment ON lti_score_events AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_district_role() OR EXISTS (SELECT 1 FROM lti_content_links l
    WHERE l.id = content_link_id AND eduos_can_manage_assignment(l.assignment_id)));

-- Everything a grade service call needs about one placed activity, in the
-- caller's district, only while grade passback is allowed end to end.
CREATE FUNCTION eduos_lti_ags_link(p_link uuid, p_app uuid)
RETURNS TABLE(assignment_id uuid, title text, points numeric, school_id uuid, course_id uuid, review_required boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.id, l.title, x.points_possible, x.school_id, x.course_id, p.teacher_review_required
    FROM lti_content_links l
    JOIN assignments x ON x.id = l.assignment_id AND x.district_id = l.district_id
    JOIN lti_grade_policy p ON p.district_id = l.district_id AND p.enabled
   WHERE l.id = p_link AND l.app_id = p_app AND l.grades_enabled_at IS NOT NULL
     AND l.district_id = nullif(current_setting('app.district_id', true), '')::uuid
     AND x.status IN ('published','closed')
     AND EXISTS (SELECT 1 FROM lti_school_grade_approvals g WHERE g.district_id = l.district_id
                  AND g.school_id = x.school_id AND g.app_id = l.app_id AND g.revoked_at IS NULL)
$$;

-- Learners a tool may score on an activity: pupils with active accounts who
-- can see the assignment (enrolled in its course, or at its school when it has
-- no course). The caller matches the tool's per-tool user id to one of them.
CREATE FUNCTION eduos_lti_ags_learners(p_link uuid, p_app uuid)
RETURNS TABLE(user_id uuid, student_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.id, s.id
    FROM eduos_lti_ags_link(p_link, p_app) a
    JOIN students s ON s.district_id = nullif(current_setting('app.district_id', true), '')::uuid
    JOIN student_user_links ul ON ul.student_id = s.id AND ul.relationship = 'pupil' AND ul.status = 'active'
    JOIN users u ON u.id = ul.user_id AND u.status = 'active'
    JOIN memberships m ON m.user_id = u.id AND m.district_id = s.district_id AND m.role = 'pupil' AND m.status = 'active'
   WHERE (a.course_id IS NOT NULL AND EXISTS (SELECT 1 FROM course_enrollments e WHERE e.course_id = a.course_id AND e.student_id = s.id AND e.status = 'active'))
      OR (a.course_id IS NULL AND s.school_id = a.school_id)
$$;

-- Record one score from the tool (AGS score service). Ignores scores older
-- than the latest one; records into the gradebook only when the district lets
-- scores count without review, the score is final, and no teacher grade exists.
CREATE FUNCTION eduos_lti_record_score(p_link uuid, p_app uuid, p_student uuid, p_given numeric, p_max numeric,
  p_activity text, p_grading text, p_comment text, p_timestamp timestamptz, p_payload jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid;
        a record; prev record; final boolean; outcome text; st text;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'LTI service tenant context required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO a FROM eduos_lti_ags_link(p_link, p_app);
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM eduos_lti_ags_learners(p_link, p_app) x WHERE x.student_id = p_student) THEN RETURN 'not_found'; END IF;
  SELECT * INTO prev FROM lti_scores WHERE district_id = d AND content_link_id = p_link AND student_id = p_student;
  IF FOUND AND prev.tool_timestamp >= p_timestamp THEN
    INSERT INTO lti_score_events(district_id, content_link_id, student_id, app_id, payload, outcome) VALUES (d, p_link, p_student, p_app, p_payload, 'stale_ignored');
    RETURN 'stale_ignored';
  END IF;
  final := p_grading = 'FullyGraded' AND p_given IS NOT NULL AND p_max IS NOT NULL;
  st := CASE WHEN NOT final THEN 'not_final' ELSE 'pending' END;
  IF final AND NOT a.review_required THEN
    -- Counts without review, but never over a grade a teacher entered.
    IF EXISTS (SELECT 1 FROM assignment_submissions s WHERE s.assignment_id = a.assignment_id AND s.student_id = p_student
                AND s.graded_at IS NOT NULL AND s.grade_source IS DISTINCT FROM 'lti') THEN
      st := 'pending';
    ELSE
      INSERT INTO assignment_submissions(district_id, assignment_id, student_id, score, points_earned, graded_at, grade_source)
      VALUES (d, a.assignment_id, p_student, round(least(p_given / p_max, 1) * 100, 2), round(least(p_given / p_max, 1) * a.points, 2), now(), 'lti')
      ON CONFLICT (assignment_id, student_id) DO UPDATE SET score = EXCLUDED.score, points_earned = EXCLUDED.points_earned,
        graded_at = now(), graded_by = NULL, grade_source = 'lti';
      st := 'recorded';
    END IF;
  END IF;
  INSERT INTO lti_scores(district_id, content_link_id, assignment_id, student_id, score_given, score_maximum, activity_progress, grading_progress, comment, tool_timestamp, status, updated_at)
  VALUES (d, p_link, a.assignment_id, p_student, p_given, p_max, p_activity, p_grading, p_comment, p_timestamp, st, now())
  ON CONFLICT (district_id, content_link_id, student_id) DO UPDATE SET score_given = EXCLUDED.score_given, score_maximum = EXCLUDED.score_maximum,
    activity_progress = EXCLUDED.activity_progress, grading_progress = EXCLUDED.grading_progress, comment = EXCLUDED.comment,
    tool_timestamp = EXCLUDED.tool_timestamp, status = EXCLUDED.status, reviewed_by = NULL, reviewed_at = NULL, updated_at = now();
  INSERT INTO lti_score_events(district_id, content_link_id, student_id, app_id, payload, outcome) VALUES (d, p_link, p_student, p_app, p_payload, st);
  RETURN st;
END;
$$;
REVOKE ALL ON FUNCTION eduos_lti_ags_link(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_lti_ags_learners(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_lti_record_score(uuid, uuid, uuid, numeric, numeric, text, text, text, timestamptz, jsonb) FROM PUBLIC;
