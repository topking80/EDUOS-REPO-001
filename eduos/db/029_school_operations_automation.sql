-- 36.6.0 recurring school operations schedules and reminder ledger.
CREATE TABLE IF NOT EXISTS school_operation_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 domain text NOT NULL CHECK(domain IN ('facilities','health_office','counseling','meal_service')),
 kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 60),
 summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 300),
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 cadence text NOT NULL CHECK(cadence IN ('daily','weekly','monthly')),
 next_run_at timestamptz NOT NULL,
 active boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS school_operation_schedules_due_idx ON school_operation_schedules(next_run_at) WHERE active=true;
ALTER TABLE school_operation_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_operation_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS school_operation_schedules_scope ON school_operation_schedules;
CREATE POLICY school_operation_schedules_scope ON school_operation_schedules
 USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid)
 WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);
ALTER TABLE school_service_work ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES school_operation_schedules(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS school_service_work_schedule_occurrence_idx ON school_service_work(schedule_id,created_at) WHERE schedule_id IS NOT NULL;
