-- 35.5.0: district-owned SRO deployment policy.
CREATE TABLE IF NOT EXISTS sro_district_policies (
  district_id uuid PRIMARY KEY REFERENCES districts(id) ON DELETE CASCADE,
  allowed_school_ids uuid[] NULL,
  require_superintendent_approval boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
ALTER TABLE sro_district_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE sro_district_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sro_district_policy_scope ON sro_district_policies;
CREATE POLICY sro_district_policy_scope ON sro_district_policies
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
