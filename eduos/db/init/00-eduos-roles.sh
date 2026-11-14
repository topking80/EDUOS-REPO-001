#!/bin/sh
# First-boot role setup for the compose "db" service (32.0.53).
# Runs once, as the bootstrap superuser, when the data volume is empty.
#   eduos_owner  owns the database and schema; used ONLY by `migrate` and `retention`.
#   eduos_app    runtime role used by the API: NOSUPERUSER NOBYPASSRLS, not an
#                owner, so FORCE ROW LEVEL SECURITY applies to every query.
# Existing volumes: see docs/UPGRADING-32.0.53.md.
set -eu
: "${EDUOS_OWNER_PASSWORD:?EDUOS_OWNER_PASSWORD must be set}"
: "${EDUOS_APP_PASSWORD:?EDUOS_APP_PASSWORD must be set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v dbname="$POSTGRES_DB" -v owner_pw="$EDUOS_OWNER_PASSWORD" -v app_pw="$EDUOS_APP_PASSWORD" <<'SQL'
CREATE ROLE eduos_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'owner_pw';
CREATE ROLE eduos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_pw';
ALTER DATABASE :"dbname" OWNER TO eduos_owner;
ALTER SCHEMA public OWNER TO eduos_owner;
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
SQL
