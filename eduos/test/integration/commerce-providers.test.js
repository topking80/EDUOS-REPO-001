// 37.7.1 per-district payment providers against real PostgreSQL under the
// runtime role. Every processor API call goes to an in-process mock of the
// documented PayPal, Square and BTCPay endpoints (COMMERCE_TEST_API_BASE):
// CI makes no network calls and holds no real keys.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const key = tag => `providers-test-${tag}-${"x".repeat(8)}`;
const future = h => new Date(Date.now() + h * 3600_000).toISOString();
const SECRETS = { paypal: "pp-secret-DO-NOT-ECHO-1234567", square: "sq-token-DO-NOT-ECHO-7654321", btcpay: "btc-api-key-DO-NOT-ECHO-555" };

/**
 * A mock of the three processors' documented REST endpoints. Before answering
 * any call it asks PostgreSQL whether EduOS has a transaction open (st.probe,
 * set once the admin client connects): 37.7.1 calls processors only with
 * none open. st.failNext makes the next matching call fail with HTTP 500;
 * st.gate holds the next matching call until the test releases it.
 */
async function startMock() {
  const st = { paypal: new Map(), paypalByKey: new Map(), square: new Map(), btcpay: new Map(), calls: [], n: 0, probes: [], probe: null, failNext: null, gate: null };
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : raw;
    const send = (code, obj) => { if (!res.destroyed) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); } };
    const u = new URL(req.url, "http://x"), p = u.pathname, auth = req.headers.authorization || "";
    st.calls.push({ method: req.method, path: p, query: u.search, auth: auth.split(" ")[0], body: raw, requestId: req.headers["paypal-request-id"] || null });
    if (st.probe) st.probes.push({ method: req.method, path: p, open: await st.probe() });
    if (st.gate && st.gate.re.test(`${req.method} ${p}`)) { const g = st.gate; st.gate = null; g.arrived(); await g.released; }
    if (st.failNext && st.failNext.test(`${req.method} ${p}`)) { st.failNext = null; return send(500, { name: "INTERNAL_SERVER_ERROR" }); }
    const id = pre => `${pre}${String(++st.n).padStart(8, "0")}`;
    // PayPal
    if (p === "/paypal/v1/oauth2/token") return auth === `Basic ${Buffer.from(`ppClientId0001:${SECRETS.paypal}`).toString("base64")}` ? send(200, { access_token: "A21-mock" }) : send(401, { error: "invalid_client" });
    if (p.startsWith("/paypal/")) {
      if (auth !== "Bearer A21-mock") return send(401, {});
      if (p === "/paypal/v2/checkout/orders" && req.method === "POST") {
        // PayPal-Request-Id: the same key returns the same order.
        const key = req.headers["paypal-request-id"];
        const o = st.paypalByKey.get(key) || { id: id("PPORDER"), status: "PAYER_ACTION_REQUIRED", amount: body.purchase_units[0].amount, request: body };
        st.paypal.set(o.id, o); if (key) st.paypalByKey.set(key, o);
        return send(200, { id: o.id, status: o.status, links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}` }] });
      }
      const m = /^\/paypal\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/.exec(p);
      if (m) {
        const o = st.paypal.get(m[1]); if (!o) return send(404, {});
        if (m[2]) { if (o.status !== "APPROVED") return send(422, { details: [{ issue: "ORDER_NOT_APPROVED" }] }); o.status = "COMPLETED"; o.capture = { id: id("PPCAP"), status: "COMPLETED", amount: o.amount }; }
        return send(200, { id: o.id, status: o.status, purchase_units: o.capture ? [{ payments: { captures: [o.capture] } }] : [] });
      }
      const r = /^\/paypal\/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/.exec(p);
      if (r) {
        const key = req.headers["paypal-request-id"];
        const done = st.paypalByKey.get(key) || { id: id("PPREF"), status: "COMPLETED" };
        if (key) st.paypalByKey.set(key, done);
        return send(201, { id: done.id, status: done.status });
      }
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
      if (p === "/btcpay/api/v1/stores/STORE12345/invoices" && req.method === "GET") {
        const want = u.searchParams.getAll("orderId");
        return send(200, [...st.btcpay.values()].filter(i => want.includes(i.metadata.orderId)));
      }
      if (p === "/btcpay/api/v1/stores/STORE12345/invoices" && req.method === "POST") {
        const inv = { id: id("INV"), status: "New", amount: body.amount, currency: body.currency, metadata: body.metadata, request: body };
        inv.checkoutLink = `https://btcpay.example.org/i/${inv.id}`;
        st.btcpay.set(inv.id, inv);
        return send(200, { id: inv.id, status: inv.status, checkoutLink: inv.checkoutLink });
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
  let db, idp, server, admin, mock, env, serverEnv, s = {}, eventId, typeId;
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
    serverEnv = { ...env, DATABASE_URL: db.appUrl, COMMERCE_SECRETS_KEY: "k".repeat(16) + "-commerce-test-key-0123456789",
      COMMERCE_TEST_API_BASE: mock.base, COMMERCE_ALLOWED_HOSTS: "btcpay.example.org", COMMERCE_RECONCILE_INTERVAL_SECONDS: "0" };
    server = await startServer(serverEnv);
    // How many EduOS transactions are open while the mock answers a processor call.
    mock.st.probe = async () => (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND xact_start IS NOT NULL`)).rows[0].n;
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

  // ---------------- 37.7.1 two-phase processor calls ----------------

  const payment = async id => (await admin.query("SELECT * FROM commerce_payments WHERE id=$1", [id])).rows[0];
  const until = async (fn, what, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (await fn()) return;
    assert.fail(`timed out waiting for ${what}\n${server.log().slice(-2000)}`);
  };
  /** Hold the next processor call matching re; resolves once it has arrived. */
  const gate = re => { let arrived, release; const g = { re, released: new Promise(r => { release = r; }) };
    const reached = new Promise(r => { g.arrived = r; }); mock.st.gate = g; return { reached, release }; };
  /** The API dies mid-call (SIGKILL: no cleanup), then a new instance starts with the reconcile sweep on. */
  const crashAndRestart = async () => {
    server.child.kill("SIGKILL"); await server.stop();
    server = await startServer({ ...serverEnv, COMMERCE_RECONCILE_INTERVAL_SECONDS: "1", COMMERCE_RECONCILE_STALE_SECONDS: "10" });
  };

  it("a processor that fails at checkout releases the seats; nothing is left half-done", async () => {
    assert.equal((await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["paypal", "bitcoin"], defaultMethod: "paypal", cardProcessor: null })).status, 200);
    const sold = async () => (await admin.query("SELECT sold_count FROM event_ticket_types WHERE id=$1", [typeId])).rows[0].sold_count;
    const before = await sold();
    mock.st.failNext = /^POST \/paypal\/v2\/checkout\/orders$/;
    const r = await buy("pa", "ppfail", "paypal");
    assert.equal(r.status, 502, JSON.stringify(r.body)); assert.equal(r.body.error, "provider_http_error");
    const o = (await admin.query("SELECT o.status, p.status AS pay, p.decline_code, p.pending_since FROM event_ticket_orders o JOIN commerce_payments p ON p.ticket_order_id=o.id WHERE o.idempotency_key=$1", [key("ppfail")])).rows[0];
    assert.deepEqual([o.status, o.pay, o.decline_code, o.pending_since], ["cancelled", "declined", "provider_unavailable", null]);
    assert.equal(await sold(), before, "the held seats went back");
    assert.match((await admin.query("SELECT detail FROM audit_events WHERE action='checkout_failed' ORDER BY occurred_at DESC LIMIT 1")).rows[0].detail, /provider=paypal;code=provider_http_error/);
  });

  it("a checkout cut off mid-call is finished by the reconcile sweep under the same idempotency key", async () => {
    const g = gate(/^POST \/paypal\/v2\/checkout\/orders$/);
    const pending = buy("pa", "ppcrash", "paypal").catch(e => e);
    await g.reached;
    const row = (await admin.query("SELECT p.* FROM commerce_payments p JOIN event_ticket_orders o ON o.id=p.ticket_order_id WHERE o.idempotency_key=$1", [key("ppcrash")])).rows[0];
    assert.deepEqual([row.status, row.provider_ref, row.pending_actor.role], ["creating", null, "parent"], "reserved and committed before the call");
    await crashAndRestart();
    g.release(); await pending;
    await admin.query("UPDATE commerce_payments SET pending_since=now() - interval '5 minutes' WHERE id=$1", [row.id]);
    await until(async () => (await payment(row.id)).status === "requires_confirmation", "the sweep to finish the checkout");
    const done = await payment(row.id);
    assert.match(done.provider_ref, /^PPORDER/); assert.equal(done.pending_since, null);
    const creates = mock.st.calls.filter(c => c.path === "/paypal/v2/checkout/orders");
    assert.equal(new Set(creates.slice(-2).map(c => c.requestId)).size, 1, "the retry reused the PayPal-Request-Id");
    assert.equal([...mock.st.paypal.values()].filter(o => o.request.purchase_units[0].reference_id === row.id).length, 1, "one PayPal order, not two");
    assert.match((await admin.query("SELECT detail FROM audit_events WHERE action='checkout_reconciled' AND resource_id=$1", [row.id])).rows[0].detail, /reconciled=true/);
    // The family's retry (same idempotency key) gets the hosted page.
    const again = await buy("pa", "ppcrash", "paypal");
    assert.equal(again.status, 201); assert.equal(again.body.data.replayed, true);
    assert.match(again.body.data.payment.redirectUrl, /checkoutnow\?token=PPORDER/);
  });

  it("a refund cut off mid-call blocks the gate, then the sweep completes it exactly once", async () => {
    const r = await buy("pa", "pprefund", "paypal");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pid = r.body.data.payment.id;
    [...mock.st.paypal.values()].find(o => o.request.purchase_units[0].reference_id === pid).status = "APPROVED";
    const paid = await as("pa")("POST", `/api/commerce/payments/${pid}/confirm`, {});
    assert.equal(paid.body.data.status, "succeeded", JSON.stringify(paid.body));
    const g = gate(/^POST \/paypal\/v2\/payments\/captures\/[A-Z0-9]+\/refund$/);
    const pending = as("supt1")("POST", `/api/commerce/payments/${pid}/refund`, {}).catch(e => e);
    await g.reached;
    assert.equal((await payment(pid)).status, "refund_pending");
    const gateCheck = await as("p1")("POST", `/api/events/${eventId}/check-in`, { ticketCode: paid.body.data.tickets[0].code });
    assert.equal(gateCheck.status, 409); assert.equal(gateCheck.body.error, "ticket_refund_pending");
    await crashAndRestart();
    g.release(); await pending;
    await admin.query("UPDATE commerce_payments SET pending_since=now() - interval '5 minutes' WHERE id=$1", [pid]);
    await until(async () => (await payment(pid)).status === "refunded", "the sweep to finish the refund");
    const cap = (await payment(pid)).provider_capture_ref;
    const refunds = mock.st.calls.filter(c => c.path === `/paypal/v2/payments/captures/${cap}/refund`);
    assert.equal(refunds.length, 2, "called before the crash and once by the sweep");
    assert.equal(new Set(refunds.map(c => c.requestId)).size, 1, "both refund calls carried the same PayPal-Request-Id");
    const books = (await admin.query("SELECT entry_kind, sum(amount_cents)::int AS t FROM commerce_ledger_entries WHERE payment_id=$1 GROUP BY entry_kind ORDER BY entry_kind", [pid])).rows;
    assert.deepEqual(books.map(b => b.entry_kind), ["refund", "settlement"], "one refund on the books");
    assert.equal(books[0].t, -books[1].t);
    const o = (await admin.query("SELECT o.status, o.refund_pending FROM event_ticket_orders o JOIN commerce_payments p ON p.ticket_order_id=o.id WHERE p.id=$1", [pid])).rows[0];
    assert.deepEqual([o.status, o.refund_pending], ["refunded", false]);
    assert.match((await admin.query("SELECT detail FROM audit_events WHERE action='refund' AND resource_id=$1", [pid])).rows[0].detail, /reconciled=true/);
  });

  it("a refused refund puts the payment back as paid and the tickets work again", async () => {
    const r = await buy("pa", "pprefuse", "paypal");
    const pid = r.body.data.payment.id;
    [...mock.st.paypal.values()].find(o => o.request.purchase_units[0].reference_id === pid).status = "APPROVED";
    const paid = await as("pa")("POST", `/api/commerce/payments/${pid}/confirm`, {});
    mock.st.failNext = /\/refund$/;
    const ref = await as("supt1")("POST", `/api/commerce/payments/${pid}/refund`, {});
    assert.equal(ref.status, 502);
    assert.deepEqual([(await payment(pid)).status, (await payment(pid)).pending_since], ["succeeded", null]);
    assert.equal((await as("p1")("POST", `/api/events/${eventId}/check-in`, { ticketCode: paid.body.data.tickets[0].code })).status, 200);
  });

  it("concurrent webhook workers cannot claim the same inbox event", async () => {
    const checkout = await buy("pa", "webhook-concurrent-claim", "paypal");
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    const pid = checkout.body.data.payment.id;
    const p = await payment(pid);
    assert.equal(p.status, "requires_confirmation");
    assert.ok(p.payer_actor?.userId);
    const eventId = "evt_concurrent_claim_integration_0001";
    await admin.query(`
      INSERT INTO commerce_webhook_events
        (district_id,payment_id,processor,provider_event_id,event_type,payload_sha256,
         provider_ref,provider_capture_ref,amount_cents,currency,state)
      VALUES ($1,$2,'paypal',$3,'PAYMENT.CAPTURE.COMPLETED',$4,$5,'CAPTURECONC001',
              $6,'USD','received')
    `, [ID.d1, pid, eventId, "c".repeat(64), p.provider_ref, p.amount_cents]);

    const workers = [new pg.Client(db.appUrl), new pg.Client(db.appUrl)];
    await Promise.all(workers.map(c => c.connect()));
    let claims;
    try {
      claims = await Promise.all(workers.map(c =>
        c.query("SELECT eduos_commerce_claim_webhook() AS event")
      ));
    } finally {
      await Promise.all(workers.map(c => c.end()));
    }
    const claimed = claims.map(r => r.rows[0].event).filter(Boolean);
    assert.equal(claimed.length, 1, "exactly one concurrent worker receives the event");
    assert.equal(claimed[0].id, (await admin.query(
      "SELECT id FROM commerce_webhook_events WHERE provider_event_id=$1", [eventId]
    )).rows[0].id);
    const state = (await admin.query(
      "SELECT state,attempts,claimed_at FROM commerce_webhook_events WHERE provider_event_id=$1", [eventId]
    )).rows[0];
    assert.equal(state.state, "processing");
    assert.equal(state.attempts, 1, "the competing worker did not consume another attempt");
    assert.ok(state.claimed_at);
    await admin.query(
      "UPDATE commerce_webhook_events SET state='ignored',last_error_code='integration_claim_test' WHERE provider_event_id=$1",
      [eventId]
    );
  });

  it("recovers an expired webhook lease and fences the stale worker", async () => {
    const checkout = await buy("pa", "webhook-lease-fencing", "paypal");
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    const pid = checkout.body.data.payment.id;
    const p = await payment(pid);
    const eventId = "evt_lease_fencing_integration_0001";
    await admin.query(`
      INSERT INTO commerce_webhook_events
        (district_id,payment_id,processor,provider_event_id,event_type,payload_sha256,
         provider_ref,provider_capture_ref,amount_cents,currency,state,attempts,claimed_at)
      VALUES ($1,$2,'paypal',$3,'PAYMENT.CAPTURE.COMPLETED',$4,$5,'CAPTURELEASE001',
              $6,'USD','processing',1,now()-interval '6 minutes')
    `, [ID.d1, pid, eventId, "b".repeat(64), p.provider_ref, p.amount_cents]);
    const runtime = new pg.Client(db.appUrl);
    await runtime.connect();
    try {
      // Model a process that died after its first claim: insert the persisted
      // expired lease directly, avoiding a real five-minute test delay.
      const first = { id: (await admin.query(
        "SELECT id FROM commerce_webhook_events WHERE provider_event_id=$1", [eventId]
      )).rows[0].id, attempts: 1 };
      const second = (await runtime.query("SELECT eduos_commerce_claim_webhook() AS event")).rows[0].event;
      assert.equal(second.id, first.id);
      assert.equal(second.attempts, 2, "recovery creates a new, higher fencing token");

      // The stale worker's conditional terminal write must not match the new
      // lease. The current claim remains processing and can still settle.
      const stale = await runtime.query(
        "UPDATE commerce_webhook_events SET state='ignored',last_error_code='stale_worker' WHERE id=$1 AND state='processing' AND attempts=$2",
        [first.id, first.attempts]
      );
      assert.equal(stale.rowCount, 0, "the previous lease cannot finish the event");
      const current = (await admin.query(
        "SELECT state,attempts,claimed_at FROM commerce_webhook_events WHERE id=$1", [first.id]
      )).rows[0];
      assert.equal(current.state, "processing");
      assert.equal(current.attempts, 2);
      assert.ok(current.claimed_at);
      await admin.query(
        "UPDATE commerce_webhook_events SET state='ignored',last_error_code='integration_lease_test' WHERE id=$1",
        [first.id]
      );
    } finally { await runtime.end(); }
    assert.equal((await payment(pid)).status, "requires_confirmation", "lease recovery alone cannot settle payment");
  });

  it("webhooks with no persisted payer actor are closed without a settlement claim", async () => {
    const checkout = await buy("pa", "webhook-missing-actor", "paypal");
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    const pid = checkout.body.data.payment.id;
    const p = await payment(pid);
    assert.equal(p.status, "requires_confirmation");
    assert.ok(p.provider_ref);
    assert.ok(p.payer_actor?.userId, "normal checkout persists the authenticated payer");

    // Simulate a legacy or damaged row: a provider callback cannot invent the
    // authenticated user needed by the existing settlement/audit path.
    await admin.query("UPDATE commerce_payments SET payer_actor=NULL WHERE id=$1", [pid]);
    const eventId = "evt_missing_actor_integration_0001";
    await admin.query(`
      INSERT INTO commerce_webhook_events
        (district_id,payment_id,processor,provider_event_id,event_type,payload_sha256,
         provider_ref,provider_capture_ref,amount_cents,currency,state)
      VALUES ($1,$2,'paypal',$3,'PAYMENT.CAPTURE.COMPLETED',$4,$5,'CAPTUREMISS001',
              $6,'USD','received')
    `, [ID.d1, pid, eventId, "a".repeat(64), p.provider_ref, p.amount_cents]);

    const runtime = new pg.Client(db.appUrl);
    await runtime.connect();
    try {
      const claimed = await runtime.query("SELECT eduos_commerce_claim_webhook() AS event");
      assert.equal(claimed.rows[0].event, null, "missing-actor event is never handed to the worker");
    } finally { await runtime.end(); }

    const event = (await admin.query(
      "SELECT state,last_error_code,processed_at,claimed_at FROM commerce_webhook_events WHERE provider_event_id=$1",
      [eventId]
    )).rows[0];
    assert.equal(event.state, "ignored");
    assert.equal(event.last_error_code, "missing_payer_actor");
    assert.ok(event.processed_at, "ignored event is terminally timestamped");
    assert.equal(event.claimed_at, null);
    assert.equal((await payment(pid)).status, "requires_confirmation", "no payment settlement occurred");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM commerce_ledger_entries WHERE payment_id=$1 AND entry_kind='settlement'", [pid])).rows[0].n, 0);
  });

  it("routes a provider capture after ticket-hold expiry to the operator refund queue without issuing tickets", async () => {
    await admin.query(`UPDATE commerce_webhook_events SET state='ignored',last_error_code='test_queue_isolation'
      WHERE state IN ('received','failed','processing')`);
    const checkout = await buy("pa", "webhook-late-capture-refund", "paypal");
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    const pid = checkout.body.data.payment.id;
    const p = await payment(pid);
    const providerEventId = "evt_late_capture_refund_0001";
    await admin.query(
      "UPDATE event_ticket_orders SET hold_expires_at=now()-interval '1 minute' WHERE id=$1",
      [p.ticket_order_id]
    );
    await admin.query(`
      INSERT INTO commerce_webhook_events
        (district_id,payment_id,processor,provider_event_id,event_type,payload_sha256,
         provider_ref,provider_capture_ref,amount_cents,currency,state)
      VALUES ($1,$2,'paypal',$3,'PAYMENT.CAPTURE.COMPLETED',$4,$5,'CAPTURELATE001',
              $6,'USD','received')
    `, [ID.d1, pid, providerEventId, "a".repeat(64), p.provider_ref, p.amount_cents]);

    const configKeys = ["DATABASE_URL","PUBLIC_ORIGIN","OIDC_ISSUER","OIDC_CLIENT_ID","OIDC_CLIENT_SECRET","OIDC_REDIRECT_URI"];
    const priorConfig = Object.fromEntries(configKeys.map(k => [k, process.env[k]]));
    Object.assign(process.env, {
      DATABASE_URL: db.appUrl, PUBLIC_ORIGIN: server.base, OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: "eduos-integration-test", OIDC_CLIENT_SECRET: "eduos-integration-test-secret",
      OIDC_REDIRECT_URI: `${server.base}/auth/callback`
    });
    let applyVerifiedWebhook;
    try { ({ applyVerifiedWebhook } = await import("../../src/commerce/service.js")); }
    finally {
      for (const k of configKeys) {
        if (priorConfig[k] === undefined) delete process.env[k];
        else process.env[k] = priorConfig[k];
      }
    }

    const runtime = new pg.Client(db.appUrl);
    await runtime.connect();
    let caseId;
    try {
      const claim = (await runtime.query("SELECT eduos_commerce_claim_webhook() AS event")).rows[0].event;
      assert.ok(claim, "late capture event is claimed");
      assert.equal(claim.providerEventId, providerEventId);
      await runtime.query("BEGIN");
      await runtime.query(
        "SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id','',true)",
        [ID.d1, USERS.pa[0], "parent"]
      );
      const applied = await applyVerifiedWebhook(runtime, {
        actor: { districtId: ID.d1, userId: USERS.pa[0], role: "parent", schoolId: null },
        requestId: "webhook-late-capture-refund", reconciled: true
      }, {
        webhookEventId: claim.id, paymentId: pid, processor: "paypal", providerRef: p.provider_ref,
        captureRef: "CAPTURELATE001", amountCents: p.amount_cents, currency: "USD"
      });
      assert.deepEqual([applied.outcome, applied.reason], ["ignored", "payment_after_hold_refund_required"]);
      await runtime.query(
        "UPDATE commerce_webhook_events SET state='ignored',last_error_code=$2 WHERE id=$1 AND state='processing'",
        [claim.id, applied.reason.replace(/[^a-z0-9_]/g, "_")]
      );
      await runtime.query("COMMIT");
    } catch (error) {
      await runtime.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { await runtime.end(); }

    const latePayment = await payment(pid);
    assert.equal(latePayment.status, "expired");
    assert.equal(latePayment.provider_capture_ref, "CAPTURELATE001");
    assert.equal((await admin.query(
      "SELECT count(*)::int AS n FROM event_tickets WHERE order_id=$1", [p.ticket_order_id]
    )).rows[0].n, 0, "a late capture never issues tickets");
    assert.equal((await admin.query(
      "SELECT count(*)::int AS n FROM commerce_ledger_entries WHERE payment_id=$1 AND entry_kind='settlement'", [pid]
    )).rows[0].n, 0, "a late capture never creates a ticket settlement");
    const refundCase = (await admin.query(
      "SELECT id,status,reason_code FROM commerce_webhook_refund_cases WHERE payment_id=$1 AND provider_capture_ref=$2",
      [pid, "CAPTURELATE001"]
    )).rows[0];
    assert.deepEqual([refundCase.status, refundCase.reason_code], ["open", "ticket_hold_expired"]);
    caseId = refundCase.id;
    const visible = await as("supt1")("GET", "/api/commerce/providers/webhook-refund-cases");
    assert.equal(visible.status, 200, JSON.stringify(visible.body));
    assert.ok(visible.body.data.refundCases.some(x => x.id === caseId));
    assert.equal(Object.hasOwn(visible.body.data.refundCases.find(x => x.id === caseId), "payerUserId"), false,
      "operator queue does not expose payer identity");
    assert.equal((await as("p1")("GET", "/api/commerce/providers/webhook-refund-cases")).status, 403,
      "ordinary parents cannot inspect the refund queue");
    assert.equal((await as("p1")("POST", `/api/commerce/providers/webhook-refund-cases/${caseId}/resolve`, {
      resolutionNote: "Attempted unauthorized refund resolution."
    })).status, 403, "ordinary parents cannot resolve a refund case");
    const resolved = await as("supt1")("POST", `/api/commerce/providers/webhook-refund-cases/${caseId}/resolve`, {
      resolutionNote: "Refund confirmed in the PayPal merchant console."
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal((await admin.query(
      "SELECT status FROM commerce_webhook_refund_cases WHERE id=$1", [caseId]
    )).rows[0].status, "resolved");
    assert.equal((await as("supt1")("GET", "/api/commerce/providers/webhook-refund-cases")).body.data.refundCases
      .some(x => x.id === caseId), false, "resolved cases leave the open queue");
    assert.equal((await as("supt1")("POST", `/api/commerce/providers/webhook-refund-cases/${caseId}/resolve`, {
      resolutionNote: "Duplicate resolution must not overwrite the original."
    })).status, 404, "a resolved case cannot be resolved a second time");
  });

  it("moves the twentieth failed webhook attempt to a terminal dead letter", async () => {
    await admin.query(`UPDATE commerce_webhook_events SET state='ignored',last_error_code='test_queue_isolation'
      WHERE state IN ('received','failed','processing')`);
    const checkout = await buy("pa", "webhook-dead-letter-exhaustion", "paypal");
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    const pid = checkout.body.data.payment.id;
    const p = await payment(pid);
    const providerEventId = "evt_dead_letter_exhaustion_0001";
    await admin.query(`
      INSERT INTO commerce_webhook_events
        (district_id,payment_id,processor,provider_event_id,event_type,payload_sha256,
         provider_ref,provider_capture_ref,amount_cents,currency,state,attempts,claimed_at,received_at)
      VALUES ($1,$2,'paypal',$3,'PAYMENT.CAPTURE.COMPLETED',$4,$5,'CAPTUREDEADLETTER1',
              $6,'USD','processing',19,now()-interval '6 minutes', '2000-01-01T00:00:00Z')
    `, [ID.d1, pid, providerEventId, "9".repeat(64), p.provider_ref, p.amount_cents]);

    const runtime = new pg.Client(db.appUrl);
    await runtime.connect();
    try {
      const claim = (await runtime.query("SELECT eduos_commerce_claim_webhook() AS event")).rows[0].event;
      assert.equal(claim?.attempts, 20, "expired nineteenth lease is reclaimed as attempt twenty");
      assert.equal(claim?.id, (await admin.query(
        "SELECT id FROM commerce_webhook_events WHERE provider_event_id=$1", [providerEventId]
      )).rows[0].id);

      // Exercise the same fenced terminal update used by the worker's catch
      // path after the final attempt fails.
      await runtime.query(
        "SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id','',true)",
        [ID.d1, USERS.pa[0], "parent"]
      );
      const marked = await runtime.query(`
        UPDATE commerce_webhook_events
           SET state=CASE WHEN attempts >= 20 THEN 'dead_letter' ELSE 'failed' END,
               last_error_code='provider_timeout'
         WHERE id=$1 AND state='processing' AND attempts=$2
      `, [claim.id, claim.attempts]);
      assert.equal(marked.rowCount, 1);
      const next = await runtime.query("SELECT eduos_commerce_claim_webhook() AS event");
      assert.equal(next.rows[0].event, null, "dead-letter events are never claimed again");
    } finally { await runtime.end(); }

    const terminal = (await admin.query(
      "SELECT state,attempts,last_error_code,processed_at,claimed_at FROM commerce_webhook_events WHERE provider_event_id=$1",
      [providerEventId]
    )).rows[0];
    assert.deepEqual(
      [terminal.state, terminal.attempts, terminal.last_error_code],
      ["dead_letter", 20, "provider_timeout"]
    );
    assert.ok(terminal.processed_at, "dead letter has a terminal timestamp");
    assert.equal(terminal.claimed_at, null, "dead letter releases its lease");
    assert.equal((await payment(pid)).status, "requires_confirmation", "failed provider processing never settles the payment");
    assert.equal((await admin.query(
      "SELECT count(*)::int AS n FROM commerce_ledger_entries WHERE payment_id=$1 AND entry_kind='settlement'", [pid]
    )).rows[0].n, 0);
    const visible = await as("supt1")("GET", "/api/commerce/providers/webhook-dead-letters");
    assert.equal(visible.status, 200, JSON.stringify(visible.body));
    const reported = visible.body.data.deadLetters.find(e => e.providerEventId === providerEventId);
    assert.ok(reported, "authorized provider administrators can see exhausted events");
    assert.deepEqual([reported.attempts, reported.errorCode], [20, "provider_timeout"]);
    assert.equal(Object.hasOwn(reported, "payload"), false, "operator view never exposes provider payloads");
  });

  it("rolls back settlement on worker crash and safely retries after lease expiry", async () => {
    await admin.query(`UPDATE commerce_webhook_events SET state='ignored',last_error_code='test_queue_isolation'
      WHERE state IN ('received','failed','processing')`);
    const checkout = await buy("pa", "webhook-crash-rollback", "paypal");
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    const pid = checkout.body.data.payment.id;
    const p = await payment(pid);
    const providerEventId = "evt_crash_rollback_integration_0001";
    await admin.query(`
      INSERT INTO commerce_webhook_events
        (district_id,payment_id,processor,provider_event_id,event_type,payload_sha256,
         provider_ref,provider_capture_ref,amount_cents,currency,state)
      VALUES ($1,$2,'paypal',$3,'PAYMENT.CAPTURE.COMPLETED',$4,$5,'CAPTURECRASH001',
              $6,'USD','received')
    `, [ID.d1, pid, providerEventId, "f".repeat(64), p.provider_ref, p.amount_cents]);

    const configKeys = ["DATABASE_URL","PUBLIC_ORIGIN","OIDC_ISSUER","OIDC_CLIENT_ID","OIDC_CLIENT_SECRET","OIDC_REDIRECT_URI"];
    const priorConfig = Object.fromEntries(configKeys.map(k => [k, process.env[k]]));
    Object.assign(process.env, {
      DATABASE_URL: db.appUrl,
      PUBLIC_ORIGIN: server.base,
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: "eduos-integration-test",
      OIDC_CLIENT_SECRET: "eduos-integration-test-secret",
      OIDC_REDIRECT_URI: `${server.base}/auth/callback`
    });
    let applyVerifiedWebhook;
    try { ({ applyVerifiedWebhook } = await import("../../src/commerce/service.js")); }
    finally {
      for (const k of configKeys) {
        if (priorConfig[k] === undefined) delete process.env[k];
        else process.env[k] = priorConfig[k];
      }
    }
    const actor = { districtId: ID.d1, userId: USERS.pa[0], role: "parent", schoolId: null };
    const req = { actor, requestId: "webhook-crash-rollback-integration", reconciled: true };
    const runtime = new pg.Client(db.appUrl);
    await runtime.connect();
    try {
      const first = (await runtime.query("SELECT eduos_commerce_claim_webhook() AS event")).rows[0].event;
      assert.equal(first.attempts, 1);
      await runtime.query("BEGIN");
      await runtime.query(
        "SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id','',true)",
        [actor.districtId, actor.userId, actor.role]
      );
      const appliedBeforeCrash = await applyVerifiedWebhook(runtime, req, {
        webhookEventId: first.id, paymentId: pid, processor: "paypal", providerRef: p.provider_ref,
        captureRef: "CAPTURECRASH001", amountCents: p.amount_cents, currency: "USD"
      });
      assert.equal(appliedBeforeCrash.outcome, "applied");
      // Simulate process death after business writes but before the inbox ack:
      // PostgreSQL rolls back payment, ticket, EDAL and ledger together.
      await runtime.query("ROLLBACK");

      assert.equal((await payment(pid)).status, "requires_confirmation");
      assert.equal((await admin.query(
        "SELECT count(*)::int AS n FROM commerce_ledger_entries WHERE payment_id=$1 AND entry_kind='settlement'", [pid]
      )).rows[0].n, 0);
      assert.equal((await admin.query(
        "SELECT count(*)::int AS n FROM event_ticket_orders o JOIN commerce_payments p ON p.ticket_order_id=o.id WHERE p.id=$1", [pid]
      )).rows[0].n, 0);

      await admin.query(
        "UPDATE commerce_webhook_events SET claimed_at=now()-interval '6 minutes' WHERE provider_event_id=$1",
        [providerEventId]
      );
      const retry = (await runtime.query("SELECT eduos_commerce_claim_webhook() AS event")).rows[0].event;
      assert.equal(retry.id, first.id);
      assert.equal(retry.attempts, 2, "expired lease recovery fences the crashed attempt");

      await runtime.query("BEGIN");
      await runtime.query(
        "SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id','',true)",
        [actor.districtId, actor.userId, actor.role]
      );
      const appliedAfterRetry = await applyVerifiedWebhook(runtime, req, {
        webhookEventId: retry.id, paymentId: pid, processor: "paypal", providerRef: p.provider_ref,
        captureRef: "CAPTURECRASH001", amountCents: p.amount_cents, currency: "USD"
      });
      assert.equal(appliedAfterRetry.outcome, "applied");
      await runtime.query(
        "UPDATE commerce_webhook_events SET state='applied',last_error_code=NULL WHERE id=$1 AND state='processing' AND attempts=$2",
        [retry.id, retry.attempts]
      );
      await runtime.query("COMMIT");
    } finally {
      await runtime.end();
    }

    assert.equal((await payment(pid)).status, "succeeded");
    assert.equal((await admin.query(
      "SELECT count(*)::int AS n FROM event_ticket_orders o JOIN commerce_payments p ON p.ticket_order_id=o.id WHERE p.id=$1", [pid]
    )).rows[0].n, 1);
    assert.equal((await admin.query(
      "SELECT count(*)::int AS n FROM commerce_ledger_entries WHERE payment_id=$1 AND entry_kind='settlement'", [pid]
    )).rows[0].n, 1);
    const terminal = (await admin.query(
      "SELECT state,attempts,processed_at,claimed_at FROM commerce_webhook_events WHERE provider_event_id=$1",
      [providerEventId]
    )).rows[0];
    assert.deepEqual([terminal.state, terminal.attempts], ["applied", 2]);
    assert.ok(terminal.processed_at);
    assert.equal(terminal.claimed_at, null);
  });

  it("distinct verified notifications for one capture settle tickets and ledger only once", async () => {
    await admin.query(`UPDATE commerce_webhook_events SET state='ignored',last_error_code='test_queue_isolation'
      WHERE state IN ('received','failed','processing')`);
    const checkout = await buy("pa", "webhook-settlement-idempotency", "paypal");
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    const pid = checkout.body.data.payment.id;
    const p = await payment(pid);
    assert.equal(p.status, "requires_confirmation");
    assert.ok(p.payer_actor?.userId);

    const captureRef = "CAPTURE_IDEMPOTENT_001";
    const eventIds = [
      "evt_settlement_idempotency_0001",
      "evt_settlement_idempotency_0002"
    ];
    for (let i = 0; i < eventIds.length; i++) {
      await admin.query(`
        INSERT INTO commerce_webhook_events
          (district_id,payment_id,processor,provider_event_id,event_type,payload_sha256,
           provider_ref,provider_capture_ref,amount_cents,currency,state,received_at)
        VALUES ($1,$2,'paypal',$3,'PAYMENT.CAPTURE.COMPLETED',$4,$5,$6,$7,'USD','received',
                now() + ($8 * interval '1 second'))
      `, [ID.d1, pid, eventIds[i], String(i + 1).repeat(64), p.provider_ref,
        captureRef, p.amount_cents, i]);
    }

    const actor = { districtId: ID.d1, userId: USERS.pa[0], role: "parent", schoolId: null };
    const req = { actor, requestId: "webhook-idempotency-integration", reconciled: true };
    // Load the application service only in the PostgreSQL integration path;
    // its config module intentionally requires deployment environment values.
    const configKeys = ["DATABASE_URL","PUBLIC_ORIGIN","OIDC_ISSUER","OIDC_CLIENT_ID","OIDC_CLIENT_SECRET","OIDC_REDIRECT_URI"];
    const priorConfig = Object.fromEntries(configKeys.map(k => [k, process.env[k]]));
    Object.assign(process.env, {
      DATABASE_URL: db.appUrl,
      PUBLIC_ORIGIN: server.base,
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: "eduos-integration-test",
      OIDC_CLIENT_SECRET: "eduos-integration-test-secret",
      OIDC_REDIRECT_URI: `${server.base}/auth/callback`
    });
    let applyVerifiedWebhook;
    try { ({ applyVerifiedWebhook } = await import("../../src/commerce/service.js")); }
    finally {
      for (const k of configKeys) {
        if (priorConfig[k] === undefined) delete process.env[k];
        else process.env[k] = priorConfig[k];
      }
    }
    const runtime = new pg.Client(db.appUrl);
    await runtime.connect();
    const outcomes = [];
    try {
      for (const eventId of eventIds) {
        const claim = await runtime.query("SELECT eduos_commerce_claim_webhook() AS event");
        assert.equal(claim.rows[0].event?.id, (await admin.query(
          "SELECT id FROM commerce_webhook_events WHERE provider_event_id=$1", [eventId]
        )).rows[0].id, "the worker claim function leases this event before settlement");
        await runtime.query("BEGIN");
        try {
          await runtime.query(
            "SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id','',true)",
            [actor.districtId, actor.userId, actor.role]
          );
          const applied = await applyVerifiedWebhook(runtime, req, {
            webhookEventId: claim.rows[0].event.id, paymentId: pid, processor: "paypal", providerRef: p.provider_ref,
            captureRef, amountCents: p.amount_cents, currency: "USD"
          });
          const state = applied.outcome === "applied" ? "applied" : "ignored";
          await runtime.query(
            "UPDATE commerce_webhook_events SET state=$2,last_error_code=$3 WHERE id=$1",
            [claim.rows[0].event.id, state, state === "ignored" ? "payment_not_awaiting_confirmation" : null]
          );
          outcomes.push(applied.outcome === "applied" ? applied.outcome : `${applied.outcome}:${applied.reason}`);
          await runtime.query("COMMIT");
        } catch (error) {
          await runtime.query("ROLLBACK");
          throw error;
        }
      }
    } finally { await runtime.end(); }

    assert.deepEqual(outcomes, ["applied", "ignored:payment_not_awaiting_confirmation"]);
    assert.equal((await payment(pid)).status, "succeeded");
    const ticketCount = (await admin.query(
      "SELECT count(*)::int AS n FROM event_tickets t JOIN event_ticket_orders o ON o.id=t.order_id WHERE o.id=(SELECT ticket_order_id FROM commerce_payments WHERE id=$1)",
      [pid]
    )).rows[0].n;
    assert.equal(ticketCount, 1, "the duplicate notification did not issue a second ticket");
    const settlements = await admin.query(
      "SELECT count(*)::int AS n FROM commerce_ledger_entries WHERE payment_id=$1 AND entry_kind='settlement'",
      [pid]
    );
    assert.equal(settlements.rows[0].n, 1, "the ledger has one settlement");
    const events = await admin.query(
      "SELECT state FROM commerce_webhook_events WHERE provider_event_id=ANY($1::text[]) ORDER BY provider_event_id",
      [eventIds]
    );
    assert.deepEqual(events.rows.map(row => row.state), ["applied", "ignored"]);
  });

  it("provider retries are idempotent and conflicting event IDs are rejected", async () => {
    const checkout = await buy("pa", "webhook-provider-retry", "paypal");
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    const pid = checkout.body.data.payment.id;
    const p = await payment(pid);
    assert.equal(p.status, "requires_confirmation");
    assert.ok(p.provider_ref);

    // The raw endpoint credential is never stored; only its digest is.
    const token = "a".repeat(64);
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    await admin.query(
      "UPDATE commerce_provider_accounts SET enabled=true,mode='test' WHERE district_id=$1 AND processor='paypal'",
      [ID.d1]
    );
    await admin.query(
      "INSERT INTO commerce_webhook_endpoints(district_id,processor,token_sha256,created_by) VALUES($1,'paypal',$2,$3)",
      [ID.d1, tokenHash, "a0000000-0000-4000-8000-0000000000f1"]
    );

    const providerEventId = "evt_provider_retry_integration_0001";
    const payloadHash = "d".repeat(64);
    const args = [tokenHash, "paypal", providerEventId, "PAYMENT.CAPTURE.COMPLETED",
      payloadHash, p.provider_ref, "CAPTURE_RETRY_0001", p.amount_cents, "USD"];
    const receive = () => admin.query(
      "SELECT eduos_commerce_receive_webhook($1,$2,$3,$4,$5,$6,$7,$8,$9) AS outcome", args
    );
    assert.equal((await receive()).rows[0].outcome, "received");
    assert.equal((await receive()).rows[0].outcome, "duplicate",
      "an identical provider retry is acknowledged without another inbox row");

    const conflict = await admin.query(
      "SELECT eduos_commerce_receive_webhook($1,$2,$3,$4,$5,$6,$7,$8,$9) AS outcome",
      [...args.slice(0, 4), "e".repeat(64), ...args.slice(5)]
    );
    assert.equal(conflict.rows[0].outcome, "event_id_conflict",
      "reusing an event ID with a different payload is not silently accepted");
    const saved = await admin.query(
      "SELECT count(*)::int AS n,state,payload_sha256 FROM commerce_webhook_events WHERE processor='paypal' AND provider_event_id=$1 GROUP BY state,payload_sha256",
      [providerEventId]
    );
    assert.equal(saved.rows.length, 1);
    assert.deepEqual([saved.rows[0].n, saved.rows[0].state, saved.rows[0].payload_sha256], [1, "received", payloadHash]);
    assert.equal((await payment(pid)).status, "requires_confirmation", "intake never settles a payment");
  });

  it("no database transaction is open while any processor is called (pg_stat_activity)", async () => {
    // Every flow above went through the mock (create, confirm/capture, refund,
    // test connection, the sweep's retries); add BTCPay's connection test.
    assert.equal((await as("supt1")("POST", "/api/commerce/providers/btcpay/test", {})).body.data.detail, "store_ok");
    const btc = await buy("pa", "btcprobe", "bitcoin");
    assert.equal(btc.status, 201, JSON.stringify(btc.body));
    const open = mock.st.probes.filter(p => p.open > 0);
    assert.deepEqual(open, [], "every processor call ran with no EduOS transaction open");
    const seen = mock.st.probes.map(p => `${p.method} ${p.path.replace(/[A-Z]+\d{6,}/g, ":id").replace(/\/[A-Z0-9]{17,}\//g, "/:id/")}`);
    for (const call of ["POST /paypal/v1/oauth2/token", "POST /paypal/v2/checkout/orders", "POST /paypal/v2/checkout/orders/:id/capture", "POST /paypal/v2/payments/captures/:id/refund",
      "GET /square/v2/locations/LOC12345", "POST /square/v2/online-checkout/payment-links", "GET /square/v2/orders/:id", "POST /square/v2/refunds",
      "GET /btcpay/api/v1/stores/STORE12345", "GET /btcpay/api/v1/stores/STORE12345/invoices", "POST /btcpay/api/v1/stores/STORE12345/invoices", "GET /btcpay/api/v1/stores/STORE12345/invoices/:id"]) {
      assert.ok(seen.includes(call), `covered: ${call} (seen ${[...new Set(seen)].join(", ")})`);
    }
  });
});

