# EduOS 33.0.0 — Security & Privacy Baseline

## Scope and evidence

This baseline was prepared against the supplied EduOS 32.32.0 source archive. It is a source-level review, not a penetration test, legal opinion, compliance certification, or production deployment approval. Database-backed tests, cloud configuration review, identity-provider configuration review, and mobile-device testing were not available in this workspace.

## Existing controls confirmed in source

- OIDC authorization-code flow with PKCE S256, nonce, one-time state consumption, browser-bound state cookie, and an allow-listed return path.
- Session cookies are HttpOnly, SameSite=Lax, and Secure when the configured public origin is HTTPS; session tokens are stored as hashes.
- CSRF tokens are bound to the session and mutating routes use CSRF middleware in the inspected core server routes.
- Sessions are database-validated by default on each request; the optional in-process cache defaults off. Session lifetime and idle timeout are bounded.
- `withTenantTransaction` installs district, user, role, and school context with transaction-local PostgreSQL settings.
- The migration runner rejects runtime roles with SUPERUSER or BYPASSRLS and rejects a runtime role that owns the student table.
- Production requires HTTPS for the public origin and OIDC issuer. Production database TLS is required except for an explicitly enabled private-network exception.
- Helmet security headers are installed; JSON request bodies are bounded; selected sensitive endpoints have rate limits.

## Findings and priorities

### High — CSP still permits inline script execution

`src/server.js` explicitly allows `'unsafe-inline'` in `script-src` and script attributes to preserve the legacy UI. This weakens XSS containment. Do not remove the allowance blindly: first migrate inline scripts and event-handler attributes to external modules, then deploy a nonce/hash-based CSP and verify all screens. Track this as a release-blocking security debt before claiming a strict CSP posture.

### High — authorization coverage needs route-by-route verification

The core server uses `requireSession` and `requirePermission` extensively, and modular route registrars add additional APIs. A complete authorization matrix still needs to be generated and exercised against every route, including school scoping, permission grants, guardians, drivers, background jobs, webhooks, and EDEN node routes. Static source checks do not prove the effective middleware chain or database query scope.

### High — database and tenant isolation need live adversarial tests

The source establishes transaction-local tenant context and migration-time runtime-role checks. Production assurance still requires a live PostgreSQL test using the actual non-owner runtime role, `FORCE ROW LEVEL SECURITY`, two districts and multiple schools, including attempts to omit context, spoof IDs, switch memberships, and access rows through joins, exports, and background tasks.

### High — student-record access audit coverage needs a data inventory

The core server includes an `auditRead` helper for FERPA-sensitive reads and append-only audit protections exist in the schema. The review has not proven every student-data read, export, search, report, AI retrieval, attachment, and integration path invokes the correct audit record. Build a field-level data-flow inventory and test coverage for each route and job.

### Medium — AI and external integration governance

External AI is opt-in in the inspected configuration, but district-level provider allowlists, field-level redaction, retention guarantees, prompt-injection boundaries, and human approval requirements need an end-to-end review. Webhook destinations and payload minimization also need deployment-level review.

### Medium — mobile security assurance

Flutter secure storage, offline cache encryption, notification redaction, device revocation, screenshot/privacy behavior, and iOS/Android build attestations remain unverified. Treat the mobile app as a separate security boundary.

## Immediate release gates

1. Remove inline script allowances only after the UI migration and CSP report validation.
2. Produce a complete API authorization matrix and tests for every route.
3. Run cross-tenant and cross-school adversarial tests against PostgreSQL using the production runtime role.
4. Prove complete access/export audit coverage for student records.
5. Complete AI data minimization and third-party processor review.
6. Complete Flutter secure-storage and offline-data review on physical devices.
7. Run dependency, secret, container, SAST, DAST, and penetration testing in CI/staging.

## Compliance boundary

This document is not a FERPA or COPPA certification. District counsel and privacy/security officers must validate applicable legal requirements, contracts, consent practices, retention schedules, vendor controls, and breach response obligations before deployment.
