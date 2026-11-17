# District payment providers (37.7.1 candidate)

Each district chooses how families pay. Setup lives in the app at
**Clubs & Sports → Ticketing & revenue → Payment options** (superintendent)
or **Data links → Payment options** (district IT). Nothing is preselected:
a new district offers no payment option, so paid tickets stay off until it
connects one. The built-in sandbox (pretend payments) is still available.

**Live money is off by default.** A district can only take real payments when
both are true:

1. the server sets `COMMERCE_LIVE_PAYMENTS_ENABLED=true` (default `false`); and
2. the district saved **live** credentials for that account.

Test (processor sandbox) credentials work without the switch. With the switch
off, a live account shows "Live, switched off on server" and checkout,
confirm, refund and test-connection calls to it answer 503
`live_payments_disabled`.

## The quick-setup cards

| Card | How it really works | Account EduOS talks to | In EduOS today |
| --- | --- | --- | --- |
| PayPal | Families approve on PayPal's page (Orders v2, redirect), then return to EduOS, which captures. | PayPal REST app (client ID + secret) | **Ready** (test and live) |
| Visa / Mastercard | Card networks, not processors: they don't sign up schools. The district picks which processor takes cards. | Square (or PayPal) | **Ready through Square** (hosted payment link). Through PayPal: adapter coming (needs PayPal's card fields in the page). |
| Square | The district's Square account; hosted checkout (Checkout API payment links). Also carries cards and Cash App Pay. | Square access token + location ID | **Ready** (sandbox and production) |
| Bitcoin | The district's own BTCPay Server (free, self-hosted). Families pay a bitcoin/Lightning invoice on BTCPay's page. | BTCPay Greenfield API key + store ID | **Ready** (refunds are manual, in dollars) |
| Venmo | Business checkout runs through PayPal (or Braintree), using the same PayPal account. US only. | PayPal | **Adapter coming**: needs PayPal's Venmo button (JavaScript SDK) in the page. Config is saved; checkout refuses it (503 `payment_adapter_not_available`). |
| Cash App | Cash App Pay reaches merchants through Square, Afterpay or Adyen. EduOS uses Square. | Square | **Ready through Square** (the payment link offers Cash App Pay). Square's sandbox tests cards only. |

Each card shows a description, official sign-up / developer / docs links,
credential fields, **Test connection**, and a status: *Not set up*, *Test*,
*Live*, or *Live, switched off on server*. Above the cards, the district
chooses which options families see, which is shown first, and who
processes Visa/Mastercard.

### Bitcoin notes (shown on the card)

- Price moves: tickets are priced in dollars; BTCPay locks the bitcoin amount
  for a short invoice window. After that the district carries the change
  unless BTCPay converts on receipt.
- Refunds are paid in dollars by the district, outside EduOS. EduOS records
  the refund in the ledger (`manual_fiat_…`) and tells the refunder; it never
  sends bitcoin.
- Check state rules and auditors before a public school accepts
  cryptocurrency.
- Checked and not used: **Coinbase Commerce closed on March 31, 2026**; its
  successor Coinbase Business is built around stablecoins. **Square Bitcoin**
  works at Square's own point of sale, Online Store and Invoices, with no API
  EduOS can call.

## Official links (all checked 2026-11-17)

Every link loaded on 2026-11-17: 25 returned HTTP 200 to a plain request; the
PayPal Business and Mastercard pages block scripted requests (403) and were
checked in a browser-style fetch instead. Pages that didn't load were not
used (mastercard.us pages, Visa's usa.visa.com small-business page).

### PayPal

- [Open a PayPal Business account](https://www.paypal.com/us/business)
- [PayPal Developer dashboard (sandbox and live app credentials)](https://developer.paypal.com/dashboard/)
- [Orders v2 checkout guide](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard)
- [Sandbox testing](https://developer.paypal.com/tools/sandbox/)
- [Webhooks](https://developer.paypal.com/api/rest/webhooks/rest/)

### Visa / Mastercard

- [Visa: how businesses accept Visa](https://corporate.visa.com/en/solutions/acceptance.html)
- [Mastercard: accepting payments](https://www.mastercard.com/us/en/business/industry-segment/small-medium-business/digital-doors/payment.html)
- [Square hosted checkout (cards)](https://developer.squareup.com/docs/checkout-api)
- [PayPal advanced card payments](https://developer.paypal.com/docs/checkout/advanced/)

### Square

- [Sign up for Square](https://squareup.com/signup)
- [Square Developer (sandbox and production tokens)](https://developer.squareup.com/us/en)
- [Checkout API (payment links)](https://developer.squareup.com/docs/checkout-api)
- [Sandbox](https://developer.squareup.com/docs/devtools/sandbox/overview)
- [Checkout limits (sandbox is cards only)](https://developer.squareup.com/docs/checkout-api/guidelines-and-limitations)
- [Validating webhooks](https://developer.squareup.com/docs/webhooks/step3validate)

### Bitcoin

- [BTCPay Server](https://btcpayserver.org/)
- [Deploying BTCPay Server](https://docs.btcpayserver.org/Deployment/)
- [Greenfield API](https://docs.btcpayserver.org/Developers/api/)
- [E-commerce integration guide (invoices, webhooks, refunds)](https://docs.btcpayserver.org/Development/ecommerce-integration-guide/)
- [Square Bitcoin (point of sale only)](https://squareup.com/us/en/bitcoin)
- [Coinbase Business](https://www.coinbase.com/business)

### Venmo

- [Venmo for Business](https://venmo.com/business/)
- [Pay with Venmo (PayPal)](https://developer.paypal.com/docs/checkout/pay-with-venmo/)
- [Venmo through Braintree](https://developer.paypal.com/braintree/docs/guides/venmo/overview)

### Cash App

- [Cash App Pay for businesses](https://developers.cash.app/home)
- [Cash App Pay partners (Square, Afterpay, Adyen)](https://developers.cash.app/cash-app-pay-partner-api/guides/partnerships/partner-with-cash-app-pay)
- [Cash App Pay with Square](https://developer.squareup.com/docs/web-payments/add-cash-app-pay)
- [Cash App Pay with Adyen](https://docs.adyen.com/payment-methods/cash-app-pay/web-drop-in/)

## Setting it up

1. **District IT** sets on the server:
   - `COMMERCE_SECRETS_KEY`: 32+ random characters. Encrypts credentials at
     rest (AES-256-GCM, bound to district and processor). Without it nothing
     can be saved.
   - `COMMERCE_ALLOWED_HOSTS`: the BTCPay Server host(s), if using Bitcoin.
     PayPal and Square hosts are fixed in code.
   - leaves `COMMERCE_LIVE_PAYMENTS_ENABLED=false` until the district is ready.
2. **Superintendent or district IT** opens Payment options, follows the card's
   sign-up and developer links, pastes **test** credentials, saves, presses
   **Test connection**.
3. Ticks the options families should see, picks the default and the card
   processor, saves.
4. **Superintendent** turns paid tickets on (Ticketing & revenue → District
   settings).
5. To go live: live credentials, mode *Live* (the app asks to confirm), and
   the server switch.

## Security

- **Credentials are write-only.** The API returns only which secret fields are
  set, never a value; a blank secret field keeps the saved one; "Remove
  credentials" clears them. The audit log records field names only.
- `commerce_provider_accounts` (migration 066): RLS by district, plus a
  restrictive policy so only the superintendent and district IT can read or
  change it (principals, teachers and families get nothing). A CHECK refuses
  any secret key in the plain `config` column, and `secrets_enc` must be a
  sealed `c1.` blob.
- Checkout reads an account through the definer function
  `eduos_commerce_checkout_account()`, which returns the caller's own
  district only.
- Every outbound call goes through the shared HTTP client with a host
  allowlist (`api-m[.sandbox].paypal.com`, `connect.squareup[sandbox].com`,
  the allowed BTCPay host, https only) and a timeout.
- EduOS never handles a card number, PayPal login or wallet: payers use the
  processor's hosted page (redirect), which keeps EduOS out of PCI card-data
  scope (SAQ A-style; confirm with your processor).
- Amounts are checked on confirm: a processor total that doesn't match the
  order is refused (`provider_amount_mismatch`) and nothing is issued.
- A payment that completes after the seat hold ran out (Square, BTCPay) is
  flagged in the audit log for a manual refund.

## Processor calls and recovery

No processor call (PayPal, Square, BTCPay; test connection included) runs
while a database transaction is open. A slow or hung processor would
otherwise hold row locks (seats, the order) and a pooled connection for the
length of the call. Each call is three steps:

1. **Reserve and commit.** Checkout holds the seats and records the payment
   as `creating`. Confirm marks the payment in flight (`pending_since`, who
   started it) and stretches the seat hold to at least five minutes. A refund
   moves the payment to `refund_pending` and marks the ticket order
   `refund_pending`, so gate check-in refuses its tickets
   (`ticket_refund_pending`) until the refund is settled one way or the other.
2. **Call the processor**, with no transaction open, under an idempotency key
   taken from the payment: PayPal `PayPal-Request-Id` (order, capture,
   refund), Square `idempotency_key` (payment link, refund). BTCPay Server's
   API has no idempotency key, so a create first looks for the payment's
   invoice by `orderId` and reuses it unless it expired or is invalid.
3. **Record the answer in a new transaction.** If the processor failed, a
   checkout is declined (`provider_unavailable`) and the seats are released;
   a refund goes back to paid; the API answers 502 with the processor's
   error code.

If the API stops between steps 1 and 3 (crash, deploy), the payment stays
in flight. Every `COMMERCE_RECONCILE_INTERVAL_SECONDS` (default 60; 0 = off)
the API lists each district's calls in flight for longer than
`COMMERCE_RECONCILE_STALE_SECONDS` (default 90) through
`eduos_commerce_stale_payments()`, repeats the same idempotent call as the
user who started it, and records the answer (audit detail
`reconciled=true`). A family that retries checkout with the same
idempotency key also finishes a cut-off create. A sandbox confirm cut off
midway is simply cleared: its outcome is the payer's choice.

Tests: `test/integration/commerce-providers.test.js` checks
`pg_stat_activity` from inside the mock processor on every call (no EduOS
transaction may be open), kills the API mid-checkout and mid-refund, and
checks the sweep finishes each exactly once.

## API

| Route | Who | |
| --- | --- | --- |
| `GET /api/commerce/providers` | superintendent, it_admin | Cards, accounts (no secrets), setup, live switch |
| `PUT /api/commerce/providers/:processor` | same, CSRF | Save config / secrets / mode / fee / on-off |
| `POST /api/commerce/providers/:processor/test` | same, CSRF | Test connection (audited) |
| `PUT /api/commerce/payment-methods` | same, CSRF | Offered methods, default, card processor |
| `GET /api/commerce/status` | anyone signed in | Ready methods only, default, note |

Checkout (`POST /api/events/:id/tickets`, marketplace checkout) takes an
optional `paymentMethod`; otherwise the district default. A processor payment
comes back with `redirectUrl`; the processor returns the payer to
`/app/?commerce_return=<payment id>`, and the app calls
`POST /api/commerce/payments/:id/confirm` (no `testOutcome`), which asks the
processor and settles, declines, or answers `pending`.

## Not done yet

- **Webhooks.** Signature checks are written and unit-tested (PayPal's verify
  API, Square's HMAC including its documented example, BTCPay's `BTCPay-Sig`),
  but there is no public webhook endpoint yet; confirmation happens when the
  payer returns or presses "I've paid".
- **Venmo, and cards through PayPal**: need PayPal's JavaScript SDK buttons
  and card fields embedded in the page.
- **Never run against the real providers.** All adapter tests use mocks (CI
  makes no network calls). Before going live, a district should run one
  test-mode payment end to end with its own sandbox account.
- Payouts to schools, vendors and the state fund; reconciliation; partial
  refunds; disputes; sales tax by jurisdiction; legal review of fees charged
  to families (see `COMMERCE-SANDBOX.md`).
- Flutter has the "Pay with" picker and processor checkout for families; the
  Payment options screen is web only.
