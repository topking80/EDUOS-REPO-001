-- ROOM-02: a remote lesson on the teacher's daily schedule.
--
-- For a class on a given day, the teacher adds a live session: the time, a
-- video-call link (Google Meet, Zoom, Microsoft Teams or Webex only) and,
-- optionally, the day's lesson from the course. Students enrolled in the
-- course see it on their schedule; joining from EduOS checks them in as
-- "remote", which the room's roll shows. As with the room, the teacher
-- confirms attendance; nothing here writes it.

CREATE TABLE class_remote_lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  course_id uuid NOT NULL,
  lesson_date date NOT NULL,
  starts time NOT NULL,
  ends time NOT NULL CHECK (ends > starts),
  join_url text NOT NULL CHECK (length(join_url) <= 500 AND join_url ~ '^https://([a-z0-9-]+\.)*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com)(/[^\s]*)?$'),
  lesson_id uuid REFERENCES lessons(id),
  note text CHECK (note IS NULL OR length(note) <= 500),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  FOREIGN KEY (district_id, course_id) REFERENCES courses(district_id, id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  UNIQUE (district_id, id)
);
CREATE UNIQUE INDEX class_remote_lessons_day ON class_remote_lessons(course_id, lesson_date) WHERE cancelled_at IS NULL;
CREATE INDEX class_remote_lessons_date ON class_remote_lessons(district_id, lesson_date);

CREATE TABLE remote_lesson_checkins (
  session_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  student_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, student_id),
  FOREIGN KEY (district_id, session_id) REFERENCES class_remote_lessons(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['class_remote_lessons','remote_lesson_checkins'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

CREATE FUNCTION eduos_teaches_course(p_course uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM courses c WHERE c.id = p_course AND c.district_id = eduos_ctx_district() AND c.teacher_user_id = eduos_ctx_user() AND c.status <> 'archived')
$$;
-- A student account (pupil link) enrolled in the course.
CREATE FUNCTION eduos_enrolled_pupil_student(p_course uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.student_id FROM course_enrollments e JOIN student_user_links l ON l.student_id = e.student_id
   WHERE e.course_id = p_course AND e.district_id = eduos_ctx_district() AND e.status = 'active'
     AND l.user_id = eduos_ctx_user() AND l.relationship = 'pupil' AND l.status = 'active' LIMIT 1
$$;

-- Read: the course's teacher, the school's leaders and the superintendent,
-- and students enrolled in the course. Write: the course's teacher.
CREATE POLICY scope_read ON class_remote_lessons AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_teaches_course(course_id)
  OR coalesce(eduos_ctx_role(), '') = 'superintendent' OR (coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal') AND school_id = eduos_ctx_school())
  OR (coalesce(eduos_ctx_role(), '') = 'pupil' AND eduos_enrolled_pupil_student(course_id) IS NOT NULL));
CREATE POLICY scope_insert ON class_remote_lessons AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_teaches_course(course_id) AND created_by = eduos_ctx_user()));
CREATE POLICY scope_update ON class_remote_lessons AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_teaches_course(course_id))
  WITH CHECK (eduos_is_table_owner() OR eduos_teaches_course(course_id));

CREATE POLICY scope_read ON remote_lesson_checkins AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR user_id = eduos_ctx_user()
  OR EXISTS (SELECT 1 FROM class_remote_lessons s WHERE s.id = session_id AND (eduos_teaches_course(s.course_id)
    OR coalesce(eduos_ctx_role(), '') = 'superintendent' OR (coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal') AND s.school_id = eduos_ctx_school()))));
CREATE POLICY functions_write ON remote_lesson_checkins AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());

-- A student joins: enrolled, today (school time zone), from ten minutes before
-- the start until the end. Returns the link to open.
CREATE FUNCTION eduos_remote_lesson_join(p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s class_remote_lessons%ROWTYPE; stu uuid; tz text; ln timestamp; n int;
BEGIN
  IF coalesce(eduos_ctx_role(), '') <> 'pupil' THEN RETURN jsonb_build_object('error', 'students_only'); END IF;
  SELECT * INTO s FROM class_remote_lessons WHERE id = p_session AND district_id = eduos_ctx_district() AND cancelled_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  stu := eduos_enrolled_pupil_student(s.course_id);
  IF stu IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = sc.timezone) THEN sc.timezone ELSE 'UTC' END INTO tz FROM schools sc WHERE sc.id = s.school_id;
  ln := now() AT TIME ZONE tz;
  IF ln::date <> s.lesson_date OR ln < ln::date + s.starts - interval '10 minutes' OR ln >= ln::date + s.ends THEN RETURN jsonb_build_object('error', 'not_now'); END IF;
  INSERT INTO remote_lesson_checkins(session_id, district_id, student_id, user_id) VALUES (s.id, s.district_id, stu, eduos_ctx_user()) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('joinUrl', s.join_url, 'already', n = 0);
END $$;
REVOKE ALL ON FUNCTION eduos_remote_lesson_join(uuid) FROM PUBLIC;
