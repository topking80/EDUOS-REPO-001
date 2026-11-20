-- SIS-02 scheduled synchronization foundation.
-- A scheduler is a distinct service principal, never a synthetic district user.
-- Human approval remains on integration_connectors.approved_by/approved_at.
CREATE TABLE integration_service_actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_key text NOT NULL UNIQUE CHECK (actor_key IN ('sis_scheduler')),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO integration_service_actors(actor_key,display_name)
VALUES ('sis_scheduler','EduOS SIS Scheduler');

ALTER TABLE integration_sync_runs
  ALTER COLUMN started_by DROP NOT NULL,
  ADD COLUMN started_by_service uuid REFERENCES integration_service_actors(id),
  ADD CONSTRAINT integration_sync_runs_started_actor_check
    CHECK (num_nonnulls(started_by,started_by_service)=1);

ALTER TABLE sis_sync_runs
  ALTER COLUMN initiated_by DROP NOT NULL,
  ADD COLUMN initiated_by_service uuid REFERENCES integration_service_actors(id),
  ADD CONSTRAINT sis_sync_runs_initiated_actor_check
    CHECK (num_nonnulls(initiated_by,initiated_by_service)=1);

ALTER TABLE audit_events
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ADD COLUMN actor_service_id uuid REFERENCES integration_service_actors(id),
  ADD CONSTRAINT audit_events_actor_check
    CHECK (num_nonnulls(actor_user_id,actor_service_id)=1);

CREATE TABLE integration_sync_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  interval_minutes integer NOT NULL DEFAULT 1440 CHECK (interval_minutes BETWEEN 15 AND 10080),
  next_run_at timestamptz,
  paused_at timestamptz,
  pause_reason text CHECK (pause_reason IS NULL OR length(pause_reason)<=240),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  config_version integer NOT NULL CHECK (config_version>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id,connector_id),
  UNIQUE(district_id,connector_id,id),
  FOREIGN KEY(district_id,connector_id) REFERENCES integration_connectors(district_id,id) ON DELETE CASCADE,
  FOREIGN KEY(district_id,created_by) REFERENCES memberships(district_id,user_id),
  FOREIGN KEY(district_id,updated_by) REFERENCES memberships(district_id,user_id),
  FOREIGN KEY(district_id,approved_by) REFERENCES memberships(district_id,user_id),
  CHECK (NOT enabled OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by<>updated_by)),
  CHECK ((NOT enabled OR paused_at IS NOT NULL) = (next_run_at IS NULL))
);
CREATE INDEX integration_sync_schedules_due
  ON integration_sync_schedules(next_run_at,id)
  WHERE enabled=true AND paused_at IS NULL;

CREATE TABLE integration_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  schedule_id uuid NOT NULL REFERENCES integration_sync_schedules(id) ON DELETE CASCADE,
  config_version integer NOT NULL CHECK(config_version>=1),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text CHECK(last_error IS NULL OR length(last_error)<=300),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,connector_id) REFERENCES integration_connectors(district_id,id) ON DELETE CASCADE,
  FOREIGN KEY(district_id,connector_id,schedule_id) REFERENCES integration_sync_schedules(district_id,connector_id,id) ON DELETE CASCADE,
  CHECK ((status='processing') = (lease_until IS NOT NULL AND lease_token IS NOT NULL)),
  CHECK (status<>'processing' OR attempts BETWEEN 1 AND 5)
);
CREATE INDEX integration_sync_jobs_claim
  ON integration_sync_jobs(available_at,created_at)
  WHERE status IN ('pending','processing');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_sync_schedules','integration_sync_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (eduos_is_table_owner() OR district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid) WITH CHECK (eduos_is_table_owner() OR district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid)',
      t||'_tenant_scope',t
    );
  END LOOP;
END $$;

ALTER TABLE integration_service_actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_service_actors FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_service_actors_read ON integration_service_actors
  FOR SELECT USING (true);
REVOKE ALL ON integration_service_actors FROM PUBLIC;
