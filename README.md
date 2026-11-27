# EDUOS-REPO-001

EduOS is a school platform for public school districts, homeschool families and independent private
schools. Everything that runs is in [`eduos/`](eduos/); its [README](eduos/README.md) says what it does,
how to run it and how to test it.

## Where things are

| Path | What it is |
|---|---|
| [`eduos/src/`](eduos/src/) | The API server (Node.js 22, Express 5) |
| [`eduos/db/`](eduos/db/) | PostgreSQL migrations (`NNN_*.sql`) and the runtime role's grants |
| [`eduos/public/`](eduos/public/) | The web app and the installable phone app at `/app/` |
| [`eduos/mobile/flutter/`](eduos/mobile/flutter/) | The native mobile and desktop app (Flutter) |
| [`eduos/clients/roku/`](eduos/clients/roku/) | The Roku channel (families view Time Capsules on a TV) |
| [`eduos/src/master-control/`](eduos/src/master-control/) | Master Control, the federation's control plane |
| [`eduos/deploy/school-node/`](eduos/deploy/school-node/) | The school node (local-first EDEN) install |
| [`eduos/docs/`](eduos/docs/) | Feature, operations and product documentation |
| [`docs/`](docs/) | Federation architecture, the Time Capsule roadmap and threat model |

The `AUDIT-37.4.0*.md` files, `IMPORT_INSTRUCTIONS_37.4.0.md` and the two `.zip` archives at the top level
are historical import material from release 37.4.0, kept for reference.

## Working on it

- **Changes go through pull requests** to `main`, one item per PR. `main` doesn't accept force-pushes or
  deletions.
- **Required checks:** `unit`, `integration`, `e2e`, `edge`, `flutter-mobile`, `dependency-security`,
  `source-and-container-security` and `prometheus-rules`, plus CodeQL code scanning. CI is in
  [`.github/workflows/`](.github/workflows/).
- **Database rules for every feature:** forced row-level security, a non-owner runtime role and least-privilege
  grants. Tests run against real PostgreSQL as that role. The checklist is
  [`eduos/docs/security/district-governance-feature-acceptance.md`](eduos/docs/security/district-governance-feature-acceptance.md).
- **Governance rules every change keeps:**
  - no vendor gets unrestricted student-data access;
  - no external grade changes without district authorization;
  - no weakening of row-level security or school boundaries;
  - no automatic student transfers;
  - no unapproved third-party data sharing;
  - no compliance claims without documented evidence and review.
