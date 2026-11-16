-- Notification delivery outcomes (release gate, emergency notifications).
--
-- delivered_at used to be set for 'skipped' rows too, so a dry run (the "log"
-- adapter) or a disabled channel looked like a confirmed delivery. From here
-- on delivered_at means a channel adapter confirmed delivery; every attempt
-- records last_attempt_at, and a failed attempt waits until next_attempt_at
-- (exponential back-off) instead of being retried on the very next run.
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
UPDATE notification_outbox SET last_attempt_at = delivered_at, delivered_at = NULL
 WHERE status = 'skipped' AND delivered_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_outbox_dispatch
  ON notification_outbox(district_id, created_at) WHERE status = 'pending' AND channel <> 'in_app';
CREATE INDEX IF NOT EXISTS notification_outbox_ref
  ON notification_outbox(district_id, ref_type, ref_id) WHERE ref_id IS NOT NULL;

-- Emergency recipients: only active accounts, and students in the incident's
-- own district (the link's district was already checked; the student's is now
-- too).
CREATE OR REPLACE FUNCTION eduos_safety_recipients(p_incident uuid, p_audience text) RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH i AS (SELECT id, school_id FROM safety_incidents WHERE id=p_incident AND district_id=eduos_ctx_district()
               AND (eduos_ctx_role()='superintendent' OR (eduos_ctx_role() IN ('principal','teacher','sro') AND school_id=eduos_ctx_school())))
  SELECT DISTINCT m.user_id FROM memberships m JOIN i ON m.school_id=i.school_id JOIN users u ON u.id=m.user_id AND u.status='active'
   WHERE p_audience='staff' AND m.district_id=eduos_ctx_district() AND m.status='active' AND m.role IN ('principal','teacher','driver','sro')
  UNION
  SELECT DISTINCT l.user_id FROM student_user_links l JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
    JOIN i ON s.school_id=i.school_id JOIN users u ON u.id=l.user_id AND u.status='active'
   WHERE p_audience='families' AND l.district_id=eduos_ctx_district() AND l.status='active' AND l.relationship IN ('parent','guardian')
$$;

-- Delivery report for one incident, for the school's leads. Recipients can
-- read only their own notifications (own_read), so the counts come from a
-- definer function that checks the caller leads the incident's school (or is
-- a superintendent in its district) and returns counts only: no recipients,
-- no text.
CREATE OR REPLACE FUNCTION eduos_safety_delivery(p_incident uuid)
RETURNS TABLE(channel text, status text, n integer, read_n integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH i AS (SELECT id FROM safety_incidents WHERE id=p_incident AND district_id=eduos_ctx_district()
               AND (eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())))
  SELECT o.channel, o.status, count(*)::int, count(o.read_at)::int
    FROM notification_outbox o JOIN i ON o.ref_id=i.id
   WHERE o.district_id=eduos_ctx_district() AND o.ref_type='safety_incident'
   GROUP BY o.channel, o.status
$$;
REVOKE ALL ON FUNCTION eduos_safety_delivery(uuid) FROM PUBLIC;
