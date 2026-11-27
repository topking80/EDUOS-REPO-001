# FED-07 — Jurisdiction rules: residency, retention, consent, legal holds

Status: built. A state or district sets these rules in Master Control as policies (FED-02). They reach each district in its signed policy bundles (FED-05), and the district's EduOS follows them. The rules are what the state or district configured: EduOS doesn't decide what any law requires, and nothing here claims compliance with one.

Code:
- Policies: `eduos/src/federation/authority-catalog.json` (model 0.6.0), mirrored in `docs/architecture/federation/authority-model.v0.1.json`. The engine (`eduos/src/federation/authority.js`) gains a `narrower` kind of restrict-only enum.
- EduOS: `eduos/src/jurisdiction-rules.js`, used by `src/retention.js`, the student records delete in `src/server.js`, `src/exchange-routes.js` and `src/policy-bundle-routes.js`.
- Master Control: the exchange agreement routes in `eduos/src/master-control/app.js`, and migration `eduos/db/master-control/005_jurisdiction_rules.sql`.

Tests: `eduos/test/jurisdiction-rules.test.js`, `eduos/test/integration/jurisdiction-rules.test.js`, and the FED-07 case in `eduos/test/integration/master-control.test.js`.

## The rules

| Policy | Values | Who sets it | How it combines |
|---|---|---|---|
| `data.residency.scope` | `any`, `us`, `in_state` | platform, state, district | Each level can narrow it, never widen it. The platform or state can lock it. |
| `records.audit.minimum_years` | 0–100 | state, district | The highest one wins: a district can keep longer, never shorter. |
| `records.closed_cases.minimum_years` | 0–100 | state, district | Same. |
| `records.safety.minimum_years` | 0–100 | state, district | Same. |
| `history.retention.minimum_years` | 0–100 | state, district | Same (from FED-02). EduOS's retention job doesn't purge student history. |
| `records.legal_hold` | on or off | state, district | Once on above, it stays on below. The state can lock it so the district can't lift it. The reason should name the matter. |
| `exchange.consent_reference.required` | on or off | state, district | Same as a hold. |

## Which bundle is in effect

EduOS uses the **newest received bundle whose effective date has arrived**. A bundle effective next month changes nothing until then. With no bundle in effect, every rule is at its default (no restriction). A value EduOS doesn't understand counts as the strictest one: a hold, the longest minimum, in-state residency.

## What EduOS does

**Retention minimums.** The nightly retention job (`npm run db:retention`) raises each district's configured days to its minimums (years × 366, so it never comes out shorter). For example, with `RETENTION_AUDIT_DAYS=365` and a two-year audit minimum, audit records are kept 732 days. The job's summary lists which minimums it applied.

**Legal hold.** While a hold is in effect:
- the retention job deletes **no district records**: audit, cases, role-app records and every feature's records. It still clears technical leftovers (offline replay receipts, old device health reports);
- a superintendent **can't delete a student's records** (`legal_hold`). A hold placed on one student's history (Time Capsule preservation) blocks that student's deletion the same way.

**Consent reference.** Where the rule is on, a district approving an exchange agreement in Master Control must record the consent or authorization it relies on (a board resolution, a parental consent process, a statute). The reference is kept on the agreement and carried in its terms. Master Control issues no terms for an agreement without one, and EduOS builds no report from such terms (`consent_reference_required`).

**Residency.**
- *Exchanges:* with `in_state`, the recipient must be in the district's state. With `us`, it must be a US jurisdiction. Master Control checks this when an agreement is proposed, approved, delivered and when terms are issued, using the rule as it stands that day. EduOS checks it again when building a report (`recipient_outside_residency`).
- *Hosting:* the operator declares where the server keeps data, with `EDUOS_DATA_LOCATION` (`US` or a state such as `US-TX`). EduOS compares the declaration with the rule and shows the result on **Data links**: *meets the rule (as declared)*, *doesn't meet the rule*, or *hosting location not declared*. EduOS can't verify where it really runs; the status is only as good as the declaration, and the page says so.

**Seeing the rules.** `GET /api/district/jurisdiction-rules` (superintendent, IT administrator) and the **Jurisdiction rules** card on Data links show the bundle in effect, each rule and the residency status.

## Not in this slice

- Moving data when the residency rule changes, or blocking the whole district when hosting doesn't meet it.
- Per-record-class holds, or holds limited to some schools.
- Retention minimums for the feature-specific records (each feature still uses its `RETENTION_*` setting, and a hold covers all of them).
- Legal review of any configured rule against the law it cites.
