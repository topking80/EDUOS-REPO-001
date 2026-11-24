-- TC-05 (export): a safe copy of a student's history.
--
-- A person downloads what they can already see of one student's history,
-- nothing more: the same database visibility rules decide every item. The
-- file is made on request and sent straight back; there is no stored copy and
-- no link to share. Every download is logged (the student, their guardians
-- and the records office see it under "Who looked") and audited.
--
-- Who may download: the student; their guardians (while the guardian still
-- has access); a guardian the student shares with; the school's leaders and
-- the superintendent. Not teachers (they see their own students' items in
-- class) and not emergency access (that is to read, for four hours).
--
-- Limits against bulk copying: 5 downloads per person per student per hour,
-- and 20 per person per day across all students, checked here.

ALTER TABLE history_access_log DROP CONSTRAINT history_access_log_action_check;
ALTER TABLE history_access_log ADD CONSTRAINT history_access_log_action_check
  CHECK (action IN ('view_history','view_capsule','export_history'));

CREATE FUNCTION eduos_history_export_allowed(p_student uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN (SELECT count(*) FROM history_access_log WHERE district_id = eduos_ctx_district() AND user_id = eduos_ctx_user()
            AND student_id = p_student AND action = 'export_history' AND at > now() - interval '1 hour') >= 5 THEN 'too_many_for_this_student'
    WHEN (SELECT count(*) FROM history_access_log WHERE district_id = eduos_ctx_district() AND user_id = eduos_ctx_user()
            AND action = 'export_history' AND at > now() - interval '1 day') >= 20 THEN 'too_many_today'
    ELSE NULL END
$$;
