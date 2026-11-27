-- HSP-07 part 2 (design: docs/product/hsp-07b-reading-and-messages.md).
--
-- 1. Homeschool reading lists: books per learner, kept by the family like its
--    other learning records (read with any authority; written by the owner or
--    an educator).
-- 2. Private school messages: threads between a learner's guardians and the
--    staff who work with that learner, about that learner.
--      * There are no learner accounts in a private school, so no child is
--        ever in a thread.
--      * Who can be in a thread is fixed by the learner: guardians linked to
--        them, and staff who teach them (a class roster), run their campus, or
--        are the registrar or a school admin. No one can message a stranger.
--      * A guardian's thread includes only that guardian and the staff they
--        chose; staff choose which linked guardians to include.
--      * School admins can read every thread (oversight; the app says so) and
--        hide a message with a reason. Messages are never edited or deleted.

-- ---------------------------------------------------------------- reading
CREATE TABLE family_reading (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  author text CHECK (author IS NULL OR length(btrim(author)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'to_read' CHECK (status IN ('to_read','reading','finished','set_aside')),
  started_on date,
  finished_on date,
  minutes integer NOT NULL DEFAULT 0 CHECK (minutes BETWEEN 0 AND 100000),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  course_id uuid,
  added_by uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (family_id, learner_id) REFERENCES family_learners(family_id, id),
  FOREIGN KEY (family_id, course_id) REFERENCES family_courses(family_id, id),
  CHECK ((status = 'finished') = (finished_on IS NOT NULL)),
  CHECK (finished_on IS NULL OR started_on IS NULL OR finished_on >= started_on)
);
CREATE INDEX family_reading_learner ON family_reading(family_id, learner_id, status);
ALTER TABLE family_reading ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_reading FORCE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON family_reading USING (eduos_is_table_owner() OR family_id = eduos_ctx_family()) WITH CHECK (eduos_is_table_owner() OR family_id = eduos_ctx_family());
CREATE POLICY learner_read ON family_reading AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_authority(learner_id) IS NOT NULL END);
CREATE POLICY learner_write ON family_reading AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_can_teach(learner_id) AND added_by = eduos_ctx_user() END);
CREATE POLICY learner_update ON family_reading AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_can_teach(learner_id) END);

-- ---------------------------------------------------------------- school messages
CREATE TABLE ps_message_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  learner_id uuid NOT NULL,
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by uuid NOT NULL REFERENCES users(id),
  opened_by_membership uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES users(id),
  closed_at timestamptz,
  FOREIGN KEY (school_id, learner_id) REFERENCES private_school_learners(school_id, id),
  FOREIGN KEY (school_id, opened_by_membership) REFERENCES private_school_memberships(school_id, id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  UNIQUE (school_id, id)
);
CREATE INDEX ps_message_threads_learner ON ps_message_threads(school_id, learner_id, opened_at DESC);

CREATE TABLE ps_message_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  last_read_at timestamptz,
  added_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, thread_id) REFERENCES ps_message_threads(school_id, id),
  FOREIGN KEY (school_id, membership_id) REFERENCES private_school_memberships(school_id, id),
  UNIQUE (thread_id, membership_id)
);

CREATE TABLE ps_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  author_membership uuid NOT NULL,
  author_user uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  sent_at timestamptz NOT NULL DEFAULT now(),
  hidden_by uuid REFERENCES users(id),
  hidden_at timestamptz,
  hide_reason text CHECK (hide_reason IS NULL OR length(btrim(hide_reason)) BETWEEN 3 AND 300),
  FOREIGN KEY (school_id, thread_id) REFERENCES ps_message_threads(school_id, id),
  FOREIGN KEY (school_id, author_membership) REFERENCES private_school_memberships(school_id, id),
  CHECK ((hidden_at IS NULL) = (hidden_by IS NULL) AND (hidden_at IS NULL) = (hide_reason IS NULL))
);
CREATE INDEX ps_messages_thread ON ps_messages(thread_id, sent_at);
-- A message is never edited or deleted; it can only be hidden, once.
CREATE FUNCTION eduos_ps_message_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.hidden_at IS NOT NULL OR NEW.body IS DISTINCT FROM OLD.body OR NEW.author_user IS DISTINCT FROM OLD.author_user
     OR NEW.author_membership IS DISTINCT FROM OLD.author_membership OR NEW.thread_id IS DISTINCT FROM OLD.thread_id OR NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'messages are never edited or deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ps_messages_fixed BEFORE UPDATE OR DELETE ON ps_messages FOR EACH ROW EXECUTE FUNCTION eduos_ps_message_fixed();

-- ---------------------------------------------------------------- helpers
-- Whom the session may put in a thread about this learner, and in what capacity.
-- A guardian of the learner: staff who teach them, run their campus, the
-- registrar and school admins. Such staff: the learner's linked guardians.
CREATE FUNCTION eduos_ps_contacts(p_learner uuid) RETURNS TABLE(membership_id uuid, name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH l AS (SELECT * FROM private_school_learners WHERE id = p_learner AND school_id = eduos_ctx_private_school() AND enrollment_status = 'enrolled'),
  staff AS (
    SELECT m.id, u.display_name, m.role FROM private_school_memberships m JOIN users u ON u.id = m.user_id, l
     WHERE m.school_id = l.school_id AND m.status = 'active' AND (
       m.role IN ('school_admin','registrar')
       OR (m.role = 'campus_admin' AND m.campus_id = l.campus_id)
       OR (m.role = 'teacher' AND EXISTS (SELECT 1 FROM ps_class_rosters r JOIN ps_classes k ON k.id = r.class_id AND k.status = 'active'
             WHERE r.learner_id = l.id AND r.removed_on IS NULL AND k.teacher_membership_id = m.id)))),
  guardians AS (
    SELECT m.id, u.display_name, m.role FROM private_school_guardian_links g JOIN private_school_memberships m ON m.user_id = g.user_id AND m.school_id = g.school_id
       AND m.role = 'guardian' AND m.status = 'active' JOIN users u ON u.id = m.user_id, l
     WHERE g.learner_id = l.id AND g.school_id = l.school_id AND g.revoked_at IS NULL)
  SELECT * FROM staff WHERE EXISTS (SELECT 1 FROM guardians g WHERE g.id = eduos_ctx_ps_membership())
  UNION
  SELECT * FROM guardians WHERE EXISTS (SELECT 1 FROM staff s WHERE s.id = eduos_ctx_ps_membership())
$$;
-- The session's membership is in this thread.
CREATE FUNCTION eduos_ps_in_thread(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM ps_message_participants p JOIN private_school_memberships m ON m.id = p.membership_id AND m.status = 'active'
    WHERE p.thread_id = p_thread AND p.membership_id = eduos_ctx_ps_membership() AND m.user_id = eduos_ctx_user())
$$;
CREATE FUNCTION eduos_ps_thread_open(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT EXISTS (SELECT 1 FROM ps_message_threads WHERE id = p_thread AND status = 'open') $$;
CREATE FUNCTION eduos_ps_thread_opener(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM ps_message_threads WHERE id = p_thread AND opened_by = eduos_ctx_user() AND opened_by_membership = eduos_ctx_ps_membership()
    AND opened_at = now())
$$;

-- Names and roles of a thread's people, for those who can see the thread
-- (guardians can't read staff memberships directly).
CREATE FUNCTION eduos_ps_thread_people(p_thread uuid) RETURNS TABLE(membership_id uuid, name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, u.display_name, m.role FROM ps_message_participants p JOIN private_school_memberships m ON m.id = p.membership_id JOIN users u ON u.id = m.user_id
   WHERE p.thread_id = p_thread AND p.school_id = eduos_ctx_private_school() AND (eduos_ps_in_thread(p_thread) OR eduos_ps_has(ARRAY['school_admin']))
$$;

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ps_message_threads','ps_message_participants','ps_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY school_isolation ON %I
      USING (eduos_is_table_owner() OR school_id = eduos_ctx_private_school())
      WITH CHECK (eduos_is_table_owner() OR school_id = eduos_ctx_private_school())$p$, t);
    EXECUTE format($p$CREATE POLICY members_only ON %I AS RESTRICTIVE
      USING (CASE WHEN eduos_is_table_owner() THEN true ELSE cardinality(eduos_ps_roles()) > 0 END)$p$, t);
  END LOOP;
END $$;
-- Threads: participants, and school admins for oversight.
CREATE POLICY thread_visible ON ps_message_threads AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_in_thread(id) OR eduos_ps_has(ARRAY['school_admin']) OR (opened_by = eduos_ctx_user() AND opened_at = now()) END);
CREATE POLICY thread_opened ON ps_message_threads AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE opened_by = eduos_ctx_user() AND opened_by_membership = eduos_ctx_ps_membership() AND status = 'open'
    AND EXISTS (SELECT 1 FROM eduos_ps_contacts(learner_id)) END);
CREATE POLICY thread_closed ON ps_message_threads AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_in_thread(id) OR eduos_ps_has(ARRAY['school_admin']) END);
CREATE POLICY participant_visible ON ps_message_participants AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_in_thread(thread_id) OR eduos_ps_has(ARRAY['school_admin']) OR eduos_ps_thread_opener(thread_id) END);
-- Only the opener adds people, in the transaction that opens the thread, and only allowed contacts (or themself).
CREATE POLICY participant_added ON ps_message_participants AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_thread_opener(thread_id)
    AND (membership_id = eduos_ctx_ps_membership() OR membership_id IN (SELECT c.membership_id FROM ps_message_threads t, eduos_ps_contacts(t.learner_id) c WHERE t.id = thread_id)) END);
CREATE POLICY participant_reads ON ps_message_participants AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE membership_id = eduos_ctx_ps_membership() END);
CREATE POLICY message_visible ON ps_messages AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_in_thread(thread_id) OR eduos_ps_has(ARRAY['school_admin']) END);
CREATE POLICY message_sent ON ps_messages AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_in_thread(thread_id) AND eduos_ps_thread_open(thread_id)
    AND author_user = eduos_ctx_user() AND author_membership = eduos_ctx_ps_membership() AND hidden_at IS NULL END);
CREATE POLICY message_hidden ON ps_messages AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) END);

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_ps_contacts(uuid)','eduos_ps_in_thread(uuid)','eduos_ps_thread_open(uuid)','eduos_ps_thread_opener(uuid)','eduos_ps_thread_people(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
END $$;
