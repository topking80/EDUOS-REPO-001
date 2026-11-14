EduOS District Edition 32.0.10 — OIDC Session and Login Hardening

This release builds on 32.0.9 and focuses on the existing OIDC sign-in/session
boundary. It does not add product modules or change district workflows.

Changes
- OIDC browser-binding cookies are now unique per authorization attempt. The
  cookie name is derived from a truncated SHA-256 digest of state, while the
  cookie value remains the state token. Parallel login attempts in separate
  tabs no longer overwrite one shared state cookie.
- Callback processing reads and clears only the matching per-attempt cookie.
- Pending in-memory OIDC transactions are pruned when expired and bounded to
  1,000 entries to limit memory growth during bursts or abuse.
- Callback state is consumed before validation, preserving single-use behavior;
  oversized state values are rejected.
- ID-token authorized-party (`azp`) rules are checked after JWT verification:
  multiple audiences require `azp` to match this client, and any supplied `azp`
  must match even for a single audience.
- Package and lockfile versions are aligned at 32.0.10.

Operational note
The in-memory pending OIDC map remains process-local. Multi-instance deployments
still require shared transaction storage (for example Redis) or sticky routing;
this release bounds memory but does not make login transactions cross-instance.

Validation
See docs/VALIDATION-32.0.10.md. Automated source/behavior tests and syntax
checks are recorded there with their dependency limitations. Live PostgreSQL,
OIDC provider, multi-instance, and browser end-to-end validation remain required.

This is a development security-hardening release, not a production certification.
