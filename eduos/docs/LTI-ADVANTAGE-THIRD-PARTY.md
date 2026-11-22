# LTI 1.3 Core platform support for third-party educational software

Status: LTI 1.3 Core resource-link launch is implemented (Phase 1). Deep Linking, NRPS and AGS are not. This document defines the scope and acceptance criteria; it does not claim LTI Advantage conformance or certification.

## Repository audit

The existing `src/lti.js` contains LTI 1.3 building blocks: RS256 platform-key loading, JWKS construction, signed short-lived launch hints, pairwise subjects, basic resource-link claims, and HTTPS URL validation. `src/mesh-routes.js` already registers the OIDC authorization and JWKS endpoints; this PR adds durable replay consumption and LTI-specific regression tests. NRPS, AGS, and Deep Linking remain unimplemented. Therefore this is an initial platform-side Core slice, not a complete or certified LTI Advantage integration.

## Product commitment

EduOS is the LTI 1.3 platform for approved third-party LTI tools. EduOS initiates and governs those tool launches, scopes, and permitted data exchange. **Canvas LMS is a destination launched by EduOS, not an LTI tool that EduOS launches as an LTI platform.** Canvas is registered in the existing EduOS app catalog as an `oidc_sso` (when the district has configured Canvas to federate with its district identity provider) or `link` app. See [Canvas LMS launch configuration](CANVAS-LMS-LAUNCH.md). This LTI Core implementation remains vendor-neutral for actual LTI tools and is not the Canvas connector.

## Required protocol support

- LTI 1.3 Core OIDC login initiation, authorization response, signed ID token, issuer/audience/nonce/state validation, key rotation, and JWKS discovery.
- LTI Advantage Deep Linking 2.0 request/response, with district-approved content types and destination validation.
- Assignment and Grade Services (AGS): scopes and line-item/results/score operations only after a district enables grade exchange for the specific integration and course.
- Names and Role Provisioning Services (NRPS): roster/context membership only after explicit district approval and a per-course sharing decision.
- Resource Link launches with stable resource-link identifiers and per-app pairwise subject identifiers.
- Vendor-neutral tool registration and configuration; provider-specific compatibility profiles must remain optional and separate from protocol-generic LTI behavior.

## District governance and privacy requirements

1. Integrations are disabled by default. A superintendent or IT administrator may configure one; a different authorized district administrator must approve it.
2. Every configuration, redirect URI, deployment ID, scope, course mapping, data-sharing setting, and credential change invalidates prior approval and requires re-approval.
3. Enforce tenant and school isolation server-side on every launch, roster, grade, line-item, and deep-link operation. Never trust client-supplied district, school, course, role, or learner identifiers.
4. Use least-privilege OAuth scopes. The current LTI Core slice permits only `none` and `identity`; roster, grade, and attendance scopes are rejected until separately governed NRPS/AGS services exist. School IDs/names are not emitted as course context. NRPS and AGS remain independently disabled by default.
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
- [x] Preserve the tool-generated OIDC `state` in the authorization response and include the tool-generated `nonce` in the signed ID token. The tool (as the OIDC relying party) is responsible for checking its returned state and token nonce against the values it created; the platform must not invent a second state/nonce correlation record for this platform-side flow.
- [x] Put the platform issuer (`iss`) and `target_link_uri` on the third-party login-initiation request; require an explicitly configured HTTPS target URI and reject legacy/incomplete LTI configurations at launch. Validate the returned login hint, opaque message hint, client ID, and exact registered redirect URI on the OIDC authentication request. Accept omitted `prompt` or `prompt=none` (reject interactive prompts), and require a non-empty state and nonce for this platform flow.
- [x] Revalidate the exact license whose seat was claimed, live district membership, active app assignment, DPA/learner eligibility, and school status at callback time; a replacement license cannot silently revive a revoked launch.
- [x] Restrict LTI Core claims to `none` and `identity`; reject unsupported roster, grade, and attendance scopes and do not misrepresent a school as an LTI course context.
- [x] Complete strict OIDC request validation: require scalar protocol parameters, reject unknown parameters, enforce supported response/scope/prompt values, and bind the login hint, signed message hint, client ID, and exact redirect URI.
- [x] Bind each launch to the browser that started it: launching sets an HttpOnly, per-launch cookie scoped to `/lti/authorize` (5 minutes, `SameSite=None; Secure` in production so the tool's cross-site redirect or form POST carries it), and the encrypted hint carries its hash. A copied hint without that browser's cookie is refused (`launch_browser_mismatch`), so a hint leaked through the tool, logs or the address bar can't be redeemed for the user's `id_token`. The cookie is cleared once used.
- [x] The auto-submit page runs only its fixed script, allowed by hash (no `'unsafe-inline'`), and sends no referrer.
- [x] Tool registrations live on the app catalog (`apps.integration_config`) with an exact redirect-URI allowlist. Approval and revocation (095): every registration starts pending; a district administrator other than the registrant approves (enforced in the route and in PostgreSQL); any change to the registration or data scope returns it to pending; "Turn off now" revokes it and stops in-flight launches. Managed from **Apps** in the web app.
- [x] Unit, route, multi-tenant, replay, revocation-window and negative-security tests.

### Phase 2 — vendor-neutral tool registration and interoperability
- Add administrator-facing configuration for standards-conformant third-party LTI tools.
- Validate issuer, client ID, deployment ID, login URL, explicit HTTPS target link URI, redirect URLs, and JWKS behavior using provider-neutral registration records.
- Add end-to-end tests against independent LTI 1.3 reference fixtures and more than one standards-conformant tool implementation where available; do not use production student data in test fixtures.
- Keep provider-specific setup notes optional and do not make any competing LMS a required integration target.

### Phase 3 — Deep Linking (LTI-02, implemented)
- [x] A registration opts in with `deepLinkingUrl` and the tool's `jwksUrl` (both required together). Registrations without them keep their existing approval fingerprint; adding or changing them needs approval again.
- [x] Teachers and principals start Deep Linking from an assignment they can manage (`POST /api/apps/:id/deep-link`). It uses the same governed, browser-bound launch: availability, licence seat, approval and callback-time re-checks. The request carries `deep_linking_settings` with `accept_types: ["ltiResourceLink"]`, a return URL on EduOS and an encrypted `data` claim. That claim names the launch, user, assignment and approved registration, lasts 30 minutes, and is bound to the teacher's browser by a cookie scoped to the return path.
- [x] The response (`POST /lti/deep-link/return`) must be an RS256 JWT signed by a key in the tool's registered JWKS, fetched through the SSRF-safe outbound client and cached for 5 minutes, with one refetch for an unknown `kid`. It must have issuer = client ID, audience = EduOS, a current `iat`/`exp`, a nonce, the right message type, version and deployment, and the exact `data` claim. It's accepted once (`lti_deep_link_returns`), from the same browser, while the teacher can still manage the assignment and the tool is still approved and available.
- [x] Accepted content is limited to LTI resource links on the tool's own host (its registered target link URI): up to 20 per response, with bounded title, text and string `custom` parameters. Other types, other hosts and bad custom values are counted as skipped. Requested line items are ignored, since AGS isn't implemented, and the teacher is told.
- [x] Links are stored in `lti_content_links` (097) under row-level security that reuses `eduos_can_see_assignment` / `eduos_can_manage_assignment`. Students see them on the course page and open them through a normal launch (`contentLinkId`), which sends the link's own `resource_link`, target URL and custom parameters. Only someone who can manage the assignment can remove a link.
- [x] Tests cover forged signatures, another key with the same `kid`, missing browser binding, wrong deployment, replay, off-host URLs, draft assignments, and removal by a student.

### Phase 4 — NRPS
- Implement membership endpoint and OAuth scope enforcement.
- Return only course-scoped members and the minimum role/profile fields.
- Require per-course opt-in and verify teacher/administrator permissions.

### Phase 5 — AGS
- Implement line-item, result, and score services with strict course/resource ownership.
- Require explicit district and course-level grade-write approval.
- Enforce score range/type validation, idempotency, replay protection, audit trails, and grade-change attribution.
- Keep grade writes disabled until independent LTI interoperability and district policy tests pass.

## Acceptance gates

- Protocol conformance tests for LTI 1.3 Core and the enabled Advantage services.
- LTI 1.3 Core, Deep Linking, NRPS, and AGS end-to-end tests against independent reference fixtures and standards-conformant third-party tools for each released phase.
- Negative tests for invalid signatures, wrong issuer/audience/deployment, nonce/state mismatch, replay, expired requests, redirect mismatch, unknown key IDs, revoked tools, disabled scopes, and tenant/course boundary violations.
- Security tests for SSRF, credential leakage, log redaction, rate limits, request-size limits, and durable replay prevention across multiple app instances.
- Authorization tests prove a teacher cannot approve their own connector, one district cannot read another district's courses/rosters/grades, and a tool cannot widen its approved scope.
- Accessibility checks for the administrator setup and learner launch surfaces.
- District-policy review confirms no restricted data or prohibited workflow is enabled.
- CI and all relevant unit, integration, and security checks pass before merge.

## Current limitations

Phase 1 (Core resource-link launch) and Phase 3 (Deep Linking) are implemented and tested against local test tools. Not yet done: NRPS and AGS (Phases 4–5), and interoperability testing against independent, standards-conformant tools and the IMS reference implementation (Phase 2). No claim of OIDC or LTI certification is made. Signing-key overlap is implemented but must be configured and operationally exercised before production use. Those capabilities must ship in separately testable increments behind district-controlled feature flags.

## Signing-key rotation procedure

1. Generate a new RSA private key and set it as `LTI_PLATFORM_PRIVATE_KEY`.
2. Move the former active PEM to `LTI_PLATFORM_PRIVATE_KEY_PREVIOUS` for the overlap period. EduOS signs with the new key and publishes both public keys in JWKS.
3. Set `LTI_PLATFORM_SUBJECT_KEY` to a district-managed random secret of at least 32 bytes. Keep this value unchanged across signing-key rotations; it stabilizes pairwise `sub` values. Protect it like a credential and back it up securely.
4. Allow relying parties to refresh JWKS and retain the previous key for at least the maximum ID-token lifetime plus the JWKS cache lifetime (currently 5 minutes each); verify relying-party key refresh behavior before removing the previous key.
5. Remove `LTI_PLATFORM_PRIVATE_KEY_PREVIOUS` only after the overlap period. Never reuse a retired private key.

Changing the active signing key invalidates outstanding launch hints because their MAC key is derived from the active private key; users must initiate a fresh launch. If no stable subject secret is configured, the implementation falls back to the active-key-derived secret for backward compatibility, so pairwise subjects change on rotation. Production deployments must set and preserve `LTI_PLATFORM_SUBJECT_KEY`.
