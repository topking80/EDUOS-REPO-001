-- SEC-01 part 4 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §5.1): the student
-- directory row itself. students had only district isolation since db/001, so
-- any signed-in pupil or parent could list every student in the district.
--
-- Now pupils and parents (or guardians) see only the students they're linked
-- to, at any school. Staff and system roles keep district-wide reads for now:
-- SIS sync, arrival handoffs, guardian contributions across schools, pickers and
-- definers all read students that way. Narrowing staff to their school is
-- follow-up SEC-08, done route by route. Definers run as the owner and are unaffected.
-- Context checks are wrapped as (SELECT ...) so Postgres runs each once per
-- query (an InitPlan), not once per row: listing or joining a whole school
-- stays fast (test/integration/performance-paths.test.js).
CREATE POLICY student_read ON students AS RESTRICTIVE FOR SELECT
  USING (CASE
    WHEN (SELECT eduos_is_table_owner()) THEN true
    WHEN (SELECT eduos_ctx_role()) IN ('pupil', 'parent') THEN eduos_is_linked_student(id)
    ELSE true END);

-- The same treatment for the attendance read policy (db/178), which shares the
-- school-day query with students.
ALTER POLICY attendance_read ON attendance_events
  USING (CASE
    WHEN (SELECT eduos_is_table_owner()) THEN true
    WHEN (SELECT eduos_ctx_role()) IN ('superintendent', 'it_admin') THEN true
    WHEN (SELECT eduos_ctx_role()) IN ('principal', 'teacher', 'librarian') THEN
      student_id IN (SELECT s.id FROM students s WHERE s.district_id = (SELECT eduos_ctx_district()) AND s.school_id = (SELECT eduos_ctx_school()))
    WHEN (SELECT eduos_ctx_role()) = 'driver' THEN
      student_id IN (SELECT ra.student_id FROM transport_rider_assignments ra JOIN transport_routes r ON r.id = ra.route_id AND r.district_id = ra.district_id
                      WHERE ra.district_id = (SELECT eduos_ctx_district()) AND r.driver_user_id = (SELECT eduos_ctx_user()))
    WHEN (SELECT eduos_ctx_role()) IN ('pupil', 'parent') THEN eduos_is_linked_student(student_id)
    ELSE false END);

-- AI redaction must still find every student in the district that a text
-- names, whoever wrote it, before the text may leave for an external provider
-- (src/student-identifiers.js). With students now school-scoped, the lookup
-- moves into definers that return only the matches (names and numbers), and
-- the runtime role loses direct reads of the token index.
CREATE FUNCTION eduos_student_identifiers_match(p_words text[]) RETURNS TABLE (display_name text, local_student_number text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH words AS (SELECT DISTINCT w FROM unnest(p_words) w)
  SELECT s.display_name, s.local_student_number FROM students s WHERE s.district_id = eduos_ctx_district() AND s.id IN (
      SELECT t.student_id FROM student_redact_tokens t JOIN words ON words.w = t.token
       WHERE t.district_id = eduos_ctx_district() AND t.kind = 'name' AND t.long
      UNION
      SELECT t.student_id FROM student_redact_tokens t JOIN words ON words.w = t.token
       WHERE t.district_id = eduos_ctx_district() GROUP BY t.student_id, t.kind HAVING count(*) = min(t.n)
      UNION
      SELECT s2.id FROM students s2 JOIN words ON words.w = s2.redact_number_compact WHERE s2.district_id = eduos_ctx_district())
$$;
CREATE FUNCTION eduos_student_identifiers_nospace(p_text text) RETURNS TABLE (display_name text, local_student_number text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.display_name, s.local_student_number FROM students s
   WHERE s.district_id = eduos_ctx_district() AND s.redact_name_nospace
     AND (EXISTS (SELECT 1 FROM unnest(eduos_redact_tokens(s.display_name)) w WHERE char_length(w) >= 2 AND strpos(p_text, w) > 0)
       OR NOT EXISTS (SELECT 1 FROM unnest(eduos_redact_tokens(s.display_name)) w WHERE strpos(p_text, w) = 0))
$$;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION eduos_student_identifiers_match(text[]), eduos_student_identifiers_nospace(text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN
    GRANT EXECUTE ON FUNCTION eduos_student_identifiers_match(text[]), eduos_student_identifiers_nospace(text) TO eduos_app;
    REVOKE SELECT ON student_redact_tokens FROM eduos_app;
  END IF;
END $$;

-- The guardian-contribution integrity check (db/087) must see the student
-- whatever the caller can list; it only compares keys, so it runs as a definer.
ALTER FUNCTION eduos_history_contribution_school_guard() SECURITY DEFINER;
