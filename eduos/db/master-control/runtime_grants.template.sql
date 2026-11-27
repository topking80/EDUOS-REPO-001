-- Master Control runtime role (FED-03). It gets this schema only; nothing in
-- the EduOS (public) schema or any other.
REVOKE ALL ON SCHEMA public FROM mc_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mc_app;
GRANT USAGE ON SCHEMA master_control TO mc_app;
GRANT SELECT, INSERT, UPDATE ON master_control.nodes, master_control.operators, master_control.role_assignments,
  master_control.delegations, master_control.policy_settings TO mc_app;
GRANT SELECT, INSERT, DELETE ON master_control.pending_logins, master_control.sessions TO mc_app;
GRANT UPDATE (last_seen_at) ON master_control.sessions TO mc_app;
GRANT SELECT, INSERT ON master_control.audit_log TO mc_app;
-- FED-04
GRANT SELECT, INSERT, UPDATE ON master_control.identity_providers, master_control.invitations TO mc_app;
-- FED-05
GRANT SELECT, INSERT, UPDATE ON master_control.policy_releases TO mc_app;
GRANT SELECT, INSERT ON master_control.policy_bundles, master_control.policy_acknowledgements TO mc_app;
-- FED-06
GRANT SELECT, INSERT, UPDATE ON master_control.exchange_agreements TO mc_app;
GRANT SELECT, INSERT ON master_control.exchange_deliveries TO mc_app;
-- FED-08
GRANT SELECT, INSERT, UPDATE ON master_control.signing_keys, master_control.incidents TO mc_app;
