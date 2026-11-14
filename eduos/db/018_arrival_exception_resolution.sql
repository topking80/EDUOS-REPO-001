-- 34.5.0: durable principal/superintendent exception workflow.
CREATE TABLE arrival_exception_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  handoff_id uuid NOT NULL,
  exception_kind text NOT NULL CHECK (exception_kind IN ('handoff_awaiting_receipt','first_attendance_missing')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  assigned_to uuid REFERENCES users(id),
  opened_by uuid NOT NULL REFERENCES users(id),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id,school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY (district_id,handoff_id) REFERENCES arrival_handoffs(district_id,id),
  UNIQUE (district_id,handoff_id,exception_kind),
  CHECK ((status='open' AND acknowledged_by IS NULL AND acknowledged_at IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
      OR (status='acknowledged' AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL AND resolved_by IS NULL AND resolved_at IS NULL)
      OR (status='resolved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX arrival_exception_work_queue ON arrival_exception_resolutions(district_id,school_id,status,updated_at DESC);
CREATE TABLE arrival_exception_resolution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  resolution_id uuid NOT NULL REFERENCES arrival_exception_resolutions(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  event text NOT NULL CHECK (event IN ('assigned','acknowledged','resolved','reopened')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX arrival_exception_resolution_log ON arrival_exception_resolution_events(district_id,resolution_id,occurred_at,id);
CREATE FUNCTION reject_arrival_exception_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'arrival_exception_resolution_events are append-only'; END; $$;
CREATE TRIGGER arrival_exception_events_no_update BEFORE UPDATE OR DELETE ON arrival_exception_resolution_events
FOR EACH ROW EXECUTE FUNCTION reject_arrival_exception_event_mutation();

ALTER TABLE arrival_exception_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE arrival_exception_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY arrival_exception_resolution_scope ON arrival_exception_resolutions
 USING (district_id=eduos_ctx_district() AND
   (eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())))
 WITH CHECK (district_id=eduos_ctx_district() AND
   (eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())));
ALTER TABLE arrival_exception_resolution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE arrival_exception_resolution_events FORCE ROW LEVEL SECURITY;
CREATE POLICY arrival_exception_resolution_event_scope ON arrival_exception_resolution_events
 USING (district_id=eduos_ctx_district() AND EXISTS (
   SELECT 1 FROM arrival_exception_resolutions r WHERE r.id=resolution_id
 ))
 WITH CHECK (district_id=eduos_ctx_district() AND actor_user_id=eduos_ctx_user() AND EXISTS (
   SELECT 1 FROM arrival_exception_resolutions r WHERE r.id=resolution_id
 ));
