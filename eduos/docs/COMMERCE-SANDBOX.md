# Commerce (37.7.0 candidate; providers 37.7.1)

Paid school-event tickets and marketplace purchases, with a revenue split
ledger. 37.7.0 shipped the `sandbox` adapter only (no keys, no network,
nothing charged). **37.7.1 moves the payment choice to each district**:
PayPal, Visa/Mastercard (through Square), Square, Bitcoin (BTCPay Server),
Venmo and Cash App quick-setup cards, in test mode unless the server allows
live payments. See `docs/COMMERCE-PROVIDERS.md`.

## Turning it on

1. The district connects at least one payment option and offers it
   (**Payment options**, superintendent or district IT). The sandbox needs no
   account. The old `COMMERCE_PAYMENT_PROVIDER` variable is gone; real money
   also needs `COMMERCE_LIVE_PAYMENTS_ENABLED=true` (default `false`).
2. The superintendent turns it on: **Clubs & Sports → Ticketing & revenue →
   District settings** (`PUT /api/commerce/settings`, `commerce:settings`).

Both are needed. With either one off, a priced ticket answers 503
`paid_ticketing_not_configured` (reason `district_payment_provider_not_connected`
or `district_commerce_disabled`), as in 37.6. Free tickets work either way.

## The money model (deck p39-p40)

All amounts are integer cents. A rate is basis points (1% = 100 bps).

**Event tickets** (school commerce). In order:

| Line | Rate (default) | Goes to |
| --- | --- | --- |
| gross | the price × quantity | (paid by the guardian) |
| processing_fee | the account's fee estimate (default 2.9% + 30¢; BTCPay 0) | processor |
| sales_tax | district setting, default 0% | tax authority |
| network_fee | 3% of gross | EduOS platform |
| school_share | 85% of net | the school |
| district_share | 10% of net | the district |
| state_share | 5% of net | the state fund (label is a setting) |

"Net" is gross minus processing, tax and network fee. The split percentages
are a district setting; they must add up to 100%.

**Marketplace licenses**: gross, processing_fee, marketplace_fee (5% to the
platform), vendor_payable (the rest).

**Rounding is deterministic.**

- A percentage of an amount rounds half up to the cent.
- The 85/10/5 split gives each share the floor of its exact amount. The
  leftover cents (at most two) go to the largest fractional remainders. Ties
  go in the fixed order school, district, state.
- The lines always add up exactly to gross. A sale whose fees would exceed
  its price is refused (`price_below_fees`).

**Deck check.** The deck's worked example (gross $10,000, processing $290,
9% tax, 3% network fee, net $8,510) gives exactly $7,233.50 / $851.00 /
$425.50 (unit test). The deck's $290 is 2.9% without the 30¢ per-transaction
part, so a real payment of that size would show $290.30.

## Flows

**Ticket checkout** (`POST /api/events/:id/tickets` on a priced ticket type):

1. Only a parent or guardian linked to a child at the school can pay. Pupils
   get 403 `guardian_payment_required`. EduOS has no student birth dates, so
   this is stricter than an "under 13" rule: no student can pay.
2. The seats are held (`sold_count` goes up) for `hold_minutes` (default 10).
   The order is `payment_pending`, and a sandbox payment is created
   (`requires_confirmation`). Repeating the same idempotency key returns the
   same payment.
3. `POST /api/commerce/payments/:id/confirm`, payer only. Sandbox: with
   `testOutcome` `sandbox_success` or `sandbox_decline`. A processor
   payment (37.7.1): the payer first completes the processor's page
   (`redirectUrl`); confirm then asks the processor and may answer
   `pending`. Holds for processor payments are at least 20 minutes.
   - **Success:** the payment `succeeded`; the order is `paid`; the tickets are
     issued (codes shown once, as QR; only sha256 hashes are stored); the
     settlement is recorded.
   - **Decline:** the seats are released and the order is `cancelled`.
   - **Expired hold:** the seats are released and the payment is `expired`.
4. Staff check tickets in at the gate (`POST /api/events/:id/check-in`).

**Refund** (`POST /api/commerce/payments/:id/refund`, `commerce:refund`):

- Who: the school's principal, or the superintendent. Marketplace purchases:
  the superintendent only.
- Whole order only. Refused if any ticket on the order was already scanned.
- Effect: the tickets are marked refunded, the seats go back on sale, and the
  ledger records the exact negation of the settlement.
- The sandbox assumes the processor returns its fee too. Real processors often
  keep it; decide that when choosing one.

**Marketplace** (`commerce:purchase`, superintendent):

1. Price a listing (`POST /api/commerce/marketplace/listings/:id/price`,
   per seat or flat).
2. Pay for an approved license: `POST /api/commerce/marketplace/fee-events/:id/checkout`,
   one purchase per fee event from the 37.6 hook. Seat-priced licenses use
   the license's seat limit.
3. Confirm through the same confirm route.

## Records

- `commerce_payments`: amount, payer and fee never change. Status only moves
  forward (`requires_confirmation` → `succeeded` / `declined` / `expired`;
  `succeeded` → `refunded`). Enforced by trigger.
- `commerce_ledger_entries`: append-only. Settlement lines are ≥ 0, refund
  lines ≤ 0.
- `commerce_receipts`: append-only. A receipt number like `R-20261117-ABCDEF0123`.
- Ledger and receipts are written only by the definer function
  `eduos_commerce_record()`. It checks:
  - the caller's right: the payer settles; a leader refunds;
  - the EDAL entry: the caller's, the right kind, its payload hash matches,
    and it names this payment and these exact lines;
  - the arithmetic: lines sum to gross; a refund reverses the settlement line
    for line.

  The runtime role cannot insert ledger or receipt rows directly.
- **EDAL:** every settlement and refund is an EDAL entry (`commerce_settlement`,
  `commerce_refund`) on the district's hash chain, with no student subject.
  The receipt shows its EDAL sequence number and hash.
- **Audit:** checkout, confirm, decline, hold expiry, refund, settings, price
  and report reads are audited.

## Who sees what

| Role | Can |
| --- | --- |
| Parent / guardian | Buy, pay, see their own payments, receipts and tickets. |
| Pupil | Get free tickets; see their own tickets. Never pays. |
| Teacher | Check tickets in for activities they staff (unchanged). |
| Principal | Their school's revenue report, payments, receipts and refunds; ticket types; gate check-in. |
| Superintendent | Settings, every school's report, refunds, marketplace purchases. |

Enforced by RLS as well as the API:

- Families see only their own ticket orders and tickets (a new restrictive
  policy on top of 056's school scope).
- Payments: the payer, that school's principal, or the superintendent.
- The ledger: leaders only.

## Data and retention

- No commerce table stores a student id. The payer is the adult account (or
  the district).
- Nothing tracks location, scans faces, scores threats or predicts anything
  about minors.
- Retention (`eduos_retention_feature_commerce`) releases stale holds. The
  financial records are kept for audit; nothing is purged.

## Also fixed

On 37.6 the runtime role had no UPDATE on `event_tickets` or
`event_ticket_orders`. So staff check-in (`SELECT … FOR UPDATE`, then
`UPDATE`) and a buyer's code recovery would fail with "permission denied".
Integration tests never exercised them.

065 grants only these columns:

- orders: `status`, `provider_reference`, `paid_at`, `refunded_at`;
- tickets: `status`, `checked_in_at`, `checked_in_by`, `ticket_code_hash`.

Guard triggers allow only forward transitions:

- orders: `payment_pending` → `paid` / `cancelled`; `paid` → `refunded`;
- tickets: `issued` → `checked_in` / `cancelled` / `refunded`.

## Webhook intake and recovery (37.8.0)

PayPal, Square and BTCPay now have a public, tokenized callback route and a
durable verified-event inbox. Provider signatures are checked against the
original request bytes. The intake route does not settle payments. A scheduled
worker claims events with a five-minute lease, revalidates the payment and
ticket hold, then invokes the existing settlement transaction. Duplicate
provider event IDs are idempotent; invalid or unmatched events cannot issue
tickets.

Events that exhaust 20 attempts appear in the provider administrator's dead
letter view. Captures received after a ticket hold expires are routed to a
separate refund-case queue; they do not issue tickets or enter the settlement
ledger. The district operator must refund through the provider and record the
resolution in EduOS. Configure `COMMERCE_RECONCILE_INTERVAL_SECONDS` (default
60; 0 disables both payment reconciliation and webhook processing).

See `COMMERCE-PROVIDERS.md` for endpoint provisioning, provider dashboard
configuration, rotation/revocation, operator routes and the sandbox launch
checklist.

## Not done (needs a decision before real money)

- **Live-provider validation.** CI uses mocked transports and makes no live
  provider calls. Each district must test its own sandbox credentials,
  hosted checkout, webhook delivery, duplicate events, late captures and
  provider-side refunds before enabling real payments.
- **Payouts and financial operations.** Payouts to schools, vendors and the
  state fund; partial refunds, chargebacks, disputes and jurisdiction-specific
  sales tax remain incomplete.
- **Legal and finance review.** Terms, refund policy, public-school
  procurement/accounting rules, tax treatment and state rules on fees charged
  to families must be reviewed before launch. GAP-ANALYSIS lists commerce as
  high risk.
- **Venmo and PayPal card fields:** require PayPal's JavaScript SDK buttons
  and card fields embedded in the page.
- **Flutter:** family ticket checkout exists, but leader payment settings,
  provider endpoint management, revenue, refund-case and dead-letter screens
  remain web only.
