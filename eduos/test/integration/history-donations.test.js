// TC-09: voluntary donations (sandbox only) against real PostgreSQL as the
// runtime role. Off until the superintendent turns them on; adults only;
// the sandbox is the only processor a gift can use; every completed gift
// gets an acknowledgement that makes no tax claim unless the district adds
// its own wording; nothing touches a student or a storage limit.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const SETTINGS = { enabled: true, minCents: 500, maxCents: 100000, suggestedCents: [1000, 2500], acknowledgementText: "Thank you for helping keep our students' histories safe." };

describe("TC-09 donations against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const key = () => `k-${crypto.randomUUID()}`;
  const give = (who, body) => as(who)("POST", "/api/donations", { idempotencyKey: key(), ...body });

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, CAPSULE_RELEASE_INTERVAL_SECONDS: "0" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["t1", "p1", "supt1", "supt2", "pa", "pb", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("is off until the superintendent turns it on, and needs a sandbox method", async () => {
    const st = ok(await as("pa")("GET", "/api/donations/status"));
    assert.equal(st.enabled, false);
    assert.equal(st.reason, "donations_not_enabled");
    assert.equal(st.sandboxOnly, true);
    assert.equal(st.changesStorage, false);
    assert.equal((await give("pa", { amountCents: 1000 })).status, 503);
    for (const who of ["p1", "t1", "pa", "pu"]) assert.equal((await as(who)("PUT", "/api/donations/settings", SETTINGS)).status, 403, who);
    assert.equal((await as("supt1")("PUT", "/api/donations/settings", { ...SETTINGS, taxWordingEnabled: true })).status, 400, "tax wording needs its text");
    ok(await as("supt1")("PUT", "/api/donations/settings", SETTINGS));
    assert.equal(ok(await as("pa")("GET", "/api/donations/status")).reason, "no_sandbox_method");
    ok(await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["sandbox", "paypal"], defaultMethod: "sandbox" }));
    const now = ok(await as("pa")("GET", "/api/donations/status"));
    assert.equal(now.enabled, true);
    assert.deepEqual(now.methods.map(m => [m.method, m.available]), [["sandbox", true], ["paypal", false]]);
    assert.equal(ok(await as("supt2")("GET", "/api/donations/status")).enabled, false, "another district's switch is its own");
  });

  it("an adult gives through the sandbox and gets an acknowledgement with no tax claim", async () => {
    const g = ok(await give("pa", { amountCents: 2500, schoolId: ID.s1 }), 201);
    assert.equal(g.status, "pending");
    assert.equal(g.test, true);
    assert.equal(g.processingFeeCents, Math.round(2500 * 0.029) + 30);
    const r = ok(await as("pa")("POST", `/api/donations/${g.id}/confirm`, { testOutcome: "sandbox_success" }));
    assert.equal(r.donation.status, "succeeded");
    assert.match(r.acknowledgement.number, /^GIFT-\d{4}-000001$/);
    assert.equal(r.acknowledgement.donor, "Parent A");
    assert.match(r.acknowledgement.designation, /preservation/);
    assert.equal(r.acknowledgement.taxWording, null);
    assert.equal(r.acknowledgement.test, true);
    assert.ok(!/deductib|tax/i.test(r.acknowledgement.body), "no tax claim");
    const again = ok(await as("pa")("POST", `/api/donations/${g.id}/confirm`, { testOutcome: "sandbox_success" }));
    assert.equal(again.acknowledgement.number, r.acknowledgement.number, "confirming twice gives the same record");
    assert.equal(ok(await as("pa")("GET", "/api/donations/mine")).length, 1);
    assert.equal(ok(await as("pa")("GET", `/api/donations/${g.id}/acknowledgement`)).number, r.acknowledgement.number);
  });

  it("the district's own tax wording appears only once it is switched on", async () => {
    ok(await as("supt1")("PUT", "/api/donations/settings", { ...SETTINGS, taxWordingEnabled: true, taxWording: "Wording approved by the district's counsel." }));
    const g = ok(await give("pb", { amountCents: 1000, anonymous: true }), 201);
    const r = ok(await as("pb")("POST", `/api/donations/${g.id}/confirm`, {}));
    assert.equal(r.acknowledgement.taxWording, "Wording approved by the district's counsel.");
    assert.match(r.acknowledgement.number, /-000002$/);
    const office = ok(await as("supt1")("GET", "/api/donations"));
    assert.equal(office.totals.gifts, 2);
    assert.equal(office.totals.grossCents, 3500);
    assert.deepEqual(office.gifts.map(x => x.donor).sort(), ["Anonymous", "Parent A"], "anonymous donors stay anonymous");
  });

  it("declines, idempotency and limits", async () => {
    const k = key();
    const g = ok(await as("pa")("POST", "/api/donations", { amountCents: 1500, idempotencyKey: k }), 201);
    assert.equal(ok(await as("pa")("POST", "/api/donations", { amountCents: 1500, idempotencyKey: k })).id, g.id, "the same request twice is one gift");
    assert.equal((await as("pa")("POST", "/api/donations", { amountCents: 1600, idempotencyKey: k })).status, 409);
    const r = ok(await as("pa")("POST", `/api/donations/${g.id}/confirm`, { testOutcome: "sandbox_decline" }));
    assert.equal(r.donation.status, "declined");
    assert.equal(r.acknowledgement, null);
    assert.equal((await as("pa")("POST", `/api/donations/${g.id}/confirm`, {})).status, 409);
    for (const amountCents of [499, 100001, 12.5, "1000"]) assert.equal((await give("pa", { amountCents })).status, 400, String(amountCents));
    assert.equal((await give("pa", { amountCents: 1000, paymentMethod: "paypal" })).status, 503, "paypal isn't connected");
    assert.equal((await give("pa", { amountCents: 1000, schoolId: crypto.randomUUID() })).status, 400);
  });

  it("students can't give; nobody sees or confirms someone else's gift", async () => {
    assert.equal((await give("pu", { amountCents: 1000 })).status, 403);
    const g = ok(await give("pa", { amountCents: 1000 }), 201);
    for (const who of ["pb", "t1", "p1", "supt2"]) {
      assert.equal((await as(who)("POST", `/api/donations/${g.id}/confirm`, {})).status, 404, who);
      assert.equal((await as(who)("GET", `/api/donations/${g.id}/acknowledgement`)).status, 404, who);
    }
    for (const who of ["pa", "p1", "t1"]) assert.equal((await as(who)("GET", "/api/donations")).status, 403, who);
    assert.equal(ok(await as("supt2")("GET", "/api/donations")).gifts.length, 0, "another district's superintendent sees none of them");
    assert.equal(ok(await as("supt2")("GET", "/api/donations/mine")).length, 0);
  });

  it("the runtime role can't fake a payment, change a gift or rewrite an acknowledgement", async () => {
    const runtime = new pg.Client(db.appUrl); await runtime.connect();
    try {
      await runtime.query("SELECT set_config('app.district_id',$1,false), set_config('app.user_id',$2,false), set_config('app.role','parent',false), set_config('app.school_id',$3,false)", [ID.d1, USERS.pa[0], ID.s1]);
      const ins = (provider, mode, status) => runtime.query(`INSERT INTO history_donations(district_id,donor_user_id,donor_name,amount_cents,processing_fee_cents,payment_method,provider,mode,provider_ref,idempotency_key,status)
        VALUES($1,$2,'Parent A',1000,0,'paypal',$3,$4,$5,$6,$7)`, [ID.d1, USERS.pa[0], provider, mode, provider === "sandbox" ? `pay_sandbox_${crypto.randomBytes(12).toString("hex")}` : "PAYPAL-ORDER-1", key(), status]);
      await assert.rejects(ins("paypal", "live", "pending"), "a real processor can't be recorded");
      await assert.rejects(ins("sandbox", "test", "succeeded"), "can't insert a paid gift");
      await assert.rejects(runtime.query("UPDATE history_donations SET status='succeeded'"), /permission denied/);
      await assert.rejects(runtime.query("UPDATE history_donation_acknowledgements SET body='x'"), /permission denied/);
      await assert.rejects(runtime.query("DELETE FROM history_donations"), /permission denied/);
      await assert.rejects(runtime.query("INSERT INTO history_donation_acknowledgements(district_id,donation_id,number,district_name,designation,donor_name,amount_cents,currency,body,test_mode) SELECT district_id,id,'GIFT-2026-999999','d','x','y',1,'USD','z',true FROM history_donations LIMIT 1"), /permission denied/);
      await runtime.query("SELECT set_config('app.user_id',$1,false)", [USERS.pb[0]]);
      const mine = (await runtime.query("SELECT donor_user_id FROM history_donations")).rows;
      assert.ok(mine.every(r => r.donor_user_id === USERS.pb[0]), "a donor sees only their own gifts");
      // Owners can't rewrite them either.
      await assert.rejects(admin.query("UPDATE history_donation_acknowledgements SET body='x'"), /append-only/);
      await assert.rejects(admin.query("DELETE FROM history_donations"), /kept/);
    } finally { await runtime.end(); }
    // No student data in any donation table.
    const cols = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name LIKE '%donation%'")).rows.map(r => r.column_name);
    assert.ok(!cols.some(c => /student/.test(c)), cols.join(","));
  });
});
