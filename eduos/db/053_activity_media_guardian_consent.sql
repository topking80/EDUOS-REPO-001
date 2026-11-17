-- 37.8.0: participant-level guardian consent for club/sports media.
CREATE TABLE IF NOT EXISTS activity_media_participants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 media_asset_id uuid NOT NULL REFERENCES activity_media_assets(id) ON DELETE CASCADE,
 student_id uuid NOT NULL,
 consent_status text NOT NULL DEFAULT 'pending' CHECK(consent_status IN ('pending','approved','denied')),
 added_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
 UNIQUE(district_id,media_asset_id,student_id)
);
CREATE INDEX IF NOT EXISTS activity_media_participants_scope_idx ON activity_media_participants(district_id,school_id,media_asset_id,consent_status);
CREATE TABLE IF NOT EXISTS activity_media_consents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 media_asset_id uuid NOT NULL REFERENCES activity_media_assets(id) ON DELETE CASCADE,
 student_id uuid NOT NULL,
 guardian_user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL CHECK(status IN ('approved','denied','withdrawn')),
 decided_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
 UNIQUE(district_id,media_asset_id,student_id,guardian_user_id)
);
CREATE INDEX IF NOT EXISTS activity_media_consents_guardian_idx ON activity_media_consents(district_id,guardian_user_id,student_id,media_asset_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['activity_media_participants','activity_media_consents'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_tenant_scope',t);
  EXECUTE format('CREATE POLICY %I ON %I USING (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid) WITH CHECK (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid)',t||'_tenant_scope',t);
 END LOOP;
END $$;
