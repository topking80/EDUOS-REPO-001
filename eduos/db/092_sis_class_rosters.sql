-- SIS-04: class rosters from the district's SIS (read-only).
--
-- A connector can now also import who teaches whom: the SIS's teachers,
-- class sections and enrollments become teacher rosters in EduOS (which decide
-- what a teacher can see of a student, including student history). It is a
-- separate data scope, off unless a district lead turns it on, and turning it
-- on, like any connector change, needs a different lead's approval.
--
-- * Teachers are matched to EduOS teachers who already exist; no account is
--   ever created. A match is either an exact email match to one active teacher
--   at the mapped school, or a manual match a lead recorded (which, like
--   school mapping, needs approval again).
-- * Only roster rows the connector created are added or removed by it. Rows a
--   person entered by hand are never touched.

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'public.integration_connectors'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%data_scope%';
  EXECUTE format('ALTER TABLE integration_connectors DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE integration_connectors ADD CONSTRAINT integration_connectors_data_scope_check
  CHECK (data_scope <@ ARRAY['students','class_rosters']::text[] AND 'students' = ANY(data_scope));

-- Where a roster row came from: a person (created_by) or a connector.
ALTER TABLE teacher_student_rosters ADD COLUMN source_connector_id uuid, ADD COLUMN synced_at timestamptz;
ALTER TABLE teacher_student_rosters ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE teacher_student_rosters ADD CONSTRAINT teacher_student_rosters_origin
  CHECK ((created_by IS NOT NULL) <> (source_connector_id IS NOT NULL));
ALTER TABLE teacher_student_rosters ADD CONSTRAINT teacher_student_rosters_source_connector
  FOREIGN KEY (district_id, source_connector_id) REFERENCES integration_connectors(district_id, id) ON DELETE CASCADE;
CREATE INDEX teacher_student_rosters_source ON teacher_student_rosters(district_id, source_connector_id) WHERE source_connector_id IS NOT NULL;

-- Manual teacher matches, for SIS teachers whose email doesn't match.
CREATE TABLE integration_staff_map (
  district_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 255),
  user_id uuid NOT NULL,
  mapped_by uuid NOT NULL REFERENCES users(id),
  mapped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, external_id),
  FOREIGN KEY (district_id, connector_id) REFERENCES integration_connectors(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, user_id) REFERENCES district_users(district_id, user_id)
);
ALTER TABLE integration_staff_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_staff_map FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_staff_map
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
