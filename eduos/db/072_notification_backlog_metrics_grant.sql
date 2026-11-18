-- /metrics calls this aggregate SECURITY DEFINER function as the runtime role.
-- Production's default runtime role is eduos_app. Integration environments use
-- a unique role per test database, so keep this migration safe when that
-- conventional role is absent; src/migrate.js reapplies the parameterized
-- runtime_grants.template.sql for the configured EDUOS_APP_ROLE on every run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN
    GRANT EXECUTE ON FUNCTION eduos_queue_backlog() TO eduos_app;
  END IF;
END
$$;
