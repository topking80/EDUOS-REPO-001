-- 37.15.0: immutable guardian media-consent decision history.
CREATE TABLE IF NOT EXISTS activity_media_consent_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 media_asset_id uuid NOT NULL,
 student_id uuid NOT NULL,
 guardian_user_id uuid NOT NULL REFERENCES users(id),
 decision text NOT NULL CHECK(decision IN ('approved','denied','withdrawn')),
 decided_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(district_id,school_id,media_asset_id,student_id)
  REFERENCES activity_media_participants(district_id,school_id,media_asset_id,student_id)
);
CREATE INDEX IF NOT EXISTS activity_media_consent_history_lookup_idx
 ON activity_media_consent_history(district_id,school_id,media_asset_id,student_id,decided_at DESC);
ALTER TABLE activity_media_consent_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_media_consent_history FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_media_consent_history_tenant_scope ON activity_media_consent_history
 USING (
  district_id=nullif(current_setting('app.district_id',true),'')::uuid
  AND (school_id=nullif(current_setting('app.school_id',true),'')::uuid
       OR current_setting('app.role',true) IN ('superintendent','it_admin'))
 )
 WITH CHECK (
  district_id=nullif(current_setting('app.district_id',true),'')::uuid
  AND (school_id=nullif(current_setting('app.school_id',true),'')::uuid
       OR current_setting('app.role',true) IN ('superintendent','it_admin'))
);
