# FED-06 — Cross-tenant exchange gateway (aggregates only)

Status: built into Master Control, plus a report builder in each district's EduOS. **Only de-identified, thresholded aggregates can pass.** No identifiable student data can be exchanged through the gateway; the datasets, the builder and the checker all refuse it.

Code:
- Contract, minimization, signing and checking: `eduos/src/federation/exchange.js`.
- Master Control: the agreement and delivery routes in `eduos/src/master-control/app.js`, and migration `eduos/db/master-control/004_exchange_gateway.sql`.
- EduOS: `eduos/src/exchange-routes.js`.

Tests: `eduos/test/exchange.test.js`, the FED-06 cases in `eduos/test/integration/master-control.test.js`, and `eduos/test/integration/exchange.test.js`.

## Datasets

| Dataset | Fields | Suppressed measure | Grouped by (secondary suppression) |
|---|---|---|---|
| `enrollment_by_grade` | school ID, school name, grade, student count | student count | school |
| `sports_participation` | school ID, school name, participant count (students on active sports rosters) | participant count | — |

Every field is a school-level dimension or a count. A test checks that no dataset has a student field.

## Agreements

An **exchange agreement** names:
- the **producer** (always a district: it owns the data) and the **recipient** (a state authority, the platform or another district);
- one dataset, and the agreed **fields** (the dataset's, or a subset that keeps its required fields);
- the **purpose**: state reporting, operations and planning, or approved research (aggregate);
- a **legal basis**;
- the **minimum cell size** (default 10, never below 5);
- an **end date**.

**Proposing:**
- Either side can propose: the district (holding `exchange.share`, a new capability: district only, never delegable) or the recipient (holding `reporting.aggregate.view` at the recipient node).
- The platform operator holds neither, so it can't ask for a district's data.

**Approval and revocation:**
- **Both sides approve**, and not the same person for both sides.
- The district approves with the **public key its EduOS signs with**.
- The agreement is active only once both sides have approved.
- **In force** means active and today within the agreement's dates, **start and end**. Before the start date, nothing can be delivered, read or issued (`agreement_not_started`); after the end date, the same (`agreement_expired`).
- **Either side can revoke**, with a reason. After that, nothing more is delivered and **nothing already delivered can be read**; Master Control keeps it for audit only.

## Agreement terms

Once an agreement is in force, the district's sharer (`exchange.share` at the producing district) downloads its **terms file** from Master Control (`GET /mc/api/exchange-agreements/:id/terms`, format `eduos-exchange-terms-1`). It holds the agreement ID, producing district, recipient, dataset, the **exact approved fields**, purpose, legal basis, minimum cell size and dates. Master Control signs it with its policy key (FED-05), and each issue is audited. The recipient can't issue the producer's terms.

## Building a report (district EduOS)

On **Data links**, the superintendent builds a report for an agreement:
1. Upload the agreement's terms file. EduOS checks it against `MC_POLICY_PUBLIC_KEY` and refuses terms that are altered, signed with another key, for another district, before their start date or after their end date. Nobody types the dataset, fields, purpose or minimum: the report uses **exactly** the terms' values, so an agreement for some fields never gets all of them.
2. EduOS counts from its own data for **this district only**, keeps only the agreed fields, and hides small counts:
   - **Primary suppression:** any count below the minimum is hidden.
   - **Secondary suppression:** within each school, if exactly one count would be hidden, the next-smallest is hidden too, so the hidden one can't be worked out from a known school total.
3. EduOS signs the result (`eduos-exchange-1`, Ed25519; the key is derived from `EXCHANGE_SIGNING_SECRET` or `EXCHANGE_SIGNING_SECRET_FILE`, at least 32 characters).
4. EduOS returns the report as a file and audits that it was built.

**Reports are snapshots.** EduOS counts what it holds now; it doesn't keep history to count a past period from. So every report is labelled with the day it was built: `snapshot: true`, `as_of` that day, and a period of that one day. A report can't claim an earlier period, and Master Control refuses one that does (`not_a_snapshot`) or that is dated in the future. Historical (as-of) reporting would need dated enrollment and roster history first.

The page shows the public key to give Master Control when approving.

## Delivering and reading (Master Control)

**Delivering:** the district (`exchange.share`) delivers the file to the agreement. Master Control checks it before storing:

| Check | Refused as |
|---|---|
| The signature, against the key the district approved | `altered`, `wrong_key`, `bad_signature` |
| The agreement, producer (tenant reference), dataset, purpose, fields, minimum cell size | `wrong_*` |
| It's a snapshot: `as_of` is one day, the period is that day | `not_a_snapshot` |
| `as_of` is within the agreement's start and end dates, and not in the future | `outside_agreement_period`, `dated_in_the_future` |
| Every field is agreed | `field_not_agreed` |
| Every shown count meets the minimum, and every hidden count is truly hidden | `not_minimized` |
| Secondary suppression is present | `not_minimized` |

- The same file twice is refused.
- A different report for the same day is a new **version** (a correction).
- Deliveries are append-only.

**Reading:**
- Either party can read a delivery, only while the agreement is in force (started, not ended, not revoked).
- **Every read is audited**, allowed or denied, with the purpose and the delivery's hash.
- Nobody else can read it, including the platform operator.

## Not in this slice

- Identifiable exchanges (such as TC-06 history transfers or SPORT-05 eligibility), which need per-record consent and authority checks.
- Automatic, network-level delivery between EduOS and Master Control; files move by download and upload, as in FED-05.
- Datasets beyond the two above.
- Historical (as-of) reports, which need dated history in EduOS.

FED-07 adds the district's consent and residency rules to agreements, terms and reports (`fed-07-jurisdiction-rules.md`).
