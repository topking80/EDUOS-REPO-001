# EduOS roadmap status, 28 November 2026

This doc measures progress against the roadmap in the 27 November comprehensive repository audit (§7, phases 1–6, and §8, immediate actions). It counts completed and tested capabilities, not merged PRs. Main is the source of truth: at the time of writing, every CI and CodeQL check on main passes.

## Summary

| Phase | Status |
|---|---|
| 1. Security closure | **Complete**, except guardian custody verification |
| 2. Core application completion | Not started under this roadmap. Earlier student-app work covers part of the student list |
| 3. School operations | Audit document merged (#231); no build work yet |
| 4. Education ecosystem | Not started under this roadmap |
| 5. Infrastructure and integrations | Plans and evaluations only (#240 Class Share and media playback; #236 and #254 open-source evaluations) |
| 6. National release | Not started |

## Phase 1: security closure

| Audit item | Evidence |
|---|---|
| Complete outstanding RLS work | Per-student row security on intervention cases (db/176), family messages and guardian invitations (#242, db/177), attendance (#243, db/178), the student directory (#244, db/179), family links and teacher rosters (#245, db/180), consents and club media (#246, db/181). Staff read students at their own school only (#248, db/183). `test/integration/rls-coverage.test.js` (#241) fails CI if any table lets the runtime role read student rows district- or school-wide. One reviewed exception remains: `eden_consent_exceptions`, which is limited to the EDEN agent, the superintendent and the student's own principal |
| Resolve grade-release privacy | Grades a teacher hasn't returned are hidden from learners and families (db/174) |
| Assignment submission visibility (historical finding) | Learners see only their own submissions (db/173) |
| Validate guardian authorization | Invitations are verified and single-use (#242). A principal can revoke and restore a guardian link with a reason, and only a pending invitation can activate one (#247, db/182). **Open:** custody verification |
| Complete security regression testing | Route inventory: every route needs a session or a reviewed exception; no-store by default (#249). Secrets removed before AI calls (#250). Hostile-content fixtures for Christie (#251). Count-only redaction records (#252). Concurrency bursts, which fixed a quiz attempt that could be submitted 8 times at once (#253, db/185) |
| Verify boundaries with the runtime database role | Integration tests run as the non-owner, non-BYPASSRLS runtime role against real PostgreSQL |

Test counts over this work: integration 721 → 733, unit 1,050 → 1,080.

Still open from `docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md`:
- **OPS-02:** a CI run with optional integrations absent.
- **OPS-03:** an authorized staging-only scan under a signed scope.

Neither blocks Phase 2.

## Audit §8: immediate actions

| # | Action | Status |
|---|---|---|
| 1 | Finish main CI and CodeQL | Done: green |
| 2 | Revalidate the two historical privacy findings | Done (db/173, db/174) |
| 3 | Security remediation PRs for the remaining RLS exceptions | Done (#241–#248) |
| 4 | Complete the three application audits | Done: #229, #230 and #231 merged |
| 5 | Turn audit findings into implementation PRs | **Not started** |
| 6 | Reconcile outstanding branches against main | **In progress:** see below |
| 7 | Release-readiness dashboard | **Not started.** This doc is the interim record |

The audit also asked every PR to state the apps, endpoints, migrations, authorization rules, tests and release dependencies it affects. **#255** adds a PR template that asks for exactly these, with the governance checklist.

## Branches not merged into main (43, plus the #231 branch)

- **22 are safe to delete.** Each one's PR was merged and the branch is unchanged since, so it can be restored from the PR. They can't be deleted from the agent session, so they need to be removed in GitHub. Turning on "Automatically delete head branches" prevents a new backlog.
- **7 have commits after their PR merged.** Check each before deleting: `tc/12-preservation-fund-r2`, `feat/clubs-sports-classrooms`, `feat/classrooms-seating-bell`, `feature/federation-jurisdiction-registry`, `security/district-ai-privacy-controls`, `feat/twilio-verified-sms`, `feat/37.7-commerce-sandbox`.
- **6 had their PR closed without merging:** `ui/02-school-theme`, `feat/notification-smtp-consent`, `audit/timeline-runtime-security-gate`, `feature/timeline-authorization-foundation`, `feature/canvas-lti-advantage`, `feature/student-history-time-capsule`.
- **9 never had a PR:** `feat/37.6-leo-edison`, `feat/event-tickets-paid-streams-v2`, `fix/37.7.4-weather-safety`, `fix/37.7.4-weather-safety-r2`, `repair/pr-75-refund-isolation-on-current-main`, `tc/08-archival-storage`, `tc/09-donations`, `tc/10-donation-accounting`, `tc/12-preservation-fund`.

The last three groups need a read-only comparison with main before any decision, to find work that isn't on main yet.

## Phase 2 starting point

Student-app work merged before this roadmap covers part of the audit's student list:
- learning resources catalog (#226)
- day planner (#227)
- grades and progress (#228)
- the Today card (#235)
- help and display settings (#237)

Not yet built from the audit's lists:
- **Nurse:** the biggest gap. Health encounters, emergency care plans, allergy alerts, medication administration, immunization and screening records, parent notification, return-to-class notes, and clinical records with their own permissions and audit.
- **Parent:** native academic progress and child-specific schedules.
- **Teacher:** the daily command center and coverage.
- **Principal and vice principal:** command center, attendance exceptions and discipline workflows.

## Recommended order

1. Merge #255 (PR template) and clear the 22 safe branches.
2. Review the remaining 22 branches read-only against main.
3. Phase 2, starting with the nurse app: clinical records separated from operations under their own row security.
4. Build the release-readiness dashboard alongside Phase 2, so each capability is marked complete only with tests and evidence.

Standing requirements carried forward: no bus-driver GPS tracking, no camera access, nothing stored in browser localStorage, and the six governance rules in the PR template.
