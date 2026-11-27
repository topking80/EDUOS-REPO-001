-- Student app Phase B: the day planner (docs/STUDENT-DAY-PLANNER.md).
--
-- Three things staff publish, and one read for the learner:
--   course_meetings          when and where a class meets (a course's teacher or the school's leads)
--   course_meeting_changes   one day's cancellation, room move or new time, with a note for students
--                            and a separate staff note that no learner read ever returns
--   school_calendar_days     no-school, early-release, late-start and modified days (school leads),
--                            optionally pointing at a bell schedule whose periods replace class times
--   eduos_learner_schedule() the learner's own classes and club or sport events for a date range,
--                            for the learner or a linked parent only
--
-- Times of day are the school's local time (schools.timezone), so a 9:00 class is 9:00 on either side
-- of a daylight-saving change. Events are timestamps and are shown in the school's time zone.

CREATE TABLE course_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  course_id uuid NOT NULL,
  weekdays smallint[] NOT NULL CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  starts time NOT NULL,
  ends time NOT NULL CHECK (ends > starts),
  period_label text CHECK (period_label IS NULL OR length(btrim(period_label)) BETWEEN 1 AND 60),
  room_id uuid,
  effective_from date NOT NULL,
  effective_until date CHECK (effective_until IS NULL OR effective_until >= effective_from),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_by uuid REFERENCES users(id),
  ended_at timestamptz,
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, course_id) REFERENCES courses(district_id, id),
  FOREIGN KEY (district_id, room_id) REFERENCES classroom_rooms(district_id, id),
  UNIQUE (district_id, id)
);
CREATE INDEX course_meetings_course ON course_meetings(district_id, course_id) WHERE ended_at IS NULL;

CREATE TABLE course_meeting_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  course_id uuid NOT NULL,
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cancelled', 'moved', 'retimed')),
  room_id uuid,
  starts time,
  ends time,
  student_note text CHECK (student_note IS NULL OR length(student_note) <= 300),
  staff_note text CHECK (staff_note IS NULL OR length(staff_note) <= 1000),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_by uuid REFERENCES users(id),
  withdrawn_at timestamptz,
  CHECK (kind <> 'moved' OR room_id IS NOT NULL),
  CHECK (kind <> 'retimed' OR (starts IS NOT NULL AND ends IS NOT NULL AND ends > starts)),
  CHECK (kind <> 'cancelled' OR (room_id IS NULL AND starts IS NULL AND ends IS NULL)),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, course_id) REFERENCES courses(district_id, id),
  FOREIGN KEY (district_id, room_id) REFERENCES classroom_rooms(district_id, id),
  UNIQUE (district_id, id)
);
CREATE UNIQUE INDEX course_meeting_changes_open ON course_meeting_changes(district_id, course_id, day) WHERE withdrawn_at IS NULL;

CREATE TABLE school_calendar_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('no_school', 'early_release', 'late_start', 'modified')),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 2 AND 120),
  bell_schedule_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_by uuid REFERENCES users(id),
  removed_at timestamptz,
  CHECK (kind <> 'no_school' OR bell_schedule_id IS NULL),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, bell_schedule_id) REFERENCES school_bell_schedules(district_id, id),
  UNIQUE (district_id, id)
);
CREATE UNIQUE INDEX school_calendar_days_open ON school_calendar_days(district_id, school_id, day) WHERE removed_at IS NULL;

-- A room, a bell schedule and a course must all belong to the row's school.
CREATE FUNCTION eduos_day_planner_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME IN ('course_meetings', 'course_meeting_changes') THEN
    IF NOT EXISTS (SELECT 1 FROM courses c WHERE c.id = NEW.course_id AND c.district_id = NEW.district_id AND c.school_id = NEW.school_id) THEN
      RAISE EXCEPTION 'course is not at this school' USING ERRCODE = '23514';
    END IF;
    IF NEW.room_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM classroom_rooms r WHERE r.id = NEW.room_id AND r.district_id = NEW.district_id AND r.school_id = NEW.school_id AND r.archived_at IS NULL) THEN
      RAISE EXCEPTION 'room is not at this school' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.bell_schedule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM school_bell_schedules b WHERE b.id = NEW.bell_schedule_id AND b.district_id = NEW.district_id AND b.school_id = NEW.school_id) THEN
    RAISE EXCEPTION 'bell schedule is not at this school' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eduos_day_planner_bind() FROM PUBLIC;
CREATE TRIGGER course_meetings_bind BEFORE INSERT OR UPDATE ON course_meetings FOR EACH ROW EXECUTE FUNCTION eduos_day_planner_bind();
CREATE TRIGGER course_meeting_changes_bind BEFORE INSERT OR UPDATE ON course_meeting_changes FOR EACH ROW EXECUTE FUNCTION eduos_day_planner_bind();
CREATE TRIGGER school_calendar_days_bind BEFORE INSERT OR UPDATE ON school_calendar_days FOR EACH ROW EXECUTE FUNCTION eduos_day_planner_bind();

-- Staff of the school (and district leaders) read these tables directly; learners and families
-- only ever see them through eduos_learner_schedule, which leaves staff notes out.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['course_meetings', 'course_meeting_changes', 'school_calendar_days'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = eduos_ctx_district())
      WITH CHECK (eduos_is_table_owner() OR district_id = eduos_ctx_district())$p$, t);
    EXECUTE format($p$CREATE POLICY staff_read ON %I AS RESTRICTIVE FOR SELECT
      USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ctx_role() IN ('superintendent', 'it_admin')
        OR (school_id = eduos_ctx_school() AND eduos_ctx_role() NOT IN ('pupil', 'parent')) END)$p$, t);
  END LOOP;
END $$;
CREATE POLICY meeting_write ON course_meetings AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_can_manage_course(course_id) AND created_by = eduos_ctx_user() END);
CREATE POLICY meeting_update ON course_meetings AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_can_manage_course(course_id) END);
CREATE POLICY change_write ON course_meeting_changes AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_can_manage_course(course_id) AND created_by = eduos_ctx_user() END);
CREATE POLICY change_update ON course_meeting_changes AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_can_manage_course(course_id) END);
CREATE POLICY calendar_write ON school_calendar_days AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_is_school_lead(school_id) AND created_by = eduos_ctx_user() END);
CREATE POLICY calendar_update ON school_calendar_days AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_is_school_lead(school_id) END);

-- The learner's schedule for p_days days from p_from (today at the school when NULL). The caller must be the learner (an active pupil link) or a parent or
-- guardian with an active link; everything else returns NULL. Only the learner's active
-- enrollments in courses at their current school count, so a dropped course or a move to another
-- school removes those classes. Club and sport events come from the learner's own active
-- memberships, published or cancelled, at their school.
CREATE FUNCTION eduos_learner_schedule(p_student uuid, p_from date, p_days integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  stu record; tz text; v_pupil uuid; out jsonb; p_to date;
BEGIN
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 42 THEN RAISE EXCEPTION 'days must be 1 to 42' USING ERRCODE = '22023'; END IF;
  SELECT s.id, s.school_id, s.district_id INTO stu FROM students s
    WHERE s.id = p_student AND s.district_id = eduos_ctx_district() AND EXISTS (
      SELECT 1 FROM student_user_links l WHERE l.student_id = s.id AND l.district_id = s.district_id AND l.user_id = eduos_ctx_user() AND l.status = 'active'
        AND ((eduos_ctx_role() = 'pupil' AND l.relationship = 'pupil') OR (eduos_ctx_role() = 'parent' AND l.relationship IN ('parent', 'guardian'))));
  IF stu.id IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(nullif(timezone, ''), 'UTC') INTO tz FROM schools WHERE id = stu.school_id AND district_id = stu.district_id;
  -- No start date: today where the school is.
  p_from := coalesce(p_from, (now() AT TIME ZONE tz)::date);
  p_to := p_from + (p_days - 1);
  SELECT l.user_id INTO v_pupil FROM student_user_links l WHERE l.student_id = stu.id AND l.district_id = stu.district_id AND l.relationship = 'pupil' AND l.status = 'active' LIMIT 1;

  WITH days AS (
    SELECT d::date AS day, extract(isodow FROM d)::smallint AS dow FROM generate_series(p_from, p_to, interval '1 day') d
  ), cal AS (
    SELECT k.day, k.kind, k.label, k.bell_schedule_id, k.created_at FROM school_calendar_days k
    WHERE k.district_id = stu.district_id AND k.school_id = stu.school_id AND k.removed_at IS NULL AND k.day BETWEEN p_from AND p_to
  ), classes AS (
    SELECT dd.day, c.id AS course_id, c.title, c.subject, u.display_name AS teacher, m.period_label,
      coalesce(ch.starts, bp.starts, m.starts) AS starts, coalesce(ch.ends, bp.ends, m.ends) AS ends,
      coalesce(rc.name, rm.name) AS room,
      CASE WHEN cal.kind = 'no_school' THEN 'no_school' WHEN ch.kind = 'cancelled' THEN 'cancelled' WHEN ch.kind IS NOT NULL THEN 'changed'
           WHEN bp.id IS NOT NULL THEN 'adjusted' ELSE 'scheduled' END AS status,
      ch.student_note AS note, greatest(m.updated_at, ch.created_at) AS changed_at
    FROM days dd
    JOIN course_enrollments e ON e.student_id = stu.id AND e.district_id = stu.district_id AND e.status = 'active'
    JOIN courses c ON c.id = e.course_id AND c.district_id = e.district_id AND c.school_id = stu.school_id AND c.status = 'active'
    JOIN course_meetings m ON m.course_id = c.id AND m.district_id = c.district_id AND m.ended_at IS NULL AND dd.dow = ANY(m.weekdays)
      AND dd.day >= m.effective_from AND (m.effective_until IS NULL OR dd.day <= m.effective_until)
    JOIN users u ON u.id = c.teacher_user_id
    LEFT JOIN classroom_rooms rm ON rm.id = m.room_id AND rm.district_id = m.district_id
    LEFT JOIN cal ON cal.day = dd.day
    LEFT JOIN course_meeting_changes ch ON ch.course_id = c.id AND ch.district_id = c.district_id AND ch.day = dd.day AND ch.withdrawn_at IS NULL
    LEFT JOIN classroom_rooms rc ON rc.id = ch.room_id AND rc.district_id = ch.district_id
    LEFT JOIN school_bell_periods bp ON cal.bell_schedule_id IS NOT NULL AND bp.schedule_id = cal.bell_schedule_id AND bp.district_id = stu.district_id
      AND m.period_label IS NOT NULL AND lower(btrim(bp.label)) = lower(btrim(m.period_label)) AND ch.starts IS NULL
  ), events AS (
    SELECT (ev.starts_at AT TIME ZONE tz)::date AS day, ev.id, ev.title, a.title AS activity, a.kind, ev.venue, ev.status,
      to_char(ev.starts_at AT TIME ZONE tz, 'HH24:MI') AS starts, to_char(ev.ends_at AT TIME ZONE tz, 'HH24:MI') AS ends,
      (ev.ends_at AT TIME ZONE tz)::date AS end_day, ev.updated_at
    FROM school_events ev
    JOIN school_activities a ON a.id = ev.activity_id AND a.district_id = ev.district_id
    JOIN activity_memberships am ON am.activity_id = a.id AND am.district_id = a.district_id AND am.user_id = v_pupil AND am.status = 'active'
    WHERE ev.district_id = stu.district_id AND ev.school_id = stu.school_id AND ev.status IN ('published', 'cancelled')
      AND (ev.starts_at AT TIME ZONE tz)::date BETWEEN p_from AND p_to
  )
  SELECT jsonb_build_object(
    'timezone', tz, 'today', (now() AT TIME ZONE tz)::date,
    'from', p_from, 'to', p_to,
    'updatedAt', (SELECT max(x) FROM (SELECT max(changed_at) AS x FROM classes UNION ALL SELECT max(created_at) FROM cal UNION ALL SELECT max(updated_at) FROM events) t),
    'days', (SELECT jsonb_agg(jsonb_build_object(
        'date', dd.day, 'weekday', dd.dow,
        'calendar', (SELECT jsonb_build_object('kind', cal.kind, 'label', cal.label) FROM cal WHERE cal.day = dd.day),
        'classes', coalesce((SELECT jsonb_agg(jsonb_build_object('courseId', k.course_id, 'title', k.title, 'subject', k.subject, 'teacher', k.teacher,
            'period', k.period_label, 'starts', to_char(k.starts, 'HH24:MI'), 'ends', to_char(k.ends, 'HH24:MI'), 'room', k.room, 'status', k.status, 'note', k.note)
            ORDER BY k.starts, k.title) FROM classes k WHERE k.day = dd.day), '[]'::jsonb),
        'events', coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'activity', x.activity, 'kind', x.kind, 'venue', nullif(x.venue, ''),
            'starts', x.starts, 'ends', x.ends, 'endsNextDay', x.end_day > x.day, 'status', x.status) ORDER BY x.starts, x.title) FROM events x WHERE x.day = dd.day), '[]'::jsonb))
      ORDER BY dd.day) FROM days dd)
  ) INTO out;
  RETURN out;
END $$;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION eduos_learner_schedule(uuid, date, integer) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN GRANT EXECUTE ON FUNCTION eduos_learner_schedule(uuid, date, integer) TO eduos_app; END IF;
END $$;
