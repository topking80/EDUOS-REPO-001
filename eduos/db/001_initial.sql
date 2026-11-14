CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE districts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_issuer text NOT NULL,
  oidc_subject text NOT NULL,
  display_name text NOT NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(oidc_issuer,oidc_subject)
);

CREATE TABLE schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  name text NOT NULL,
  school_level text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id,id)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  role text NOT NULL CHECK(role IN ('superintendent','principal','teacher','parent','pupil')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  is_default boolean NOT NULL DEFAULT false,
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  UNIQUE(district_id,user_id),
  CHECK((role='superintendent' AND school_id IS NULL) OR (role<>'superintendent' AND school_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_default_membership_per_user ON memberships(user_id) WHERE is_default=true;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY(district_id) REFERENCES districts(id)
);
CREATE INDEX sessions_active_lookup ON sessions(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  local_student_number text NOT NULL,
  display_name text NOT NULL,
  grade_level text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  UNIQUE(district_id,local_student_number),
  UNIQUE(district_id,id)
);

CREATE TABLE student_user_links (
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  student_id uuid NOT NULL,
  relationship text NOT NULL CHECK(relationship IN ('parent','guardian','pupil')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  PRIMARY KEY(user_id,student_id,relationship),
  FOREIGN KEY(district_id,user_id) REFERENCES memberships(district_id,user_id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id)
);

CREATE TABLE attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  student_id uuid NOT NULL,
  event_date date NOT NULL,
  status text NOT NULL,
  family_acknowledged_at timestamptz,
  family_acknowledged_by uuid REFERENCES users(id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_role text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  outcome text NOT NULL DEFAULT 'success',
  detail text,
  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_district_time ON audit_events(district_id,occurred_at DESC);

-- Defense in depth: audit rows are append-only through ordinary SQL roles.
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END; $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- RLS is enabled for tenant-owned data. The app DB role must not own these
-- tables and must not have BYPASSRLS. Set app.* only inside transactions.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['schools','students','student_user_links','attendance_events','audit_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid) WITH CHECK (district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- Restrict audit table writes to INSERT/SELECT only for the runtime role.
-- Apply grants to the dedicated runtime role after creating it:
-- REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM eduos_app;
