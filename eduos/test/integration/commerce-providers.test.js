// 37.7.1 per-district payment providers against real PostgreSQL under the
// runtime role. Every processor API call goes to an in-process mock of the
// documented PayPal, Square and BTCPay endpoints (COMMERCE_TEST_API_BASE):
// CI makes no network calls and holds no real keys.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const key = tag => `providers-test-${tag}-${"x".repeat(8)}`;
const future = h => new Date(Date.now() + h * 3600_000).toISOString();
const SECRETS = { paypal: "pp-secret-DO-NOT-ECHO-1234567", square: "sq-token-DO-NOT-ECHO-7654321", btcpay: "btc-api-key-DO-NOT-ECHO-555" };

/** A mock of the three processors' documented REST endpoints. */
async function startMock() {
  const st = { paypal: new Map(), square: new Map(), btcpay: new Map(), calls: [], n: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : raw;
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const u = new URL(req.url, "http://x"), p = u.pathname, auth = req.headers.authorization || "";
    st.calls.push({ method: req.method, path: p, auth: auth.split(" ")[0], body: raw });
    const id = pre => `${pre}${String(++st.n).padStart(8, "0")}`;
    // PayPal
    if (p === "/paypal/v1/oauth2/token") return auth === `Basic ${Buffer.from(`ppClientId0001:${SECRETS.paypal}`).toString("base64")}` ? send(200, { access_token: "A21-mock" }) : send(401, { error: "invalid_client" });
    if (p.startsWith("/paypal/")) {
      if (auth !== "Bearer A21-mock") return send(401, {});
      if (p === "/paypal/v2/checkout/orders" && req.method === "POST") {
        const o = { id: id("PPORDER"), status: "PAYER_ACTION_REQUIRED", amount: body.purchase_units[0].amount, request: body };
        st.paypal.set(o.id, o);
        return send(200, { id: o.id, status: o.status, links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}` }] });
      }
      const m = /^\/paypal\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/.exec(p);
      if (m) {
        const o = st.paypal.get(m[1]); if (!o) return send(404, {});
        if (m[2]) { if (o.status !== "APPROVED") return send(422, { details: [{ issue: "ORDER_NOT_APPROVED" }] }); o.status = "COMPLETED"; o.capture = { id: id("PPCAP"), status: "COMPLETED", amount: o.amount }; }
        return send(200, { id: o.id, status: o.status, purchase_units: o.capture ? [{ payments: { captures: [o.capture] } }] : [] });
      }
      const r = /^\/paypal\/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/.exec(p);
      if (r) return send(201, { id: id("PPREF"), status: "COMPLETED" });
    }
    // Square
    if (p.startsWith("/square/")) {
      if (auth !== `Bearer ${SECRETS.square}` || req.headers["square-version"] !== "2026-09-16") return send(401, {});
      if (p === "/square/v2/locations/LOC12345") return send(200, { location: { id: "LOC12345", status: "ACTIVE" } });
      if (p === "/square/v2/online-checkout/payment-links") {
        const o = { id: id("SQORDER"), state: "OPEN", total_money: body.quick_pay.price_money, net_amount_due_money: { ...body.quick_pay.price_money }, tenders: [], request: body };
        st.square.set(o.id, o);
        return send(200, { payment_link: { id: id("PL"), order_id: o.id, url: `https://sandbox.square.link/u/${o.id}` } });
      }
      const m = /^\/square\/v2\/orders\/([A-Z0-9]+)$/.exec(p);
      if (m) { const o = st.square.get(m[1]); return o ? send(200, { order: o }) : send(404, {}); }
      if (p === "/square/v2/refunds") return send(200, { refund: { id: id("SQREF"), status: "PENDING", payment_id: body.payment_id } });
    }
    // BTCPay Server
    if (p.startsWith("/btcpay/")) {
      if (auth !== `token ${SECRETS.btcpay}`) return send(401, {});
      if (p === "/btcpay/api/v1/stores/STORE12345") return send(200, { id: "STORE12345", name: "District store" });
      if (p === "/btcpay/api/v1/stores/STORE12345/invoices" && req.method === "POST") {
        const inv = { id: id("INV"), status: "New", amount: body.amount, currency: body.currency, request: body };
        st.btcpay.set(inv.id, inv);
        return send(200, { id: inv.id, status: inv.status, checkoutLink: `https://btcpay.example.org/i/${inv.id}` });
      }
      const m = /^\/btcpay\/api\/v1\/stores\/STORE12345\/invoices\/([A-Z0-9]+)$/.exec(p);
      if (m) { const inv = st.btcpay.get(m[1]); return inv ? send(200, inv) : send(404, {}); }
    }
    send(404, { error: "mock_not_found", path: p });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { st, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

describe("37.7.1 district payment providers against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, mock, env, s = {}, eventId, typeId;
  const as = name => client(server.base, s[name]);
  const buy = (who, tag, method) => as(who)("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: typeId, quantity: 1, idempotencyKey: key(tag), ...(method ? { paymentMethod: method } : {}) });

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    mock = await startMock();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // A district IT administrator (not in the shared seed).
    await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ('a0000000-0000-4000-8000-0000000000f1',$1,'it1','District IT','it1@d1.test')", [idp.issuer]);
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ('a0000000-0000-4000-8000-0000000000f1',$1,NULL,'it_admin',true)", [ID.d1]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl, COMMERCE_SECRETS_KEY: "k".repeat(16) + "-commerce-test-key-0123456789",
      COMMERCE_TEST_API_BASE: mock.base, COMMERCE_ALLOWED_HOSTS: "btcpay.example.org" });
    for (const name of ["supt1", "supt2", "p1", "t1", "pa", "pu", "it1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    const act = await as("p1")("POST", "/api/activities", { kind: "sport", title: "Owls Basketball", status: "published" });
    const ev = await as("p1")("POST", `/api/activities/${act.body.data.id}/events`, { title: "Home opener", startsAt: future(48), endsAt: future(50), venue: "Gym", publish: true });
    eventId = ev.body.data.id;
    typeId = (await as("p1")("POST", `/api/events/${eventId}/ticket-types`, { name: "Adult", priceCents: 1000, capacity: 40, salesOpen: true })).body.data.id;
    assert.equal((await as("supt1")("PUT", "/api/commerce/settings", { enabled: true })).status, 200);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await mock?.close(); await db?.drop(); });

  it("only district administrators see or change providers", async () => {
    for (const who of ["p1", "t1", "pa", "pu"]) {
      assert.equal((await as(who)("GET", "/api/commerce/providers")).status, 403, who);
      assert.equal((await as(who)("PUT", "/api/commerce/providers/paypal", { config: { clientId: "ppClientId0001" } })).status, 403, who);
      assert.equal((await as(who)("PUT", "/api/commerce/payment-methods", { enabledMethods: ["sandbox"] })).status, 403, who);
      assert.equal((await as(who)("POST", "/api/commerce/providers/paypal/test", {})).status, 403, who);
    }
    const o = await as("supt1")("GET", "/api/commerce/providers");
    assert.equal(o.status, 200);
    assert.deepEqual(Object.keys(o.body.data.processors).sort(), ["btcpay", "paypal", "square"]);
    assert.ok(Object.values(o.body.data.processors).every(p => p.status === "not_set_up" && !p.enabled));
    assert.deepEqual(o.body.data.methods.map(m => m.id), ["paypal", "card", "square", "bitcoin", "venmo", "cash_app", "sandbox"]);
    assert.equal(o.body.data.liveSwitch, false); assert.equal(o.body.data.secretsKeyConfigured, true);
    assert.equal((await as("it1")("GET", "/api/commerce/providers")).status, 200, "district IT may");
    assert.equal((await as("it1")("PUT", "/api/commerce/settings", { enabled: false })).status, 403, "but not the revenue settings");
  });

  it("credentials are sealed at rest and never returned; changes are audited by field name only", async () => {
    const bad = await as("supt1")("PUT", "/api/commerce/providers/paypal", { config: { clientSecret: "nope" } });
    assert.equal(bad.status, 400, "a secret can't go in the plain config");
    assert.equal((await as("supt1")("PUT", "/api/commerce/providers/paypal", { enabled: true, config: { clientId: "ppClientId0001" } })).status, 409, "can't enable without the secret");
    const r = await as("it1")("PUT", "/api/commerce/providers/paypal", { config: { clientId: "ppClientId0001" }, secrets: { clientSecret: SECRETS.paypal }, enabled: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.data.status, r.body.data.secretsSet.clientSecret, r.body.data.config.clientId], ["test", true, "ppClientId0001"]);
    assert.ok(!JSON.stringify(r.body).includes(SECRETS.paypal));
    assert.ok(!JSON.stringify((await as("supt1")("GET", "/api/commerce/providers")).body).includes(SECRETS.paypal));
    const row = (await admin.query("SELECT * FROM commerce_provider_accounts WHERE district_id=$1 AND processor='paypal'", [ID.d1])).rows[0];
    assert.match(row.secrets_enc, /^c1\./); assert.ok(!row.secrets_enc.includes(SECRETS.paypal)); assert.ok(!JSON.stringify(row.config).includes(SECRETS.paypal));
    assert.deepEqual(row.secret_fields, ["clientSecret"]);
    const aud = (await admin.query("SELECT detail FROM audit_events WHERE action='provider_saved' ORDER BY occurred_at DESC LIMIT 1")).rows[0].detail;
    assert.match(aud, /processor=paypal;enabled=true;mode=test;fields=clientId;secrets=clientSecret/);
    assert.ok(!aud.includes(SECRETS.paypal));
    // A blank secret keeps what's saved.
    const keep = await as("supt1")("PUT", "/api/commerce/providers/paypal", { secrets: { clientSecret: "" } });
    assert.equal(keep.body.data.secretsSet.clientSecret, true);
    // The database itself refuses an unsealed secret.
    await assert.rejects(admin.query("UPDATE commerce_provider_accounts SET secrets_enc='plain-text-secret' WHERE district_id=$1 AND processor='paypal'", [ID.d1]), /check constraint/);
  });

  it("RLS: another district sees nothing, and payers can't read the accounts table", async () => {
    const o2 = await as("supt2")("GET", "/api/commerce/providers");
    assert.equal(o2.body.data.processors.paypal.status, "not_set_up");
    assert.equal(o2.body.data.processors.paypal.secretsSet.clientSecret, false);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      const ctx = async (district, user, role) => { await app.query("BEGIN"); await app.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true)", [district, user, role]); };
      await ctx(ID.d2, USERS.supt2[0], "superintendent");
      assert.equal((await app.query("SELECT count(*)::int AS n FROM commerce_provider_accounts")).rows[0].n, 0);
      assert.equal((await app.query("SELECT count(*)::int AS n FROM eduos_commerce_checkout_account('paypal')")).rows[0].n, 0);
      await app.query("ROLLBACK");
      await ctx(ID.d1, USERS.pa[0], "parent");
      assert.equal((await app.query("SELECT count(*)::int AS n FROM commerce_provider_accounts")).rows[0].n, 0, "a parent can't read it");
      assert.equal((await app.query("SELECT count(*)::int AS n FROM eduos_commerce_checkout_account('paypal')")).rows[0].n, 1, "checkout reaches its own district's account");
      await app.query("ROLLBACK");
      await ctx(ID.d1, USERS.p1[0], "principal");
      await assert.rejects(app.query("INSERT INTO commerce_provider_accounts(district_id,processor,updated_by) VALUES($1,'square',$2)", [ID.d1, USERS.p1[0]]), /row-level security/);
      await app.query("ROLLBACK");
    } finally { await app.end(); }
  });

  it("test connection talks to the processor's sandbox (mocked) and records the result", async () => {
    const t = await as("supt1")("POST", "/api/commerce/providers/paypal/test", {});
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.deepEqual([t.body.data.ok, t.body.data.detail, t.body.data.mode], [true, "token_ok", "test"]);
    const o = await as("supt1")("GET", "/api/commerce/providers");
    assert.equal(o.body.data.processors.paypal.lastTest.ok, true);
    const notSet = await as("supt1")("POST", "/api/commerce/providers/square/test", {});
    assert.equal(notSet.status, 503);
  });

  it("live mode needs credentials, and the server-wide switch keeps it off", async () => {
    assert.equal((await as("supt1")("PUT", "/api/commerce/providers/square", { mode: "live", config: { locationId: "LOC12345" } })).status, 409, "live without credentials");
    const live = await as("supt1")("PUT", "/api/commerce/providers/paypal", { mode: "live" });
    assert.equal(live.status, 200); assert.equal(live.body.data.status, "live_blocked");
    assert.equal((await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["paypal"], defaultMethod: "paypal" })).status, 200);
    const st = await as("pa")("GET", "/api/commerce/status");
    assert.deepEqual([st.body.data.enabled, st.body.data.methods.length], [false, 0], "families aren't offered a blocked method");
    const r = await buy("pa", "live", "paypal");
    assert.equal(r.status, 503); assert.equal(r.body.error, "live_payments_disabled");
    const t = await as("supt1")("POST", "/api/commerce/providers/paypal/test", {});
    assert.equal(t.status, 503); assert.equal(t.body.error, "live_payments_disabled");
    assert.ok(!mock.st.calls.some(c => c.path.includes("live")), "no call left for a live host");
    assert.equal((await as("supt1")("PUT", "/api/commerce/providers/paypal", { mode: "test" })).body.data.status, "test");
  });

  it("PayPal (test mode): hosted approval, then capture; a refund goes back through PayPal", async () => {
    const r = await buy("pa", "pp1", "paypal");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = r.body.data.payment;
    assert.deepEqual([p.provider, p.method, p.mode, p.test, p.sandbox], ["paypal", "paypal", "test", true, false]);
    assert.match(p.redirectUrl, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=PPORDER/);
    const order = [...mock.st.paypal.values()].at(-1);
    assert.equal(order.amount.value, "10.00");
    assert.match(order.request.payment_source.paypal.experience_context.return_url, new RegExp(`commerce_return=${p.id}`));
    assert.ok(!JSON.stringify(order.request).match(/Alice|Pupil|student/i), "no student data goes to the processor");
    const early = await as("pa")("POST", `/api/commerce/payments/${p.id}/confirm`, {});
    assert.equal(early.status, 200); assert.equal(early.body.data.status, "pending");
    assert.equal((await as("pa")("POST", `/api/commerce/payments/${p.id}/confirm`, { testOutcome: "sandbox_success" })).body.data.status, "pending", "a sandbox outcome can't fake a PayPal payment");
    order.status = "APPROVED";
    const done = await as("pa")("POST", `/api/commerce/payments/${p.id}/confirm`, {});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.status, "succeeded"); assert.equal(done.body.data.tickets.length, 1);
    const row = (await admin.query("SELECT provider_capture_ref, processing_fee_cents FROM commerce_payments WHERE id=$1", [p.id])).rows[0];
    assert.match(row.provider_capture_ref, /^PPCAP/); assert.equal(row.processing_fee_cents, 59, "2.9% + 30c estimate");
    const receipt = await as("pa")("GET", `/api/commerce/receipts/${done.body.data.receipt.id}`);
    assert.equal(receipt.body.data.mode, "test"); assert.match(receipt.body.data.note, /Test-mode/);
    const ref = await as("supt1")("POST", `/api/commerce/payments/${p.id}/refund`, {});
    assert.equal(ref.status, 200, JSON.stringify(ref.body));
    assert.ok(mock.st.calls.some(c => c.path === `/paypal/v2/payments/captures/${row.provider_capture_ref}/refund`));
    assert.match((await admin.query("SELECT refund_ref FROM commerce_payments WHERE id=$1", [p.id])).rows[0].refund_ref, /^PPREF/);
  });

  it("Venmo and cards-through-PayPal are 'adapter coming': saved, but checkout refuses them", async () => {
    const save = await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["paypal", "venmo", "card"], cardProcessor: "paypal", defaultMethod: "paypal" });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    const st = await as("pa")("GET", "/api/commerce/status");
    assert.deepEqual(st.body.data.methods.map(m => m.method), ["paypal"]);
    const v = await buy("pa", "venmo", "venmo");
    assert.equal(v.status, 503); assert.equal(v.body.error, "payment_adapter_not_available");
    const c = await buy("pa", "cardpp", "card");
    assert.equal(c.status, 503); assert.equal(c.body.error, "payment_adapter_not_available");
    assert.equal((await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["card"], cardProcessor: null })).status, 409, "cards need a processor");
    assert.equal((await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["bogus"] })).status, 400);
  });

  it("Square (test mode): cards and Cash App Pay on Square's hosted page", async () => {
    const sq = await as("supt1")("PUT", "/api/commerce/providers/square", { enabled: true, config: { locationId: "LOC12345" }, secrets: { accessToken: SECRETS.square } });
    assert.equal(sq.status, 200, JSON.stringify(sq.body));
    assert.equal((await as("supt1")("POST", "/api/commerce/providers/square/test", {})).body.data.detail, "location_active");
    assert.equal((await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["card", "cash_app", "sandbox"], cardProcessor: "square", defaultMethod: "card" })).status, 200);
    const card = await buy("pa", "sqcard");
    assert.equal(card.status, 201, JSON.stringify(card.body));
    assert.deepEqual([card.body.data.payment.provider, card.body.data.payment.method], ["square", "card"]);
    const link = [...mock.st.square.values()].at(-1);
    assert.equal(link.request.checkout_options.accepted_payment_methods, undefined);
    assert.equal(link.request.quick_pay.price_money.amount, 1000);
    const cash = await buy("pa", "sqcash", "cash_app");
    assert.equal(cash.status, 201);
    assert.equal([...mock.st.square.values()].at(-1).request.checkout_options.accepted_payment_methods.cash_app_pay, true);
    assert.equal((await as("pa")("POST", `/api/commerce/payments/${card.body.data.payment.id}/confirm`, {})).body.data.status, "pending");
    Object.assign(link, { state: "COMPLETED", net_amount_due_money: { amount: 0, currency: "USD" }, tenders: [{ id: "TENDER0001", payment_id: "SQPAYMENT0001" }] });
    const done = await as("pa")("POST", `/api/commerce/payments/${card.body.data.payment.id}/confirm`, {});
    assert.equal(done.body.data.status, "succeeded", JSON.stringify(done.body));
    const ref = await as("p1")("POST", `/api/commerce/payments/${card.body.data.payment.id}/refund`, {});
    assert.equal(ref.status, 200, JSON.stringify(ref.body));
    assert.ok(mock.st.calls.some(c => c.path === "/square/v2/refunds" && c.body.includes("SQPAYMENT0001")));
  });

  it("Bitcoin through BTCPay Server: invoice, settlement, and a refund recorded as paid in dollars", async () => {
    const off = await as("supt1")("PUT", "/api/commerce/providers/btcpay", { config: { serverUrl: "https://elsewhere.example.com", storeId: "STORE12345" } });
    assert.equal(off.status, 400, "the server's host must be allowed");
    const b = await as("supt1")("PUT", "/api/commerce/providers/btcpay", { enabled: true, config: { serverUrl: "https://btcpay.example.org", storeId: "STORE12345" }, secrets: { apiKey: SECRETS.btcpay } });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const meta = (await as("supt1")("GET", "/api/commerce/providers")).body.data.methods.find(m => m.id === "bitcoin");
    assert.ok(meta.notes.some(n => /price moves/.test(n)) && meta.notes.some(n => /in dollars/.test(n)) && meta.notes.some(n => /state's rules/.test(n)));
    assert.equal((await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["bitcoin"], defaultMethod: "bitcoin", cardProcessor: null })).status, 200);
    const r = await buy("pa", "btc");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.data.payment.redirectUrl, /^https:\/\/btcpay\.example\.org\/i\/INV/);
    const inv = [...mock.st.btcpay.values()].at(-1);
    assert.deepEqual([inv.amount, inv.currency], ["10.00", "USD"]);
    inv.status = "Settled";
    const done = await as("pa")("POST", `/api/commerce/payments/${r.body.data.payment.id}/confirm`, {});
    assert.equal(done.body.data.status, "succeeded");
    assert.equal(done.body.data.payment.processingFeeCents, 0, "no processor fee");
    const ref = await as("supt1")("POST", `/api/commerce/payments/${r.body.data.payment.id}/refund`, {});
    assert.equal(ref.status, 200); assert.equal(ref.body.data.manual, true);
    assert.match((await admin.query("SELECT refund_ref FROM commerce_payments WHERE id=$1", [r.body.data.payment.id])).rows[0].refund_ref, /^manual_fiat_[0-9a-f]{24}$/);
  });

  it("pupils still can't pay, whatever the district offers", async () => {
    const kid = await buy("pu", "kid", "bitcoin");
    assert.equal(kid.status, 403); assert.equal(kid.body.error, "guardian_payment_required");
  });
});
