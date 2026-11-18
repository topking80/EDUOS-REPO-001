// 37.7.1 per-district payment providers: the catalog (how each option really
// works), sealed credentials, the PayPal / Square / BTCPay adapters against a
// mock transport (no network), and the webhook signature checks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { METHODS, PROCESSORS, CHECKOUT_METHODS, processorFor, adapterState, allLinks } from "../src/commerce/catalog.js";
import { sealSecrets, openSecrets } from "../src/commerce/secrets.js";
import { paypalAdapter, squareAdapter, btcpayAdapter, verifySquareSignature, verifyBtcpaySignature, ProviderError, SQUARE_VERSION } from "../src/commerce/adapters.js";

const read = f => readFile(new URL(`../${f}`, import.meta.url), "utf8");
const KEY = "m".repeat(40);

/** A scripted transport: records every call, answers from the route table. */
function mockTransport(routes) {
  const calls = [];
  const t = async (url, opts) => {
    calls.push({ url, ...opts });
    for (const [re, fn] of routes) { const m = re.exec(`${opts.method} ${url}`); if (m) { const [status, body] = await fn(m, opts); return { status, text: JSON.stringify(body) }; } }
    return { status: 404, text: "{}" };
  };
  t.calls = calls;
  return t;
}

test("catalog: six quick-setup cards plus the sandbox, each with official links", () => {
  assert.deepEqual(Object.keys(METHODS), ["paypal", "card", "square", "bitcoin", "venmo", "cash_app", "sandbox"]);
  assert.deepEqual(CHECKOUT_METHODS, ["paypal", "card", "bitcoin", "venmo", "cash_app", "sandbox"], "Square is a processor tile, not a checkout button");
  for (const m of Object.values(METHODS)) {
    if (m.id === "sandbox") continue;
    for (const l of [m.signup, m.developer, ...m.docs]) assert.match(l.url, /^https:\/\/[a-z0-9.-]+\.(com|org|app)\//, `${m.id}: ${l.url}`);
  }
  const hosts = new Set(allLinks().map(u => new URL(u).hostname.split(".").slice(-2).join(".")));
  assert.deepEqual([...hosts].sort(), ["adyen.com", "btcpayserver.org", "cash.app", "coinbase.com", "mastercard.com", "paypal.com", "squareup.com", "venmo.com", "visa.com"]);
});

test("catalog: how each option really works", () => {
  assert.match(METHODS.card.description, /card networks, not processors/);
  assert.deepEqual([...METHODS.card.processors], ["square", "paypal"]);
  assert.deepEqual([...METHODS.venmo.processors], ["paypal"]);
  assert.deepEqual([...METHODS.cash_app.processors], ["square"]);
  assert.match(METHODS.cash_app.description, /Square, Afterpay or Adyen/);
  assert.deepEqual([...METHODS.bitcoin.processors], ["btcpay"]);
  const notes = METHODS.bitcoin.notes.join(" ");
  assert.match(notes, /price moves/); assert.match(notes, /Refunds are made in dollars/); assert.match(notes, /state's rules/); assert.match(notes, /Coinbase Commerce closed on March 31, 2026/);
  assert.equal(processorFor("venmo"), "paypal"); assert.equal(processorFor("cash_app"), "square"); assert.equal(processorFor("bitcoin"), "btcpay");
  assert.equal(processorFor("card", { card_processor: "square" }), "square"); assert.equal(processorFor("card", {}), null); assert.equal(processorFor("card", { card_processor: "btcpay" }), null);
  assert.equal(processorFor("square"), null, "not a checkout method");
  assert.equal(adapterState("card", "square"), "ready"); assert.equal(adapterState("card", "paypal"), "coming"); assert.equal(adapterState("venmo", "paypal"), "coming");
  for (const m of ["paypal", "cash_app", "bitcoin", "sandbox"]) assert.equal(adapterState(m, processorFor(m)), "ready", m);
  assert.deepEqual(PROCESSORS.paypal.hosts, { test: "api-m.sandbox.paypal.com", live: "api-m.paypal.com" });
  assert.deepEqual(PROCESSORS.square.hosts, { test: "connect.squareupsandbox.com", live: "connect.squareup.com" });
  for (const p of Object.values(PROCESSORS)) for (const f of p.fields) if (/secret|token|key/i.test(f.key)) assert.equal(f.secret, true, `${p.id}.${f.key} must be write-only`);
});

test("sealed credentials: bound to district and processor, unreadable without the key", () => {
  const blob = sealSecrets(KEY, "d1", "paypal", { clientSecret: "shh-123", empty: "" });
  assert.match(blob, /^c1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
  assert.ok(!blob.includes("shh-123"));
  assert.deepEqual(openSecrets(KEY, "d1", "paypal", blob), { clientSecret: "shh-123" });
  assert.throws(() => openSecrets(KEY, "d2", "paypal", blob), "another district can't open it");
  assert.throws(() => openSecrets(KEY, "d1", "square", blob), "nor another processor");
  assert.throws(() => openSecrets("x".repeat(40), "d1", "paypal", blob));
  assert.throws(() => sealSecrets("", "d1", "paypal", { clientSecret: "a" }), /commerce_secrets_key_missing/);
  assert.equal(sealSecrets("", "d1", "paypal", {}), null);
});

const BASE = "https://api-m.sandbox.paypal.com";
function paypalMock(state = {}) {
  return mockTransport([
    [/^POST https:\/\/api-m\.sandbox\.paypal\.com\/v1\/oauth2\/token$/, (_m, o) => o.headers.authorization === `Basic ${Buffer.from("cid0000000001:sec").toString("base64")}` ? [200, { access_token: "T" }] : [401, {}]],
    [/^POST .*\/v2\/checkout\/orders$/, () => [201, { id: "ORDER123", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123" }] }]],
    [/^GET .*\/v2\/checkout\/orders\/ORDER123$/, () => [200, { id: "ORDER123", status: state.status || "PAYER_ACTION_REQUIRED" }]],
    [/^POST .*\/v2\/checkout\/orders\/ORDER123\/capture$/, () => state.decline ? [422, { details: [{ issue: "INSTRUMENT_DECLINED" }] }]
      : [201, { id: "ORDER123", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: state.captureStatus || "COMPLETED", amount: { value: state.value || "12.34", currency_code: "USD" } }] } }] }]],
    [/^POST .*\/v2\/payments\/captures\/CAP1\/refund$/, () => [201, { id: "REF1", status: "COMPLETED" }]],
    [/^POST .*\/v1\/notifications\/verify-webhook-signature$/, (_m, o) => [200, { verification_status: JSON.parse(o.body).transmission_sig === "good" ? "SUCCESS" : "FAILURE" }]]
  ]);
}
const pp = (t, extra = {}) => paypalAdapter({ mode: "test", clientId: "cid0000000001", clientSecret: "sec", fee: { bps: 290, fixedCents: 30 }, transport: t, base: BASE, allowedHosts: ["api-m.sandbox.paypal.com"], ...extra });

test("PayPal adapter: Orders v2 create (hosted approval), capture on return, refund by capture", async () => {
  const state = {}, t = paypalMock(state), a = pp(t);
  assert.equal(a.feeFor(1234), 66);
  assert.deepEqual(await a.testConnection(), { ok: true, detail: "token_ok" });
  const c = await a.createPayment({ amountCents: 1234, currency: "USD", reference: "pay-1", description: "2 × Adult", returnUrl: "https://edu.example/app/?commerce_return=pay-1", cancelUrl: "https://edu.example/c" });
  assert.deepEqual(c, { providerRef: "ORDER123", status: "requires_action", redirectUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123" });
  const create = t.calls.find(x => x.url.endsWith("/v2/checkout/orders"));
  const body = JSON.parse(create.body);
  assert.equal(body.intent, "CAPTURE"); assert.deepEqual(body.purchase_units[0].amount, { currency_code: "USD", value: "12.34" });
  assert.equal(body.payment_source.paypal.experience_context.return_url, "https://edu.example/app/?commerce_return=pay-1");
  assert.match(create.headers["paypal-request-id"], /^[0-9a-f]{40}$/, "idempotent create");
  assert.deepEqual(create.allowedHosts, ["api-m.sandbox.paypal.com"]);
  assert.deepEqual(await a.confirmPayment("ORDER123", { amountCents: 1234, currency: "USD" }), { status: "pending" });
  state.status = "APPROVED";
  state.captureStatus = "PENDING";
  assert.deepEqual(await a.confirmPayment("ORDER123", { amountCents: 1234, currency: "USD" }), { status: "pending" },
    "an order marked COMPLETED must not settle while its capture is still PENDING");
  state.captureStatus = "COMPLETED";
  assert.deepEqual(await a.confirmPayment("ORDER123", { amountCents: 1234, currency: "USD" }), { status: "succeeded", captureRef: "CAP1" });
  state.value = "99.00";
  await assert.rejects(a.confirmPayment("ORDER123", { amountCents: 1234, currency: "USD" }), e => e.code === "provider_amount_mismatch");
  state.value = undefined; state.decline = true;
  assert.deepEqual(await a.confirmPayment("ORDER123", { amountCents: 1234, currency: "USD" }), { status: "declined", declineCode: "instrument_declined" });
  assert.deepEqual(await a.refundPayment("ORDER123", 1234, { captureRef: "CAP1" }), { status: "refunded", refundRef: "REF1" });
  await assert.rejects(a.createPayment({ amountCents: 100, currency: "EUR", reference: "x" }), e => e.code === "currency_not_supported");
  await assert.rejects(pp(t, { clientSecret: "wrong" }).testConnection(), e => e instanceof ProviderError && e.code === "provider_auth_failed");
  assert.ok(!JSON.stringify(t.calls.map(x => x.url)).includes("sec"), "the secret never goes in a URL");
});

test("PayPal webhooks: verified through PayPal's verify-webhook-signature API, needs the webhook ID", async () => {
  const t = paypalMock(), headers = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-transmission-id": "1", "paypal-transmission-time": "now" };
  assert.equal(await pp(t).verifyWebhook({ headers: { ...headers, "paypal-transmission-sig": "good" }, rawBody: "{}" }), false, "no webhook ID configured");
  const a = pp(t, { webhookId: "WH-123456" });
  assert.equal(await a.verifyWebhook({ headers: { ...headers, "paypal-transmission-sig": "good" }, rawBody: '{"id":"E1"}' }), true);
  assert.equal(await a.verifyWebhook({ headers: { ...headers, "paypal-transmission-sig": "bad" }, rawBody: '{"id":"E1"}' }), false);
  assert.equal(await a.verifyWebhook({ headers: {}, rawBody: "{}" }), false);
});

test("Square adapter: payment link (Cash App Pay opted in only for Cash App), order check, refund", async () => {
  const order = { state: "OPEN", total_money: { amount: 1000, currency: "USD" }, net_amount_due_money: { amount: 1000, currency: "USD" }, tenders: [] };
  const t = mockTransport([
    [/^GET https:\/\/connect\.squareupsandbox\.com\/v2\/locations\/L1234567$/, (_m, o) => o.headers["square-version"] === SQUARE_VERSION && o.headers.authorization === "Bearer tok" ? [200, { location: { status: "ACTIVE" } }] : [401, {}]],
    [/^POST .*\/v2\/online-checkout\/payment-links$/, () => [200, { payment_link: { id: "PL1", order_id: "SQO123456", url: "https://sandbox.square.link/u/x" } }]],
    [/^GET .*\/v2\/orders\/SQO123456$/, () => [200, { order }]],
    [/^POST .*\/v2\/refunds$/, () => [200, { refund: { id: "RF1", status: "PENDING" } }]]
  ]);
  const a = squareAdapter({ mode: "test", accessToken: "tok", locationId: "L1234567", fee: { bps: 290, fixedCents: 30 }, transport: t, base: "https://connect.squareupsandbox.com", allowedHosts: ["connect.squareupsandbox.com"] });
  assert.deepEqual(await a.testConnection(), { ok: true, detail: "location_active" });
  const c = await a.createPayment({ amountCents: 1000, currency: "USD", reference: "pay-2", description: "Adult", returnUrl: "https://edu.example/r", method: "card" });
  assert.deepEqual(c, { providerRef: "SQO123456", status: "requires_action", redirectUrl: "https://sandbox.square.link/u/x" });
  const first = JSON.parse(t.calls.at(-1).body);
  assert.equal(first.checkout_options.accepted_payment_methods, undefined); assert.equal(first.checkout_options.allow_tipping, false);
  await a.createPayment({ amountCents: 1000, currency: "USD", reference: "pay-3", returnUrl: "https://edu.example/r", method: "cash_app" });
  assert.deepEqual(JSON.parse(t.calls.at(-1).body).checkout_options.accepted_payment_methods, { cash_app_pay: true });
  assert.deepEqual(await a.confirmPayment("SQO123456", { amountCents: 1000, currency: "USD" }), { status: "pending" });
  Object.assign(order, { state: "COMPLETED", net_amount_due_money: { amount: 0, currency: "USD" }, tenders: [{ id: "T1", payment_id: "PAY1" }] });
  assert.deepEqual(await a.confirmPayment("SQO123456", { amountCents: 1000, currency: "USD" }), { status: "succeeded", captureRef: "PAY1" });
  await assert.rejects(a.confirmPayment("SQO123456", { amountCents: 999, currency: "USD" }), e => e.code === "provider_amount_mismatch");
  order.state = "CANCELED";
  assert.deepEqual(await a.confirmPayment("SQO123456", { amountCents: 1000, currency: "USD" }), { status: "declined", declineCode: "square_order_canceled" });
  assert.deepEqual(await a.refundPayment("SQO123456", 1000, { captureRef: "PAY1" }), { status: "refunded", refundRef: "RF1" });
  assert.deepEqual(JSON.parse(t.calls.at(-1).body).amount_money, { amount: 1000, currency: "USD" });
});

test("Square webhook signature: matches Square's documented example; constant-time compare", () => {
  // From https://developer.squareup.com/docs/webhooks/step3validate
  const ex = { signatureKey: "asdf1234", notificationUrl: "https://example.com/webhook", rawBody: '{"hello":"world"}' };
  assert.equal(verifySquareSignature({ ...ex, signature: "2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=" }), true);
  assert.equal(verifySquareSignature({ ...ex, signature: "2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og" }), false);
  assert.equal(verifySquareSignature({ ...ex, rawBody: '{"hello":"World"}', signature: "2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=" }), false);
  assert.equal(verifySquareSignature({ ...ex, signatureKey: null, signature: "x" }), false);
});

test("BTCPay adapter: Greenfield invoice, settlement check, refunds recorded as paid in dollars; BTCPay-Sig", async () => {
  const inv = { id: "INV12345", status: "New", amount: "25.00", currency: "USD" };
  const listed = [];
  const t = mockTransport([
    [/^GET https:\/\/pay\.district\.example\/api\/v1\/stores\/STORE12345$/, (_m, o) => o.headers.authorization === "token k1" ? [200, { id: "STORE12345" }] : [403, {}]],
    [/^GET .*\/invoices\?orderId=pay-4$/, () => [200, listed]],
    [/^POST .*\/invoices$/, () => [200, { id: "INV12345", checkoutLink: "https://pay.district.example/i/INV12345" }]],
    [/^GET .*\/invoices\/INV12345$/, () => [200, inv]]
  ]);
  const a = btcpayAdapter({ mode: "test", serverUrl: "https://pay.district.example", storeId: "STORE12345", apiKey: "k1", webhookSecret: "whsec", fee: { bps: 0, fixedCents: 0 }, transport: t, base: "https://pay.district.example", allowedHosts: ["pay.district.example"] });
  assert.equal(a.feeFor(2500), 0);
  assert.deepEqual(await a.testConnection(), { ok: true, detail: "store_ok" });
  const c = await a.createPayment({ amountCents: 2500, currency: "USD", reference: "pay-4", returnUrl: "https://edu.example/r" });
  assert.equal(c.redirectUrl, "https://pay.district.example/i/INV12345");
  assert.deepEqual(JSON.parse(t.calls.at(-1).body), { amount: "25.00", currency: "USD", metadata: { orderId: "pay-4" }, checkout: { redirectURL: "https://edu.example/r", redirectAutomatically: true } });
  // No idempotency key in Greenfield: a retried create finds the invoice by
  // orderId and reuses it (unless it expired, was invalid, or doesn't match).
  assert.equal(t.calls.at(-2).method, "GET");
  listed.push({ id: "INVOLD1", status: "Expired", amount: "25.00", currency: "USD", metadata: { orderId: "pay-4" }, checkoutLink: "https://pay.district.example/i/INVOLD1" },
    { id: "INVOTHER", status: "New", amount: "99.00", currency: "USD", metadata: { orderId: "pay-4" }, checkoutLink: "https://pay.district.example/i/INVOTHER" },
    { id: "INV12345", status: "New", amount: "25.00", currency: "USD", metadata: { orderId: "pay-4" }, checkoutLink: "https://pay.district.example/i/INV12345" });
  const posts = t.calls.filter(x => x.method === "POST").length;
  const again = await a.createPayment({ amountCents: 2500, currency: "USD", reference: "pay-4", returnUrl: "https://edu.example/r" });
  assert.deepEqual([again.providerRef, again.redirectUrl, again.reused], ["INV12345", "https://pay.district.example/i/INV12345", true]);
  assert.equal(t.calls.filter(x => x.method === "POST").length, posts, "no second invoice");
  assert.deepEqual(await a.confirmPayment("INV12345", { amountCents: 2500, currency: "USD" }), { status: "pending" });
  inv.status = "Expired";
  assert.deepEqual(await a.confirmPayment("INV12345", { amountCents: 2500, currency: "USD" }), { status: "declined", declineCode: "invoice_expired" });
  inv.status = "Settled";
  assert.deepEqual(await a.confirmPayment("INV12345", { amountCents: 2500, currency: "USD" }), { status: "succeeded", captureRef: "INV12345" });
  const r = await a.refundPayment("INV12345", 2500);
  assert.equal(r.manual, true); assert.match(r.refundRef, /^manual_fiat_[0-9a-f]{24}$/);
  assert.equal((await a.refundPayment("INV12345", 2500)).refundRef, r.refundRef, "a retried refund records the same reference");
  const raw = '{"type":"InvoiceSettled","invoiceId":"INV12345"}';
  const sig = "sha256=" + createHmac("sha256", "whsec").update(raw).digest("hex");
  assert.equal(a.verifyWebhook({ headers: { "btcpay-sig": sig }, rawBody: raw }), true);
  assert.equal(verifyBtcpaySignature({ secret: "whsec", rawBody: raw + " ", signature: sig }), false);
  assert.equal(verifyBtcpaySignature({ secret: null, rawBody: raw, signature: sig }), false);
});

test("adapters need an injected transport, refuse missing credentials, and map HTTP failures without echoing bodies", async () => {
  assert.throws(() => paypalAdapter({ mode: "test", clientId: "cid", clientSecret: "s", base: BASE }), /transport required/);
  assert.throws(() => squareAdapter({ mode: "test", accessToken: "", locationId: "L", transport: () => {} }), e => e.code === "provider_credentials_missing");
  assert.throws(() => btcpayAdapter({ mode: "test", serverUrl: "https://x.example", storeId: "S", transport: () => {} }), e => e.code === "provider_credentials_missing");
  const boom = mockTransport([[/./, () => [500, { secret_echo: "do-not-show" }]]]);
  await assert.rejects(pp(boom).testConnection(), e => e.code === "provider_http_error" && !String(e.detail).includes("do-not-show"));
  const down = async () => { const e = new Error("x"); e.code = "connector_unreachable"; throw e; };
  await assert.rejects(pp(down).testConnection(), e => e.code === "provider_unreachable");
});

test("migration 066 and grants: sealed-only credentials, admin-only RLS, checkout through a definer function", async () => {
  const sql = await read("db/066_commerce_district_providers.sql");
  assert.match(sql, /CREATE TABLE commerce_provider_accounts/); assert.match(sql, /CREATE TABLE commerce_payment_setup/);
  assert.match(sql, /secrets_enc ~ '\^c1\\\./, "only sealed blobs are accepted");
  assert.match(sql, /NOT \(config \?\| ARRAY\['clientSecret','accessToken','apiKey','webhookSecret','webhookSignatureKey'\]\)/);
  assert.match(sql, /scope_admin ON commerce_provider_accounts AS RESTRICTIVE FOR ALL\s+USING \(eduos_is_table_owner\(\) OR eduos_ctx_role\(\) IN \('superintendent','it_admin'\)\)/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /eduos_commerce_checkout_account\(p_processor text\)[\s\S]*SECURITY DEFINER/);
  assert.match(sql, /commerce_payments_sandbox_is_test/);
  assert.doesNotMatch(sql, /student_id|latitude|longitude|geolocation|face|threat|risk_score|predict/i);
  const grants = await read("db/runtime_grants.template.sql");
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON commerce_provider_accounts, commerce_payment_setup TO eduos_app/);
  assert.match(grants, /REVOKE DELETE, TRUNCATE ON commerce_provider_accounts, commerce_payment_setup FROM eduos_app/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION eduos_commerce_checkout_account\(text\) TO eduos_app/);
  const setup = await read("src/commerce/setup.js");
  for (const code of ["payment_method_not_available", "card_processor_not_chosen", "payment_adapter_not_available", "live_payments_disabled", "commerce_secrets_key_missing", "provider_credentials_missing"]) assert.match(setup, new RegExp(code), code);
  const cfg = await read("src/config.js");
  assert.match(cfg, /commerceLivePaymentsEnabled: process\.env\.COMMERCE_LIVE_PAYMENTS_ENABLED === "true"/);
  assert.match(cfg, /COMMERCE_SECRETS_KEY must be at least 32 characters/);
  assert.match(cfg, /commerceTestApiBase: \(process\.env\.NODE_ENV \|\| "development"\) !== "production"/);
});

test("processor calls run after commit: afterCommit continuations, in-flight states, the reconcile sweep", async () => {
  const { afterCommit, isAfterCommit, runAfterCommit } = await import("../src/commerce/phases.js");
  const order = [];
  const v = afterCommit(async () => { order.push("call"); return afterCommit(() => { order.push("record"); return 7; }); });
  assert.equal(isAfterCommit(v), true); assert.equal(isAfterCommit({ x: 1 }), false);
  assert.equal(await runAfterCommit(v), 7); assert.deepEqual(order, ["call", "record"]);
  assert.deepEqual(await runAfterCommit({ plain: true }), { plain: true });
  const sql = await read("db/066_commerce_district_providers.sql");
  assert.match(sql, /status IN \('creating','requires_confirmation','succeeded','declined','expired','refund_pending','refunded'\)/);
  assert.match(sql, /OLD\.status='refund_pending' AND NEW\.status IN \('refunded','succeeded'\)/);
  assert.match(sql, /CREATE FUNCTION eduos_commerce_stale_payments\(p_stale_seconds integer\)[\s\S]*SECURITY DEFINER/);
  assert.match(sql, /ADD COLUMN refund_pending boolean NOT NULL DEFAULT false/);
  const grants = await read("db/runtime_grants.template.sql");
  assert.match(grants, /GRANT EXECUTE ON FUNCTION eduos_commerce_stale_payments\(integer\) TO eduos_app;/);
  assert.match(grants, /GRANT UPDATE \(hold_expires_at, refund_pending\) ON event_ticket_orders TO eduos_app;/);
  // The service never awaits a processor inside the request's transaction:
  // every adapter call sits in an afterCommit continuation or outside().
  const svc = await read("src/commerce/service.js");
  const direct = [...svc.matchAll(/(.{0,40})adapter\.(createPayment|refundPayment)\(/g)], viaConfirm = [...svc.matchAll(/(.{0,40})providerConfirm\(/g)];
  assert.equal(direct.length, 2); assert.ok(viaConfirm.length >= 3);
  for (const m of direct) assert.match(m[1], /outside\(\(\) => $/, m[0]);
  for (const m of viaConfirm) assert.match(m[1], /outside\(\(\) => $|^function $/, m[0]);
  assert.equal([...svc.matchAll(/adapter\.confirmPayment\(/g)].length, 1, "only providerConfirm calls confirmPayment");
  assert.match(await read("src/server.js"), /startCommerceReconcile\(\);/);
  assert.match(await read(".env.example"), /COMMERCE_RECONCILE_INTERVAL_SECONDS=60/);
});
