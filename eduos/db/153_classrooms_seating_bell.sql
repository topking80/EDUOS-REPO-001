-- Classrooms operations: school bell schedules (periods per day type) and
-- teacher-managed seating charts tied to existing courses and classroom rooms.
-- Numbered 153: 152 is clubs & sports attendance/physicals.
--
-- Promises kept here: bell schedules belong to a school and are readable across
-- that school; seating charts hold only grid coordinates and optional seat
-- labels for learners already enrolled in the course, and are visible only to
-- the course's teacher and school leads (never extra personal data).

CREATE TABLE school_bell_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  day_type text NOT NULL DEFAULT 'regular' CHECK (day_type IN ('regular','early_release','late_start','assembly','custom')),
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id) ON DELETE CASCADE,
  UNIQUE (district_id, id)
);
CREATE UNIQUE INDEX school_bell_schedules_default
  ON school_bell_schedules(district_id, school_id) WHERE is_default AND status = 'active';
CREATE INDEX school_bell_schedules_school ON school_bell_schedules(district_id, school_id, status, name);

CREATE TABLE school_bell_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 30),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  kind text NOT NULL DEFAULT 'instruction' CHECK (kind IN ('instruction','homeroom','lunch','passing','assembly')),
  starts time NOT NULL,
  ends time NOT NULL CHECK (ends > starts),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, schedule_id) REFERENCES school_bell_schedules(district_id, id) ON DELETE CASCADE,
  UNIQUE (district_id, schedule_id, seq)
);
CREATE INDEX school_bell_periods_schedule ON school_bell_periods(district_id, schedule_id, starts, seq);

CREATE TABLE course_seating_charts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  course_id uuid NOT NULL,
  room_id uuid,
  rows_count smallint NOT NULL DEFAULT 5 CHECK (rows_count BETWEEN 1 AND 20),
  cols_count smallint NOT NULL DEFAULT 6 CHECK (cols_count BETWEEN 1 AND 20),
  share_with_families boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, course_id) REFERENCES courses(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, room_id) REFERENCES classroom_rooms(district_id, id) ON DELETE SET NULL,
  UNIQUE (district_id, id),
  UNIQUE (district_id, course_id)
);

CREATE TABLE course_seat_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  course_id uuid NOT NULL,
  chart_id uuid NOT NULL,
  student_id uuid NOT NULL,
  seat_row smallint NOT NULL CHECK (seat_row >= 1),
  seat_col smallint NOT NULL CHECK (seat_col >= 1),
  seat_label text NOT NULL DEFAULT '' CHECK (length(seat_label) <= 40),
  assigned_by uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, course_id) REFERENCES courses(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, chart_id) REFERENCES course_seating_charts(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id) ON DELETE CASCADE,
  UNIQUE (chart_id, student_id),
  UNIQUE (chart_id, seat_row, seat_col)
);
CREATE INDEX course_seat_assignments_course ON course_seat_assignments(district_id, course_id);

CREATE FUNCTION eduos_seating_chart_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c_school uuid; r_school uuid; r_arch timestamptz;
BEGIN
  SELECT school_id INTO c_school FROM courses WHERE id = NEW.course_id AND district_id = NEW.district_id;
  IF c_school IS NULL OR c_school <> NEW.school_id THEN
    RAISE EXCEPTION 'course is not in this school' USING ERRCODE = '23503';
  END IF;
  IF NEW.room_id IS NOT NULL THEN
    SELECT school_id, archived_at INTO r_school, r_arch FROM classroom_rooms WHERE id = NEW.room_id AND district_id = NEW.district_id;
    IF r_school IS NULL OR r_school <> NEW.school_id OR r_arch IS NOT NULL THEN
      RAISE EXCEPTION 'room is not active in this school' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION eduos_seating_chart_bind() FROM PUBLIC;
CREATE TRIGGER course_seating_charts_bind BEFORE INSERT OR UPDATE ON course_seating_charts
  FOR EACH ROW EXECUTE FUNCTION eduos_seating_chart_bind();

CREATE FUNCTION eduos_seat_assignment_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ch course_seating_charts;
BEGIN
  SELECT * INTO ch FROM course_seating_charts WHERE id = NEW.chart_id AND district_id = NEW.district_id;
  IF ch.id IS NULL OR ch.course_id <> NEW.course_id OR ch.school_id <> NEW.school_id THEN
    RAISE EXCEPTION 'seating chart mismatch' USING ERRCODE = '23503';
  END IF;
  IF NEW.seat_row > ch.rows_count OR NEW.seat_col > ch.cols_count THEN
    RAISE EXCEPTION 'seat outside chart bounds' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM course_enrollments e WHERE e.district_id = NEW.district_id AND e.course_id = NEW.course_id
                 AND e.student_id = NEW.student_id AND e.status = 'active') THEN
    RAISE EXCEPTION 'learner is not enrolled in this course' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION eduos_seat_assignment_bind() FROM PUBLIC;
CREATE TRIGGER course_seat_assignments_bind BEFORE INSERT OR UPDATE ON course_seat_assignments
  FOR EACH ROW EXECUTE FUNCTION eduos_seat_assignment_bind();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['school_bell_schedules','school_bell_periods','course_seating_charts','course_seat_assignments'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY %I ON %I
      USING (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid
       AND (school_id=nullif(current_setting(''app.school_id'',true),'''')::uuid OR current_setting(''app.role'',true) IN (''superintendent'',''it_admin'') OR eduos_is_table_owner()))
      WITH CHECK (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid
       AND (school_id=nullif(current_setting(''app.school_id'',true),'''')::uuid OR current_setting(''app.role'',true) IN (''superintendent'',''it_admin'') OR eduos_is_table_owner()))',
   t || '_tenant_scope', t);
 END LOOP;
END $$;

-- Vice principals may write bell schedules for their own school (t49u).
-- Do not widen eduos_is_school_lead, which is used across other features.
CREATE FUNCTION eduos_can_manage_bell_schedule(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_is_school_lead(p_school)
      OR (eduos_ctx_role()='vice_principal' AND p_school=eduos_ctx_school())
$$;
REVOKE ALL ON FUNCTION eduos_can_manage_bell_schedule(uuid) FROM PUBLIC;

-- A family reads a chart only when the teacher/admin has turned sharing on
-- and they are linked to an enrolled learner in that course.
CREATE FUNCTION eduos_can_read_seating_chart(p_course uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_can_manage_course(p_course)
      OR EXISTS (
        SELECT 1 FROM course_seating_charts ch
        JOIN course_enrollments e ON e.course_id=ch.course_id AND e.district_id=ch.district_id AND e.status='active'
        WHERE ch.course_id=p_course AND ch.district_id=eduos_ctx_district() AND ch.share_with_families
          AND eduos_is_linked_student(e.student_id))
$$;
REVOKE ALL ON FUNCTION eduos_can_read_seating_chart(uuid) FROM PUBLIC;

-- A family sees only their own learner's seat, and only when sharing is on.
CREATE FUNCTION eduos_can_read_seat(p_course uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_can_manage_course(p_course)
      OR (eduos_is_linked_student(p_student)
          AND EXISTS (SELECT 1 FROM course_seating_charts ch
                      WHERE ch.course_id=p_course AND ch.district_id=eduos_ctx_district() AND ch.share_with_families))
$$;
REVOKE ALL ON FUNCTION eduos_can_read_seat(uuid, uuid) FROM PUBLIC;

CREATE POLICY bell_schedule_write ON school_bell_schedules AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_can_manage_bell_schedule(school_id));
CREATE POLICY bell_schedule_update ON school_bell_schedules AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_can_manage_bell_schedule(school_id));
CREATE POLICY bell_period_write ON school_bell_periods AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_can_manage_bell_schedule(school_id));
CREATE POLICY bell_period_update ON school_bell_periods AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_can_manage_bell_schedule(school_id));
CREATE POLICY bell_period_delete ON school_bell_periods AS RESTRICTIVE FOR DELETE
  USING (eduos_is_table_owner() OR eduos_can_manage_bell_schedule(school_id));

CREATE POLICY seating_chart_read ON course_seating_charts AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_read_seating_chart(course_id));
CREATE POLICY seating_chart_write ON course_seating_charts AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_can_manage_course(course_id));
CREATE POLICY seating_chart_update ON course_seating_charts AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_can_manage_course(course_id));

CREATE POLICY seat_read ON course_seat_assignments AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_read_seat(course_id, student_id));
CREATE POLICY seat_write ON course_seat_assignments AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_can_manage_course(course_id));
CREATE POLICY seat_update ON course_seat_assignments AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_can_manage_course(course_id));
CREATE POLICY seat_delete ON course_seat_assignments AS RESTRICTIVE FOR DELETE
  USING (eduos_is_table_owner() OR eduos_can_manage_course(course_id));
