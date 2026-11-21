# TC-02 — Parent and guardian contributions

## Scope
Parents and guardians with an active, district-scoped relationship may submit a text family-memory contribution for a linked student. Submissions enter a pending moderation queue and are not student-history entries until approved by a principal in the originating school or a superintendent in the district.

## API
- `POST /api/family/children/:studentId/history-contributions` — submit title, body, and occurrence timestamp.
- `GET /api/family/children/:studentId/history-contributions` — list only the caller's contributions for an actively linked child.
- `PATCH /api/family/children/:studentId/history-contributions/:contributionId` — withdraw the caller's pending submission.
- `GET /api/students/:studentId/history-contributions` — school-lead review queue.
- `PATCH /api/students/:studentId/history-contributions/:contributionId` — approve or reject a pending submission.

Every write requires a session and CSRF validation. Guardian links and school/district scope are rechecked inside the transaction. Reviews lock the student and contribution rows, and the decision, resulting history entry, event record, and audit event commit atomically.

## Governance and limits
- Approved contributions become `family_memory` history entries with `family` audience; they do not alter official records.
- Rejected submissions remain auditable and never become history entries.
- Parents cannot approve their own submissions or change a submission after it enters review.
- This phase intentionally accepts text only. Multimedia upload remains unavailable until approved private storage, malware scanning, image processing, and read authorization providers are configured and exposed through a complete fail-closed workflow.
- Donations do not increase storage quotas, bypass moderation, change access, or unlock features. Per-student storage and media limits remain district policy and are not modified by this phase.
