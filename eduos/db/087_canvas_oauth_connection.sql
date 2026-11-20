-- CANVAS-API-01: secure OAuth connection state and district-owned Canvas grants.
-- OAuth state is single-use and tenant/user/configuration bound. Tokens are
-- encrypted by the application with connector-specific associated data.
ALTER TABLE integration_connectors
  DROP CONSTRAINT IF EXISTS integration_connectors_kind_check;
ALTER TABLE integration_connectors
  ADD CONSTRAINT integration_connectors_kind_check
  CHECK (kind IN ('oneroster','edfi','powerschool','canvas'));

CREATE TABLE integration_canvas_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  user_id uuid NOT NULL,
  state_hash char(64) NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  config_version integer NOT NULL CHECK (config_version >= 1),
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id,connector_id) REFERENCES integration_connectors(district_id,id) ON DELETE CASCADE,
  FOREIGN KEY (district_id,user_id) REFERENCES district_users(district_id,user_id) ON DELETE CASCADE
);
CREATE INDEX integration_canvas_oauth_states_expiry ON integration_canvas_oauth_states(expires_at);

CREATE TABLE integration_canvas_oauth_grants (
  district_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  canvas_user_id text NOT NULL CHECK (length(canvas_user_id) BETWEEN 1 AND 100),
  canvas_user_name text CHECK (canvas_user_name IS NULL OR length(canvas_user_name) <= 200),
  access_token_enc text NOT NULL CHECK (length(access_token_enc) BETWEEN 20 AND 8192),
  refresh_token_enc text NOT NULL CHECK (length(refresh_token_enc) BETWEEN 20 AND 8192),
  expires_at timestamptz NOT NULL,
  granted_scope text[] NOT NULL DEFAULT '{}'::text[],
  authorized_by uuid NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  refresh_lease_token uuid,
  refresh_lease_until timestamptz,
  PRIMARY KEY (district_id,connector_id),
  CHECK ((refresh_lease_token IS NULL) = (refresh_lease_until IS NULL)),
  FOREIGN KEY (district_id,connector_id) REFERENCES integration_connectors(district_id,id) ON DELETE CASCADE,
  FOREIGN KEY (district_id,authorized_by) REFERENCES district_users(district_id,user_id)
);

DO $canvas$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['integration_canvas_oauth_states','integration_canvas_oauth_grants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON %I USING (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'',true),'''')::uuid) WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'',true),'''')::uuid)',t||'_tenant_scope',t);
  END LOOP;
END $canvas$;
