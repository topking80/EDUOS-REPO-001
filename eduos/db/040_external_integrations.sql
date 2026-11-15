-- External integrations: OneRoster 1.2 and Ed-Fi API connectors.
--
-- EduOS stays the system of record and runs without any of these. A district
-- adds a connector (IT admin or superintendent), a different district lead
-- approves it, and only then can anyone sync. Any change to where it connects,
-- its credentials or what it may import sends it back for approval.
-- Connectors only READ from the external system: no EduOS student data is sent
-- out. Client secrets are stored encrypted (AES-256-GCM, INTEGRATIONS_KEY on
-- the server) and are never returned by the API.

CREATE TABLE integration_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('oneroster','edfi')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  base_url text NOT NULL CHECK (length(base_url) BETWEEN 12 AND 2048),
  token_url text NOT NULL CHECK (length(token_url) BETWEEN 12 AND 2048),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 300),
  client_secret_enc text NOT NULL CHECK (length(client_secret_enc) BETWEEN 20 AND 4096),
  scope text CHECK (scope IS NULL OR length(scope) <= 1000),
  -- What the connector may change in EduOS. Students only, for now.
  data_scope text[] NOT NULL DEFAULT ARRAY['students'] CHECK (data_scope <@ ARRAY['students']::text[] AND cardinality(data_scope) >= 1),
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','active','disabled')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  disabled_by uuid REFERENCES users(id),
  disabled_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text CHECK (last_sync_status IS NULL OR last_sync_status IN ('previewed','completed','failed')),
  UNIQUE (district_id, name),
  UNIQUE (district_id, id),
  CHECK (status <> 'active' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by <> updated_by))
);

-- Which external school (OneRoster org sourcedId, Ed-Fi schoolId) is which
-- EduOS school. Students at unmapped schools are not imported.
CREATE TABLE integration_school_map (
  district_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 255),
  school_id uuid NOT NULL,
  mapped_by uuid NOT NULL REFERENCES users(id),
  mapped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, external_id),
  FOREIGN KEY (district_id, connector_id) REFERENCES integration_connectors(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id) ON DELETE CASCADE
);

CREATE TABLE integration_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('preview','apply')),
  status text NOT NULL CHECK (status IN ('previewed','completed','failed')),
  started_by uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(counts::text) <= 16384),
  -- Up to 200 rejected records: external id and reason only, no names.
  rejected jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rejected) = 'array' AND octet_length(rejected::text) <= 65536),
  error text CHECK (error IS NULL OR length(error) <= 300),
  FOREIGN KEY (district_id, connector_id) REFERENCES integration_connectors(district_id, id) ON DELETE CASCADE
);
CREATE INDEX integration_sync_runs_recent ON integration_sync_runs(connector_id, started_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connectors','integration_school_map','integration_sync_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid) '
                   'WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid)', t || '_tenant_scope', t);
  END LOOP;
END $$;
