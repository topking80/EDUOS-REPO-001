-- 37.x verified SMS notification consent. Phone numbers are stored per
-- district because a user may have separate contact channels by membership.
-- All existing accounts remain opted out and unverified.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS phone_e164 text,
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_notifications_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_notifications_consented_at timestamptz;

ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_phone_e164_check
  CHECK(phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_phone_verification_pair_check
  CHECK((phone_e164 IS NULL) = (phone_verified_at IS NULL));

ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_sms_requires_verified_phone_check
  CHECK(NOT sms_notifications_enabled OR (phone_e164 IS NOT NULL AND phone_verified_at IS NOT NULL));
