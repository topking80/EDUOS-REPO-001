-- SEC-07 (docs/CONCURRENCY.md): a quiz attempt is submitted once, however
-- many submits arrive together. The open-attempt check ran before the UPDATE,
-- and the UPDATE matched on id alone, so a second submit that waited on the
-- row lock still updated it (moving submitted_at) and went on to add the
-- attempt's mastery evidence a second time. Re-checking the status in the
-- UPDATE itself means the waiter, re-reading the row after the first commits,
-- matches nothing and gets attempt_not_open.
CREATE OR REPLACE FUNCTION eduos_quiz_submit(p_attempt uuid) RETURNS TABLE(id uuid, late boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT eduos_my_open_attempt(p_attempt) THEN RETURN; END IF;
  RETURN QUERY UPDATE quiz_attempts a SET status='needs_review', submitted_at=now(),
      late = (a.deadline_at IS NOT NULL AND now() > a.deadline_at + interval '60 seconds')
    WHERE a.id=p_attempt AND a.status='in_progress' RETURNING a.id, a.late;
END; $$;
