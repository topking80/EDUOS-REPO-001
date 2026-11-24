# District preservation fund (TC-12)

The pooled fund that preservation gifts (TC-09) go into, with its accounting (TC-10) and its spending rules. **Sandbox / ledger only**: payments are recorded, no money moves.

## Everything starts off

- The fund is **off**. Gifts stay **closed** until the fund is on, collection isn't paused, and the superintendent has recorded one **legal**, one **finance** and one **governance** approval (a reference such as board minutes or a counsel memo, and the date). A database trigger on `history_donations` enforces this, so no gift can start while it's closed.
- Family totals are **not published** until the superintendent turns that on, and then only once at least `reportMinDonors` (default 5, minimum 3) people have given. The summary has no names and no per-gift amounts.
- Collection and disbursement can each be **paused**, with a reason that families see.

## What the fund can pay for

District-wide preservation only, from a fixed list the district narrows: storage, archival media, moving old files to readable formats, backups, making the archive accessible, other district-wide preservation. No fund table has a student column. **It can't buy any student more storage or any preferential access.**

The district writes its own purpose, allocation rules, who decides, and refund policy. Families see these on the Support preservation card.

## Sources (restricted gifts)

A gift for one school is restricted to that school; a gift for the whole district is unrestricted. Each payment comes from one source and can't exceed what it has: its gifts' net ledger (gift − fee − refund), less what was paid, less what is approved but not yet paid.

## Approvals and conflicts of interest

- Finance (the superintendent or a named reviewer, TC-10) requests a payment: category, description, payee, invoice or quote, amount, source.
- It needs `approvalsRequired` approvals (default 2, 2–5) from finance people **other than the requester**. Each approver attests they have no personal or financial interest. One rejection (with a reason) rejects it.
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
| POST | `/api/preservation-fund/disbursements` | finance |
| POST | `/api/preservation-fund/disbursements/:id/vote` `{decision, noConflict, note}` | finance, not the requester |
| POST | `/api/preservation-fund/disbursements/:id/pay` `{paymentRef}` | finance, not the requester |
| POST | `/api/preservation-fund/disbursements/:id/close` `{reason}` | requester (withdraw) or finance (cancel approved) |

## Database (migration 137)

`preservation_fund_settings`, `preservation_fund_governance_records` (append-only), `preservation_fund_disbursements` (terms fixed, never deleted), `preservation_fund_votes` (append-only), `preservation_fund_ledger` (append-only). Writes to disbursements, votes and the ledger go only through SECURITY DEFINER functions; settings and governance records are written by the superintendent through RLS.

## Decisions left to the district

Which approvals count as legal, finance and governance sign-off; how many approvals a payment needs; whether and when to publish totals; whether real payments are ever made from EduOS (today they are recorded only).
