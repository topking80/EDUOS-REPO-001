-- SEC-01 part 4 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §5.1): the student
-- directory row itself. students had only district isolation since db/001, so
-- any signed-in pupil or parent could list every student in the district.
--
-- Now pupils and parents (or guardians) see only the students they're linked
-- to, at any school. Staff and system roles keep district-wide reads for now:
-- SIS sync, arrival handoffs, guardian contributions across schools, pickers and
-- definers all read students that way. Narrowing staff to their school is
-- follow-up SEC-08, done route by route. Definers run as the owner and are unaffected.
CREATE POLICY student_read ON students AS RESTRICTIVE FOR SELECT
  USING (CASE
    WHEN eduos_is_table_owner() THEN true
    WHEN eduos_ctx_role() IN ('pupil', 'parent') THEN eduos_is_linked_student(id)
    ELSE true END);

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
