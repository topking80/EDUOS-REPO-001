-- EduOS 36.4.0 specialized school operations roles and work queues.
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='memberships'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%role%'
 LOOP EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT %I',r.conname); END LOOP;
 ALTER TABLE memberships ADD CONSTRAINT memberships_role_36_4_check CHECK(role IN
 ('superintendent','it_admin','principal','vice_principal','teacher','parent','pupil','driver','sro','librarian','counselor','nurse','maintenance','lunch_staff'));
END $$;
CREATE TABLE IF NOT EXISTS school_service_work (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 domain text NOT NULL CHECK(domain IN ('facilities','health_office','counseling','meal_service')),
 kind text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed','cancelled')),
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
 details text, created_by uuid NOT NULL REFERENCES users(id), assigned_to uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS school_service_work_queue_idx ON school_service_work(district_id,school_id,domain,status,created_at DESC);
ALTER TABLE school_service_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_service_work FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS school_service_work_tenant ON school_service_work;
CREATE POLICY school_service_work_tenant ON school_service_work
 USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid)
 WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);
