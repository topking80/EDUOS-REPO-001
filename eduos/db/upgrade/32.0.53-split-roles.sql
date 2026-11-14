-- One-time role split for databases created by EduOS <= 32.0.52, where the
-- API connected as the bootstrap superuser (compose POSTGRES_USER=eduos).
-- Run ONCE as that superuser, then run `npm run db:migrate` / `docker compose up`
-- with migrate connecting as eduos_owner and the API as eduos_app:
--   psql -U eduos -d eduos -v ON_ERROR_STOP=1 \
--        -v owner_pw="$EDUOS_OWNER_PASSWORD" -v app_pw="$EDUOS_APP_PASSWORD" \
--        -f db/upgrade/32.0.53-split-roles.sql
-- (REASSIGN OWNED cannot be used: the bootstrap superuser owns system objects.)
CREATE ROLE eduos_owner LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'owner_pw';
CREATE ROLE eduos_app   LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'app_pw';
ALTER DATABASE eduos OWNER TO eduos_owner;
ALTER SCHEMA public OWNER TO eduos_owner;
-- Hand every EduOS table, sequence and function to the owner role (extension
-- members such as pgcrypto's functions stay with the superuser).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT format('ALTER TABLE public.%I OWNER TO eduos_owner', tablename) AS s FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE r.s; END LOOP;
  FOR r IN SELECT format('ALTER SEQUENCE public.%I OWNER TO eduos_owner', c.relname) AS s FROM pg_class c
            WHERE c.relkind='S' AND c.relnamespace='public'::regnamespace
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype IN ('a','i')) LOOP
    EXECUTE r.s; END LOOP;
  FOR r IN SELECT format('ALTER FUNCTION %s OWNER TO eduos_owner', p.oid::regprocedure) AS s FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') LOOP
    EXECUTE r.s; END LOOP;
END $$;
