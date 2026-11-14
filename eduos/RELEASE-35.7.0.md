# EduOS 35.8.0 — Library Assistant & District Resource Network

Adds multi-source library catalogue import, school/district inventory summaries, and cross-school resource request workflows. See `LIBRARY-ASSISTANT-35.8.0.md` for API contracts, supported field mapping, boundaries, and deployment.

Migration: `022_library_services.sql` (registered in `src/migrate.js`). Runtime grants added to `db/runtime_grants.template.sql`.

Focused verification: 14 tests passed; JavaScript syntax checks passed across the repository. Live PostgreSQL/RLS migration, catalogue vendor export conformance, and browser E2E were not run. Vendor platform APIs are not directly connected in this release; imports accept normalized exported records.
