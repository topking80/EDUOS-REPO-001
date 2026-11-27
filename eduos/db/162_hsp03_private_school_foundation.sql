-- HSP-03: independent private school foundation (design: docs/product/hsp-03-private-school-foundation.md).
--
-- A private school is its own tenant (tenants.kind = 'private_school'), never
-- a district and never a district's school. Its tables are isolated by
-- app.private_school_id under forced RLS; in a private-school session
-- app.district_id and app.family_id are empty, so no district or family row
-- matches, and the reverse.
--
-- A school starts 'pending_verification'. Until the platform verifies its
-- identity (npm run ps:verify), it can set up campuses, staff and its profile
-- but holds no learner records: enrolling and guardian links need 'active'.

CREATE TABLE private_schools (
  id uuid PRIMARY KEY REFERENCES tenants(id),
  legal_name text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 2 AND 200),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 120),
  status text NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification','active','suspended','closing','closed')),
  time_zone text NOT NULL DEFAULT 'America/New_York' CHECK (length(time_zone) BETWEEN 3 AND 64),
  jurisdiction_ref text CHECK (jurisdiction_ref IS NULL OR jurisdiction_ref ~ '^US-[A-Z]{2}$'),
  website_domain text CHECK (website_domain IS NULL OR website_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  domain_verified_at timestamptz,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(branding) = 'object' AND length(branding::text) <= 2000),
  verification_ref text CHECK (verification_ref IS NULL OR length(btrim(verification_ref)) BETWEEN 3 AND 200),
  verified_by text CHECK (verified_by IS NULL OR length(btrim(verified_by)) BETWEEN 2 AND 200),
  verified_at timestamptz,
  closure_requested_by uuid REFERENCES users(id),
  closure_requested_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'pending_verification' OR status = 'closed' OR verified_at IS NOT NULL),
  CHECK ((verified_at IS NULL) = (verification_ref IS NULL))
);

CREATE TABLE private_school_campuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  city text CHECK (city IS NULL OR length(btrim(city)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id)
);

CREATE TABLE private_school_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('school_admin','campus_admin','registrar','finance','teacher','staff','guardian')),
  campus_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid NOT NULL REFERENCES users(id),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 500),
  FOREIGN KEY (school_id, campus_id) REFERENCES private_school_campuses(school_id, id),
  CHECK (role NOT IN ('campus_admin','teacher','staff') OR campus_id IS NOT NULL),
  CHECK (role NOT IN ('school_admin','registrar','finance','guardian') OR campus_id IS NULL),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  UNIQUE (school_id, id)
);
CREATE UNIQUE INDEX private_school_memberships_one_active ON private_school_memberships(school_id, user_id, role) WHERE status = 'active';

CREATE TABLE private_school_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320 AND email LIKE '%@%'),
  role text NOT NULL CHECK (role IN ('school_admin','campus_admin','registrar','finance','teacher','staff','guardian')),
  campus_id uuid,
  learner_ids uuid[] NOT NULL DEFAULT '{}',
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid NOT NULL REFERENCES users(id),
  invited_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (school_id, campus_id) REFERENCES private_school_campuses(school_id, id),
  CHECK (role NOT IN ('campus_admin','teacher','staff') OR campus_id IS NOT NULL),
  CHECK (role = 'guardian' OR learner_ids = '{}')
);

CREATE TABLE private_school_learners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  campus_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  grade_level text CHECK (grade_level IS NULL OR grade_level IN ('pre_k','k','1','2','3','4','5','6','7','8','9','10','11','12')),
  local_number text CHECK (local_number IS NULL OR length(btrim(local_number)) BETWEEN 1 AND 40),
  enrollment_status text NOT NULL DEFAULT 'enrolled' CHECK (enrollment_status IN ('enrolled','withdrawn')),
  enrolled_on date NOT NULL,
  withdrawn_on date,
  withdraw_reason text CHECK (withdraw_reason IS NULL OR length(btrim(withdraw_reason)) BETWEEN 3 AND 300),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, campus_id) REFERENCES private_school_campuses(school_id, id),
  CHECK ((enrollment_status = 'withdrawn') = (withdrawn_on IS NOT NULL)),
  UNIQUE (school_id, id)
);
CREATE UNIQUE INDEX private_school_learners_number ON private_school_learners(school_id, local_number) WHERE local_number IS NOT NULL;

CREATE TABLE private_school_guardian_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  relationship text NOT NULL CHECK (relationship IN ('parent','legal_guardian','other_guardian')),
  authority text NOT NULL DEFAULT 'full' CHECK (authority IN ('full','view')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  FOREIGN KEY (school_id, learner_id) REFERENCES private_school_learners(school_id, id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX private_school_guardian_links_open ON private_school_guardian_links(learner_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE private_school_calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  campus_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'event' CHECK (kind IN ('event','holiday','term_start','term_end','closure','meeting')),
  audience text NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone','staff')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  FOREIGN KEY (school_id, campus_id) REFERENCES private_school_campuses(school_id, id),
  CHECK (ends_at >= starts_at),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE INDEX private_school_calendar_range ON private_school_calendar_events(school_id, starts_at);

CREATE TABLE private_school_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES private_schools(id),
  actor_user_id uuid,
  actor_role text NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 60),
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 60),
  resource_id text,
  detail text CHECK (detail IS NULL OR length(detail) <= 1000),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX private_school_audit_time ON private_school_audit_events(school_id, occurred_at DESC);
CREATE TRIGGER private_school_audit_append_only BEFORE UPDATE OR DELETE ON private_school_audit_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- ---------------------------------------------------------------- context helpers
CREATE FUNCTION eduos_ctx_private_school() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.private_school_id', true), '')::uuid $$;
-- The role of the membership the session was opened for (one context, one
-- role, per HSP-00), while it is still active. Someone who is both a teacher
-- and a guardian switches between the two.
CREATE FUNCTION eduos_ctx_ps_membership() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.ps_membership_id', true), '')::uuid $$;
CREATE FUNCTION eduos_ps_roles() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(m.role), '{}') FROM private_school_memberships m JOIN private_schools s ON s.id = m.school_id AND s.status IN ('pending_verification','active','closing')
   WHERE m.id = eduos_ctx_ps_membership() AND m.school_id = eduos_ctx_private_school() AND m.user_id = eduos_ctx_user() AND m.status = 'active'
$$;
CREATE FUNCTION eduos_ps_has(p_roles text[]) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT eduos_ps_roles() && p_roles $$;
-- The campus of the session's membership, for campus staff.
CREATE FUNCTION eduos_ps_campuses() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(m.campus_id), '{}') FROM private_school_memberships m
   WHERE m.id = eduos_ctx_ps_membership() AND m.school_id = eduos_ctx_private_school() AND m.user_id = eduos_ctx_user() AND m.status = 'active' AND m.campus_id IS NOT NULL
$$;
CREATE FUNCTION eduos_ps_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT EXISTS (SELECT 1 FROM private_schools WHERE id = eduos_ctx_private_school() AND status = 'active') $$;
-- May the user see this learner? School-wide administrators and the
-- registrar: every learner. Campus administrators, teachers and staff: their
-- campus. Guardians: learners linked to them. Finance: none (HSP-05 gives
-- finance billing records, never learner records).
CREATE FUNCTION eduos_ps_sees_learner(p_learner uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN eduos_ps_has(ARRAY['school_admin','registrar']) THEN true
    ELSE EXISTS (SELECT 1 FROM private_school_learners l WHERE l.id = p_learner AND l.school_id = eduos_ctx_private_school() AND l.campus_id = ANY(eduos_ps_campuses())
                  AND eduos_ps_has(ARRAY['campus_admin','teacher','staff']))
      OR EXISTS (SELECT 1 FROM private_school_guardian_links g WHERE g.learner_id = p_learner AND g.school_id = eduos_ctx_private_school() AND g.user_id = eduos_ctx_user()
                  AND g.revoked_at IS NULL AND eduos_ps_has(ARRAY['guardian']))
  END
$$;

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['private_school_campuses','private_school_memberships','private_school_invitations','private_school_learners',
                           'private_school_guardian_links','private_school_calendar_events','private_school_audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY school_isolation ON %I
      USING (eduos_is_table_owner() OR school_id = eduos_ctx_private_school())
      WITH CHECK (eduos_is_table_owner() OR school_id = eduos_ctx_private_school())$p$, t);
    EXECUTE format($p$CREATE POLICY members_only ON %I AS RESTRICTIVE
      USING (CASE WHEN eduos_is_table_owner() THEN true ELSE cardinality(eduos_ps_roles()) > 0 END)$p$, t);
  END LOOP;
END $$;
ALTER TABLE private_schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_schools FORCE ROW LEVEL SECURITY;
CREATE POLICY school_isolation ON private_schools USING (eduos_is_table_owner() OR id = eduos_ctx_private_school()) WITH CHECK (eduos_is_table_owner() OR id = eduos_ctx_private_school());
CREATE POLICY members_only ON private_schools AS RESTRICTIVE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE cardinality(eduos_ps_roles()) > 0 END);
CREATE POLICY admin_edits ON private_schools AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) END);

CREATE POLICY admin_campuses ON private_school_campuses AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) END);
CREATE POLICY admin_campuses_update ON private_school_campuses AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) END);
-- Memberships: staff see the staff list; a guardian sees only their own membership.
CREATE POLICY membership_visible ON private_school_memberships AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin','campus_admin','registrar','finance','teacher','staff']) OR user_id = eduos_ctx_user() END);
CREATE POLICY membership_admin ON private_school_memberships AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) END);
-- Invitations: the school admin; the registrar and campus admins may invite guardians.
CREATE POLICY invitation_visible ON private_school_invitations AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) OR (role = 'guardian' AND eduos_ps_has(ARRAY['registrar','campus_admin'])) END);
CREATE POLICY invitation_written ON private_school_invitations AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) OR (role = 'guardian' AND eduos_ps_has(ARRAY['registrar','campus_admin']) AND eduos_ps_active()) END);
CREATE POLICY invitation_revoked ON private_school_invitations AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) OR (role = 'guardian' AND eduos_ps_has(ARRAY['registrar','campus_admin'])) END);
-- Learners: seen by scope; enrolled and changed by the registrar, the school admin, or a campus admin for their campus; only once verified.
CREATE POLICY learner_visible ON private_school_learners AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_sees_learner(id) END);
CREATE POLICY learner_enrolled ON private_school_learners AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_active() AND (eduos_ps_has(ARRAY['school_admin','registrar']) OR (eduos_ps_has(ARRAY['campus_admin']) AND campus_id = ANY(eduos_ps_campuses()))) END);
CREATE POLICY learner_changed ON private_school_learners AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_active() AND (eduos_ps_has(ARRAY['school_admin','registrar']) OR (eduos_ps_has(ARRAY['campus_admin']) AND campus_id = ANY(eduos_ps_campuses()))) END);
CREATE POLICY guardian_link_visible ON private_school_guardian_links AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin','registrar']) OR user_id = eduos_ctx_user() OR (eduos_ps_has(ARRAY['campus_admin']) AND eduos_ps_sees_learner(learner_id)) END);
CREATE POLICY guardian_link_written ON private_school_guardian_links AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_active() AND (eduos_ps_has(ARRAY['school_admin','registrar']) OR (eduos_ps_has(ARRAY['campus_admin']) AND eduos_ps_sees_learner(learner_id))) END);
CREATE POLICY guardian_link_revoked ON private_school_guardian_links AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin','registrar']) OR (eduos_ps_has(ARRAY['campus_admin']) AND eduos_ps_sees_learner(learner_id)) END);
-- Calendar: everyone-events for every member; staff-only events for staff. Written by school or campus administrators.
CREATE POLICY event_visible ON private_school_calendar_events AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE audience = 'everyone' OR eduos_ps_has(ARRAY['school_admin','campus_admin','registrar','finance','teacher','staff']) END);
CREATE POLICY event_written ON private_school_calendar_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) OR (eduos_ps_has(ARRAY['campus_admin']) AND campus_id = ANY(eduos_ps_campuses())) END);
CREATE POLICY event_changed ON private_school_calendar_events AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) OR (eduos_ps_has(ARRAY['campus_admin']) AND campus_id = ANY(eduos_ps_campuses())) END);
CREATE POLICY audit_visible ON private_school_audit_events AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) OR actor_user_id = eduos_ctx_user() END);
CREATE POLICY audit_written ON private_school_audit_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE actor_user_id = eduos_ctx_user() END);

-- A school always keeps an active school administrator.
CREATE FUNCTION eduos_ps_keeps_admin() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private_school_memberships WHERE school_id = NEW.school_id AND role = 'school_admin' AND status = 'active') THEN
    RAISE EXCEPTION 'a private school needs at least one active school administrator' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER private_school_keeps_admin AFTER UPDATE ON private_school_memberships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION eduos_ps_keeps_admin();

-- ---------------------------------------------------------------- sessions
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'sessions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%tenant_kind = ANY%' AND conname <> 'sessions_one_context';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE sessions DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE sessions ADD CONSTRAINT sessions_tenant_kind CHECK (tenant_kind IN ('district','homeschool_family','private_school'));
ALTER TABLE sessions ADD COLUMN private_school_id uuid REFERENCES private_schools(id);
ALTER TABLE sessions ADD COLUMN private_school_membership_id uuid REFERENCES private_school_memberships(id);
ALTER TABLE sessions DROP CONSTRAINT sessions_one_context;
ALTER TABLE sessions ADD CONSTRAINT sessions_one_context CHECK (
  (tenant_kind = 'district' AND district_id IS NOT NULL AND family_id IS NULL AND family_membership_id IS NULL AND private_school_id IS NULL AND private_school_membership_id IS NULL)
  OR (tenant_kind = 'homeschool_family' AND district_id IS NULL AND school_id IS NULL AND family_id IS NOT NULL AND family_membership_id IS NOT NULL AND private_school_id IS NULL AND private_school_membership_id IS NULL)
  OR (tenant_kind = 'private_school' AND district_id IS NULL AND school_id IS NULL AND family_id IS NULL AND family_membership_id IS NULL AND private_school_id IS NOT NULL AND private_school_membership_id IS NOT NULL));

-- ---------------------------------------------------------------- functions for the runtime role outside a school context
CREATE FUNCTION eduos_private_school_contexts(p_user uuid)
RETURNS TABLE(membership_id uuid, school_id uuid, school_name text, role text, campus_name text, school_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, s.id, s.display_name, m.role, c.name, s.status FROM private_school_memberships m
    JOIN private_schools s ON s.id = m.school_id AND s.status IN ('pending_verification','active','closing')
    LEFT JOIN private_school_campuses c ON c.id = m.campus_id
   WHERE m.user_id = p_user AND m.status = 'active' ORDER BY s.display_name, m.role, m.id
$$;
CREATE FUNCTION eduos_private_school_session(p_token_hash text, p_idle_minutes integer)
RETURNS TABLE(session_id uuid, user_id uuid, school_id uuid, membership_id uuid, role text, campus_id uuid, school_status text, csrf_token_hash text,
              verified_email text, client_kind text, last_seen_at timestamptz, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.user_id, s.private_school_id, s.private_school_membership_id, m.role, m.campus_id, p.status, s.csrf_token_hash, s.verified_email, s.client_kind, s.last_seen_at, u.display_name
    FROM sessions s JOIN users u ON u.id = s.user_id AND u.status = 'active'
    JOIN private_school_memberships m ON m.id = s.private_school_membership_id AND m.user_id = s.user_id AND m.school_id = s.private_school_id AND m.status = 'active'
    JOIN private_schools p ON p.id = s.private_school_id AND p.status IN ('pending_verification','active','closing')
   WHERE s.token_hash = p_token_hash AND s.tenant_kind = 'private_school' AND s.revoked_at IS NULL AND s.expires_at > now()
     AND s.last_seen_at > now() - make_interval(mins => p_idle_minutes)
$$;
-- Register a school: pending verification, the caller its first school administrator. At most 3 pending per user.
CREATE FUNCTION eduos_register_private_school(p_user uuid, p_legal_name text, p_display_name text, p_campus text, p_time_zone text, p_jurisdiction text, p_domain text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE sid uuid := gen_random_uuid(); cid uuid; mid uuid;
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM eduos_ctx_user() THEN RAISE EXCEPTION 'not your account' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (SELECT count(*) FROM private_schools WHERE created_by = p_user AND status = 'pending_verification') >= 3 THEN
    RAISE EXCEPTION 'pending_limit_reached' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO tenants(id, kind) VALUES (sid, 'private_school');
  INSERT INTO private_schools(id, legal_name, display_name, time_zone, jurisdiction_ref, website_domain, created_by) VALUES (sid, p_legal_name, p_display_name, p_time_zone, p_jurisdiction, p_domain, p_user);
  INSERT INTO private_school_campuses(school_id, name, created_by) VALUES (sid, p_campus, p_user) RETURNING id INTO cid;
  INSERT INTO private_school_memberships(school_id, user_id, role, added_by) VALUES (sid, p_user, 'school_admin', p_user) RETURNING id INTO mid;
  INSERT INTO private_school_audit_events(school_id, actor_user_id, actor_role, action, resource_type, resource_id) VALUES (sid, p_user, 'school_admin', 'register', 'private_school', sid::text);
  RETURN jsonb_build_object('schoolId', sid, 'campusId', cid, 'membershipId', mid);
END $$;
CREATE FUNCTION eduos_accept_private_school_invitation(p_user uuid, p_email text, p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i private_school_invitations%ROWTYPE; mid uuid; l uuid;
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM eduos_ctx_user() THEN RAISE EXCEPTION 'not your account' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO i FROM private_school_invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR i.revoked_at IS NOT NULL OR i.accepted_at IS NOT NULL OR i.expires_at < now() THEN RETURN jsonb_build_object('ok', false, 'error', 'invitation_not_valid'); END IF;
  IF p_email IS NULL OR lower(p_email) <> i.email THEN RETURN jsonb_build_object('ok', false, 'error', 'invitation_for_another_email'); END IF;
  IF NOT EXISTS (SELECT 1 FROM private_schools WHERE id = i.school_id AND status IN ('pending_verification','active')) THEN RETURN jsonb_build_object('ok', false, 'error', 'invitation_not_valid'); END IF;
  IF EXISTS (SELECT 1 FROM private_school_memberships WHERE school_id = i.school_id AND user_id = p_user AND role = i.role AND status = 'active') THEN RETURN jsonb_build_object('ok', false, 'error', 'already_a_member'); END IF;
  INSERT INTO private_school_memberships(school_id, user_id, role, campus_id, added_by) VALUES (i.school_id, p_user, i.role, i.campus_id, i.invited_by) RETURNING id INTO mid;
  FOREACH l IN ARRAY i.learner_ids LOOP
    IF EXISTS (SELECT 1 FROM private_school_learners WHERE id = l AND school_id = i.school_id AND enrollment_status = 'enrolled') THEN
      INSERT INTO private_school_guardian_links(school_id, learner_id, user_id, relationship, created_by) VALUES (i.school_id, l, p_user, 'parent', i.invited_by) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  UPDATE private_school_invitations SET accepted_by = p_user, accepted_at = now() WHERE id = i.id;
  INSERT INTO private_school_audit_events(school_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
    VALUES (i.school_id, p_user, i.role, 'accept', 'private_school_invitation', i.id::text, 'learners=' || coalesce(array_length(i.learner_ids, 1), 0));
  RETURN jsonb_build_object('ok', true, 'schoolId', i.school_id, 'membershipId', mid, 'role', i.role);
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_private_school_contexts(uuid)','eduos_private_school_session(text,integer)',
      'eduos_register_private_school(uuid,text,text,text,text,text,text)','eduos_accept_private_school_invitation(uuid,text,text)',
      'eduos_ps_roles()','eduos_ps_campuses()','eduos_ps_active()','eduos_ps_sees_learner(uuid)','eduos_ps_has(text[])','eduos_ctx_private_school()','eduos_ctx_ps_membership()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
END $$;

-- A changed website domain is unverified again.
CREATE FUNCTION eduos_ps_domain_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.website_domain IS DISTINCT FROM OLD.website_domain THEN NEW.domain_verified_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER private_schools_domain_reset BEFORE UPDATE ON private_schools FOR EACH ROW EXECUTE FUNCTION eduos_ps_domain_reset();
