# Student History & Time Capsule — PR Feature Roadmap

**Feature branch:** `feature/student-history-time-capsule`  
**Target:** `main`  
**Status:** Updated against merged PRs through 2026-11-23 (latest review includes PR #134). See the implementation status register below; a merged PR is not treated as full completion when its body explicitly leaves roadmap scope outstanding.

## Implementation status register

| Workstream | Status | Evidence and remaining scope |
|---|---|---|
| TC-01 — data model | **Complete** | #89 merged the mainline persistence foundation: history entries, revisions, attachments, capsule persistence, forced RLS and constrained grants. |
| TC-02 — guardian contributions | **Partial** | #90 merged text-only moderated contributions. Multimedia uploads remain blocked pending production storage, malware scanning, image processing and authorization providers. |
| TC-03 — teacher contributions | **Partial** | #93 merged school review and family approval, decision history and screens. Contributions are text-only; multimedia remains outstanding. |
| TC-04 — portfolio/timeline | **Partial** | #94 merged the student/family portfolio, filters and pagination. Media previews and multimedia timeline remain outstanding. |
| TC-05 — privacy and sharing | **Partial — substantially advanced** | #91 merged database-enforced relationship/audience privacy; #134 added custody restrictions, adult-student rights transitions, time-limited read-only guardian sharing grants, emergency access with review, access logs, and a documented threat model with unit/integration/browser checks. Safe export controls and any remaining roadmap privacy/release gates still need explicit verification before marking complete. |
| TC-06 — lifelong access and transfer | **Not started / no merged PR found** | No merged implementation for cross-district transfer packages, receiving-district acceptance or lifelong continuity was found in the reviewed PR history. |
| TC-07 — milestone releases | **Partial** | #96 merged capsule creation/sealing/consent/date-or-milestone release. Its PR explicitly leaves notifications, legal holds, export, photos/video and student/teacher capsule-creation screens outstanding. 37.8.0 (`tc/08-archival-storage`): legal holds now block release. |
| TC-08 — archival storage/capacity | **Partial — 37.8.0 branch `tc/08-archival-storage-v2`** | History photo rows readable by the runtime role only through checked functions (PR #71 finding 4), checksums on upload, scheduled integrity verification with superintendent alerts and recovery logging, in-place move to an instant-read archive class (re-verified), legal holds (block deletion, photo release and capsule release), per-school capacity reporting without names, restore-drill procedure (`eduos/docs/HISTORY-PRESERVATION.md`). Atomic quotas were already on main (MEDIA-01). Remaining: retention-period review/deletion workflow (needs the district's records-schedule decisions), deduplication, video/documents. |
| TC-09 — voluntary donations | **Not started / no merged PR found** | No merged donation collection/payment-provider workflow found. |
| TC-10 — donation accounting | **Not started / no merged PR found** | No merged append-only donation ledger, reconciliation or receipt workflow found. |
| TC-11 — family storage dashboard | **Partial — 37.8.0 branch `tc/11-family-storage-dashboard`** | Student and linked-guardian view (custody restrictions and a student holding their own rights respected) of the district's photo limit, real usage, items by status, the guardian's own contributions, capsules, the records schedule and the export link, with plain guidance. Says donations never change storage. Web only; donation history waits for TC-09/TC-10; Flutter screen not built. |
| TC-12 — district preservation fund | **Not started / no merged PR found** | No merged district fund governance, disbursement or reporting workflow found. |

**Latest change since the prior review:** PR #134 (`TC-05: Time Capsule privacy controls`) merged on 2026-11-23. It closes major custody, adult-student transition, controlled-sharing, emergency-access, access-log and threat-model gaps. TC-05 remains partial until safe export and all remaining acceptance criteria are verified.

**Important validation boundary:** the PR history establishes merged code, not production readiness. The merged contribution PRs state that media providers are not configured; #96 lists its deferred lifecycle features. District policy, legal/records review, production storage/scanning setup and operational verification remain release gates.

## Product intent

Provide a durable, permission-governed student history that can preserve selected school records, family contributions, teacher-approved artifacts, and a student portfolio across school years, graduation, and eligible school transfers. Families may voluntarily support preservation costs, while districts retain control of educational records, retention, access, and per-student storage policy.

## Non-negotiable product and governance rules

- **District policy controls capacity.** Districts configure per-student limits for media size/type, media counts, document counts, total storage, retention, and permitted formats. These limits are independent of donations.
- **Donations never buy storage or privileges.** A contribution cannot increase a student's quota, bypass moderation, alter access, accelerate release, or affect educational services.
- **Voluntary and non-coercive.** No student or family is required to donate. No donor leaderboard, public donor status, or student-facing fundraising pressure.
- **Separate educational records from family memories.** Classify official records, teacher-created artifacts, family-submitted items, and student portfolio content separately, with distinct ownership, retention, export, and deletion rules.
- **Least-privilege access.** Enforce district, school, class, student, guardian, teacher, records-staff, and finance permissions server-side. Never rely on UI hiding as authorization.
- **Consent and custody are explicit.** Verify guardian relationships and authority; support custody restrictions, revoked consent, student age/rights transitions, and district-defined rules.
- **Audit sensitive actions.** Record access grants, approvals, denials, exports, releases, retention changes, deletion, and financial ledger events in tamper-evident audit history.
- **District rules prevail.** Legal holds, records schedules, public-records obligations, student privacy laws, and district transfer/retention rules must be honored. Do not promise perpetual retention where policy or law prohibits it.
- **Secure media lifecycle.** Use private object storage, short-lived authorized access, malware/content validation, metadata minimization, encryption, lifecycle policies, and recoverable deletion where required.
- **Finance is segregated.** Donation processing and accounting must not expose educational records to finance roles or allow finance actions to modify student records.

## PR sequence

### TC-01 — Student history and Time Capsule data model
**Goal:** Establish the canonical, tenant-scoped data model and migration foundation.

Scope:
- Model student history containers, timeline entries, artifact metadata, artifact classifications, source/provenance, school-year associations, retention state, and storage accounting.
- Link records to stable internal student identities while preserving district/tenant boundaries and source-system identifiers only where needed.
- Define lifecycle states (draft, submitted, approved, published, restricted, archived, pending deletion, deleted) and immutable provenance/audit references.
- Add migrations, indexes, constraints, tenant-aware access patterns, and seed/test fixtures.
- Keep binary media in object storage; database stores metadata and opaque object references only.

Acceptance:
- Migrations are reversible or have documented safe-forward recovery.
- Cross-tenant references and invalid lifecycle transitions are rejected.
- Database constraints enforce required ownership, classification, and provenance.
- Tests cover tenant isolation, duplicate/idempotent creation, and lifecycle transitions.

Dependencies: None. This is the foundation for TC-02 through TC-12.

### TC-02 — Parent and guardian contributions
**Goal:** Allow authorized guardians to submit family memories and approved supporting materials.

Scope:
- Verify guardian relationship and authority before submission.
- Support text, documents, photos, and permitted video metadata/upload flows.
- Capture submitter, relationship, consent, date/context, visibility preference, and provenance.
- Enforce district file-type, size, count, quota, and retention rules before accepting uploads.
- Provide submission status and withdrawal requests subject to records/legal retention rules.

Acceptance:
- Unauthorized, unverified, or restricted guardians cannot submit or view student content.
- Upload validation is server-side and uses safe signed upload/download flows.
- Contributions enter a review state and are not automatically published.
- Duplicate requests and upload retries are idempotent.

Dependencies: TC-01.

### TC-03 — Teacher contributions and approvals
**Goal:** Enable staff to add school artifacts with controlled review and publication.

Scope:
- Teacher submissions tied to authorized school/class/student assignments.
- Approval queues and configurable approver roles; separation of submitter and approver where policy requires.
- Review, reject, request changes, redact, restrict, and publish actions with reason codes.
- Record academic context and provenance without creating an unofficial gradebook or replacing SIS records.
- Escalation and reassignment for staff departure or role changes.

Acceptance:
- Teachers can contribute only for students within their authorized scope.
- Self-approval is prevented when required by district policy.
- Every decision is auditable and publication is permission-checked.
- Official record designation is restricted to authorized records personnel and approved workflows.

Dependencies: TC-01; TC-05 authorization contracts must be applied.

### TC-04 — Student portfolio and multimedia timeline
**Goal:** Present approved student history as an accessible, chronological portfolio.

Scope:
- Timeline grouped by school year, milestone, and artifact type.
- Responsive media/document previews, captions, dates, source attribution, and accessibility metadata.
- Student-facing and family-facing views filtered by audience permissions.
- Search/filter and pagination that respect tenant and record-level permissions.
- Accessible controls, keyboard navigation, captions/transcripts where available, and reduced-motion support.

Acceptance:
- Only approved and authorized artifacts appear.
- Private/restricted items are not exposed through search, APIs, thumbnails, or cached responses.
- Timeline is usable on mobile and with assistive technology.
- Large histories are paginated and do not load all media eagerly.

Dependencies: TC-01, TC-02, TC-03, TC-05.

### TC-05 — Privacy, permissions, and sharing
**Goal:** Implement the security and privacy control plane for the entire feature.

Scope:
- Role/relationship-based authorization combining tenant, school, student, record classification, guardian authority, and consent.
- Explicit sharing grants with audience, scope, expiry, revocation, and audit history.
- Custody restrictions, disputed guardianship, student rights transitions, staff offboarding, and emergency access procedures.
- Safe export and access logging; no public-by-default links.
- Data minimization, encryption, retention/deletion controls, and privacy review for analytics/telemetry.
- Threat model and tests for IDOR/BOLA, privilege escalation, cross-tenant access, signed URL leakage, cache poisoning, and bulk export abuse.

Acceptance:
- Deny-by-default authorization is enforced at every API/storage boundary.
- Revocation takes effect promptly, including for previously issued access paths to the extent technically controllable.
- Automated tests prove cross-tenant and cross-student access is denied.
- Security review documents residual risks and operational controls.

Dependencies: TC-01. This PR is a release gate for all externally accessible contribution, timeline, sharing, and export features.

### TC-06 — Lifelong access and school-transfer continuity
**Goal:** Preserve eligible history across school transitions without bypassing district authority.

Scope:
- Stable student identity resolution and duplicate/merge review workflow.
- Transfer packages containing only eligible records and artifacts, with provenance and consent/authority checks.
- Receiving-district acceptance and mapping; maintain source district ownership and record-origin metadata.
- Family continuity view for records the family is authorized to retain/access.
- Handle district departure, school closure, student identity conflicts, and unsupported receiving systems.

Acceptance:
- No cross-district disclosure occurs without a valid transfer basis and required authorization.
- Source and destination district policies are respected; records are not silently reclassified.
- Transfer is idempotent, auditable, and supports reconciliation of rejected/partial items.
- Family access does not imply ownership or override official-record retention restrictions.

Dependencies: TC-01, TC-05.

### TC-07 — Graduation and milestone releases
**Goal:** Release eligible artifacts at configured milestones under district policy and consent.

Scope:
- Configurable events such as grade transitions, graduation, and district-defined milestones.
- Release eligibility rules by artifact classification, consent, legal hold, retention status, and audience.
- Preview/notification, scheduled release, cancellation, and manual records-office review.
- Family/student export options for eligible content with audit receipts.

Acceptance:
- No release occurs solely because a date or milestone is reached when required approvals/consents are absent.
- Legal holds and restricted records block release.
- Release jobs are idempotent, observable, and auditable.
- District policy can disable or narrow milestone releases.

Dependencies: TC-01, TC-05, TC-06.

### TC-08 — Archival storage and capacity optimization
**Goal:** Reduce long-term preservation cost while protecting integrity and recoverability.

Scope:
- District-defined per-student capacity and media/document limits; quotas are enforced independently of donation status.
- Tiered storage lifecycle, deduplication where legally and technically safe, compression/transcoding, checksums, and integrity verification.
- Retention schedules, legal holds, deletion workflows, restore procedures, and backup/replication policy.
- Capacity reporting and alerts for district administrators; avoid exposing other students' data.
- No automatic quality reduction or deletion without district policy and required notice/approval.

Acceptance:
- Quotas are checked atomically to prevent concurrent-upload overrun.
- Storage transitions preserve checksums, provenance, permissions, and retrieval.
- Restore drills and integrity tests are documented.
- Donations cannot change quota, retention, media limits, or service priority.

Dependencies: TC-01, TC-05. Coordinate with infrastructure/storage owners before production rollout.

### TC-09 — Voluntary family donations and recurring contributions
**Goal:** Offer an optional way for families/community supporters to contribute to preservation costs.

Scope:
- Clear voluntary donation flow with one-time and recurring options where supported.
- Plain-language purpose, recipient/fund designation, cancellation, refund/contact information, and fee disclosure.
- No donation prompts tied to student grades, access, teacher decisions, or required school interactions.
- Secure payment-provider integration using tokenized provider flows; do not store card/bank credentials.
- Donor identity and payment data segregated from student portfolio access.

Acceptance:
- Core student history functionality remains available without donating.
- Donation amount/status cannot affect student storage quota or access.
- Recurring authorization, cancellation, failed payment, refund, and webhook replay are handled safely.
- No payment details are stored in EDUOS application tables beyond provider references and necessary accounting metadata.

Dependencies: TC-01; coordinate TC-10 and TC-12 before enabling collection.

### TC-10 — Donation accounting, receipts, and transparency
**Goal:** Provide auditable financial records and clear use-of-funds reporting.

Scope:
- Append-only donation ledger with provider transaction references, gross amount, fees, net amount, currency, fund designation, refund/chargeback status, and timestamps.
- Receipts and donor history with privacy-conscious delivery.
- Reconciliation against payment provider reports; idempotent webhook processing and exception queue.
- Role separation for finance staff; no access to student artifacts unless separately authorized for a legitimate purpose.
- Public/district-level aggregate reporting with privacy thresholds; no student-level donor disclosure.

Acceptance:
- Ledger balances reconcile to provider settlements and refunds.
- Duplicate/out-of-order webhooks do not duplicate financial entries.
- Corrections use compensating entries, not destructive edits.
- Receipts and reports clearly distinguish donations from fees and avoid unsupported tax-deductibility claims.

Dependencies: TC-09, TC-12.

### TC-11 — Family storage dashboard
**Goal:** Explain preservation status and district-set capacity to families without selling quota upgrades.

Scope:
- Show student storage usage, permitted media/document limits, accepted/pending/rejected items, and retention/release status.
- Explain district-defined limits and provide guidance for supported formats/size reduction.
- Show donation history separately from storage usage and explicitly state that donations do not increase storage.
- Offer family export/access tools only for eligible records.

Acceptance:
- Usage reflects authoritative server accounting and updates safely after uploads/deletions/transcodes.
- Dashboard does not offer paid quota upgrades or imply donations change limits.
- Families see only students for whom they have current authorization.
- No sensitive internal storage paths or other students' usage is exposed.

Dependencies: TC-01, TC-02, TC-05, TC-08; donation history integration after TC-09/TC-10.

### TC-12 — District community preservation fund
**Goal:** Govern pooled voluntary contributions for district-wide preservation costs.

Scope:
- District-configured fund purpose, eligible expenses, allocation rules, approval thresholds, and governance disclosures.
- Separate fund ledger/accounting dimensions from individual family donations and student records.
- Budget, disbursement, balance, and aggregate impact reporting with audit trail.
- Conflict-of-interest controls, restricted fund handling, refund/return policy, and periodic reconciliation.
- District-level controls to pause collection or disbursement.

Acceptance:
- Funds cannot be allocated to purchase individual student quota or preferential access.
- Disbursements require authorized approvals and are traceable to documented eligible expenses.
- Financial reporting is transparent while protecting donor and student privacy.
- Collection remains disabled until legal, finance, and district governance approvals are documented.

Dependencies: TC-09, TC-10; TC-08 provides the preservation-cost model.

## Suggested delivery gates

1. **Foundation:** TC-01.
2. **Controlled contributions:** TC-02 and TC-03, with TC-05 authorization requirements implemented before exposure.
3. **Experience:** TC-04.
4. **Continuity and release:** TC-06 and TC-07.
5. **Preservation operations:** TC-08.
6. **Financial safeguards:** TC-09 and TC-10.
7. **Family transparency and district governance:** TC-11 and TC-12.

The sequence is a dependency guide, not permission to defer security. TC-05's deny-by-default controls and threat-model requirements must be built into earlier PRs and completed before any production exposure.

## Definition of done for every implementation PR

- Tests cover success, failure, authorization boundaries, tenant isolation, retries/idempotency, and relevant lifecycle edges.
- Database migrations and rollback/recovery notes are included.
- API contracts, permissions, retention behavior, and operational configuration are documented.
- No secrets, payment credentials, or student media are logged.
- CI, lint, type checks, relevant integration tests, and security scans pass; failures are investigated and fixed rather than waived.
- Changes are reviewed against district policy and applicable student-record/privacy obligations before release.
