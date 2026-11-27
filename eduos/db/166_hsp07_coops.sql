-- HSP-07: homeschool co-ops (design: docs/product/hsp-07-coops.md).
--
-- A co-op is a group of homeschool families, reached from a family session.
-- It is invite-only and adult-only:
--   * families join by a one-time code an organizer made; the family's owner accepts;
--   * only a member family's owners and co-educators see the co-op; learners
--     (and guardian viewers) never do;
--   * there are no messages to or from children, and no direct messages at
--     all: announcements and resources are posts to the whole co-op, and a
--     member family's posts wait for an organizer or moderator to approve them;
--   * learners are signed up to sessions by their family's owner; other
--     families see only how many signed up, and the organizers, moderators and
--     the session's leading family see first names only;
--   * co-op attendance stays in the co-op until the family adds it to its own
--     attendance log; the co-op never writes into a family's records.
-- Families keep their own data: nothing here reads another family's learners,
-- courses or work.

CREATE TABLE coops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_by_family uuid NOT NULL REFERENCES homeschool_families(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE TABLE coop_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id uuid NOT NULL REFERENCES coops(id),
  family_id uuid NOT NULL REFERENCES homeschool_families(id),
  family_label text NOT NULL,
  role text NOT NULL CHECK (role IN ('organizer','moderator','member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','left','removed')),
  joined_by uuid NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  ended_by uuid REFERENCES users(id),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 3 AND 300),
  CHECK ((status = 'active') = (ended_at IS NULL)),
  CHECK (status <> 'removed' OR end_reason IS NOT NULL)
);
CREATE UNIQUE INDEX coop_members_active ON coop_members(coop_id, family_id) WHERE status = 'active';

CREATE TABLE coop_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id uuid NOT NULL REFERENCES coops(id),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 2 AND 120),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by_family uuid NOT NULL REFERENCES homeschool_families(id),
  invited_by uuid NOT NULL REFERENCES users(id),
  invited_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_by_family uuid REFERENCES homeschool_families(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK ((accepted_at IS NULL) = (accepted_by_family IS NULL))
);

CREATE TABLE coop_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id uuid NOT NULL REFERENCES coops(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  location text CHECK (location IS NULL OR length(btrim(location)) BETWEEN 1 AND 200),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  leader_family_id uuid REFERENCES homeschool_families(id),
  capacity integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 300),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '12 hours'),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  UNIQUE (coop_id, id)
);
CREATE INDEX coop_sessions_time ON coop_sessions(coop_id, starts_at);

CREATE TABLE coop_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id uuid NOT NULL,
  session_id uuid NOT NULL,
  family_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  -- First name only: what organizers and the session leader need for a headcount.
  learner_label text NOT NULL CHECK (length(learner_label) BETWEEN 1 AND 60 AND learner_label !~ '\s'),
  status text NOT NULL DEFAULT 'signed_up' CHECK (status IN ('signed_up','withdrawn')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  FOREIGN KEY (coop_id, session_id) REFERENCES coop_sessions(coop_id, id),
  FOREIGN KEY (family_id, learner_id) REFERENCES family_learners(family_id, id),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  UNIQUE (coop_id, id)
);
CREATE UNIQUE INDEX coop_signups_live ON coop_signups(session_id, learner_id) WHERE status = 'signed_up';

CREATE TABLE coop_session_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id uuid NOT NULL,
  signup_id uuid NOT NULL UNIQUE,
  present boolean NOT NULL,
  marked_by uuid NOT NULL REFERENCES users(id),
  marked_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (coop_id, signup_id) REFERENCES coop_signups(coop_id, id)
);

CREATE TABLE coop_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id uuid NOT NULL REFERENCES coops(id),
  kind text NOT NULL CHECK (kind IN ('announcement','resource')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  body text CHECK (body IS NULL OR length(body) <= 4000),
  url text CHECK (url IS NULL OR (length(url) <= 500 AND url ~ '^https://[^\s<>"]+$')),
  author_family uuid NOT NULL REFERENCES homeschool_families(id),
  author_label text NOT NULL,
  author_user uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('pending','published','rejected','removed')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 3 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'resource' OR url IS NOT NULL OR body IS NOT NULL),
  CHECK (status NOT IN ('rejected','removed') OR decision_reason IS NOT NULL)
);
CREATE INDEX coop_posts_coop ON coop_posts(coop_id, created_at DESC);

CREATE TABLE coop_post_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id uuid NOT NULL REFERENCES coops(id),
  post_id uuid NOT NULL REFERENCES coop_posts(id),
  family_id uuid NOT NULL REFERENCES homeschool_families(id),
  user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, family_id)
);

CREATE TABLE coop_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coop_id uuid NOT NULL REFERENCES coops(id),
  family_id uuid NOT NULL REFERENCES homeschool_families(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 60),
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 60),
  resource_id text,
  detail text CHECK (detail IS NULL OR length(detail) <= 1000),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coop_audit_time ON coop_audit_events(coop_id, occurred_at DESC);
CREATE TRIGGER coop_audit_append_only BEFORE UPDATE OR DELETE ON coop_audit_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- A family's own attendance entry for a co-op session it was marked present at (added by the family, once).
ALTER TABLE family_attendance ADD COLUMN coop_attendance_id uuid UNIQUE REFERENCES coop_session_attendance(id);

-- ---------------------------------------------------------------- helpers
-- The family in context's role in a co-op, through one of its owners or co-educators.
CREATE FUNCTION eduos_coop_role(p_coop uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.role FROM coop_members m JOIN coops c ON c.id = m.coop_id AND c.status = 'active'
   WHERE m.coop_id = p_coop AND m.family_id = eduos_ctx_family() AND m.status = 'active' AND eduos_family_role() IN ('owner','co_educator')
$$;
CREATE FUNCTION eduos_coop_manages(p_coop uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(eduos_coop_role(p_coop) IN ('organizer','moderator'), false) $$;
-- The family in context leads this session.
CREATE FUNCTION eduos_coop_leads(p_session uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM coop_sessions s WHERE s.id = p_session AND s.leader_family_id = eduos_ctx_family() AND eduos_coop_role(s.coop_id) IS NOT NULL)
$$;
-- The session and family of a signup, for the attendance policies.
CREATE FUNCTION eduos_coop_signup(p_signup uuid) RETURNS TABLE(session_id uuid, family_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT session_id, family_id FROM coop_signups WHERE id = p_signup $$;
-- Audit an action in a co-op the family in context belongs to.
CREATE FUNCTION eduos_coop_audit(p_coop uuid, p_action text, p_type text, p_id text, p_detail text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF eduos_coop_role(p_coop) IS NULL THEN RAISE EXCEPTION 'not a member of this co-op' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO coop_audit_events(coop_id, family_id, actor_user_id, action, resource_type, resource_id, detail) VALUES (p_coop, eduos_ctx_family(), eduos_ctx_user(), p_action, p_type, p_id, p_detail);
END $$;

-- A co-op always keeps an active organizer while it is open.
CREATE FUNCTION eduos_coop_keeps_organizer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.role = 'organizer' AND OLD.status = 'active' AND (NEW.role <> 'organizer' OR NEW.status <> 'active')
     AND EXISTS (SELECT 1 FROM coops WHERE id = OLD.coop_id AND status = 'active')
     AND NOT EXISTS (SELECT 1 FROM coop_members WHERE coop_id = OLD.coop_id AND id <> OLD.id AND role = 'organizer' AND status = 'active') THEN
    RAISE EXCEPTION 'a co-op needs an active organizer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coop_members_keep_organizer BEFORE UPDATE ON coop_members FOR EACH ROW EXECUTE FUNCTION eduos_coop_keeps_organizer();

-- ---------------------------------------------------------------- definer entry points
-- Start a co-op; the family in context (its owner) becomes the organizer.
CREATE FUNCTION eduos_coop_create(p_name text, p_description text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cid uuid; lbl text;
BEGIN
  IF eduos_family_role() IS DISTINCT FROM 'owner' THEN RETURN jsonb_build_object('ok', false, 'error', 'family_owner_only'); END IF;
  IF (SELECT count(*) FROM coop_members m JOIN coops c ON c.id = m.coop_id AND c.status = 'active' WHERE m.family_id = eduos_ctx_family() AND m.status = 'active') >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'coop_limit_reached'); END IF;
  SELECT display_name INTO lbl FROM homeschool_families WHERE id = eduos_ctx_family();
  INSERT INTO coops(name, description, created_by_family, created_by) VALUES (btrim(p_name), p_description, eduos_ctx_family(), eduos_ctx_user()) RETURNING id INTO cid;
  INSERT INTO coop_members(coop_id, family_id, family_label, role, joined_by) VALUES (cid, eduos_ctx_family(), lbl, 'organizer', eduos_ctx_user());
  PERFORM eduos_coop_audit(cid, 'create', 'coop', cid::text, NULL);
  RETURN jsonb_build_object('ok', true, 'id', cid);
END $$;
-- Join with an organizer's code: the family in context's owner, once, before it expires.
CREATE FUNCTION eduos_coop_join(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i coop_invitations%ROWTYPE; lbl text;
BEGIN
  IF eduos_family_role() IS DISTINCT FROM 'owner' THEN RETURN jsonb_build_object('ok', false, 'error', 'family_owner_only'); END IF;
  SELECT * INTO i FROM coop_invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR i.accepted_at IS NOT NULL OR i.revoked_at IS NOT NULL OR i.expires_at < now()
     OR NOT EXISTS (SELECT 1 FROM coops WHERE id = i.coop_id AND status = 'active') THEN RETURN jsonb_build_object('ok', false, 'error', 'invitation_not_valid'); END IF;
  IF EXISTS (SELECT 1 FROM coop_members WHERE coop_id = i.coop_id AND family_id = eduos_ctx_family() AND status = 'active') THEN RETURN jsonb_build_object('ok', false, 'error', 'already_a_member'); END IF;
  SELECT display_name INTO lbl FROM homeschool_families WHERE id = eduos_ctx_family();
  INSERT INTO coop_members(coop_id, family_id, family_label, role, joined_by) VALUES (i.coop_id, eduos_ctx_family(), lbl, 'member', eduos_ctx_user());
  UPDATE coop_invitations SET accepted_by_family = eduos_ctx_family(), accepted_at = now() WHERE id = i.id;
  PERFORM eduos_coop_audit(i.coop_id, 'join', 'coop_invitation', i.id::text, lbl);
  RETURN jsonb_build_object('ok', true, 'coopId', i.coop_id);
END $$;
-- Leave: the family's owner. Its signups to sessions not yet started are withdrawn.
CREATE FUNCTION eduos_coop_leave(p_coop uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m coop_members%ROWTYPE;
BEGIN
  IF eduos_family_role() IS DISTINCT FROM 'owner' THEN RETURN jsonb_build_object('ok', false, 'error', 'family_owner_only'); END IF;
  SELECT * INTO m FROM coop_members WHERE coop_id = p_coop AND family_id = eduos_ctx_family() AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'coop_not_found'); END IF;
  PERFORM eduos_coop_audit(p_coop, 'leave', 'coop_member', m.id::text, NULL);
  UPDATE coop_members SET status = 'left', ended_by = eduos_ctx_user(), ended_at = now() WHERE id = m.id;
  UPDATE coop_signups g SET status = 'withdrawn', withdrawn_at = now() FROM coop_sessions s
   WHERE g.session_id = s.id AND g.coop_id = p_coop AND g.family_id = eduos_ctx_family() AND g.status = 'signed_up' AND s.starts_at > now();
  RETURN jsonb_build_object('ok', true);
END $$;
-- How many learners are signed up to each session (all members see counts, not names).
CREATE FUNCTION eduos_coop_session_counts(p_coop uuid) RETURNS TABLE(session_id uuid, signed_up integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, (SELECT count(*)::int FROM coop_signups g WHERE g.session_id = s.id AND g.status = 'signed_up')
    FROM coop_sessions s WHERE s.coop_id = p_coop AND eduos_coop_role(p_coop) IS NOT NULL
$$;

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['coops','coop_members','coop_invitations','coop_sessions','coop_signups','coop_session_attendance','coop_posts','coop_post_flags','coop_audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
-- Membership: only the co-op's member families (owners and co-educators).
CREATE POLICY coop_members_only ON coops USING (eduos_is_table_owner() OR eduos_coop_role(id) IS NOT NULL) WITH CHECK (eduos_is_table_owner() OR eduos_coop_role(id) IS NOT NULL);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['coop_members','coop_invitations','coop_sessions','coop_signups','coop_session_attendance','coop_posts','coop_post_flags','coop_audit_events'] LOOP
    EXECUTE format($p$CREATE POLICY coop_members_only ON %I USING (eduos_is_table_owner() OR eduos_coop_role(coop_id) IS NOT NULL)
      WITH CHECK (eduos_is_table_owner() OR eduos_coop_role(coop_id) IS NOT NULL)$p$, t);
  END LOOP;
END $$;
-- Only a family's owner acts for it; co-educators read.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['coops','coop_members','coop_invitations','coop_sessions','coop_signups','coop_session_attendance','coop_posts','coop_post_flags'] LOOP
    EXECUTE format($p$CREATE POLICY owner_acts_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' END)$p$, t);
    EXECUTE format($p$CREATE POLICY owner_acts_update ON %I AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' END)$p$, t);
  END LOOP;
END $$;
CREATE POLICY organizer_edits ON coops AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_coop_role(id) = 'organizer' END);
CREATE POLICY organizer_manages ON coop_members AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_coop_role(coop_id) = 'organizer' END);
CREATE POLICY organizer_invites ON coop_invitations AS RESTRICTIVE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_coop_role(coop_id) = 'organizer' END);
CREATE POLICY managers_schedule ON coop_sessions AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_coop_manages(coop_id) AND created_by = eduos_ctx_user() END);
CREATE POLICY managers_reschedule ON coop_sessions AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_coop_manages(coop_id) END);
-- Signups: a family sees and changes its own; organizers, moderators and the leading family see them all (first names only).
CREATE POLICY signup_visible ON coop_signups AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE family_id = eduos_ctx_family() OR eduos_coop_manages(coop_id) OR eduos_coop_leads(session_id) END);
CREATE POLICY signup_own_insert ON coop_signups AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE family_id = eduos_ctx_family() AND created_by = eduos_ctx_user() AND status = 'signed_up' END);
CREATE POLICY signup_own_update ON coop_signups AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE family_id = eduos_ctx_family() END);
CREATE POLICY attendance_visible ON coop_session_attendance AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_coop_manages(coop_id) OR EXISTS (SELECT 1 FROM eduos_coop_signup(signup_id) g WHERE g.family_id = eduos_ctx_family() OR eduos_coop_leads(g.session_id)) END);
CREATE POLICY attendance_marked ON coop_session_attendance AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE marked_by = eduos_ctx_user() AND (eduos_coop_manages(coop_id) OR EXISTS (SELECT 1 FROM eduos_coop_signup(signup_id) g WHERE eduos_coop_leads(g.session_id))) END);
CREATE POLICY attendance_remarked ON coop_session_attendance AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_coop_manages(coop_id) OR EXISTS (SELECT 1 FROM eduos_coop_signup(signup_id) g WHERE eduos_coop_leads(g.session_id)) END);
-- Posts: published ones to everyone in the co-op; pending and decided ones to their author family and the moderators.
CREATE POLICY post_visible ON coop_posts AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE status = 'published' OR author_family = eduos_ctx_family() OR eduos_coop_manages(coop_id) END);
CREATE POLICY post_written ON coop_posts AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE author_family = eduos_ctx_family() AND author_user = eduos_ctx_user() AND decided_by IS NULL
    AND (status = 'pending' OR (status = 'published' AND eduos_coop_manages(coop_id))) END);
CREATE POLICY post_moderated ON coop_posts AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_coop_manages(coop_id) END);
CREATE POLICY flag_visible ON coop_post_flags AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE family_id = eduos_ctx_family() OR eduos_coop_manages(coop_id) END);
CREATE POLICY flag_written ON coop_post_flags AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE family_id = eduos_ctx_family() AND user_id = eduos_ctx_user() END);
CREATE POLICY audit_managers ON coop_audit_events AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_coop_manages(coop_id) END);
-- A family can only tie its own attendance entry to its own co-op attendance.
CREATE POLICY coop_credit_own ON family_attendance AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE coop_attendance_id IS NULL OR EXISTS (SELECT 1 FROM coop_session_attendance a, eduos_coop_signup(a.signup_id) g
    WHERE a.id = family_attendance.coop_attendance_id AND a.present AND g.family_id = family_attendance.family_id) END);

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_coop_role(uuid)','eduos_coop_manages(uuid)','eduos_coop_leads(uuid)','eduos_coop_signup(uuid)','eduos_coop_create(text,text)','eduos_coop_join(text)',
      'eduos_coop_leave(uuid)','eduos_coop_session_counts(uuid)','eduos_coop_audit(uuid,text,text,text,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
END $$;
