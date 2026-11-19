-- 37.10.1: district-scoped Timeline authorization foundation (migration 083).
-- This migration deliberately exposes no API and creates no capsule worker.
-- Entries begin as immutable drafts; later runtime work must add audited
-- revision/publish transitions rather than granting general UPDATE/DELETE.

CREATE TABLE timeline_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  course_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  entry_type text NOT NULL CHECK(entry_type IN
    ('achievement','project','coursework','reflection','event','portfolio_artifact','educator_note','system_milestone')),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 160),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 12000),
  visibility text NOT NULL CHECK(visibility IN ('private','family','educators','classroom','school')),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,course_id) REFERENCES courses(district_id,id),
  CHECK((visibility='classroom') = (course_id IS NOT NULL))
);

CREATE INDEX timeline_entries_student_time
  ON timeline_entries(district_id,school_id,student_id,occurred_at DESC,id DESC);
CREATE INDEX timeline_entries_course_time
  ON timeline_entries(district_id,course_id,occurred_at DESC,id DESC)
  WHERE course_id IS NOT NULL;

-- SECURITY DEFINER is required to inspect relationship, roster and enrollment
-- tables whose RLS is independently enforced. The function uses only the
-- transaction-local actor context; no actor identity is accepted from callers.
CREATE FUNCTION eduos_timeline_can_read(
  p_district uuid, p_school uuid, p_student uuid, p_author uuid,
  p_visibility text, p_status text, p_course uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    p_district = eduos_ctx_district()
    AND EXISTS (
      SELECT 1 FROM memberships m
      JOIN schools sc ON sc.id=p_school AND sc.district_id=m.district_id
      WHERE m.district_id=p_district AND m.user_id=eduos_ctx_user()
        AND m.role=eduos_ctx_role() AND m.school_id IS NOT DISTINCT FROM eduos_ctx_school()
        AND m.status='active'
    )
    AND EXISTS (
      -- Keep a learner's historical family timeline available after a school
      -- transfer; staff/classroom access below still requires current scope.
      SELECT 1 FROM students s
      WHERE s.id=p_student AND s.district_id=p_district
    )
    AND (
      (
        p_author=eduos_ctx_user() AND p_status IN ('draft','published')
        AND (
          (eduos_ctx_role()='parent' AND EXISTS (
            SELECT 1 FROM student_user_links l
            WHERE l.district_id=p_district AND l.student_id=p_student
              AND l.user_id=eduos_ctx_user() AND l.status='active'
              AND l.relationship IN ('parent','guardian')
          ))
          OR (eduos_ctx_role()='pupil' AND EXISTS (
            SELECT 1 FROM student_user_links l
            WHERE l.district_id=p_district AND l.student_id=p_student
              AND l.user_id=eduos_ctx_user() AND l.status='active'
              AND l.relationship='pupil'
          ))
          OR (eduos_ctx_role()='teacher' AND p_school=eduos_ctx_school() AND EXISTS (
            SELECT 1 FROM teacher_student_rosters r
            WHERE r.district_id=p_district AND r.school_id=p_school
              AND r.student_id=p_student AND r.teacher_user_id=eduos_ctx_user()
          ))
          OR (eduos_ctx_role() IN ('principal','vice_principal') AND p_school=eduos_ctx_school())
        )
      )
      OR (
        p_status='published' AND (
          (p_visibility='family' AND eduos_ctx_role()='parent' AND EXISTS (
            SELECT 1 FROM student_user_links l
            WHERE l.district_id=p_district AND l.student_id=p_student
              AND l.user_id=eduos_ctx_user() AND l.status='active'
              AND l.relationship IN ('parent','guardian')
          ))
          OR (p_visibility IN ('family','classroom','school') AND eduos_ctx_role()='pupil' AND EXISTS (
            SELECT 1 FROM student_user_links l
            WHERE l.district_id=p_district AND l.student_id=p_student
              AND l.user_id=eduos_ctx_user() AND l.status='active'
              AND l.relationship='pupil'
          ))
          OR (p_visibility='educators' AND eduos_ctx_role()='teacher' AND p_school=eduos_ctx_school()
              AND EXISTS (
                SELECT 1 FROM teacher_student_rosters r
                WHERE r.district_id=p_district AND r.school_id=p_school
                  AND r.student_id=p_student AND r.teacher_user_id=eduos_ctx_user()
              ))
          OR (p_visibility='classroom' AND p_course IS NOT NULL AND EXISTS (
            SELECT 1 FROM courses c JOIN course_enrollments e
              ON e.district_id=c.district_id AND e.course_id=c.id
            WHERE c.id=p_course AND c.district_id=p_district AND c.school_id=p_school
              AND c.status='active' AND e.student_id=p_student AND e.status='active'
              AND (
                (eduos_ctx_role()='teacher' AND c.teacher_user_id=eduos_ctx_user()
                  AND p_school=eduos_ctx_school())
                OR (eduos_ctx_role()='pupil' AND EXISTS (
                  SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
                    AND l.student_id=p_student AND l.user_id=eduos_ctx_user()
                    AND l.relationship='pupil' AND l.status='active'
                ))
                OR (eduos_ctx_role()='parent' AND EXISTS (
                  SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
                    AND l.student_id=p_student AND l.user_id=eduos_ctx_user()
                    AND l.relationship IN ('parent','guardian') AND l.status='active'
                ))
              )
          ))
          OR (p_visibility='school' AND (
            (eduos_ctx_role() IN ('teacher','principal','vice_principal')
              AND p_school=eduos_ctx_school())
            OR (eduos_ctx_role()='parent' AND EXISTS (
              SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
                AND l.student_id=p_student AND l.user_id=eduos_ctx_user()
                AND l.relationship IN ('parent','guardian') AND l.status='active'
            ))
            OR (eduos_ctx_role()='pupil' AND EXISTS (
              SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
                AND l.student_id=p_student AND l.user_id=eduos_ctx_user()
                AND l.relationship='pupil' AND l.status='active'
            ))
          ))
        )
      )
    )
$$;

CREATE FUNCTION eduos_timeline_can_insert(
  p_district uuid, p_school uuid, p_student uuid, p_author uuid,
  p_entry_type text, p_visibility text, p_course uuid, p_status text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_district=eduos_ctx_district()
    AND p_author=eduos_ctx_user()
    AND p_status='draft'
    AND EXISTS (
      SELECT 1 FROM memberships m JOIN schools sc
        ON sc.id=p_school AND sc.district_id=m.district_id AND sc.status='active'
      JOIN students s ON s.id=p_student AND s.district_id=m.district_id AND s.school_id=p_school
      WHERE m.district_id=p_district AND m.user_id=eduos_ctx_user()
        AND m.role=eduos_ctx_role() AND m.school_id IS NOT DISTINCT FROM eduos_ctx_school()
        AND m.status='active'
    )
    AND CASE eduos_ctx_role()
      WHEN 'pupil' THEN p_visibility IN ('private','family') AND EXISTS (
        SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
          AND l.student_id=p_student AND l.user_id=eduos_ctx_user()
          AND l.relationship='pupil' AND l.status='active'
      )
      WHEN 'parent' THEN p_visibility IN ('private','family') AND EXISTS (
        SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
          AND l.student_id=p_student AND l.user_id=eduos_ctx_user()
          AND l.relationship IN ('parent','guardian') AND l.status='active'
      )
      WHEN 'teacher' THEN p_visibility IN ('educators','classroom','school')
        AND p_school=eduos_ctx_school()
        AND EXISTS (
          SELECT 1 FROM teacher_student_rosters r WHERE r.district_id=p_district
            AND r.school_id=p_school AND r.student_id=p_student
            AND r.teacher_user_id=eduos_ctx_user()
        )
        AND (p_visibility<>'classroom' OR EXISTS (
          SELECT 1 FROM courses c WHERE c.id=p_course AND c.district_id=p_district
            AND c.school_id=p_school AND c.teacher_user_id=eduos_ctx_user() AND c.status='active'
        ))
      WHEN 'principal' THEN p_visibility='school' AND p_school=eduos_ctx_school()
      WHEN 'vice_principal' THEN p_visibility='school' AND p_school=eduos_ctx_school()
      ELSE false
    END
$$;

ALTER TABLE timeline_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE timeline_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY timeline_tenant_scope ON timeline_entries
  USING (district_id=eduos_ctx_district())
  WITH CHECK (district_id=eduos_ctx_district());
CREATE POLICY timeline_read_scope ON timeline_entries AS RESTRICTIVE FOR SELECT
  USING (eduos_timeline_can_read(district_id,school_id,student_id,created_by,visibility,status,course_id));
CREATE POLICY timeline_insert_scope ON timeline_entries AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_timeline_can_insert(district_id,school_id,student_id,created_by,entry_type,visibility,course_id,status));

REVOKE ALL ON timeline_entries FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_timeline_can_read(uuid,uuid,uuid,uuid,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_timeline_can_insert(uuid,uuid,uuid,uuid,text,text,uuid,text) FROM PUBLIC;
