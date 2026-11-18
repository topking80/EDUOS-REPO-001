-- /metrics calls this aggregate SECURITY DEFINER function as the runtime role.
-- PUBLIC execution remains revoked by runtime_grants.template.sql.
GRANT EXECUTE ON FUNCTION eduos_queue_backlog() TO eduos_app;
