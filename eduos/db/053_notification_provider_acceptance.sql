-- Provider acceptance is not the same as confirmed end-device delivery.
-- Keep accepted messages terminal (no duplicate retry) without setting delivered_at.
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_status_check
  CHECK(status IN ('pending','accepted','delivered','skipped','failed'));
