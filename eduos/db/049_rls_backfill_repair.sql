-- Repair two data backfills that ran under forced row-level security
-- (found by the upgrade-path release gate, 2026-11-16).
--
-- Migrations run as the table owner with no tenant context, and the tenant
-- policies on students and notification_outbox have no owner exception, so a
-- plain statement over existing rows matches none of them:
--   043 built the student-name redaction index from `students`. On a database
--       that already had students, it indexed none, so text sent to an
--       external AI provider was not checked against those students' names
--       until their record was next edited. (Student numbers were still caught
--       through the generated compact-number column.)
--   044 moved skipped notifications' send time from delivered_at to
--       last_attempt_at. On existing rows it changed nothing, so skipped sends
--       still showed a delivery time.
-- Both are redone here district by district with that district's context
-- set. Safe to run on any database: rows already correct are left alone.
DO $$
DECLARE d uuid; prior text := current_setting('app.district_id', true);
BEGIN
  FOR d IN SELECT id FROM districts LOOP
    PERFORM set_config('app.district_id', d::text, true);
    INSERT INTO student_redact_tokens
    SELECT r.* FROM students s
     CROSS JOIN LATERAL eduos_student_redact_rows(s.district_id, s.id, s.display_name, s.local_student_number) r
     WHERE s.district_id = d
    ON CONFLICT DO NOTHING;
    UPDATE notification_outbox SET last_attempt_at = coalesce(last_attempt_at, delivered_at), delivered_at = NULL
     WHERE district_id = d AND status = 'skipped' AND delivered_at IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.district_id', coalesce(prior, ''), true);
END $$;
