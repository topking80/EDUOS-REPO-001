// EduOS 37.7.1 commerce: processor adapters. Each one talks to its
// provider's documented REST API, in test mode against the provider's
// sandbox host and in live mode against production (live is refused unless
// COMMERCE_LIVE_PAYMENTS_ENABLED=true; the service checks before building
// one). Every flow is a hosted page: the family pays on PayPal's, Square's or
// BTCPay's own page, so EduOS never handles a card number or wallet login.
//
// Adapters are pure: the HTTP transport, base URL and host allowlist are
// passed in (src/commerce/service.js supplies the real ones; tests supply a
// mock, so CI makes no network calls).
//
// Interface (every adapter, including the sandbox in payments.js):
//   name, live, checkout: true
//   feeFor(amountCents)                         -> estimated processing fee (cents)
//   testConnection()                            -> { ok: true, detail }
//   createPayment({ amountCents, currency, reference, description, returnUrl, cancelUrl, method })
//                                               -> { providerRef, status: "requires_action", redirectUrl }
//   confirmPayment(providerRef, { amountCents, currency })
//                                               -> { status: "succeeded", captureRef } | { status: "declined", declineCode } | { status: "pending" }
//   refundPayment(providerRef, amountCents, { captureRef })
//                                               -> { status: "refunded", refundRef, manual? }
//   verifyWebhook({ headers, rawBody })         -> boolean (async for PayPal)
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { pctOf, MAX_CENTS } from "./split.js";

export class ProviderError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}
const amountOk = a => Number.isSafeInteger(a) && a > 0 && a <= MAX_CENTS;
const dollars = c => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const toCents = v => { const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(v ?? "")); return m ? Number(m[1]) * 100 + Number((m[2] || "0").padEnd(2, "0")) : NaN; };
const safeEq = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
const header = (headers, name) => { const v = headers?.[name] ?? headers?.[name.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
const idem = (...parts) => createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 40);

function feeFn({ bps = 290, fixedCents = 30 } = {}) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 1500 || !Number.isInteger(fixedCents) || fixedCents < 0 || fixedCents > 1000) throw new RangeError("fee estimate out of range");
  return amountCents => { if (!amountOk(amountCents)) throw new RangeError("amount out of range"); return pctOf(amountCents, bps) + fixedCents; };
}
function checkPayment({ amountCents, currency }) {
  if (!amountOk(amountCents)) throw new RangeError("invalid payment");
  if (currency !== "USD") throw new ProviderError("currency_not_supported", currency);
}

/** A JSON client over the injected transport; maps HTTP failures to ProviderError codes, never echoing bodies. */
function jsonClient({ transport, base, allowedHosts, what }) {
  if (typeof transport !== "function") throw new Error("transport required");
  return async (method, path, { headers = {}, body, form } = {}) => {
    const payload = form ? new URLSearchParams(form).toString() : body === undefined ? null : JSON.stringify(body);
    let r;
    try {
      r = await transport(base + path, { method, body: payload, allowedHosts,
        headers: { accept: "application/json", ...(payload ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" } : {}), ...headers } });
    } catch (e) {
      throw new ProviderError(e?.code === "connector_url_not_allowed" ? "provider_host_not_allowed" : "provider_unreachable", `${what}: ${e?.detail || e?.code || "network"}`);
    }
    let json = null;
    try { json = r.text ? JSON.parse(r.text) : {}; } catch { json = null; }
    if (r.status === 401 || r.status === 403) throw new ProviderError("provider_auth_failed", `${what}: HTTP ${r.status}`);
    if (r.status < 200 || r.status > 299) { const e = new ProviderError("provider_http_error", `${what}: HTTP ${r.status}`); e.status = r.status; e.body = json; throw e; }
    if (json === null) throw new ProviderError("provider_bad_response", `${what}: not JSON`);
    return json;
  };
}

// ---------------- PayPal (Orders v2) ----------------
export function paypalAdapter({ mode, clientId, clientSecret, webhookId = null, fee, transport, base, allowedHosts }) {
  if (!clientId || !clientSecret) throw new ProviderError("provider_credentials_missing", "paypal");
  const call = jsonClient({ transport, base, allowedHosts, what: "paypal" });
  let token = null;
  const auth = async () => {
    if (token) return token;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const j = await call("POST", "/v1/oauth2/token", { form: { grant_type: "client_credentials" }, headers: { authorization: `Basic ${basic}` } });
    if (typeof j.access_token !== "string" || !j.access_token) throw new ProviderError("provider_auth_failed", "paypal: no access_token");
    return (token = j.access_token);
  };
  const authed = async (method, path, opts = {}) => call(method, path, { ...opts, headers: { authorization: `Bearer ${await auth()}`, ...(opts.headers || {}) } });
  const captureOf = order => order?.purchase_units?.[0]?.payments?.captures?.[0] || null;
  return Object.freeze({
    name: "paypal", live: mode === "live", checkout: true, feeFor: feeFn(fee),
    async testConnection() { await auth(); return { ok: true, detail: "token_ok" }; },
    async createPayment({ amountCents, currency, reference, description, returnUrl, cancelUrl }) {
      checkPayment({ amountCents, currency });
      const order = await authed("POST", "/v2/checkout/orders", { headers: { "paypal-request-id": idem("paypal-order", reference) }, body: {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: String(reference).slice(0, 256), description: String(description || "EduOS purchase").slice(0, 127), amount: { currency_code: currency, value: dollars(amountCents) } }],
        payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } } } });
      const link = (order.links || []).find(l => l.rel === "payer-action" || l.rel === "approve");
      if (!order.id || !link?.href) throw new ProviderError("provider_bad_response", "paypal: no approval link");
      return { providerRef: order.id, status: "requires_action", redirectUrl: link.href };
    },
    async confirmPayment(ref, { amountCents, currency } = {}) {
      let order = await authed("GET", `/v2/checkout/orders/${encodeURIComponent(ref)}`);
      if (order.status === "APPROVED") {
        try {
          order = await authed("POST", `/v2/checkout/orders/${encodeURIComponent(ref)}/capture`, { headers: { "paypal-request-id": idem("paypal-capture", ref) }, body: {} });
        } catch (e) {
          const issue = e.body?.details?.[0]?.issue;
          if (e.status === 422 && issue) return { status: "declined", declineCode: String(issue).toLowerCase().replace(/[^a-z_]/g, "_").slice(0, 60) };
          throw e;
        }
      }
      if (order.status === "VOIDED") return { status: "declined", declineCode: "paypal_order_voided" };
      if (order.status !== "COMPLETED") return { status: "pending" };
      const cap = captureOf(order);
      if (!cap) return { status: "pending" };
      if (cap.status === "DECLINED" || cap.status === "FAILED") return { status: "declined", declineCode: "paypal_capture_declined" };
      // A PayPal capture can remain PENDING after the order itself reports
      // COMPLETED. Never settle EduOS while the underlying capture is pending.
      if (cap.status === "PENDING") return { status: "pending" };
      if (cap.status !== "COMPLETED") return { status: "pending" };
      if (amountCents !== undefined && (toCents(cap.amount?.value) !== amountCents || cap.amount?.currency_code !== currency)) throw new ProviderError("provider_amount_mismatch", "paypal");
      if (typeof cap.id !== "string" || !/^[A-Za-z0-9_-]{4,128}$/.test(cap.id)) throw new ProviderError("provider_bad_response", "paypal: invalid capture reference");
      return { status: "succeeded", captureRef: cap.id };
    },
    async refundPayment(ref, amountCents, { captureRef } = {}) {
      if (!captureRef || !amountOk(amountCents)) throw new ProviderError("provider_refund_reference_missing", "paypal");
      const r = await authed("POST", `/v2/payments/captures/${encodeURIComponent(captureRef)}/refund`, { headers: { "paypal-request-id": idem("paypal-refund", captureRef) }, body: {} });
      if (!r.id || !["COMPLETED", "PENDING"].includes(r.status)) throw new ProviderError("provider_refund_failed", `paypal: ${r.status || "unknown"}`);
      return { status: r.status === "COMPLETED" ? "refunded" : "pending", refundRef: r.id };
    },
    // PayPal signs webhooks with a certificate; the documented check is its
    // verify-webhook-signature API. Needs the webhook ID from the dashboard.
    async verifyWebhook({ headers, rawBody }) {
      if (!webhookId) return false;
      let event; try { event = JSON.parse(String(rawBody)); } catch { return false; }
      const need = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"].map(h => header(headers, h));
      if (need.some(v => !v)) return false;
      const r = await authed("POST", "/v1/notifications/verify-webhook-signature", { body: { auth_algo: need[0], cert_url: need[1], transmission_id: need[2],
        transmission_sig: need[3], transmission_time: need[4], webhook_id: webhookId, webhook_event: event } });
      return r.verification_status === "SUCCESS";
    }
  });
}

// ---------------- Square (Checkout API payment links) ----------------
export const SQUARE_VERSION = "2026-09-16";
export function squareAdapter({ mode, accessToken, locationId, webhookSignatureKey = null, webhookUrl = null, fee, transport, base, allowedHosts }) {
  if (!accessToken || !locationId) throw new ProviderError("provider_credentials_missing", "square");
  const call = jsonClient({ transport, base, allowedHosts, what: "square" });
  const sq = (method, path, opts = {}) => call(method, path, { ...opts, headers: { authorization: `Bearer ${accessToken}`, "square-version": SQUARE_VERSION } });
  return Object.freeze({
    name: "square", live: mode === "live", checkout: true, feeFor: feeFn(fee),
    async testConnection() {
      const j = await sq("GET", `/v2/locations/${encodeURIComponent(locationId)}`);
      if (j.location?.status !== "ACTIVE") throw new ProviderError("provider_location_inactive", "square");
      return { ok: true, detail: "location_active" };
    },
    async createPayment({ amountCents, currency, reference, description, returnUrl, method }) {
      checkPayment({ amountCents, currency });
      const j = await sq("POST", "/v2/online-checkout/payment-links", { body: {
        idempotency_key: idem("square-link", reference),
        quick_pay: { name: String(description || "EduOS purchase").slice(0, 255), price_money: { amount: amountCents, currency }, location_id: locationId },
        checkout_options: { redirect_url: returnUrl, allow_tipping: false, ...(method === "cash_app" ? { accepted_payment_methods: { cash_app_pay: true } } : {}) },
        payment_note: String(reference).slice(0, 500) } });
      const link = j.payment_link;
      if (!link?.order_id || !link?.url) throw new ProviderError("provider_bad_response", "square: no payment link");
      return { providerRef: link.order_id, status: "requires_action", redirectUrl: link.url };
    },
    async confirmPayment(ref, { amountCents, currency } = {}) {
      const { order } = await sq("GET", `/v2/orders/${encodeURIComponent(ref)}`);
      if (!order) throw new ProviderError("provider_bad_response", "square: no order");
      if (order.state === "CANCELED") return { status: "declined", declineCode: "square_order_canceled" };
      const tender = (order.tenders || [])[0];
      const due = order.net_amount_due_money?.amount;
      if (!tender || (due !== undefined && due !== 0)) return { status: "pending" };
      if (amountCents !== undefined && (order.total_money?.amount !== amountCents || order.total_money?.currency !== currency)) throw new ProviderError("provider_amount_mismatch", "square");
      return { status: "succeeded", captureRef: tender.payment_id || tender.id };
    },
    async refundPayment(ref, amountCents, { captureRef } = {}) {
      if (!captureRef || !amountOk(amountCents)) throw new ProviderError("provider_refund_reference_missing", "square");
      const j = await sq("POST", "/v2/refunds", { body: { idempotency_key: idem("square-refund", captureRef), payment_id: captureRef, amount_money: { amount: amountCents, currency: "USD" }, reason: "EduOS refund" } });
      if (!j.refund?.id || ["REJECTED", "FAILED"].includes(j.refund.status)) throw new ProviderError("provider_refund_failed", `square: ${j.refund?.status || "unknown"}`);
      return { status: j.refund.status === "COMPLETED" ? "refunded" : "pending", refundRef: j.refund.id };
    },
    // x-square-hmacsha256-signature = base64(HMAC-SHA256(key, notificationUrl + rawBody)).
    verifyWebhook({ headers, rawBody }) { return verifySquareSignature({ signatureKey: webhookSignatureKey, notificationUrl: webhookUrl, rawBody, signature: header(headers, "x-square-hmacsha256-signature") }); }
  });
}
export function verifySquareSignature({ signatureKey, notificationUrl, rawBody, signature }) {
  if (!signatureKey || !notificationUrl || !signature || rawBody === undefined) return false;
  const expected = createHmac("sha256", signatureKey).update(notificationUrl + String(rawBody)).digest("base64");
  return safeEq(expected, signature);
}

// ---------------- BTCPay Server (Greenfield API) ----------------
export function btcpayAdapter({ mode, serverUrl, storeId, apiKey, webhookSecret = null, fee, transport, base, allowedHosts }) {
  if (!serverUrl || !storeId || !apiKey) throw new ProviderError("provider_credentials_missing", "btcpay");
  const call = jsonClient({ transport, base, allowedHosts, what: "btcpay" });
  const bt = (method, path, opts = {}) => call(method, path, { ...opts, headers: { authorization: `token ${apiKey}` } });
  const store = `/api/v1/stores/${encodeURIComponent(storeId)}`;
  return Object.freeze({
    name: "btcpay", live: mode === "live", checkout: true, feeFor: feeFn(fee), manualRefunds: true,
    async testConnection() { const j = await bt("GET", store); if (!j.id) throw new ProviderError("provider_bad_response", "btcpay"); return { ok: true, detail: "store_ok" }; },
    async createPayment({ amountCents, currency, reference, returnUrl }) {
      checkPayment({ amountCents, currency });
      // Greenfield has no idempotency key, so a retried create (the reconcile
      // sweep, or a lost response) first looks for this payment's invoice by
      // its orderId and reuses it while it can still be paid.
      const found = await bt("GET", `${store}/invoices?orderId=${encodeURIComponent(String(reference))}`);
      const prior = Array.isArray(found) ? found.find(i => i?.metadata?.orderId === String(reference) && i.id && i.checkoutLink
        && !["Expired", "Invalid"].includes(i.status) && toCents(i.amount) === amountCents && i.currency === currency) : null;
      if (prior) return { providerRef: prior.id, status: "requires_action", redirectUrl: prior.checkoutLink, reused: true };
      const inv = await bt("POST", `${store}/invoices`, { body: { amount: dollars(amountCents), currency,
        metadata: { orderId: String(reference) }, checkout: { redirectURL: returnUrl, redirectAutomatically: true } } });
      if (!inv.id || !inv.checkoutLink) throw new ProviderError("provider_bad_response", "btcpay: no checkout link");
      return { providerRef: inv.id, status: "requires_action", redirectUrl: inv.checkoutLink };
    },
    async confirmPayment(ref, { amountCents, currency } = {}) {
      const inv = await bt("GET", `${store}/invoices/${encodeURIComponent(ref)}`);
      if (inv.status === "Expired") return { status: "declined", declineCode: "invoice_expired" };
      if (inv.status === "Invalid") return { status: "declined", declineCode: "invoice_invalid" };
      if (inv.status !== "Settled") return { status: "pending" };
      if (amountCents !== undefined && (toCents(inv.amount) !== amountCents || inv.currency !== currency)) throw new ProviderError("provider_amount_mismatch", "btcpay");
      return { status: "succeeded", captureRef: inv.id };
    },
    // Refunds are paid in dollars by the district, outside EduOS: this
    // records that it happened. No bitcoin is sent from here.
    async refundPayment(ref, amountCents) {
      if (!amountOk(amountCents)) throw new ProviderError("provider_refund_failed", "btcpay");
      // One record per invoice, so a retried refund records the same reference.
      return { status: "refunded", refundRef: `manual_fiat_${idem("btcpay-refund", ref).slice(0, 24)}`, manual: true };
    },
    // BTCPay-Sig: "sha256=" + hex(HMAC-SHA256(webhook secret, raw body)).
    verifyWebhook({ headers, rawBody }) { return verifyBtcpaySignature({ secret: webhookSecret, rawBody, signature: header(headers, "btcpay-sig") }); }
  });
}
export function verifyBtcpaySignature({ secret, rawBody, signature }) {
  if (!secret || !signature || rawBody === undefined) return false;
  return safeEq("sha256=" + createHmac("sha256", secret).update(Buffer.isBuffer(rawBody) ? rawBody : String(rawBody)).digest("hex"), signature);
}

export const ADAPTERS = Object.freeze({ paypal: paypalAdapter, square: squareAdapter, btcpay: btcpayAdapter });
