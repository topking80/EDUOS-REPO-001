-- 32.4.0: mobile role apps backed by real data.
--   * bus driver role ('driver', school-scoped)
--   * transport: routes, stops, rider assignments, driver runs and append-only
--     board/alight check-in events. NO location tracking: there is no GPS,
--     coordinate or device-position column anywhere; a check-in is a driver
--     tapping "On board" / "Off" at a named stop.
--   * Christie tutor: approved skills and practice items, tutoring sessions,
--     append-only turns, per-skill mastery.
--   * Comms Hub: school/class announcements, two-way threads with read
--     receipts, message reports for moderation, and a notification outbox.
--
-- Isolation model (unchanged): every table carries district_id with the
-- tenant_isolation policy and FORCE ROW LEVEL SECURITY; the runtime role is
-- not the owner. RESTRICTIVE policies below narrow reads and writes by role,
-- school, roster, guardian link, route driver and thread participation. Helper
-- functions that must look at another protected table are SECURITY DEFINER
-- (owner) to avoid policy recursion; each one re-checks app.district_id and
-- only ever answers about the CURRENT user (app.user_id).

-- ---------------------------------------------------------------------------
-- Bus driver role.
-- ---------------------------------------------------------------------------
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check, DROP CONSTRAINT memberships_school_scope_check;
ALTER TABLE flow_events DROP CONSTRAINT flow_events_actor_role_check, DROP CONSTRAINT flow_events_audience_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK(role IN ('superintendent','it_admin','principal','teacher','parent','pupil','driver'));
ALTER TABLE memberships ADD CONSTRAINT memberships_school_scope_check
  CHECK((role IN ('superintendent','it_admin') AND school_id IS NULL)
     OR (role NOT IN ('superintendent','it_admin') AND school_id IS NOT NULL));
ALTER TABLE flow_events ADD CONSTRAINT flow_events_actor_role_check
  CHECK(actor_role IN ('superintendent','it_admin','principal','teacher','parent','pupil','driver'));
ALTER TABLE flow_events ADD CONSTRAINT flow_events_audience_check
  CHECK(cardinality(audience) BETWEEN 1 AND 7
    AND audience <@ ARRAY['superintendent','it_admin','principal','teacher','parent','pupil','driver']::text[]);

-- Small context helpers (caller's rights).
CREATE FUNCTION eduos_ctx_user() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION eduos_ctx_school() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.school_id', true), '')::uuid $$;
CREATE FUNCTION eduos_ctx_role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.role', true), '') $$;
CREATE FUNCTION eduos_ctx_district() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.district_id', true), '')::uuid $$;

-- Is p_student linked to the current parent/pupil user?
CREATE FUNCTION eduos_is_linked_student(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM student_user_links l
    WHERE l.student_id=p_student AND l.district_id=eduos_ctx_district() AND l.user_id=eduos_ctx_user() AND l.status='active'
      AND ((eduos_ctx_role()='parent' AND l.relationship IN ('parent','guardian'))
        OR (eduos_ctx_role()='pupil' AND l.relationship='pupil')))
$$;
-- Is p_student on the current teacher's roster?
CREATE FUNCTION eduos_on_my_roster(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role()='teacher' AND EXISTS(SELECT 1 FROM teacher_student_rosters r
    WHERE r.student_id=p_student AND r.district_id=eduos_ctx_district() AND r.teacher_user_id=eduos_ctx_user())
$$;
-- Staff read scope for a student-linked row at school p_school.
CREATE FUNCTION eduos_staff_can_see_student(p_school uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_ctx_role()='superintendent'
      OR (eduos_ctx_role()='principal' AND p_school=eduos_ctx_school())
      OR (eduos_ctx_role()='teacher' AND p_school=eduos_ctx_school() AND eduos_on_my_roster(p_student))
$$;

-- ---------------------------------------------------------------------------
-- Transport.
-- ---------------------------------------------------------------------------
CREATE TABLE transport_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
  bus_label text NOT NULL CHECK(length(btrim(bus_label)) BETWEEN 1 AND 40),
  direction text NOT NULL CHECK(direction IN ('am','pm')),
  driver_user_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE UNIQUE INDEX transport_routes_name ON transport_routes(district_id,school_id,lower(name),direction) WHERE status='active';

-- A stop is a named pickup point on a route (e.g. "Maple Ave & 3rd St"). It is
-- route data, not a record of where any student is.
CREATE TABLE transport_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  route_id uuid NOT NULL,
  seq integer NOT NULL CHECK(seq BETWEEN 1 AND 200),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  scheduled_time time,
  is_school boolean NOT NULL DEFAULT false,
  UNIQUE(district_id,id),
  UNIQUE(route_id,seq),
  FOREIGN KEY(district_id,route_id) REFERENCES transport_routes(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);

CREATE TABLE transport_rider_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  route_id uuid NOT NULL,
  stop_id uuid NOT NULL,
  student_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,route_id) REFERENCES transport_routes(district_id,id),
  FOREIGN KEY(district_id,stop_id) REFERENCES transport_stops(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE UNIQUE INDEX transport_rider_active ON transport_rider_assignments(route_id,student_id) WHERE revoked_at IS NULL;
CREATE INDEX transport_rider_student ON transport_rider_assignments(district_id,student_id) WHERE revoked_at IS NULL;

CREATE TABLE transport_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  route_id uuid NOT NULL,
  driver_user_id uuid NOT NULL REFERENCES users(id),
  service_date date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK((status='completed') = (completed_at IS NOT NULL)),
  UNIQUE(district_id,id),
  UNIQUE(route_id,service_date),
  FOREIGN KEY(district_id,route_id) REFERENCES transport_routes(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX transport_runs_day ON transport_runs(district_id,school_id,service_date);

-- Append-only. The latest event per (run, student) is the rider's status.
CREATE TABLE transport_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  run_id uuid NOT NULL,
  student_id uuid NOT NULL,
  stop_id uuid NOT NULL,
  event text NOT NULL CHECK(event IN ('boarded','alighted','not_riding')),
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK(note IS NULL OR length(note) <= 200),
  FOREIGN KEY(district_id,run_id) REFERENCES transport_runs(district_id,id),
  FOREIGN KEY(district_id,stop_id) REFERENCES transport_stops(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX transport_checkins_run ON transport_checkins(run_id,student_id,recorded_at DESC);
CREATE INDEX transport_checkins_student ON transport_checkins(district_id,student_id,recorded_at DESC);

CREATE FUNCTION reject_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('eduos.retention_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END; $$;
CREATE TRIGGER transport_checkins_append_only BEFORE UPDATE OR DELETE ON transport_checkins
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Does the current user drive this route / run? Does a linked child ride it?
CREATE FUNCTION eduos_drives_route(p_route uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role()='driver' AND EXISTS(SELECT 1 FROM transport_routes r
    WHERE r.id=p_route AND r.district_id=eduos_ctx_district() AND r.driver_user_id=eduos_ctx_user() AND r.status='active')
$$;
CREATE FUNCTION eduos_drives_run(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role()='driver' AND EXISTS(SELECT 1 FROM transport_runs x
    WHERE x.id=p_run AND x.district_id=eduos_ctx_district() AND x.driver_user_id=eduos_ctx_user())
$$;
CREATE FUNCTION eduos_child_rides_route(p_route uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role() IN ('parent','pupil') AND EXISTS(SELECT 1 FROM transport_rider_assignments a
    WHERE a.route_id=p_route AND a.district_id=eduos_ctx_district() AND a.revoked_at IS NULL AND eduos_is_linked_student(a.student_id))
$$;
CREATE FUNCTION eduos_transport_staff(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_is_table_owner() OR eduos_ctx_role()='superintendent'
      OR (eduos_ctx_role() IN ('principal','teacher','driver') AND p_school=eduos_ctx_school())
$$;
CREATE FUNCTION eduos_transport_manager(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_is_table_owner() OR eduos_ctx_role()='superintendent'
      OR (eduos_ctx_role()='principal' AND p_school=eduos_ctx_school())
$$;

-- ---------------------------------------------------------------------------
-- Christie tutor (approved content only).
-- ---------------------------------------------------------------------------
CREATE TABLE christie_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,                                  -- NULL: district-wide
  subject text NOT NULL CHECK(length(btrim(subject)) BETWEEN 1 AND 40),
  grade_level text NOT NULL CHECK(length(btrim(grade_level)) BETWEEN 1 AND 4),
  code text NOT NULL CHECK(code ~ '^[A-Za-z0-9._-]{1,40}$'),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
  sequence integer NOT NULL DEFAULT 1 CHECK(sequence BETWEEN 1 AND 1000),
  explanation text NOT NULL CHECK(length(btrim(explanation)) BETWEEN 1 AND 4000),
  source text CHECK(source IS NULL OR length(source) <= 300),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  CHECK((status='approved') <= (approved_at IS NOT NULL)),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE UNIQUE INDEX christie_skills_code ON christie_skills(district_id,lower(code)) WHERE status<>'retired';

CREATE TABLE christie_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  skill_id uuid NOT NULL,
  seq integer NOT NULL CHECK(seq BETWEEN 1 AND 500),
  prompt text NOT NULL CHECK(length(btrim(prompt)) BETWEEN 1 AND 500),
  answer text NOT NULL CHECK(length(btrim(answer)) BETWEEN 1 AND 120),   -- never sent to pupils
  hints text[] NOT NULL CHECK(cardinality(hints) BETWEEN 1 AND 6),
  UNIQUE(district_id,id),
  UNIQUE(skill_id,seq),
  FOREIGN KEY(district_id,skill_id) REFERENCES christie_skills(district_id,id)
);

CREATE TABLE christie_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),      -- the signed-in learner
  skill_id uuid NOT NULL,
  item_id uuid,
  hint_level integer NOT NULL DEFAULT 0 CHECK(hint_level BETWEEN 0 AND 6),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
  needs_adult boolean NOT NULL DEFAULT false,      -- the learner asked for a person / wrote something an adult should see
  provider text NOT NULL CHECK(length(provider) <= 40),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,skill_id) REFERENCES christie_skills(district_id,id),
  FOREIGN KEY(district_id,item_id) REFERENCES christie_items(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX christie_sessions_student ON christie_sessions(district_id,student_id,last_activity_at DESC);

CREATE TABLE christie_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  session_id uuid NOT NULL,
  student_id uuid NOT NULL,
  seq integer NOT NULL CHECK(seq >= 1),
  speaker text NOT NULL CHECK(speaker IN ('student','christie')),
  kind text NOT NULL CHECK(kind IN ('question','attempt','item','hint','feedback','explanation','refusal','redirect')),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  item_id uuid,
  correct boolean,
  hint_level integer,
  provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id,seq),
  FOREIGN KEY(district_id,session_id) REFERENCES christie_sessions(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id)
);
CREATE TRIGGER christie_turns_append_only BEFORE UPDATE OR DELETE ON christie_turns
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE student_skill_mastery (
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  skill_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  correct integer NOT NULL DEFAULT 0 CHECK(correct >= 0),
  hints_used integer NOT NULL DEFAULT 0 CHECK(hints_used >= 0),
  mastery integer NOT NULL DEFAULT 0 CHECK(mastery BETWEEN 0 AND 100),
  mastered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(student_id,skill_id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,skill_id) REFERENCES christie_skills(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);

CREATE FUNCTION eduos_can_see_christie_session(p_session uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM christie_sessions s WHERE s.id=p_session AND s.district_id=eduos_ctx_district()
    AND ((eduos_ctx_role()='pupil' AND s.user_id=eduos_ctx_user())
      OR eduos_staff_can_see_student(s.school_id, s.student_id)))
$$;

-- ---------------------------------------------------------------------------
-- Comms Hub.
-- ---------------------------------------------------------------------------
CREATE TABLE comms_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  scope text NOT NULL CHECK(scope IN ('school','class')),
  class_teacher_id uuid REFERENCES users(id),     -- scope='class': that teacher's roster is the class
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 4000),
  audience text[] NOT NULL DEFAULT ARRAY['teacher','parent','pupil']::text[]
    CHECK(cardinality(audience) BETWEEN 1 AND 5 AND audience <@ ARRAY['principal','teacher','parent','pupil','driver']::text[]),
  author_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'published' CHECK(status IN ('published','removed')),
  removed_by uuid REFERENCES users(id),
  removed_at timestamptz,
  removed_reason text CHECK(removed_reason IS NULL OR length(removed_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((scope='class') = (class_teacher_id IS NOT NULL)),
  CHECK((status='removed') = (removed_at IS NOT NULL)),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX comms_announcements_school ON comms_announcements(district_id,school_id,created_at DESC);

CREATE TABLE comms_announcement_reads (
  announcement_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(announcement_id,user_id),
  FOREIGN KEY(district_id,announcement_id) REFERENCES comms_announcements(district_id,id)
);

CREATE TABLE comms_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('family','staff')),
  subject text NOT NULL CHECK(length(btrim(subject)) BETWEEN 1 AND 160),
  student_id uuid,                                  -- family threads: the learner they are about
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','locked')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  locked_by uuid REFERENCES users(id),
  locked_at timestamptz,
  lock_reason text CHECK(lock_reason IS NULL OR length(lock_reason) <= 500),
  CHECK((kind='family') = (student_id IS NOT NULL)),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);

CREATE TABLE comms_participants (
  thread_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK(role IN ('superintendent','principal','teacher','parent','driver')),
  added_by uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(thread_id,user_id),
  FOREIGN KEY(district_id,thread_id) REFERENCES comms_threads(district_id,id)
);
CREATE INDEX comms_participants_user ON comms_participants(district_id,user_id);

CREATE TABLE comms_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz,
  hidden_by uuid REFERENCES users(id),
  hidden_reason text CHECK(hidden_reason IS NULL OR length(hidden_reason) <= 500),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,thread_id) REFERENCES comms_threads(district_id,id)
);
CREATE INDEX comms_messages_thread ON comms_messages(thread_id,created_at);

CREATE TABLE comms_message_reads (
  message_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id,user_id),
  FOREIGN KEY(district_id,message_id) REFERENCES comms_messages(district_id,id)
);

CREATE TABLE comms_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  message_id uuid NOT NULL,
  reported_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  resolution text CHECK(resolution IS NULL OR resolution IN ('hidden','dismissed')),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((status='resolved') = (resolved_at IS NOT NULL)),
  UNIQUE(message_id,reported_by),
  FOREIGN KEY(district_id,message_id) REFERENCES comms_messages(district_id,id)
);

-- Notification outbox. In-app rows are delivered on insert. Rows for external
-- channels (email/sms/push) are only created when that adapter is enabled, are
-- picked up by `node src/notify-dispatch.js` (owner role), and carry no
-- student-identifying text (title/body are generic for those channels).
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  channel text NOT NULL CHECK(channel IN ('in_app','email','sms','push')),
  kind text NOT NULL CHECK(kind IN ('announcement','message','transport','christie','moderation')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body text CHECK(body IS NULL OR length(body) <= 500),
  ref_type text CHECK(ref_type IS NULL OR length(ref_type) <= 40),
  ref_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','skipped','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
  last_error text CHECK(last_error IS NULL OR length(last_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  read_at timestamptz
);
CREATE INDEX notification_outbox_recipient ON notification_outbox(district_id,recipient_user_id,created_at DESC) WHERE channel='in_app';
CREATE INDEX notification_outbox_pending ON notification_outbox(status,created_at) WHERE status='pending';

CREATE FUNCTION eduos_is_thread_participant(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM comms_participants p WHERE p.thread_id=p_thread AND p.district_id=eduos_ctx_district() AND p.user_id=eduos_ctx_user())
$$;
CREATE FUNCTION eduos_is_moderator(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND p_school=eduos_ctx_school())
$$;
-- Can the current user see a class (a teacher's roster) announcement?
CREATE FUNCTION eduos_in_class(p_teacher uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_user()=p_teacher OR EXISTS(SELECT 1 FROM teacher_student_rosters r
    WHERE r.teacher_user_id=p_teacher AND r.district_id=eduos_ctx_district() AND eduos_is_linked_student(r.student_id))
$$;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['transport_routes','transport_stops','transport_rider_assignments','transport_runs','transport_checkins',
    'christie_skills','christie_items','christie_sessions','christie_turns','student_skill_mastery',
    'comms_announcements','comms_announcement_reads','comms_threads','comms_participants','comms_messages','comms_message_reads','comms_reports',
    'notification_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Transport: school staff (principal, teacher, driver) and the superintendent
-- read routes/stops; families only the routes their own child rides.
CREATE POLICY scope_read ON transport_routes AS RESTRICTIVE FOR SELECT
  USING (eduos_transport_staff(school_id) OR eduos_child_rides_route(id));
CREATE POLICY scope_insert ON transport_routes AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_transport_manager(school_id));
CREATE POLICY scope_update ON transport_routes AS RESTRICTIVE FOR UPDATE
  USING (eduos_transport_manager(school_id)) WITH CHECK (eduos_transport_manager(school_id));
CREATE POLICY scope_read ON transport_stops AS RESTRICTIVE FOR SELECT
  USING (eduos_transport_staff(school_id) OR eduos_child_rides_route(route_id));
CREATE POLICY scope_insert ON transport_stops AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_transport_manager(school_id));
CREATE POLICY scope_update ON transport_stops AS RESTRICTIVE FOR UPDATE
  USING (eduos_transport_manager(school_id)) WITH CHECK (eduos_transport_manager(school_id));

-- Rider lists: principal/superintendent; a teacher for roster learners; the
-- route's driver; a family for its own child.
CREATE POLICY scope_read ON transport_rider_assignments AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_staff_can_see_student(school_id, student_id)
         OR (eduos_ctx_role()='driver' AND school_id=eduos_ctx_school() AND eduos_drives_route(route_id))
         OR eduos_is_linked_student(student_id));
CREATE POLICY scope_insert ON transport_rider_assignments AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_transport_manager(school_id));
CREATE POLICY scope_update ON transport_rider_assignments AS RESTRICTIVE FOR UPDATE
  USING (eduos_transport_manager(school_id)) WITH CHECK (eduos_transport_manager(school_id));

-- Runs: staff of the school; families whose child rides the route.
CREATE POLICY scope_read ON transport_runs AS RESTRICTIVE FOR SELECT
  USING (eduos_transport_staff(school_id) OR eduos_child_rides_route(route_id));
CREATE POLICY scope_insert ON transport_runs AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner()
    OR (eduos_ctx_role()='driver' AND school_id=eduos_ctx_school() AND driver_user_id=eduos_ctx_user() AND eduos_drives_route(route_id)));
CREATE POLICY scope_update ON transport_runs AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR (eduos_ctx_role()='driver' AND driver_user_id=eduos_ctx_user()) OR eduos_transport_manager(school_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='driver' AND driver_user_id=eduos_ctx_user()) OR eduos_transport_manager(school_id));

-- Check-ins: same readers as rider lists; only the run's driver (or the
-- principal, for corrections) records, always as themselves.
CREATE POLICY scope_read ON transport_checkins AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_staff_can_see_student(school_id, student_id)
         OR eduos_drives_run(run_id) OR eduos_is_linked_student(student_id));
CREATE POLICY scope_insert ON transport_checkins AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (recorded_by=eduos_ctx_user() AND school_id=eduos_ctx_school()
    AND (eduos_drives_run(run_id) OR eduos_ctx_role()='principal')));

-- Christie content: approved skills are readable by everyone in the school
-- (district-wide skills by everyone); drafts by staff. Items (which hold the
-- answers) are never readable by pupils or families at the SQL level either;
-- the tutor reads them through eduos_christie_item_for_session().
CREATE POLICY scope_read ON christie_skills AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent'
    OR ((school_id IS NULL OR school_id=eduos_ctx_school())
        AND (status='approved' OR eduos_ctx_role() IN ('principal','teacher'))));
CREATE POLICY scope_insert ON christie_skills AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role()='superintendent'
    OR (eduos_ctx_role() IN ('principal','teacher') AND school_id=eduos_ctx_school() AND created_by=eduos_ctx_user()));
CREATE POLICY scope_update ON christie_skills AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())
         OR (eduos_ctx_role()='teacher' AND school_id=eduos_ctx_school() AND created_by=eduos_ctx_user() AND status='draft'))
  WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())
         OR (eduos_ctx_role()='teacher' AND school_id=eduos_ctx_school() AND created_by=eduos_ctx_user() AND status='draft'));
CREATE POLICY scope_read ON christie_items AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('superintendent','principal','teacher'));
CREATE POLICY scope_insert ON christie_items AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() IN ('superintendent','principal','teacher'));

-- The learner's own sessions; staff by the usual student scope.
CREATE POLICY scope_read ON christie_sessions AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR (eduos_ctx_role()='pupil' AND user_id=eduos_ctx_user())
         OR eduos_staff_can_see_student(school_id, student_id));
CREATE POLICY scope_insert ON christie_sessions AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='pupil' AND user_id=eduos_ctx_user() AND eduos_is_linked_student(student_id)));
CREATE POLICY scope_update ON christie_sessions AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR (eduos_ctx_role()='pupil' AND user_id=eduos_ctx_user())
         OR eduos_staff_can_see_student(school_id, student_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='pupil' AND user_id=eduos_ctx_user())
         OR eduos_staff_can_see_student(school_id, student_id));
CREATE POLICY scope_read ON christie_turns AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_see_christie_session(session_id));
CREATE POLICY scope_insert ON christie_turns AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='pupil' AND eduos_can_see_christie_session(session_id)));
CREATE POLICY scope_read ON student_skill_mastery AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_linked_student(student_id) OR eduos_staff_can_see_student(school_id, student_id));
CREATE POLICY scope_insert ON student_skill_mastery AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='pupil' AND eduos_is_linked_student(student_id)));
CREATE POLICY scope_update ON student_skill_mastery AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR (eduos_ctx_role()='pupil' AND eduos_is_linked_student(student_id)))
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='pupil' AND eduos_is_linked_student(student_id)));

-- Announcements: same school, role in the audience, class membership for
-- class scope; authors and moderators also see removed ones.
CREATE POLICY scope_read ON comms_announcements AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent'
    OR (school_id=eduos_ctx_school() AND (
          author_user_id=eduos_ctx_user() OR eduos_ctx_role()='principal'
          OR (status='published' AND eduos_ctx_role()=ANY(audience) AND (scope='school' OR eduos_in_class(class_teacher_id))))));
CREATE POLICY scope_insert ON comms_announcements AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (author_user_id=eduos_ctx_user() AND (
       eduos_ctx_role()='superintendent'
    OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())
    OR (eduos_ctx_role()='teacher' AND school_id=eduos_ctx_school() AND scope='class' AND class_teacher_id=eduos_ctx_user()))));
CREATE POLICY scope_update ON comms_announcements AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR author_user_id=eduos_ctx_user() OR eduos_is_moderator(school_id))
  WITH CHECK (eduos_is_table_owner() OR author_user_id=eduos_ctx_user() OR eduos_is_moderator(school_id));
CREATE POLICY own_row ON comms_announcement_reads AS RESTRICTIVE
  USING (eduos_is_table_owner() OR user_id=eduos_ctx_user()
         OR EXISTS(SELECT 1 FROM comms_announcements a WHERE a.id=announcement_id AND (a.author_user_id=eduos_ctx_user() OR eduos_is_moderator(a.school_id))))
  WITH CHECK (eduos_is_table_owner() OR user_id=eduos_ctx_user());

-- Threads, participants, messages, receipts: participants only; moderators of
-- the school can read (the API limits them to reported messages).
CREATE POLICY scope_read ON comms_threads AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_thread_participant(id) OR eduos_is_moderator(school_id) OR created_by=eduos_ctx_user());
CREATE POLICY scope_insert ON comms_threads AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (created_by=eduos_ctx_user() AND school_id=eduos_ctx_school()
    AND eduos_ctx_role() IN ('principal','teacher','parent','driver')));
CREATE POLICY scope_update ON comms_threads AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_thread_participant(id) OR eduos_is_moderator(school_id))
  WITH CHECK (eduos_is_table_owner() OR eduos_is_thread_participant(id) OR eduos_is_moderator(school_id));
CREATE POLICY scope_read ON comms_participants AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_thread_participant(thread_id)
         OR EXISTS(SELECT 1 FROM comms_threads t WHERE t.id=thread_id AND (t.created_by=eduos_ctx_user() OR eduos_is_moderator(t.school_id))));
CREATE POLICY scope_insert ON comms_participants AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR EXISTS(SELECT 1 FROM comms_threads t WHERE t.id=thread_id AND t.created_by=eduos_ctx_user()));
CREATE POLICY scope_read ON comms_messages AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_thread_participant(thread_id) OR eduos_is_moderator(school_id));
CREATE POLICY scope_insert ON comms_messages AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (author_user_id=eduos_ctx_user() AND eduos_is_thread_participant(thread_id)));
CREATE POLICY scope_update ON comms_messages AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_moderator(school_id)) WITH CHECK (eduos_is_table_owner() OR eduos_is_moderator(school_id));
CREATE POLICY scope_rw ON comms_message_reads AS RESTRICTIVE
  USING (eduos_is_table_owner() OR EXISTS(SELECT 1 FROM comms_messages m WHERE m.id=message_id AND eduos_is_thread_participant(m.thread_id)))
  WITH CHECK (eduos_is_table_owner() OR user_id=eduos_ctx_user());
CREATE POLICY scope_read ON comms_reports AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR reported_by=eduos_ctx_user() OR eduos_is_moderator(school_id));
CREATE POLICY scope_insert ON comms_reports AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (reported_by=eduos_ctx_user()
    AND EXISTS(SELECT 1 FROM comms_messages m WHERE m.id=message_id AND eduos_is_thread_participant(m.thread_id))));
CREATE POLICY scope_update ON comms_reports AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_moderator(school_id)) WITH CHECK (eduos_is_table_owner() OR eduos_is_moderator(school_id));

-- Outbox: recipients read and mark their own in-app notifications; anyone may
-- enqueue (the API decides recipients); only the owner (dispatcher) sees the rest.
CREATE POLICY own_read ON notification_outbox AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR recipient_user_id=eduos_ctx_user());
CREATE POLICY own_update ON notification_outbox AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR recipient_user_id=eduos_ctx_user())
  WITH CHECK (eduos_is_table_owner() OR recipient_user_id=eduos_ctx_user());

-- The tutor needs the current item (with its answer) for the learner's own
-- active session only. Returns nothing for anyone else.
CREATE FUNCTION eduos_christie_item_for_session(p_session uuid)
RETURNS TABLE(item_id uuid, item_seq integer, prompt text, answer text, hints text[], skill_id uuid, explanation text, skill_title text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.seq, i.prompt, i.answer, i.hints, k.id, k.explanation, k.title
    FROM christie_sessions s JOIN christie_items i ON i.id=s.item_id JOIN christie_skills k ON k.id=s.skill_id
   WHERE s.id=p_session AND s.district_id=eduos_ctx_district() AND s.user_id=eduos_ctx_user()
     AND eduos_ctx_role()='pupil' AND k.status='approved'
$$;
-- Next item (seq after p_after, wrapping) for an approved skill; pupil-safe
-- (no answer returned).
CREATE FUNCTION eduos_christie_next_item(p_skill uuid, p_after integer)
RETURNS TABLE(item_id uuid, seq integer, prompt text, total integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH k AS (SELECT id FROM christie_skills WHERE id=p_skill AND district_id=eduos_ctx_district() AND status='approved'
               AND (school_id IS NULL OR school_id=eduos_ctx_school())),
       items AS (SELECT i.id,i.seq,i.prompt FROM christie_items i JOIN k ON k.id=i.skill_id)
  SELECT id, seq, prompt, (SELECT count(*)::int FROM items) FROM items
   ORDER BY (seq <= coalesce(p_after,0)), seq LIMIT 1
$$;
CREATE FUNCTION eduos_christie_item_counts(p_skills uuid[])
RETURNS TABLE(skill_id uuid, items integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.skill_id, count(*)::int FROM christie_items i JOIN christie_skills k ON k.id=i.skill_id
   WHERE i.skill_id=ANY(p_skills) AND i.district_id=eduos_ctx_district() AND k.status='approved'
     AND (k.school_id IS NULL OR k.school_id=eduos_ctx_school()) GROUP BY i.skill_id
$$;

-- ---------------------------------------------------------------------------
-- FERPA record deletion now also covers the 32.4.0 learner records.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eduos_purge_student(p_student uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; out jsonb := '{}'::jsonb;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM students WHERE id=p_student AND district_id=d) THEN RETURN NULL; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  -- 32.4.0
  DELETE FROM transport_checkins WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('transport_checkins', n);
  DELETE FROM transport_rider_assignments WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('transport_assignments', n);
  DELETE FROM christie_turns WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('christie_turns', n);
  DELETE FROM christie_sessions WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('christie_sessions', n);
  DELETE FROM student_skill_mastery WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('mastery', n);
  DELETE FROM comms_reports r USING comms_messages m, comms_threads t WHERE r.message_id=m.id AND m.thread_id=t.id AND t.student_id=p_student AND t.district_id=d;
  DELETE FROM comms_message_reads r USING comms_messages m, comms_threads t WHERE r.message_id=m.id AND m.thread_id=t.id AND t.student_id=p_student AND t.district_id=d;
  DELETE FROM comms_messages m USING comms_threads t WHERE m.thread_id=t.id AND t.student_id=p_student AND t.district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('thread_messages', n);
  DELETE FROM comms_participants p USING comms_threads t WHERE p.thread_id=t.id AND t.student_id=p_student AND t.district_id=d;
  DELETE FROM comms_threads WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('threads', n);
  -- earlier releases
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

-- Login return path for the role app (only "/" or "/app/" are accepted by the API).
ALTER TABLE oidc_pending_logins ADD COLUMN return_path text NOT NULL DEFAULT '/' CHECK(return_path IN ('/','/app/'));
