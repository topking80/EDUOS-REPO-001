# District Governance — Feature Acceptance Baseline

**Status:** Required design and review gate for all new EduOS feature PRs  
**Repository baseline:** `main` at `f11d119aed96453d18b953f88e1a0edac7af9e82`  
**Applies to:** API, database, web/mobile clients, school nodes, district services, integrations, marketplace apps, analytics, and background workers.

## 1. Purpose

This document makes the district governance model an explicit implementation gate. A feature is not eligible for implementation or release merely because it is requested by a school, vendor, family, staff member, or product plan. It must fit the district's authority model, school boundaries, student privacy rules, and security architecture.

This is a review baseline, not a grant of new permissions and not a claim that all features already satisfy it.

## 2. Existing architecture invariants to preserve

The following constraints are grounded in the current repository and must not be weakened by feature work:

1. **District tenant boundary:** district-owned records are scoped by `district_id`; tenant tables use enabled and forced PostgreSQL RLS with deny-by-default scope predicates.
2. **School boundary:** where data belongs to a school, enforce `school_id` as well as `district_id`. School users cannot query or mutate another school's records merely by changing a URL, body, query, or identifier.
3. **Authenticated actor context:** derive user, district, active school, and role from the authenticated server-side session. Ignore client-supplied role, district, school, owner, author, or recipient claims.
4. **Role permissions:** route authorization must use the actual permission registry and enforce it server-side. A UI hiding a button is not authorization.
5. **Temporary grants:** permission grants are time-bounded, revocable, and school-scoped where applicable. A grant-based write must remain inside the grant's school. Do not add implicit permanent grants.
6. **District vs school administration:** district-level decisions remain with district-authorized roles; school-level actors remain within their school and granted authority.
7. **IT separation of duties:** the `it_admin` role operates systems, accounts, integrations, and approved app infrastructure but does not receive student-record access by implication.
8. **Third-party app governance:** vendors/apps use the district catalog, privacy review, data-sharing scopes, licensing, and assignment/approval flow. Default student-data scope is none. No direct vendor bypass or unreviewed executable deployment.
9. **School-node / federation boundary:** school-local services may continue approved workflows during WAN loss. Cross-node egress is allowlisted and aggregate-only by default; identifiable record transfer remains disabled unless explicitly authorized under the applicable consent and district-to-district process.
10. **Aggregate reporting:** preserve minimum cell size and complementary suppression protections at both egress and hub. Never use aggregate reporting as a back door to student-level disclosure.
11. **Media and consent:** private media must use the registered storage, scanning, authorization, and delivery pipeline. Consent decisions and withdrawals must be enforced at read/delivery time, not only at upload time.
12. **Auditability:** privileged decisions, disclosures, changes to access, sensitive reads where required, and irreversible lifecycle transitions must be auditable.
13. **Least privilege:** runtime database roles must not own application tables, must not have `BYPASSRLS`, and must receive only the minimum table/column/function grants.
14. **Financial governance:** payment processors and commerce settings remain district-configured. School revenue, refunds, donation recipients, and financial reporting must follow authorized school/district scope and ledger controls.
15. **No student-data monetization:** no advertising profiles, sale/rental of student data, or behavioral targeting based on student records.

## 3. Feature decision categories

Every feature proposal must receive exactly one initial disposition:

- **APPROVE FOR DESIGN:** no identified governance conflict; detailed threat and data-flow design still required.
- **APPROVE WITH CONTROLS:** allowed only with specified district settings, role permissions, consent, review, or operational constraints.
- **REDESIGN:** original behavior conflicts with a governance invariant; a safe alternative is required before implementation.
- **REJECT:** the requested behavior cannot be made consistent with EduOS district governance, privacy, or safety requirements.
- **HOLD FOR POLICY / LEGAL REVIEW:** depends on a district policy, agreement, legal basis, agency integration, or operational authority not established in the repository.

A reviewer must record the reason, owner of the decision, and conditions for reconsideration. Do not treat missing policy configuration as implied approval.

## 4. Mandatory feature review

Before implementation begins, the PR author must document:

### A. Authority and roles
- Which district role may configure, approve, suspend, and audit the feature?
- Which school roles may use it, and only within which school?
- What may parents/guardians and pupils see or do?
- Are temporary grants needed? If yes, who issues them, what school scope applies, when do they expire, and how are they revoked?
- Does any new role permission accidentally grant a wider resource/action combination than the route supports?

### B. Data and privacy
- Data elements collected, generated, inferred, displayed, exported, and deleted.
- Data owner/controller and permitted purpose.
- Student data classification and sensitivity.
- Guardian relationship and consent requirements, including withdrawal and changed custody/relationship status.
- Retention, correction, deletion, legal hold, and audit-history behavior.
- Whether any data leaves the school node or district boundary, to whom, and under what allowlist/approval.

### C. Technical enforcement
- Tenant and school RLS on every tenant-owned table, including join/association tables.
- Server-side authorization on every read, write, export, attachment, search, and worker path.
- IDOR, cross-tenant, cross-school, role-confusion, stale-session, and revoked-access tests.
- Least-privilege runtime grants; no reliance on table ownership or RLS bypass.
- Audit events and safe error behavior that does not reveal another tenant's record existence.
- Rate limits, abuse controls, replay protection, idempotency, and safe background-worker behavior.

### D. Reliability and operations
- School-local behavior during WAN outage, where applicable.
- Queue encryption, expiry, idempotency, replay, conflict resolution, and recovery.
- Backup/restore, observability, provider outage behavior, incident response, and rollback.
- Accessibility, device support, and role-specific web/mobile journeys.
- Clear distinction between simulated, unit-tested, integration-tested, and hardware/deployment-verified behavior.

## 5. Mandatory implementation acceptance tests

Every feature PR must include relevant tests from this list. Tests must run against PostgreSQL with a non-owner runtime role for database enforcement claims.

| Test class | Minimum proof |
|---|---|
| Authentication | Anonymous and expired sessions are denied |
| Tenant isolation | District A cannot read, mutate, export, or infer District B data |
| School isolation | School A users cannot access School B records without an explicitly authorized district role |
| Role matrix | Each allowed action succeeds; each unlisted action is denied |
| IT separation | IT administrator cannot gain student-record access through the new route or join |
| Grant lifecycle | Expired, revoked, wrong-school, and wrong-resource grants fail |
| Relationship lifecycle | Guardian/educator access stops when the underlying relationship or assignment is revoked |
| IDOR | Replacing every object identifier with another user's or school's ID does not disclose or alter data |
| RLS enforcement | RLS enabled and forced; runtime role is not owner and has no bypass |
| Data export | Export scope and field minimization match the actor's authority |
| Media | Unauthorized, unscanned, blocked, or consent-withdrawn media cannot be delivered |
| Audit | Sensitive access and privileged state changes create the expected audit record |
| Resilience | Retry, duplicate delivery, replay, partial failure, and recovery are safe |
| Client parity | Web and mobile clients cannot bypass server policy; offline queues contain only approved data |

A test that only mocks the database does not prove RLS. A test run as table owner does not prove runtime isolation.

## 6. Restricted feature patterns

The following patterns are not approved by this baseline:

- Persistent or covert student/staff GPS tracking.
- Publicly searchable identifiable learner profiles or cross-district student lookup.
- Global student scoring, predictive ability ranking, or school rankings derived from identifiable learner data.
- Unmoderated adult-to-child or stranger-to-child direct messaging.
- Direct student contact with unknown external volunteers or researchers.
- Automated police database checks, dispatch, or lockdown control without explicit agency authorization, written agreements, district approval, and separate safety review.
- Vendor-installed arbitrary code, unreviewed packages, or data access beyond an approved permission manifest.
- Student-data advertising, sale, rental, or behavioral targeting.

A safer alternative may be proposed, but it must be separately reviewed. Examples include time-bounded attendance/check-in events instead of continuous location tracking, educator-mediated collaboration instead of open messaging, and approved district-to-district record exchange instead of public learner profiles.

## 7. Required PR description template

Every feature PR should include:

```markdown
## District governance decision
- Disposition: APPROVE FOR DESIGN / APPROVE WITH CONTROLS / REDESIGN / REJECT / HOLD
- Decision owner:
- District policy/configuration required:
- Conditions and limitations:

## Data and authority
- Data classes and purposes:
- District roles:
- School roles:
- Guardian/pupil scope:
- Cross-school or external disclosure:

## Enforcement
- RLS migration(s):
- API authorization:
- Runtime grants:
- Audit events:
- Consent and retention:
- Worker/integration permissions:

## Verification
- PostgreSQL runtime-role tests:
- Cross-district and cross-school negative tests:
- IDOR and revoked-access tests:
- Offline/retry/replay tests:
- Web/mobile journeys:
- Commands run and exact results:
- Tests not run and why:
```

## 8. Release gate

A feature cannot be described as complete or production-ready until:

- Governance disposition and conditions are recorded.
- Database, route, worker, client, and integration paths all enforce the same policy.
- Required real-PostgreSQL negative tests pass using the runtime role.
- Security, privacy, consent, retention, and audit requirements are verified.
- Relevant offline/failure/replay tests pass.
- Documentation states any remaining limitations and operational prerequisites.
- The PR has been reviewed and merged through the repository's normal process.

A schema, route, UI screen, passing unit test, or successful local demo alone is not sufficient evidence.

## 9. Relationship to the build queue

This baseline is PR 0 in `original-school-app-district-governed-pr-plan.md`. It is a governance/documentation gate; it does not grant new runtime permissions or claim new feature functionality. Subsequent PRs must reference this checklist and may not weaken these invariants without an explicit, separately reviewed district-governance decision.
