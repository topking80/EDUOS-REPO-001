-- Provider acceptance is terminal but is not confirmed end-device delivery.
-- Keep accepted messages from being retried while leaving delivered_at unset.
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_status_check
  CHECK(status IN ('pending','accepted','delivered','skipped','failed'));
