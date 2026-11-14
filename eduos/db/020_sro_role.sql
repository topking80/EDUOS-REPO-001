-- 35.3.0: school-scoped School Resource Officer role.
-- SROs are intentionally excluded from student, attendance, transport,
-- pickup, and guardian data permissions; policy.js grants safety status only.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK(role IN ('superintendent','it_admin','principal','teacher','parent','pupil','driver','sro'));
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_school_scope_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_school_scope_check
  CHECK((role IN ('superintendent','it_admin') AND school_id IS NULL)
     OR (role NOT IN ('superintendent','it_admin') AND school_id IS NOT NULL));

ALTER TABLE flow_events DROP CONSTRAINT IF EXISTS flow_events_actor_role_check;
ALTER TABLE flow_events ADD CONSTRAINT flow_events_actor_role_check
  CHECK(actor_role IN ('superintendent','it_admin','principal','teacher','parent','pupil','driver','sro'));
ALTER TABLE flow_events DROP CONSTRAINT IF EXISTS flow_events_audience_check;
ALTER TABLE flow_events ADD CONSTRAINT flow_events_audience_check
  CHECK(cardinality(audience) BETWEEN 1 AND 8
    AND audience <@ ARRAY['superintendent','it_admin','principal','teacher','parent','pupil','driver','sro']::text[]);

-- Include SROs in generic incident staff notifications only. Family messages
-- remain separate and contain no student or classroom detail.
CREATE OR REPLACE FUNCTION eduos_safety_recipients(p_incident uuid, p_audience text) RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH i AS (SELECT id, school_id FROM safety_incidents WHERE id=p_incident AND district_id=eduos_ctx_district()
               AND (eduos_ctx_role()='superintendent' OR (eduos_ctx_role() IN ('principal','teacher','sro') AND school_id=eduos_ctx_school())))
  SELECT DISTINCT m.user_id FROM memberships m JOIN i ON m.school_id=i.school_id
   WHERE p_audience='staff' AND m.district_id=eduos_ctx_district() AND m.status='active' AND m.role IN ('principal','teacher','driver','sro')
  UNION
  SELECT DISTINCT l.user_id FROM student_user_links l JOIN students s ON s.id=l.student_id JOIN i ON s.school_id=i.school_id
   WHERE p_audience='families' AND l.district_id=eduos_ctx_district() AND l.status='active' AND l.relationship IN ('parent','guardian')
$$;
