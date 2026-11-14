-- Phase 32.0.34: connected family messaging and account-owned classroom preferences.
CREATE TABLE family_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  student_id uuid NOT NULL,
  sender_user_id uuid NOT NULL REFERENCES users(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CHECK(sender_user_id <> recipient_user_id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,sender_user_id) REFERENCES memberships(district_id,user_id),
  FOREIGN KEY(district_id,recipient_user_id) REFERENCES memberships(district_id,user_id)
);
CREATE INDEX family_messages_thread ON family_messages(district_id,student_id,created_at DESC);
CREATE INDEX family_messages_recipient ON family_messages(district_id,recipient_user_id,read_at,created_at DESC);

CREATE TABLE teacher_classroom_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  teacher_user_id uuid NOT NULL,
  room_label text NOT NULL CHECK(length(trim(room_label)) BETWEEN 1 AND 80),
  floor_number integer NOT NULL CHECK(floor_number BETWEEN 1 AND 100),
  layout text NOT NULL CHECK(layout IN ('rows','pods','u','groups')),
  seat_position text NOT NULL CHECK(seat_position IN ('front-left','front-center','front-right','side-left','side-right','back-center')),
  preference jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(pg_column_size(preference) <= 16384),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY(district_id,teacher_user_id) REFERENCES memberships(district_id,user_id),
  UNIQUE(district_id,teacher_user_id,school_id,room_label)
);
CREATE INDEX teacher_preferences_owner ON teacher_classroom_preferences(district_id,teacher_user_id,updated_at DESC);

ALTER TABLE family_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON family_messages
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
ALTER TABLE teacher_classroom_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_classroom_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teacher_classroom_preferences
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

-- Controlled SIS import ledger. This is an authenticated import adapter, not a
-- vendor-specific live connector; district staff initiate and review each batch.
CREATE TABLE sis_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  initiated_by uuid NOT NULL,
  source_system text NOT NULL CHECK(length(trim(source_system)) BETWEEN 1 AND 80),
  source_batch_id text NOT NULL CHECK(length(trim(source_batch_id)) BETWEEN 1 AND 160),
  status text NOT NULL CHECK(status IN ('completed','failed')),
  students_received integer NOT NULL DEFAULT 0 CHECK(students_received>=0),
  students_upserted integer NOT NULL DEFAULT 0 CHECK(students_upserted>=0),
  attendance_received integer NOT NULL DEFAULT 0 CHECK(attendance_received>=0),
  attendance_imported integer NOT NULL DEFAULT 0 CHECK(attendance_imported>=0),
  payload_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY(district_id,initiated_by) REFERENCES memberships(district_id,user_id),
  UNIQUE(district_id,source_system,source_batch_id)
);
CREATE TABLE sis_attendance_imports (
  district_id uuid NOT NULL REFERENCES districts(id),
  source_system text NOT NULL,
  source_event_id text NOT NULL,
  attendance_event_id uuid NOT NULL REFERENCES attendance_events(id),
  sync_run_id uuid NOT NULL REFERENCES sis_sync_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(district_id,source_system,source_event_id)
);
CREATE INDEX sis_sync_runs_school_time ON sis_sync_runs(district_id,school_id,created_at DESC);
ALTER TABLE sis_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sis_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sis_sync_runs
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
ALTER TABLE sis_attendance_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE sis_attendance_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sis_attendance_imports
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
