# Original School App Vision — District-Governed PR Build Queue

**Repository:** `topking80/EDUOS-REPO-001`  
**Baseline:** `main` at `f11d119aed96453d18b953f88e1a0edac7af9e82`  
**Source:** Mathew C. Pennington, *School App.docx*  
**Purpose:** Turn the original school-app vision into separately reviewable implementation PRs without weakening EduOS district governance, school boundaries, privacy, or security.

## Non-negotiable district-governance rule

A feature is eligible only if it preserves the current authorization model:

- District and school data remain tenant-scoped. Every new tenant-owned table must use forced RLS and the correct district and, where applicable, school scope.
- The server derives district, school, user, role, and relationships from the authenticated session. Client-supplied scope or role claims are never trusted.
- District-level decisions stay with district-authorized roles. School-level actions stay within the actor's active school and granted permissions.
- Third-party apps remain subject to the district app catalog, privacy review, data-sharing scope, licensing, and assignment/approval workflow. No vendor receives roster or student data by default.
- Student media remains private and governed by guardian consent, retention, and the existing media scanning/delivery pipeline.
- No advertising, student-data sale, or behavioral data harvesting.
- Every PR must include audit events, least-privilege runtime grants, migration/RLS tests, negative authorization tests, and documented operational behavior.

This matches existing repository foundations: `policy.js` separates superintendent, IT administrator, principal, teacher, parent, and pupil permissions; IT administrators explicitly lack student-record permissions. The district resource mesh makes app assignment and licensing district-governed and constrains app data-sharing scope. Existing RLS migrations enforce district and school scope, and media consent is recorded with immutable decision history. District-specific payment-provider setup is also already modeled.

## Disposition of the original vision

### Build, subject to district controls

- Student learning timeline and scheduled Time Capsule, with narrow visibility, verified relationships, consent, retention, and auditable release.
- Complete schedule and substitute coverage workflows, extending existing staff absence/coverage foundations.
- Unified attendance and custody events across classes, activities, transportation, pickup, and emergency roll call.
- Visitor check-in and authorized staff review, with district-defined policies and restricted records access.
- Local-first/edge reliability and safe synchronization, preserving district authority and auditable conflict resolution.
- Cross-school learner records only through explicit, approved district-to-district exchange and verified authority.
- Parent, teacher, and employee experiences using role-specific access and private in-app communication.
- District-approved education marketplace extensions, signed and isolated, with least-privilege data scopes.
- Digital bookstore and event ticketing under district-selected providers and school/district financial controls.
- Donations only with district-approved recipients, accounting, refunds, and audit trails.
- Teacher collaboration and guest-speaker sessions with moderated, approved participation.
- Local-network assessments with district/school curriculum and assessment controls.
- School comparison only as opt-in, appropriately aggregated and privacy-protected reporting.

### Do not build as originally phrased; replace with a safer governed design

- **Continuous tracking of every student/staff member:** do not add unrestricted GPS or persistent location surveillance. Use event-based attendance, explicit check-ins, time-bounded hall passes, transport custody handoffs, and emergency accountability. Any exceptional location capability requires a separate legal, safety, and district-policy approval.
- **Automatic police-registry checks or direct police/lockdown control:** do not connect to law-enforcement databases, dispatch, or lockdown controls without agency authorization, written agreements, threat review, and district approval. Start with authorized visitor workflows and human-controlled escalation.
- **Public cross-school learner profiles or global ability tracking:** do not expose identifiable student records or create a national learner score. Any record exchange must be purpose-limited, consent/authority-aware, district-approved, and auditable. Comparison/reporting must be aggregate with small-cohort suppression.
- **Unrestricted stranger-to-student messaging, open global student networking, or unsupervised research volunteering:** do not build open contact. Replace with educator-mediated, moderated, age-appropriate spaces, verified participants, guardian/district controls, and research-specific approvals.
- **Unrestricted device geofencing:** do not introduce covert location tracking. Any classroom device policy must be transparent, narrowly scoped, district-authorized, and designed not to collect continuous student location.
- **Arbitrary third-party executable packages on school servers:** do not allow unsigned or unreviewed code. Require signed artifacts, sandboxing, permission manifests, vulnerability review, controlled updates/rollback, and district approval.
- **Advertising or monetization from student data:** prohibited by this build plan.

## Proposed PR sequence

Each item below is a separate PR after its prerequisite architecture review. The PR numbers are intentionally not preassigned; GitHub assigns them when created.

| Order | Proposed PR | Scope | Main acceptance gates |
|---|---|---|---|
| 0 | District-governance acceptance baseline | Add reusable feature checklist and policy decision record for new modules | Policy ownership, RLS, role matrix, audit, consent, retention, threat model, and negative tests documented |
| 1 | Local-first edge reliability | Prove local network operation, offline queue behavior, safe sync, conflict resolution, recovery, and degraded-mode UI | WAN-disconnected end-to-end tests; replay/idempotency; no cross-district sync; documented backup/restore |
| 2 | Timeline & Time Capsule runtime | Implement timeline entries, capsule lifecycle, worker, recipient checks, and UI; keep existing PR #67 as design/spec foundation | RLS and attachment authorization; guardian/educator scope; consent/revocation recheck at release; idempotent worker; audit and retention tests |
| 3 | Unified schedule and substitute operations | Student/class/activity schedule, staff schedule, daily substitute invitation and assignment, collision checks | District/school role matrix; expiring invite; no privilege inheritance; change propagation and offline handling |
| 4 | Unified attendance and custody events | Reconcile class attendance, absence, hall-pass events, transport check-ins, pickup custody, and emergency roll call | Event idempotency; authorized recipients only; stale/offline status; guardian notification preferences; no persistent GPS |
| 5 | Visitor management | Visitor registration, identity evidence, host approval, check-in/out, restricted-person flags, audit | Human review; restricted access to sensitive records; district-configured policy; no unsupported registry or automated law-enforcement integration |
| 6 | Emergency communications hardening | Local alerts, acknowledgement, role-based instructions, SMS fallback, evacuation/accountability views | Local operation during WAN outage; provider failure/retry tests; authorized initiation; human-controlled lockdown; no unapproved police integration |
| 7 | Portable learner records and federation | District-approved record requests, transfer, provenance, corrections, revocation, and federation trust | Explicit inter-district agreement/configuration; verified guardian/legal authority; field-level disclosure; audit; no global public lookup |
| 8 | Parent experience consolidation | Multi-child/multi-school family dashboard, schedules, approved communications, activity and event views | Current guardian relationship on every request; school/district boundaries; revocation tests; no exposure of private educator notes |
| 9 | Teacher and employee workspace completion | Teacher daily workspace, secure relay messaging, staff notices, approved guest-speaker workflow | Active assignment/role checks; no private contact disclosure; moderation, retention, and district-configurable communication controls |
| 10 | Governed marketplace runtime | Vendor onboarding, district privacy approval, signed app packages, sandboxed local/remote launch, scope enforcement | Default data scope none; district approval and licensing; supply-chain review; tenant isolation; revocation and rollback |
| 11 | Bookstore and event commerce completion | School/district catalogs, tickets, receipts, refunds, reconciliation, provider configuration | District-selected processor; authorized school ownership; transparent fees; ledger/reconciliation tests; no student data used for targeting |
| 12 | District-approved donations | Event/general donation flows and school-designated funds | District-approved destination and accounting; receipts/refunds; financial audit; no unapproved fundraising beneficiary |
| 13 | Moderated educator and student collaboration | Teacher network, guest speakers, supervised cross-school projects and language collaboration | Verified educators; moderated spaces; age/guardian/district controls; anti-contact-abuse safeguards; no public student directory |
| 14 | Local-network assessments | District/school assessment authoring, local delivery, offline submission queue, later synchronization | Curriculum/assessment permissions; integrity and replay tests; local outage recovery; accessibility; no high-stakes scoring claims without validation |
| 15 | Privacy-protected school insights | Opt-in school/district comparisons and longitudinal aggregate reporting | Aggregation, minimum cohort thresholds, suppression, documented definitions, no identifiable student ranking |

## PR dependency and sequencing notes

- PR 0 is the gate for every subsequent feature.
- PR 1 should precede features whose core promise depends on school-local operation or offline continuity.
- PR 2 continues the existing Timeline/Time Capsule design work in PR #67; runtime code should be a distinct implementation PR after schema and authorization review.
- PRs 3–6 build on existing staff coverage, attendance, transport, pickup, safety, notification, and media foundations. Reuse those services rather than creating parallel sources of truth.
- PR 7 is a prerequisite for any true cross-school learner history. Until it passes, family views must remain within the currently authorized district/school scope.
- PRs 10–12 must preserve district-controlled app approval and payment-provider configuration. A school or vendor cannot bypass district rules by creating a direct listing, launch, payment route, or data-sharing grant.
- PR 13 must remain educator-mediated and supervised; open stranger-to-child contact is out of scope.
- PR 15 must use aggregate data only and must not become a student-level ranking product.

## Required PR checklist

Every implementation PR must provide:

1. A source requirement and district-policy mapping.
2. Schema constraints, foreign keys, forced RLS, and school-scope policy where relevant.
3. Explicit role/permission changes reviewed against `eduos/src/policy.js`.
4. Least-privilege runtime grants and no table-owner/BYPASSRLS runtime path.
5. Positive and negative API tests, including cross-district, cross-school, IDOR, revoked relationship, and privilege-escalation cases.
6. Real PostgreSQL integration tests using the non-owner runtime role.
7. Offline, retry, replay, partial-failure, and recovery tests where relevant.
8. Audit, retention, consent, accessibility, and operational documentation.
9. A report of exactly which tests ran and which could not run. No PR is called complete solely because a route or table exists.

## Current state

- PR #67 remains the Timeline & Time Capsule design foundation; it is not the runtime implementation.
- This document is a proposed build queue, not evidence that any listed implementation PR has been completed.
- Do not merge a feature that violates the district-governance rule, even if it matches the original wording.
