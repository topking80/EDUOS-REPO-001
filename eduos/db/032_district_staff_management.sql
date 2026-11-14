-- 36.9.0 district staff scheduling, absence and substitute coverage workflow.
CREATE TABLE IF NOT EXISTS staff_absence_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, staff_user_id uuid NOT NULL REFERENCES users(id),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, reason_category text NOT NULL CHECK(reason_category IN ('personal','professional_development','other')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','cancelled')),
 reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_at>starts_at)
);
CREATE TABLE IF NOT EXISTS staff_shift_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, staff_user_id uuid NOT NULL REFERENCES users(id),
 shift_date date NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 department text NOT NULL CHECK(department IN ('instruction','transport','facilities','health_office','counseling','meal_service','library','administration','other')),
 assignment text NOT NULL CHECK(length(assignment) BETWEEN 1 AND 240), status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','confirmed','completed','cancelled')),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), CHECK(ends_at>starts_at)
);
CREATE TABLE IF NOT EXISTS substitute_coverage_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, absence_id uuid REFERENCES staff_absence_requests(id),
 requested_by uuid NOT NULL REFERENCES users(id), department text NOT NULL CHECK(department IN ('instruction','transport','facilities','health_office','counseling','meal_service','library','administration','other')),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, role_needed text NOT NULL CHECK(length(role_needed) BETWEEN 1 AND 100),
 details text CHECK(details IS NULL OR length(details)<=500), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','assigned','declined','cancelled')),
 assigned_user_id uuid REFERENCES users(id), reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CHECK(ends_at>starts_at)
);
CREATE INDEX IF NOT EXISTS staff_absence_school_dates_idx ON staff_absence_requests(district_id,school_id,starts_at,ends_at,status);
CREATE INDEX IF NOT EXISTS staff_shift_school_date_idx ON staff_shift_assignments(district_id,school_id,shift_date,department);
CREATE INDEX IF NOT EXISTS substitute_coverage_school_status_idx ON substitute_coverage_requests(district_id,school_id,status,starts_at);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['staff_absence_requests','staff_shift_assignments','substitute_coverage_requests'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_tenant_scope',t);
 EXECUTE format('CREATE POLICY %I ON %I USING(district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid) WITH CHECK(district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid)',t||'_tenant_scope',t);
END LOOP; END $$;
