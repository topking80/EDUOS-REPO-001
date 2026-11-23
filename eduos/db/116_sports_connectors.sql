-- SPORTS-02: MaxPreps and Hudl connectors, with the school's own account.
--
-- A school that already has a MaxPreps or Hudl account connects it with the
-- access key (API key or partner token) the vendor gives that account. The
-- school's principal, vice principal or athletic director enters it; district
-- IT approves before anything moves. The key is stored encrypted and never
-- shown again; changing it needs approving again. Calls go only to that
-- vendor's own site, in the EduOS sports sync format (docs/SPORTS-CONNECTORS.md).
--
-- What a connector may do, each switched on per connector:
--   send the roster   only athletes whose family opted in for that service (SPORTS-01)
--   send the schedule events with published scores
--   bring results in  scores and team stats wait for the coach; approving makes
--                     a draft result, which is published the usual way
--   bring film in     Hudl links only (no video stored); the coach can hide one
-- Every run is logged.

CREATE TABLE sports_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  service text NOT NULL CHECK (service IN ('maxpreps','hudl')),
  base_url text NOT NULL CHECK (length(base_url) <= 300),
  secret_enc text NOT NULL,
  key_hint text NOT NULL CHECK (length(key_hint) <= 8),
  send_roster boolean NOT NULL DEFAULT false,
  send_schedule boolean NOT NULL DEFAULT false,
  pull_results boolean NOT NULL DEFAULT false,
  pull_film boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paused','revoked')),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  last_run_at timestamptz,
  CHECK (send_roster OR send_schedule OR pull_results OR pull_film),
  CHECK (pull_film = false OR service = 'hudl'),
  CHECK (status NOT IN ('approved','rejected') OR decided_by IS NOT NULL),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  UNIQUE (district_id, id)
);
CREATE UNIQUE INDEX sports_connectors_one ON sports_connectors(school_id, service) WHERE status <> 'revoked';

CREATE TABLE sports_connector_teams (
  connector_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  activity_id uuid NOT NULL REFERENCES school_activities(id),
  external_team_id text NOT NULL CHECK (external_team_id ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, activity_id),
  FOREIGN KEY (district_id, connector_id) REFERENCES sports_connectors(district_id, id)
);

CREATE TABLE sports_connector_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  connector_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('send_roster','send_schedule','pull_results','pull_film')),
  ok boolean NOT NULL,
  count integer NOT NULL DEFAULT 0,
  withheld integer NOT NULL DEFAULT 0,
  message text CHECK (message IS NULL OR length(message) <= 300),
  run_by uuid NOT NULL REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, connector_id) REFERENCES sports_connectors(district_id, id)
);
CREATE INDEX sports_connector_runs_activity ON sports_connector_runs(district_id, activity_id, at DESC);

CREATE TABLE sports_inbound_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  connector_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  event_id uuid NOT NULL REFERENCES school_events(id),
  opponent text NOT NULL CHECK (length(opponent) BETWEEN 1 AND 120),
  home_score smallint NOT NULL CHECK (home_score BETWEEN 0 AND 999),
  away_score smallint NOT NULL CHECK (away_score BETWEEN 0 AND 999),
  team_stats jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(team_stats) = 'object' AND octet_length(team_stats::text) <= 4000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  received_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  FOREIGN KEY (district_id, connector_id) REFERENCES sports_connectors(district_id, id)
);
CREATE UNIQUE INDEX sports_inbound_results_pending ON sports_inbound_results(event_id, connector_id) WHERE status = 'pending';

CREATE TABLE sports_film_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  connector_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  event_id uuid REFERENCES school_events(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  url text NOT NULL CHECK (length(url) <= 500 AND url ~ '^https://([a-z0-9-]+\.)*hudl\.com(/[^\s]*)?$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  hidden_by uuid REFERENCES users(id),
  hidden_at timestamptz,
  FOREIGN KEY (district_id, connector_id) REFERENCES sports_connectors(district_id, id)
);
CREATE UNIQUE INDEX sports_film_links_once ON sports_film_links(activity_id, url);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sports_connectors','sports_connector_teams','sports_connector_runs','sports_inbound_results','sports_film_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The school's sports leads: principal, vice principal, athletic director.
CREATE FUNCTION eduos_sports_lead(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_school = eduos_ctx_school() AND (coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal') OR eduos_is_athletic_director(p_school))
$$;

CREATE POLICY scope_read ON sports_connectors AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_sports_lead(school_id)
  OR coalesce(eduos_ctx_role(), '') IN ('it_admin','superintendent')
  OR (coalesce(eduos_ctx_role(), '') IN ('teacher','coach') AND school_id = eduos_ctx_school()));  -- coaches link their teams; the key stays encrypted and no route returns it
CREATE POLICY scope_insert ON sports_connectors AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_sports_lead(school_id) AND requested_by = eduos_ctx_user() AND status = 'pending'));
-- Leads change the key (back to pending), pause, resume, revoke; IT decides.
CREATE POLICY scope_update ON sports_connectors AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_sports_lead(school_id) OR coalesce(eduos_ctx_role(), '') = 'it_admin')
  WITH CHECK (eduos_is_table_owner() OR (coalesce(eduos_ctx_role(), '') = 'it_admin')
    OR (eduos_sports_lead(school_id) AND status IN ('pending','paused','approved','revoked') AND (status <> 'approved' OR decided_by IS NOT NULL)));

-- Only district IT approves: a lead can resume a paused connector (it stays
-- approved by IT), but never set approved on a pending or rejected one.
CREATE FUNCTION eduos_sports_connector_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_it boolean := eduos_is_table_owner() OR coalesce(eduos_ctx_role(), '') = 'it_admin';
BEGIN
  IF OLD.status = 'revoked' THEN RAISE EXCEPTION 'connector is revoked' USING ERRCODE = '42501'; END IF;
  IF (NEW.status, NEW.decided_by, NEW.decided_at) IS DISTINCT FROM (OLD.status, OLD.decided_by, OLD.decided_at) AND NEW.status IN ('approved','rejected') AND NOT is_it
     AND NOT (OLD.status = 'paused' AND NEW.status = 'approved' AND (NEW.decided_by, NEW.decided_at) IS NOT DISTINCT FROM (OLD.decided_by, OLD.decided_at)) THEN
    RAISE EXCEPTION 'only district IT approves a sports connector' USING ERRCODE = '42501';
  END IF;
  IF NEW.secret_enc IS DISTINCT FROM OLD.secret_enc OR NEW.base_url IS DISTINCT FROM OLD.base_url
     OR (NEW.send_roster, NEW.send_schedule, NEW.pull_results, NEW.pull_film) IS DISTINCT FROM (OLD.send_roster, OLD.send_schedule, OLD.pull_results, OLD.pull_film) THEN
    IF NOT is_it OR NEW.status <> 'approved' THEN NEW.status := 'pending'; NEW.decided_by := NULL; NEW.decided_at := NULL; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sports_connectors_guard BEFORE UPDATE ON sports_connectors FOR EACH ROW EXECUTE FUNCTION eduos_sports_connector_guard();

CREATE POLICY scope_write ON sports_connector_teams AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_manages_team(activity_id) AND set_by = eduos_ctx_user()));
CREATE POLICY scope_update ON sports_connector_teams AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_manages_team(activity_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_manages_team(activity_id) AND set_by = eduos_ctx_user()));
CREATE POLICY scope_read ON sports_connector_runs AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_manages_team(activity_id)
  OR coalesce(eduos_ctx_role(), '') IN ('it_admin','superintendent'));
CREATE POLICY scope_insert ON sports_connector_runs AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_manages_team(activity_id) AND run_by = eduos_ctx_user()));
CREATE POLICY scope_read ON sports_inbound_results AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_manages_team(activity_id));
CREATE POLICY scope_insert ON sports_inbound_results AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_manages_team(activity_id));
CREATE POLICY scope_update ON sports_inbound_results AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_manages_team(activity_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_manages_team(activity_id) AND reviewed_by = eduos_ctx_user()));
CREATE POLICY scope_insert ON sports_film_links AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_manages_team(activity_id));
CREATE POLICY scope_update ON sports_film_links AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_manages_team(activity_id));
