-- SEC-01 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §5.1), part 1: intervention
-- cases and case notes get per-student row security. Until now both had only
-- district isolation (db/004); the routes filtered, the database didn't.
--
-- Matching the routes (src/server.js /api/cases, student 360, records export):
--   superintendent: every case in the district;
--   principal (and vice principal, who runs as principal): cases at their school;
--   teacher: cases at their school that they own or opened, or for a student on their roster;
--   parent or guardian: cases about their own child that the school shared (family_visible),
--     and, inside those, only notes also marked family_visible;
--   pupils and every other role: none.
-- Writes: the same staff; families never write. Deletion stays with the owner
-- (records deletion and retention run as definer functions).

CREATE FUNCTION eduos_can_see_case(p_school uuid, p_student uuid, p_owner uuid, p_creator uuid, p_family_visible boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_owner_session()
    OR eduos_ctx_role() = 'superintendent'
    OR (eduos_ctx_role() = 'principal' AND p_school = eduos_ctx_school())
    OR (eduos_ctx_role() = 'teacher' AND p_school = eduos_ctx_school()
        AND (p_owner = eduos_ctx_user() OR p_creator = eduos_ctx_user() OR eduos_on_my_roster(p_student)))
    OR (eduos_ctx_role() = 'parent' AND p_family_visible AND eduos_is_linked_student(p_student))
$$;
CREATE FUNCTION eduos_can_see_case_note(p_case uuid, p_note_family_visible boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM student_intervention_cases c WHERE c.id = p_case AND c.district_id = eduos_ctx_district()
    AND eduos_can_see_case(c.school_id, c.student_id, c.owner_user_id, c.created_by, c.family_visible)
    AND (eduos_ctx_role() <> 'parent' OR p_note_family_visible))
$$;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION eduos_can_see_case(uuid, uuid, uuid, uuid, boolean), eduos_can_see_case_note(uuid, boolean) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN
    GRANT EXECUTE ON FUNCTION eduos_can_see_case(uuid, uuid, uuid, uuid, boolean), eduos_can_see_case_note(uuid, boolean) TO eduos_app;
  END IF;
END $$;

CREATE POLICY case_read ON student_intervention_cases AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_see_case(school_id, student_id, owner_user_id, created_by, family_visible));
CREATE POLICY case_insert ON student_intervention_cases AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() IN ('superintendent', 'principal', 'teacher')
    AND eduos_can_see_case(school_id, student_id, owner_user_id, created_by, family_visible)));
CREATE POLICY case_update ON student_intervention_cases AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR (eduos_ctx_role() IN ('superintendent', 'principal', 'teacher')
    AND eduos_can_see_case(school_id, student_id, owner_user_id, created_by, family_visible)))
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() IN ('superintendent', 'principal', 'teacher')
    AND eduos_can_see_case(school_id, student_id, owner_user_id, created_by, family_visible)));
CREATE POLICY case_delete ON student_intervention_cases AS RESTRICTIVE FOR DELETE USING (eduos_is_table_owner());

CREATE POLICY note_read ON student_case_notes AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_see_case_note(case_id, family_visible));
CREATE POLICY note_insert ON student_case_notes AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() IN ('superintendent', 'principal', 'teacher')
    AND author_user_id = eduos_ctx_user() AND eduos_can_see_case_note(case_id, true)));
CREATE POLICY note_delete ON student_case_notes AS RESTRICTIVE FOR DELETE USING (eduos_is_table_owner());

-- A note belongs to its case's student; a note can't be attached to another student's case.
CREATE FUNCTION eduos_case_note_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prev text := current_setting('app.district_id', true); ok boolean;
BEGIN
  -- The cases table's district isolation has no owner bypass, so look in the note's district.
  PERFORM set_config('app.district_id', NEW.district_id::text, true);
  ok := EXISTS (SELECT 1 FROM student_intervention_cases c WHERE c.id = NEW.case_id AND c.district_id = NEW.district_id AND c.student_id = NEW.student_id);
  PERFORM set_config('app.district_id', coalesce(prev, ''), true);
  IF NOT ok THEN RAISE EXCEPTION 'case note does not match its case' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eduos_case_note_bind() FROM PUBLIC;
CREATE TRIGGER student_case_notes_bind BEFORE INSERT ON student_case_notes FOR EACH ROW EXECUTE FUNCTION eduos_case_note_bind();
