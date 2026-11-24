-- SAFE-01b: vice principals start and lead safety alerts.
--
-- Until now a vice principal could see a live alert but not start one, and
-- couldn't run the accountability board, start reunification or give the all
-- clear. They now can, at their own school, exactly as the principal does.
--
-- The pick-up desk is unchanged: eduos_safety_lead/eduos_safety_staff also
-- govern pick-up adults, passes and releases (db/013), so the safety tables
-- get their own incident-lead and incident-staff checks instead of widening
-- those two functions.

CREATE FUNCTION eduos_safety_incident_staff(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_safety_staff(p_school) OR (eduos_ctx_role() = 'vice_principal' AND p_school = eduos_ctx_school())
$$;
CREATE FUNCTION eduos_safety_incident_lead(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_safety_lead(p_school) OR (eduos_ctx_role() = 'vice_principal' AND p_school = eduos_ctx_school())
$$;

DROP POLICY scope_insert ON safety_incidents;
DROP POLICY scope_update ON safety_incidents;
CREATE POLICY scope_insert ON safety_incidents AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (initiated_by = eduos_ctx_user() AND eduos_safety_incident_staff(school_id)));
CREATE POLICY scope_update ON safety_incidents AS RESTRICTIVE FOR UPDATE
  USING (eduos_safety_incident_lead(school_id) OR (eduos_safety_staff(school_id) AND initiated_by = eduos_ctx_user()))
  WITH CHECK (eduos_safety_incident_lead(school_id) OR (eduos_safety_staff(school_id) AND initiated_by = eduos_ctx_user()));

DROP POLICY scope_read ON safety_events;
DROP POLICY scope_insert ON safety_events;
CREATE POLICY scope_read ON safety_events AS RESTRICTIVE FOR SELECT USING (eduos_safety_incident_staff(school_id));
CREATE POLICY scope_insert ON safety_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (actor_user_id = eduos_ctx_user() AND eduos_safety_incident_staff(school_id)));

-- Roll call: the vice principal reads the whole school's (for the board); taking
-- roll call stays with teachers and the principal.
DROP POLICY scope_read ON safety_rollcall_entries;
CREATE POLICY scope_read ON safety_rollcall_entries AS RESTRICTIVE FOR SELECT
  USING (eduos_safety_incident_lead(school_id) OR (eduos_ctx_role() = 'teacher' AND recorded_by = eduos_ctx_user()));

-- Alerts reach vice principals; a vice principal's alert reaches everyone.
CREATE OR REPLACE FUNCTION eduos_safety_recipients(p_incident uuid, p_audience text) RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH i AS (SELECT id, school_id FROM safety_incidents WHERE id=p_incident AND district_id=eduos_ctx_district()
               AND (eduos_ctx_role()='superintendent' OR (eduos_ctx_role() IN ('principal','vice_principal','teacher','sro') AND school_id=eduos_ctx_school())))
  SELECT DISTINCT m.user_id FROM memberships m JOIN i ON m.school_id=i.school_id JOIN users u ON u.id=m.user_id AND u.status='active'
   WHERE p_audience='staff' AND m.district_id=eduos_ctx_district() AND m.status='active' AND m.role IN ('principal','vice_principal','teacher','driver','sro')
  UNION
  SELECT DISTINCT l.user_id FROM student_user_links l JOIN students s ON s.id=l.student_id AND s.district_id=l.district_id
    JOIN i ON s.school_id=i.school_id JOIN users u ON u.id=l.user_id AND u.status='active'
   WHERE p_audience='families' AND l.district_id=eduos_ctx_district() AND l.status='active' AND l.relationship IN ('parent','guardian')
$$;

-- The delivery report on the board.
CREATE OR REPLACE FUNCTION eduos_safety_delivery(p_incident uuid)
RETURNS TABLE(channel text, status text, n integer, read_n integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH i AS (SELECT id FROM safety_incidents WHERE id=p_incident AND district_id=eduos_ctx_district()
               AND (eduos_ctx_role()='superintendent' OR (eduos_ctx_role() IN ('principal','vice_principal') AND school_id=eduos_ctx_school())))
  SELECT o.channel, o.status, count(*)::int, count(o.read_at)::int
    FROM notification_outbox o JOIN i ON o.ref_id=i.id
   WHERE o.district_id=eduos_ctx_district() AND o.ref_type='safety_incident'
   GROUP BY o.channel, o.status
$$;

-- Roll-call alerts (missing / injured) go to vice principals too.
CREATE OR REPLACE FUNCTION eduos_school_leads() RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.user_id FROM memberships m WHERE m.district_id=eduos_ctx_district() AND m.school_id=eduos_ctx_school()
     AND m.role IN ('principal','vice_principal') AND m.status='active' AND eduos_ctx_role() IN ('principal','vice_principal','teacher','parent')
$$;
