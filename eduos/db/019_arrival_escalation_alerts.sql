-- 34.6.0 durable escalation dedupe ledger.
CREATE TABLE arrival_escalation_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  handoff_id uuid NOT NULL,
  exception_kind text NOT NULL CHECK(exception_kind IN ('handoff_awaiting_receipt','first_attendance_missing')),
  severity text NOT NULL CHECK(severity IN ('medium','high')),
  threshold_minutes integer NOT NULL CHECK(threshold_minutes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY(district_id,handoff_id) REFERENCES arrival_handoffs(district_id,id),
  UNIQUE(district_id,handoff_id,exception_kind,severity)
);
CREATE INDEX arrival_escalation_school_day ON arrival_escalation_alerts(district_id,school_id,created_at DESC);
ALTER TABLE arrival_escalation_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE arrival_escalation_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY arrival_escalation_alert_scope ON arrival_escalation_alerts
 USING(district_id=eduos_ctx_district() AND
   (eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())))
 WITH CHECK(district_id=eduos_ctx_district() AND
   (eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())));
