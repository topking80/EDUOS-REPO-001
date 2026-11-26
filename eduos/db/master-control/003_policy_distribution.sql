-- FED-05: signed, versioned policy distribution from Master Control.
--
-- A release is made at a platform or state node and resolves the effective
-- policies of every active district below it (snapshot). Each district gets
-- its own signed bundle with a version that only goes up. A release can go
-- to pilot districts first; promoting it to the rest needs every pilot to
-- have accepted (or a recorded override). District leaders acknowledge or
-- object. A rollback is a new release that re-issues each affected
-- district's previous bundle content under a higher version. Bundles and
-- acknowledgements are append-only.
SET search_path = master_control, pg_temp;

CREATE TABLE policy_releases (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES nodes(id),
  kind text NOT NULL CHECK (kind IN ('release','rollback')),
  rollback_of text REFERENCES policy_releases(id),
  effective_from date NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  pilot_district_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  target_district_ids text[] NOT NULL,
  snapshot jsonb NOT NULL,
  catalog_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('piloting','published','rolled_back')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_by text,
  promoted_at timestamptz,
  promote_note text CHECK (promote_note IS NULL OR length(promote_note) <= 500),
  rolled_back_by_release text REFERENCES policy_releases(id),
  CHECK ((kind = 'rollback') = (rollback_of IS NOT NULL))
);

CREATE TABLE policy_bundles (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES policy_releases(id),
  district_node_id text NOT NULL REFERENCES nodes(id),
  version integer NOT NULL CHECK (version >= 1),
  stage text NOT NULL CHECK (stage IN ('pilot','general','rollback')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bundle jsonb NOT NULL,
  issued_by text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (district_node_id, version),
  UNIQUE (release_id, district_node_id)
);

CREATE TABLE policy_acknowledgements (
  id text PRIMARY KEY,
  bundle_id text NOT NULL REFERENCES policy_bundles(id),
  district_node_id text NOT NULL REFERENCES nodes(id),
  decision text NOT NULL CHECK (decision IN ('accepted','objected')),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  CHECK (decision = 'accepted' OR (note IS NOT NULL AND length(note) >= 3)),
  acknowledged_by text NOT NULL REFERENCES operators(principal_id),
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_acknowledgements_bundle ON policy_acknowledgements(bundle_id, acknowledged_at DESC);

CREATE TRIGGER policy_bundles_append_only BEFORE UPDATE OR DELETE ON policy_bundles FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER policy_acknowledgements_append_only BEFORE UPDATE OR DELETE ON policy_acknowledgements FOR EACH ROW EXECUTE FUNCTION reject_change();
