# Maintenance, Bus Driver, and School Resource Officer App Audit

**Audit date:** 2026-11-27  
**Repository baseline:** `main`  
**Scope:** role navigation, native Flutter screens, API/policy boundaries, and verified product capabilities  
**Change type:** documentation only; no runtime code or database changes

## Executive summary

| Role | Current implementation | Assessment |
|---|---|---|
| Maintenance | Native Facilities tab backed by the shared school-operations work queue | Partial; useful work-order foundation, not a full maintenance management hub |
| Bus driver | Native Route screen, assigned route/run data, named-stop rider check-ins, offline queue | Strong foundation; operationally useful, but important safety and exception workflows remain |
| SRO | Native Safety workspace, incident visibility, assignment acknowledgement and status updates | Purposefully narrow and privacy-conscious; not a dispatch or police interoperability system |

This audit is a source review, not a release certification. No builds, test suites, direct-SQL RLS checks, device tests, or live API exercises were run for this document.

## 1. Maintenance / Facilities

### Verified today

- Role navigation exposes Facilities, Staffing, and Messages.
- Facilities resolves to the native `OperationsScreen`, using the `facilities` school-operations domain.
- The queue supports operational summary counts (active/open, urgent, overdue), work item creation, and start/complete/cancel actions. Leads can escalate.
- Facility work kinds include repair, cleaning, safety hazard, setup, and other.
- Maintenance is granted facilities read/create/update policy permissions.
- The screen supports a short summary and optional details. The generic work queue is a useful foundation for routing and tracking requests.

### Gaps before this is a complete Maintenance Hub

1. **Asset and equipment register:** no verified native inventory of HVAC, boilers, elevators, fire systems, doors, vehicles, kitchen equipment, warranties, manuals, or service history.
2. **Preventive maintenance:** no verified recurring inspections, scheduled maintenance calendar, meter/condition readings, or overdue preventive-maintenance workflow.
3. **Work-order lifecycle:** current generic queue does not establish a full work-order record with location/building/room, asset, requester, assigned technician/vendor, labor, parts, cost, photos, before/after evidence, approval, and close-out verification.
4. **Facilities inspections and compliance:** no verified inspection templates and evidence trails for fire/life-safety, playgrounds, water, accessibility, environmental, or other district-required inspections.
5. **Space and event setup:** setup is a work-item kind, but there is no verified room reservation, event setup checklist, capacity, custodial turnover, or conflict-aware scheduling workflow.
6. **Escalation and service levels:** urgent/overdue counts exist, but verify configurable response targets, after-hours escalation, supervisor assignment, acknowledgement, and escalation audit.
7. **Mobile field workflow:** verify safe photo/file upload, barcode/QR asset lookup, low-connectivity draft handling, and accessibility on phones/tablets.

### Recommended direction

Build a dedicated Facilities Hub on top of the existing queue rather than replacing it. Sequence: (F-01) richer work orders with school/building/room and assignment; (F-02) asset register and service history; (F-03) preventive maintenance/inspection schedules; (F-04) parts/vendor/cost and approval controls; (F-05) field evidence and offline-safe workflow. District policy should control asset taxonomy, service targets, retention, and cost approvals.

## 2. Bus Driver

### Verified today

- Role navigation exposes Route, Messages, and Alerts.
- Route is a native Flutter `DriverRouteScreen` backed by `GET /api/transport/today`.
- Drivers see assigned route(s), bus label, stop sequence, rider name/grade/stop, and current run/check-in state.
- Drivers can start and finish a run when connected, record board/not-riding/alighted events, and see on-board/expected/dropped counts.
- Check-ins can be queued offline and later submitted with their original time. Run start/finish require a connection.
- The transport schema is documented as append-only check-in events with forced RLS. The product intentionally does not collect GPS/device-location tracking.
- Policy limits drivers to transport read/check-in, school/branding read, basic communications, and safety read. It explicitly excludes student records, grades, attendance, and cases.
- Route assignment is managed by authorized school/district leadership; drivers see their assigned route data.

### Gaps and safety-critical verification

1. **No verified route navigation/traffic integration:** the app shows stop order and names, but no verified turn-by-turn navigation, road closures, weather/traffic routing, or dispatch integration.
2. **No verified pre-trip/post-trip vehicle inspection:** add a checklist for brakes, tires, lights, accessibility lift, emergency equipment, cleanliness, and defect reporting with vehicle grounding and maintenance handoff.
3. **No complete incident/exception flow:** verify a constrained workflow for breakdown, collision, medical emergency, unsafe stop, late route, substitute driver, missed stop, and emergency contact—without exposing broad student records.
4. **Custody and handoff edge cases:** verify authorized stop changes, absent rider, wrong bus, no authorized adult, early dismissal, split custody, route reassignment, and disputed boarding/alighting. Driver check-in must never become a guardian-release authorization.
5. **Offline queue safeguards:** validate idempotency, duplicate/replay handling, clock drift, device loss, queue expiry, logout/profile switch, revoked route assignment, and visible sync reconciliation. A queued check-in must be clearly marked pending until server-confirmed.
6. **Accessibility and field usability:** test large touch targets, glare/contrast, one-handed use, screen readers, distraction-minimizing interaction, and safe use while the vehicle is stopped.
7. **Operational coverage:** no verified driver substitute/relief handoff, vehicle assignment, route change acknowledgement, dispatch messaging, or daily defect sign-off.

### Recommended direction

Preserve the no-GPS design and least-privilege rider view. Prioritize (D-01) vehicle inspection and defect handoff; (D-02) constrained incident/route exception workflow; (D-03) dispatch/substitute and route-change acknowledgement; (D-04) robust offline/idempotency/revocation tests; (D-05) stop and custody edge-case simulations. Never let a driver role access general student profiles or independently release a student to a guardian.

## 3. School Resource Officer (SRO)

### Verified today

- Role navigation exposes Safety and Alerts.
- SRO has a dedicated native Safety screen, distinct from the general safety-center screen used by most roles.
- The role policy grants school/branding read and safety read plus the dedicated `sro_update` action. It does not grant student, attendance, pickup, transport, discipline, or reunification-release permissions.
- SRO status updates are constrained to requested, notified, responding, on-scene, cleared, or unavailable; updates are CSRF-protected, rate-limited, school-scoped, audited, and no-cache.
- Incident-specific SRO assignment and acknowledgement/decline are represented in the safety event timeline. Assignment is restricted to active SRO membership at the incident's school and district policy.
- SRO membership provisioning/revocation is district-controlled, not principal-controlled.
- Safety notifications include SROs in staff notifications while family notifications are kept separate.
- Existing tests assert role permission restrictions, school scoping, status constraints, audit/no-cache behavior, district-controlled provisioning, and UI exposure. These tests were inspected, not executed in this audit.

### Gaps and high-risk boundaries

1. **Not police dispatch:** the product records internal school coordination/status. It does not dispatch police, contact 911, establish agency radio interoperability, or guarantee responder arrival. UI and documentation must say this plainly.
2. **No verified agency integration:** no dispatch-grade CAD/RMS, radio, panic-button, or agency identity federation integration was verified. Any future connection requires formal district/agency agreements, agency-owned authentication, threat modeling, test environment, human confirmation, and audit.
3. **Incident information minimization:** verify exactly which incident fields, room reports, responder notes, and event details an SRO can see. Keep student health, counseling, discipline, family contact, and custody details out of SRO views unless a separately approved legal/policy basis and narrowly scoped workflow exists.
4. **Assignment/revocation race:** verify that an SRO who is unassigned, suspended, or has school access revoked immediately loses incident access and cannot post further status/acknowledgement events.
5. **Status semantics:** distinguish officer self-reported status from independently verified dispatch/arrival. Preserve actor, timestamp, assignment, and correction history.
6. **Emergency fallback:** make it explicit that users must use established emergency channels and local protocols; EduOS is not a substitute for emergency services or agency command.
7. **Training and governance:** define district/agency SOPs, role training, retention, evidence/legal hold, audit review, and who can authorize access.

### Recommended direction

Keep the SRO role intentionally narrow. Prioritize (SRO-01) a privacy/field-level access audit of every SRO incident response; (SRO-02) immediate revocation and assignment lifecycle tests; (SRO-03) clear non-dispatch and emergency fallback messaging; (SRO-04) district/agency governance and retention review. Do not expand SRO access to student records, discipline, attendance, transport, pickup, or reunification as a convenience feature.

## 4. Cross-role priorities

1. **Safety and privacy first:** verify tenant/school RLS and negative authorization tests for all three roles, including cross-school, revoked membership, inactive assignment, and direct API/database access.
2. **Operational handoffs:** connect Facilities defects to work orders; connect driver vehicle defects to maintenance; keep SRO coordination inside the approved safety incident boundary.
3. **Mobile reliability:** test offline, retry, duplicate submissions, device loss, account switching, logout, stale data, and revoked access.
4. **Native parity:** confirm web/mobile feature parity only where appropriate; sensitive SRO and driver capabilities should remain deliberately least-privilege.
5. **Release evidence:** Flutter analyze/tests, Node integration tests, DB RLS tests under a non-owner runtime role, accessibility, device matrix, and safety tabletop exercises.

## 5. Audit conclusion

- **Maintenance:** partial operational work queue; build the Facilities Hub around work orders, assets, inspections, preventive maintenance, and field evidence.
- **Bus driver:** strongest of the three current workflows; retain privacy/no-GPS constraints and close vehicle inspection, incident, dispatch, custody-edge, and offline reliability gaps.
- **SRO:** intentionally restricted incident coordination role; strengthen access verification, revocation, governance, and non-dispatch clarity rather than broadening student-data access.

**Release status:** not certified by this source audit. No code was changed and no tests were run.
