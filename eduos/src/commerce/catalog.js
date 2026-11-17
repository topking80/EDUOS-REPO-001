// EduOS 37.7.1 commerce: what a district can set up, and how each choice
// really works. Two layers:
//   PROCESSORS  the accounts that hold money and need credentials
//               (PayPal, Square, BTCPay Server) plus the built-in sandbox.
//   METHODS     what families see at checkout. Several run through one
//               processor: Venmo through PayPal, Visa/Mastercard through
//               whichever processor the district picks, Cash App Pay
//               through Square.
// Every link below was checked against the provider's official site on
// 2026-11-17 (see docs/COMMERCE-PROVIDERS.md).

export const MODES = Object.freeze(["test", "live"]);

const f = (key, label, { secret = false, required = true, placeholder = "", pattern = null, max = 500 } = {}) =>
  Object.freeze({ key, label, secret, required, placeholder, pattern, max });

export const PROCESSORS = Object.freeze({
  sandbox: Object.freeze({
    id: "sandbox", label: "EduOS sandbox", credentials: false, fields: Object.freeze([]),
    defaultFee: Object.freeze({ bps: 290, fixedCents: 30 }),
    description: "Built in. Lets you try every screen with pretend payments: no account, no money."
  }),
  paypal: Object.freeze({
    id: "paypal", label: "PayPal", credentials: true,
    hosts: Object.freeze({ test: "api-m.sandbox.paypal.com", live: "api-m.paypal.com" }),
    fields: Object.freeze([
      f("clientId", "Client ID", { pattern: "^[A-Za-z0-9_-]{10,128}$", max: 128 }),
      f("clientSecret", "Secret", { secret: true, max: 256 }),
      f("webhookId", "Webhook ID (optional, for notifications)", { required: false, pattern: "^[A-Za-z0-9-]{6,64}$", max: 64 })
    ]),
    defaultFee: Object.freeze({ bps: 290, fixedCents: 30 }),
    description: "PayPal Checkout through the Orders v2 API. Families approve on PayPal's own page; EduOS never sees their login or card."
  }),
  square: Object.freeze({
    id: "square", label: "Square", credentials: true,
    hosts: Object.freeze({ test: "connect.squareupsandbox.com", live: "connect.squareup.com" }),
    fields: Object.freeze([
      f("accessToken", "Access token", { secret: true, max: 256 }),
      f("locationId", "Location ID", { pattern: "^[A-Za-z0-9]{6,64}$", max: 64 }),
      f("webhookSignatureKey", "Webhook signature key (optional)", { secret: true, required: false, max: 256 }),
      f("webhookUrl", "Webhook notification URL (optional)", { required: false, pattern: "^https://", max: 500 })
    ]),
    defaultFee: Object.freeze({ bps: 290, fixedCents: 30 }),
    description: "Square's hosted checkout (Checkout API payment links). Cards, Apple Pay and Google Pay, and Cash App Pay for US sellers."
  }),
  btcpay: Object.freeze({
    id: "btcpay", label: "BTCPay Server", credentials: true,
    hosts: null, // self-hosted: the district's own server, which must be listed in COMMERCE_ALLOWED_HOSTS
    fields: Object.freeze([
      f("serverUrl", "Your BTCPay Server URL", { pattern: "^https://", placeholder: "https://btcpay.example.org", max: 300 }),
      f("storeId", "Store ID", { pattern: "^[A-Za-z0-9]{8,64}$", max: 64 }),
      f("apiKey", "Greenfield API key", { secret: true, max: 256 }),
      f("webhookSecret", "Webhook secret (optional)", { secret: true, required: false, max: 256 })
    ]),
    defaultFee: Object.freeze({ bps: 0, fixedCents: 0 }),
    description: "Free, open-source and self-hosted. Payments go straight to the district's own wallet; there is no company in the middle and no processing fee."
  })
});

const L = (label, url) => Object.freeze({ label, url });

// The six quick-setup cards (plus the sandbox), in the order shown.
export const METHODS = Object.freeze({
  paypal: Object.freeze({
    id: "paypal", label: "PayPal", processors: Object.freeze(["paypal"]), setupProcessor: "paypal",
    description: "Families pay with their PayPal account on PayPal's page, then come back to EduOS for their tickets.",
    signup: L("Open a PayPal Business account", "https://www.paypal.com/us/business"),
    developer: L("PayPal Developer dashboard (sandbox and live app credentials)", "https://developer.paypal.com/dashboard/"),
    docs: Object.freeze([L("Orders v2 checkout guide", "https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard"),
      L("Sandbox testing", "https://developer.paypal.com/tools/sandbox/"), L("Webhooks", "https://developer.paypal.com/api/rest/webhooks/rest/")]),
    adapter: "ready"
  }),
  card: Object.freeze({
    id: "card", label: "Visa / Mastercard", processors: Object.freeze(["square", "paypal"]), setupProcessor: null,
    description: "Visa and Mastercard are card networks, not processors: they don't sign up schools directly. Cards are accepted through a processor, so pick which of your processors handles them.",
    signup: L("Visa: how businesses accept Visa", "https://corporate.visa.com/en/solutions/acceptance.html"),
    developer: L("Mastercard: accepting payments", "https://www.mastercard.com/us/en/business/industry-segment/small-medium-business/digital-doors/payment.html"),
    docs: Object.freeze([L("Square hosted checkout (cards)", "https://developer.squareup.com/docs/checkout-api"),
      L("PayPal advanced card payments", "https://developer.paypal.com/docs/checkout/advanced/")]),
    // Cards through Square's hosted page work now. Cards through PayPal need
    // PayPal's card fields on the EduOS page (PayPal's JavaScript SDK), which
    // isn't built yet.
    adapter: Object.freeze({ square: "ready", paypal: "coming" }),
    comingReason: "Cards through PayPal need PayPal's card fields embedded in the EduOS page. That adapter isn't built yet; choose Square for cards."
  }),
  square: Object.freeze({
    id: "square", label: "Square", processors: Object.freeze(["square"]), setupProcessor: "square", methodless: true,
    description: "Connect your Square account. Square then handles Visa/Mastercard (choose it on the card tile) and Cash App Pay.",
    signup: L("Sign up for Square", "https://squareup.com/signup"),
    developer: L("Square Developer (sandbox and production tokens)", "https://developer.squareup.com/us/en"),
    docs: Object.freeze([L("Checkout API (payment links)", "https://developer.squareup.com/docs/checkout-api"),
      L("Sandbox", "https://developer.squareup.com/docs/devtools/sandbox/overview"),
      L("Checkout limits (sandbox is cards only)", "https://developer.squareup.com/docs/checkout-api/guidelines-and-limitations"),
      L("Validating webhooks", "https://developer.squareup.com/docs/webhooks/step3validate")]),
    adapter: "ready"
  }),
  bitcoin: Object.freeze({
    id: "bitcoin", label: "Bitcoin", processors: Object.freeze(["btcpay"]), setupProcessor: "btcpay",
    description: "Through BTCPay Server, which the district (or a host it chooses) runs. Families pay a bitcoin or Lightning invoice on BTCPay's page.",
    signup: L("BTCPay Server", "https://btcpayserver.org/"),
    developer: L("Deploying BTCPay Server", "https://docs.btcpayserver.org/Deployment/"),
    docs: Object.freeze([L("Greenfield API", "https://docs.btcpayserver.org/Developers/api/"),
      L("E-commerce integration guide (invoices, webhooks, refunds)", "https://docs.btcpayserver.org/Development/ecommerce-integration-guide/")]),
    notes: Object.freeze([
      "Bitcoin's price moves. Tickets are priced in dollars and the invoice locks the bitcoin amount for a short window; the district carries any change after that unless BTCPay converts on receipt.",
      "Refunds are made in dollars by the district, outside EduOS. EduOS records the refund in the ledger; it does not send bitcoin back.",
      "Check your state's rules (and your auditors) before accepting cryptocurrency for a public school.",
      "Other options checked: Square Bitcoin works at Square's own point of sale but has no API for this; Coinbase Commerce closed on March 31, 2026, and its successor, Coinbase Business, is built around stablecoins."
    ]),
    otherLinks: Object.freeze([L("Square Bitcoin (point of sale only)", "https://squareup.com/us/en/bitcoin"), L("Coinbase Business", "https://www.coinbase.com/business")]),
    adapter: "ready"
  }),
  venmo: Object.freeze({
    id: "venmo", label: "Venmo", processors: Object.freeze(["paypal"]), setupProcessor: null,
    description: "Venmo checkout for businesses runs through PayPal (or Braintree). Connect PayPal first; Venmo is US-only and uses the same PayPal account.",
    signup: L("Venmo for Business", "https://venmo.com/business/"),
    developer: L("Pay with Venmo (PayPal)", "https://developer.paypal.com/docs/checkout/pay-with-venmo/"),
    docs: Object.freeze([L("Venmo through Braintree", "https://developer.paypal.com/braintree/docs/guides/venmo/overview")]),
    adapter: "coming",
    comingReason: "Venmo needs PayPal's Venmo button on the EduOS page (PayPal's JavaScript SDK). That adapter isn't built yet, so checkout won't offer Venmo."
  }),
  cash_app: Object.freeze({
    id: "cash_app", label: "Cash App", processors: Object.freeze(["square"]), setupProcessor: null,
    description: "Cash App Pay reaches merchants through Square, Afterpay or Adyen. EduOS uses Square: connect Square first. US sellers only.",
    signup: L("Cash App Pay for businesses", "https://developers.cash.app/home"),
    developer: L("Cash App Pay partners (Square, Afterpay, Adyen)", "https://developers.cash.app/cash-app-pay-partner-api/guides/partnerships/partner-with-cash-app-pay"),
    docs: Object.freeze([L("Cash App Pay with Square", "https://developer.squareup.com/docs/web-payments/add-cash-app-pay"),
      L("Cash App Pay with Adyen", "https://docs.adyen.com/payment-methods/cash-app-pay/web-drop-in/")]),
    notes: Object.freeze(["Square's sandbox can't test Cash App Pay (cards only), so test mode shows the card form."]),
    adapter: "ready"
  }),
  sandbox: Object.freeze({
    id: "sandbox", label: "Sandbox (test checkout)", processors: Object.freeze(["sandbox"]), setupProcessor: null,
    description: "Pretend payments for training and testing. Pick success or decline; nothing is charged.",
    adapter: "ready"
  })
});

/** Methods families can be offered (Square itself is a processor tile, not a checkout button). */
export const CHECKOUT_METHODS = Object.freeze(Object.values(METHODS).filter(m => !m.methodless).map(m => m.id));

/** Which processor carries a method for this district (card: the district's pick). */
export function processorFor(method, setup = {}) {
  const m = METHODS[method];
  if (!m || m.methodless) return null;
  if (method === "card") return m.processors.includes(setup.card_processor) ? setup.card_processor : null;
  return m.processors[0];
}
/** "ready" or "coming" for a method on a processor. */
export function adapterState(method, processor) {
  const a = METHODS[method]?.adapter;
  if (!a) return "coming";
  return typeof a === "string" ? a : (a[processor] || "coming");
}
export function allLinks() {
  const out = [];
  for (const m of Object.values(METHODS)) for (const l of [m.signup, m.developer, ...(m.docs || []), ...(m.otherLinks || [])]) if (l) out.push(l.url);
  return [...new Set(out)];
}
