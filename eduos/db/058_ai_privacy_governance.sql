-- District-level governance gate for sending staff-entered content to an external AI processor.
-- External processing remains disabled until the superintendent explicitly enables it.
ALTER TABLE ai_district_policy
  ADD COLUMN external_provider_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN external_provider_acknowledged_at timestamptz,
  ADD COLUMN external_provider_acknowledged_by uuid REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE ai_district_policy
  ADD CONSTRAINT ai_external_provider_ack_required
  CHECK (NOT external_provider_enabled OR
    (external_provider_acknowledged_at IS NOT NULL AND external_provider_acknowledged_by IS NOT NULL));

COMMENT ON COLUMN ai_district_policy.external_provider_enabled IS
  'District opt-in gate for staff text leaving EduOS for an external AI processor; defaults off.';
COMMENT ON COLUMN ai_district_policy.external_provider_acknowledged_at IS
  'When the superintendent acknowledged the district external-AI privacy limitations.';
