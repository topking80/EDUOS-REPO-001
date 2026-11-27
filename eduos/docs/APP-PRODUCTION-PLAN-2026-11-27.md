# EduOS App Production Plan

**Plan date:** 2026-11-27  
**Target branch:** `main`  
**Status:** Proposed production program; this document is a plan, not a release certification.  
**Scope:** District, school, homeschool, private-school, federation, web/PWA, Flutter, school-node, and Roku experiences in this repository.

## 1. Production objective

Deliver EduOS as a dependable, secure, supportable school operating system. Every app must be more than a working screen: its workflows, data boundaries, authorization, accessibility, resilience, observability, deployment, support ownership, and recovery procedures must be verified.

Production readiness is earned per app and per capability. A role app may launch in a limited scope while another remains in pilot; do not label the entire platform production-ready based on a successful demo or one passing test suite.

## 2. Non-negotiable product and safety decisions

1. **Tenant and school isolation:** preserve district, school, family, and private-school contexts; enforce authorization on the server and in forced PostgreSQL RLS.
2. **Least privilege:** use a non-owner runtime database role without `BYPASSRLS`; grant only required tables, columns, and functions.
3. **No covert or persistent location tracking:** bus-driver apps do not use GPS or device-location tracking. Keep route/stop sequence and manual stop check-ins. Do not add live bus maps, geofencing, GPS-derived ETAs, route histories, or location-based alerts. Any future proposal would require a separate policy and governance decision; it is not part of this plan.
4. **Safety actions remain human-authorized:** weather alerts may prompt but do not automatically start shelter; SRO workflows do not become police dispatch, CAD/RMS, or 911 integration without separate authority and review.
5. **Nurse boundary:** the current nurse experience is an operational shell, not a clinical health-record product. Do not release clinical charting, medication administration, diagnosis, or treatment workflows until a separately designed Health Office service passes clinical, privacy, legal, and security review.
6. **Family and learner privacy:** guardians see only children for whom they have active authority; students see only information authorized for their role and relationship.
7. **No unapproved external data use:** external AI, messaging, analytics, vendors, and integrations remain disabled or tightly scoped until district approval, privacy review, licensing, and data-flow validation are complete.
8. **No compliance claims by assertion:** document evidence and obtain qualified review; software tests alone do not establish FERPA, COPPA, accessibility, or other legal compliance.

## 3. App portfolio and production tracks

| App / surface | Production outcome | Critical acceptance focus |
|---|---|---|
| Student | Reliable learning, assignments, schedule, grades/progress, library, history and approved activities | Grade visibility/return policy, student-specific RLS, age-appropriate UX, accessible learning flows |
| Parent / guardian | Child-linked progress, schedule, attendance/arrival, transport check-ins, messages, alerts, Time Capsules | Custody/authority changes, child-scoped data, consent and media controls |
| Teacher | Daily operations, classes, assignments, grading, attendance, communications, approved history contributions | Class roster scope, grading permissions, substitute/coverage workflows, media consent |
| Principal / vice principal | School command center, staffing, safety, operations, school oversight | Clear role split, school-only access, approvals, audit trails, escalation and continuity |
| Superintendent / district admin / IT | District governance, configuration, identity, apps, reporting and operations | Separation of duties, district-only authority, no implied student-record access for IT |
| Maintenance / facilities | Work requests, triage, assignment, status, inspections and asset lifecycle as approved | Work-order lifecycle, priority/SLA, evidence, school scope, offline/retry behavior |
| Bus driver / transport | Assigned route and stops, manual rider check-ins, run state, alerts and exceptions | Correct route assignment, safe offline queue, duplicate/replay handling, guardian visibility; **no GPS** |
| SRO / safety | School-scoped safety status and incident assignment/acknowledgement | Active membership, revocation, audit, strict separation from student/discipline/transport records |
| Nurse / health office | Operational coordination only until a separate clinical design is approved | No accidental clinical record exposure; clinical capabilities held behind explicit approval |
| Librarian, counselor, coach, lunchroom, office and other support roles | Complete assigned daily workflows with narrow role access | Role matrix, student relationship scope, accessibility, audit and workflow completion |
| Homeschool hub | Family-directed courses, attendance, work samples, reading, progress and records | Adult authority, family context, clear family-record labeling, safe co-op boundaries |
| Private-school hub | Campus, admissions, classes, attendance, report cards, tuition and communications | School verification, campus isolation, financial dual control, guardian messaging |
| Master Control / federation | Delegated authority, signed policy, jurisdiction, aggregate exchange and node governance | Signed bundles, audit chain, aggregation protections, identity and revocation |
| Web / PWA | Responsive browser and installable mobile web workflows | Browser/device coverage, accessibility, secure sessions, offline boundaries |
| Flutter mobile / desktop | Native role experiences across supported devices | Flutter analyzer/tests, server-address contract, device permissions, upgrade behavior |
| School node / EDEN | Approved school-local continuity and controlled synchronization | Hardware validation, signed identity/bundles, queue integrity, failover/handback and aggregate-only egress |
| Roku | Read-only family Time Capsule viewing | Account/household scope, token lifecycle, no write or expanded disclosure |

## 4. Delivery sequence

### Phase 0 — Establish the release control plane

**Deliverables**
- Publish one production inventory: app, role, platform, owner, maturity, dependencies, known gaps, and release decision.
- Create a release board with one workstream per app and cross-cutting workstreams for identity, data, security, CI/CD, observability, and operations.
- Confirm branch protection and required checks on `main`; every change lands through a reviewed PR.
- Define supported browsers, mobile OS versions, Flutter version, desktop targets, school-node hardware profiles, and Roku support policy.
- Define environments: local development, shared test, staging, pilot, and production. Keep data and secrets isolated.
- Establish release versioning, migration policy, rollback/forward-fix policy, and release notes.

**Exit criteria**
- Every app has a named product owner and technical owner.
- Required CI checks are visible and enforced; failed or skipped checks block release.
- Staging is reproducible from versioned configuration and documented secrets.

### Phase 1 — Security, privacy, and data correctness

**Priority: P0; blocks broad production release.**

1. Close the student grade privacy findings: ensure grades/feedback marked not returned are not exposed to students or guardians, and add student-specific RLS to `assignment_submissions` with real PostgreSQL runtime-role tests.
2. Re-audit every tenant table, join table, attachment, search, export, background worker, and integration for forced RLS and least-privilege grants.
3. Run cross-district, cross-school, cross-family, cross-private-school, stale-session, revoked-guardian, revoked-staff, and IDOR negative tests.
4. Verify permission registry and route middleware alignment; hiding a UI control is not access control.
5. Verify sensitive-read and privileged-write audit events, immutable event history where required, retention, export, correction, deletion, and legal-hold behavior.
6. Validate media scanning, storage authorization, delivery-time consent, consent withdrawal, and signed URL expiry.
7. Review external AI, notification, app catalog, LTI, SIS, webhook, payment, and analytics data flows; default off unless approved.
8. Threat-model safety, pickup, transportation, SRO, school-node, and federation workflows separately.
9. Run dependency, container, source, secret, and CodeQL scans; triage findings with documented severity and disposition.

**Exit criteria**
- All P0 security/privacy defects are fixed and independently reviewed.
- Database enforcement is proven against PostgreSQL as the non-owner runtime role, not mocked or run as table owner.
- No unresolved critical/high findings without an approved, time-bounded risk acceptance.

### Phase 2 — Complete role apps by operational journey

Deliver end-to-end workflows, not isolated screens. Prioritize in this order:

**2A. Student, guardian, and teacher**
- Resolve grade-return and submission RLS defects before releasing Grades broadly.
- Complete student grades/progress and ensure student and guardian views use the same authoritative policy.
- Complete parent child-scoped grades/progress and schedule journeys.
- Complete teacher daily operations, including class day, attendance, grading, messages, coverage/substitute handoff, and consent-aware contributions.
- Validate homeschool/private-school family context and role switching without mixing district and family records.

**2B. School leadership and office**
- Complete principal and vice-principal command workflows, approval boundaries, staffing, escalation, and audit.
- Validate office, arrival, pickup, visitor, and reunification paths with real role/relationship matrices.
- Keep emergency initiation and all-clear human-controlled and drillable.

**2C. Facilities, transport, and SRO**
- Maintenance: add a complete work-order lifecycle, assignment, priority, due dates, inspections, asset references, evidence, and escalation where approved.
- Bus driver: strengthen route assignment, stop sequence, manual rider check-ins, no-show/not-riding, exception reporting, run start/end, vehicle inspection, and dispatch communication. Preserve the no-GPS product rule.
- SRO: validate school membership provisioning/revocation, incident-specific assignment, acknowledge/decline, status transitions, and audit. Keep dispatch and external agency integrations out of scope.

**2D. Other support and specialist roles**
- Audit each librarian, counselor, coach, lunchroom, IT, operations, and office role against the same role matrix and operational acceptance standard.
- Nurse stays operational-only until the separate clinical service approval gate is passed.

**2E. Homeschool, private school, and federation**
- Validate onboarding, authority, campus/family context, learner transfers, consent, billing dual control, district/family boundaries, federation delegation, signed policy bundles, aggregate-only reporting, and revocation.

**Exit criteria for each app**
- All primary workflows have happy-path, denial, edge-case, and recovery tests.
- Product owner signs off against role-specific acceptance criteria.
- No app is marked complete solely because a route or screen exists.

### Phase 3 — Cross-platform quality and resilience

**Web / PWA**
- Run browser smoke and full E2E journeys for each high-priority role.
- Run automated accessibility checks and manual keyboard/screen-reader review for critical journeys.
- Test responsive layouts, supported browsers, session expiry, refresh, file upload/download, and install/update behavior.

**Flutter**
- Run `flutter analyze` and full `flutter test` on the pinned CI Flutter version.
- Test supported iOS/Android/tablet/desktop device profiles, permission prompts, deep links, push handling, app upgrades, and low-connectivity behavior.
- Keep client server-address tests and API contract tests current.

**Offline / EDEN**
- Keep offline data minimized and encrypted; preserve the documented bounded queues.
- Test queue expiry, idempotency, replay, clock skew, duplicate submissions, conflict resolution, and reconnect recovery.
- Test WAN outage, node restart, signed bundle rejection, failover authorization, handback, and purge.
- Verify school-node hardware on the actual supported profile; simulation alone is not hardware certification.

**Roku**
- Test authentication/token lifecycle, household scope, read-only enforcement, playback compatibility, and account revocation.

**Exit criteria**
- Required unit, integration, E2E, edge, Flutter, dependency-security, source/container-security, and Prometheus-rule checks pass.
- Critical user journeys pass on each supported client.
- Offline claims are limited to workflows actually tested.

### Phase 4 — Operational readiness

**Deliverables**
- Dashboards for availability, API latency/error rate, database health, queue depth/age, notification delivery, mobile crash rate, background jobs, node health, and security events.
- Structured logs with correlation IDs and sensitive-data redaction.
- Alerts with severity, owner, runbook, and escalation route; avoid alerts that expose student data.
- Backup schedule, encrypted off-site copies, restore drills, RPO/RTO targets, and documented retention.
- Incident response playbooks for data exposure, account compromise, outage, failed migration, notification failure, lost device, school-node failure, and safety workflow failure.
- Support model: district admin guide, school quick-start guides, staff training, family onboarding, accessibility support, and escalation contacts.
- Data migration/import validation, reconciliation reports, and a rollback/forward-fix decision process.
- Vendor/subprocessor inventory, contracts/DPAs as applicable, data-flow map, and approved integration list.

**Exit criteria**
- Restore and incident exercises have evidence and named participants.
- On-call and district escalation coverage is confirmed for pilot hours.
- Support documentation matches the shipped build.

### Phase 5 — Controlled pilot and general availability

**Pilot sequence**
1. Internal test tenant with synthetic data only.
2. One district/school pilot with named administrators and trained role representatives.
3. Expand to additional schools in the same district after the first pilot exit review.
4. Add homeschool/private-school pilots as a distinct tenant-context track.
5. Expand federation and school-node deployments only after their separate trust, hardware, and recovery gates.
6. General availability only after pilot defects are closed or formally accepted.

**Pilot guardrails**
- Feature flags and district-level enablement for new capabilities.
- No silent migration of live student data; use rehearsed imports and reconciliation.
- Document pilot scope, data, users, success measures, support hours, known limitations, and stop conditions.
- Maintain a tested rollback or disable path for each newly enabled capability.
- Do not enable clinical nurse features, GPS tracking, unapproved external AI, or unapproved third-party data sharing.

**Exit criteria**
- No unresolved P0/P1 defects.
- Pilot success metrics meet thresholds agreed before the pilot.
- District stakeholders sign off on workflows, training, support, privacy, and operational readiness.
- Release notes and known limitations are published.

## 5. Required quality gates

| Gate | Required evidence | Release rule |
|---|---|---|
| Governance | Role/authority decision, data-flow map, privacy review, consent/retention plan | Block if missing |
| Database security | Forced RLS, non-owner runtime role, least-privilege grants, negative isolation tests | Block if missing or failing |
| API security | Auth, authorization, CSRF, validation, rate limits, audit, IDOR tests | Block on critical/high defects |
| Functional | Role journey tests, integration and E2E evidence | Block on critical workflow failure |
| Accessibility | Automated and manual review of critical paths | Block on severe barriers |
| Mobile/client | Analyzer, tests, supported device smoke, permission review | Block on failing required checks |
| Resilience | Retry/replay/offline/recovery tests where applicable | Block if data loss or unsafe duplicate possible |
| Operations | Monitoring, alerting, backup/restore, runbooks, support owner | Block if unowned |
| Release | Reviewed PR, required CI, migration review, release notes, rollback plan | Block if incomplete |

The repository README lists required CI checks: `unit`, `integration`, `e2e`, `edge`, `flutter-mobile`, `dependency-security`, `source-and-container-security`, `prometheus-rules`, and CodeQL. Confirm the branch protection configuration actually enforces them before the first production release.

## 6. Release train and work breakdown

Use small, independently reviewable PRs. Keep each PR on a feature/fix branch created from current `main`; do not mix unrelated app work.

| Workstream | Priority | First deliverable |
|---|---:|---|
| Grade privacy + submission RLS | P0 | Remediation PR and real-Postgres regression suite |
| Production inventory + release checklist | P0 | App ownership and maturity matrix |
| Identity, role and tenant isolation | P0 | Cross-context negative test matrix |
| Deployment / secrets / migrations | P0 | Reproducible staging and rollback runbook |
| Student / guardian / teacher completion | P1 | Role journey acceptance packs |
| Principal / VP / office completion | P1 | Leadership and front-office acceptance packs |
| Transport / facilities / SRO | P1 | No-GPS transport, work-order and SRO acceptance packs |
| Homeschool / private-school | P1 | Separate context onboarding and transfer acceptance |
| Accessibility and device matrix | P1 | Web/Flutter supported-device test plan |
| Monitoring / backup / incident response | P1 | Operational dashboards and restore exercise |
| Federation / EDEN hardware | P2 | Trust and hardware certification |
| Clinical Health Office | HOLD | Separate clinical architecture and approvals |
| GA and scale testing | P2 | Pilot exit report and load/restore evidence |

## 7. Production scorecard

Track these measures weekly and at every release review:

- App readiness: percentage of critical journeys passing per role and platform.
- Security: open P0/P1 findings, RLS/IDOR negative-test pass rate, overdue remediation.
- Reliability: service availability, API p95 latency, error rate, queue age, background job success.
- Client quality: crash-free sessions, failed sign-ins, supported-device smoke pass rate.
- Operations: restore-test success, incident acknowledgement and resolution time, alert noise.
- Adoption: active trained users by role, onboarding completion, support requests per active user.
- Data quality: import reconciliation variance, duplicate/replayed writes, failed sync count.
- Accessibility: unresolved critical barriers in core journeys.

Set numeric SLOs and pilot success thresholds with the district before launch; do not invent targets after observing results.

## 8. Immediate next actions

1. Treat this plan as the master production roadmap and keep it updated through PRs.
2. Finish and review the role-app audit PRs (#229, #230, #231) as evidence inputs; they are audits, not release approvals.
3. Recheck PR #228 and fix the grade-return and student-specific RLS findings before enabling broad student/family Grades release.
4. Create the production inventory and app-owner matrix from the current codebase.
5. Start the P0 security/data-correctness remediation, then proceed through the phases above.
6. Run the full required CI suite and a real staging deployment before any production launch claim.

## 9. Definition of done

EduOS is ready for a production release only when the selected release scope has:
- a named owner and documented supported users/platforms;
- completed primary workflows and role-specific acceptance tests;
- verified tenant, school, family, and private-school isolation;
- passing required CI and real PostgreSQL runtime-role security tests;
- reviewed privacy, consent, retention, accessibility, and integration boundaries;
- tested backup, restore, monitoring, incident response, and rollback;
- completed pilot sign-off and published release notes.

This plan deliberately separates **production planning** from **production certification**. No app or release is certified by this document alone.
