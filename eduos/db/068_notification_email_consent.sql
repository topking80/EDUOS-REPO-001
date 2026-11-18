-- EduOS 37.7.2: district-scoped email notification consent.
-- Existing users are opted out; the timestamp records the most recent affirmative opt-in.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS email_notifications_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_notifications_consented_at timestamptz;
