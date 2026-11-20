# Canvas API integration plan

## Purpose and direction

EduOS launches the district's Canvas LMS from the approved app catalog. Canvas is the destination for that launch. This document covers a separate, optional API connection so EduOS can exchange approved academic data with the district's Canvas tenant.

The API connection must not change the launch direction, replace the district identity provider, or make Canvas a required dependency. A district may use the catalog launch without enabling API synchronization.

## Existing foundation to reuse

The repository already has a governed integration pipeline:

- District-scoped connector records with row-level security.
- AES-256-GCM encrypted connector credentials, bound to connector and district.
- Superintendent / IT-admin management and two-person approval.
- URL validation, public-address DNS checks, pinned outbound connections, no redirects, bounded response size and timeout.
- Preview-before-apply, explicit school mapping, shared SIS import rules, audit history and separately approved schedules.
- Configuration-version checks that reject a sync if connector configuration changes while data is being fetched.

Canvas work should extend this pipeline where semantics fit. It must not weaken those controls or reuse the existing OAuth client-credentials adapter for Canvas user authorization.

## Canvas authentication model

Canvas REST API access uses OAuth 2.0 authorization code flow. The district registers an institution-managed Canvas developer key and configures its exact redirect URI. A district-authorized Canvas administrator initiates the connection from EduOS and approves the requested access in Canvas. EduOS never collects a Canvas password, asks for a personal access token, or forwards browser cookies.

Required implementation controls:

1. Validate the Canvas tenant origin as HTTPS and apply the existing outbound URL / DNS pinning policy to every token and API request. Do not accept arbitrary per-request hosts.
2. Use an unpredictable, single-use, short-lived OAuth state value bound to the initiating EduOS district, user, connector, exact Canvas origin, and callback. Store only a hash of state. Reject replay, mismatch, expiry, cross-district callbacks, and callbacks for disabled or changed connectors.
3. Use the exact registered redirect URI for both authorization and token exchange. Do not derive it from an untrusted Host or forwarded header.
4. Keep the Canvas developer-key client secret and OAuth refresh token encrypted at rest with tenant/connector-bound associated data. Never return secrets or access/refresh tokens from APIs, logs, audit details, errors, browser storage, or sync history.
5. Keep access tokens in memory only where practical; refresh them server-side before expiry. Canvas access tokens commonly expire after one hour. Serialize refresh per connector to avoid concurrent refresh races. Treat revoked/invalid refresh credentials as requiring a new administrator authorization.
6. Use the HTTP Authorization Bearer header only. Never put tokens in query strings.
7. Use minimum developer-key endpoint scopes configured by the district. The connection must fail closed if required scopes are unavailable; do not silently request broader permissions.
8. Keep connector configuration and OAuth grant approval separate. Any change to tenant origin, developer key, redirect URI, requested scope, or grant owner invalidates approval and pauses scheduled work.
9. Provide a district-visible disconnect/revoke action. Delete encrypted tokens, cancel pending jobs, invalidate OAuth state, and record a secret-free audit event.
10. Bind the grant to a named district service owner and record the Canvas account/user identity returned by OAuth for accountability. Do not impersonate teachers or learners.

## Proposed PR sequence

### CANVAS-API-01 — OAuth connection and secure token lifecycle

- Add a Canvas API connector kind without changing existing OneRoster, Ed-Fi, or PowerSchool behavior.
- Add tenant-scoped, RLS-protected OAuth state and token storage with least-privilege runtime grants.
- Implement authorization start, callback, code exchange, refresh, status, and disconnect/revoke routes.
- Reuse existing URL validation and pinned outbound HTTP transport; add safe form-encoded token exchange support.
- Enforce state replay defense, exact redirect matching, cross-district isolation, two-person approval, connector-version checks, refresh serialization, and secret redaction.
- Add unit and real-PostgreSQL integration tests for success, denial, replay, expired state, wrong district, changed config, revoked grant, refresh race, and runtime privilege isolation.
- Keep the connector disabled until district-provided Canvas developer-key setup and review are complete.

### CANVAS-API-02 — Course and enrollment discovery (read-only)

- Read only the district-authorized courses and active student/teacher enrollments.
- Use paginated Canvas API requests, bounded page/record counts, cancellation, rate-limit handling and retry-after behavior.
- Preserve Canvas IDs as external identifiers; never infer matches from names alone.
- Require explicit course-to-EduOS class and Canvas-school-to-EduOS-school mappings.
- Preview differences before any local import. Do not create or modify Canvas records.
- Add tests for pagination, cross-course isolation, inactive enrollments, duplicates, deleted courses, partial API failures and mapping changes during a sync.

### CANVAS-API-03 — Grade synchronization (read-only first)

- Define a district-approved source-of-truth and mapping policy before implementation.
- Start with read-only grade/submission retrieval and preview. No automatic grade writes to Canvas or EduOS in this phase.
- Map grading periods, assignment groups, excused/missing states, late submissions, points, percentages and final-grade calculation explicitly; do not equate a course total with a report-card grade without district rules.
- Enforce course, school, student, and staff authorization at every query and import.
- Keep grade records separate from roster imports and record provenance, timestamps, source IDs and corrections.
- Require district policy, FERPA/privacy, accessibility and human acceptance before enabling any grade import.

### CANVAS-API-04 — Approved write-back (only if district policy authorizes it)

- Separate opt-in capability and approval from read-only sync.
- Define exactly which fields, roles, courses and grading periods may be written.
- Use idempotency/reconciliation, explicit conflict handling, dry-run preview, audit, rate limits, and a district-wide kill switch.
- Never overwrite a teacher's grade silently. Require a documented conflict policy and human confirmation for disputed or final grades.
- Keep write scopes disabled by default and unavailable until the district signs off.

## Data and policy boundaries

- Canvas launch from the EduOS catalog remains independent of this connector.
- No Canvas API sync runs merely because an app is launched.
- Do not sync messages, inbox content, files, submissions/attachments, discussion content, analytics, or unrelated profile/demographic fields as part of the initial scope.
- Do not raise per-student storage limits or bypass district retention/storage policy.
- Do not treat OAuth consent as district approval for data use. The district must approve purpose, scope, retention, role access, vendor terms and parent/student notice as applicable.
- Do not enable a connector or schedule automatically after OAuth succeeds.

## Acceptance gates

A PR is not complete merely because unit tests pass. Each implementation PR must include:

- Unit tests and real-PostgreSQL integration tests for tenant isolation, RLS, authorization, state/replay, approvals, token lifecycle, audit and failure rollback.
- Security review for SSRF/DNS rebinding, redirect handling, token leakage, OAuth CSRF, replay, privilege escalation, race conditions, rate limits, pagination bounds and denial-of-service.
- CI including CodeQL, dependency/source/container security, integration and E2E checks.
- A district Canvas test tenant and institution-issued developer key for end-to-end verification before production enablement. Test credentials must be supplied through approved secret management and must never be committed or pasted into issues/PRs.
- Written district acceptance of the exact data fields and sync direction before any live sync is enabled.

## References

- [Canvas OAuth2 documentation](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth)
- [Canvas OAuth2 endpoints](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth_endpoints)
- [Canvas developer keys and scoped access](https://developerdocs.instructure.com/services/canvas/platform/developer-keys)

