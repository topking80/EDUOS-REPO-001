-- Vice principals act with the principal's authority, except that they can't
-- assign roles.
--
-- A vice principal's session runs with app.role = 'principal' (src/auth.js),
-- so every route check, permission and row policy that lets a principal act
-- at their school lets the vice principal act there too. The membership is
-- still 'vice_principal'; the session carries it in app.membership_role and
-- the audit log records it.
--
-- Principal-only, for vice principals (each refused here as well as in the
-- routes, whatever path reaches the table):
--   * staff, family and student accounts and their roles (users, memberships)
--   * coach and advisor assignments (activity_staff)
--   * room timetables (classroom_room_teachers)
--   * assigning the resource officer during an incident (route only: it is
--     a log event, not a table of its own)

CREATE FUNCTION eduos_ctx_membership_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.membership_role', true), ''), eduos_ctx_role())
$$;
CREATE FUNCTION eduos_ctx_is_vice_principal() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT eduos_ctx_membership_role() = 'vice_principal' $$;

-- The one relationship check that matched the session's role against the
-- membership row now matches the membership role.
CREATE OR REPLACE FUNCTION eduos_history_relation(p_district uuid, p_school uuid, p_student uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_district IS DISTINCT FROM eduos_ctx_district() OR eduos_ctx_user() IS NULL THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM memberships m WHERE m.district_id=p_district AND m.user_id=eduos_ctx_user()
          AND m.role=public.eduos_ctx_membership_role() AND m.school_id IS NOT DISTINCT FROM eduos_ctx_school() AND m.status='active') THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM students s WHERE s.id=p_student AND s.district_id=p_district) THEN NULL
    WHEN eduos_ctx_role()='superintendent' THEN 'district'
    WHEN eduos_ctx_role()='parent' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
          AND l.student_id=p_student AND l.user_id=eduos_ctx_user() AND l.status='active' AND l.relationship IN ('parent','guardian'))
          AND NOT public.eduos_custody_blocked(p_student, eduos_ctx_user()) AND NOT public.eduos_student_holds_rights(p_student) THEN 'guardian'
    WHEN eduos_ctx_role()='pupil' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
          AND l.student_id=p_student AND l.user_id=eduos_ctx_user() AND l.status='active' AND l.relationship='pupil') THEN 'student'
    WHEN eduos_ctx_role()='teacher' AND p_school=eduos_ctx_school() AND EXISTS (SELECT 1 FROM teacher_student_rosters r
          WHERE r.district_id=p_district AND r.school_id=p_school AND r.student_id=p_student AND r.teacher_user_id=eduos_ctx_user()) THEN 'teacher'
    WHEN eduos_ctx_role() IN ('principal','vice_principal') AND p_school=eduos_ctx_school() THEN 'school_lead'
  END
$$;

CREATE FUNCTION eduos_refuse_vice_principal_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF public.eduos_ctx_is_vice_principal() THEN
    RAISE EXCEPTION 'only the principal assigns this (%)', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_vice_principal_refused BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION eduos_refuse_vice_principal_assignment();
CREATE TRIGGER users_vice_principal_refused BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION eduos_refuse_vice_principal_assignment();
CREATE TRIGGER activity_staff_vice_principal_refused BEFORE INSERT OR UPDATE ON activity_staff
  FOR EACH ROW EXECUTE FUNCTION eduos_refuse_vice_principal_assignment();
CREATE TRIGGER classroom_room_teachers_vice_principal_refused BEFORE INSERT OR UPDATE ON classroom_room_teachers
  FOR EACH ROW EXECUTE FUNCTION eduos_refuse_vice_principal_assignment();

-- The audit log records who acted: a vice principal's entries say so, on
-- every path that writes one.
CREATE FUNCTION eduos_audit_membership_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_role = 'principal' AND public.eduos_ctx_is_vice_principal() AND NEW.actor_user_id = eduos_ctx_user() THEN
    NEW.actor_role := 'vice_principal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_events_membership_role BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION eduos_audit_membership_role();
