# Homeschool & Private School Hub — Product and Architecture Plan

**Repository:** `topking80/EDUOS-REPO-001`  
**Target:** `main`  
**Status:** Architecture/product plan; not runtime implementation.

## Goal

Extend EduOS beyond district-operated public schools with first-class support for independent private schools and family-directed homeschool programs. Both environments must use the existing identity, learning, assessment, portfolio, communications, privacy, and audit foundations without pretending that a homeschool family is a school district.

## Product entry points

Add an education-environment selector after authentication and authorization:

- District / public school
- Independent private school
- Homeschool family

The selector is a navigation and tenancy context, never an authorization mechanism. The server resolves every active organization, family relationship, role, and permission from authenticated memberships. A user may belong to more than one environment and must explicitly switch context.

## Homeschool family workspace

### Family administration
- A parent/legal guardian creates or joins a homeschool family workspace and invites verified co-educators or guardians.
- Support multiple learners per family, with separate records, grade/age bands, learning plans, schedules, attendance, assessments, and portfolios.
- Family roles: owner/primary educator, co-educator, guardian/viewer, and learner. Avoid assuming every adult linked to a child has identical legal authority.
- Family ownership, learner transfer, guardian disputes, and account recovery require explicit workflows and audit history.

### Learning operations
- Build individualized learning plans from editable courses, units, lessons, standards/tags, resources, and learning goals.
- Reuse assignments, rubrics, gradebook, assessments, accommodations, mastery evidence, and Christie approved-content tutor where permissions allow.
- Support flexible school-year calendars, configurable instructional days, attendance sessions, instructional time, field trips, co-op days, and unscheduled learning.
- Allow parent-authored work and external learning evidence with provenance; distinguish parent-entered grades from independently verified credentials.
- Generate progress reports, course summaries, transcripts, and portfolio exports with clear issuer/provenance labels. Never represent an export as state-approved accreditation or a government transcript.

### Family resources
- Multi-child calendar and daily plan, reading/library lists, expenses/resources links, announcements, secure family-to-educator communication, and optional homeschool co-op groups.
- Co-op participation is invite-only, adult-sponsored, moderated, and has no open stranger-to-child messaging.
- Family data storage quotas remain governed by the existing district/product storage policy, not expanded automatically by this feature.

## Independent private school workspace

### School onboarding and governance
- A private school is an independent tenant/organization with its own verified operator, school profile, calendar, policies, staff, enrollment, classes, and branding.
- Support single-campus and multi-campus organizations with explicit parent organization/campus relationships.
- Provide school administrator, principal/campus administrator, registrar, finance, teacher, staff, guardian, and learner roles with least privilege.
- Keep district affiliation optional and explicit. If a school participates in a district, consortium, or public program, it does not gain access to district data or services without an approved agreement and scoped authorization.
- School identity/ownership verification, domain claims, operator changes, and school closure/export are required lifecycle workflows.

### Academic and operational workflows
- Admissions inquiry, application, document checklist, review, offer, waitlist, enrollment, withdrawal, and re-enrollment.
- Student/staff directory, class rosters, schedules, attendance, learning plans, assignments, gradebook, assessments, report cards, transcripts, and student portfolio.
- School calendar, events, announcements, secure family communication, approved activities/clubs, library, and role-based dashboards.
- Support tuition and fee workflows only through configured, compliant payment providers. Separate tuition invoices, scholarships/aid, credits, refunds, receipts, and reconciliation; no payment credentials stored by EduOS.
- Financial permissions must be separated from academic/student-record permissions. No student data may be used for advertising or targeting.

## Shared capabilities and interoperability

- Reuse the learning core, EDAL provenance/verification, portfolio and Time Capsule only where the existing authorization and consent rules permit.
- Provide family-level cross-environment views only for learners for whom the signed-in adult has a current, verified relationship and lawful authority.
- A learner moving between homeschool, private school, and district school gets a controlled export/import workflow. Transfers are purpose-limited, field-selective, consent/authority checked, auditable, correctable, and revocable where legally applicable.
- Never create a public learner directory or universal student profile. Do not silently merge identities across organizations.
- Keep school-local records isolated. Federation is opt-in and agreement-based; no organization can query another organization's roster or records by guessing an identifier.
- Allow school and family generated records to be clearly distinguished from externally issued credentials and state-required forms.

## Regulatory and policy configuration

Education requirements differ by jurisdiction and can change. Build a configurable compliance layer, not hard-coded claims that EduOS itself determines legal compliance.

- Jurisdiction profile selected by the organization/family, with source, effective date, last-reviewed date, and responsible reviewer.
- Configurable attendance/instructional-hour tracking, notice/filing reminders, record retention, assessment/reporting templates, and document checklists.
- Display that requirements vary and direct users to the relevant education authority or qualified adviser for official determinations.
- Do not automatically file notices, certify compliance, or submit records to government agencies without an explicit, authorized integration and user confirmation.
- Provide privacy notices, data access/export/correction/deletion workflows, retention controls, media consent, and immutable audit events appropriate to each tenant type.

## Data and security architecture requirements

1. Introduce explicit tenant types and membership models for `district`, `private_school`, and `homeschool_family`; do not overload `district_id` with family IDs.
2. Define organization/campus/family membership and learner relationship tables with stable opaque IDs, effective dates, revocation, and audit.
3. Every tenant-owned table must have tenant-scoped foreign keys, forced PostgreSQL RLS, least-privilege runtime grants, and negative cross-tenant integration tests using the non-owner runtime role.
4. Server derives tenant, role, school/campus, family membership, and guardian authority from authenticated session state. Never trust client-supplied tenant IDs or role claims.
5. Scope each API route and background worker to the active tenant and re-check membership/relationship at read, write, export, and scheduled delivery time.
6. Add audit events for enrollment decisions, attendance changes, grade/report edits, exports, consent, relationship changes, financial actions, and organization ownership changes.
7. Preserve existing private media scanning, consent, retention, and signed delivery controls. No broadening of media visibility by changing tenant type.
8. Add accessibility, localization/time-zone, backup/recovery, rate-limit, abuse-prevention, and offline behavior tests.
9. No advertising, sale of learner data, behavioral profiling, unrestricted GPS, or open adult-to-child direct messaging.

## Proposed implementation sequence

- **HSP-00 — Architecture and tenancy foundation:** tenant-type model, threat model, membership/relationship model, policy matrix, migration strategy, API boundaries, and test plan. Gate for all runtime work. Design: `docs/product/hsp-00-architecture-and-tenancy.md`.
- **HSP-01 — Homeschool family workspace:** family tenant and membership lifecycle, multi-learner dashboard, learner relationship verification, family calendar. Built: `docs/product/hsp-01-homeschool-family-workspace.md`.
- **HSP-02 — Homeschool learning operations:** individualized plans, attendance sessions and instructional time, parent-authored evidence, progress reports and transcript/portfolio exports. Built: `docs/product/hsp-02-homeschool-learning.md`.
- **HSP-03 — Private school foundation:** verified organization/campus onboarding, roles, branding, calendar, staff and student enrollment.
- **HSP-04 — Private school admissions and academics:** admissions lifecycle, rosters, schedules, attendance, learning and report-card workflows.
- **HSP-05 — Tuition and school finance:** provider configuration, invoices, aid/credits, receipts, refunds, reconciliation, separation of duties.
- **HSP-06 — Controlled portability and compliance profiles:** family/school/district transfer, provenance, jurisdictional templates, retention and audit.
- **HSP-07 — Co-ops and shared services:** supervised co-op groups, approved resource sharing, library and family communication integrations.

## Acceptance gates for every implementation PR

- Migration and rollback plan; schema and tenant ownership documented.
- Forced RLS and runtime grants verified; no owner/BYPASSRLS execution path.
- Positive and negative API/integration tests for cross-family, cross-school, cross-campus, and cross-district access.
- Tests for revoked guardian/educator membership, learner transfer, stale sessions, IDOR, exports, background jobs, and audit completeness.
- Browser/mobile workflows for every affected role; keyboard and screen-reader accessibility checks.
- Real PostgreSQL integration tests using the non-owner runtime role; report exact commands and results.
- Data retention, backup, deletion/export, consent, and incident-response behavior documented.
- No claim of legal compliance or state accreditation without jurisdiction-specific review and verified evidence.

## Initial scope boundary

This document authorizes planning and review only. It does not claim that the features above exist, and it does not authorize direct changes to `main`. Runtime implementation must proceed through the numbered, independently reviewable PR sequence after HSP-00 is reviewed.
