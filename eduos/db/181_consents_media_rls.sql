-- SEC-01 part 6 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §5.1): athletic
-- association consents and club and sport media participation and consent.
-- The media tables were limited to the school (plus district roles) and the
-- athletic consents to the district, so a pupil or parent could read every
-- other family's consent decisions.
--
-- Pupils and parents now see only rows for the students they're linked to,
-- and write only as themselves for those students. Staff keep their existing
-- school (or district) scope. Whole-item totals that a parent's own consent
-- or a family's stream request depends on move into definers, so they still
-- count every participant, not just the caller's child.

CREATE POLICY family_read ON athlete_association_consents AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN (SELECT eduos_is_table_owner()) THEN true
    WHEN (SELECT eduos_ctx_role()) IN ('pupil', 'parent') THEN eduos_is_linked_student(student_id) ELSE true END);
CREATE POLICY family_insert ON athlete_association_consents AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent')
    OR ((SELECT eduos_ctx_role()) = 'parent' AND eduos_is_linked_student(student_id) AND granted_by = (SELECT eduos_ctx_user())));
CREATE POLICY family_update ON athlete_association_consents AS RESTRICTIVE FOR UPDATE
  USING ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent')
    OR ((SELECT eduos_ctx_role()) = 'parent' AND eduos_is_linked_student(student_id)))
  WITH CHECK ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent')
    OR ((SELECT eduos_ctx_role()) = 'parent' AND eduos_is_linked_student(student_id) AND revoked_by = (SELECT eduos_ctx_user())));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['activity_media_participants', 'activity_media_consents', 'activity_media_consent_history'] LOOP
    EXECUTE format($p$CREATE POLICY family_read ON %I AS RESTRICTIVE FOR SELECT
      USING (CASE WHEN (SELECT eduos_is_table_owner()) THEN true
        WHEN (SELECT eduos_ctx_role()) IN ('pupil', 'parent') THEN eduos_is_linked_student(student_id) ELSE true END)$p$, t);
  END LOOP;
END $$;
-- Families: a parent records consent as themselves for their own child; staff add participants.
CREATE POLICY family_insert ON activity_media_consents AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent')
    OR ((SELECT eduos_ctx_role()) = 'parent' AND eduos_is_linked_student(student_id) AND guardian_user_id = (SELECT eduos_ctx_user())));
CREATE POLICY family_update ON activity_media_consents AS RESTRICTIVE FOR UPDATE
  USING ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent')
    OR ((SELECT eduos_ctx_role()) = 'parent' AND guardian_user_id = (SELECT eduos_ctx_user())));
CREATE POLICY family_insert ON activity_media_consent_history AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent')
    OR ((SELECT eduos_ctx_role()) = 'parent' AND eduos_is_linked_student(student_id) AND guardian_user_id = (SELECT eduos_ctx_user())));
CREATE POLICY family_insert ON activity_media_participants AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent'));
CREATE POLICY family_update ON activity_media_participants AS RESTRICTIVE FOR UPDATE
  USING ((SELECT eduos_is_table_owner()) OR (SELECT eduos_ctx_role()) NOT IN ('pupil', 'parent')
    OR ((SELECT eduos_ctx_role()) = 'parent' AND eduos_is_linked_student(student_id)));

-- Totals across every participant of one media item (src/clubs-sports-routes.js consent).
CREATE FUNCTION eduos_media_consent_totals(p_asset uuid) RETURNS TABLE (total int, approved int, denied int, withdrawn int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*)::int FROM activity_media_participants p WHERE p.district_id = eduos_ctx_district() AND p.media_asset_id = p_asset),
         (SELECT count(*)::int FROM activity_media_participants p WHERE p.district_id = eduos_ctx_district() AND p.media_asset_id = p_asset AND p.consent_status = 'approved'),
         (SELECT count(*)::int FROM activity_media_participants p WHERE p.district_id = eduos_ctx_district() AND p.media_asset_id = p_asset AND p.consent_status = 'denied'),
         (SELECT count(*)::int FROM activity_media_consents k WHERE k.district_id = eduos_ctx_district() AND k.media_asset_id = p_asset AND k.status = 'withdrawn')
$$;
-- Participants without approved consent in an event's or activity's media (src/event-streaming-routes.js).
CREATE FUNCTION eduos_media_unconsented_count(p_school uuid, p_event uuid, p_activity uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(DISTINCT p.student_id)::int FROM activity_media_participants p
    JOIN activity_media_assets m ON m.id = p.media_asset_id AND m.district_id = p.district_id
   WHERE p.district_id = eduos_ctx_district() AND p.school_id = p_school
     AND (m.event_id = p_event OR (p_activity IS NOT NULL AND m.activity_id = p_activity))
     AND p.consent_status <> 'approved'
$$;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION eduos_media_consent_totals(uuid), eduos_media_unconsented_count(uuid, uuid, uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN
    GRANT EXECUTE ON FUNCTION eduos_media_consent_totals(uuid), eduos_media_unconsented_count(uuid, uuid, uuid) TO eduos_app;
  END IF;
END $$;
