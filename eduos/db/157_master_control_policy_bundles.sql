-- FED-05: policy bundles a district received from Master Control.
--
-- The superintendent uploads the signed bundle Master Control issued for the
-- district. EduOS checks the signature against MC_POLICY_PUBLIC_KEY, that it
-- is addressed to this district, and that its version is newer than any
-- already received, then keeps it as received. Nothing is applied: district
-- settings are unchanged. Read by the superintendent and IT administrator.
CREATE TABLE district_policy_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  bundle_id text NOT NULL CHECK (length(bundle_id) BETWEEN 1 AND 80),
  release_id text NOT NULL CHECK (length(release_id) BETWEEN 1 AND 80),
  version integer NOT NULL CHECK (version >= 1),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  previous_sha256 text CHECK (previous_sha256 IS NULL OR previous_sha256 ~ '^[0-9a-f]{64}$'),
  key_fingerprint text NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{32}$'),
  bundle jsonb NOT NULL CHECK (jsonb_typeof(bundle) = 'object'),
  received_by uuid NOT NULL REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (district_id, bundle_id),
  UNIQUE (district_id, version)
);
ALTER TABLE district_policy_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_policy_bundles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON district_policy_bundles
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);
CREATE POLICY district_admin_read ON district_policy_bundles AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('superintendent','it_admin'));
CREATE POLICY superintendent_insert ON district_policy_bundles AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND received_by = nullif(current_setting('app.user_id', true), '')::uuid));
CREATE TRIGGER district_policy_bundles_append_only BEFORE UPDATE OR DELETE ON district_policy_bundles
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
