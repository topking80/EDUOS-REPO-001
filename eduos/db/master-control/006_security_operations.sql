-- FED-08: security operations.
--
-- signing_keys: every key Master Control has signed policy bundles or
-- exchange terms with, by fingerprint. The key in use is 'active'; one it
-- moved on from is 'retired'. A 'revoked' key (compromised or withdrawn) is
-- never used again: Master Control refuses to sign with it even if its secret
-- is configured once more.
--
-- incidents: a security incident opened at a node. While open, it can freeze
-- exchanges that involve the node or anything under it (no deliveries,
-- reads, approvals or terms), and opening it can sign out everyone who holds
-- a role there.
SET search_path = master_control, pg_temp;

CREATE TABLE signing_keys (
  fingerprint text PRIMARY KEY CHECK (fingerprint ~ '^[0-9a-f]{32}$'),
  purpose text NOT NULL CHECK (purpose IN ('policy')),
  public_key text NOT NULL CHECK (length(public_key) BETWEEN 40 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired','revoked')),
  first_used_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 500),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE UNIQUE INDEX signing_keys_one_active ON signing_keys(purpose) WHERE status = 'active';

CREATE TABLE incidents (
  id text PRIMARY KEY CHECK (id ~ '^inc-[0-9a-f]{16}$'),
  node_id text NOT NULL REFERENCES nodes(id),
  severity text NOT NULL CHECK (severity IN ('low','moderate','high','critical')),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 5 AND 1000),
  freeze_exchange boolean NOT NULL,
  signed_out integer NOT NULL DEFAULT 0 CHECK (signed_out >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by text,
  closed_at timestamptz,
  close_note text CHECK (close_note IS NULL OR length(btrim(close_note)) BETWEEN 5 AND 1000),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL AND close_note IS NOT NULL))
);
CREATE INDEX incidents_open ON incidents(node_id) WHERE status = 'open';

-- When the producing district last replaced its EduOS exchange key.
ALTER TABLE exchange_agreements ADD COLUMN producer_key_rotated_at timestamptz;
