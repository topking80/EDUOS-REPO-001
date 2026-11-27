# Principal, Vice Principal, and Nurse Apps — Comprehensive Audit

**Audit date:** 2026-11-27  
**Repository:** `topking80/EDUOS-REPO-001`  
**Audited base:** `main` at `819451455d139478cc9e7177906e9596a6404f27`  
**Scope:** Flutter role navigation and screens, role-home APIs, school operations, health-office boundaries, safety, staffing, permissions and test coverage.

## Executive assessment

EduOS has native role shells for principal, vice principal and nurse. The principal has a useful school overview, the vice principal has a broad operational queue plus attendance and safety, and the nurse has a health-office operational queue. These are meaningful foundations, but they are not equivalent in depth.

**The nurse experience is currently an operations console, not a complete school-nurse clinical workflow.** This appears deliberate: the UI explicitly tells nurses not to enter diagnoses, medications, treatment notes or student-identifying health details into the general operations queue. That is the right boundary, but it means clinical workflows must be built in a separate, purpose-designed, highly restricted health-record service before claiming the Nurse App is complete.

## Role-by-role assessment

### 1. Principal app

**Native tabs on main:** School (overview), Staffing, Library, Pick-up, Transport, Messages, Alerts, Time Capsules.

**What is present**
- School-level overview from `GET /api/home`, including student count, today's absences, open support cases and overdue follow-ups.
- Bus run/rider summary.
- Needs-attention indicators for adult-requested Christie chats, reported messages, pending guardian invitations and lesson/source approvals.
- School announcements.
- Staffing, library, pick-up desk, transport, messages, alerts and Time Capsule workflows.
- School-scoped home query derives school from the authenticated actor.

**Gaps / risks**
- The overview sends leaders to the web for lesson/source approvals; the principal workflow is not fully native.
- The main principal tab list does not expose a dedicated native attendance command center, intervention/case-management queue, school calendar/master schedule, visitor management, or comprehensive staff coverage dashboard.
- School performance and operational indicators are spread across separate screens rather than one principal action queue.
- The audit did not establish that every principal action has complete role-specific negative authorization tests and audit coverage.

**Recommended completion**
1. Add a principal action center with prioritized follow-ups, approval queues, attendance exceptions, intervention escalations and unresolved operations.
2. Add a school calendar/master schedule and substitute/coverage overview.
3. Bring approval review natively into the app with a reasoned decision trail and separation of duties.
4. Add visitor/contractor check-in oversight only within the district-approved visitor policy.
5. Validate school-only visibility, especially for multi-school or district-level users.

**Assessment:** Strong school overview foundation; leadership workflows remain fragmented and partly web-dependent.

### 2. Vice principal app

**Native tabs on main:** Operations, Staffing, Attendance, Safety, Messages, Time Capsules.

**What is present**
- Operations screen aggregates work queues and summary counts.
- Vice principal can coordinate facilities and meal-service work items, including priorities, statuses and escalation.
- AttendanceToday screen is wired as a native destination.
- Safety Center and Time Capsule screens are native.
- Staffing and messages are available.
- Operations screen explicitly describes vice principal responsibilities as school-day exceptions, attendance follow-up, safety coordination and facilities escalation.
- Sensitive counseling and health-office queues are marked sensitive and their details are not exposed through the generic vice-principal operations view.

**Gaps / risks**
- The Operations tab's generic vice-principal area list is facilities and meal service; health-office and counseling records are intentionally segregated. The VP still needs a safe status/coordination signal without access to confidential clinical/counseling narratives.
- No dedicated native discipline/restorative-practice workflow or structured behavior intervention plan was evidenced in the inspected tab set.
- Attendance tab exists, but the audit did not establish a unified exception workflow connecting unexplained absences, tardies, family contact, transport handoffs and follow-up ownership.
- School-wide master schedule, substitute coverage and room/coverage conflict resolution are not clearly represented as a VP command center.
- Visitor oversight and routine campus supervision workflows are not evidenced in the current role tabs.

**Recommended completion**
1. Build an attendance exception queue with ownership, contact attempts, reasons, escalation and audit history.
2. Build a governed student-support/behavior workflow with least-privilege case access, restorative actions, guardian communication and retention rules.
3. Add a VP daily command center for staffing coverage, schedule conflicts, unresolved safety/operations tasks and handoffs.
4. Provide privacy-preserving health-office/counseling operational indicators (e.g., open coverage request) without exposing diagnoses, treatment or confidential narratives.
5. Add cross-workflow tests for role boundaries and escalation authority.

**Assessment:** Useful operations/attendance/safety foundation; not yet a complete vice-principal school-day command center.

### 3. Nurse app

**Native tabs on main:** Health office, Staffing, Messages.

**What is present**
- Health office opens the shared OperationsScreen scoped to the `health_office` domain.
- Nurse can create operational work items for supplies, screening logistics, room coverage and other health-office operations.
- Nurse console text explicitly prohibits diagnoses, medications, treatment notes and student-identifying health details in this generic queue.
- Health office is marked sensitive in the operations UI.
- Nurse role participates in the SafetyOS takeover role set.
- Staffing and messages are available.

**Critical product gap**
The inspected Flutter screen and role tabs do not demonstrate a dedicated clinical encounter workflow for student visits, authorized emergency care plans, allergy alerts, medication administration, immunization/health screening records, parent notifications, return-to-class decisions, or emergency escalation documentation. A generic supply/coverage queue must not be treated as a clinical record.

**Required safe design**
1. Establish a separate Health Office service and data model with explicit district policy, health-record retention, emergency access and audit requirements.
2. Define role permissions for nurse, designated backup nurse, authorized school health staff, principal/vice principal (operational status only), teacher (minimum necessary classroom instruction), guardian (authorized child-specific disclosure) and student (age/policy-appropriate access).
3. Store visit/encounter notes, vital signs where authorized, medication orders/administration, allergy/emergency plans, immunization/screening records and disposition in purpose-specific records with strict field-level and row-level controls.
4. Enforce consent/authorization, custody restrictions, minimum-necessary disclosure, emergency “break-glass” access with reason and immutable audit, and rapid revocation.
5. Keep sensitive clinical content out of push notifications, generic messages, school operations, broad dashboards, analytics and AI retrieval by default.
6. Build parent/guardian communication with approved templates and release checks; do not expose full clinical notes by default.
7. Provide downtime/emergency procedures and a tested reconciliation process. Do not cache sensitive clinical records on ordinary shared devices without a separately approved managed-device design.

**Assessment:** Health-office operations shell exists; clinical Nurse App is not evidenced and must be treated as a separate high-sensitivity product slice.

## Cross-role security and governance checks

- The generic operations UI classifies `health_office` and `counseling` as sensitive, suppresses free-text details for those domains, and limits creation by role.
- Nurse and counselor queues use different allowed task kinds; vice principal is not allowed to create health-office clinical work.
- Principal school overview is backed by a role-specific `/api/home` query scoped to the actor's school.
- The role-tab tests assert that principal, vice principal and nurse tabs resolve to native screens rather than a web fallback.
- The operations test suite checks failed/offline submissions preserve typed content and double taps do not duplicate writes.
- SafetyOS includes principal, vice principal and nurse roles in the staff safety takeover set.

These are positive controls, but the source review is not a penetration test. The complete role matrix, database RLS policies, clinical-data grants and negative direct-SQL tests for a future health-record service must be reviewed before implementation approval.

## Priority findings

### P1 — Nurse app must not be represented as clinically complete
The current Nurse screen is a health-office operations queue only. No clinical encounter/medication/emergency-care-plan workflow was verified. Keep the current data boundary; do not put clinical details into the generic operations queue.

### P1 — Clinical data architecture and authorization are prerequisites
Before storing health records, define tenant isolation, student/guardian relationship rules, role and field permissions, emergency access, audit, consent, retention, backup, breach response and managed-device constraints. Require negative cross-student, cross-school, cross-district and revoked-relationship tests.

### P2 — Principal approval and intervention work remains fragmented
Move key school-lead approvals and action queues into native workflows and add a single prioritized command center.

### P2 — Vice principal attendance and school-day coordination needs an integrated queue
Connect attendance exceptions, family contact, staffing coverage, schedule conflicts, operations and safety follow-ups without widening access to confidential health/counseling records.

### P2 — Shared school calendar, visitor and coverage workflows are not clearly complete
Define ownership between principal and vice principal and implement only with district policy and auditable access.

## Validation limitations

This is a source/documentation audit using repository files and test definitions. No Flutter analyzer, Flutter test suite, Node test suite, PostgreSQL integration suite, browser smoke, migration-upgrade test, device test or production penetration test was executed during this review. Existing test files indicate intended coverage, not proof of a current passing run.

Before release, run:
1. Flutter analyzer and full test suite.
2. Node unit and integration tests with non-owner runtime roles.
3. Direct-SQL RLS tests for all school leadership and health-office data.
4. Cross-school/cross-district IDOR and revoked membership tests.
5. SafetyOS role simulation and offline/reconnect/replay tests.
6. Accessibility checks for tablets, phones, keyboard and screen readers.
7. For any clinical health feature: threat model, policy/legal review, clinical workflow review, break-glass audit test, backup/restore drill and managed-device assessment.

## Recommended implementation order

1. Keep the nurse's generic operations queue free of clinical data; approve a dedicated Health Office architecture and threat model.
2. Build the Health Office service and minimal clinical encounter/medication/emergency-plan workflows behind strict role gates and tests.
3. Build the vice principal attendance exception and daily coordination command center.
4. Build the principal native approvals and school action center.
5. Complete shared calendar, staffing coverage and visitor workflows according to district policy.
6. Run all cross-role, security, accessibility and device validation before declaring these apps release-ready.

## Release decision

**Principal:** partial / substantial foundation.  
**Vice principal:** partial / substantial operational foundation.  
**Nurse:** operational shell only; clinical app not complete.

The three apps are not release-certified by this audit. No runtime code or database schema is changed in this documentation-only PR.
