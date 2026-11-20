-- Add the PowerSchool read-only roster adapter to the existing governed
-- integration pipeline. No new data scope or write permission is introduced.
ALTER TABLE integration_connectors
  DROP CONSTRAINT IF EXISTS integration_connectors_kind_check;
ALTER TABLE integration_connectors
  ADD CONSTRAINT integration_connectors_kind_check
  CHECK (kind IN ('oneroster', 'edfi', 'powerschool'));
