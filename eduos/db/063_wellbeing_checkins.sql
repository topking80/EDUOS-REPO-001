-- EduOS 37.6.0 (candidate): well-being check-ins and the crisis hook.
-- A learner tells a HUMAN counselor how they are doing. No scores, no
-- predictions, no risk ranking of minors (p21). Check-ins are off until the
-- district turns them on, and then only for learners whose guardian opted in
-- after reading the district's notice. Crisis language (a fixed, published
-- phrase list in src/wellbeing-model.js), in a check-in or in a Christie chat,
-- always shows the 988 Suicide & Crisis Lifeline and alerts the school's
-- counselors at once. It also opens an URGENT item in the existing counseling
-- queue (school_service_work, domain 'counseling'). Queue items carry no
-- student identifiers or content: that queue is visible to school and district
-- leads.
-- Numbered 063: 051-057 and 060 are clubs & sports (#47), 058 is the district
-- AI privacy controls (#48), 059 Leo/Edison; the 37.6 branches are 061-064.
-- src/migrate.js applies every numbered file after 050 in name order.

DO $$
DECLARE def text; kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='notification_outbox'::regclass AND conname='notification_outbox_kind_check';
  -- Reads both forms PostgreSQL prints: ARRAY['a'::text, ...] (as created
  -- by 013/030) and '{a,b}'::text[] (after another widening like this one),
  -- so the 37.6 migrations can widen the list in any order.
  kinds := ARRAY(SELECT DISTINCT (regexp_matches(def, '[''{,]([a-z0-9_]+)(?=[''},])', 'g'))[1]);
  IF NOT 'wellbeing' = ANY(kinds) THEN
    kinds := kinds || 'wellbeing'::text;
    ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;
    EXECUTE format('ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_kind_check CHECK(kind = ANY(%L::text[]))', kinds);
  END IF;
END $$;

-- District switch and notice. Off unless a superintendent turns it on.
CREATE TABLE wellbeing_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  checkins_enabled boolean NOT NULL DEFAULT false,
  notice_version text NOT NULL DEFAULT 'v1' CHECK(notice_version ~ '^[A-Za-z0-9._-]{1,20}$'),
  notice_text text NOT NULL CHECK(length(btrim(notice_text)) BETWEEN 20 AND 3000),
  retention_days integer NOT NULL DEFAULT 365 CHECK(retention_days BETWEEN 30 AND 2555),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A guardian's decision for one learner, under one notice version
-- (append-only; the latest wins).
CREATE TABLE wellbeing_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('opted_in','opted_out')),
  notice_version text NOT NULL,
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id)
);
CREATE INDEX wellbeing_consents_student ON wellbeing_consents(district_id,student_id,decided_at DESC);
CREATE TRIGGER wellbeing_consents_append_only BEFORE UPDATE OR DELETE ON wellbeing_consents
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TABLE wellbeing_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  mood text NOT NULL CHECK(mood IN ('great','good','okay','low','struggling')),
  needs text[] NOT NULL DEFAULT '{}' CHECK(cardinality(needs) <= 8 AND needs <@ ARRAY['talk_to_someone','friends','schoolwork','home','sleep','food','safety','other']::text[]),
  note text CHECK(note IS NULL OR length(note) <= 500),
  wants_talk boolean NOT NULL DEFAULT false,
  -- Set only by the explicit crisis-phrase rule; not a score.
  crisis boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','seen','in_progress','closed')),
  assigned_to uuid REFERENCES users(id),
  -- The counseling-queue item this check-in opened, if any (the queue item
  -- never points back at the learner).
  work_id uuid REFERENCES school_service_work(id) ON DELETE SET NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((status='closed') = (closed_at IS NOT NULL)),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id)
);
CREATE INDEX wellbeing_checkins_queue ON wellbeing_checkins(district_id,school_id,status,created_at);
CREATE TABLE wellbeing_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  checkin_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK(action IN ('seen','assigned','met_with_student','contacted_family','referred','note','closed','reopened')),
  note text CHECK(note IS NULL OR length(note) <= 1000),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,checkin_id) REFERENCES wellbeing_checkins(district_id,id)
);
CREATE INDEX wellbeing_actions_checkin ON wellbeing_actions(checkin_id,at);
CREATE TRIGGER wellbeing_actions_append_only BEFORE UPDATE OR DELETE ON wellbeing_actions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
-- Immediate human alert for crisis language (from a check-in or from Christie).
CREATE TABLE wellbeing_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  source text NOT NULL CHECK(source IN ('checkin','christie')),
  checkin_id uuid,
  work_id uuid REFERENCES school_service_work(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id)
);
CREATE INDEX wellbeing_alerts_open ON wellbeing_alerts(district_id,school_id,created_at) WHERE acknowledged_at IS NULL;

CREATE FUNCTION eduos_is_counselor(p_school uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT eduos_ctx_role()='counselor' AND p_school=eduos_ctx_school()
$$;
CREATE FUNCTION eduos_is_my_pupil_record(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role()='pupil' AND eduos_is_linked_student(p_student)
$$;
-- May this learner send check-ins? District switch AND the guardian's latest
-- decision is opted_in under the CURRENT notice version (a changed notice
-- needs a fresh opt-in).
CREATE FUNCTION eduos_wellbeing_allowed(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH s AS (SELECT checkins_enabled, notice_version FROM wellbeing_settings WHERE district_id=eduos_ctx_district()),
       c AS (SELECT decision, notice_version FROM wellbeing_consents WHERE district_id=eduos_ctx_district() AND student_id=p_student ORDER BY decided_at DESC LIMIT 1)
  SELECT coalesce((SELECT checkins_enabled FROM s), false)
     AND coalesce((SELECT decision='opted_in' AND notice_version=(SELECT notice_version FROM s) FROM c), false)
$$;
-- Open an item in the existing counseling queue. Summary is fixed text: no
-- student identifier, no content. Assigned when the school has exactly one
-- counselor; created_by is that counselor (or the first one) so the learner's
-- account is not attached to the item. Returns NULL when the school has no
-- counselor (the principal fallback is notified instead).
CREATE FUNCTION eduos_wellbeing_open_work(p_school uuid, p_kind text, p_priority text, p_summary text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); c uuid[]; wid uuid;
BEGIN
  IF p_kind NOT IN ('wellbeing_crisis','wellbeing_talk') THEN RAISE EXCEPTION 'kind' USING ERRCODE='22023'; END IF;
  SELECT array_agg(m.user_id ORDER BY m.user_id) INTO c FROM memberships m
   WHERE m.district_id=d AND m.school_id=p_school AND m.role='counselor' AND m.status='active';
  IF c IS NULL THEN RETURN NULL; END IF;
  INSERT INTO school_service_work(district_id,school_id,domain,kind,priority,summary,created_by,assigned_to,due_at)
  VALUES(d,p_school,'counseling',p_kind,p_priority,p_summary,c[1],CASE WHEN cardinality(c)=1 THEN c[1] END,
         CASE WHEN p_priority='urgent' THEN now() ELSE now()+interval '1 day' END)
  RETURNING id INTO wid;
  RETURN wid;
END; $$;
-- Raise a crisis alert and return who to notify (ids only; no content).
-- Callable by the learner's own session (check-in, Christie).
CREATE FUNCTION eduos_wellbeing_raise_alert(p_student uuid, p_source text, p_checkin uuid)
RETURNS TABLE(alert_id uuid, school_id uuid, work_id uuid, recipient uuid, fallback boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); sch uuid; aid uuid; wid uuid;
BEGIN
  IF NOT eduos_is_my_pupil_record(p_student) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE='42501';
  END IF;
  SELECT s.school_id INTO sch FROM students s WHERE s.id=p_student AND s.district_id=d;
  IF sch IS NULL THEN RAISE EXCEPTION 'student not found'; END IF;
  wid := eduos_wellbeing_open_work(sch, 'wellbeing_crisis', 'urgent',
    CASE p_source WHEN 'christie' THEN 'URGENT: crisis words in a Christie chat. Find the student now: open Well-being alerts in EduOS.'
      ELSE 'URGENT: crisis words in a well-being check-in. Find the student now: open Well-being alerts in EduOS.' END);
  INSERT INTO wellbeing_alerts(district_id,school_id,student_id,source,checkin_id,work_id) VALUES(d,sch,p_student,p_source,p_checkin,wid) RETURNING id INTO aid;
  IF p_checkin IS NOT NULL THEN UPDATE wellbeing_checkins SET work_id=wid WHERE id=p_checkin AND student_id=p_student; END IF;
  RETURN QUERY SELECT aid, sch, wid, m.user_id, false FROM memberships m
    WHERE m.district_id=d AND m.school_id=sch AND m.role='counselor' AND m.status='active';
  IF NOT FOUND THEN
    RETURN QUERY SELECT aid, sch, wid, m.user_id, true FROM memberships m
      WHERE m.district_id=d AND m.school_id=sch AND m.role='principal' AND m.status='active';
  END IF;
END; $$;
-- A learner asked to talk (or checked "safety"): a high-priority queue item.
CREATE FUNCTION eduos_wellbeing_request_talk(p_checkin uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c wellbeing_checkins; wid uuid;
BEGIN
  SELECT * INTO c FROM wellbeing_checkins WHERE id=p_checkin AND district_id=eduos_ctx_district();
  IF c.id IS NULL OR NOT eduos_is_my_pupil_record(c.student_id) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE='42501'; END IF;
  IF c.work_id IS NOT NULL THEN RETURN c.work_id; END IF;
  wid := eduos_wellbeing_open_work(c.school_id, 'wellbeing_talk', 'high', 'A student asked to talk with a counselor. Open Well-being check-ins in EduOS.');
  UPDATE wellbeing_checkins SET work_id=wid WHERE id=c.id;
  RETURN wid;
END; $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wellbeing_settings','wellbeing_consents','wellbeing_checkins','wellbeing_actions','wellbeing_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- Counselor-only, plus the learner's own submissions and the guardian's own
-- consent decisions. Principals, teachers and the district office have NO row
-- access to check-ins or alerts.
CREATE POLICY scope_insert ON wellbeing_settings AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role()='superintendent');
CREATE POLICY scope_update ON wellbeing_settings AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent') WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role()='superintendent');
CREATE POLICY scope_read ON wellbeing_consents AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id)) OR eduos_is_counselor(school_id));
CREATE POLICY scope_insert ON wellbeing_consents AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='parent' AND eduos_is_linked_student(student_id) AND decided_by=eduos_ctx_user()));
CREATE POLICY scope_read ON wellbeing_checkins AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_counselor(school_id) OR eduos_is_my_pupil_record(student_id));
CREATE POLICY scope_insert ON wellbeing_checkins AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_is_my_pupil_record(student_id) AND eduos_wellbeing_allowed(student_id) AND status='new' AND work_id IS NULL));
CREATE POLICY scope_update ON wellbeing_checkins AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_counselor(school_id)) WITH CHECK (eduos_is_table_owner() OR eduos_is_counselor(school_id));
CREATE POLICY scope_read ON wellbeing_actions AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_is_counselor(school_id));
CREATE POLICY scope_insert ON wellbeing_actions AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_is_counselor(school_id) AND actor_user_id=eduos_ctx_user()));
CREATE POLICY scope_read ON wellbeing_alerts AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_is_counselor(school_id));
CREATE POLICY scope_insert ON wellbeing_alerts AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_update ON wellbeing_alerts AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_counselor(school_id)) WITH CHECK (eduos_is_table_owner() OR eduos_is_counselor(school_id));

-- FERPA purge: the learner's check-ins, actions, alerts and consents.
ALTER FUNCTION eduos_purge_student(uuid) RENAME TO eduos_purge_student_pre_wellbeing;
CREATE FUNCTION eduos_purge_student(p_student uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; rest jsonb;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM wellbeing_actions x USING wellbeing_checkins c WHERE x.checkin_id=c.id AND c.student_id=p_student AND c.district_id=d;
  DELETE FROM wellbeing_alerts WHERE student_id=p_student AND district_id=d;
  DELETE FROM wellbeing_checkins WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM wellbeing_consents WHERE student_id=p_student AND district_id=d;
  rest := eduos_purge_student_pre_wellbeing(p_student);
  IF rest IS NULL THEN RETURN NULL; END IF;
  RETURN rest || jsonb_build_object('wellbeing_checkins', n);
END; $$;
-- Retention (src/retention.js calls every eduos_retention_feature_*(jsonb)):
-- check-ins, their actions and acknowledged alerts older than the district's
-- retention_days (default 365). Consents are kept as the record of the
-- guardian's choice until the learner is purged.
CREATE FUNCTION eduos_retention_feature_wellbeing(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; a int;
  days int := coalesce((SELECT retention_days FROM wellbeing_settings WHERE district_id=d), 365);
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM wellbeing_alerts WHERE district_id=d AND acknowledged_at IS NOT NULL AND created_at < now() - make_interval(days => days);
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM wellbeing_alerts x USING wellbeing_checkins c WHERE x.checkin_id=c.id AND c.district_id=d AND c.created_at < now() - make_interval(days => days) AND x.acknowledged_at IS NOT NULL;
  DELETE FROM wellbeing_actions x USING wellbeing_checkins c WHERE x.checkin_id=c.id AND c.district_id=d AND c.created_at < now() - make_interval(days => days)
     AND NOT EXISTS (SELECT 1 FROM wellbeing_alerts al WHERE al.checkin_id=c.id);
  DELETE FROM wellbeing_checkins c WHERE c.district_id=d AND c.created_at < now() - make_interval(days => days)
     AND NOT EXISTS (SELECT 1 FROM wellbeing_alerts al WHERE al.checkin_id=c.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('eduos.retention_purge', 'off', true);
  RETURN jsonb_build_object('wellbeing_checkins', n, 'wellbeing_alerts', a);
END; $$;
REVOKE ALL ON FUNCTION eduos_purge_student(uuid), eduos_purge_student_pre_wellbeing(uuid), eduos_retention_feature_wellbeing(jsonb),
  eduos_wellbeing_open_work(uuid, text, text, text) FROM PUBLIC;
