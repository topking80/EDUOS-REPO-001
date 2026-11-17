-- 37.x FCM push consent and encrypted per-device token registry.
-- Existing users remain opted out; no device tokens are backfilled.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS push_notifications_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS push_notifications_consented_at timestamptz;

CREATE TABLE user_push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  platform text NOT NULL CHECK(platform IN ('ios','android')),
  token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  token_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(district_id,token_hash),
  FOREIGN KEY(user_id,district_id) REFERENCES user_preferences(user_id,district_id) ON DELETE CASCADE
);

CREATE INDEX user_push_devices_active_user
  ON user_push_devices(district_id,user_id,last_seen_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE user_push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_push_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_push_devices
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
CREATE POLICY own_user ON user_push_devices AS RESTRICTIVE
  USING (user_id = eduos_ctx_user() OR eduos_is_table_owner())
  WITH CHECK (user_id = eduos_ctx_user() OR eduos_is_table_owner());

GRANT SELECT, INSERT, UPDATE ON user_push_devices TO eduos_app;
REVOKE DELETE, TRUNCATE ON user_push_devices FROM eduos_app;
