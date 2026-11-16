-- Indexes for the two reads the role apps make most (performance).
--
-- The unread badge: every signed-in phone asks for its unread count every 30
-- seconds (GET /api/notifications?summary=1). This keeps it to that person's
-- unread rows instead of all their notifications.
CREATE INDEX IF NOT EXISTS notification_outbox_unread
  ON notification_outbox(district_id, recipient_user_id) WHERE channel = 'in_app' AND read_at IS NULL;

-- A school day's attendance (GET /api/attendance/day, the attendance-day lock
-- and the arrival paths): each student's latest observation on a date.
CREATE INDEX IF NOT EXISTS attendance_events_day_student
  ON attendance_events(district_id, event_date, student_id, observed_at DESC);
