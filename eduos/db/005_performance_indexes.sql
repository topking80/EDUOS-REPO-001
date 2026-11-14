-- 005: performance indexes for high-volume read paths.
-- attendance_events previously had only foreign-key constraints and no read
-- index, so the attendance register (ORDER BY event_date DESC LIMIT) and the
-- per-student Student 360 attendance lookups fell back to sequential scans.

-- District-wide attendance register: ordered, bounded scan instead of seq scan + sort.
CREATE INDEX IF NOT EXISTS attendance_district_date
  ON attendance_events(district_id, event_date DESC);

-- Per-student attendance history (Student 360): direct index lookup per learner.
CREATE INDEX IF NOT EXISTS attendance_student_date
  ON attendance_events(district_id, student_id, event_date DESC);
