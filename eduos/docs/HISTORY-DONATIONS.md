# Preservation gifts (TC-09)

Voluntary one-time gifts from families and staff toward keeping student histories safe. This phase is **sandbox only**: no money moves, and the database refuses anything but the sandbox provider in test mode.

## What it does

- A superintendent turns gifts on (`PUT /api/donations/settings`). Off by default. They set the smallest and largest gift, suggested amounts, and the acknowledgement text.
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

## Not built yet (decisions)

- Hosted checkout with a real processor (needs a two-phase flow, webhooks and reconciliation).
- Recurring gifts.
- Refunds and reconciliation come with TC-10 (donation accounting).
