-- 37.8.0 follow-up: SECURITY DEFINER webhook entry points are owned by the
-- migration/table owner, which is deliberately NOBYPASSRLS. PostgreSQL forces
-- even a table owner through RLS when FORCE ROW LEVEL SECURITY is enabled.
-- These four tables are queried globally only inside narrowly scoped definer
-- functions (endpoint-token resolution, verified inbox insertion, and worker
-- claim). Keep RLS ENABLED so the non-owner runtime role remains tenant-scoped,
-- but remove FORCE so the trusted migration owner can execute those functions
-- without a fabricated tenant GUC. The API must never run as this owner; startup
-- rejects table/object owners as the runtime role.
ALTER TABLE commerce_webhook_endpoints NO FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_provider_accounts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_payments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_webhook_events NO FORCE ROW LEVEL SECURITY;
