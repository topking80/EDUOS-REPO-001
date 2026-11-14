-- 33.8.0: authoritative arrival handoff records, separate from browser-local demo.
CREATE TABLE arrival_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('bus','car_rider','walk_in')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','cancelled')),
  transport_run_id uuid,
  assigned_teacher_user_id uuid,
  initiated_by uuid NOT NULL REFERENCES users(id),
  received_by uuid REFERENCES users(id),
  initiated_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz,
  note text CHECK (note IS NULL OR length(note) <= 500),
  UNIQUE(district_id,id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id,id),
  FOREIGN KEY (district_id, transport_run_id) REFERENCES transport_runs(district_id,id),
  FOREIGN KEY (district_id, assigned_teacher_user_id) REFERENCES district_users(district_id,user_id),
  CHECK ((status='received' AND received_by IS NOT NULL AND received_at IS NOT NULL)
      OR (status<>'received' AND received_by IS NULL AND received_at IS NULL))
);
CREATE INDEX arrival_handoffs_school_day ON arrival_handoffs(district_id,school_id,initiated_at DESC);
CREATE INDEX arrival_handoffs_teacher_pending ON arrival_handoffs(district_id,assigned_teacher_user_id,status);
CREATE UNIQUE INDEX arrival_handoffs_one_pending_student ON arrival_handoffs(district_id,student_id) WHERE status='pending';

CREATE TABLE arrival_handoff_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  handoff_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  event text NOT NULL CHECK (event IN ('initiated','received','cancelled','attendance_recorded')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id,handoff_id) REFERENCES arrival_handoffs(district_id,id)
);
CREATE INDEX arrival_handoff_events_log ON arrival_handoff_events(district_id,handoff_id,occurred_at,id);
CREATE FUNCTION reject_arrival_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'arrival_handoff_events are append-only'; END; $$;
CREATE TRIGGER arrival_events_no_update BEFORE UPDATE OR DELETE ON arrival_handoff_events
FOR EACH ROW EXECUTE FUNCTION reject_arrival_event_mutation();

ALTER TABLE arrival_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE arrival_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY arrival_handoff_read_scope ON arrival_handoffs FOR SELECT
 USING (
   district_id=eduos_ctx_district() AND (
     eduos_ctx_role()='superintendent'
     OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())
     OR (eduos_ctx_role()='driver' AND initiated_by=eduos_ctx_user())
     OR (eduos_ctx_role()='teacher' AND (assigned_teacher_user_id=eduos_ctx_user() OR eduos_on_my_roster(student_id)))
   )
 );
CREATE POLICY arrival_handoff_create_scope ON arrival_handoffs FOR INSERT
 WITH CHECK (
   district_id=eduos_ctx_district() AND (
     (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school() AND method IN ('car_rider','walk_in'))
     OR (eduos_ctx_role()='driver' AND initiated_by=eduos_ctx_user() AND method='bus')
   )
 );
CREATE POLICY arrival_handoff_receive_scope ON arrival_handoffs FOR UPDATE
 USING (
   district_id=eduos_ctx_district() AND (
     (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())
     OR (eduos_ctx_role()='teacher' AND (assigned_teacher_user_id=eduos_ctx_user() OR eduos_on_my_roster(student_id)))
   )
 )
 WITH CHECK (
   district_id=eduos_ctx_district() AND status='received' AND received_by=eduos_ctx_user()
   AND received_at IS NOT NULL
   AND ((eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())
     OR (eduos_ctx_role()='teacher' AND (assigned_teacher_user_id=eduos_ctx_user() OR eduos_on_my_roster(student_id))))
 );
ALTER TABLE arrival_handoff_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE arrival_handoff_events FORCE ROW LEVEL SECURITY;
CREATE POLICY arrival_handoff_event_scope ON arrival_handoff_events
 USING (
   district_id=eduos_ctx_district() AND EXISTS (
     SELECT 1 FROM arrival_handoffs h WHERE h.id=arrival_handoff_events.handoff_id
   )
 )
 WITH CHECK (
   district_id=eduos_ctx_district() AND actor_user_id=eduos_ctx_user() AND EXISTS (
     SELECT 1 FROM arrival_handoffs h WHERE h.id=arrival_handoff_events.handoff_id
   )
 );
