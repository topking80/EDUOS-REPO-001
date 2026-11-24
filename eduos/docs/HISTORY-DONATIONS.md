# Preservation gifts (TC-09)

Voluntary one-time gifts from families and staff toward keeping student histories safe. This phase is **sandbox only**: no money moves, and the database refuses anything but the sandbox provider in test mode.

## What it does

- A superintendent turns gifts on (`PUT /api/donations/settings`). Off by default. Gifts also stay closed until the preservation fund is open (TC-12, `PRESERVATION-FUND.md`): fund on, not paused, and legal, finance and governance approvals recorded. They set the smallest and largest gift, suggested amounts, and the acknowledgement text.
- Adults (parents and staff) see a **Support preservation** card on the history page. Students never see it and can't give (`403 guardian_payment_required`).
- The gift runs through the district's existing payment setup (`commerce_payment_setup`, migration 065/066). Only a ready **sandbox** method is used. A method carried by a real processor answers `donations_sandbox_only`. The live-payments kill switch (`EDUOS_COMMERCE_LIVE_PAYMENTS`) is not consulted because nothing live can run here.
- On success the donor gets a plain acknowledgement, numbered `GIFT-YYYY-NNNNNN`, with the district, the designation (a school or the whole district), the amount and the district's acknowledgement text. It is append-only.
- Acknowledgements make **no tax-deductibility claim**. A district can add its own tax-receipt wording (`taxWordingEnabled`, default off). EduOS never writes that wording.
- The superintendent sees totals and gifts. Donors who asked for it show as "Anonymous".

## What it never does

- Gifts never change storage limits, what is kept, or anything a student gets. There is no student column on any donation table.
- No card or bank details are stored: only the sandbox reference, amount, fee and status.
- Donation records can't be deleted; their terms can't change after they are made.

## API

| Method | Path | Who |
|---|---|---|
| GET | `/api/donations/status` | any signed-in user |
| POST | `/api/donations` | adults; `{amountCents, schoolId?, anonymous?, idempotencyKey}` |
| POST | `/api/donations/:id/confirm` | the donor; `{testOutcome: "sandbox_success" \| "sandbox_decline"}` |
| GET | `/api/donations/mine` | the donor |
| GET | `/api/donations/:id/acknowledgement` | the donor or the superintendent |
| GET | `/api/donations` | superintendent |
| GET/PUT | `/api/donations/settings` | superintendent |

## Database (migration 135)

`district_donation_settings`, `history_donations`, `history_donation_acknowledgements`, `history_donation_counters`. RLS scopes everything to the district; donors read their own gifts, the superintendent reads all. Status changes and acknowledgements go only through `eduos_history_donation_record()` (SECURITY DEFINER).

## Accounting, refunds and reconciliation (TC-10, migration 136)

- **Ledger.** Every completed gift posts two append-only lines: the gift (+) and the processor's fee (−). A refund posts a refund line (−, the full gift). The processor keeps its fee on a refund, as card processors do, so a refunded gift nets to minus the fee. Only definer functions write the ledger; gifts completed before 136 are backfilled.
- **Who sees the books.** The superintendent, and staff the superintendent names as **finance reviewers** (`PUT /api/donations/finance/reviewers/:userId {on}`). There's no finance role, so this is the designation. A reviewer acts only while signed in under a staff role. Appointments are kept, never deleted.
- **Refunds.** `POST /api/donations/:id/refund {reason}` (finance) refunds a completed gift through the sandbox. Nobody refunds their own gift. The donor gets a plain refund notice (`GIFT-…-R`, `GET /api/donations/:id/refund-notice`) with no tax wording.
- **Reconciliation.** `GET /api/donations/reconciliation?from&to` (UTC dates) compares the gift records with the ledger line by line and lists any differences. `POST /api/donations/reconciliations` signs a period off and keeps the result, matched or not. Whoever recorded a refund in the period can't sign it off (`403 separation_of_duties`).
- The **Gift accounts** card on the history page shows this month, sign-off, recent gifts with Refund, and (for the superintendent) the reviewer list.

| Method | Path | Who |
|---|---|---|
| GET | `/api/donations/finance/access` | anyone (is this user finance?) |
| GET/PUT | `/api/donations/finance/reviewers[/:userId]` | superintendent |
| GET | `/api/donations/ledger?from&to` | finance |
| POST | `/api/donations/:id/refund` | finance, not the donor |
| GET | `/api/donations/:id/refund-notice` | the donor or finance |
| GET | `/api/donations/reconciliation?from&to` | finance |
| GET/POST | `/api/donations/reconciliations` | finance; sign-off not by a refunder in the period |

With the sandbox there is no processor statement to compare against, so reconciliation checks EduOS's own gift records against its ledger. A real processor would add its settlement report as a third column.

## Not built yet (decisions)

- Hosted checkout with a real processor (needs a two-phase flow, webhooks, settlement import).
- Recurring gifts.
