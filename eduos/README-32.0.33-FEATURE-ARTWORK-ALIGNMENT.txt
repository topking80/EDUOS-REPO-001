EduOS District Edition 32.0.33 — Feature & Artwork Alignment

This release reconciles the Parent / Guardian portal with the existing EduOS persona architecture and visual system.

Changes:
- Parent portal navigation is restricted to the Parent / Guardian workspace, not Teacher.
- Authenticated parent sessions now use the server family endpoints to list verified linked learners and retrieve an individual learner summary.
- Synthetic family demo data remains clearly separate from authenticated family data.
- Added original `eduos-family-portal-flow.svg` artwork in the established EduOS navy, blue, teal and amber palette.
- Added product consistency tests and corrected the release title / package-lock metadata.
- Preserved the existing Superintendent, Principal, Teacher, Parent / Guardian, Pupil / Student and four AI-agent identities.

Run:
  npm ci
  npm test
  npm start

See AUDIT-32.0.33-FEATURE-ARTWORK-CONSISTENCY.md for the persona-to-feature/artwork map and remaining integration gaps.

This is a source-code consistency release. Live OIDC, PostgreSQL, SIS synchronization, messaging delivery and emergency-plan validation must still be tested/configured in the target district environment.
