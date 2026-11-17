-- EduOS 37.6.0 (candidate): Enrollment funnel (deck p47).
-- inquiry -> applied -> documents -> review -> offered -> accepted -> enrolled,
-- with a waitlist and new-student seats per school, year and grade. Families
-- apply from their parent account and see only their own applications; school
-- leaders (principal for their school, superintendent for all) run the board.
-- Numbered 062: 051-057 and 060 are clubs & sports (#47), 058 is the district
-- AI privacy controls (#48), 059 Leo/Edison; the 37.6 branches are 061-064.
-- src/migrate.js applies every numbered file after 050 in name order.

-- Notification kind 'enrollment', added without dropping kinds other
-- migrations added (order-independent).
DO $$
DECLARE def text; kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='notification_outbox'::regclass AND conname='notification_outbox_kind_check';
  -- Reads both forms PostgreSQL prints: ARRAY['a'::text, ...] (as created
  -- by 013/030) and '{a,b}'::text[] (after another widening like this one),
  -- so the 37.6 migrations can widen the list in any order.
  kinds := ARRAY(SELECT DISTINCT (regexp_matches(def, '[''{,]([a-z0-9_]+)(?=[''},])', 'g'))[1]);
  IF NOT 'enrollment' = ANY(kinds) THEN
    kinds := kinds || 'enrollment'::text;
    ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;
    EXECUTE format('ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_kind_check CHECK(kind = ANY(%L::text[]))', kinds);
  END IF;
END $$;

CREATE TABLE enrollment_capacity (
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  school_year text NOT NULL CHECK(school_year ~ '^[0-9]{4}-[0-9]{2}$'),
  grade_level text NOT NULL CHECK(grade_level ~ '^(PK|K|[0-9]{1,2})$'),
  seats integer NOT NULL CHECK(seats BETWEEN 0 AND 5000),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(district_id,school_id,school_year,grade_level),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE SEQUENCE enrollment_waitlist_seq;
CREATE TABLE enrollment_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  school_year text NOT NULL CHECK(school_year ~ '^[0-9]{4}-[0-9]{2}$'),
  grade_level text NOT NULL CHECK(grade_level ~ '^(PK|K|[0-9]{1,2})$'),
  status text NOT NULL CHECK(status IN ('inquiry','applied','documents','review','offered','accepted','enrolled','waitlisted','declined','withdrawn')),
  source text NOT NULL CHECK(source IN ('family','staff')),
  child_first_name text NOT NULL CHECK(length(btrim(child_first_name)) BETWEEN 1 AND 80),
  child_last_name text NOT NULL CHECK(length(btrim(child_last_name)) BETWEEN 1 AND 80),
  child_birth_date date CHECK(child_birth_date IS NULL OR child_birth_date > date '1990-01-01'),
  guardian_user_id uuid REFERENCES users(id),
  guardian_name text NOT NULL CHECK(length(btrim(guardian_name)) BETWEEN 1 AND 120),
  guardian_email text CHECK(guardian_email IS NULL OR (length(guardian_email) BETWEEN 3 AND 320 AND guardian_email ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  guardian_phone text CHECK(guardian_phone IS NULL OR guardian_phone ~ '^[0-9 ()+.-]{7,30}$'),
  waitlist_seq bigint,
  offer_expires_on date,
  student_id uuid,
  submitted_at timestamptz,
  decided_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((status='waitlisted') = (waitlist_seq IS NOT NULL)),
  CHECK((status='enrolled') = (student_id IS NOT NULL)),
  CHECK(source='staff' OR guardian_user_id IS NOT NULL),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id)
);
CREATE INDEX enrollment_apps_board ON enrollment_applications(district_id,school_id,school_year,status,created_at);
CREATE INDEX enrollment_apps_guardian ON enrollment_applications(district_id,guardian_user_id) WHERE guardian_user_id IS NOT NULL;
CREATE TABLE enrollment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  application_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text CHECK(note IS NULL OR length(note) <= 500),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_role text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,application_id) REFERENCES enrollment_applications(district_id,id)
);
CREATE INDEX enrollment_events_app ON enrollment_events(application_id,at);
CREATE TRIGGER enrollment_events_append_only BEFORE UPDATE OR DELETE ON enrollment_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
-- Documents: PDF/PNG/JPEG only (checked by magic bytes in the API), <= 2 MB,
-- held only until the retention window after the decision (see purge below).
CREATE TABLE enrollment_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  application_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('proof_of_residence','birth_certificate','immunization_record','prior_school_records','custody_document','other')),
  filename text NOT NULL CHECK(filename ~ '^[A-Za-z0-9 ._()-]{1,120}$'),
  mime text NOT NULL CHECK(mime IN ('application/pdf','image/png','image/jpeg')),
  bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 2097152),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','verified','rejected')),
  review_note text CHECK(review_note IS NULL OR length(review_note) <= 300),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CHECK(octet_length(content) = bytes),
  FOREIGN KEY(district_id,application_id) REFERENCES enrollment_applications(district_id,id)
);
CREATE INDEX enrollment_documents_app ON enrollment_documents(district_id,application_id);

CREATE FUNCTION eduos_my_application(p_app uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role()='parent' AND EXISTS(SELECT 1 FROM enrollment_applications a WHERE a.id=p_app
    AND a.district_id=eduos_ctx_district() AND a.guardian_user_id=eduos_ctx_user())
$$;
CREATE FUNCTION eduos_leads_application(p_app uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM enrollment_applications a WHERE a.id=p_app AND a.district_id=eduos_ctx_district()
    AND (eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND a.school_id=eduos_ctx_school())))
$$;

-- Status machine, enforced in SQL as well as in src/enrollment-model.js.
CREATE FUNCTION eduos_enrollment_transition_ok(p_from text, p_to text, p_family boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from = p_to THEN true
    WHEN p_to = 'withdrawn' THEN p_from IN ('inquiry','applied','documents','review','waitlisted','offered','accepted')
    WHEN p_family THEN (p_from, p_to) IN (('inquiry','applied'),('documents','review'),('offered','accepted'),('offered','declined'))
    ELSE (p_from, p_to) IN (('inquiry','applied'),('applied','documents'),('applied','review'),('documents','review'),
      ('review','documents'),('review','offered'),('review','waitlisted'),('review','declined'),
      ('waitlisted','offered'),('waitlisted','declined'),('offered','accepted'),('offered','declined'),('offered','waitlisted'),
      ('accepted','enrolled'))
  END
$$;
CREATE FUNCTION eduos_enrollment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE family boolean := NOT eduos_owner_session() AND eduos_ctx_role() = 'parent';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF family AND (NEW.status NOT IN ('inquiry','applied') OR NEW.source <> 'family' OR NEW.guardian_user_id IS DISTINCT FROM eduos_ctx_user()) THEN
      RAISE EXCEPTION 'families start an application as inquiry or applied, for themselves' USING ERRCODE='42501';
    END IF;
    IF NEW.status NOT IN ('inquiry','applied') AND NOT eduos_owner_session() THEN
      RAISE EXCEPTION 'an application starts as inquiry or applied' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT eduos_owner_session() AND NOT eduos_is_table_owner() THEN
    IF NOT eduos_enrollment_transition_ok(OLD.status, NEW.status, family) THEN
      RAISE EXCEPTION 'enrollment transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE='42501';
    END IF;
    -- Moving to enrolled happens only inside eduos_enrollment_complete().
    IF NEW.status='enrolled' AND OLD.status<>'enrolled' THEN
      RAISE EXCEPTION 'use eduos_enrollment_complete to enroll' USING ERRCODE='42501';
    END IF;
    -- A family may only clear its own waitlist place (by withdrawing or declining).
    IF family AND ((NEW.school_id, NEW.school_year, NEW.grade_level, NEW.guardian_user_id, NEW.source, NEW.student_id)
        IS DISTINCT FROM (OLD.school_id, OLD.school_year, OLD.grade_level, OLD.guardian_user_id, OLD.source, OLD.student_id)
        OR (NEW.waitlist_seq IS NOT NULL AND NEW.waitlist_seq IS DISTINCT FROM OLD.waitlist_seq)) THEN
      RAISE EXCEPTION 'families cannot change those fields' USING ERRCODE='42501';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER enrollment_applications_guard BEFORE INSERT OR UPDATE ON enrollment_applications
  FOR EACH ROW EXECUTE FUNCTION eduos_enrollment_guard();

-- New-student seats for a school/year/grade: capacity vs offers and accepts.
-- Families see only whether seats remain (the API never shows them counts).
CREATE FUNCTION eduos_enrollment_seats(p_school uuid, p_year text, p_grade text)
RETURNS TABLE(seats integer, committed integer, waitlisted integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT c.seats FROM enrollment_capacity c WHERE c.district_id=eduos_ctx_district() AND c.school_id=p_school AND c.school_year=p_year AND c.grade_level=p_grade),
         (SELECT count(*)::int FROM enrollment_applications a WHERE a.district_id=eduos_ctx_district() AND a.school_id=p_school
            AND a.school_year=p_year AND a.grade_level=p_grade AND a.status IN ('offered','accepted','enrolled')),
         (SELECT count(*)::int FROM enrollment_applications a WHERE a.district_id=eduos_ctx_district() AND a.school_id=p_school
            AND a.school_year=p_year AND a.grade_level=p_grade AND a.status='waitlisted')
   WHERE eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND p_school=eduos_ctx_school()) OR eduos_ctx_role()='parent'
$$;

-- Accepted -> enrolled: creates the student and, when the applying guardian has
-- an account, the guardian link. School leaders only.
CREATE FUNCTION eduos_enrollment_complete(p_app uuid, p_number text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); a enrollment_applications; sid uuid := gen_random_uuid();
BEGIN
  SELECT * INTO a FROM enrollment_applications WHERE id=p_app AND district_id=d FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'application not found' USING ERRCODE='P0002'; END IF;
  IF NOT (eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND a.school_id=eduos_ctx_school())) THEN
    RAISE EXCEPTION 'school leaders enroll' USING ERRCODE='42501';
  END IF;
  IF a.status <> 'accepted' THEN RAISE EXCEPTION 'only an accepted offer can be enrolled' USING ERRCODE='23514'; END IF;
  IF p_number !~ '^[A-Za-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'student number invalid' USING ERRCODE='22023'; END IF;
  INSERT INTO students(id,district_id,school_id,local_student_number,display_name,grade_level)
    VALUES(sid, d, a.school_id, p_number, btrim(a.child_first_name)||' '||btrim(a.child_last_name), a.grade_level);
  IF a.guardian_user_id IS NOT NULL AND EXISTS(SELECT 1 FROM memberships m WHERE m.district_id=d AND m.user_id=a.guardian_user_id AND m.role='parent' AND m.status='active') THEN
    INSERT INTO student_user_links(district_id,student_id,user_id,relationship) VALUES(d, sid, a.guardian_user_id, 'guardian');
  END IF;
  UPDATE enrollment_applications SET status='enrolled', student_id=sid, decided_at=coalesce(decided_at, now()), updated_at=now() WHERE id=p_app;
  INSERT INTO enrollment_events(district_id,application_id,from_status,to_status,note,actor_user_id,actor_role)
    VALUES(d, p_app, 'accepted', 'enrolled', 'Student record created', eduos_ctx_user(), eduos_ctx_role());
  RETURN sid;
END; $$;


DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enrollment_capacity','enrollment_applications','enrollment_events','enrollment_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- Enrollment
CREATE POLICY scope_read ON enrollment_capacity AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_school_lead(school_id));
CREATE POLICY scope_insert ON enrollment_capacity AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_is_school_lead(school_id));
CREATE POLICY scope_update ON enrollment_capacity AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_school_lead(school_id)) WITH CHECK (eduos_is_table_owner() OR eduos_is_school_lead(school_id));
CREATE POLICY scope_read ON enrollment_applications AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_school_lead(school_id) OR (eduos_ctx_role()='parent' AND guardian_user_id=eduos_ctx_user()));
CREATE POLICY scope_insert ON enrollment_applications AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_is_school_lead(school_id) OR (eduos_ctx_role()='parent' AND guardian_user_id=eduos_ctx_user() AND source='family'));
CREATE POLICY scope_update ON enrollment_applications AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_school_lead(school_id) OR (eduos_ctx_role()='parent' AND guardian_user_id=eduos_ctx_user()))
  WITH CHECK (eduos_is_table_owner() OR eduos_is_school_lead(school_id) OR (eduos_ctx_role()='parent' AND guardian_user_id=eduos_ctx_user()));
CREATE POLICY scope_read ON enrollment_events AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_leads_application(application_id) OR eduos_my_application(application_id));
CREATE POLICY scope_insert ON enrollment_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR ((eduos_leads_application(application_id) OR eduos_my_application(application_id)) AND actor_user_id=eduos_ctx_user()));
CREATE POLICY scope_read ON enrollment_documents AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_leads_application(application_id) OR eduos_my_application(application_id));
CREATE POLICY scope_insert ON enrollment_documents AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR ((eduos_leads_application(application_id) OR eduos_my_application(application_id)) AND uploaded_by=eduos_ctx_user()));
CREATE POLICY scope_update ON enrollment_documents AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_leads_application(application_id)) WITH CHECK (eduos_is_table_owner() OR eduos_leads_application(application_id));

-- FERPA purge: an enrolled learner's application, its history and documents.
ALTER FUNCTION eduos_purge_student(uuid) RENAME TO eduos_purge_student_pre_enrollment;
CREATE FUNCTION eduos_purge_student(p_student uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; rest jsonb;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM enrollment_documents x USING enrollment_applications a WHERE x.application_id=a.id AND a.student_id=p_student AND a.district_id=d;
  DELETE FROM enrollment_events x USING enrollment_applications a WHERE x.application_id=a.id AND a.student_id=p_student AND a.district_id=d;
  DELETE FROM enrollment_applications WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT;
  rest := eduos_purge_student_pre_enrollment(p_student);
  IF rest IS NULL THEN RETURN NULL; END IF;
  RETURN rest || jsonb_build_object('enrollment_applications', n);
END; $$;

-- Retention (src/retention.js calls every eduos_retention_feature_*(jsonb) as
-- the owner, per district). Documents are kept only until
-- RETENTION_ENROLLMENT_DOCUMENT_DAYS (default 90) after the decision; closed
-- applications that did not lead to enrollment go after
-- RETENTION_ENROLLMENT_CLOSED_DAYS (default 365).
CREATE FUNCTION eduos_retention_feature_enrollment(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; out jsonb := '{}'::jsonb;
  doc_days int := coalesce((p->>'RETENTION_ENROLLMENT_DOCUMENT_DAYS')::int, 90);
  app_days int := coalesce((p->>'RETENTION_ENROLLMENT_CLOSED_DAYS')::int, 365);
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM enrollment_documents x USING enrollment_applications a WHERE x.application_id=a.id AND a.district_id=d
     AND a.status IN ('enrolled','declined','withdrawn') AND coalesce(a.decided_at, a.updated_at) < now() - make_interval(days => doc_days);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('enrollment_documents', n);
  DELETE FROM enrollment_events x USING enrollment_applications a WHERE x.application_id=a.id AND a.district_id=d
     AND a.status IN ('declined','withdrawn') AND a.updated_at < now() - make_interval(days => app_days);
  DELETE FROM enrollment_documents x USING enrollment_applications a WHERE x.application_id=a.id AND a.district_id=d
     AND a.status IN ('declined','withdrawn') AND a.updated_at < now() - make_interval(days => app_days);
  DELETE FROM enrollment_applications WHERE district_id=d AND status IN ('declined','withdrawn') AND updated_at < now() - make_interval(days => app_days);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('enrollment_applications', n);
  PERFORM set_config('eduos.retention_purge', 'off', true);
  RETURN out;
END; $$;
REVOKE ALL ON FUNCTION eduos_purge_student(uuid), eduos_purge_student_pre_enrollment(uuid), eduos_retention_feature_enrollment(jsonb) FROM PUBLIC;
