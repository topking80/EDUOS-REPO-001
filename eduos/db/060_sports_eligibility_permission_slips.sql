-- 37.6.0: sports eligibility, athletic directors, guardian e-sign permission
-- slips and database-enforced roster scoping for the clubs & sports backend.
-- Numbered 060: 058 is the district AI privacy controls (#48) and 059 is
-- Leo/Edison; all of them are found in db/ by src/migrate.js in name order.
--
-- Promises kept here: eligibility is pass/fail by named district rule, computed
-- on read and never stored, never a score or a prediction, and visible only to
-- the team's coach and the school's athletic director. No location, no faces.

-- ---------------------------------------------------------------------------
-- Athletic directors: a per-school role granted by the principal or the
-- superintendent to a staff member of that school. Revoking keeps the history.
-- ---------------------------------------------------------------------------
CREATE TABLE school_athletic_directors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 assigned_by uuid NOT NULL REFERENCES users(id),
 assigned_at timestamptz NOT NULL DEFAULT now(),
 revoked_by uuid REFERENCES users(id),
 revoked_at timestamptz,
 CHECK((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX school_athletic_directors_active ON school_athletic_directors(district_id,school_id,user_id) WHERE revoked_at IS NULL;

-- District eligibility rules, set by the superintendent. Defaults apply until set.
CREATE TABLE sports_eligibility_policy (
 district_id uuid PRIMARY KEY REFERENCES districts(id) ON DELETE CASCADE,
 min_course_percent numeric(5,2) NOT NULL DEFAULT 60 CHECK(min_course_percent BETWEEN 0 AND 100),
 min_attendance_percent numeric(5,2) NOT NULL DEFAULT 90 CHECK(min_attendance_percent BETWEEN 0 AND 100),
 window_days integer NOT NULL DEFAULT 30 CHECK(window_days BETWEEN 7 AND 120),
 min_records integer NOT NULL DEFAULT 5 CHECK(min_records BETWEEN 1 AND 60),
 updated_by uuid NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Permission slips. The slip text is bound by SHA-256; a signature must carry
-- the hash of the exact text the guardian saw. Signatures are append-only and
-- the latest one per guardian and learner is the answer.
-- ---------------------------------------------------------------------------
CREATE TABLE activity_permission_slips (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 activity_id uuid NOT NULL REFERENCES school_activities(id) ON DELETE CASCADE,
 event_id uuid REFERENCES school_events(id) ON DELETE CASCADE,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 2 AND 120),
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 10 AND 4000),
 body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
 due_on date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 closed_at timestamptz,
 UNIQUE(district_id,id)
);
CREATE INDEX activity_permission_slips_activity ON activity_permission_slips(district_id,activity_id,status,due_on);
CREATE FUNCTION eduos_permission_slip_bind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.activity_id IS DISTINCT FROM OLD.activity_id OR NEW.school_id IS DISTINCT FROM OLD.school_id) THEN
    RAISE EXCEPTION 'a permission slip''s text is fixed once sent; close it and send a new one' USING ERRCODE='22023';
  END IF;
  NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
  IF NOT EXISTS (SELECT 1 FROM school_activities a WHERE a.id=NEW.activity_id AND a.district_id=NEW.district_id AND a.school_id=NEW.school_id) THEN
    RAISE EXCEPTION 'activity is not in this school' USING ERRCODE='23503';
  END IF;
  IF NEW.event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM school_events e WHERE e.id=NEW.event_id AND e.district_id=NEW.district_id AND e.activity_id=NEW.activity_id) THEN
    RAISE EXCEPTION 'event is not on this activity' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER activity_permission_slips_bind BEFORE INSERT OR UPDATE ON activity_permission_slips
  FOR EACH ROW EXECUTE FUNCTION eduos_permission_slip_bind();

CREATE TABLE activity_permission_slip_signatures (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 slip_id uuid NOT NULL,
 student_id uuid NOT NULL,
 guardian_user_id uuid NOT NULL REFERENCES users(id),
 decision text NOT NULL CHECK(decision IN ('granted','declined')),
 signed_name text NOT NULL CHECK(length(btrim(signed_name)) BETWEEN 2 AND 120),
 body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
 signed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(district_id,slip_id) REFERENCES activity_permission_slips(district_id,id) ON DELETE CASCADE,
 FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id)
);
CREATE INDEX activity_permission_slip_signatures_latest ON activity_permission_slip_signatures(district_id,slip_id,student_id,signed_at DESC);
CREATE INDEX activity_permission_slip_signatures_student ON activity_permission_slip_signatures(district_id,student_id);
CREATE TRIGGER activity_permission_slip_signatures_append_only BEFORE UPDATE OR DELETE ON activity_permission_slip_signatures
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
-- A signature is only accepted for an open slip, the exact text, and a learner
-- who is on that activity's active roster at the slip's school.
CREATE FUNCTION eduos_permission_slip_signature_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s activity_permission_slips;
BEGIN
  SELECT * INTO s FROM activity_permission_slips WHERE id=NEW.slip_id AND district_id=NEW.district_id;
  IF s.id IS NULL OR s.status <> 'open' THEN RAISE EXCEPTION 'permission slip is not open' USING ERRCODE='22023'; END IF;
  IF NEW.body_sha256 <> s.body_sha256 THEN RAISE EXCEPTION 'permission slip text changed; reload and read it again' USING ERRCODE='22023'; END IF;
  IF NEW.school_id <> s.school_id THEN RAISE EXCEPTION 'school mismatch' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM activity_roster_entries r WHERE r.district_id=s.district_id AND r.activity_id=s.activity_id
                 AND r.student_id=NEW.student_id AND r.status='active') THEN
    RAISE EXCEPTION 'learner is not on this roster' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION eduos_permission_slip_signature_check() FROM PUBLIC;
CREATE TRIGGER activity_permission_slip_signatures_check BEFORE INSERT ON activity_permission_slip_signatures
  FOR EACH ROW EXECUTE FUNCTION eduos_permission_slip_signature_check();

-- ---------------------------------------------------------------------------
-- Role helpers (SECURITY DEFINER so policies can read staff assignments).
-- ---------------------------------------------------------------------------
CREATE FUNCTION eduos_is_athletic_director(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role() IN ('teacher','vice_principal','principal') AND p_school=eduos_ctx_school()
     AND EXISTS(SELECT 1 FROM school_athletic_directors x WHERE x.district_id=eduos_ctx_district() AND x.school_id=p_school
                AND x.user_id=eduos_ctx_user() AND x.revoked_at IS NULL)
$$;
CREATE FUNCTION eduos_is_activity_staff(p_activity uuid, p_roles text[] DEFAULT ARRAY['advisor','coach']) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role()='teacher' AND EXISTS(SELECT 1 FROM activity_staff s WHERE s.district_id=eduos_ctx_district()
    AND s.activity_id=p_activity AND s.user_id=eduos_ctx_user() AND s.school_id=eduos_ctx_school() AND s.staff_role=ANY(p_roles))
$$;
CREATE FUNCTION eduos_activity_school(p_activity uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT school_id FROM school_activities WHERE id=p_activity AND district_id=eduos_ctx_district()
$$;
-- Eligibility: the team's coach or the school's athletic director. Nobody else,
-- including principals who are not the athletic director.
CREATE FUNCTION eduos_can_see_eligibility(p_activity uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM school_activities a WHERE a.id=p_activity AND a.district_id=eduos_ctx_district() AND a.kind='sport')
     AND (eduos_is_activity_staff(p_activity, ARRAY['coach']) OR eduos_is_athletic_director(eduos_activity_school(p_activity)))
$$;
-- Who may read a roster: school leads, the activity's staff, the athletic
-- director, and a family or learner for their own row.
CREATE FUNCTION eduos_can_read_roster(p_activity uuid, p_school uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_is_school_lead(p_school) OR eduos_is_activity_staff(p_activity) OR eduos_is_athletic_director(p_school)
      OR eduos_is_linked_student(p_student)
$$;
CREATE FUNCTION eduos_can_manage_roster(p_activity uuid, p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_is_school_lead(p_school) OR eduos_is_activity_staff(p_activity) OR eduos_is_athletic_director(p_school)
$$;
-- A family sees a slip when one of their linked learners is on the roster.
CREATE FUNCTION eduos_family_on_roster(p_activity uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role() IN ('parent','pupil') AND EXISTS(SELECT 1 FROM activity_roster_entries r JOIN student_user_links l
    ON l.student_id=r.student_id AND l.district_id=r.district_id AND l.user_id=eduos_ctx_user() AND l.status='active'
   WHERE r.activity_id=p_activity AND r.district_id=eduos_ctx_district() AND r.status='active'
     AND ((eduos_ctx_role()='parent' AND l.relationship IN ('parent','guardian')) OR (eduos_ctx_role()='pupil' AND l.relationship='pupil')))
$$;

-- ---------------------------------------------------------------------------
-- RLS. District and school tenant scope (as in 056; the table owner, i.e. the
-- retention and deletion functions, is not school-bound) plus RESTRICTIVE per-role
-- limits, so the roster rules hold in the database and not only in the routes.
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['school_athletic_directors','activity_permission_slips','activity_permission_slip_signatures'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON %I
      USING (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid
       AND (school_id=nullif(current_setting(''app.school_id'',true),'''')::uuid OR current_setting(''app.role'',true) IN (''superintendent'',''it_admin'') OR eduos_is_table_owner()))
      WITH CHECK (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid
       AND (school_id=nullif(current_setting(''app.school_id'',true),'''')::uuid OR current_setting(''app.role'',true) IN (''superintendent'',''it_admin'') OR eduos_is_table_owner()))',
   t||'_tenant_scope',t);
 END LOOP;
END $$;
ALTER TABLE sports_eligibility_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE sports_eligibility_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY sports_eligibility_policy_tenant ON sports_eligibility_policy
  USING (district_id=nullif(current_setting('app.district_id',true),'')::uuid)
  WITH CHECK (district_id=nullif(current_setting('app.district_id',true),'')::uuid);
CREATE POLICY scope_write ON sports_eligibility_policy AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role()='superintendent');
CREATE POLICY scope_update ON sports_eligibility_policy AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent');

CREATE POLICY scope_read ON school_athletic_directors AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_school_lead(school_id) OR user_id=eduos_ctx_user() OR eduos_ctx_role()='it_admin');
CREATE POLICY scope_insert ON school_athletic_directors AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_is_school_lead(school_id));
CREATE POLICY scope_update ON school_athletic_directors AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_school_lead(school_id)) WITH CHECK (eduos_is_table_owner() OR eduos_is_school_lead(school_id));

-- Roster gap fix: the 056 school scope let any account at the school read every
-- roster. Now only the people above can, enforced for SELECT, INSERT and UPDATE.
CREATE POLICY scope_read ON activity_roster_entries AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_read_roster(activity_id, school_id, student_id));
CREATE POLICY scope_insert ON activity_roster_entries AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_can_manage_roster(activity_id, school_id));
CREATE POLICY scope_update ON activity_roster_entries AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_can_manage_roster(activity_id, school_id))
  WITH CHECK (eduos_is_table_owner() OR eduos_can_manage_roster(activity_id, school_id));

CREATE POLICY scope_read ON activity_permission_slips AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_manage_roster(activity_id, school_id) OR eduos_family_on_roster(activity_id));
CREATE POLICY scope_insert ON activity_permission_slips AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_can_manage_roster(activity_id, school_id));
CREATE POLICY scope_update ON activity_permission_slips AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_can_manage_roster(activity_id, school_id))
  WITH CHECK (eduos_is_table_owner() OR eduos_can_manage_roster(activity_id, school_id));

CREATE POLICY scope_read ON activity_permission_slip_signatures AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_linked_student(student_id)
     OR EXISTS(SELECT 1 FROM activity_permission_slips s WHERE s.id=slip_id AND s.district_id=district_id
               AND eduos_can_manage_roster(s.activity_id, s.school_id)));
CREATE POLICY scope_insert ON activity_permission_slip_signatures AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='parent' AND guardian_user_id=eduos_ctx_user() AND eduos_is_linked_student(student_id)));

-- ---------------------------------------------------------------------------
-- Eligibility inputs: raw attendance counts and course work for the active
-- roster, only for the coach or athletic director. src/sports-eligibility.js
-- turns them into pass/fail by rule on read; nothing derived is stored.
-- ---------------------------------------------------------------------------
CREATE FUNCTION eduos_sports_eligibility_inputs(p_activity uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); pol sports_eligibility_policy; since date;
BEGIN
  IF NOT eduos_can_see_eligibility(p_activity) THEN
    RAISE EXCEPTION 'eligibility is visible to the coach and athletic director only' USING ERRCODE='42501';
  END IF;
  SELECT * INTO pol FROM sports_eligibility_policy WHERE district_id=d;
  IF pol.district_id IS NULL THEN pol.min_course_percent := 60; pol.min_attendance_percent := 90; pol.window_days := 30; pol.min_records := 5; END IF;
  since := current_date - pol.window_days;
  RETURN jsonb_build_object(
    'policy', jsonb_build_object('minCoursePercent', pol.min_course_percent, 'minAttendancePercent', pol.min_attendance_percent,
                                 'windowDays', pol.window_days, 'minRecords', pol.min_records, 'set', pol.updated_by IS NOT NULL),
    'students', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'studentId', s.id, 'name', s.display_name, 'grade', s.grade_level, 'jersey', r.jersey_number,
      'attendance', (SELECT jsonb_build_object(
          'present', count(*) FILTER (WHERE e.status='present'), 'absent', count(*) FILTER (WHERE e.status='absent'),
          'tardy', count(*) FILTER (WHERE e.status='tardy'), 'excused', count(*) FILTER (WHERE e.status='excused'), 'records', count(*))
        FROM attendance_events e WHERE e.district_id=d AND e.student_id=s.id AND e.event_date >= since),
      'courses', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'courseId', c.id, 'title', c.title, 'weights', c.grade_weights,
          'work', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'category', a.category, 'points', a.points_possible::float8,
                     'dueAt', a.due_at, 'retakePolicy', a.retake_policy,
                     'submission', (SELECT jsonb_build_object('pointsEarned', x.points_earned::float8, 'score', x.score::float8, 'gradedAt', x.graded_at)
                                      FROM assignment_submissions x WHERE x.assignment_id=a.id AND x.student_id=s.id AND x.district_id=d LIMIT 1),
                     'attempts', coalesce((SELECT jsonb_agg(jsonb_build_object('status', q.status, 'total', q.total_points::float8, 'possible', q.possible_points::float8) ORDER BY q.attempt_no)
                                      FROM quiz_attempts q WHERE q.assignment_id=a.id AND q.student_id=s.id AND q.district_id=d), '[]'::jsonb)))
                   FROM assignments a WHERE a.course_id=c.id AND a.district_id=d AND a.status IN ('published','closed')), '[]'::jsonb)))
        FROM course_enrollments ce JOIN courses c ON c.id=ce.course_id AND c.district_id=d
       WHERE ce.student_id=s.id AND ce.district_id=d AND ce.status='active' AND c.status='active'), '[]'::jsonb)) ORDER BY s.display_name)
      FROM activity_roster_entries r JOIN students s ON s.id=r.student_id AND s.district_id=d
     WHERE r.activity_id=p_activity AND r.district_id=d AND r.status='active'), '[]'::jsonb));
END; $$;
REVOKE ALL ON FUNCTION eduos_sports_eligibility_inputs(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Student record deletion: remove this learner's clubs & sports rows (roster,
-- media participation and consents, slip signatures) before the earlier chain.
-- ---------------------------------------------------------------------------
ALTER FUNCTION eduos_purge_student(uuid) RENAME TO eduos_purge_student_pre_sports;
CREATE FUNCTION eduos_purge_student(p_student uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; out jsonb := '{}'::jsonb; rest jsonb;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM students WHERE id=p_student AND district_id=d) THEN RETURN NULL; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM activity_permission_slip_signatures WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('permission_slip_signatures', n);
  DELETE FROM activity_media_consent_history WHERE student_id=p_student AND district_id=d;
  DELETE FROM activity_media_consents WHERE student_id=p_student AND district_id=d;
  DELETE FROM activity_media_participants WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('activity_media_participants', n);
  DELETE FROM activity_roster_entries WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('activity_roster_entries', n);
  rest := eduos_purge_student_pre_sports(p_student);
  RETURN out || coalesce(rest, '{}'::jsonb);
END; $$;
REVOKE ALL ON FUNCTION eduos_purge_student(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_purge_student_pre_sports(uuid) FROM PUBLIC;

-- Retention: slips closed (or past due) for longer than the window go, with
-- their signatures (RETENTION_PERMISSION_SLIP_DAYS, default 730, minimum 90).
-- Run by the src/retention.js feature loop once that loop is merged.
CREATE FUNCTION eduos_retention_feature_activities(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int;
  days int := greatest(90, coalesce(nullif(p->>'RETENTION_PERMISSION_SLIP_DAYS','')::int, 730));
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM activity_permission_slip_signatures x USING activity_permission_slips s
   WHERE x.slip_id=s.id AND s.district_id=d AND x.district_id=d AND s.due_on < current_date - days;
  DELETE FROM activity_permission_slips WHERE district_id=d AND due_on < current_date - days;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('activity_permission_slips', n);
END; $$;
REVOKE ALL ON FUNCTION eduos_retention_feature_activities(jsonb) FROM PUBLIC;
