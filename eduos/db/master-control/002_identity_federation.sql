-- FED-04: identity federation for Master Control.
--
-- * Trusted OIDC providers, each limited to the part of the federation it may
--   vouch for (scope node). The provider configured in MC_OIDC_* becomes the
--   "primary" provider, scoped to the platform (created at start-up).
-- * Client secrets are never stored: a provider names the environment
--   variable that holds its secret.
-- * Operators belong to one provider; invitations provision them (the
--   invitee signs in once with the named provider and the role is attached).
-- * Lifecycle: disabled operators and suspended providers lose all authority
--   from that day and every session ends; last sign-in is kept for reviews.
SET search_path = master_control, pg_temp;

CREATE TABLE identity_providers (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  issuer text NOT NULL UNIQUE CHECK (length(issuer) BETWEEN 8 AND 500),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 300),
  client_secret_env text NOT NULL CHECK (client_secret_env ~ '^MC_[A-Z0-9_]{3,60}$'),
  scopes text[] NOT NULL DEFAULT ARRAY['openid','profile','email'],
  scope_node_id text NOT NULL REFERENCES nodes(id),
  require_mfa boolean NOT NULL DEFAULT false,
  allowed_email_domains text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','retired')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);

ALTER TABLE operators
  ADD COLUMN idp_id text REFERENCES identity_providers(id),
  ADD COLUMN last_sign_in_at timestamptz,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_reason text CHECK (disabled_reason IS NULL OR length(disabled_reason) <= 300),
  ADD CONSTRAINT operators_disabled_consistent CHECK ((status = 'disabled') = (disabled_at IS NOT NULL));

ALTER TABLE pending_logins
  ADD COLUMN idp_id text,
  ADD COLUMN invitation_hash text;

CREATE TABLE invitations (
  id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  idp_id text NOT NULL REFERENCES identity_providers(id),
  node_id text NOT NULL REFERENCES nodes(id),
  role_id text NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  effective_to date,
  approval_reference text NOT NULL CHECK (length(approval_reference) BETWEEN 1 AND 300),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_by text REFERENCES operators(principal_id),
  accepted_at timestamptz,
  assignment_id text REFERENCES role_assignments(id),
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IS NULL OR length(revoked_reason) <= 300),
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)),
  CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);
CREATE INDEX invitations_node ON invitations(node_id, created_at DESC);
