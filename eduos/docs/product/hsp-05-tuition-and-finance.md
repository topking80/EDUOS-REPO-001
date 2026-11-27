# HSP-05 — Private school tuition and finance

Status: built (migration `db/164_hsp05_private_school_finance.sql`, routes `src/private-school-finance-routes.js`).

## What it does

A private school's finance staff bill families, record payments and close the books, with a second
person on every step that moves or forgives money.

| Step | Who does it | Who has to agree |
|---|---|---|
| Propose a payment provider (manual, PayPal, Square, BTCPay, other) | finance or school admin | a **different** school admin approves it |
| Open a billing account (payer = a guardian at the school, learners billed there) | finance or school admin | — |
| Draft an invoice: tuition and fees (positive), aid, discounts and credits (negative) | finance or school admin | — |
| Aid and discounts on a draft | added by finance | a **different** school admin approves each line before the invoice can be issued |
| Issue an invoice | finance or school admin | numbered `INV-YYYY-NNNN`, total frozen, lines can't change |
| Record a payment (check, ACH, cash, an approved provider, other) | finance or school admin | receipt `RCT-YYYY-NNNN`; can't exceed the balance; append-only |
| Request a refund (up to what's left of the payment) | finance or school admin | a **different** school admin approves or rejects |
| Void an invoice (with a reason) | finance or school admin | only once its payments are refunded |
| Prepare a reconciliation for a period (invoiced, received by method, refunded, net) | finance or school admin | a **different** school admin signs off; refused while refunds wait or if the totals changed since it was prepared |

Every step is written to the school's audit trail (`private_school_audit_events`).

Balance = issued total − payments + approved refunds.

## Who sees what

- **Finance and school admins** see the school's billing. Finance gets learner **names only**
  (`eduos_ps_billing_learners()`) for invoice lines; it still holds no learner records.
- **Guardians** see only the accounts they pay, and only issued or void invoices on them (never drafts),
  their payments and receipts, and approved refunds (`GET /api/private-school/billing/mine`).
- **Teachers, registrars, campus staff** see no billing.
- **Other schools, districts and homeschool families** see none of it: every table has forced RLS with
  the school isolation and members-only policies, checked as the runtime role in
  `test/integration/private-school-finance.test.js`.

## What it doesn't do

- **No card or bank details are stored.** A provider is a label and an account reference; a payment is a
  method and a reference. Online checkout through a provider is a later slice.
- No tax statements, no 1098-T or other filings, no accounting-system export yet. Receipts say so.
- EduOS doesn't process money; the school does.

## API

All under `/api/private-school/billing`, in a private-school session (see the header of
`src/private-school-finance-routes.js` for request bodies).
