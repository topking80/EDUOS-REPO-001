# Canvas LMS integration: LTI 1.3 / LTI Advantage

Status: implementation plan and security acceptance criteria. This document does not claim that Canvas interoperability is complete.

## Repository audit

The existing `src/lti.js` contains LTI 1.3 building blocks: RS256 platform-key loading, JWKS construction, signed short-lived launch hints, per-process replay tracking, pairwise subjects, basic resource-link claims, and HTTPS URL validation. Its own header explicitly says it does not provide NRPS or AGS. The audit also found no LTI route registration in `src/server.js` and no LTI-specific test suite. Therefore the existing module is a foundation, not a usable Canvas integration.

## Product commitment

Canvas LMS is a supported educational-software integration through the district-managed app catalog. The platform side is EduOS; Canvas is the LTI tool/consumer for EduOS launches where configured, and EduOS may also act as an LTI platform for approved Canvas-hosted tools. These are distinct deployment roles and must not be conflated. Initial delivery should explicitly state which direction is implemented; this plan prioritizes EduOS as the LTI 1.3 platform for launching approved tools from EduOS, with Canvas interoperability validation against Canvas test instances.

## Required protocol support

- LTI 1.3 Core OIDC login initiation, authorization response, signed ID token, issuer/audience/nonce/state validation, key rotation, and JWKS discovery.
- LTI Advantage Deep Linking 2.0 request/response, with district-approved content types and destination validation.
- Assignment and Grade Services (AGS): scopes and line-item/results/score operations only after a district enables grade exchange for the specific integration and course.
- Names and Role Provisioning Services (NRPS): roster/context membership only after explicit district approval and a per-course sharing decision.
- Resource Link launches with stable resource-link identifiers and per-app pairwise subject identifiers.
- Canvas-specific configuration and test fixtures kept separate from protocol-generic LTI behavior.

## District governance and privacy requirements

1. Integrations are disabled by default. A superintendent or IT administrator may configure one; a different authorized district administrator must approve it.
2. Every configuration, redirect URI, deployment ID, scope, course mapping, data-sharing setting, and credential change invalidates prior approval and requires re-approval.
3. Enforce tenant and school isolation server-side on every launch, roster, grade, line-item, and deep-link operation. Never trust client-supplied district, school, course, role, or learner identifiers.
4. Use least-privilege OAuth scopes. NRPS and AGS are independently disabled by default; identity-only launches must not silently grant roster or grade access.
5. Do not expose family, attendance, wellbeing, discipline, transportation, payment, or unrelated SIS data through LTI claims or services.
6. Use pairwise pseudonymous subjects per tool; send only the identity attributes explicitly authorized by the district and allowed by the integration's approved scope.
7. Encrypt secrets at rest; never log tokens, private keys, authorization codes, grade payloads, or student PII. Return `Cache-Control: no-store` for protocol responses.
8. Validate issuer, client ID, deployment ID, exact redirect URI, state, nonce, audience, signature, algorithm, timestamps, and one-time launch identifiers. Reject unsigned tokens, algorithm confusion, replay, stale state, and unregistered deployments.
9. Apply SSRF defenses to metadata/JWKS retrieval and outbound calls: HTTPS only in production, DNS/IP validation, pinned connections, no redirects, host allowlists, bounded timeouts and response sizes.
10. Record privacy-safe audit events for launches, approvals, data reads/writes, grade changes, sync failures, and revocations. Provide an immediate district kill switch.
11. Honor district policy and retention settings; if a requested scope or workflow conflicts with district policy, deny it rather than weakening the policy.
12. No student-facing launch or grade write is enabled in production until the relevant security, accessibility, interoperability, and district-policy gates pass.

## Delivery sequence

### Phase 1 — make the existing LTI 1.3 core operable
- [x] Register the LTI authorization route and JWKS endpoint through the district app routes.
- [x] Add a tenant-scoped PostgreSQL replay ledger and atomic consume function; the runtime role can call only the function, not read or mutate the ledger directly.
- [x] Wire atomic replay consumption into the OIDC authorization transaction; reject duplicate launches across processes/restarts.
- [ ] Persist and validate OIDC state/nonce across the complete browser round trip; the current authorization route requires non-empty values and signs the supplied nonce into the ID token, but does not yet provide durable pre-auth state/nonce correlation.
- Add strict OIDC request validation and key rotation. Keep LTI deployment ID in the signed LTI claim; it is not a standard OIDC authorization-request parameter.
- Add schema-backed tool/deployment registrations, redirect URI allowlists, approval workflow, revocation, and district kill switch.
- Add unit, route, multi-tenant, replay, and negative-security tests.

### Phase 2 — Canvas configuration and interoperability
- Add Canvas-specific setup guidance and an administrator-facing configuration flow.
- Validate Canvas issuer, client ID, deployment ID, login URL, redirect URLs, and JWKS behavior against official Canvas LTI configuration.
- Add end-to-end tests using a Canvas test instance; do not use production student data in test fixtures.

### Phase 3 — Deep Linking
- Support signed Deep Linking requests and validated responses.
- Permit only district-approved resource types and approved EduOS destinations.
- Test malicious URLs, unapproved content, replay, and cross-tenant references.

### Phase 4 — NRPS
- Implement membership endpoint and OAuth scope enforcement.
- Return only course-scoped members and the minimum role/profile fields.
- Require per-course opt-in and verify teacher/administrator permissions.

### Phase 5 — AGS
- Implement line-item, result, and score services with strict course/resource ownership.
- Require explicit district and course-level grade-write approval.
- Enforce score range/type validation, idempotency, replay protection, audit trails, and grade-change attribution.
- Keep grade writes disabled until Canvas interoperability and district policy tests pass.

## Acceptance gates

- Protocol conformance tests for LTI 1.3 Core and the enabled Advantage services.
- Canvas test-instance launch, Deep Linking, NRPS, and AGS end-to-end tests for each released phase.
- Negative tests for invalid signatures, wrong issuer/audience/deployment, nonce/state mismatch, replay, expired requests, redirect mismatch, unknown key IDs, revoked tools, disabled scopes, and tenant/course boundary violations.
- Security tests for SSRF, credential leakage, log redaction, rate limits, request-size limits, and durable replay prevention across multiple app instances.
- Authorization tests prove a teacher cannot approve their own connector, one district cannot read another district's courses/rosters/grades, and a tool cannot widen its approved scope.
- Accessibility checks for the administrator setup and learner launch surfaces.
- District-policy review confirms no restricted data or prohibited workflow is enabled.
- CI and all relevant unit, integration, and security checks pass before merge.

## Current limitations

This PR records the required scope and audit findings and adds a durable replay-consumption primitive. The durable replay primitive is now wired into the OIDC authorization transaction, with client, target-link, exact redirect, state, and nonce request checks; the deployment ID is emitted in the signed LTI claim rather than incorrectly required as an OIDC authorization parameter. It still does not claim durable pre-auth state/nonce correlation, NRPS, AGS, Deep Linking, Canvas test-instance certification, or production readiness. Those capabilities must ship in separately testable increments behind district-controlled feature flags.
