# Timeline & Time Capsule — Implementation Plan

> **Superseded data model (2026-11-21).** The `timeline_entries` tables described below were retired in `eduos/db/089_retire_timeline_entries.sql`. Student history and Time Capsules use `student_history_entries` and the `student_time_capsule*` tables (`086`), with relationship-based privacy enforced in the database (`088`). See `docs/STUDENT-HISTORY-TIME-CAPSULE-PR-ROADMAP.md`.

## Purpose
Add a permission-aware learner timeline and scheduled Time Capsule experience to EduOS. The timeline records meaningful learning milestones; capsules package selected memories for release to named recipients at a future date or supported milestone.

## Product behavior

### Timeline
- Chronological, cursor-paginated entries with filters for learner, school year, term, course, activity, and entry type.
- Entry types: achievement, project, coursework, reflection, event, portfolio artifact, educator note, and system milestone.
- Store occurred_at separately from created_at; retain author/source attribution and revision metadata.
- Visibility is explicit and defaults to the narrowest permitted audience.
- Attachments must use the platform's existing secure file-storage and malware-scanning pipeline.
- Edits are auditable; deletion follows applicable retention/records policy.

### Time Capsules
- Draft creation supports title, message, selected timeline items/attachments, recipients, and release_at or a supported milestone.
- Lifecycle: draft -> sealed -> scheduled -> released; cancellation is allowed only before release and is audited.
- Sealing snapshots the selected content references and locks recipient/content changes for ordinary users.
- A trusted server-side worker releases due capsules; client clocks and client-supplied state are never authoritative.
- Release is idempotent and re-checks recipient identity, tenant membership, relationship, consent, and current authorization.
- Notification delivery happens after release and cannot roll back a successful release.
- Private self-addressed, family, classroom, and school use cases require explicit audience selection and policy checks.

## Security and privacy
- Enforce tenant, school, classroom, learner, and guardian relationship boundaries server-side for every operation.
- Deny by default. Never trust client-supplied tenant_id, owner_id, role, author_id, recipient authorization, visibility, or lifecycle state.
- Prevent IDOR by performing scoped lookup and authorization together.
- Guardians require a currently verified relationship and applicable consent; educators require active assignment and permitted data scope.
- District/school administration does not imply access to private reflections or personal capsules.
- Apply RLS to every tenant-owned table and test SELECT/INSERT/UPDATE/DELETE and join paths, including attachment metadata.
- Background workers use narrowly scoped service credentials, re-check authorization, and write auditable lifecycle events.
- Signed attachment URLs must be short-lived, audience-scoped, and issued only after authorization.
- Rate-limit entry/capsule creation, sharing, and lifecycle actions. Avoid existence leaks for inaccessible records.
- Audit sensitive access and lifecycle transitions without logging private content.
- Confirm jurisdiction-specific student privacy, retention, records-request, and deletion requirements before production release.

## Proposed logical data model
Adapt names/types to the existing schema rather than introducing a parallel identity or tenancy model:
- timeline_entries: tenant/school/learner scope, type, title/body, occurred_at, author/source, visibility, status, timestamps.
- timeline_entry_revisions: immutable revision snapshots and actor/time metadata.
- timeline_entry_attachments: storage reference, MIME/size, scan state, ownership.
- time_capsules: tenant/owner, title/message, lifecycle state, release target, sealed/released/cancelled timestamps.
- time_capsule_items: ordered references to timeline entries and attachments, with snapshot policy.
- time_capsule_recipients: explicit recipient identity/type and consent/eligibility metadata.
- time_capsule_events: append-only lifecycle audit events with non-sensitive metadata.

Use foreign keys and tenant-aware constraints; index learner/time queries and due capsules by state + release_at. Do not store duplicate identity, role, or membership authorities.

## API and worker contract
Follow existing route, validation, authentication, and error conventions:
- Read timeline with cursor pagination and explicit learner/context scope.
- Create/update/delete entries only after server-side actor scope validation.
- Create capsule draft; seal only after validating items, recipients, consent, and release target.
- Cancel only a not-yet-released capsule with an authorized actor.
- Read capsule content only after current authorization and release eligibility checks.
- Worker claims due capsules with a transactional lease/lock, re-checks authorization and consent, performs one idempotent release transition, and enqueues notifications.

## Reliability
- Use UTC for storage; interpret user-entered local release dates using an explicit IANA timezone.
- Handle daylight-saving transitions and invalid/past release targets.
- Use a unique release event/idempotency key and safe retry behavior for concurrent workers.
- Track due backlog, release latency, retries, failures, and notification delivery without private payloads.
- Notification failures are retried independently from release.

## Acceptance and security tests
- Role matrix: learner, guardian, teacher, school admin, district admin, and cross-tenant user.
- RLS coverage for reads, writes, joins, revisions, attachments, and worker/service paths.
- Negative tests for forged tenant/owner/recipient/visibility/state fields, IDOR, revoked guardian relationship, removed educator assignment, and unauthorized attachment downloads.
- State-machine tests for invalid transitions, cancellation races, concurrent claims, duplicate worker delivery, and retry after partial failure.
- Timezone/DST boundary tests and release-time authorization changes.
- Pagination, optimistic concurrency, rate-limit, audit-log redaction, and notification retry tests.
- Accessibility: keyboard and screen-reader navigation, contrast, reduced motion, and responsive layouts.

## Implementation sequence
1. Inspect this repository's real app tree, identity/tenant model, migrations/RLS, file storage, jobs, and notifications.
2. Implement schema and deny-by-default policies with negative tests first.
3. Implement timeline service/API/UI.
4. Implement capsule state machine and idempotent release worker.
5. Integrate notifications, accessibility, observability, and retention controls.
6. Run the full repository CI/security suite; document any unverified checks and residual risks.

## Scope note
This document is a design/implementation foundation, not a claim that runtime code or tests are complete. Implementation must conform to the actual repository architecture and must not guess framework or schema conventions.
