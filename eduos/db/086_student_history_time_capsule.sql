-- TC-01: tenant-scoped student history and Time Capsule persistence foundation.
-- Binary media remains in the existing private_media_objects registry; this
-- migration stores only opaque asset references and descriptive metadata.

-- A composite key lets history attachments prove that the media object belongs
-- to the same district and originating school.
ALTER TABLE private_media_objects
  ADD CONSTRAINT private_media_objects_district_school_asset_uq
  UNIQUE (district_id, school_id, asset_id);

CREATE TABLE student_history_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN (
    'achievement','project','coursework','reflection','event',
    'portfolio_artifact','educator_note','system_milestone'
  )),
  classification text NOT NULL CHECK (classification IN (
    'official_record','family_memory','student_portfolio',
    'teacher_artifact','system_milestone'
  )),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 180),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 12000),
  occurred_at timestamptz NOT NULL,
  school_year text CHECK (school_year IS NULL OR length(trim(school_year)) BETWEEN 1 AND 32),
  audience text NOT NULL DEFAULT 'private'
    CHECK (audience IN ('private','student','family','classroom','school')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','published','restricted','archived','pending_deletion','deleted')),
  source_type text NOT NULL
    CHECK (source_type IN ('student','guardian','teacher','school','district','sis','system','other')),
  source_reference text CHECK (source_reference IS NULL OR length(source_reference) <= 256),
  author_user_id uuid,
  revision_no integer NOT NULL DEFAULT 1 CHECK (revision_no >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, author_user_id) REFERENCES memberships(district_id, user_id),
  UNIQUE (district_id, school_id, student_id, id)
);

CREATE INDEX student_history_entries_student_timeline_idx
  ON student_history_entries(district_id, student_id, occurred_at DESC, id DESC);
CREATE INDEX student_history_entries_school_status_idx
  ON student_history_entries(district_id, school_id, status, occurred_at DESC);
CREATE INDEX student_history_entries_classification_idx
  ON student_history_entries(district_id, student_id, classification, status);

CREATE TABLE student_history_entry_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no >= 1),
  actor_user_id uuid,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, actor_user_id) REFERENCES memberships(district_id, user_id),
  FOREIGN KEY (district_id, school_id, student_id, entry_id)
    REFERENCES student_history_entries(district_id, school_id, student_id, id) ON DELETE CASCADE,
  UNIQUE (district_id, entry_id, revision_no)
);
CREATE INDEX student_history_revisions_entry_idx
  ON student_history_entry_revisions(district_id, entry_id, revision_no DESC);

CREATE TABLE student_history_entry_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 500),
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 999),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, school_id, student_id, entry_id)
    REFERENCES student_history_entries(district_id, school_id, student_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, school_id, asset_id)
    REFERENCES private_media_objects(district_id, school_id, asset_id) ON DELETE RESTRICT,
  UNIQUE (district_id, entry_id, asset_id),
  UNIQUE (district_id, entry_id, position),
  UNIQUE (district_id, school_id, student_id, entry_id, id)
);
CREATE INDEX student_history_attachments_entry_idx
  ON student_history_entry_attachments(district_id, entry_id, position);

-- Capsule records are metadata and immutable history references only. Release
-- execution, consent checks, and recipient delivery are implemented in later PRs.
CREATE TABLE student_time_capsules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 180),
  message text NOT NULL DEFAULT '' CHECK (length(message) <= 12000),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sealed','scheduled','released','cancelled')),
  release_kind text NOT NULL DEFAULT 'scheduled'
    CHECK (release_kind IN ('scheduled','milestone')),
  release_at timestamptz,
  milestone_key text CHECK (milestone_key IS NULL OR length(trim(milestone_key)) BETWEEN 1 AND 80),
  timezone text NOT NULL DEFAULT 'UTC' CHECK (length(trim(timezone)) BETWEEN 1 AND 64),
  sealed_at timestamptz,
  released_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, owner_user_id) REFERENCES memberships(district_id, user_id),
  UNIQUE (district_id, school_id, student_id, id),
  CHECK (
    (release_kind = 'scheduled' AND release_at IS NOT NULL AND milestone_key IS NULL)
    OR (release_kind = 'milestone' AND release_at IS NULL AND milestone_key IS NOT NULL)
  ),
  CHECK ((status IN ('sealed','scheduled','released') AND sealed_at IS NOT NULL) OR status IN ('draft','cancelled')),
  CHECK ((status = 'released' AND released_at IS NOT NULL) OR (status <> 'released' AND released_at IS NULL)),
  CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL) OR (status <> 'cancelled' AND cancelled_at IS NULL))
);
CREATE INDEX student_time_capsules_due_idx
  ON student_time_capsules(status, release_at)
  WHERE status = 'scheduled';
CREATE INDEX student_time_capsules_student_idx
  ON student_time_capsules(district_id, student_id, created_at DESC);

CREATE TABLE student_time_capsule_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  capsule_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  attachment_id uuid,
  entry_revision_no integer NOT NULL CHECK (entry_revision_no >= 1),
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 999),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, school_id, student_id, capsule_id)
    REFERENCES student_time_capsules(district_id, school_id, student_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, school_id, student_id, entry_id)
    REFERENCES student_history_entries(district_id, school_id, student_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (district_id, school_id, student_id, entry_id, attachment_id)
    REFERENCES student_history_entry_attachments(district_id, school_id, student_id, entry_id, id) ON DELETE RESTRICT,
  UNIQUE (district_id, capsule_id, position),
);
CREATE INDEX student_time_capsule_items_capsule_idx
  ON student_time_capsule_items(district_id, capsule_id, position);

CREATE TABLE student_time_capsule_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  capsule_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  recipient_type text NOT NULL CHECK (recipient_type IN ('student','guardian','teacher','school_staff')),
  consent_status text NOT NULL DEFAULT 'pending'
    CHECK (consent_status IN ('pending','approved','denied','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, school_id, student_id, capsule_id)
    REFERENCES student_time_capsules(district_id, school_id, student_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, recipient_user_id) REFERENCES memberships(district_id, user_id),
  UNIQUE (district_id, capsule_id, recipient_user_id)
);
CREATE INDEX student_time_capsule_recipients_user_idx
  ON student_time_capsule_recipients(district_id, recipient_user_id, consent_status);

CREATE TABLE student_time_capsule_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  capsule_id uuid NOT NULL,
  actor_user_id uuid,
  event_type text NOT NULL CHECK (event_type IN (
    'created','item_added','recipient_added','sealed','scheduled',
    'release_attempted','released','cancelled','release_blocked'
  )),
  outcome text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','denied','failed')),
  reason_code text CHECK (reason_code IS NULL OR length(reason_code) <= 80),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, school_id, student_id, capsule_id)
    REFERENCES student_time_capsules(district_id, school_id, student_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, actor_user_id) REFERENCES memberships(district_id, user_id)
);
CREATE INDEX student_time_capsule_events_history_idx
  ON student_time_capsule_events(district_id, capsule_id, occurred_at DESC);

-- Every entry insert/update creates a revision in the same transaction. The
-- snapshot deliberately excludes attachment storage keys and binary content.
CREATE FUNCTION eduos_student_history_capture_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.revision_no := 1;
  ELSE
    NEW.revision_no := OLD.revision_no + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION eduos_student_history_write_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  INSERT INTO student_history_entry_revisions (
    district_id, school_id, student_id, entry_id, revision_no, actor_user_id, snapshot
  ) VALUES (
    NEW.district_id, NEW.school_id, NEW.student_id, NEW.id, NEW.revision_no, actor_id,
    jsonb_build_object(
      'entryType', NEW.entry_type,
      'classification', NEW.classification,
      'title', NEW.title,
      'body', NEW.body,
      'occurredAt', NEW.occurred_at,
      'schoolYear', NEW.school_year,
      'audience', NEW.audience,
      'status', NEW.status,
      'sourceType', NEW.source_type,
      'sourceReference', NEW.source_reference
    )
  );
  RETURN NULL;
END;
$$;

CREATE FUNCTION eduos_student_history_reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION eduos_student_history_capture_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_student_history_write_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_student_history_reject_immutable_mutation() FROM PUBLIC;

CREATE TRIGGER student_history_entry_revision_number
  BEFORE INSERT OR UPDATE ON student_history_entries
  FOR EACH ROW EXECUTE FUNCTION eduos_student_history_capture_revision();
CREATE TRIGGER student_history_entry_revision_snapshot
  AFTER INSERT OR UPDATE ON student_history_entries
  FOR EACH ROW EXECUTE FUNCTION eduos_student_history_write_revision();
CREATE TRIGGER student_history_revisions_append_only
  BEFORE UPDATE OR DELETE ON student_history_entry_revisions
  FOR EACH ROW EXECUTE FUNCTION eduos_student_history_reject_immutable_mutation();
CREATE TRIGGER student_time_capsule_events_append_only
  BEFORE UPDATE OR DELETE ON student_time_capsule_events
  FOR EACH ROW EXECUTE FUNCTION eduos_student_history_reject_immutable_mutation();

-- RLS is enforced at both district and originating-school boundaries. A
-- superintendent can administer the district's history across its schools;
-- student/guardian/teacher relationship checks remain an API authorization
-- responsibility and must be applied before each operation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'student_history_entries',
    'student_history_entry_revisions',
    'student_history_entry_attachments',
    'student_time_capsules',
    'student_time_capsule_items',
    'student_time_capsule_recipients',
    'student_time_capsule_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (
      district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid
      AND (school_id = nullif(current_setting(''app.school_id'', true), '''')::uuid
        OR current_setting(''app.role'', true) = ''superintendent'')
    ) WITH CHECK (
      district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid
      AND (school_id = nullif(current_setting(''app.school_id'', true), '''')::uuid
        OR current_setting(''app.role'', true) = ''superintendent'')
    )', t || '_district_school_scope', t);
  END LOOP;
END;
$$;
