EduOS District Edition — Phase 32.0 Integrated

This release builds on the Phase 31.1 integrated archive and adds the first server-backed Student 360 and intervention-case workflow.

Included:
- Phase 31.1 district UI and standalone demo snapshot
- Existing OIDC/session, CSRF, district API, assignments, attendance, audit, and access-grant foundation
- Migration 004: district-scoped intervention cases and append-only case notes
- Student 360 API read model (profile + attendance + academics + visible cases + timeline)
- Case list/create/update/append-note APIs with role checks and audit records
- Connected Services UI for Student 360 and Intervention Cases

Setup:
1. Use Node.js 22 or later.
2. Copy .env.example to .env and configure PostgreSQL, OIDC issuer/client settings, and session secrets.
3. Create a dedicated runtime DB role that does not own tenant tables and does not have BYPASSRLS.
4. Apply the ordered migrations with `npm run db:migrate` using a migration-capable database role.
5. Apply `db/runtime_grants.template.sql` after substituting the intended runtime role.
6. Run `npm install`, `npm test`, then `npm start`.

Validation limits:
- Automated tests and JavaScript syntax checks are run for this archive.
- No live PostgreSQL migration, live OIDC sign-in, or browser end-to-end test is claimed.
- Teacher access is currently scoped to the teacher's school because the schema does not yet contain teacher course/roster assignments. Add roster-level authorization before production use with sensitive case data.
- Synthetic localStorage demo data is not synchronized with authenticated PostgreSQL records.
- This is not a certification or legal compliance determination.
