-- 32.2.0: district limits, the IT administrator role and the district
-- resource mesh (one app catalog, licenses bought once and assigned
-- district-wide, to schools, grades or roles, and shared between schools).
--
-- Isolation model (unchanged): every table carries district_id and the
-- tenant_isolation policy on app.district_id, with FORCE ROW LEVEL SECURITY.
-- New: per-user/per-school RESTRICTIVE policies on seats, launches and
-- requests, so sharing an app never exposes another school's usage rows.
-- Apps never receive roster data from the mesh: a launch carries only the
-- launching user's own claims, limited by the app's data_sharing_scope.

-- ---------------------------------------------------------------------------
-- IT administrator: district-wide, no student-record permissions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname, conrelid::regclass AS tbl FROM pg_constraint
            WHERE contype='c' AND conrelid IN ('memberships'::regclass,'flow_events'::regclass)
              AND pg_get_constraintdef(oid) LIKE '%superintendent%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK(role IN ('superintendent','it_admin','principal','teacher','parent','pupil'));
ALTER TABLE memberships ADD CONSTRAINT memberships_school_scope_check
  CHECK((role IN ('superintendent','it_admin') AND school_id IS NULL)
     OR (role NOT IN ('superintendent','it_admin') AND school_id IS NOT NULL));
ALTER TABLE flow_events ADD CONSTRAINT flow_events_actor_role_check
  CHECK(actor_role IN ('superintendent','it_admin','principal','teacher','parent','pupil'));
ALTER TABLE flow_events ADD CONSTRAINT flow_events_audience_check
  CHECK(cardinality(audience) BETWEEN 1 AND 6
    AND audience <@ ARRAY['superintendent','it_admin','principal','teacher','parent','pupil']::text[]);

-- True when the current role owns the mesh tables: only SECURITY DEFINER
-- functions below run that way (the runtime role is never an owner; the API
-- refuses to start otherwise). Lets those functions compute aggregates without
-- giving the runtime role row access.
CREATE FUNCTION eduos_is_table_owner() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
                          WHERE c.oid='public.districts'::regclass)
$$;
CREATE FUNCTION eduos_is_district_role() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.role', true) IN ('superintendent','it_admin') $$;

-- ---------------------------------------------------------------------------
-- District-configurable caps. NULL means unlimited (the default for every
-- district; no row is needed). Product limits are opt-in, never built in.
-- ---------------------------------------------------------------------------
CREATE TABLE district_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  max_schools integer CHECK(max_schools IS NULL OR max_schools > 0),
  max_students integer CHECK(max_students IS NULL OR max_students > 0),
  max_users integer CHECK(max_users IS NULL OR max_users > 0),
  max_active_webhooks integer CHECK(max_active_webhooks IS NULL OR max_active_webhooks > 0),
  max_apps integer CHECK(max_apps IS NULL OR max_apps > 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- App catalog.
-- ---------------------------------------------------------------------------
CREATE TABLE apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  owner_school_id uuid,                       -- NULL: district-owned
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
  vendor text NOT NULL CHECK(length(btrim(vendor)) BETWEEN 1 AND 160),
  description text CHECK(description IS NULL OR length(description) <= 2000),
  category text CHECK(category IS NULL OR length(category) <= 60),
  launch_url text NOT NULL CHECK(length(launch_url) <= 2048 AND launch_url ~ '^https?://'),
  integration_type text NOT NULL CHECK(integration_type IN ('link','oidc_sso','lti13','api')),
  integration_config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK(jsonb_typeof(integration_config)='object' AND length(integration_config::text) <= 8192),
  data_sharing_scope text NOT NULL DEFAULT 'none'
    CHECK(data_sharing_scope IN ('none','identity','roster_basic','roster_full','grades','attendance')),
  dpa_status text NOT NULL DEFAULT 'none' CHECK(dpa_status IN ('none','pending','signed','sdpc_signed')),
  dpa_expires_on date,
  coppa_compliant boolean NOT NULL DEFAULT false,
  ferpa_school_official boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,owner_school_id) REFERENCES schools(district_id,id)
);
CREATE UNIQUE INDEX apps_active_name ON apps(district_id, lower(name)) WHERE status='active';

CREATE TABLE app_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  app_id uuid NOT NULL,
  purchased_by_school_id uuid,                -- NULL: bought by the district
  seat_limit integer CHECK(seat_limit IS NULL OR seat_limit > 0),  -- NULL: unlimited
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled')),
  note text CHECK(note IS NULL OR length(note) <= 500),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(ends_on IS NULL OR ends_on >= starts_on),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,app_id) REFERENCES apps(district_id,id),
  FOREIGN KEY(district_id,purchased_by_school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX app_licenses_app ON app_licenses(district_id,app_id);

-- Who may use an app. scope='district': every school. scope='school': one
-- school (granted by the district, or shared by the owning school).
CREATE TABLE app_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  app_id uuid NOT NULL,
  scope text NOT NULL CHECK(scope IN ('district','school')),
  school_id uuid,
  grade_levels text[] CHECK(grade_levels IS NULL OR (cardinality(grade_levels) BETWEEN 1 AND 16)),  -- NULL: all grades
  roles text[] NOT NULL DEFAULT ARRAY['principal','teacher','parent','pupil']::text[]
    CHECK(cardinality(roles) BETWEEN 1 AND 6
      AND roles <@ ARRAY['superintendent','it_admin','principal','teacher','parent','pupil']::text[]),
  shared_by_school_id uuid,                   -- set when the owning school shared it
  assigned_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  CHECK((scope='district' AND school_id IS NULL) OR (scope='school' AND school_id IS NOT NULL)),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,app_id) REFERENCES apps(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY(district_id,shared_by_school_id) REFERENCES schools(district_id,id)
);
CREATE UNIQUE INDEX app_assignments_active ON app_assignments(district_id,app_id,scope,school_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;

-- Principals (or district staff) ask for an app; the district decides.
CREATE TABLE app_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  app_id uuid,                                -- an existing catalog app, or
  requested_name text CHECK(requested_name IS NULL OR length(btrim(requested_name)) BETWEEN 1 AND 160),
  requested_vendor text CHECK(requested_vendor IS NULL OR length(requested_vendor) <= 160),
  requested_url text CHECK(requested_url IS NULL OR (length(requested_url) <= 2048 AND requested_url ~ '^https?://')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','withdrawn')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text CHECK(decision_note IS NULL OR length(decision_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(app_id IS NOT NULL OR requested_name IS NOT NULL),
  CHECK((status IN ('approved','denied')) = (decided_at IS NOT NULL)),
  FOREIGN KEY(district_id,app_id) REFERENCES apps(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX app_requests_queue ON app_requests(district_id,status,created_at DESC);

-- A seat is taken on a user's first launch under a license.
CREATE TABLE app_seats (
  district_id uuid NOT NULL REFERENCES districts(id),
  license_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  school_id uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(license_id,user_id),
  FOREIGN KEY(district_id,license_id) REFERENCES app_licenses(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX app_seats_school ON app_seats(district_id,school_id);

-- Append-only launch ledger (also written to audit_events).
CREATE TABLE app_launches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  app_id uuid NOT NULL,
  license_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  school_id uuid,
  role text NOT NULL,
  integration_type text NOT NULL,
  shared_scope text NOT NULL,
  launched_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,app_id) REFERENCES apps(district_id,id),
  FOREIGN KEY(district_id,license_id) REFERENCES app_licenses(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX app_launches_usage ON app_launches(district_id,app_id,school_id,launched_at DESC);

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['district_settings','apps','app_licenses','app_assignments','app_requests','app_seats','app_launches'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Usage rows: district roles see all; a principal sees their own school;
-- everyone else sees only their own rows. Inserts are only ever for oneself.
CREATE POLICY own_scope ON app_launches AS RESTRICTIVE
  USING (eduos_is_table_owner() OR eduos_is_district_role()
         OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
         OR (current_setting('app.role', true) = 'principal'
             AND school_id = nullif(current_setting('app.school_id', true), '')::uuid))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY own_scope ON app_seats AS RESTRICTIVE
  USING (eduos_is_table_owner() OR eduos_is_district_role()
         OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
         OR (current_setting('app.role', true) = 'principal'
             AND school_id = nullif(current_setting('app.school_id', true), '')::uuid))
  WITH CHECK (eduos_is_table_owner() OR user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY own_scope ON app_requests AS RESTRICTIVE
  USING (eduos_is_table_owner() OR eduos_is_district_role()
         OR school_id = nullif(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR eduos_is_district_role()
         OR school_id = nullif(current_setting('app.school_id', true), '')::uuid);
-- Only district roles change district caps.
CREATE POLICY district_roles_write ON district_settings AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_district_role()) WITH CHECK (eduos_is_table_owner() OR eduos_is_district_role());
CREATE POLICY district_roles_insert ON district_settings AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_is_district_role());

-- Claim (or reuse) a seat for the CURRENT user (app.user_id) under a license.
-- Runs as the owner so it can count every school's seats; the caller cannot
-- name another user. Returns 'ok', 'exhausted' or 'inactive'.
CREATE FUNCTION eduos_claim_seat(p_license uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid;
        u uuid := nullif(current_setting('app.user_id', true), '')::uuid;
        s uuid := nullif(current_setting('app.school_id', true), '')::uuid;
        lic record; used int;
BEGIN
  IF d IS NULL OR u IS NULL THEN RAISE EXCEPTION 'tenant context is required'; END IF;
  SELECT id,seat_limit,status,starts_on,ends_on INTO lic FROM app_licenses WHERE id=p_license AND district_id=d FOR UPDATE;
  IF NOT FOUND OR lic.status<>'active' OR lic.starts_on>current_date OR (lic.ends_on IS NOT NULL AND lic.ends_on<current_date) THEN
    RETURN 'inactive';
  END IF;
  IF EXISTS(SELECT 1 FROM app_seats WHERE license_id=p_license AND user_id=u) THEN RETURN 'ok'; END IF;
  IF lic.seat_limit IS NOT NULL THEN
    SELECT count(*) INTO used FROM app_seats WHERE license_id=p_license AND district_id=d;
    IF used >= lic.seat_limit THEN RETURN 'exhausted'; END IF;
  END IF;
  INSERT INTO app_seats(district_id,license_id,user_id,school_id) VALUES(d,p_license,u,s);
  RETURN 'ok';
END; $$;
REVOKE ALL ON FUNCTION eduos_claim_seat(uuid) FROM PUBLIC;

-- License usage, aggregated per school. District roles: every school.
-- The principal of the app's owning school: every school the app is used at,
-- as counts only (no user rows). Any other principal: their own school only.
CREATE FUNCTION eduos_app_usage(p_app uuid)
RETURNS TABLE(school_id uuid, seats_used bigint, launches bigint, launches_30d bigint, last_launch_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid;
        r text := current_setting('app.role', true);
        s uuid := nullif(current_setting('app.school_id', true), '')::uuid;
        owner uuid; everything boolean;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'tenant context is required'; END IF;
  SELECT a.owner_school_id INTO owner FROM apps a WHERE a.id=p_app AND a.district_id=d;
  IF NOT FOUND THEN RETURN; END IF;
  everything := r IN ('superintendent','it_admin') OR (r='principal' AND owner IS NOT NULL AND owner=s);
  IF NOT everything AND r<>'principal' THEN RETURN; END IF;
  RETURN QUERY
    WITH seat AS (SELECT st.school_id, count(*) AS n FROM app_seats st JOIN app_licenses l ON l.id=st.license_id
                   WHERE l.app_id=p_app AND st.district_id=d GROUP BY st.school_id),
         launch AS (SELECT la.school_id, count(*) AS n, count(*) FILTER (WHERE la.launched_at > now()-interval '30 days') AS n30,
                           max(la.launched_at) AS last_at
                      FROM app_launches la WHERE la.app_id=p_app AND la.district_id=d GROUP BY la.school_id)
    SELECT coalesce(seat.school_id,launch.school_id), coalesce(seat.n,0), coalesce(launch.n,0), coalesce(launch.n30,0), launch.last_at
      FROM seat FULL JOIN launch
        ON coalesce(launch.school_id,'00000000-0000-0000-0000-000000000000'::uuid)=coalesce(seat.school_id,'00000000-0000-0000-0000-000000000000'::uuid)
     WHERE everything OR coalesce(seat.school_id,launch.school_id)=s;
END; $$;
REVOKE ALL ON FUNCTION eduos_app_usage(uuid) FROM PUBLIC;
