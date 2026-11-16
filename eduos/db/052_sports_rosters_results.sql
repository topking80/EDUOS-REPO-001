-- 37.7.0: sports rosters and approved game results.
CREATE TABLE IF NOT EXISTS activity_roster_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 activity_id uuid NOT NULL REFERENCES school_activities(id) ON DELETE CASCADE,
 student_id uuid NOT NULL,
 jersey_number smallint CHECK(jersey_number BETWEEN 0 AND 99),
 position text NOT NULL DEFAULT '' CHECK(length(position)<=80),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 added_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
 UNIQUE(district_id,activity_id,student_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS activity_roster_active_number_idx
 ON activity_roster_entries(district_id,activity_id,jersey_number)
 WHERE status='active' AND jersey_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_roster_scope_idx
 ON activity_roster_entries(district_id,school_id,activity_id,status);
CREATE TABLE IF NOT EXISTS activity_event_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 activity_id uuid NOT NULL REFERENCES school_activities(id) ON DELETE CASCADE,
 event_id uuid NOT NULL REFERENCES school_events(id) ON DELETE CASCADE,
 opponent text NOT NULL CHECK(length(opponent) BETWEEN 1 AND 120),
 home_score smallint NOT NULL CHECK(home_score BETWEEN 0 AND 999),
 away_score smallint NOT NULL CHECK(away_score BETWEEN 0 AND 999),
 summary text NOT NULL DEFAULT '' CHECK(length(summary)<=1500),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 recorded_by uuid NOT NULL REFERENCES users(id),
 approved_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(district_id,event_id)
);
CREATE INDEX IF NOT EXISTS activity_results_public_idx
 ON activity_event_results(district_id,school_id,activity_id,status,created_at DESC);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['activity_roster_entries','activity_event_results'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_tenant_scope',t);
  EXECUTE format('CREATE POLICY %I ON %I USING (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid) WITH CHECK (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid)',t||'_tenant_scope',t);
 END LOOP;
END $$;
