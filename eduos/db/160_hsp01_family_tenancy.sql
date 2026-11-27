-- HSP-01: the homeschool family workspace (design: docs/product/hsp-00-architecture-and-tenancy.md).
--
-- HSP-01a  tenants: the tenant supertype. Every district gets a row (kind
--          'district'); a family is kind 'homeschool_family'. districts are
--          otherwise unchanged, and no family ID ever goes in a district_id.
-- HSP-01b  sessions carry their tenant: a district session as today, or a
--          family session (district_id NULL, family_id set). One context per
--          session.
-- HSP-01c  family tables, isolated by app.family_id under forced RLS. In a
--          family session app.district_id is empty, so every district table's
--          policy matches nothing; in a district session app.family_id is
--          empty, so no family table matches.

-- ---------------------------------------------------------------- HSP-01a
CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('district','private_school','homeschool_family')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closing','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON tenants USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

INSERT INTO tenants(id, kind, created_at) SELECT id, 'district', created_at FROM districts ON CONFLICT DO NOTHING;

-- A new district gets its tenant row first, so the foreign key below holds.
CREATE FUNCTION eduos_district_tenant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO tenants(id, kind) VALUES (NEW.id, 'district') ON CONFLICT (id) DO NOTHING;
  IF (SELECT kind FROM tenants WHERE id = NEW.id) <> 'district' THEN RAISE EXCEPTION 'tenant % is not a district', NEW.id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER districts_tenant BEFORE INSERT ON districts FOR EACH ROW EXECUTE FUNCTION eduos_district_tenant();
ALTER TABLE districts ADD CONSTRAINT districts_tenant_fk FOREIGN KEY (id) REFERENCES tenants(id);

-- ---------------------------------------------------------------- HSP-01c (families first; sessions reference them)
CREATE TABLE homeschool_families (
  id uuid PRIMARY KEY REFERENCES tenants(id),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 120),
  time_zone text NOT NULL DEFAULT 'America/New_York' CHECK (length(time_zone) BETWEEN 3 AND 64),
  jurisdiction_ref text CHECK (jurisdiction_ref IS NULL OR jurisdiction_ref ~ '^US-[A-Z]{2}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE family_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES homeschool_families(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','co_educator','guardian_viewer','learner')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid NOT NULL REFERENCES users(id),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 500),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  UNIQUE (family_id, id)
);
CREATE UNIQUE INDEX family_memberships_one_active ON family_memberships(family_id, user_id) WHERE status = 'active';

CREATE TABLE family_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES homeschool_families(id),
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320 AND email LIKE '%@%'),
  role text NOT NULL CHECK (role IN ('co_educator','guardian_viewer')),
  learner_ids uuid[] NOT NULL DEFAULT '{}',
  authority text NOT NULL CHECK (authority IN ('educational','view')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid NOT NULL REFERENCES users(id),
  invited_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK ((role = 'guardian_viewer') = (authority = 'view'))
);

CREATE TABLE family_learners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES homeschool_families(id),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  grade_band text CHECK (grade_band IS NULL OR grade_band IN ('pre_k','k','1','2','3','4','5','6','7','8','9','10','11','12','adult')),
  birth_year integer CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  UNIQUE (family_id, id)
);

CREATE TABLE family_learner_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  relationship text NOT NULL CHECK (relationship IN ('parent','legal_guardian','co_educator','learner_self')),
  authority text NOT NULL CHECK (authority IN ('full','educational','view')),
  verification text NOT NULL DEFAULT 'self_declared' CHECK (verification IN ('self_declared','verified_by_owner','verified_document')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES users(id),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 500),
  FOREIGN KEY (family_id, learner_id) REFERENCES family_learners(family_id, id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (relationship <> 'learner_self' OR authority = 'view')
);
CREATE UNIQUE INDEX family_learner_relationships_open ON family_learner_relationships(learner_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE family_calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES homeschool_families(id),
  learner_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'lesson' CHECK (kind IN ('lesson','field_trip','co_op','appointment','break','other')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  FOREIGN KEY (family_id, learner_id) REFERENCES family_learners(family_id, id),
  CHECK (ends_at >= starts_at),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE INDEX family_calendar_range ON family_calendar_events(family_id, starts_at);

-- Every family action, append-only (district audit_events needs a district).
CREATE TABLE family_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES homeschool_families(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_role text NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 60),
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 60),
  resource_id text,
  detail text CHECK (detail IS NULL OR length(detail) <= 1000),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX family_audit_time ON family_audit_events(family_id, occurred_at DESC);
CREATE TRIGGER family_audit_append_only BEFORE UPDATE OR DELETE ON family_audit_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- ---------------------------------------------------------------- context helpers
CREATE FUNCTION eduos_ctx_family() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.family_id', true), '')::uuid $$;
-- The signed-in user's role in the family in context (re-checked on every call).
CREATE FUNCTION eduos_family_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.role FROM family_memberships m JOIN homeschool_families f ON f.id = m.family_id AND f.status = 'active'
   WHERE m.family_id = eduos_ctx_family() AND m.user_id = eduos_ctx_user() AND m.status = 'active'
$$;
-- The signed-in user's authority over one learner: the owner has full
-- authority over every learner; others only through an open relationship.
CREATE FUNCTION eduos_family_authority(p_learner uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN eduos_family_role() IS NULL THEN NULL
              WHEN eduos_family_role() = 'owner' THEN 'full'
              ELSE (SELECT r.authority FROM family_learner_relationships r
                     WHERE r.family_id = eduos_ctx_family() AND r.learner_id = p_learner AND r.user_id = eduos_ctx_user() AND r.revoked_at IS NULL)
         END
$$;

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['family_memberships','family_invitations','family_learners','family_learner_relationships','family_calendar_events','family_audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY family_isolation ON %I
      USING (eduos_is_table_owner() OR family_id = eduos_ctx_family())
      WITH CHECK (eduos_is_table_owner() OR family_id = eduos_ctx_family())$p$, t);
  END LOOP;
END $$;
ALTER TABLE homeschool_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE homeschool_families FORCE ROW LEVEL SECURITY;
CREATE POLICY family_isolation ON homeschool_families USING (eduos_is_table_owner() OR id = eduos_ctx_family())
  WITH CHECK (eduos_is_table_owner() OR id = eduos_ctx_family());

-- Only active members of the family in context, on top of the isolation
-- above. CASE (not OR) so the owner role, which the definer functions run
-- as, never re-enters them.
CREATE POLICY members_only ON homeschool_families AS RESTRICTIVE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() IS NOT NULL END);
CREATE POLICY owner_edits ON homeschool_families AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' END);
CREATE POLICY members_only ON family_memberships AS RESTRICTIVE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() IS NOT NULL END);
CREATE POLICY owner_manages ON family_memberships AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' END);
CREATE POLICY owner_updates ON family_memberships AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' END);
CREATE POLICY owner_only ON family_invitations AS RESTRICTIVE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' END);
CREATE POLICY owner_or_self ON family_audit_events AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' OR actor_user_id = eduos_ctx_user() END);
CREATE POLICY members_write ON family_audit_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() IS NOT NULL AND actor_user_id = eduos_ctx_user() END);
-- Learners: seen only with some authority; added, changed and archived by the owner.
CREATE POLICY learner_visible ON family_learners AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_authority(id) IS NOT NULL END);
CREATE POLICY owner_adds ON family_learners AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' END);
CREATE POLICY owner_changes ON family_learners AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' END);
CREATE POLICY relationship_visible ON family_learner_relationships AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' OR (eduos_family_role() IS NOT NULL AND user_id = eduos_ctx_user()) END);
CREATE POLICY owner_relates ON family_learner_relationships AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' END);
CREATE POLICY owner_unrelates ON family_learner_relationships AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner' END);
-- Calendar: family-wide events for every member; a learner's events with authority over them.
-- Writes: the owner, or a co-educator with educational authority over the learner.
CREATE POLICY event_visible ON family_calendar_events AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() IS NOT NULL AND (learner_id IS NULL OR eduos_family_authority(learner_id) IS NOT NULL) END);
CREATE POLICY event_written ON family_calendar_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner'
    OR (eduos_family_role() = 'co_educator' AND learner_id IS NOT NULL AND eduos_family_authority(learner_id) = 'educational') END);
CREATE POLICY event_changed ON family_calendar_events AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_role() = 'owner'
    OR (eduos_family_role() = 'co_educator' AND learner_id IS NOT NULL AND eduos_family_authority(learner_id) = 'educational') END);

-- A family always keeps at least one active owner.
CREATE FUNCTION eduos_family_keeps_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM family_memberships WHERE family_id = NEW.family_id AND role = 'owner' AND status = 'active') THEN
    RAISE EXCEPTION 'a family needs at least one active owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER family_keeps_owner AFTER UPDATE ON family_memberships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION eduos_family_keeps_owner();

-- ---------------------------------------------------------------- HSP-01b sessions
ALTER TABLE sessions ADD COLUMN tenant_kind text NOT NULL DEFAULT 'district' CHECK (tenant_kind IN ('district','homeschool_family'));
ALTER TABLE sessions ADD COLUMN family_id uuid REFERENCES homeschool_families(id);
ALTER TABLE sessions ADD COLUMN family_membership_id uuid REFERENCES family_memberships(id);
ALTER TABLE sessions ALTER COLUMN district_id DROP NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_one_context CHECK (
  (tenant_kind = 'district' AND district_id IS NOT NULL AND family_id IS NULL AND family_membership_id IS NULL)
  OR (tenant_kind = 'homeschool_family' AND district_id IS NULL AND school_id IS NULL AND family_id IS NOT NULL AND family_membership_id IS NOT NULL));

-- ---------------------------------------------------------------- functions the runtime role calls outside a family context
-- The user's active family memberships (for the context switcher and sign-in).
CREATE FUNCTION eduos_family_contexts(p_user uuid)
RETURNS TABLE(membership_id uuid, family_id uuid, family_name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, f.id, f.display_name, m.role FROM family_memberships m JOIN homeschool_families f ON f.id = m.family_id AND f.status = 'active'
   WHERE m.user_id = p_user AND m.status = 'active' ORDER BY f.display_name, m.id
$$;
-- Resolve a family session: the session, its membership still active, the family still active.
CREATE FUNCTION eduos_family_session(p_token_hash text, p_idle_minutes integer)
RETURNS TABLE(session_id uuid, user_id uuid, family_id uuid, family_membership_id uuid, role text, csrf_token_hash text,
              verified_email text, client_kind text, last_seen_at timestamptz, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.user_id, s.family_id, s.family_membership_id, m.role, s.csrf_token_hash, s.verified_email, s.client_kind, s.last_seen_at, u.display_name
    FROM sessions s JOIN users u ON u.id = s.user_id AND u.status = 'active'
    JOIN family_memberships m ON m.id = s.family_membership_id AND m.user_id = s.user_id AND m.family_id = s.family_id AND m.status = 'active'
    JOIN homeschool_families f ON f.id = s.family_id AND f.status = 'active'
   WHERE s.token_hash = p_token_hash AND s.tenant_kind = 'homeschool_family' AND s.revoked_at IS NULL AND s.expires_at > now()
     AND s.last_seen_at > now() - make_interval(mins => p_idle_minutes)
$$;
-- Create a family with the calling user as its owner. Only for the user the
-- session belongs to (app.user_id), at most 5 active families owned per user.
CREATE FUNCTION eduos_create_family(p_user uuid, p_name text, p_time_zone text, p_jurisdiction text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE fid uuid := gen_random_uuid();
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM eduos_ctx_user() THEN RAISE EXCEPTION 'not your account' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (SELECT count(*) FROM family_memberships m JOIN homeschool_families f ON f.id = m.family_id
       WHERE m.user_id = p_user AND m.role = 'owner' AND m.status = 'active' AND f.status = 'active') >= 5 THEN
    RAISE EXCEPTION 'family_limit_reached' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO tenants(id, kind) VALUES (fid, 'homeschool_family');
  INSERT INTO homeschool_families(id, display_name, time_zone, jurisdiction_ref, created_by) VALUES (fid, p_name, p_time_zone, p_jurisdiction, p_user);
  INSERT INTO family_memberships(family_id, user_id, role, added_by) VALUES (fid, p_user, 'owner', p_user);
  INSERT INTO family_audit_events(family_id, actor_user_id, actor_role, action, resource_type, resource_id) VALUES (fid, p_user, 'owner', 'create', 'family', fid::text);
  RETURN fid;
END $$;
-- Accept an invitation: only the signed-in user whose verified email it was
-- sent to; once; before it expires. Adds the membership and the learner
-- relationships the invitation named.
CREATE FUNCTION eduos_accept_family_invitation(p_user uuid, p_email text, p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i family_invitations%ROWTYPE; mid uuid; l uuid;
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM eduos_ctx_user() THEN RAISE EXCEPTION 'not your account' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO i FROM family_invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR i.revoked_at IS NOT NULL OR i.accepted_at IS NOT NULL OR i.expires_at < now() THEN RETURN jsonb_build_object('ok', false, 'error', 'invitation_not_valid'); END IF;
  IF p_email IS NULL OR lower(p_email) <> i.email THEN RETURN jsonb_build_object('ok', false, 'error', 'invitation_for_another_email'); END IF;
  IF NOT EXISTS (SELECT 1 FROM homeschool_families WHERE id = i.family_id AND status = 'active') THEN RETURN jsonb_build_object('ok', false, 'error', 'invitation_not_valid'); END IF;
  IF EXISTS (SELECT 1 FROM family_memberships WHERE family_id = i.family_id AND user_id = p_user AND status = 'active') THEN RETURN jsonb_build_object('ok', false, 'error', 'already_a_member'); END IF;
  INSERT INTO family_memberships(family_id, user_id, role, added_by) VALUES (i.family_id, p_user, i.role, i.invited_by) RETURNING id INTO mid;
  FOREACH l IN ARRAY i.learner_ids LOOP
    IF EXISTS (SELECT 1 FROM family_learners WHERE id = l AND family_id = i.family_id AND status = 'active') THEN
      INSERT INTO family_learner_relationships(family_id, learner_id, user_id, relationship, authority, created_by)
        VALUES (i.family_id, l, p_user, CASE WHEN i.role = 'co_educator' THEN 'co_educator' ELSE 'parent' END, i.authority, i.invited_by)
        ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  UPDATE family_invitations SET accepted_by = p_user, accepted_at = now() WHERE id = i.id;
  INSERT INTO family_audit_events(family_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
    VALUES (i.family_id, p_user, i.role, 'accept', 'family_invitation', i.id::text, 'learners=' || coalesce(array_length(i.learner_ids, 1), 0));
  RETURN jsonb_build_object('ok', true, 'familyId', i.family_id, 'membershipId', mid, 'role', i.role);
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_family_contexts(uuid)','eduos_family_session(text,integer)','eduos_create_family(uuid,text,text,text)',
                            'eduos_accept_family_invitation(uuid,text,text)','eduos_family_role()','eduos_family_authority(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
END $$;
