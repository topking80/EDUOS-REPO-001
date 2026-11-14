-- 36.8.0 shared staff daily workspace: checklists, shift handoffs and school notices.
CREATE TABLE IF NOT EXISTS school_staff_checklists (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
 domain text NOT NULL CHECK(domain IN ('general','facilities','health_office','counseling','meal_service','library','transport')),
 cadence text NOT NULL DEFAULT 'daily' CHECK(cadence IN ('daily','weekly','monthly','one_time')),
 active boolean NOT NULL DEFAULT true, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS school_staff_checklist_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), checklist_id uuid NOT NULL REFERENCES school_staff_checklists(id) ON DELETE CASCADE,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 240), position integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS school_staff_checklist_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, checklist_id uuid NOT NULL REFERENCES school_staff_checklists(id) ON DELETE CASCADE,
 item_id uuid NOT NULL REFERENCES school_staff_checklist_items(id) ON DELETE CASCADE, run_date date NOT NULL DEFAULT current_date,
 completed_by uuid REFERENCES users(id), completed_at timestamptz, UNIQUE(item_id,run_date)
);
CREATE TABLE IF NOT EXISTS school_staff_handoffs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, domain text NOT NULL CHECK(domain IN ('general','facilities','health_office','counseling','meal_service','library','transport')),
 summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 500), next_action text CHECK(next_action IS NULL OR length(next_action)<=300),
 from_user_id uuid NOT NULL REFERENCES users(id), to_user_id uuid REFERENCES users(id), acknowledged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS school_staff_announcements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 1200), audience text NOT NULL DEFAULT 'all_staff' CHECK(audience IN ('all_staff','operations_staff')),
 created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_handoffs_school_created_idx ON school_staff_handoffs(district_id,school_id,created_at DESC);
CREATE INDEX IF NOT EXISTS staff_announcements_school_created_idx ON school_staff_announcements(district_id,school_id,created_at DESC);
ALTER TABLE school_staff_checklists ENABLE ROW LEVEL SECURITY; ALTER TABLE school_staff_checklists FORCE ROW LEVEL SECURITY;
ALTER TABLE school_staff_checklist_items ENABLE ROW LEVEL SECURITY; ALTER TABLE school_staff_checklist_items FORCE ROW LEVEL SECURITY;
ALTER TABLE school_staff_checklist_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE school_staff_checklist_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE school_staff_handoffs ENABLE ROW LEVEL SECURITY; ALTER TABLE school_staff_handoffs FORCE ROW LEVEL SECURITY;
ALTER TABLE school_staff_announcements ENABLE ROW LEVEL SECURITY; ALTER TABLE school_staff_announcements FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['school_staff_checklists','school_staff_checklist_runs','school_staff_handoffs','school_staff_announcements'] LOOP
 EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_tenant_scope',t);
 EXECUTE format('CREATE POLICY %I ON %I USING(district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid) WITH CHECK(district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid)',t||'_tenant_scope',t);
END LOOP; END $$;
DO $$ BEGIN
 DROP POLICY IF EXISTS school_staff_checklist_items_tenant_scope ON school_staff_checklist_items;
 CREATE POLICY school_staff_checklist_items_tenant_scope ON school_staff_checklist_items USING(EXISTS(SELECT 1 FROM school_staff_checklists c WHERE c.id=checklist_id AND c.district_id=nullif(current_setting('app.district_id',true),'')::uuid)) WITH CHECK(EXISTS(SELECT 1 FROM school_staff_checklists c WHERE c.id=checklist_id AND c.district_id=nullif(current_setting('app.district_id',true),'')::uuid));
END $$;
