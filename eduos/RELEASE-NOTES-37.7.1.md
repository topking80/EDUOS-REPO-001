# EduOS District Edition 37.7.1

**Release type:** Feature increment (commerce)
**Base:** 37.7.0 (`RELEASE-NOTES-37.7.0.md`: the 37.6 and 37.7.0 features and
the 2026-11-17 audit hardening)
**Status:** On `feat/37.7-commerce-sandbox`. Not deployed. No real processor
has been called: every adapter test uses mocks and CI makes no network calls.

## District payment providers

Each district chooses its own payment options instead of one server-wide
setting. Details: `docs/COMMERCE-PROVIDERS.md` and
`docs/release-candidates/37.7.1-commerce-providers.md`.

- Quick-setup cards (Payment options): PayPal, Visa/Mastercard (through Square
  or PayPal), Square, Bitcoin (the district's BTCPay Server), Venmo and Cash
  App, plus the no-money sandbox. Superintendent and district IT only.
- Credentials sealed at rest with `COMMERCE_SECRETS_KEY`, write-only, audited
  by field name. RLS by district.
- Adapters: PayPal Orders v2, Square payment links (cards, Cash App Pay),
  BTCPay Greenfield invoices. Venmo and cards-through-PayPal are saved but
  checkout refuses them until their embedded buttons exist.
- Live payments stay off unless `COMMERCE_LIVE_PAYMENTS_ENABLED=true` and the
  district saved live credentials.

## Processor calls outside database transactions

Answers decision 2 of the 2026-11-17 audit review: no PayPal, Square or
BTCPay call runs inside an open database transaction.

- Checkout, confirm, refund and Test connection now reserve and commit, call
  the processor with no transaction open, then record the answer in a new
  transaction.
- Idempotent: PayPal `PayPal-Request-Id` and Square `idempotency_key`, keyed
  by the payment; BTCPay (no idempotency key in its API) looks up the
  payment's invoice by `orderId` before creating one. BTCPay manual refund
  references are derived from the invoice, so a retry records the same one.
- New payment states `creating` and `refund_pending`, and an in-flight marker
  (`pending_since`, `pending_actor`). The reconcile sweep finishes calls cut
  off by a crash or deploy: `COMMERCE_RECONCILE_INTERVAL_SECONDS` (default
  60, 0 = off), `COMMERCE_RECONCILE_STALE_SECONDS` (default 90).
- A processor failure at checkout releases the seats (payment declined,
  `provider_unavailable`); a refused refund puts the payment back as paid.
- Gate check-in refuses a ticket while its refund is in flight
  (`ticket_refund_pending`).

## Deploying

- Migration `066_commerce_district_providers.sql` (also on databases that
  already ran 067; the migrator applies files by name), then re-apply
  `db/runtime_grants.template.sql`.
- New settings: `COMMERCE_SECRETS_KEY`, `COMMERCE_ALLOWED_HOSTS`,
  `COMMERCE_LIVE_PAYMENTS_ENABLED`, `COMMERCE_RECONCILE_INTERVAL_SECONDS`,
  `COMMERCE_RECONCILE_STALE_SECONDS` (see `.env.example`).
  `COMMERCE_PAYMENT_PROVIDER` is removed.

## Tests

- `test/integration/commerce-providers.test.js`: the mock processor checks
  `pg_stat_activity` on every call and finds no EduOS transaction open (on
  the previous commit, 44 of 44 calls found one); the API is killed
  mid-checkout and mid-refund and the sweep finishes each exactly once under
  the same idempotency key; processor failures release seats or restore the
  payment.
- `test/commerce-providers-37.7.1.test.js`: BTCPay invoice reuse by
  `orderId`, stable manual refund references, migration and grants.
