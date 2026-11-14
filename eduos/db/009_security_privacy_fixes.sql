-- 32.0.53: security and student-privacy fixes from the 32.0.52 review.
-- Idempotent where practical; runs inside the migration transaction.

-- ---------------------------------------------------------------------------
-- (24) One account may hold several roles and/or schools in a district.
-- Foreign keys that pointed at memberships(district_id,user_id) are moved to a
-- district_users anchor table so memberships can have >1 row per user+district.
-- ---------------------------------------------------------------------------
CREATE TABLE district_users (
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (district_id, user_id)
);
INSERT INTO district_users(district_id,user_id)
  SELECT DISTINCT district_id,user_id FROM memberships ON CONFLICT DO NOTHING;

DO $$
DECLARE c record; def text;
BEGIN
  FOR c IN SELECT conname, conrelid::regclass AS tbl, pg_get_constraintdef(oid) AS def
             FROM pg_constraint
            WHERE contype='f' AND confrelid='memberships'::regclass
  LOOP
    def := replace(c.def, 'REFERENCES memberships(district_id, user_id)', 'REFERENCES district_users(district_id, user_id)');
    IF def = c.def THEN RAISE EXCEPTION 'unexpected FK shape on %: %', c.tbl, c.def; END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', c.tbl, c.conname, def);
  END LOOP;
END $$;

ALTER TABLE memberships DROP CONSTRAINT memberships_district_id_user_id_key;
ALTER TABLE memberships ADD CONSTRAINT memberships_user_scope_role_key
  UNIQUE NULLS NOT DISTINCT (user_id, district_id, school_id, role);
ALTER TABLE memberships ADD CONSTRAINT memberships_district_user_fk
  FOREIGN KEY (district_id, user_id) REFERENCES district_users(district_id, user_id);

CREATE FUNCTION ensure_district_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO district_users(district_id,user_id) VALUES (NEW.district_id,NEW.user_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER memberships_ensure_district_user BEFORE INSERT OR UPDATE OF district_id,user_id ON memberships
FOR EACH ROW EXECUTE FUNCTION ensure_district_user();

-- ---------------------------------------------------------------------------
-- (5) Audit rows carry the acting session's school so principals see only
-- their school. Filled from the transaction-local app.school_id setting.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_events ADD COLUMN school_id uuid;
CREATE INDEX audit_district_school_time ON audit_events(district_id, school_id, occurred_at DESC);
CREATE FUNCTION audit_set_school() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.school_id IS NULL THEN
    NEW.school_id := nullif(current_setting('app.school_id', true), '')::uuid;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER audit_set_school BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION audit_set_school();

-- ---------------------------------------------------------------------------
-- (7) Teacher rosters: teachers see only students assigned to them.
-- ---------------------------------------------------------------------------
CREATE TABLE teacher_student_rosters (
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  teacher_user_id uuid NOT NULL,
  student_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (district_id, teacher_user_id, student_id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, teacher_user_id) REFERENCES district_users(district_id, user_id),
  FOREIGN KEY (district_id, created_by) REFERENCES district_users(district_id, user_id)
);
CREATE INDEX teacher_rosters_student ON teacher_student_rosters(district_id, student_id);
ALTER TABLE teacher_student_rosters ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_student_rosters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teacher_student_rosters
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- (15) Student-specific flow events record their subject so family feeds can
-- be limited to linked learners. Never sent in webhook payloads.
-- ---------------------------------------------------------------------------
ALTER TABLE flow_events ADD COLUMN subject_student_id uuid;
ALTER TABLE flow_events ADD CONSTRAINT flow_events_subject_fk
  FOREIGN KEY (district_id, subject_student_id) REFERENCES students(district_id, id);
CREATE INDEX flow_events_subject ON flow_events(district_id, subject_student_id) WHERE subject_student_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- (9)(21) Sessions: IdP-verified email, idle timeout; durable OIDC state.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN verified_email text CHECK (verified_email IS NULL OR length(verified_email) <= 320);
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX sessions_user_active ON sessions(user_id, created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE oidc_pending_logins (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oidc_pending_expiry ON oidc_pending_logins(expires_at);

-- ---------------------------------------------------------------------------
-- (12) Privileged retention / record-deletion path for append-only tables.
-- The runtime role has no DELETE privilege on these tables, so the purge flag
-- below only has effect inside these owner-defined functions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('eduos.retention_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'audit_events are append-only';
END; $$;
CREATE OR REPLACE FUNCTION reject_case_note_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('eduos.retention_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'student_case_notes are append-only';
END; $$;

-- Deletes one learner's records in the current district (app.district_id).
-- Audit rows are retained as the record of the deletion/disclosure history.
CREATE FUNCTION eduos_purge_student(p_student uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; out jsonb := '{}'::jsonb;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM students WHERE id=p_student AND district_id=d) THEN RETURN NULL; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM sis_attendance_imports i USING attendance_events e
   WHERE i.attendance_event_id=e.id AND e.student_id=p_student AND e.district_id=d AND i.district_id=d;
  DELETE FROM attendance_events WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('attendance', n);
  DELETE FROM assignment_submissions WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('submissions', n);
  DELETE FROM student_case_notes WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('case_notes', n);
  DELETE FROM student_intervention_cases WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('cases', n);
  DELETE FROM family_messages WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('messages', n);
  DELETE FROM guardian_invitations WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('invitations', n);
  DELETE FROM teacher_student_rosters WHERE student_id=p_student AND district_id=d;
  DELETE FROM flow_events WHERE subject_student_id=p_student AND district_id=d;
  DELETE FROM student_user_links WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('links', n);
  DELETE FROM students WHERE id=p_student AND district_id=d;
  PERFORM set_config('eduos.retention_purge', 'off', true);
  RETURN out;
END; $$;
REVOKE ALL ON FUNCTION eduos_purge_student(uuid) FROM PUBLIC;

-- Retention for the current district. Run by the owner via `npm run db:retention`.
CREATE FUNCTION eduos_retention_purge(audit_days int, closed_case_days int, flow_event_days int, webhook_delivery_days int)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; out jsonb := '{}'::jsonb;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  IF least(audit_days, closed_case_days, flow_event_days, webhook_delivery_days) < 1 THEN RAISE EXCEPTION 'retention days must be >= 1'; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM audit_events WHERE district_id=d AND occurred_at < now() - make_interval(days => audit_days);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('audit_events', n);
  DELETE FROM student_case_notes n2 USING student_intervention_cases c
   WHERE n2.case_id=c.id AND c.district_id=d AND n2.district_id=d AND c.status='closed'
     AND c.closed_at < now() - make_interval(days => closed_case_days);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('case_notes', n);
  DELETE FROM student_intervention_cases WHERE district_id=d AND status='closed'
     AND closed_at < now() - make_interval(days => closed_case_days);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('closed_cases', n);
  DELETE FROM flow_events WHERE district_id=d AND occurred_at < now() - make_interval(days => flow_event_days);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('flow_events', n);
  DELETE FROM webhook_deliveries WHERE district_id=d AND occurred_at < now() - make_interval(days => webhook_delivery_days);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('webhook_deliveries', n);
  PERFORM set_config('eduos.retention_purge', 'off', true);
  RETURN out;
END; $$;
REVOKE ALL ON FUNCTION eduos_retention_purge(int,int,int,int) FROM PUBLIC;

-- Sessions and pending OIDC logins are not district-scoped.
CREATE FUNCTION eduos_purge_sessions(session_days int) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE s int; p int;
BEGIN
  DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => session_days))
                          OR expires_at < now() - make_interval(days => session_days);
  GET DIAGNOSTICS s = ROW_COUNT;
  DELETE FROM oidc_pending_logins WHERE expires_at < now();
  GET DIAGNOSTICS p = ROW_COUNT;
  RETURN jsonb_build_object('sessions', s, 'oidc_pending_logins', p);
END; $$;
REVOKE ALL ON FUNCTION eduos_purge_sessions(int) FROM PUBLIC;
