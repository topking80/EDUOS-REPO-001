// TC-10: donation accounting (sandbox only) against real PostgreSQL as the
// runtime role. Completed gifts post ledger lines; refunds post a refund line
// and a plain refund notice; the reconciliation report checks the gift
// records against the ledger. Nobody refunds their own gift, and whoever
// recorded a refund in a period can't sign that period off.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const fee = c => Math.round(c * 0.029) + 30;
const today = () => new Date().toISOString().slice(0, 10);

describe("TC-10 donation accounting against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, gifts = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const give = async (who, amountCents, testOutcome = "sandbox_success") => {
    const g = ok(await as(who)("POST", "/api/donations", { amountCents, idempotencyKey: `k-${crypto.randomUUID()}` }), 201);
    return ok(await as(who)("POST", `/api/donations/${g.id}/confirm`, { testOutcome })).donation;
  };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, CAPSULE_RELEASE_INTERVAL_SECONDS: "0" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["t1", "p1", "supt1", "supt1b", "supt2", "pa", "pb", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    ok(await as("supt1")("PUT", "/api/donations/settings", { enabled: true, minCents: 500, maxCents: 100000, suggestedCents: [1000] }));
    ok(await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["sandbox"], defaultMethod: "sandbox" }));
    gifts.pa = await give("pa", 2500);
    gifts.pb = await give("pb", 1000);
    gifts.t1 = await give("t1", 5000);
    gifts.declined = await give("pa", 700, "sandbox_decline");
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("completed gifts post a gift line and a fee line; declines post nothing", async () => {
    const l = ok(await as("supt1")("GET", "/api/donations/ledger"));
    assert.equal(l.lines.length, 6);
    assert.equal(l.totals.giftsCents, 8500);
    assert.equal(l.totals.feesCents, -(fee(2500) + fee(1000) + fee(5000)));
    assert.equal(l.totals.netCents, 8500 - fee(2500) - fee(1000) - fee(5000));
    assert.ok(!l.lines.some(x => x.donationId === gifts.declined.id));
    assert.ok(l.lines.every(x => x.test && /^pay_sandbox_/.test(x.providerRef) && /^GIFT-/.test(x.number)));
    assert.equal(ok(await as("supt2")("GET", "/api/donations/ledger")).lines.length, 0, "another district sees none");
    for (const who of ["p1", "t1", "pa", "pu"]) assert.equal((await as(who)("GET", "/api/donations/ledger")).status, 403, who);
  });

  it("the superintendent names staff as finance reviewers; families can't be named", async () => {
    assert.equal((await as("p1")("PUT", `/api/donations/finance/reviewers/${USERS.t1[0]}`, { on: true })).status, 403);
    assert.equal((await as("supt1")("PUT", `/api/donations/finance/reviewers/${USERS.pa[0]}`, { on: true })).status, 400, "a parent can't review");
    assert.equal((await as("supt2")("PUT", `/api/donations/finance/reviewers/${USERS.p1[0]}`, { on: true })).status, 400, "not staff in d2");
    ok(await as("supt1")("PUT", `/api/donations/finance/reviewers/${USERS.p1[0]}`, { on: true }));
    ok(await as("supt1")("PUT", `/api/donations/finance/reviewers/${USERS.p1[0]}`, { on: true })); // naming twice is fine
    ok(await as("supt1")("PUT", `/api/donations/finance/reviewers/${USERS.t1[0]}`, { on: true }));
    const r = ok(await as("supt1")("GET", "/api/donations/finance/reviewers"));
    assert.deepEqual(r.reviewers.map(x => x.name).sort(), ["Principal S1", "Teacher S1"].sort());
    assert.ok(!r.staff.some(x => x.id === USERS.pa[0]));
    assert.equal(ok(await as("p1")("GET", "/api/donations/finance/access")).finance, true);
    assert.equal(ok(await as("pa")("GET", "/api/donations/finance/access")).finance, false);
    assert.equal(ok(await as("p1")("GET", "/api/donations/ledger")).lines.length, 6);
    assert.equal(ok(await as("p1")("GET", "/api/donations")).gifts.length, 4);
  });

  it("a reviewer refunds a gift through the sandbox; the donor gets a plain refund notice", async () => {
    assert.equal((await as("t1")("POST", `/api/donations/${gifts.t1.id}/refund`, { reason: "Asked for it back" })).status, 403, "nobody refunds their own gift");
    assert.equal((await as("pa")("POST", `/api/donations/${gifts.pb.id}/refund`, { reason: "Asked for it back" })).status, 403);
    assert.equal((await as("p1")("POST", `/api/donations/${gifts.pa.id}/refund`, {})).status, 400, "a reason is required");
    assert.equal((await as("p1")("POST", `/api/donations/${gifts.declined.id}/refund`, { reason: "Asked for it back" })).status, 409);
    const r = ok(await as("p1")("POST", `/api/donations/${gifts.pa.id}/refund`, { reason: "Donor asked for it back" }));
    assert.match(r.number, /^GIFT-\d{4}-\d{6}-R$/);
    assert.equal(r.amountCents, 2500);
    assert.equal(r.feeKeptCents, fee(2500));
    assert.equal((await as("p1")("POST", `/api/donations/${gifts.pa.id}/refund`, { reason: "Donor asked for it back" })).status, 409, "once only");
    const mine = ok(await as("pa")("GET", "/api/donations/mine")).find(g => g.id === gifts.pa.id);
    assert.equal(mine.status, "refunded");
    assert.equal(mine.refundNotice.number, r.number);
    const n = ok(await as("pa")("GET", `/api/donations/${gifts.pa.id}/refund-notice`));
    assert.equal(n.amountCents, 2500);
    assert.equal(n.test, true);
    assert.ok(!/deductib|tax/i.test(n.body));
    for (const who of ["pb", "supt2", "pu"]) assert.equal((await as(who)("GET", `/api/donations/${gifts.pa.id}/refund-notice`)).status, 404, who);
    const l = ok(await as("supt1")("GET", "/api/donations/ledger"));
    assert.equal(l.totals.refundsCents, -2500);
    assert.equal(l.lines.length, 7);
  });

  it("reconciliation matches, and the refunder can't sign the period off", async () => {
    const rep = ok(await as("p1")("GET", `/api/donations/reconciliation?from=${today()}&to=${today()}`));
    assert.equal(rep.matched, true);
    assert.equal(rep.gifts, 3);
    assert.equal(rep.refunds, 1);
    assert.equal(rep.netCents, rep.ledgerNetCents);
    assert.equal(rep.netCents, 8500 - 2500 - fee(2500) - fee(1000) - fee(5000));
    assert.equal(rep.canSignOff, false);
    const blocked = await as("p1")("POST", "/api/donations/reconciliations", { from: today(), to: today() });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, "separation_of_duties");
    assert.equal((await as("pa")("POST", "/api/donations/reconciliations", { from: today(), to: today() })).status, 403);
    for (const q of ["from=2026-13-01&to=2026-12-01", "from=2026-02-01&to=2026-01-01", "from=2020-01-01&to=2026-01-01"])
      assert.equal((await as("supt1")("GET", `/api/donations/reconciliation?${q}`)).status, 400, q);
    const signed = ok(await as("supt1")("POST", "/api/donations/reconciliations", { from: today(), to: today(), note: "Sandbox month-end check" }));
    assert.equal(signed.matched, true);
    assert.equal(signed.reconciledBy, "Supt One");
    assert.equal(ok(await as("t1")("GET", "/api/donations/reconciliations")).length, 1);
  });

  it("a gift record with no ledger lines shows up as a discrepancy", async () => {
    await admin.query(`INSERT INTO history_donations(district_id,donor_user_id,donor_name,amount_cents,processing_fee_cents,payment_method,provider,mode,provider_ref,idempotency_key,status,confirmed_at)
      VALUES($1,$2,'Parent B',4000,146,'sandbox','sandbox','test',$3,$4,'succeeded',now())`, [ID.d1, USERS.pb[0], `pay_sandbox_${crypto.randomBytes(12).toString("hex")}`, `k-${crypto.randomUUID()}`]);
    const rep = ok(await as("supt1b")("GET", `/api/donations/reconciliation?from=${today()}&to=${today()}`));
    assert.equal(rep.matched, false);
    assert.deepEqual(rep.discrepancies.map(d => [d.kind, d.expectedCents, d.ledgerCents]).sort(), [["gift", 4000, null], ["processing_fee", -146, null]]);
    const signed = ok(await as("supt1b")("POST", "/api/donations/reconciliations", { from: today(), to: today() }));
    assert.equal(signed.matched, false, "a mismatch can be signed off as a mismatch, never hidden");
  });

  it("removing a reviewer ends their access; the runtime role can't write the books", async () => {
    ok(await as("supt1")("PUT", `/api/donations/finance/reviewers/${USERS.t1[0]}`, { on: false }));
    assert.equal((await as("t1")("GET", "/api/donations/ledger")).status, 403);
    assert.equal((await as("supt1")("PUT", `/api/donations/finance/reviewers/${USERS.t1[0]}`, { on: false })).status, 404);
    assert.equal(ok(await as("supt1")("GET", "/api/donations/finance/reviewers")).history.length, 2);
    const runtime = new pg.Client(db.appUrl); await runtime.connect();
    try {
      await runtime.query("SELECT set_config('app.district_id',$1,false), set_config('app.user_id',$2,false), set_config('app.role','superintendent',false), set_config('app.school_id','',false)", [ID.d1, USERS.supt1[0]]);
      await assert.rejects(runtime.query("INSERT INTO history_donation_ledger(district_id,donation_id,kind,amount_cents,currency,provider_ref,test_mode) VALUES($1,$2,'refund',-1,'USD','x',true)", [ID.d1, gifts.pb.id]), /permission denied/);
      await assert.rejects(runtime.query("UPDATE history_donation_ledger SET amount_cents=1"), /permission denied/);
      await assert.rejects(runtime.query("DELETE FROM history_donation_reconciliations"), /permission denied/);
      await assert.rejects(runtime.query("INSERT INTO history_donation_finance_reviewers(district_id,user_id,named_by) VALUES($1,$2,$2)", [ID.d1, USERS.pa[0]]), /permission denied/);
      await assert.rejects(runtime.query("SELECT eduos_history_donation_post_gift($1)", [gifts.pb.id]), /permission denied/);
      await runtime.query("SELECT set_config('app.role','principal',false), set_config('app.user_id',$1,false), set_config('app.school_id',$2,false)", [USERS.p1[0], ID.s1]);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM history_donation_finance_reviewers")).rows[0].n, 1, "a reviewer sees their own appointment");
      await runtime.query("SELECT set_config('app.role','parent',false), set_config('app.user_id',$1,false)", [USERS.pa[0]]);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM history_donation_ledger")).rows[0].n, 0, "a donor doesn't see the books");
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM history_donation_finance_reviewers")).rows[0].n, 0);
      await assert.rejects(runtime.query("SELECT eduos_history_donation_reconciliation(current_date, current_date)"), /forbidden/);
    } finally { await runtime.end(); }
    await assert.rejects(admin.query("UPDATE history_donation_ledger SET amount_cents=1"), /append-only/);
    await assert.rejects(admin.query("DELETE FROM history_donation_refunds"), /append-only/);
    await assert.rejects(admin.query("DELETE FROM history_donation_finance_reviewers"), /kept/);
  });
});
