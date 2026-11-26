-- FED-06: the exchange gateway (aggregates only).
--
-- An exchange agreement names a producer district, a recipient node, one
-- aggregate dataset, the agreed fields (a subset of the dataset's), a
-- purpose, a legal basis, a minimum cell size (5 or more), and an end date.
-- It is active only once the producer district has approved it (with the
-- public key its EduOS signs with) and the recipient has too. Either side
-- can revoke it; then nothing more is delivered or read. Deliveries are
-- signed envelopes from the district's EduOS, checked against the
-- agreement; they are append-only. No student-level data can be delivered.
SET search_path = master_control, pg_temp;

CREATE TABLE exchange_agreements (
  id text PRIMARY KEY,
  producer_node_id text NOT NULL REFERENCES nodes(id),
  recipient_node_id text NOT NULL REFERENCES nodes(id),
  dataset text NOT NULL CHECK (dataset IN ('enrollment_by_grade','sports_participation')),
  fields text[] NOT NULL CHECK (cardinality(fields) BETWEEN 1 AND 20),
  purpose text NOT NULL CHECK (purpose IN ('state_reporting','operations_planning','research_aggregate')),
  legal_basis text NOT NULL CHECK (length(legal_basis) BETWEEN 3 AND 500),
  min_cell_size integer NOT NULL CHECK (min_cell_size >= 5),
  effective_from date NOT NULL,
  effective_to date NOT NULL,
  producer_public_key text,
  producer_fingerprint text CHECK (producer_fingerprint IS NULL OR producer_fingerprint ~ '^[0-9a-f]{32}$'),
  producer_approved_by text REFERENCES operators(principal_id),
  producer_approved_at timestamptz,
  recipient_approved_by text REFERENCES operators(principal_id),
  recipient_approved_at timestamptz,
  status text NOT NULL CHECK (status IN ('proposed','active','revoked','expired')),
  revoked_by text REFERENCES operators(principal_id),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500),
  proposed_by text NOT NULL REFERENCES operators(principal_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (producer_node_id <> recipient_node_id),
  CHECK (effective_to >= effective_from),
  CHECK (status <> 'active' OR (producer_approved_at IS NOT NULL AND recipient_approved_at IS NOT NULL AND producer_public_key IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE exchange_deliveries (
  id text PRIMARY KEY,
  agreement_id text NOT NULL REFERENCES exchange_agreements(id),
  period_from date NOT NULL,
  period_to date NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count >= 0),
  suppressed_cells integer NOT NULL CHECK (suppressed_cells >= 0),
  envelope jsonb NOT NULL,
  delivered_by text NOT NULL REFERENCES operators(principal_id),
  delivered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, period_from, period_to, version)
);
CREATE TRIGGER exchange_deliveries_append_only BEFORE UPDATE OR DELETE ON exchange_deliveries FOR EACH ROW EXECUTE FUNCTION reject_change();
