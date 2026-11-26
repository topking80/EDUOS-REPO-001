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
- **Either side can revoke**, with a reason. After that, nothing more is delivered and **nothing already delivered can be read**; Master Control keeps it for audit only. The same applies once the end date passes.

## Building a report (district EduOS)

On **Data links**, the superintendent builds a report for an agreement:
1. Choose the agreement ID, dataset, purpose, period and minimum cell size.
2. EduOS counts from its own data for **this district only**, keeps only the agreed fields, and hides small counts:
   - **Primary suppression:** any count below the minimum is hidden.
   - **Secondary suppression:** within each school, if exactly one count would be hidden, the next-smallest is hidden too, so the hidden one can't be worked out from a known school total.
3. EduOS signs the result (`eduos-exchange-1`, Ed25519; the key is derived from `EXCHANGE_SIGNING_SECRET` or `EXCHANGE_SIGNING_SECRET_FILE`, at least 32 characters).
4. EduOS returns the report as a file and audits that it was built.

The page shows the public key to give Master Control when approving.

## Delivering and reading (Master Control)

**Delivering:** the district (`exchange.share`) delivers the file to the agreement. Master Control checks it before storing:

| Check | Refused as |
|---|---|
| The signature, against the key the district approved | `altered`, `wrong_key`, `bad_signature` |
| The agreement, producer (tenant reference), dataset, purpose, fields, minimum cell size | `wrong_*` |
| The period ends within the agreement | `outside_agreement_period` |
| Every field is agreed | `field_not_agreed` |
| Every shown count meets the minimum, and every hidden count is truly hidden | `not_minimized` |
| Secondary suppression is present | `not_minimized` |

- The same file twice is refused.
- A different report for the same period is a new **version** (a correction).
- Deliveries are append-only.

**Reading:**
- Either party can read a delivery, only while the agreement is in force.
- **Every read is audited**, allowed or denied, with the purpose and the delivery's hash.
- Nobody else can read it, including the platform operator.

## Not in this slice

- Identifiable exchanges (such as TC-06 history transfers or SPORT-05 eligibility), which need per-record consent and authority checks.
- Automatic, network-level delivery between EduOS and Master Control; files move by download and upload, as in FED-05.
- Datasets beyond the two above.
- Jurisdiction-specific residency and retention rules (FED-07).
