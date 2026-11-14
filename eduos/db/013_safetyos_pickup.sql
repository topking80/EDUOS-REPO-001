-- 32.5.0: SafetyOS (emergency alerts, roll call, accountability, reunification)
-- and car pick-up verification (authorized adults, pick-up passes, custody and
-- do-not-release flags, early dismissal, release log). Also: per-school time
-- zone for "today", notification kinds, and retention for 32.4/32.5 tables.
--
-- Not collected anywhere in this migration: location, GPS, device position,
-- photos, face data, biometrics, or any threat / risk score. Pick-up ID checks
-- are a staff member looking at a photo ID; EduOS stores only that the check
-- was done. Same isolation model as 012: district tenant_isolation + FORCE RLS,
-- RESTRICTIVE per-role policies, SECURITY DEFINER helpers that only answer
-- about the CURRENT user.

-- ---------------------------------------------------------------------------
-- School time zone ("today" for bus runs and pick-up).
-- ---------------------------------------------------------------------------
ALTER TABLE schools ADD COLUMN timezone text NOT NULL DEFAULT 'America/New_York'
  CHECK(timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$' AND length(timezone) <= 64);
CREATE FUNCTION eduos_school_today(p_school uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (now() AT TIME ZONE coalesce(
    (SELECT s.timezone FROM schools s WHERE s.id=p_school AND s.district_id=eduos_ctx_district()
       AND EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=s.timezone)), 'UTC'))::date
$$;
ALTER TABLE transport_runs ALTER COLUMN service_date DROP DEFAULT;

-- Notification kinds for 32.5.0.
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_kind_check
  CHECK(kind IN ('announcement','message','transport','christie','moderation','safety','pickup'));

-- ---------------------------------------------------------------------------
-- SafetyOS.
-- ---------------------------------------------------------------------------
CREATE TABLE safety_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('lockdown','shelter','evacuate','hold')),
  is_drill boolean NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','reunification','closed','cancelled')),
  instructions text CHECK(instructions IS NULL OR length(instructions) <= 500),
  reunification_point text CHECK(reunification_point IS NULL OR length(reunification_point) <= 200),
  initiated_by uuid NOT NULL REFERENCES users(id),
  initiated_at timestamptz NOT NULL DEFAULT now(),
  confirm_by timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  reunification_at timestamptz,
  closed_by uuid REFERENCES users(id),
  closed_at timestamptz,
  debrief text CHECK(debrief IS NULL OR length(debrief) <= 4000),
  CHECK((status IN ('active','reunification','closed')) <= (confirmed_at IS NOT NULL)),
  CHECK((status IN ('closed','cancelled')) = (closed_at IS NOT NULL)),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
-- At most one live (confirmed, not closed) incident per school.
CREATE UNIQUE INDEX safety_incidents_live ON safety_incidents(school_id) WHERE status IN ('active','reunification');
CREATE INDEX safety_incidents_school ON safety_incidents(district_id,school_id,initiated_at DESC);

-- Append-only incident log (the timeline used for the debrief report).
CREATE TABLE safety_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  event text NOT NULL CHECK(event IN ('initiated','confirmed','cancelled','expired','rollcall','responders','note',
                                      'reunification','released','all_clear','debrief')),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_role text NOT NULL,
  detail text CHECK(detail IS NULL OR length(detail) <= 500),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,incident_id) REFERENCES safety_incidents(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX safety_events_incident ON safety_events(incident_id,at);
CREATE TRIGGER safety_events_append_only BEFORE UPDATE OR DELETE ON safety_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Roll call: append-only; the latest entry per (incident, student) wins.
CREATE TABLE safety_rollcall_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  student_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('present','missing','extra','injured')),
  note text CHECK(note IS NULL OR length(note) <= 200),
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,incident_id) REFERENCES safety_incidents(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX safety_rollcall_latest ON safety_rollcall_entries(incident_id,student_id,recorded_at DESC);
CREATE INDEX safety_rollcall_student ON safety_rollcall_entries(district_id,student_id);
CREATE TRIGGER safety_rollcall_append_only BEFORE UPDATE OR DELETE ON safety_rollcall_entries
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- Car pick-up.
-- ---------------------------------------------------------------------------
-- Adults who may collect a learner. Guardians with an EduOS account get an
-- approved 'guardian' row; others are requested by a guardian and approved by
-- the school.
CREATE TABLE pickup_adults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  user_id uuid REFERENCES users(id),              -- set for guardians with an account
  full_name text NOT NULL CHECK(length(btrim(full_name)) BETWEEN 2 AND 120),
  relationship text NOT NULL CHECK(length(btrim(relationship)) BETWEEN 1 AND 40),
  kind text NOT NULL DEFAULT 'authorized' CHECK(kind IN ('guardian','authorized')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','revoked')),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text CHECK(decision_note IS NULL OR length(decision_note) <= 300),
  CHECK((status IN ('approved','rejected')) <= (decided_at IS NOT NULL)),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE UNIQUE INDEX pickup_adults_name ON pickup_adults(student_id,lower(full_name)) WHERE status IN ('pending','approved');
CREATE INDEX pickup_adults_student ON pickup_adults(district_id,student_id);

-- Pick-up passes. Only a SHA-256 of the code is stored; the code is shown once.
CREATE TABLE pickup_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  adult_id uuid NOT NULL,
  code_hash text NOT NULL UNIQUE CHECK(code_hash ~ '^[0-9a-f]{64}$'),
  code_hint text NOT NULL CHECK(code_hint ~ '^[0-9A-Z]{2}$'),
  issued_by uuid NOT NULL REFERENCES users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK(expires_at > issued_at AND expires_at <= issued_at + interval '31 days'),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,adult_id) REFERENCES pickup_adults(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX pickup_tags_adult ON pickup_tags(adult_id) WHERE revoked_at IS NULL;

-- Court orders and do-not-release flags (principal-managed; never shown to families).
CREATE TABLE pickup_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('do_not_release','custody_order')),
  person_name text CHECK(person_name IS NULL OR length(btrim(person_name)) BETWEEN 2 AND 120),
  adult_id uuid,
  detail text NOT NULL CHECK(length(btrim(detail)) BETWEEN 1 AND 500),
  document_on_file boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','lifted')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_by uuid REFERENCES users(id),
  lifted_at timestamptz,
  CHECK(kind <> 'do_not_release' OR person_name IS NOT NULL OR adult_id IS NOT NULL),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,adult_id) REFERENCES pickup_adults(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX pickup_restrictions_student ON pickup_restrictions(district_id,student_id) WHERE status='active';

CREATE TABLE pickup_early_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  adult_id uuid NOT NULL,
  dismissal_date date NOT NULL,
  dismissal_time time NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','declined','released','cancelled')),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,adult_id) REFERENCES pickup_adults(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX pickup_early_day ON pickup_early_dismissals(district_id,school_id,dismissal_date);

-- Append-only pick-up log: verified (in the queue), released, blocked, denied.
CREATE TABLE pickup_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  adult_id uuid,
  tag_id uuid,
  event text NOT NULL CHECK(event IN ('verified','released','blocked','denied')),
  id_checked boolean NOT NULL DEFAULT false,
  early_dismissal_id uuid,
  incident_id uuid,                                  -- set during reunification
  reason text CHECK(reason IS NULL OR length(reason) <= 300),
  recorded_by uuid NOT NULL REFERENCES users(id),
  service_date date NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CHECK(event <> 'released' OR (id_checked AND adult_id IS NOT NULL)),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,adult_id) REFERENCES pickup_adults(district_id,id),
  FOREIGN KEY(district_id,tag_id) REFERENCES pickup_tags(district_id,id),
  FOREIGN KEY(district_id,early_dismissal_id) REFERENCES pickup_early_dismissals(district_id,id),
  FOREIGN KEY(district_id,incident_id) REFERENCES safety_incidents(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX pickup_events_day ON pickup_events(district_id,school_id,service_date,at);
CREATE INDEX pickup_events_student ON pickup_events(district_id,student_id,at DESC);
CREATE TRIGGER pickup_events_append_only BEFORE UPDATE OR DELETE ON pickup_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------
-- Does the current parent have a linked child at p_school?
CREATE FUNCTION eduos_parent_has_child_at(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role()='parent' AND EXISTS(SELECT 1 FROM student_user_links l JOIN students s ON s.id=l.student_id
    WHERE l.user_id=eduos_ctx_user() AND l.district_id=eduos_ctx_district() AND l.status='active'
      AND l.relationship IN ('parent','guardian') AND s.school_id=p_school)
$$;
-- Staff who may act in SafetyOS at p_school.
CREATE FUNCTION eduos_safety_staff(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_is_table_owner() OR eduos_ctx_role()='superintendent'
      OR (eduos_ctx_role() IN ('principal','teacher') AND p_school=eduos_ctx_school())
$$;
CREATE FUNCTION eduos_safety_lead(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_is_table_owner() OR eduos_ctx_role()='superintendent'
      OR (eduos_ctx_role()='principal' AND p_school=eduos_ctx_school())
$$;
-- Is p_incident live (active or reunification) at the caller's school?
CREATE FUNCTION eduos_safety_live(p_incident uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM safety_incidents i WHERE i.id=p_incident AND i.district_id=eduos_ctx_district()
    AND i.status IN ('active','reunification'))
$$;

-- During a live incident a teacher can mark a learner who is NOT on their
-- roster as "extra" in their room. This returns at most 5 matches (id, name,
-- grade) from the caller's school, only while an incident is live there.
CREATE FUNCTION eduos_safety_find_student(p_incident uuid, p_query text)
RETURNS TABLE(student_id uuid, display_name text, grade_level text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.display_name, s.grade_level FROM students s JOIN safety_incidents i ON i.school_id=s.school_id
   WHERE i.id=p_incident AND i.district_id=eduos_ctx_district() AND i.status IN ('active','reunification')
     AND s.district_id=eduos_ctx_district() AND i.school_id=eduos_ctx_school()
     AND eduos_ctx_role() IN ('principal','teacher')
     AND length(btrim(coalesce(p_query,''))) >= 2
     AND (s.display_name ILIKE '%' || replace(replace(btrim(p_query),'%',''),'_','') || '%' OR s.local_student_number = btrim(p_query))
   ORDER BY s.display_name LIMIT 5
$$;

-- Is p_student enrolled at the school of live incident p_incident (caller's
-- school)? Returns the learner's name and grade for the roll-call "extra" row.
CREATE FUNCTION eduos_safety_student_at_school(p_incident uuid, p_student uuid)
RETURNS TABLE(student_id uuid, display_name text, grade_level text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.display_name, s.grade_level FROM students s JOIN safety_incidents i ON i.school_id=s.school_id
   WHERE i.id=p_incident AND s.id=p_student AND i.district_id=eduos_ctx_district() AND s.district_id=eduos_ctx_district()
     AND i.status IN ('active','reunification') AND i.school_id=eduos_ctx_school() AND eduos_ctx_role() IN ('principal','teacher')
$$;
-- Who gets an incident notice: 'staff' (principals, teachers, drivers at the
-- school), 'families' (active guardians of learners at the school). Only for
-- SafetyOS staff at that school (or the superintendent); ids only.
CREATE FUNCTION eduos_safety_recipients(p_incident uuid, p_audience text) RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH i AS (SELECT id, school_id FROM safety_incidents WHERE id=p_incident AND district_id=eduos_ctx_district()
               AND (eduos_ctx_role()='superintendent' OR (eduos_ctx_role() IN ('principal','teacher') AND school_id=eduos_ctx_school())))
  SELECT DISTINCT m.user_id FROM memberships m JOIN i ON m.school_id=i.school_id
   WHERE p_audience='staff' AND m.district_id=eduos_ctx_district() AND m.status='active' AND m.role IN ('principal','teacher','driver')
  UNION
  SELECT DISTINCT l.user_id FROM student_user_links l JOIN students s ON s.id=l.student_id JOIN i ON s.school_id=i.school_id
   WHERE p_audience='families' AND l.district_id=eduos_ctx_district() AND l.status='active' AND l.relationship IN ('parent','guardian')
$$;
-- A linked guardian gets an approved 'guardian' pick-up row for their child.
CREATE FUNCTION eduos_pickup_ensure_guardian(p_student uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid; s record; u record;
BEGIN
  IF eduos_ctx_role() <> 'parent' OR NOT eduos_is_linked_student(p_student) THEN RETURN NULL; END IF;
  SELECT id INTO a FROM pickup_adults WHERE student_id=p_student AND user_id=eduos_ctx_user() AND kind='guardian' AND status='approved';
  IF a IS NOT NULL THEN RETURN a; END IF;
  SELECT id, school_id INTO s FROM students WHERE id=p_student AND district_id=eduos_ctx_district();
  SELECT display_name INTO u FROM users WHERE id=eduos_ctx_user();
  INSERT INTO pickup_adults(district_id,school_id,student_id,user_id,full_name,relationship,kind,status,requested_by,decided_at,decision_note)
    VALUES(eduos_ctx_district(), s.school_id, p_student, eduos_ctx_user(), u.display_name, 'Guardian', 'guardian', 'approved', eduos_ctx_user(), now(), 'Linked guardian account')
    ON CONFLICT DO NOTHING RETURNING id INTO a;
  IF a IS NULL THEN  -- a pending/approved row with the same name exists: promote it
    UPDATE pickup_adults SET user_id=eduos_ctx_user(), kind='guardian', status='approved', decided_at=now(), decision_note='Linked guardian account'
     WHERE student_id=p_student AND lower(full_name)=lower(u.display_name) AND status IN ('pending','approved') RETURNING id INTO a;
  END IF;
  RETURN a;
END; $$;

-- Pick-up verification by pass code hash, for school staff on pick-up duty
-- (principal or teacher at the tag's school). Returns the adult and the
-- learners they may collect, with flags; nothing for anyone else.
CREATE FUNCTION eduos_pickup_lookup(p_hash text)
RETURNS TABLE(tag_id uuid, tag_state text, adult_id uuid, adult_name text, relationship text, adult_kind text, adult_status text,
              student_id uuid, student_name text, grade_level text,
              do_not_release boolean, custody_order boolean, restriction_detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id,
         CASE WHEN t.revoked_at IS NOT NULL THEN 'revoked' WHEN t.expires_at <= now() THEN 'expired' ELSE 'valid' END,
         a.id, a.full_name, a.relationship, a.kind, a.status,
         s.id, s.display_name, s.grade_level,
         EXISTS(SELECT 1 FROM pickup_restrictions r WHERE r.student_id=a.student_id AND r.status='active' AND r.kind='do_not_release'
                  AND (r.adult_id=a.id OR lower(btrim(r.person_name))=lower(btrim(a.full_name)))),
         EXISTS(SELECT 1 FROM pickup_restrictions r WHERE r.student_id=a.student_id AND r.status='active' AND r.kind='custody_order'),
         (SELECT string_agg(r.detail, ' | ' ORDER BY r.created_at) FROM pickup_restrictions r WHERE r.student_id=a.student_id AND r.status='active'
            AND (r.kind='custody_order' OR r.adult_id=a.id OR lower(btrim(r.person_name))=lower(btrim(a.full_name))))
    FROM pickup_tags t JOIN pickup_adults a ON a.id=t.adult_id JOIN students s ON s.id=a.student_id
   WHERE t.code_hash=p_hash AND t.district_id=eduos_ctx_district() AND t.school_id=eduos_ctx_school()
     AND eduos_ctx_role() IN ('principal','teacher')
$$;

-- Staff on pick-up duty (principal or teacher at the caller's school) see the
-- day's queue with names even for learners outside their roster.
CREATE FUNCTION eduos_pickup_today()
RETURNS TABLE(student_id uuid, display_name text, grade_level text, event text, at timestamptz, reason text, incident_id uuid,
              adult_name text, relationship text, by_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.student_id, s.display_name, s.grade_level, e.event, e.at, e.reason, e.incident_id,
         pa.full_name, pa.relationship, u.display_name
    FROM pickup_events e JOIN students s ON s.id=e.student_id LEFT JOIN pickup_adults pa ON pa.id=e.adult_id JOIN users u ON u.id=e.recorded_by
   WHERE e.district_id=eduos_ctx_district() AND e.school_id=eduos_ctx_school() AND eduos_ctx_role() IN ('principal','teacher')
     AND e.service_date=eduos_school_today(eduos_ctx_school())
   ORDER BY e.at, e.id LIMIT 5000
$$;
CREATE FUNCTION eduos_pickup_early_today()
RETURNS TABLE(id uuid, student_id uuid, student_name text, adult_name text, dismissal_time text, status text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.student_id, s.display_name, pa.full_name, to_char(e.dismissal_time,'HH24:MI'), e.status, e.reason
    FROM pickup_early_dismissals e JOIN students s ON s.id=e.student_id JOIN pickup_adults pa ON pa.id=e.adult_id
   WHERE e.district_id=eduos_ctx_district() AND e.school_id=eduos_ctx_school() AND eduos_ctx_role() IN ('principal','teacher')
     AND e.dismissal_date=eduos_school_today(eduos_ctx_school()) AND e.status IN ('approved','released')
   ORDER BY e.dismissal_time
$$;
-- Recipients for pick-up / roll-call alerts: the school's principals, and a
-- learner's guardians (ids only), for staff at the caller's school.
CREATE FUNCTION eduos_school_leads() RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.user_id FROM memberships m WHERE m.district_id=eduos_ctx_district() AND m.school_id=eduos_ctx_school()
     AND m.role='principal' AND m.status='active' AND eduos_ctx_role() IN ('principal','teacher','parent')
$$;
CREATE FUNCTION eduos_pickup_guardians(p_student uuid) RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.user_id FROM student_user_links l JOIN students s ON s.id=l.student_id
   WHERE l.student_id=p_student AND l.district_id=eduos_ctx_district() AND s.school_id=eduos_ctx_school()
     AND l.status='active' AND l.relationship IN ('parent','guardian') AND eduos_ctx_role() IN ('principal','teacher')
$$;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['safety_incidents','safety_events','safety_rollcall_entries',
    'pickup_adults','pickup_tags','pickup_restrictions','pickup_early_dismissals','pickup_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Incidents: everyone at the school (staff, students, drivers) sees the state;
-- families of learners there see it too (the API gives them generic text only).
CREATE POLICY scope_read ON safety_incidents AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent' OR school_id=eduos_ctx_school() OR eduos_parent_has_child_at(school_id));
CREATE POLICY scope_insert ON safety_incidents AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (initiated_by=eduos_ctx_user() AND eduos_safety_staff(school_id)));
CREATE POLICY scope_update ON safety_incidents AS RESTRICTIVE FOR UPDATE
  USING (eduos_safety_lead(school_id) OR (eduos_safety_staff(school_id) AND initiated_by=eduos_ctx_user()))
  WITH CHECK (eduos_safety_lead(school_id) OR (eduos_safety_staff(school_id) AND initiated_by=eduos_ctx_user()));
CREATE POLICY scope_read ON safety_events AS RESTRICTIVE FOR SELECT USING (eduos_safety_staff(school_id));
CREATE POLICY scope_insert ON safety_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (actor_user_id=eduos_ctx_user() AND eduos_safety_staff(school_id)));
-- Roll call: leads see all; a teacher sees what they recorded. Writes only while live.
CREATE POLICY scope_read ON safety_rollcall_entries AS RESTRICTIVE FOR SELECT
  USING (eduos_safety_lead(school_id) OR (eduos_ctx_role()='teacher' AND recorded_by=eduos_ctx_user()));
CREATE POLICY scope_insert ON safety_rollcall_entries AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (recorded_by=eduos_ctx_user() AND eduos_safety_staff(school_id) AND eduos_safety_live(incident_id)));

-- Authorized adults: the learner's guardians and school leads. Guardians add
-- pending rows for their own child and may revoke; only leads approve.
CREATE POLICY scope_read ON pickup_adults AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_safety_lead(school_id) OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id)));
CREATE POLICY scope_insert ON pickup_adults AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (requested_by=eduos_ctx_user() AND (eduos_safety_lead(school_id)
    OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id) AND status='pending' AND kind='authorized'))));
CREATE POLICY scope_update ON pickup_adults AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_safety_lead(school_id) OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id)))
  WITH CHECK (eduos_is_table_owner() OR eduos_safety_lead(school_id) OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id) AND status='revoked'));
-- Tags: the issuer and leads; staff verify through eduos_pickup_lookup().
CREATE POLICY scope_read ON pickup_tags AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR issued_by=eduos_ctx_user() OR eduos_safety_lead(school_id));
CREATE POLICY scope_insert ON pickup_tags AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (issued_by=eduos_ctx_user() AND (eduos_safety_lead(school_id)
    OR (eduos_ctx_role()='parent' AND EXISTS(SELECT 1 FROM pickup_adults a WHERE a.id=adult_id AND a.status='approved')))));
CREATE POLICY scope_update ON pickup_tags AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR issued_by=eduos_ctx_user() OR eduos_safety_lead(school_id))
  WITH CHECK (eduos_is_table_owner() OR issued_by=eduos_ctx_user() OR eduos_safety_lead(school_id));
-- Restrictions: school leads only.
CREATE POLICY scope_rw ON pickup_restrictions AS RESTRICTIVE
  USING (eduos_safety_lead(school_id)) WITH CHECK (eduos_safety_lead(school_id));
-- Early dismissal: guardians of the learner, school staff (teachers for roster learners).
CREATE POLICY scope_read ON pickup_early_dismissals AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_safety_lead(school_id) OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id))
         OR (eduos_ctx_role()='teacher' AND school_id=eduos_ctx_school()));
CREATE POLICY scope_insert ON pickup_early_dismissals AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (requested_by=eduos_ctx_user() AND (eduos_safety_lead(school_id)
    OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id) AND status='requested'))));
CREATE POLICY scope_update ON pickup_early_dismissals AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_safety_staff(school_id) OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id)))
  WITH CHECK (eduos_is_table_owner() OR eduos_safety_staff(school_id) OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id) AND status='cancelled'));
-- Pick-up log: leads; the staff member who recorded it; guardians for their own child.
CREATE POLICY scope_read ON pickup_events AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_safety_lead(school_id) OR (eduos_ctx_role()='teacher' AND school_id=eduos_ctx_school())
         OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id)));
CREATE POLICY scope_insert ON pickup_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (recorded_by=eduos_ctx_user() AND eduos_safety_staff(school_id)));

-- ---------------------------------------------------------------------------
-- Retention for 32.4.0 / 32.5.0 records (run by `npm run db:retention`, owner).
-- Incident logs, roll calls and pick-up logs follow the audit period.
-- ---------------------------------------------------------------------------
CREATE FUNCTION eduos_retention_purge_role_apps(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; out jsonb := '{}'::jsonb;
  notif int := (p->>'notificationDays')::int; tut int := (p->>'christieDays')::int; trn int := (p->>'transportDays')::int;
  com int := (p->>'commsDays')::int; saf int := (p->>'safetyDays')::int; tag int := (p->>'pickupTagDays')::int;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  IF least(notif, tut, trn, com, saf, tag) IS NULL OR least(notif, tut, trn, com, saf, tag) < 1 THEN RAISE EXCEPTION 'retention days must be >= 1'; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM notification_outbox WHERE district_id=d AND created_at < now() - make_interval(days => notif)
     AND (channel <> 'in_app' OR read_at IS NOT NULL OR created_at < now() - make_interval(days => notif * 2));
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('notifications', n);
  DELETE FROM christie_turns t USING christie_sessions s WHERE t.session_id=s.id AND s.district_id=d AND t.district_id=d
     AND s.last_activity_at < now() - make_interval(days => tut);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('christie_turns', n);
  DELETE FROM christie_sessions WHERE district_id=d AND last_activity_at < now() - make_interval(days => tut);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('christie_sessions', n);
  DELETE FROM transport_checkins c USING transport_runs r WHERE c.run_id=r.id AND r.district_id=d AND c.district_id=d
     AND r.service_date < current_date - trn;
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('transport_checkins', n);
  DELETE FROM transport_runs WHERE district_id=d AND service_date < current_date - trn;
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('transport_runs', n);
  DELETE FROM comms_reports r USING comms_messages m, comms_threads t WHERE r.message_id=m.id AND m.thread_id=t.id AND t.district_id=d AND t.last_message_at < now() - make_interval(days => com);
  DELETE FROM comms_message_reads r USING comms_messages m, comms_threads t WHERE r.message_id=m.id AND m.thread_id=t.id AND t.district_id=d AND t.last_message_at < now() - make_interval(days => com);
  DELETE FROM comms_messages m USING comms_threads t WHERE m.thread_id=t.id AND t.district_id=d AND t.last_message_at < now() - make_interval(days => com);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('comms_messages', n);
  DELETE FROM comms_participants p USING comms_threads t WHERE p.thread_id=t.id AND t.district_id=d AND t.last_message_at < now() - make_interval(days => com);
  DELETE FROM comms_threads WHERE district_id=d AND last_message_at < now() - make_interval(days => com);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('comms_threads', n);
  DELETE FROM comms_announcement_reads r USING comms_announcements a WHERE r.announcement_id=a.id AND a.district_id=d AND a.created_at < now() - make_interval(days => com);
  DELETE FROM comms_announcements WHERE district_id=d AND created_at < now() - make_interval(days => com);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('comms_announcements', n);
  DELETE FROM pickup_tags t WHERE district_id=d AND (coalesce(revoked_at, expires_at) < now() - make_interval(days => tag))
     AND NOT EXISTS(SELECT 1 FROM pickup_events e WHERE e.tag_id=t.id);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('pickup_tags', n);
  DELETE FROM pickup_events WHERE district_id=d AND at < now() - make_interval(days => saf);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('pickup_events', n);
  DELETE FROM safety_rollcall_entries e USING safety_incidents i WHERE e.incident_id=i.id AND i.district_id=d AND coalesce(i.closed_at, i.initiated_at) < now() - make_interval(days => saf) AND i.status IN ('closed','cancelled');
  DELETE FROM safety_events e USING safety_incidents i WHERE e.incident_id=i.id AND i.district_id=d AND coalesce(i.closed_at, i.initiated_at) < now() - make_interval(days => saf) AND i.status IN ('closed','cancelled')
     AND NOT EXISTS(SELECT 1 FROM pickup_events pe WHERE pe.incident_id=i.id);
  DELETE FROM safety_incidents i WHERE district_id=d AND status IN ('closed','cancelled') AND coalesce(closed_at, initiated_at) < now() - make_interval(days => saf)
     AND NOT EXISTS(SELECT 1 FROM pickup_events pe WHERE pe.incident_id=i.id) AND NOT EXISTS(SELECT 1 FROM safety_events se WHERE se.incident_id=i.id);
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('safety_incidents', n);
  PERFORM set_config('eduos.retention_purge', 'off', true);
  RETURN out;
END; $$;
REVOKE ALL ON FUNCTION eduos_retention_purge_role_apps(jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- FERPA record deletion: 32.5.0 learner records first, then the 32.4.0 body.
-- ---------------------------------------------------------------------------
ALTER FUNCTION eduos_purge_student(uuid) RENAME TO eduos_purge_student_324;
CREATE FUNCTION eduos_purge_student(p_student uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; out jsonb := '{}'::jsonb; rest jsonb;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM students WHERE id=p_student AND district_id=d) THEN RETURN NULL; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM pickup_events WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('pickup_events', n);
  DELETE FROM pickup_early_dismissals WHERE student_id=p_student AND district_id=d;
  DELETE FROM pickup_restrictions WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('pickup_restrictions', n);
  DELETE FROM pickup_tags t USING pickup_adults a WHERE t.adult_id=a.id AND a.student_id=p_student AND a.district_id=d;
  DELETE FROM pickup_adults WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('pickup_adults', n);
  DELETE FROM safety_rollcall_entries WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('rollcall_entries', n);
  rest := eduos_purge_student_324(p_student);
  RETURN out || coalesce(rest, '{}'::jsonb);
END; $$;
REVOKE ALL ON FUNCTION eduos_purge_student(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_purge_student_324(uuid) FROM PUBLIC;
