# District preservation fund (TC-12)

The pooled fund that preservation gifts (TC-09) go into, with its accounting (TC-10) and its spending rules. **Sandbox / ledger only**: payments are recorded, no money moves.

## Everything starts off

- The fund is **off**. Gifts stay **closed** until the fund is on, collection isn't paused, and the superintendent has recorded one **legal**, one **finance** and one **governance** approval (a reference such as board minutes or a counsel memo, and the date). A database trigger on `history_donations` enforces this, so no gift can start while it's closed.
- Family totals are **not published** until the superintendent turns that on, and then only once at least `reportMinDonors` (default 5, minimum 3) people have given. The summary has no names and no per-gift amounts.
- When totals are published they also appear as a **footnote on student grade cards** (the "Final grades & credentials" card of Grades & progress, `GET /api/learning/progress` → `fundFootnote`): total given and total spent, nothing else. The district can turn the footnote off (`gradeCardFootnote`, on by default once totals are published). EduOS has no separate report-card document; that card is the grade card.
- Collection and disbursement can each be **paused**, with a reason that families see.

## What the fund can pay for

District-wide preservation only, from a fixed list the district narrows: storage, archival media, moving old files to readable formats, backups, making the archive accessible, other district-wide preservation. No fund table has a student column. **It can't buy any student more storage or any preferential access.**

The district writes its own purpose, allocation rules, who decides, and refund policy. Families see these on the Support preservation card.

## Sources (restricted gifts)

A gift for one school is restricted to that school; a gift for the whole district is unrestricted. Each payment comes from one source and can't exceed what it has: its gifts' net ledger (gift − fee − refund), less what was paid, less what is approved but not yet paid.

## Approvals and conflicts of interest

- Finance (the superintendent or a named reviewer, TC-10) requests a payment: the **school it's for**, category, description, payee, invoice or quote, amount, source. A school's restricted gifts can only pay for that school.
- District decision (2026-11-24): it needs **three approvals, all required** — the **principal of that school** and **two district administrators** (superintendent or IT administrator). This is fixed, not a setting. Nobody approving can be the requester, and each approver attests they have no personal or financial interest. A vice principal acting for the principal doesn't fill the principal's seat. Once a seat is filled, a further approval for it is refused (`seat_filled`). One rejection (with a reason) from the panel rejects it.
- Principals and district administrators see what's waiting for them under **Fund payments to approve** (principals and the superintendent on Student history; IT administrators on Apps).
- Someone **other than the requester** records the payment, with the accounts-payable reference. That posts an append-only line to `preservation_fund_ledger`.
- The requester can withdraw a pending request; finance can cancel an approved one, which releases the money. Nothing is deleted; terms are fixed once requested.

## API

| Method | Path | Who |
|---|---|---|
| GET | `/api/preservation-fund` | anyone in the district: disclosures, collecting or not, published totals |
| GET/PUT | `/api/preservation-fund/settings` | superintendent |
| GET | `/api/preservation-fund/governance` | finance |
| POST | `/api/preservation-fund/governance` `{kind, reference, approvedOn}` | superintendent |
| GET | `/api/preservation-fund/report` | finance: balances by source, payments, votes |
| POST | `/api/preservation-fund/disbursements` `{schoolId, sourceSchoolId?, category, description, payee, invoiceRef, amountCents}` | finance |
| GET | `/api/preservation-fund/approvals` | principals and district administrators: pending payments and the caller's seat |
| POST | `/api/preservation-fund/disbursements/:id/vote` `{decision, noConflict, note}` | the school's principal or a district administrator, not the requester |
| POST | `/api/preservation-fund/disbursements/:id/pay` `{paymentRef}` | finance, not the requester |
| POST | `/api/preservation-fund/disbursements/:id/close` `{reason}` | requester (withdraw) or finance (cancel approved) |

## Database (migration 137)

`preservation_fund_settings`, `preservation_fund_governance_records` (append-only), `preservation_fund_disbursements` (terms fixed, never deleted), `preservation_fund_votes` (append-only; each vote records its seat, `school_principal` or `district_admin`), `preservation_fund_ledger` (append-only). Writes to disbursements, votes and the ledger go only through SECURITY DEFINER functions; settings and governance records are written by the superintendent through RLS.

## Decisions left to the district

Decided 2026-11-24: payments need the school's principal plus two district administrators; totals are published as a grade-card footnote. Still open: which documents count as legal, finance and governance sign-off; whether district-wide costs that serve no single school need a different approver than a principal; whether real payments are ever made from EduOS (today they are recorded only).
