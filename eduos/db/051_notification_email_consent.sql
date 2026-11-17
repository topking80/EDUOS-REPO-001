-- 37.x notification email consent. Existing users are opted out by default.
-- The timestamp records the most recent affirmative opt-in; opting out does not
-- erase the historical timestamp. The preference is district-scoped and covered
-- by the existing user_preferences FORCE RLS / own_row policy.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS email_notifications_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_notifications_consented_at timestamptz;
