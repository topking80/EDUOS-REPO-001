# Timeline & Time Capsule Runtime — Pre-Implementation Security Gate

**Baseline:** `main` at `f11d119aed96453d18b953f88e1a0edac7af9e82` (37.7.2 package version; 72 numbered migrations through `072_notification_backlog_metrics_grant.sql`).
**Related design:** PR #67 (`docs/features/timeline-time-capsule.md`), still draft and unmerged.
**Disposition:** HOLD runtime implementation until the authorization, consent, media, worker, and test contracts below are implemented and verified. This is an audit artifact only; it adds no runtime behavior.

## Confirmed repository architecture

- Node 22+ / Express 5 / PostgreSQL; ESM modules under `eduos/src`.
- Route modules are registered from `eduos/src/server.js`; learning routes use `requireSession`, CSRF protection for writes, `withTenantTransaction`, and shared role helpers.
- Tenant context is transaction-local: district, user, role, school. Runtime startup rejects superuser, BYPASSRLS, and schema-object ownership.
- Migrations are in `eduos/db/`; runtime grants are explicit in `eduos/db/runtime_grants.template.sql`.
- Existing learning RLS helpers include `eduos_can_see_learning(school_id, student_id)`, `eduos_learning_staff(school_id, student_id)`, and `eduos_is_linked_student(student_id)`. Parent/guardian relationship checks use active `student_user_links` rows.
- Private media registry exists in migration 054 and is accessed by `src/media-object-registry.js`; media consent history in migrations 053/057 is specifically tied to activity media participants, not a general timeline consent authority.

## Findings that block a safe runtime implementation

### 1. Existing learning visibility is too broad for personal timeline content

`eduos_can_see_learning` intentionally supports academic learning records and includes school staff scope plus active linked-family/learner scope. It is not an appropriate default policy for private reflections, family memories, educator notes, or sealed capsules. Reusing it wholesale would silently grant broader access than the product design promises.

**Required:** timeline-specific, deny-by-default audience rules. Private learner reflections must not become visible to teachers, principals, district administrators, or other guardians merely because they can see academic records. Classroom/school audiences must be explicit and scoped to active assignments or memberships.

### 2. Guardian access must be re-evaluated at every access point

The current relationship model is `student_user_links` with active/disabled status and parent/guardian relationship values. The learning service correctly queries active links for parent access. A new timeline feature must do the same on every list, detail, attachment, capsule-read, and release operation—not rely on authorization captured when a capsule was created or sealed.

**Required:** revocation tests proving a disabled relationship immediately blocks access to entries, media, capsule contents, and queued notifications. No cached recipient grants.

### 3. Existing media consent is not a reusable general timeline-consent model

Migrations 053 and 057 record guardian decisions for activity-media participants. That model is tied to activity media asset participants and does not express timeline entry audience, learner reflections, capsule recipients, or consent withdrawal semantics for those content types.

**Required:** define a separate timeline/media purpose and consent model before linking private media. Every attachment must reference the private object registry, and access must require clean scan + processed state + current authorization + current consent. Never expose `storage_key` or a public object URL.

### 4. Private media registry RLS is tenant-only

Migration 054 enables and forces RLS on `private_media_objects`, but its policy checks only `district_id`. The helper module adds a school-scope check before querying, and the runtime grant is explicit; nevertheless, the database policy itself does not independently constrain school scope. This is a pre-existing defense-in-depth limitation, not evidence of a current exploit.

**Required:** timeline attachment authorization must join to a timeline-scoped attachment relation and current recipient policy; add school-scope database enforcement or prove an equally strong database-side guard. Test same-district cross-school access through direct SQL as the non-owner runtime role.

### 5. No Timeline/Time Capsule runtime or release worker was found

The current route tree has learning APIs, but no timeline route module, capsule state machine, due-capsule worker, or timeline-specific notification outbox was identified in the inspected main tree.

**Required:** implement a transactional claim/lease worker, unique idempotency key, state transition audit, bounded retry, and separate notification delivery. The worker must re-check membership, relationship, consent, content eligibility, and recipient eligibility immediately before release. A notification failure must not undo a successful release.

### 6. Time and lifecycle semantics need database enforcement

The design calls for UTC storage, explicit IANA timezone interpretation, sealed immutable content/recipients, cancellation only before release, and safe concurrent worker behavior.

**Required:** database constraints and transactional state transitions must prevent edits after sealing, premature reads, post-release cancellation, duplicate release, and recipient/content mutation. Validate nonexistent and ambiguous local times at DST transitions; do not trust client clocks.

### 7. Runtime grants must be added with the migration

The runtime grant template is explicit and re-applied after migrations. A new table without corresponding grants will fail at runtime; overly broad grants would undermine append-only and privacy requirements.

**Required:** table-by-table SELECT/INSERT/UPDATE/DELETE grants, no direct mutation of immutable revisions/events, no public EXECUTE on SECURITY DEFINER helpers, and startup checks under the actual non-owner runtime role.

## Implementation sequence (gated)

1. **Authorization model:** document and implement timeline-specific audience rules and current relationship/assignment checks. Add database helpers with fixed search paths and no caller-controlled identity.
2. **Schema/RLS:** tenant + school + learner composite keys; ENABLE and FORCE RLS; restrictive read/write policies; immutable revision/event tables; safe retention/deletion model.
3. **Timeline API:** scoped learner resolution; cursor pagination; create/edit/correct/archive; private default visibility; audit metadata only (never private body text).
4. **Media:** consent-purpose records; private registry references; scan/processing gates; signed short-lived audience-authorized delivery only.
5. **Capsule state machine:** draft → sealed → scheduled → released, with pre-release cancellation; immutable sealed snapshot; transactional due claim and idempotent release.
6. **Notifications:** post-release outbox, generic external-channel content, retries independent of release.
7. **Tests and evidence:** unit tests plus real PostgreSQL integration as the non-owner runtime role; CI run evidence attached before marking the PR ready.

## Mandatory negative test matrix

- Parent/guardian with no active relationship; relationship disabled after capsule sealing; relationship disabled during worker lease.
- Pupil/guardian/staff cross-district and same-district cross-school IDOR attempts.
- Teacher with no active roster/course assignment; assignment removed after entry creation.
- Principal/superintendent attempting to read private reflection or self-addressed capsule.
- Forged district, school, student, author, visibility, owner, recipient, release state, timestamps, and media IDs.
- Pending, blocked, failed, or unprocessed media; consent denied/withdrawn after sealing; direct storage-key leakage.
- Capsule detail/list before release; concurrent workers; crash after transition but before notification; duplicate retry; cancellation/release race.
- DST spring-forward nonexistent time, fall-back ambiguous time, past release time, UTC/local date rollover.
- Student transfer, archive, deletion/retention purge, legal hold, correction/revision history.
- Direct SQL SELECT/INSERT/UPDATE/DELETE as runtime role; RLS FORCE and grants; no owner/BYPASSRLS execution path.

## Verification status

- Source inspection: completed for the design PR, learning route/service patterns, learning RLS helpers, guardian-link schema, media registry, activity media consent migrations, runtime grants, package scripts, and migration inventory.
- Latest migration inventory: 72 numbered migrations; latest is 072.
- Runtime tests: **not run**. This GitHub connection can inspect and write repository files but does not provide a checkout/test execution environment or PostgreSQL URL. The repository's integration harness requires `EDUOS_TEST_PG_URL` pointing to PostgreSQL 15+; without it, integration tests skip.
- Hardware/deployment: not applicable to this feature audit.
- No runtime code changed; no feature completion is claimed.

## Exit criteria

Do not mark Timeline/Time Capsule implemented or merge a runtime PR until all seven blockers are addressed, the full negative matrix passes in CI with real PostgreSQL and the non-owner runtime role, and the PR contains exact test run links/results plus privacy/retention decisions.
