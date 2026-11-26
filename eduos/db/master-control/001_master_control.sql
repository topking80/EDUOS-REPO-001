-- FED-03: Master Control, the federation administration plane.
--
-- Lives in its own schema (or its own database) and is reached by its own
-- runtime role, which is granted nothing outside this schema. It stores the
-- FED-02 authority model (education federation nodes, role assignments,
-- delegations, policy settings), the operators who may sign in, and a
-- hash-chained audit log of every decision. It holds no student, guardian
-- or staff records and cannot read any district table.
CREATE SCHEMA IF NOT EXISTS master_control;
SET search_path = master_control, pg_temp;

CREATE TABLE nodes (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  kind text NOT NULL CHECK (kind IN ('platform','state_education_authority','district','school')),
  parent_id text REFERENCES nodes(id),
  jurisdiction_id text CHECK (jurisdiction_id IS NULL OR jurisdiction_id ~ '^US-[A-Z]{2}$'),
  tenant_ref text CHECK (tenant_ref IS NULL OR length(tenant_ref) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('proposed','active','suspended','revoked','expired')),
  effective_from date NOT NULL,
  effective_to date,
  revoked_on date,
  suspended_on date,
  approval_reference text NOT NULL CHECK (length(approval_reference) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);
CREATE UNIQUE INDEX nodes_one_platform ON nodes ((kind)) WHERE kind = 'platform';

-- People who may sign in, by OIDC issuer + subject. principal_id is the
-- opaque identity the authority model uses.
CREATE TABLE operators (
  principal_id text PRIMARY KEY CHECK (principal_id ~ '^op-[a-z0-9-]{8,64}$'),
  oidc_issuer text NOT NULL CHECK (length(oidc_issuer) BETWEEN 1 AND 500),
  oidc_subject text NOT NULL CHECK (length(oidc_subject) BETWEEN 1 AND 255),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE role_assignments (
  id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES operators(principal_id),
  role_id text NOT NULL,
  node_id text NOT NULL REFERENCES nodes(id),
  status text NOT NULL CHECK (status IN ('proposed','active','suspended','revoked','expired')),
  effective_from date NOT NULL,
  effective_to date,
  revoked_on date,
  suspended_on date,
  approval_reference text NOT NULL CHECK (length(approval_reference) BETWEEN 1 AND 300),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);

CREATE TABLE delegations (
  id text PRIMARY KEY,
  from_assignment_id text REFERENCES role_assignments(id),
  from_delegation_id text REFERENCES delegations(id),
  delegate_principal_id text NOT NULL REFERENCES operators(principal_id),
  delegate_home_node_id text NOT NULL REFERENCES nodes(id),
  node_id text NOT NULL REFERENCES nodes(id),
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) BETWEEN 1 AND 20),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 3 AND 300),
  may_redelegate boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('proposed','active','suspended','revoked','expired')),
  effective_from date NOT NULL,
  effective_to date NOT NULL,
  revoked_on date,
  suspended_on date,
  approval_reference text NOT NULL CHECK (length(approval_reference) BETWEEN 1 AND 300),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CHECK ((from_assignment_id IS NULL) <> (from_delegation_id IS NULL))
);

CREATE TABLE policy_settings (
  id text PRIMARY KEY,
  policy_id text NOT NULL,
  node_id text NOT NULL REFERENCES nodes(id),
  value jsonb NOT NULL,
  lock_descendants boolean NOT NULL DEFAULT false,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('active','superseded','withdrawn')),
  effective_from date NOT NULL,
  effective_to date,
  set_by_assignment_id text NOT NULL REFERENCES role_assignments(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  UNIQUE (policy_id, node_id, version)
);

CREATE TABLE pending_logins (
  state_hash text PRIMARY KEY,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES operators(principal_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- Every decision Master Control makes (allowed, denied or rejected as
-- invalid), chained by SHA-256 so a removed or edited row is detectable.
CREATE TABLE audit_log (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  node_id text,
  capability text,
  decision text NOT NULL CHECK (decision IN ('allowed','denied','rejected')),
  reason text,
  basis jsonb,
  detail jsonb,
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_log_node ON audit_log(node_id, seq DESC);

CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'master_control.% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
