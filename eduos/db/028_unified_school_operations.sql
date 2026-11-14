-- 36.5.0 unified operations: deadlines, escalation levels and assignment controls.
ALTER TABLE school_service_work ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE school_service_work ADD COLUMN IF NOT EXISTS escalation_level integer NOT NULL DEFAULT 0 CHECK(escalation_level BETWEEN 0 AND 3);
ALTER TABLE school_service_work ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
CREATE INDEX IF NOT EXISTS school_service_work_due_idx ON school_service_work(district_id,school_id,due_at) WHERE status IN ('open','in_progress');
