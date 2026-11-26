# TC-02 — Parent and guardian contributions

## Scope
Parents and guardians with an active, district-scoped relationship may submit a text family-memory contribution for a linked student. Submissions enter a pending moderation queue and are not student-history entries until approved by a principal in the originating school or a superintendent in the district.

## Family portal
The Family view includes a per-child Family memories panel. Guardians can submit a title, optional text, and occurrence date, see the status and any school review note, and withdraw their own pending submission. The panel never exposes another guardian's submission.

## School review experience
Principals and superintendents have a Family history review screen showing pending submissions within their RLS-enforced school or district scope. Reviewers can approve or reject a submission with an optional family-facing note; each decision is audited.

## API
- `GET /api/history-contributions` — pending review queue for authorized school/district leads.
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
- Text contributions, family photos, and district-opt-in UTF-8 plain-text `.txt` documents are implemented. Guardian photos and documents require configured private S3-compatible storage, ClamAV, and superintendent district-policy enablement before use. Photos are re-encoded and metadata-stripped; `.txt` files are scanned and downloaded as attachments, never rendered inline. PDF/DOCX, HTML, archives, executables, and video remain unsupported. See `MEDIA-STORAGE.md` for the enforced formats, limits, and lifecycle.
- Donations do not increase storage quotas, bypass moderation, change access, or unlock features. Per-student storage and media limits remain district policy and are not modified by this phase.
