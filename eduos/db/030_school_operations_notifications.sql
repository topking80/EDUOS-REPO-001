-- 36.7.0 operational notification preferences and idempotent delivery ledger.
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_kind_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_kind_check
 CHECK(kind IN ('announcement','message','transport','christie','moderation','safety','pickup','school_operations'));
CREATE TABLE IF NOT EXISTS school_ops_notification_preferences (
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 in_app_enabled boolean NOT NULL DEFAULT true,
 due_soon_enabled boolean NOT NULL DEFAULT true,
 overdue_enabled boolean NOT NULL DEFAULT true,
 escalation_enabled boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(district_id,user_id)
);
CREATE TABLE IF NOT EXISTS school_ops_notification_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 work_id uuid NOT NULL REFERENCES school_service_work(id) ON DELETE CASCADE,
 recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 notice_type text NOT NULL CHECK(notice_type IN ('due_soon','overdue','escalation')),
 notification_id uuid REFERENCES notification_outbox(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(work_id,recipient_user_id,notice_type)
);
ALTER TABLE school_ops_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_ops_notification_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE school_ops_notification_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_ops_notification_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS school_ops_notification_preferences_scope ON school_ops_notification_preferences;
CREATE POLICY school_ops_notification_preferences_scope ON school_ops_notification_preferences
 USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid AND user_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid AND user_id=nullif(current_setting('app.user_id',true),'')::uuid);
DROP POLICY IF EXISTS school_ops_notification_ledger_scope ON school_ops_notification_ledger;
CREATE POLICY school_ops_notification_ledger_scope ON school_ops_notification_ledger
 USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid)
 WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);
