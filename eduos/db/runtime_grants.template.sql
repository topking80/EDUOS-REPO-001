-- Least-privilege grants for the EduOS runtime role.
-- Applied automatically by `npm run db:migrate` (src/migrate.js) after the
-- migrations, substituting EDUOS_APP_ROLE and the connected database name for
-- the literal names eduos_app / eduos below. It can also be run by hand as the
-- migration owner after adapting those two names.
-- The runtime role must NOT be a superuser, must NOT have BYPASSRLS and must
-- NOT own the tables (the server refuses to start otherwise).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE eduos TO eduos_app;
GRANT USAGE ON SCHEMA public TO eduos_app;
-- 32.0.54: the API checks at startup that every migration has been applied.
GRANT SELECT ON schema_migrations TO eduos_app;
GRANT SELECT ON districts, users, memberships, district_users, sessions, schools, students,
  student_user_links, attendance_events, audit_events TO eduos_app;
GRANT INSERT, UPDATE ON sessions TO eduos_app;
GRANT INSERT, UPDATE ON attendance_events TO eduos_app;
GRANT INSERT ON audit_events TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM eduos_app;
-- Ensure eduos_app is not table owner and does not have BYPASSRLS.

-- SIS import upserts students; guardian acceptance creates/reactivates links.
GRANT INSERT, UPDATE ON students TO eduos_app;
GRANT INSERT, UPDATE ON student_user_links TO eduos_app;
REVOKE DELETE, TRUNCATE ON students, student_user_links FROM eduos_app;

GRANT SELECT ON assignments, assignment_submissions TO eduos_app;
GRANT INSERT, UPDATE ON assignments, assignment_submissions TO eduos_app;

-- Phase 28 access-request and permission-grant tables.
GRANT SELECT, INSERT, UPDATE ON access_requests TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON permission_grants TO eduos_app;
REVOKE DELETE, TRUNCATE ON access_requests, permission_grants FROM eduos_app;

-- Phase 32 Student 360 intervention records
GRANT SELECT, INSERT, UPDATE ON student_intervention_cases TO eduos_app;
GRANT SELECT, INSERT ON student_case_notes TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON student_case_notes FROM eduos_app;

-- Phase 32.0.34 family messaging, classroom preferences and SIS import ledger.
GRANT SELECT, INSERT, UPDATE ON family_messages TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON teacher_classroom_preferences TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON sis_sync_runs TO eduos_app;
GRANT SELECT, INSERT ON sis_attendance_imports TO eduos_app;
REVOKE DELETE, TRUNCATE ON family_messages, teacher_classroom_preferences, sis_sync_runs, sis_attendance_imports FROM eduos_app;

-- Phase 32.0.35 guardian relationship invitation lifecycle.
GRANT SELECT, INSERT, UPDATE ON guardian_invitations TO eduos_app;
REVOKE DELETE, TRUNCATE ON guardian_invitations FROM eduos_app;

-- Phase 32.0.44 cross-profile flow events and signed outbound webhooks.
-- flow_events and webhook_deliveries are append-only for the runtime role.
GRANT SELECT, INSERT ON flow_events TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON flow_events FROM eduos_app;
GRANT SELECT, INSERT, UPDATE ON webhook_subscriptions TO eduos_app;
REVOKE DELETE, TRUNCATE ON webhook_subscriptions FROM eduos_app;
GRANT SELECT, INSERT ON webhook_deliveries TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON webhook_deliveries FROM eduos_app;
GRANT SELECT, INSERT, UPDATE ON webhook_outbox TO eduos_app;
REVOKE DELETE, TRUNCATE ON webhook_outbox FROM eduos_app;

-- 32.0.53 teacher rosters, durable OIDC login state, record deletion.
GRANT SELECT, INSERT, DELETE ON teacher_student_rosters TO eduos_app;
GRANT SELECT, INSERT, DELETE ON oidc_pending_logins TO eduos_app;
-- 037 native app sign-in handoffs (single-use, 60 s; deleted on redemption).
GRANT SELECT, INSERT, DELETE ON native_login_handoffs TO eduos_app;
REVOKE ALL ON FUNCTION eduos_retention_purge(int,int,int,int), eduos_purge_sessions(int) FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_purge_student(uuid) TO eduos_app;

-- 32.1.0 district administration API (src/admin-routes.js): create schools,
-- users and memberships; column-limited updates. schools is RLS-scoped; users
-- and memberships are checked by the API (district-only, audited).
GRANT INSERT ON schools, users, memberships, district_users TO eduos_app;
GRANT UPDATE (name, school_level, status) ON schools TO eduos_app;
GRANT UPDATE (display_name, email, status) ON users TO eduos_app;
GRANT UPDATE (status) ON memberships TO eduos_app;
REVOKE DELETE, TRUNCATE ON schools, users, memberships, district_users FROM eduos_app;

-- 32.2.0 district caps and the district resource mesh. Seats are claimed and
-- usage is aggregated only through the two SECURITY DEFINER functions; launches
-- are append-only.
GRANT SELECT, INSERT, UPDATE ON district_settings TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON apps, app_licenses, app_assignments, app_requests TO eduos_app;
GRANT SELECT ON app_seats TO eduos_app;
GRANT SELECT, INSERT ON app_launches TO eduos_app;
REVOKE DELETE, TRUNCATE ON district_settings, apps, app_licenses, app_assignments, app_requests, app_seats, app_launches FROM eduos_app;
REVOKE INSERT, UPDATE ON app_seats FROM eduos_app;
REVOKE UPDATE ON app_launches FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_claim_seat(uuid), eduos_app_usage(uuid) TO eduos_app;
-- 32.3.0 school branding. Assets and uploads are immutable once written;
-- drafts may be discarded; published/archived history is never deleted (RLS).
GRANT SELECT, INSERT ON branding_uploads, branding_assets TO eduos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON branding_profiles TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON user_preferences TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON branding_uploads, branding_assets FROM eduos_app;
REVOKE TRUNCATE ON branding_profiles FROM eduos_app;
REVOKE DELETE, TRUNCATE ON user_preferences FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_can_edit_branding(uuid), eduos_in_branding_scope(uuid) TO eduos_app;
-- 32.4.0 role apps: transport, Christie tutor, Comms Hub, notification outbox.
-- Check-ins and tutor turns are append-only; messages only change through the
-- moderation columns; reads/receipts are insert-only.
GRANT SELECT, INSERT, UPDATE ON transport_routes, transport_stops, transport_rider_assignments, transport_runs TO eduos_app;
GRANT SELECT, INSERT ON transport_checkins TO eduos_app;
REVOKE DELETE, TRUNCATE ON transport_routes, transport_stops, transport_rider_assignments, transport_runs, transport_checkins FROM eduos_app;
REVOKE UPDATE ON transport_checkins FROM eduos_app;
GRANT SELECT, INSERT, UPDATE ON christie_skills TO eduos_app;
GRANT SELECT, INSERT ON christie_items TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON christie_sessions, student_skill_mastery TO eduos_app;
GRANT SELECT, INSERT ON christie_turns TO eduos_app;
REVOKE DELETE, TRUNCATE ON christie_skills, christie_items, christie_sessions, christie_turns, student_skill_mastery FROM eduos_app;
REVOKE UPDATE ON christie_items, christie_turns FROM eduos_app;
GRANT SELECT, INSERT ON comms_announcements, comms_announcement_reads, comms_threads, comms_participants, comms_messages, comms_message_reads, comms_reports TO eduos_app;
GRANT UPDATE (status, removed_by, removed_at, removed_reason) ON comms_announcements TO eduos_app;
GRANT UPDATE (status, locked_by, locked_at, lock_reason, last_message_at) ON comms_threads TO eduos_app;
GRANT UPDATE (hidden_at, hidden_by, hidden_reason) ON comms_messages TO eduos_app;
GRANT UPDATE (status, resolution, resolved_by, resolved_at) ON comms_reports TO eduos_app;
REVOKE DELETE, TRUNCATE ON comms_announcements, comms_announcement_reads, comms_threads, comms_participants, comms_messages, comms_message_reads, comms_reports FROM eduos_app;
GRANT SELECT, INSERT ON notification_outbox TO eduos_app;
GRANT UPDATE (read_at) ON notification_outbox TO eduos_app;
REVOKE DELETE, TRUNCATE ON notification_outbox FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_christie_item_for_session(uuid), eduos_christie_next_item(uuid,integer), eduos_christie_item_counts(uuid[]) TO eduos_app;
-- 32.5.0 SafetyOS and car pick-up. Logs (incident events, roll call, pick-up
-- events) are insert-only; the rest change only through listed columns.
GRANT UPDATE (timezone) ON schools TO eduos_app;
GRANT SELECT, INSERT ON safety_incidents, safety_events, safety_rollcall_entries TO eduos_app;
GRANT UPDATE (status, confirmed_by, confirmed_at, reunification_at, reunification_point, instructions, closed_by, closed_at, debrief) ON safety_incidents TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON safety_events, safety_rollcall_entries FROM eduos_app;
REVOKE DELETE, TRUNCATE ON safety_incidents FROM eduos_app;
GRANT SELECT, INSERT ON pickup_adults, pickup_tags, pickup_restrictions, pickup_early_dismissals, pickup_events TO eduos_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON pickup_adults TO eduos_app;
GRANT UPDATE (revoked_at) ON pickup_tags TO eduos_app;
GRANT UPDATE (status, lifted_by, lifted_at) ON pickup_restrictions TO eduos_app;
GRANT UPDATE (status, decided_by, decided_at) ON pickup_early_dismissals TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON pickup_events FROM eduos_app;
REVOKE DELETE, TRUNCATE ON pickup_adults, pickup_tags, pickup_restrictions, pickup_early_dismissals FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_school_today(uuid), eduos_safety_find_student(uuid,text), eduos_pickup_lookup(text),
  eduos_safety_student_at_school(uuid,uuid), eduos_safety_recipients(uuid,text), eduos_pickup_ensure_guardian(uuid),
  eduos_pickup_today(), eduos_pickup_early_today(), eduos_school_leads(), eduos_pickup_guardians(uuid),
  eduos_safety_delivery(uuid) TO eduos_app;
REVOKE ALL ON FUNCTION eduos_purge_student_324(uuid), eduos_retention_purge_role_apps(jsonb) FROM eduos_app;
-- 035 (audit 37.4.0 item 6): replay-receipt purge is owner-only, like the other retention functions.
REVOKE ALL ON FUNCTION eduos_retention_purge_offline_replays(int) FROM eduos_app;
-- 32.6.0 learning core and EDAL. Evidence, final grades and the ledger are
-- insert-only; EDAL heads are reachable only through definer functions.
GRANT SELECT, INSERT ON learning_standards, courses, course_enrollments, course_units, lessons, lesson_standards, primary_sources, lesson_sources,
  assignment_standards, quiz_items, quiz_item_keys, student_accommodations, quiz_attempts, quiz_responses, mastery_evidence, standard_mastery,
  course_final_grades, credentials, edal_entries, edal_payloads, edal_checkpoints TO eduos_app;
GRANT UPDATE (title, subject, grade_level, term, status, grade_weights) ON courses TO eduos_app;
GRANT UPDATE (status) ON course_enrollments TO eduos_app;
GRANT UPDATE (title, summary) ON course_units TO eduos_app;
GRANT UPDATE (title, objective, content, status, approved_by, approved_at, updated_at) ON lessons TO eduos_app;
GRANT UPDATE (status, approved_by, approved_at) ON primary_sources TO eduos_app;
GRANT UPDATE (extra_time_pct, read_aloud, notes, updated_by, updated_at) ON student_accommodations TO eduos_app;
GRANT UPDATE (status, total_points, reviewed_by, reviewed_at, returned_at) ON quiz_attempts TO eduos_app;
GRANT UPDATE (response, saved_at, teacher_points, teacher_comment) ON quiz_responses TO eduos_app;
GRANT UPDATE (mastery, level, evidence_count, assessed_count, mastered_at, updated_at) ON standard_mastery TO eduos_app;
GRANT UPDATE (revoked_at, revoked_by, revoke_reason) ON credentials TO eduos_app;
GRANT UPDATE (course_id, lesson_id, kind, points_possible, category, rubric, max_attempts, retake_policy, time_limit_minutes) ON assignments TO eduos_app;
GRANT UPDATE (standard_id, lesson_id) ON christie_skills TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON mastery_evidence, course_final_grades, edal_entries, edal_payloads, edal_checkpoints FROM eduos_app;
REVOKE DELETE, TRUNCATE ON learning_standards, courses, course_enrollments, course_units, lessons, lesson_standards, primary_sources, lesson_sources,
  assignment_standards, quiz_items, quiz_item_keys, student_accommodations, quiz_attempts, quiz_responses, standard_mastery, credentials FROM eduos_app;
REVOKE UPDATE ON quiz_items, quiz_item_keys, lesson_standards, lesson_sources, assignment_standards, learning_standards FROM eduos_app;
REVOKE ALL ON edal_heads FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_edal_head(), eduos_edal_chain(bigint,integer), eduos_edal_head_info(), eduos_edal_neighbors(uuid),
  eduos_quiz_keys(uuid), eduos_quiz_submit(uuid), eduos_quiz_record_auto(uuid,jsonb,numeric), eduos_course_students(uuid) TO eduos_app;
REVOKE ALL ON FUNCTION eduos_purge_student_325(uuid) FROM eduos_app;
-- 32.7.0 offline node, EDEN and DECN. Logs and inbound records are
-- append-only; the outbox is written only by src/eden/egress.js; student data
-- is reachable for EDEN only through the definer functions (counts, the
-- identifier block-list, and the sealed DECN package).
GRANT SELECT, INSERT, UPDATE ON offline_replays TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON eden_nodes, eden_enrollment_tokens, eden_node_bundles, eden_aggregates, eden_continuity_packages,
  eden_failovers, eden_node_state, eden_outbox, eden_bundle_cache, eden_consent_exceptions TO eduos_app;
GRANT SELECT, INSERT ON eden_bundles, eden_inbound_log, eden_failover_events, eden_egress_log, decn_hosting, decn_hosted_rows, decn_imports TO eduos_app;
GRANT UPDATE (status, return_sha256, returned_at) ON decn_hosting TO eduos_app;
GRANT SELECT, INSERT, DELETE ON eden_nonces TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON eden_bundles, eden_inbound_log, eden_failover_events, eden_egress_log, decn_hosted_rows, decn_imports FROM eduos_app;
REVOKE DELETE, TRUNCATE ON eden_nodes, eden_enrollment_tokens, eden_node_bundles, eden_aggregates, eden_continuity_packages, eden_failovers,
  eden_node_state, eden_outbox, eden_bundle_cache, eden_consent_exceptions, decn_hosting, offline_replays FROM eduos_app;
GRANT USAGE ON SEQUENCE eden_outbox_seq_seq TO eduos_app;
GRANT EXECUTE ON FUNCTION eduos_eden_source(text, uuid, date), eduos_eden_identifiers(uuid), eduos_decn_continuity(uuid),
  eduos_decn_restore(uuid, uuid, timestamptz, text, jsonb), eduos_decn_return_package(uuid), eduos_decn_import_return(uuid, text, jsonb),
  eduos_decn_purge(uuid) TO eduos_app;
REVOKE ALL ON FUNCTION eduos_node_prune_to_school(uuid) FROM eduos_app;

-- 33.8.0 authoritative school arrival handoff lifecycle.
GRANT SELECT, INSERT ON arrival_handoffs TO eduos_app;
GRANT UPDATE (status,received_by,received_at) ON arrival_handoffs TO eduos_app;
GRANT SELECT, INSERT ON arrival_handoff_events TO eduos_app;
REVOKE DELETE, TRUNCATE ON arrival_handoffs, arrival_handoff_events FROM eduos_app;
REVOKE UPDATE ON arrival_handoff_events FROM eduos_app;

-- 34.5.0 durable principal exception resolution; 34.6 escalation ledger.
GRANT SELECT, INSERT, UPDATE ON arrival_exception_resolutions TO eduos_app;
GRANT SELECT, INSERT ON arrival_exception_resolution_events TO eduos_app;
REVOKE DELETE, TRUNCATE ON arrival_exception_resolutions, arrival_exception_resolution_events FROM eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON arrival_exception_resolution_events FROM eduos_app;
GRANT SELECT ON arrival_escalation_alerts TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON arrival_escalation_alerts FROM eduos_app;

-- 35.5.0 district-owned SRO policy.
GRANT SELECT, INSERT, UPDATE ON sro_district_policies TO eduos_app;
REVOKE DELETE, TRUNCATE ON sro_district_policies FROM eduos_app;

-- 35.7.0 district library catalogue intake and resource coordination.
GRANT SELECT, INSERT ON library_catalog_imports TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON library_items TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON library_resource_requests TO eduos_app;
REVOKE DELETE, TRUNCATE ON library_catalog_imports, library_items, library_resource_requests FROM eduos_app;
-- 35.8.0 library circulation runtime permissions; RLS enforces district boundaries.
GRANT SELECT, INSERT, UPDATE ON library_loans, library_reservations TO eduos_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON library_borrower_cards TO eduos_app;

-- 36.2.0 borrowing policy (upserted) and overdue notice ledger (insert-only).
-- Missing through 37.4.0, so the runtime role was denied these tables.
GRANT SELECT, INSERT, UPDATE ON library_borrowing_policies TO eduos_app;
GRANT SELECT, INSERT ON library_notice_ledger TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON library_notice_ledger FROM eduos_app;
REVOKE DELETE, TRUNCATE ON library_borrowing_policies FROM eduos_app;

-- 36.4.0 specialized school operations queues.
GRANT SELECT, INSERT, UPDATE ON school_service_work TO eduos_app;
REVOKE DELETE, TRUNCATE ON school_service_work FROM eduos_app;

-- 36.6.0 recurring school operations schedules.
-- Missing through 37.4.0, so the runtime role was denied this table.
GRANT SELECT, INSERT, UPDATE ON school_operation_schedules TO eduos_app;
REVOKE DELETE, TRUNCATE ON school_operation_schedules FROM eduos_app;

-- 36.7.0 school operations notification preferences and idempotency ledger.
GRANT SELECT, INSERT, UPDATE ON school_ops_notification_preferences TO eduos_app;
REVOKE DELETE, TRUNCATE ON school_ops_notification_preferences FROM eduos_app;
GRANT SELECT, INSERT, UPDATE ON school_ops_notification_ledger TO eduos_app;
REVOKE DELETE, TRUNCATE ON school_ops_notification_ledger FROM eduos_app;

-- 36.8.0 shared staff daily workspace; RLS scopes every record to district.
GRANT SELECT, INSERT, UPDATE ON school_staff_checklists, school_staff_checklist_items, school_staff_checklist_runs,
  school_staff_handoffs, school_staff_announcements TO eduos_app;
REVOKE DELETE, TRUNCATE ON school_staff_checklists, school_staff_checklist_items, school_staff_checklist_runs,
  school_staff_handoffs, school_staff_announcements FROM eduos_app;

-- 36.9.0 district staff management.
GRANT SELECT, INSERT, UPDATE ON staff_absence_requests, staff_shift_assignments, substitute_coverage_requests TO eduos_app;
REVOKE DELETE, TRUNCATE ON staff_absence_requests, staff_shift_assignments, substitute_coverage_requests FROM eduos_app;

-- Audit 37.4.0 item 3: row-level-security policy helpers.
-- Every function referenced by an RLS policy, plus the SECURITY INVOKER
-- functions those helpers call, is granted to the runtime role explicitly
-- instead of relying on PostgreSQL's default PUBLIC EXECUTE. This is additive:
-- PUBLIC EXECUTE is NOT revoked here (see AUDIT-37.4.0-ADDENDUM-2.md).
-- test/integration/postgres.test.js (H2b) fails if a policy helper lacks an
-- explicit grant.
GRANT EXECUTE ON FUNCTION
  eduos_can_manage_assignment(uuid), eduos_can_manage_course(uuid), eduos_can_see_assignment(uuid),
  eduos_can_see_attempt(uuid), eduos_can_see_christie_session(uuid), eduos_can_see_course(uuid),
  eduos_can_see_learning(uuid, uuid), eduos_can_see_lesson(uuid), eduos_child_rides_route(uuid),
  eduos_ctx_district(), eduos_ctx_role(), eduos_ctx_school(), eduos_ctx_user(), eduos_drives_route(uuid),
  eduos_drives_run(uuid), eduos_edal_verifier(), eduos_in_class(uuid), eduos_is_district_role(),
  eduos_is_linked_student(uuid), eduos_is_moderator(uuid), eduos_is_school_lead(uuid), eduos_is_staff(),
  eduos_is_table_owner(), eduos_is_thread_participant(uuid), eduos_learning_staff(uuid, uuid),
  eduos_my_open_attempt(uuid), eduos_on_my_roster(uuid), eduos_owner_session(),
  eduos_parent_has_child_at(uuid), eduos_safety_lead(uuid), eduos_safety_live(uuid), eduos_safety_staff(uuid),
  eduos_staff_can_see_student(uuid, uuid), eduos_teaches_student(uuid), eduos_transport_manager(uuid),
  eduos_transport_staff(uuid)
  TO eduos_app;

-- 034 transport check-in consistency policy helper (audit 37.4.0 item 4).
GRANT EXECUTE ON FUNCTION eduos_transport_checkin_consistent(uuid, uuid, uuid, uuid, timestamptz) TO eduos_app;

-- 038 edge device health: staff read and manage devices in their district
-- (row-level security); devices report only through eduos_edge_record_health,
-- which checks the device token. Reports are append-only for the app.
GRANT SELECT, INSERT ON edge_devices TO eduos_app;
GRANT UPDATE (revoked_at, revoked_by) ON edge_devices TO eduos_app;
GRANT SELECT ON edge_device_reports TO eduos_app;
REVOKE DELETE, TRUNCATE ON edge_devices, edge_device_reports FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_edge_record_health(uuid, text, jsonb) TO eduos_app;
REVOKE ALL ON FUNCTION eduos_retention_purge_edge_reports(int) FROM eduos_app;

-- 039 district-approved edge updates: district leads manage the policy and
-- releases (row-level security; the API limits who may change them); devices
-- learn their target only through eduos_edge_update_target.
GRANT SELECT, INSERT, UPDATE ON edge_update_policy TO eduos_app;
GRANT SELECT, INSERT ON edge_update_releases TO eduos_app;
GRANT UPDATE (stage, promoted_by, promoted_at, withdrawn_by, withdrawn_at, withdraw_reason) ON edge_update_releases TO eduos_app;
REVOKE DELETE, TRUNCATE ON edge_update_policy, edge_update_releases FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_edge_update_target(uuid, text), eduos_os_version_key(text) TO eduos_app;
GRANT UPDATE (update_cohort, cohort_set_by, cohort_set_at) ON edge_devices TO eduos_app;
-- 040 external integrations: district leads manage connectors (row-level
-- security keeps them in their district); sync runs are an append-only record.
GRANT SELECT, INSERT, UPDATE ON integration_connectors TO eduos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_school_map TO eduos_app;
GRANT SELECT, INSERT ON integration_sync_runs TO eduos_app;
REVOKE DELETE, TRUNCATE ON integration_connectors, integration_sync_runs FROM eduos_app;

-- 041 AI gateway: the superintendent manages the district's AI policy; usage
-- records are append-only for the app (no prompts or answers are stored).
GRANT SELECT, INSERT, UPDATE ON ai_district_policy TO eduos_app;
GRANT SELECT, INSERT ON ai_usage TO eduos_app;
GRANT USAGE ON SEQUENCE ai_usage_id_seq TO eduos_app;
REVOKE DELETE, TRUNCATE ON ai_district_policy, ai_usage FROM eduos_app;

-- 042: a usage row is reserved, then settled (only these columns change).
GRANT UPDATE (outcome, provider, tokens_in, tokens_out) ON ai_usage TO eduos_app;

-- 043: the app tokenizes text with the same functions the student index uses.
GRANT EXECUTE ON FUNCTION eduos_redact_tokens(text), eduos_redact_compact(text), eduos_redact_is_nospace(text) TO eduos_app;
GRANT SELECT ON student_redact_tokens TO eduos_app;
