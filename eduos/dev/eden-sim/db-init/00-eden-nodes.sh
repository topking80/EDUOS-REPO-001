#!/bin/sh
# 32.7.0 EDEN simulation: ONE PostgreSQL container hosts the two simulated
# school nodes' databases (node_a, node_b), each with its own owner and
# non-superuser runtime role, to keep memory low. A real school node has its
# own PostgreSQL on its own box (deploy/school-node/).
set -eu
: "${EDEN_SIM_DB_PASSWORD:?EDEN_SIM_DB_PASSWORD must be set}"
for n in a b; do
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v pw="$EDEN_SIM_DB_PASSWORD" -v n="$n" <<'SQL'
SELECT format('CREATE ROLE node_%s_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'n', :'pw') \gexec
SELECT format('CREATE ROLE node_%s_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'n', :'pw') \gexec
SELECT format('CREATE DATABASE node_%s OWNER node_%s_owner', :'n', :'n') \gexec
SELECT format('REVOKE ALL ON DATABASE node_%s FROM PUBLIC', :'n') \gexec
SELECT format('GRANT CONNECT ON DATABASE node_%s TO node_%s_app', :'n', :'n') \gexec
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "node_$n" -c "ALTER SCHEMA public OWNER TO node_${n}_owner"
done
