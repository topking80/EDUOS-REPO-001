-- 37.14.0: enforce school scope in addition to district RLS for clubs/sports data.
-- District leaders retain cross-school visibility; school users are confined to their active school context.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'school_activities','activity_staff','activity_memberships','school_events',
  'event_ticket_types','event_ticket_orders','event_tickets','event_streams',
  'activity_media_assets','activity_roster_entries','activity_event_results',
  'activity_media_participants','activity_media_consents','private_media_objects'
 ] LOOP
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_tenant_scope',t);
  EXECUTE format(
   'CREATE POLICY %I ON %I
      USING (
       district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid
       AND (
        school_id=nullif(current_setting(''app.school_id'',true),'''')::uuid
        OR current_setting(''app.role'',true) IN (''superintendent'',''it_admin'')
       )
      )
      WITH CHECK (
       district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid
       AND (
        school_id=nullif(current_setting(''app.school_id'',true),'''')::uuid
        OR current_setting(''app.role'',true) IN (''superintendent'',''it_admin'')
       )
      )',t||'_tenant_scope',t);
 END LOOP;
END $$;
