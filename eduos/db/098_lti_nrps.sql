-- 098 (LTI-03): LTI Names and Role Provisioning Services 2.0 (class lists).
--
-- A tool gets a course's class list only when all of these hold:
--   * the district approved the tool's registration with NRPS turned on and
--     the roster_basic data scope (the approval fingerprint covers both);
--   * a teacher who manages that course turned sharing on for that tool
--     (lti_course_sharing);
--   * the tool proves itself with a client assertion signed by its registered
--     key, and calls with a short-lived token for this registration.
-- Members are only the course teacher and learners with active EduOS pupil
-- accounts linked to students actively enrolled in the course.
CREATE TABLE lti_course_sharing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  course_id uuid NOT NULL,
  app_id uuid NOT NULL,
  enabled_by uuid NOT NULL REFERENCES users(id),
  enabled_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, course_id) REFERENCES courses(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, app_id) REFERENCES apps(district_id, id),
  UNIQUE (district_id, course_id, app_id)
);
ALTER TABLE lti_course_sharing ENABLE ROW LEVEL SECURITY;
ALTER TABLE lti_course_sharing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lti_course_sharing
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);
-- Anyone who can see the course can see which tools get its class list.
CREATE POLICY see_course ON lti_course_sharing AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_see_course(course_id));
CREATE POLICY manage_course_insert ON lti_course_sharing AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(course_id)
    AND enabled_by = nullif(current_setting('app.user_id', true), '')::uuid));
CREATE POLICY manage_course_delete ON lti_course_sharing AS RESTRICTIVE FOR DELETE
  USING (eduos_is_table_owner() OR eduos_can_manage_course(course_id));

-- Each client assertion (jti) is accepted once per registration.
CREATE TABLE lti_service_assertions (
  district_id uuid NOT NULL REFERENCES districts(id),
  app_id uuid NOT NULL,
  jti text NOT NULL CHECK (length(jti) BETWEEN 8 AND 200),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (district_id, app_id, jti)
);
CREATE INDEX lti_service_assertions_expiry ON lti_service_assertions(expires_at);
-- Every class-list read by a tool.
CREATE TABLE lti_service_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  app_id uuid NOT NULL,
  course_id uuid,
  service text NOT NULL CHECK (service IN ('token','nrps_memberships')),
  members integer CHECK (members IS NULL OR members >= 0),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lti_service_access_log_app ON lti_service_access_log(district_id, app_id, at DESC);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['lti_service_assertions','lti_service_access_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'',true),'''')::uuid) WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'',true),'''')::uuid)', t);
  END LOOP;
END $$;

-- A shared course's class list, for the tool it is shared with, in the
-- caller's district only. Returns nothing unless the sharing row exists for
-- this exact app and the course is active.
CREATE FUNCTION eduos_lti_nrps_members(p_sharing uuid, p_app uuid)
RETURNS TABLE(course_id uuid, course_title text, user_id uuid, display_name text, email text, lti_role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid;
        c record;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'LTI service tenant context required' USING ERRCODE = '42501'; END IF;
  SELECT co.id, co.title, co.teacher_user_id, co.school_id INTO c
    FROM lti_course_sharing s JOIN courses co ON co.id = s.course_id AND co.district_id = s.district_id
   WHERE s.id = p_sharing AND s.app_id = p_app AND s.district_id = d AND co.status = 'active';
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
    SELECT c.id, c.title, u.id, u.display_name, u.email, 'Instructor'::text
      FROM users u JOIN memberships m ON m.user_id = u.id AND m.district_id = d AND m.role = 'teacher' AND m.status = 'active'
     WHERE u.id = c.teacher_user_id AND u.status = 'active'
    UNION
    SELECT c.id, c.title, u.id, u.display_name, u.email, 'Learner'::text
      FROM course_enrollments e
      JOIN student_user_links l ON l.student_id = e.student_id AND l.district_id = d AND l.relationship = 'pupil' AND l.status = 'active'
      JOIN users u ON u.id = l.user_id AND u.status = 'active'
      JOIN memberships m ON m.user_id = u.id AND m.district_id = d AND m.role = 'pupil' AND m.status = 'active'
     WHERE e.course_id = c.id AND e.district_id = d AND e.status = 'active';
END;
$$;
REVOKE ALL ON FUNCTION eduos_lti_nrps_members(uuid, uuid) FROM PUBLIC;
