-- 37.13.0: enforce district + school consistency in club/sports relationships.
-- Unique indexes provide composite referenced keys while retaining existing IDs.
CREATE UNIQUE INDEX IF NOT EXISTS school_activities_scope_id_uq ON school_activities(district_id,school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS school_events_scope_id_uq ON school_events(district_id,school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS event_ticket_types_scope_id_uq ON event_ticket_types(district_id,school_id,event_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS event_ticket_orders_scope_id_uq ON event_ticket_orders(district_id,school_id,event_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS activity_media_assets_scope_id_uq ON activity_media_assets(district_id,school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS students_scope_id_uq ON students(district_id,school_id,id);

DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='activity_staff_activity_school_fk') THEN
  ALTER TABLE activity_staff ADD CONSTRAINT activity_staff_activity_school_fk
   FOREIGN KEY(district_id,school_id,activity_id) REFERENCES school_activities(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='activity_memberships_activity_school_fk') THEN
  ALTER TABLE activity_memberships ADD CONSTRAINT activity_memberships_activity_school_fk
   FOREIGN KEY(district_id,school_id,activity_id) REFERENCES school_activities(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='school_events_activity_school_fk') THEN
  ALTER TABLE school_events ADD CONSTRAINT school_events_activity_school_fk
   FOREIGN KEY(district_id,school_id,activity_id) REFERENCES school_activities(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='event_ticket_types_event_school_fk') THEN
  ALTER TABLE event_ticket_types ADD CONSTRAINT event_ticket_types_event_school_fk
   FOREIGN KEY(district_id,school_id,event_id) REFERENCES school_events(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='event_ticket_orders_event_school_fk') THEN
  ALTER TABLE event_ticket_orders ADD CONSTRAINT event_ticket_orders_event_school_fk
   FOREIGN KEY(district_id,school_id,event_id) REFERENCES school_events(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='event_ticket_orders_type_school_fk') THEN
  ALTER TABLE event_ticket_orders ADD CONSTRAINT event_ticket_orders_type_school_fk
   FOREIGN KEY(district_id,school_id,event_id,ticket_type_id) REFERENCES event_ticket_types(district_id,school_id,event_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='event_tickets_order_school_fk') THEN
  ALTER TABLE event_tickets ADD CONSTRAINT event_tickets_order_school_fk
   FOREIGN KEY(district_id,school_id,event_id,order_id) REFERENCES event_ticket_orders(district_id,school_id,event_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='event_tickets_event_school_fk') THEN
  ALTER TABLE event_tickets ADD CONSTRAINT event_tickets_event_school_fk
   FOREIGN KEY(district_id,school_id,event_id) REFERENCES school_events(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='event_streams_event_school_fk') THEN
  ALTER TABLE event_streams ADD CONSTRAINT event_streams_event_school_fk
   FOREIGN KEY(district_id,school_id,event_id) REFERENCES school_events(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='activity_roster_activity_school_fk') THEN
  ALTER TABLE activity_roster_entries ADD CONSTRAINT activity_roster_activity_school_fk
   FOREIGN KEY(district_id,school_id,activity_id) REFERENCES school_activities(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='activity_results_activity_school_fk') THEN
  ALTER TABLE activity_event_results ADD CONSTRAINT activity_results_activity_school_fk
   FOREIGN KEY(district_id,school_id,activity_id) REFERENCES school_activities(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='activity_results_event_school_fk') THEN
  ALTER TABLE activity_event_results ADD CONSTRAINT activity_results_event_school_fk
   FOREIGN KEY(district_id,school_id,event_id) REFERENCES school_events(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='media_assets_activity_school_fk') THEN
  ALTER TABLE activity_media_assets ADD CONSTRAINT media_assets_activity_school_fk
   FOREIGN KEY(district_id,school_id,activity_id) REFERENCES school_activities(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='media_assets_event_school_fk') THEN
  ALTER TABLE activity_media_assets ADD CONSTRAINT media_assets_event_school_fk
   FOREIGN KEY(district_id,school_id,event_id) REFERENCES school_events(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='media_participants_asset_school_fk') THEN
  ALTER TABLE activity_media_participants ADD CONSTRAINT media_participants_asset_school_fk
   FOREIGN KEY(district_id,school_id,media_asset_id) REFERENCES activity_media_assets(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='media_consents_asset_school_fk') THEN
  ALTER TABLE activity_media_consents ADD CONSTRAINT media_consents_asset_school_fk
   FOREIGN KEY(district_id,school_id,media_asset_id) REFERENCES activity_media_assets(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='activity_roster_student_school_fk') THEN
  ALTER TABLE activity_roster_entries ADD CONSTRAINT activity_roster_student_school_fk
   FOREIGN KEY(district_id,school_id,student_id) REFERENCES students(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='media_participant_student_school_fk') THEN
  ALTER TABLE activity_media_participants ADD CONSTRAINT media_participant_student_school_fk
   FOREIGN KEY(district_id,school_id,student_id) REFERENCES students(district_id,school_id,id);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='media_consent_student_school_fk') THEN
  ALTER TABLE activity_media_consents ADD CONSTRAINT media_consent_student_school_fk
   FOREIGN KEY(district_id,school_id,student_id) REFERENCES students(district_id,school_id,id);
 END IF;
END $$;
