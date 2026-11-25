-- Least-privilege grants for the EduOS runtime role.
-- Applied automatically by `npm run db:migrate` (src/migrate.js) after the
-- migrations, substituting EDUOS_APP_ROLE and the connected database name for
-- the literal names eduos_app / eduos below. It can also be run by hand as the
-- migration owner after adapting those two names.
-- The runtime role must NOT be a superuser, must NOT have BYPASSRLS and must
-- NOT own the tables (the server refuses to start otherwise).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
-- Functions are executable by every database role (PUBLIC) unless revoked,
-- and many here are SECURITY DEFINER: a reporting or other role in the same
-- cluster could set app.district_id itself and call them. Only the runtime
-- role gets EXECUTE, function by function, below. Re-applied after every
-- migration, so new functions start revoked too.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
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
-- 37.7.0 audit: deployment-wide delivery slots, through these functions only (no table access).
REVOKE ALL ON webhook_delivery_slots FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_webhook_slot_acquire(integer, integer), eduos_webhook_slot_release(uuid), eduos_webhook_slots_free(integer) TO eduos_app;

-- 32.0.53 teacher rosters, durable OIDC login state, record deletion.
GRANT SELECT, INSERT, DELETE ON teacher_student_rosters TO eduos_app;
GRANT SELECT, INSERT, DELETE ON oidc_pending_logins TO eduos_app;
-- 037 native app sign-in handoffs (single-use, 60 s; deleted on redemption).
GRANT SELECT, INSERT, DELETE ON native_login_handoffs TO eduos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON device_sign_in_requests TO eduos_app;
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
GRANT SELECT, INSERT, UPDATE ON app_licenses, app_assignments, app_requests TO eduos_app;
REVOKE INSERT, UPDATE ON apps FROM eduos_app;
GRANT SELECT ON apps TO eduos_app;
GRANT INSERT (district_id,owner_school_id,name,vendor,description,category,launch_url,integration_type,integration_config,
              data_sharing_scope,dpa_status,dpa_expires_on,coppa_compliant,ferpa_school_official,created_by) ON apps TO eduos_app;
GRANT UPDATE (owner_school_id,name,vendor,description,category,launch_url,integration_type,integration_config,
              data_sharing_scope,dpa_status,dpa_expires_on,coppa_compliant,ferpa_school_official,status,updated_at) ON apps TO eduos_app;
GRANT EXECUTE ON FUNCTION eduos_lti_approve_registration(uuid,text,uuid) TO eduos_app;
GRANT EXECUTE ON FUNCTION eduos_lti_revoke_registration(uuid,uuid) TO eduos_app;
GRANT SELECT ON app_seats TO eduos_app;
GRANT SELECT, INSERT ON app_launches TO eduos_app;
REVOKE DELETE, TRUNCATE ON district_settings, apps, app_licenses, app_assignments, app_requests, app_seats, app_launches FROM eduos_app;
REVOKE INSERT, UPDATE ON app_seats FROM eduos_app;
-- 37.6.0 marketplace: privacy reviews and fee events are append-only.
GRANT SELECT, INSERT, UPDATE ON marketplace_vendors, marketplace_listings TO eduos_app;
GRANT SELECT, INSERT ON marketplace_privacy_reviews, marketplace_fee_events TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON marketplace_privacy_reviews, marketplace_fee_events FROM eduos_app;
REVOKE DELETE, TRUNCATE ON marketplace_vendors, marketplace_listings FROM eduos_app;
REVOKE ALL ON FUNCTION eduos_marketplace_request_guard() FROM eduos_app;
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
-- TEACH-01: leaving and rejoining network threads (db/101; policy own_membership).
GRANT UPDATE (left_at) ON comms_participants TO eduos_app;
GRANT EXECUTE ON FUNCTION eduos_is_network_educator() TO eduos_app;
GRANT UPDATE (hidden_at, hidden_by, hidden_reason) ON comms_messages TO eduos_app;
GRANT UPDATE (status, resolution, resolved_by, resolved_at) ON comms_reports TO eduos_app;
REVOKE DELETE, TRUNCATE ON comms_announcements, comms_announcement_reads, comms_threads, comms_participants, comms_messages, comms_message_reads, comms_reports FROM eduos_app;
GRANT SELECT, INSERT ON notification_outbox TO eduos_app;
GRANT UPDATE (read_at) ON notification_outbox TO eduos_app;
REVOKE DELETE, TRUNCATE ON notification_outbox FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_christie_item_for_session(uuid), eduos_christie_next_item(uuid,integer), eduos_christie_item_counts(uuid[]) TO eduos_app;
-- 37.7.2 aggregate notification/webhook backlog metrics; no tenant or message data is exposed.
GRANT EXECUTE ON FUNCTION eduos_queue_backlog() TO eduos_app;
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
-- 37.6.0 enrollment funnel. History is append-only; documents can only be
-- reviewed (status and note), never edited or deleted by the runtime role.
GRANT SELECT, INSERT, UPDATE ON enrollment_capacity, enrollment_applications TO eduos_app;
GRANT SELECT, INSERT ON enrollment_documents, enrollment_events TO eduos_app;
GRANT UPDATE (status, review_note, reviewed_by, reviewed_at) ON enrollment_documents TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON enrollment_events FROM eduos_app;
REVOKE DELETE, TRUNCATE ON enrollment_capacity, enrollment_applications, enrollment_documents FROM eduos_app;
GRANT USAGE ON SEQUENCE enrollment_waitlist_seq TO eduos_app;
GRANT EXECUTE ON FUNCTION eduos_my_application(uuid), eduos_leads_application(uuid), eduos_enrollment_transition_ok(text, text, boolean),
  eduos_enrollment_seats(uuid, text, text), eduos_enrollment_complete(uuid, text) TO eduos_app;
REVOKE ALL ON FUNCTION eduos_purge_student_pre_enrollment(uuid), eduos_retention_feature_enrollment(jsonb) FROM eduos_app;
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
-- 37.6.0 Credentials Wallet: holders create and revoke share links; links are
-- never deleted by the runtime role (FERPA purge runs through the definer chain).
GRANT SELECT, INSERT ON wallet_shares TO eduos_app;
GRANT UPDATE (revoked_by, revoked_at) ON wallet_shares TO eduos_app;
REVOKE DELETE, TRUNCATE ON wallet_shares FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_wallet_export_inputs(uuid), eduos_wallet_credentials(), eduos_wallet_share_lookup(text),
  eduos_wallet_credential_status(uuid) TO eduos_app;
REVOKE ALL ON FUNCTION eduos_purge_student_pre_wallet(uuid) FROM eduos_app;
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
-- 37.6.0 well-being check-ins: consents and the actions log are append-only;
-- alerts are created only by eduos_wellbeing_raise_alert (SECURITY DEFINER).
GRANT SELECT, INSERT, UPDATE ON wellbeing_settings, wellbeing_checkins TO eduos_app;
GRANT SELECT, INSERT ON wellbeing_consents, wellbeing_actions TO eduos_app;
GRANT SELECT, UPDATE (acknowledged_by, acknowledged_at) ON wellbeing_alerts TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON wellbeing_consents, wellbeing_actions FROM eduos_app;
REVOKE INSERT, DELETE, TRUNCATE ON wellbeing_alerts FROM eduos_app;
REVOKE DELETE, TRUNCATE ON wellbeing_settings, wellbeing_checkins FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_is_counselor(uuid), eduos_is_my_pupil_record(uuid), eduos_wellbeing_allowed(uuid),
  eduos_wellbeing_raise_alert(uuid, text, uuid), eduos_wellbeing_request_talk(uuid) TO eduos_app;
REVOKE ALL ON FUNCTION eduos_wellbeing_open_work(uuid, text, text, text), eduos_purge_student_pre_wellbeing(uuid), eduos_retention_feature_wellbeing(jsonb) FROM eduos_app;
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
GRANT SELECT ON integration_service_actors TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON integration_sync_schedules, integration_sync_jobs TO eduos_app;
REVOKE DELETE, TRUNCATE ON integration_service_actors, integration_sync_schedules, integration_sync_jobs FROM eduos_app;
REVOKE DELETE, TRUNCATE ON integration_connectors, integration_sync_runs FROM eduos_app;

-- 041 AI gateway: the superintendent manages the district's AI policy; usage
-- records are append-only for the app (no prompts or answers are stored).
GRANT SELECT, INSERT, UPDATE ON ai_district_policy TO eduos_app;
GRANT SELECT, INSERT ON ai_usage TO eduos_app;
GRANT USAGE ON SEQUENCE ai_usage_id_seq TO eduos_app;
REVOKE DELETE, TRUNCATE ON ai_district_policy, ai_usage FROM eduos_app;

-- 042: a usage row is reserved, then settled (only these columns change).
GRANT UPDATE (outcome, provider, tokens_in, tokens_out) ON ai_usage TO eduos_app;
-- 37.6.0 Leo/Edison: lessons provenance columns ride on the existing lessons INSERT grant
-- (UPDATE stays limited to the 014 columns); Edison reads counts only through these.
GRANT EXECUTE ON FUNCTION eduos_edison_allowed(uuid), eduos_edison_source(text, uuid, date), eduos_edison_identifiers() TO eduos_app;

-- 043: the app tokenizes text with the same functions the student index uses.
GRANT EXECUTE ON FUNCTION eduos_redact_tokens(text), eduos_redact_compact(text), eduos_redact_is_nospace(text) TO eduos_app;
GRANT SELECT ON student_redact_tokens TO eduos_app;

-- 048: aggregate queue backlog for /metrics (totals and ages only).
GRANT EXECUTE ON FUNCTION eduos_queue_backlog() TO eduos_app;


-- 37.6.0 Clubs, sports, school events and ticket inventory. The API emits
-- audit events and applies school/assignment checks; RLS is district-wide.
GRANT SELECT, INSERT, UPDATE ON school_activities, activity_staff, activity_memberships,
  school_events, event_ticket_types, event_streams TO eduos_app;
GRANT SELECT, INSERT ON event_ticket_orders, event_tickets, activity_media_assets TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON event_ticket_orders, event_tickets, activity_media_assets FROM eduos_app;
REVOKE DELETE, TRUNCATE ON school_activities, activity_staff, activity_memberships,
  school_events, event_ticket_types, event_streams FROM eduos_app;
-- 37.7.0 commerce (sandbox). Orders and tickets change only in these
-- columns and only along the transitions the 065 triggers allow (this also
-- lets staff check tickets in and buyers recover lost codes, which the
-- table-level REVOKE above had blocked). The ledger and receipts are written
-- only by eduos_commerce_record().
GRANT UPDATE (status, provider_reference, paid_at, refunded_at) ON event_ticket_orders TO eduos_app;
GRANT UPDATE (status, checked_in_at, checked_in_by, ticket_code_hash) ON event_tickets TO eduos_app;
GRANT SELECT, INSERT, UPDATE ON commerce_settings, commerce_payments, marketplace_purchases TO eduos_app;
REVOKE DELETE, TRUNCATE ON commerce_settings, commerce_payments, marketplace_purchases FROM eduos_app;
GRANT SELECT ON commerce_ledger_entries, commerce_receipts TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commerce_ledger_entries, commerce_receipts FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_commerce_record(uuid, text, uuid, jsonb, text), eduos_commerce_expire_holds() TO eduos_app;
REVOKE ALL ON FUNCTION eduos_retention_feature_commerce(jsonb), eduos_ticket_order_guard(), eduos_ticket_guard(),
  eduos_marketplace_purchase_guard(), eduos_commerce_payment_guard() FROM eduos_app;
-- 37.7.1 per-district payment providers (066). Credentials are stored sealed;
-- payers and school leaders reach one account only through
-- eduos_commerce_checkout_account(), for their own district.
GRANT SELECT, INSERT, UPDATE ON commerce_provider_accounts, commerce_payment_setup TO eduos_app;
REVOKE DELETE, TRUNCATE ON commerce_provider_accounts, commerce_payment_setup FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_commerce_checkout_account(text) TO eduos_app;
-- Two-phase processor calls: confirm stretches a seat hold while the processor
-- captures; a refund in flight blocks check-in. The sweep lists stale calls.
GRANT UPDATE (hold_expires_at, refund_pending) ON event_ticket_orders TO eduos_app;
GRANT EXECUTE ON FUNCTION eduos_commerce_stale_payments(integer) TO eduos_app;


-- 37.7.0 Sports roster and result records.
GRANT SELECT, INSERT, UPDATE ON activity_roster_entries, activity_event_results TO eduos_app;
REVOKE DELETE, TRUNCATE ON activity_roster_entries, activity_event_results FROM eduos_app;

-- 37.8.0 media governance.
GRANT SELECT, INSERT, UPDATE ON activity_media_participants, activity_media_consents TO eduos_app;
GRANT SELECT, INSERT ON activity_media_consent_history TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON activity_media_consent_history FROM eduos_app;
REVOKE DELETE, TRUNCATE ON activity_media_participants, activity_media_consents FROM eduos_app;
GRANT UPDATE (consent_status, moderation_status, approved_by) ON activity_media_assets TO eduos_app;

 
-- 37.9.3 private media object registry. Storage keys are readable only by
-- tenant-scoped server code; no public-facing route selects this table.
GRANT SELECT, INSERT, UPDATE ON private_media_objects TO eduos_app;
REVOKE DELETE, TRUNCATE ON private_media_objects FROM eduos_app;

-- 37.6.0 sports eligibility, athletic directors and permission slips (060).
-- Signatures are append-only; eligibility inputs come only through the
-- SECURITY DEFINER function, which checks coach / athletic director itself.
GRANT SELECT, INSERT, UPDATE ON school_athletic_directors, sports_eligibility_policy TO eduos_app;
GRANT SELECT, INSERT ON activity_permission_slips, activity_permission_slip_signatures TO eduos_app;
GRANT UPDATE (status, closed_at) ON activity_permission_slips TO eduos_app;
REVOKE DELETE, TRUNCATE ON school_athletic_directors, sports_eligibility_policy, activity_permission_slips, activity_permission_slip_signatures FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_sports_eligibility_inputs(uuid) TO eduos_app;
GRANT EXECUTE ON FUNCTION eduos_is_athletic_director(uuid), eduos_is_activity_staff(uuid, text[]), eduos_activity_school(uuid),
  eduos_can_see_eligibility(uuid), eduos_can_read_roster(uuid, uuid, uuid), eduos_can_manage_roster(uuid, uuid), eduos_family_on_roster(uuid) TO eduos_app;

-- 37.8.0 provider webhook inbox: tenant-scoped event intake and processing ledger.
GRANT SELECT, INSERT, UPDATE ON commerce_webhook_events TO eduos_app;
REVOKE DELETE, TRUNCATE ON commerce_webhook_events FROM eduos_app;
REVOKE ALL ON FUNCTION eduos_commerce_webhook_event_guard() FROM eduos_app;
-- 37.8.0 opaque endpoint tokens: tenant-scoped provisioning/revocation; the
-- public resolver accepts only a SHA-256 token digest and returns sealed secrets.
GRANT SELECT, INSERT, UPDATE ON commerce_webhook_endpoints TO eduos_app;
REVOKE DELETE, TRUNCATE ON commerce_webhook_endpoints FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_commerce_webhook_account(text) TO eduos_app;

-- 37.8.0: public verified webhook intake can persist only a matched inbox event.
GRANT EXECUTE ON FUNCTION eduos_commerce_receive_webhook(text,text,text,text,text,text,text,integer,text) TO eduos_app;

-- 37.8.0: worker may claim one event at a time through the narrow definer.
GRANT EXECUTE ON FUNCTION eduos_commerce_claim_webhook() TO eduos_app;
-- Late provider captures are held for explicit operator refund reconciliation.
GRANT SELECT, INSERT ON commerce_webhook_refund_cases TO eduos_app;
GRANT UPDATE (last_seen_at, status, resolved_at, resolved_by, resolution_note)
  ON commerce_webhook_refund_cases TO eduos_app;
REVOKE DELETE, TRUNCATE ON commerce_webhook_refund_cases FROM eduos_app;

-- 37.10.1 timeline_entries was retired in 089 (student history uses student_history_entries).
-- TC-01 student history and Time Capsule persistence foundation.
-- Revisions and lifecycle events are append-only; media bytes remain in the
-- private object store and are never exposed through these metadata tables.
GRANT SELECT, INSERT ON student_history_entries TO eduos_app;
-- Revoke previously deployed column grants as well as withholding them below:
-- re-running this template must close permissions granted by an older template.
REVOKE UPDATE (status) ON student_history_entries FROM eduos_app;
-- Approval/publication/deletion status is changed only by an authorized workflow.
GRANT UPDATE (entry_type, classification, title, body, occurred_at, school_year, audience, source_reference)
  ON student_history_entries TO eduos_app;
REVOKE DELETE, TRUNCATE ON student_history_entries FROM eduos_app;
GRANT SELECT ON student_history_entry_revisions TO eduos_app;
GRANT SELECT, INSERT ON student_history_entry_attachments,
  student_time_capsule_items, student_time_capsule_events TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON student_history_entry_revisions FROM eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON student_history_entry_attachments,
  student_time_capsule_items, student_time_capsule_events FROM eduos_app;
GRANT SELECT, INSERT ON student_time_capsules, student_time_capsule_recipients TO eduos_app;
-- Explicitly revoke lifecycle columns granted by earlier versions of this template.
REVOKE UPDATE (status, release_kind, release_at, milestone_key, sealed_at, released_at, cancelled_at)
  ON student_time_capsules FROM eduos_app;
-- Runtime edits are limited to descriptive draft metadata. Sealing, scheduling,
-- release, cancellation and milestone transitions require authorized workflow functions.
GRANT UPDATE (title, message, timezone, updated_at)
  ON student_time_capsules TO eduos_app;
GRANT UPDATE (consent_status, updated_at) ON student_time_capsule_recipients TO eduos_app;
REVOKE DELETE, TRUNCATE ON student_time_capsules, student_time_capsule_recipients FROM eduos_app;


-- TC-02 guardian family-memory contribution workflow.
GRANT SELECT, INSERT ON student_history_contributions TO eduos_app;
REVOKE DELETE, TRUNCATE ON student_history_contributions FROM eduos_app;
GRANT UPDATE (status, reviewed_by, reviewed_at, review_note, history_entry_id, updated_at)
  ON student_history_contributions TO eduos_app;
GRANT SELECT, INSERT ON student_history_contribution_events TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON student_history_contribution_events FROM eduos_app;
-- 088: student history and Time Capsule relationship rules (row-level
-- security helpers; each checks the session's own membership).
GRANT EXECUTE ON FUNCTION eduos_history_relation(uuid,uuid,uuid), eduos_history_user_is(uuid,uuid,uuid,uuid,text),
  eduos_history_entry_visible(uuid,uuid,uuid,text,text,text,uuid), eduos_history_entry_writable(uuid,uuid,uuid,text,text,text,text,uuid),
  eduos_history_entry_manageable(uuid,uuid,uuid,text,uuid), eduos_history_entry_access(uuid,text),
  eduos_capsule_role(uuid,uuid,uuid,uuid,uuid,text), eduos_capsule_access(uuid) TO eduos_app;

-- 090 TC-03: teacher contributions. Steps (submit, school review, family
-- decision) go through these functions; the decision log is read-only here.
GRANT SELECT ON student_history_entry_decisions TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON student_history_entry_decisions FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_history_submit(uuid), eduos_history_review(uuid,text,text,text),
  eduos_history_family_decide(uuid,text,text,text) TO eduos_app;

-- 091 Time Capsule lifecycle. Seal, cancel, milestone release and the release
-- sweep go through these functions; eduos_capsule_try_release and
-- eduos_capsule_event are internal to them.
GRANT EXECUTE ON FUNCTION eduos_capsule_is_draft(uuid), eduos_capsule_seal(uuid), eduos_capsule_cancel(uuid),
  eduos_capsule_release_milestone(uuid), eduos_capsule_release_due(integer), eduos_capsule_contents(uuid),
  eduos_capsule_invitations(), eduos_capsule_recipient_options(uuid), eduos_capsule_milestones_pending() TO eduos_app;

-- 092 SIS-04 class rosters: a sync refreshes synced_at on rows it keeps;
-- manual teacher matches are edited by district leads.
GRANT UPDATE (synced_at) ON teacher_student_rosters TO eduos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_staff_map TO eduos_app;

-- LTI 1.3: replay ledger remains inaccessible; only the tenant-checked
-- SECURITY DEFINER function may atomically claim a launch under tenant context.
GRANT EXECUTE ON FUNCTION eduos_lti_consume_launch(uuid, text, timestamptz) TO eduos_app;
-- CANVAS-API-01 (096): one-time OAuth state and tenant-owned encrypted grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_canvas_oauth_states TO eduos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_canvas_oauth_grants TO eduos_app;
REVOKE TRUNCATE ON integration_canvas_oauth_states, integration_canvas_oauth_grants FROM eduos_app;

-- 097 LTI-02 Deep Linking: links are placed and removed, never edited; each
-- return is recorded once.
GRANT SELECT, INSERT, DELETE ON lti_content_links TO eduos_app;
REVOKE UPDATE, TRUNCATE ON lti_content_links FROM eduos_app;
GRANT SELECT, INSERT ON lti_deep_link_returns TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON lti_deep_link_returns FROM eduos_app;

-- 098 LTI-03 NRPS: teachers share a course's class list with a tool; tools
-- read it only through the checked functions; every read is logged.
GRANT SELECT, INSERT, DELETE ON lti_course_sharing TO eduos_app;
REVOKE UPDATE, TRUNCATE ON lti_course_sharing FROM eduos_app;
GRANT SELECT, INSERT ON lti_service_assertions, lti_service_access_log TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON lti_service_assertions, lti_service_access_log FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_lti_nrps_members(uuid, uuid) TO eduos_app;

-- 099 LTI-04 AGS: the district policy, school approvals (revoked, never
-- deleted), per-activity switches, and tool scores kept apart from the
-- gradebook. Tools write scores only through eduos_lti_record_score.
GRANT SELECT, INSERT, UPDATE ON lti_grade_policy TO eduos_app;
REVOKE DELETE, TRUNCATE ON lti_grade_policy FROM eduos_app;
GRANT SELECT, INSERT ON lti_school_grade_approvals TO eduos_app;
GRANT UPDATE (revoked_by, revoked_at, revoke_reason) ON lti_school_grade_approvals TO eduos_app;
REVOKE DELETE, TRUNCATE ON lti_school_grade_approvals FROM eduos_app;
GRANT UPDATE (grades_enabled_by, grades_enabled_at) ON lti_content_links TO eduos_app;
GRANT SELECT ON lti_scores, lti_score_events TO eduos_app;
GRANT UPDATE (status, reviewed_by, reviewed_at, updated_at) ON lti_scores TO eduos_app;
REVOKE INSERT, DELETE, TRUNCATE ON lti_scores FROM eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON lti_score_events FROM eduos_app;
GRANT UPDATE (grade_source) ON assignment_submissions TO eduos_app;
GRANT EXECUTE ON FUNCTION eduos_lti_ags_link(uuid, uuid), eduos_lti_ags_learners(uuid, uuid),
  eduos_lti_record_score(uuid, uuid, uuid, numeric, numeric, text, text, text, timestamptz, jsonb) TO eduos_app;

-- TEACH-02 (db/102): the shared materials library. A share is updated
-- (re-shared or withdrawn), never deleted; copies are a record only.
GRANT SELECT, INSERT ON shared_materials, shared_material_copies TO eduos_app;
GRANT UPDATE (title, subject, grade_level, summary, body, version, status, withdrawn_by, withdrawn_at, withdrawn_reason, updated_at) ON shared_materials TO eduos_app;
REVOKE DELETE, TRUNCATE ON shared_materials, shared_material_copies FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_material_copies(uuid) TO eduos_app;

-- TEACH-03 (db/103): co-written drafts. Saved (updated) by editors; revisions
-- are append-only; editors leave by setting left_at; nothing is deleted.
GRANT SELECT, INSERT ON collab_drafts, collab_draft_editors, collab_draft_revisions TO eduos_app;
GRANT UPDATE (title, subject, grade_level, body, version, updated_by, updated_at) ON collab_drafts TO eduos_app;
GRANT UPDATE (left_at) ON collab_draft_editors TO eduos_app;
REVOKE DELETE, TRUNCATE ON collab_drafts, collab_draft_editors, collab_draft_revisions FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_is_draft_editor(uuid) TO eduos_app;

-- TEACH-04 (db/104): daily class plans; edited in place, never deleted (an
-- emptied plan has no blocks).
GRANT SELECT, INSERT ON class_day_plans TO eduos_app;
GRANT UPDATE (title, blocks, status, version, updated_by, updated_at) ON class_day_plans TO eduos_app;
REVOKE DELETE, TRUNCATE ON class_day_plans FROM eduos_app;

-- COACH-02 (db/106): a coach's own practice plans and playbooks; archived,
-- never deleted.
GRANT SELECT, INSERT ON coaching_plans TO eduos_app;
GRANT UPDATE (title, sport, level, body, team_id, version, archived_at, updated_at) ON coaching_plans TO eduos_app;
REVOKE DELETE, TRUNCATE ON coaching_plans FROM eduos_app;

-- STATE-01 (db/107): the district's state, its own state-index entries, and
-- educators' licenses. Retired, never deleted.
GRANT SELECT, INSERT ON district_state_settings, district_state_entries, educator_licenses TO eduos_app;
GRANT UPDATE (state_code, updated_by, updated_at) ON district_state_settings TO eduos_app;
GRANT UPDATE (retired_at, retired_by) ON district_state_entries TO eduos_app;
GRANT UPDATE (state_code, license_number, license_type, endorsements, issued_on, expires_on, status, verified_by, verified_at, verify_note, updated_at, retired_at) ON educator_licenses TO eduos_app;
REVOKE DELETE, TRUNCATE ON district_state_settings, district_state_entries, educator_licenses FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_works_at_my_school(uuid) TO eduos_app;

-- DEV-01 (db/108): classroom rooms and the device registry. Archived/retired, never deleted.
GRANT SELECT, INSERT ON classroom_rooms, classroom_devices, classroom_device_events TO eduos_app;
GRANT USAGE ON SEQUENCE classroom_device_events_id_seq TO eduos_app;
GRANT UPDATE (name, building, capacity, archived_at) ON classroom_rooms TO eduos_app;
GRANT UPDATE (kind, name, maker, model, serial, capabilities, status, room_id, decided_by, decided_at, decision_note, updated_at, retired_at) ON classroom_devices TO eduos_app;
REVOKE DELETE, TRUNCATE ON classroom_rooms, classroom_devices, classroom_device_events FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_device_scope(uuid), eduos_device_manager(uuid) TO eduos_app;

-- DEV-02 (db/109): room timetable and pairing a teacher's own device. Codes
-- are reachable only through the two SECURITY DEFINER functions.
GRANT SELECT, INSERT ON classroom_room_teachers TO eduos_app;
GRANT UPDATE (ended_at, ended_by) ON classroom_room_teachers TO eduos_app;
GRANT SELECT ON classroom_pairings TO eduos_app;
GRANT UPDATE (ended_at, ended_by, end_reason) ON classroom_pairings TO eduos_app;
GRANT UPDATE (token_hash, token_issued_at, token_issued_by) ON classroom_devices TO eduos_app;
REVOKE ALL ON classroom_pair_codes FROM eduos_app;
REVOKE DELETE, TRUNCATE ON classroom_room_teachers, classroom_pairings FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_is_school_teacher(uuid, uuid), eduos_school_teachers(uuid), eduos_classroom_agent_code(uuid, text, text, int), eduos_classroom_pair(uuid, text, text) TO eduos_app;

-- DEV-03 (db/110): classroom commands. Written only by the three SECURITY
-- DEFINER functions; read by the sender and the school's leaders.
GRANT SELECT ON classroom_commands TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON classroom_commands FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_classroom_command(uuid, text, jsonb), eduos_classroom_agent_take(uuid, text), eduos_classroom_agent_result(uuid, text, uuid, boolean, text) TO eduos_app;

-- ROOM-01 (db/111): scanning into a room. Check-ins and check-in codes are
-- written only by the SECURITY DEFINER functions.
GRANT UPDATE (kind, door_secret_hash, door_secret_set_at) ON classroom_rooms TO eduos_app;
GRANT SELECT ON room_checkins TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON room_checkins FROM eduos_app;
REVOKE ALL ON classroom_checkin_codes FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_can_read_room_checkins(uuid, uuid), eduos_room_slot_now(uuid), eduos_room_local_date(uuid),
  eduos_classroom_agent_checkin_code(uuid, text, text), eduos_room_checkin(uuid, text, text), eduos_classroom_agent_kiosk_checkin(uuid, text, text), eduos_my_room_checkins() TO eduos_app;

-- ROOM-02 (db/112): remote lessons on the teacher's daily schedule. Remote
-- check-ins are written only by eduos_remote_lesson_join(). Cancelled, never deleted.
GRANT SELECT, INSERT ON class_remote_lessons TO eduos_app;
GRANT UPDATE (starts, ends, join_url, lesson_id, note, updated_at, cancelled_at) ON class_remote_lessons TO eduos_app;
GRANT SELECT ON remote_lesson_checkins TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON remote_lesson_checkins FROM eduos_app;
REVOKE DELETE, TRUNCATE ON class_remote_lessons FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_teaches_course(uuid), eduos_enrolled_pupil_student(uuid), eduos_remote_lesson_join(uuid) TO eduos_app;

-- TEACH-05 (db/113): the portable teacher profile. Withdrawn/archived, never deleted.
GRANT SELECT, INSERT ON teacher_work_claims, portfolio_packages, portfolio_imports, teacher_library_items TO eduos_app;
GRANT UPDATE (status, reviewed_by, reviewed_at, review_note) ON teacher_work_claims TO eduos_app;
GRANT UPDATE (withdrawn_at) ON portfolio_packages TO eduos_app;
GRANT UPDATE (status, reviewed_by, reviewed_at, review_note, items) ON portfolio_imports TO eduos_app;
GRANT UPDATE (archived_at) ON teacher_library_items TO eduos_app;
REVOKE DELETE, TRUNCATE ON teacher_work_claims, portfolio_packages, portfolio_imports, teacher_library_items FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_portfolio_reviewer(uuid, uuid) TO eduos_app;

-- TEACH-06 (db/114): approved storage. Retired / kept, never deleted.
GRANT SELECT, INSERT ON storage_devices, district_storage_settings, portfolio_cloud_copies, portfolio_offloads TO eduos_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note, public_key, key_fingerprint, retired_at) ON storage_devices TO eduos_app;
GRANT UPDATE (cloud_enabled, retention_days, updated_by, updated_at) ON district_storage_settings TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON portfolio_cloud_copies, portfolio_offloads FROM eduos_app;
REVOKE DELETE, TRUNCATE ON storage_devices, district_storage_settings FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_storage_overseer(uuid) TO eduos_app;

-- SPORTS-01 (db/115): MaxPreps / Hudl links, family opt-in and export log. Removed/revoked, never deleted.
GRANT SELECT, INSERT ON activity_external_links, athlete_sharing_consents, sports_exports TO eduos_app;
GRANT UPDATE (removed_at) ON activity_external_links TO eduos_app;
GRANT UPDATE (revoked_by, revoked_at) ON athlete_sharing_consents TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sports_exports FROM eduos_app;
REVOKE DELETE, TRUNCATE ON activity_external_links, athlete_sharing_consents FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_manages_team(uuid), eduos_is_family_of(uuid) TO eduos_app;

-- SPORTS-02 (db/116): MaxPreps / Hudl connectors. Revoked / hidden, never deleted.
GRANT SELECT, INSERT ON sports_connectors, sports_connector_teams, sports_connector_runs, sports_inbound_results, sports_film_links TO eduos_app;
GRANT UPDATE (base_url, secret_enc, key_hint, send_roster, send_schedule, pull_results, pull_film, status, decided_by, decided_at, decision_note, last_run_at) ON sports_connectors TO eduos_app;
GRANT UPDATE (external_team_id, set_by, set_at) ON sports_connector_teams TO eduos_app;
GRANT UPDATE (status, reviewed_by, reviewed_at) ON sports_inbound_results TO eduos_app;
GRANT UPDATE (hidden_by, hidden_at) ON sports_film_links TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sports_connector_runs FROM eduos_app;
REVOKE DELETE, TRUNCATE ON sports_connectors, sports_connector_teams, sports_inbound_results, sports_film_links FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_sports_lead(uuid) TO eduos_app;

-- RANK-01 (db/117): a school's U.S. News indicator figures. Superseded, never deleted.
GRANT SELECT, INSERT ON school_ranking_entries TO eduos_app;
GRANT UPDATE (verified_by, verified_at, superseded_at) ON school_ranking_entries TO eduos_app;
REVOKE DELETE, TRUNCATE ON school_ranking_entries FROM eduos_app;

-- TC-05 (db/118): history privacy controls. Lifted / reversed / revoked / closed, never deleted.
GRANT SELECT, INSERT ON student_custody_restrictions, student_rights_transitions, history_sharing_grants, history_emergency_access, history_access_log TO eduos_app;
GRANT USAGE ON SEQUENCE history_access_log_id_seq TO eduos_app;
GRANT UPDATE (lifted_by, lifted_at, lift_note) ON student_custody_restrictions TO eduos_app;
GRANT UPDATE (reversed_by, reversed_at, reverse_note) ON student_rights_transitions TO eduos_app;
GRANT UPDATE (revoked_at, revoked_by) ON history_sharing_grants TO eduos_app;
GRANT UPDATE (closed_at, reviewed_by, reviewed_at, review_note) ON history_emergency_access TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON history_access_log FROM eduos_app;
REVOKE DELETE, TRUNCATE ON student_custody_restrictions, student_rights_transitions, history_sharing_grants, history_emergency_access FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_custody_blocked(uuid, uuid), eduos_student_holds_rights(uuid), eduos_history_granted(uuid, uuid, text),
  eduos_history_emergency(uuid, uuid, uuid), eduos_history_own_after_transition(uuid, uuid, uuid), eduos_records_office(uuid),
  eduos_is_student_self(uuid), eduos_is_linked_guardian(uuid) TO eduos_app;

-- SAFE-01 (db/119): room status during an emergency. Append-only.
GRANT SELECT, INSERT ON safety_room_reports TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON safety_room_reports FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_safety_room_reporter(uuid), eduos_safety_room_viewer(uuid), eduos_safety_school_rooms(uuid),
  eduos_safety_my_room_now(), eduos_safety_room_alert_recipients(uuid) TO eduos_app;

-- SAFE-01b (db/120): vice principals start and lead safety alerts.
GRANT EXECUTE ON FUNCTION eduos_safety_incident_staff(uuid), eduos_safety_incident_lead(uuid) TO eduos_app;

-- db/121: vice principals act with the principal's authority, except assigning roles.
GRANT EXECUTE ON FUNCTION eduos_ctx_membership_role(), eduos_ctx_is_vice_principal(), eduos_refuse_vice_principal_assignment(), eduos_audit_membership_role() TO eduos_app;

-- SAFE-02 (db/122): classroom displays follow a safety alert. The device's
-- safety columns are written only by eduos_classroom_agent_safety.
GRANT EXECUTE ON FUNCTION eduos_classroom_agent_safety(uuid, text), eduos_safety_live_at(uuid), eduos_safety_displays(uuid) TO eduos_app;

-- SAFE-03 (db/123): hazards and shelter areas. Areas are ended, never deleted.
GRANT SELECT, INSERT ON school_shelter_areas TO eduos_app;
GRANT UPDATE (ended_by, ended_at) ON school_shelter_areas TO eduos_app;
REVOKE DELETE, TRUNCATE ON school_shelter_areas FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_shelter_area_manager(uuid), eduos_shelter_area_for(uuid, uuid, uuid, text) TO eduos_app;

-- SAFE-04 (db/124): National Weather Service prompts. Alerts are written by
-- the sweep's functions; leaders decide them. Settings and points are edited.
GRANT SELECT, INSERT ON district_weather_settings, school_weather_points TO eduos_app;
GRANT UPDATE (enabled, set_by, set_at) ON district_weather_settings TO eduos_app;
GRANT UPDATE (lat, lon, set_by, set_at), DELETE ON school_weather_points TO eduos_app;
GRANT SELECT ON school_weather_alerts TO eduos_app;
GRANT UPDATE (decision, decided_by, decided_at, decision_note, incident_id) ON school_weather_alerts TO eduos_app;
REVOKE DELETE, TRUNCATE ON district_weather_settings, school_weather_alerts FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_weather_lead(uuid), eduos_weather_targets(), eduos_weather_record(uuid, uuid, jsonb), eduos_weather_recipients(uuid, uuid) TO eduos_app;

-- TC-05 export (db/125): download limits.
GRANT EXECUTE ON FUNCTION eduos_history_export_allowed(uuid) TO eduos_app;

-- MEDIA-01 (db/126): history photos. Policies are edited by the
-- superintendent; photos go through the definer functions only.
GRANT SELECT, INSERT ON district_history_media_policies TO eduos_app;
GRANT UPDATE (images_enabled, max_image_bytes, max_per_entry, max_bytes_per_student, set_by, set_at) ON district_history_media_policies TO eduos_app;
REVOKE DELETE, TRUNCATE ON district_history_media_policies FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_history_media_begin(uuid, uuid, text, text, bigint, text, text, text), eduos_history_media_get(uuid, text),
  eduos_history_media_set(uuid, text, bigint, text, text, int, int), eduos_history_entry_photos(uuid[]) TO eduos_app;

-- MEDIA-02 (db/127): family photos; reached only through these functions.
-- TC-02 guardian text documents (db/138); metadata and objects remain private.
GRANT EXECUTE ON FUNCTION eduos_history_contribution_document_begin(uuid, uuid, text, bigint, text, text),
  eduos_history_contribution_document_set(uuid, text, bigint, text, text),
  eduos_history_contribution_document_get(uuid),
  eduos_history_contribution_documents_release(uuid) TO eduos_app;

GRANT EXECUTE ON FUNCTION eduos_history_student_media_bytes(uuid, uuid), eduos_history_contribution_mine(uuid), eduos_history_contribution_reviewer(uuid),
  eduos_history_contribution_photo_begin(uuid, uuid, text, text, bigint, text, text, text),
  eduos_history_contribution_photo_set(uuid, text, bigint, text, text, int, int), eduos_history_contribution_photo_get(uuid),
  eduos_history_contribution_photos(uuid[]), eduos_history_contribution_photos_publish(uuid), eduos_history_contribution_photos_release(uuid) TO eduos_app;

-- MEDIA-03 (db/128): Time Capsule photos; reached only through these functions.
GRANT EXECUTE ON FUNCTION eduos_capsule_photo_begin(uuid, uuid, text, text, bigint, text, text, text),
  eduos_capsule_photo_set(uuid, text, bigint, text, text, int, int), eduos_capsule_photos(uuid), eduos_capsule_photo_get(uuid),
  eduos_capsule_photos_release(uuid) TO eduos_app;

-- TC-06a (db/129): history transfers. The records office reads them; every
-- change goes through these functions.
GRANT SELECT ON history_transfers TO eduos_app;
GRANT EXECUTE ON FUNCTION eduos_records_office_for(uuid), eduos_history_transfer_start(uuid, text, text, text, boolean), eduos_history_transfer_family_decider(uuid),
  eduos_history_transfer_family_pending(), eduos_history_transfer_family_decide(uuid, boolean), eduos_history_transfer_cancel(uuid, text),
  eduos_history_transfer_contents(uuid), eduos_history_transfer_downloaded(uuid, text) TO eduos_app;

-- TC-06b (db/130): receiving history transfers. The records office reads
-- them; every change goes through these functions.
GRANT SELECT ON history_imports, history_import_items TO eduos_app;
GRANT EXECUTE ON FUNCTION eduos_history_import_office(uuid), eduos_history_import_receive(text, text, jsonb, jsonb, jsonb), eduos_history_import_candidates(uuid),
  eduos_history_import_confirm(uuid, text, uuid), eduos_history_import_decide(uuid, integer, boolean, text), eduos_history_import_close(uuid, text),
  eduos_history_entry_origins(uuid[]) TO eduos_app;
-- TC-08 (db/132): preservation. Policies are edited by the superintendent;
-- holds, events and media checks change only through these functions.
GRANT SELECT, INSERT ON district_history_preservation_policies TO eduos_app;
GRANT UPDATE (verify_every_days, archive_after_days, capacity_alert_percent, records_schedule_ref, set_by, set_at) ON district_history_preservation_policies TO eduos_app;
REVOKE DELETE, TRUNCATE ON district_history_preservation_policies FROM eduos_app;
GRANT SELECT ON history_legal_holds, history_preservation_events TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON history_legal_holds, history_preservation_events FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_history_on_hold(uuid, uuid), eduos_history_hold_place(uuid, text, text), eduos_history_hold_release(uuid, text),
  eduos_history_media_checksum(uuid, text), eduos_history_preservation_due(integer), eduos_history_preservation_record(uuid, text, text, text),
  eduos_history_capacity_report(), eduos_history_last_check() TO eduos_app;

-- TC-11 (db/134): the family storage dashboard's totals.
GRANT EXECUTE ON FUNCTION eduos_history_family_storage(uuid) TO eduos_app;

-- TC-09 (db/135): donations (sandbox only). Gifts are started by the donor;
-- outcomes and acknowledgements only through the function.
GRANT SELECT, INSERT ON district_donation_settings TO eduos_app;
GRANT UPDATE (enabled, min_cents, max_cents, suggested_cents, acknowledgement_text, tax_wording_enabled, tax_wording, updated_by, updated_at) ON district_donation_settings TO eduos_app;
REVOKE DELETE, TRUNCATE ON district_donation_settings FROM eduos_app;
GRANT SELECT, INSERT ON history_donations TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON history_donations FROM eduos_app;
GRANT SELECT ON history_donation_acknowledgements TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON history_donation_acknowledgements, history_donation_counters FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_history_donation_record(uuid, text, text) TO eduos_app;

-- TC-10 (db/136): donation accounting. The ledger, refunds, reconciliations and
-- reviewer appointments are read through RLS and written only by functions.
GRANT SELECT ON history_donation_finance_reviewers, history_donation_ledger, history_donation_refunds, history_donation_reconciliations TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON history_donation_finance_reviewers, history_donation_ledger, history_donation_refunds, history_donation_reconciliations FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_history_donation_finance(), eduos_history_donation_reviewer_set(uuid, boolean), eduos_history_donation_refund(uuid, text, text),
  eduos_history_donation_reconciliation(date, date), eduos_history_donation_reconcile(date, date, text) TO eduos_app;

-- TC-12 (db/137): the preservation fund. Settings and governance records are
-- written by the superintendent through RLS; disbursements, votes and the fund
-- ledger only through functions. The gift gate is a trigger (no grant needed).
GRANT SELECT, INSERT ON preservation_fund_settings TO eduos_app;
GRANT UPDATE (enabled, collection_paused, disbursement_paused, pause_reason, fund_name, purpose, eligible_categories, allocation_rules, governance_text,
  refund_policy, public_report, grade_card_footnote, report_min_donors, updated_by, updated_at) ON preservation_fund_settings TO eduos_app;
REVOKE DELETE, TRUNCATE ON preservation_fund_settings FROM eduos_app;
GRANT SELECT, INSERT ON preservation_fund_governance_records TO eduos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON preservation_fund_governance_records FROM eduos_app;
GRANT SELECT ON preservation_fund_disbursements, preservation_fund_votes, preservation_fund_ledger TO eduos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON preservation_fund_disbursements, preservation_fund_votes, preservation_fund_ledger FROM eduos_app;
GRANT EXECUTE ON FUNCTION eduos_preservation_fund_collection_open(uuid), eduos_preservation_fund_available(uuid, uuid),
  eduos_preservation_fund_request(uuid, uuid, text, text, text, text, integer), eduos_preservation_fund_vote(uuid, text, boolean, text),
  eduos_preservation_fund_pay(uuid, text), eduos_preservation_fund_close(uuid, text), eduos_preservation_fund_summary(),
  eduos_preservation_fund_seat(uuid), eduos_preservation_fund_grade_card_footnote() TO eduos_app;
