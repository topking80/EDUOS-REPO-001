// TC-12: the district preservation fund (sandbox / ledger only) against real
// PostgreSQL as the runtime role. Collection is closed until the district
// documents legal, finance and governance approvals; disbursements need
// approvals from people other than the requester, each attesting no conflict;
// payment is recorded by someone other than the requester; spending can't
// exceed the source's balance; pauses stop collection and disbursement; the
// family summary shows totals only when published and enough people gave.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";
import { FUND_SETTINGS } from "./fund-helpers.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const fee = c => Math.round(c * 0.029) + 30;

describe("TC-12 preservation fund against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, req1;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const err = (r, code, error) => { assert.equal(r.status, code, JSON.stringify(r.body)); if (error) assert.equal(r.body.error, error); };
  const give = async (who, amountCents, schoolId = null) => {
    const r = await as(who)("POST", "/api/donations", { amountCents, schoolId, idempotencyKey: `k-${crypto.randomUUID()}` });
    if (r.status !== 201) return r;
    return ok(await as(who)("POST", `/api/donations/${r.body.data.id}/confirm`, {})).donation;
  };
  const gov = kind => as("supt1")("POST", "/api/preservation-fund/governance", { kind, reference: `Board minutes, item ${kind}`, approvedOn: "2026-11-01" });
  const ask = (who, body) => as(who)("POST", "/api/preservation-fund/disbursements",
    { category: "storage", description: "Archive storage for the district history store", payee: "Example Storage Co", invoiceRef: "INV-1001", amountCents: 3000, ...body });
  const vote = (who, id, decision = "approve", extra = {}) => as(who)("POST", `/api/preservation-fund/disbursements/${id}/vote`, { decision, noConflict: true, ...extra });
  const report = async (who = "supt1") => ok(await as(who)("GET", "/api/preservation-fund/report"));
  const unrestricted = r => r.balances.find(b => b.source.unrestricted);

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
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("collection stays closed until the fund is on and all three approvals are documented", async () => {
    const f = ok(await as("pa")("GET", "/api/preservation-fund"));
    assert.equal(f.collecting, false);
    assert.match(f.limits, /can't buy any student more storage/);
    assert.equal(f.summary.shown, false);
    err(await give("pa", 1000), 503, "fund_collection_closed");
    for (const who of ["p1", "t1", "pa"]) err(await as(who)("PUT", "/api/preservation-fund/settings", FUND_SETTINGS), 403);
    for (const who of ["p1", "pa"]) err(await as(who)("POST", "/api/preservation-fund/governance", { kind: "legal", reference: "Counsel memo 12", approvedOn: "2026-11-01" }), 403);
    err(await as("supt1")("POST", "/api/preservation-fund/governance", { kind: "legal", reference: "Counsel memo 12", approvedOn: "2999-01-01" }), 400);
    err(await as("supt1")("PUT", "/api/preservation-fund/settings", { ...FUND_SETTINGS, eligibleCategories: ["student_quota"] }), 400);
    err(await as("supt1")("PUT", "/api/preservation-fund/settings", { ...FUND_SETTINGS, approvalsRequired: 1 }), 400);
    const st = ok(await as("supt1")("PUT", "/api/preservation-fund/settings", FUND_SETTINGS));
    assert.equal(st.approvalsRequired, 2);
    assert.equal(st.publicReport, false);
    ok(await gov("legal")); ok(await gov("finance"));
    assert.equal(ok(await as("pa")("GET", "/api/preservation-fund")).collecting, false, "two of three isn't enough");
    // The database refuses a gift too, not just the API.
    const runtime = new pg.Client(db.appUrl); await runtime.connect();
    try {
      await runtime.query("SELECT set_config('app.district_id',$1,false), set_config('app.user_id',$2,false), set_config('app.role','parent',false), set_config('app.school_id',$3,false)", [ID.d1, USERS.pa[0], ID.s1]);
      await assert.rejects(runtime.query(`INSERT INTO history_donations(district_id,donor_user_id,donor_name,amount_cents,processing_fee_cents,payment_method,provider,mode,provider_ref,idempotency_key)
        VALUES($1,$2,'Parent A',1000,59,'sandbox','sandbox','test',$3,$4)`, [ID.d1, USERS.pa[0], `pay_sandbox_${crypto.randomBytes(12).toString("hex")}`, `k-${crypto.randomUUID()}`]), /fund_collection_closed/);
    } finally { await runtime.end(); }
    const g = ok(await gov("governance"));
    assert.deepEqual(g.missing, []);
    assert.equal(ok(await as("pa")("GET", "/api/preservation-fund")).collecting, true);
    assert.equal(ok(await as("pa")("GET", "/api/donations/status")).enabled, true);
    assert.equal(ok(await as("supt2")("GET", "/api/preservation-fund")).collecting, false, "another district's fund is its own");
  });

  it("requests are checked against the source's balance and the eligible categories", async () => {
    await give("pa", 2500); await give("t1", 5000); await give("pb", 1000, ID.s1);
    ok(await as("supt1")("PUT", `/api/donations/finance/reviewers/${USERS.p1[0]}`, { on: true }));
    const r = await report();
    assert.equal(unrestricted(r).availableCents, 7500 - fee(2500) - fee(5000));
    assert.equal(r.balances.find(b => b.source.schoolId === ID.s1).availableCents, 1000 - fee(1000));
    for (const who of ["pa", "t1", "pu"]) err(await ask(who, {}), 403);
    err(await ask("p1", { category: "other_preservation" }), 400, "category_not_eligible");
    err(await ask("p1", { category: "student_quota" }), 400);
    err(await ask("p1", { amountCents: 100000 }), 409, "insufficient_funds");
    err(await ask("p1", { amountCents: 2000, sourceSchoolId: ID.s1 }), 409, "insufficient_funds");
    req1 = ok(await ask("p1", {}));
    assert.equal(req1.status, "pending");
    assert.equal(req1.test, true);
  });

  it("two other people approve, each attesting no conflict; the requester can't", async () => {
    err(await vote("p1", req1.id), 403, "requester_cannot_approve");
    err(await vote("supt1", req1.id, "approve", { noConflict: false }), 403, "conflict_declared");
    err(await vote("pa", req1.id), 403);
    assert.equal(ok(await vote("supt1", req1.id)).status, "pending", "one approval of two");
    err(await vote("supt1", req1.id), 409, "already_decided");
    const d = ok(await vote("supt1b", req1.id));
    assert.equal(d.status, "approved");
    assert.deepEqual(d.votes.map(v => [v.voter, v.decision, v.noConflict]), [["Supt One", "approve", true], ["Supt Two", "approve", true]]);
    assert.equal(unrestricted(await report()).availableCents, 7500 - fee(2500) - fee(5000) - 3000, "approved money is set aside");
  });

  it("someone other than the requester records the payment, which posts to the fund ledger", async () => {
    err(await as("p1")("POST", `/api/preservation-fund/disbursements/${req1.id}/pay`, { paymentRef: "AP-5521" }), 403, "requester_cannot_pay");
    err(await as("supt1")("POST", `/api/preservation-fund/disbursements/${req1.id}/pay`, {}), 400);
    const p = ok(await as("supt1")("POST", `/api/preservation-fund/disbursements/${req1.id}/pay`, { paymentRef: "AP-5521" }));
    assert.equal(p.status, "paid");
    err(await as("supt1")("POST", `/api/preservation-fund/disbursements/${req1.id}/pay`, { paymentRef: "AP-5521" }), 409, "not_approved");
    const u = unrestricted(await report());
    assert.equal(u.paidCents, 3000);
    assert.equal(u.availableCents, 7500 - fee(2500) - fee(5000) - 3000);
    const line = (await admin.query("SELECT amount_cents, category, test_mode FROM preservation_fund_ledger WHERE disbursement_id=$1", [req1.id])).rows;
    assert.deepEqual(line, [{ amount_cents: -3000, category: "storage", test_mode: true }]);
  });

  it("one rejection rejects; withdrawals and cancellations are kept", async () => {
    const a = ok(await ask("supt1", { amountCents: 500, invoiceRef: "INV-2" }));
    err(await vote("p1", a.id, "reject"), 400, "reason_required");
    assert.equal(ok(await vote("p1", a.id, "reject", { note: "Not an eligible cost" })).status, "rejected");
    err(await vote("supt1b", a.id), 409, "not_pending");
    const b = ok(await ask("p1", { amountCents: 500, invoiceRef: "INV-3" }));
    err(await as("supt1")("POST", `/api/preservation-fund/disbursements/${b.id}/close`, { reason: "Not mine to withdraw" }), 409, "cannot_close");
    assert.equal(ok(await as("p1")("POST", `/api/preservation-fund/disbursements/${b.id}/close`, { reason: "Entered twice" })).status, "withdrawn");
    const c = ok(await ask("p1", { amountCents: 500, invoiceRef: "INV-4" }));
    ok(await vote("supt1", c.id)); ok(await vote("supt1b", c.id));
    assert.equal(ok(await as("supt1")("POST", `/api/preservation-fund/disbursements/${c.id}/close`, { reason: "Vendor withdrew the quote" })).status, "cancelled");
    assert.equal(unrestricted(await report()).availableCents, 7500 - fee(2500) - fee(5000) - 3000, "cancelled money is released");
    assert.equal((await report()).disbursements.length, 4);
  });

  it("the family summary shows totals only when published and enough people gave, with no names", async () => {
    ok(await as("supt1")("PUT", "/api/preservation-fund/settings", { ...FUND_SETTINGS, publicReport: true, reportMinDonors: 5 }));
    const few = ok(await as("pa")("GET", "/api/preservation-fund")).summary;
    assert.deepEqual([few.shown, few.reason], [false, "too_few_donors"]);
    ok(await as("supt1")("PUT", "/api/preservation-fund/settings", { ...FUND_SETTINGS, publicReport: true, reportMinDonors: 3 }));
    const r = await as("pb")("GET", "/api/preservation-fund");
    const sum = ok(r).summary;
    assert.equal(sum.shown, true);
    assert.equal(sum.givenCents, 8500);
    assert.equal(sum.spentCents, 3000);
    assert.deepEqual(sum.spentByCategory, { storage: 3000 });
    assert.ok(!/Parent A|Teacher S1|Parent B/.test(JSON.stringify(r.body)), "no donor names");
    for (const who of ["pa", "pu", "t1"]) err(await as(who)("GET", "/api/preservation-fund/report"), 403);
    assert.equal(ok(await as("supt2")("GET", "/api/preservation-fund")).summary.shown, false);
  });

  it("pauses stop new gifts and any disbursement step", async () => {
    err(await as("supt1")("PUT", "/api/preservation-fund/settings", { ...FUND_SETTINGS, disbursementPaused: true }), 400, "pause_reason_required");
    const pending = ok(await ask("p1", { amountCents: 500, invoiceRef: "INV-5" }));
    ok(await as("supt1")("PUT", "/api/preservation-fund/settings", { ...FUND_SETTINGS, disbursementPaused: true, collectionPaused: true, pauseReason: "Annual audit under way" }));
    err(await ask("p1", { amountCents: 500, invoiceRef: "INV-6" }), 409, "disbursement_paused");
    err(await vote("supt1", pending.id), 409, "disbursement_paused");
    err(await give("pa", 1000), 503, "fund_collection_closed");
    const f = ok(await as("pa")("GET", "/api/preservation-fund"));
    assert.equal(f.collecting, false);
    assert.equal(f.paused.reason, "Annual audit under way");
    ok(await as("supt1")("PUT", "/api/preservation-fund/settings", FUND_SETTINGS));
    assert.equal(ok(await vote("supt1", pending.id)).status, "pending");
  });

  it("the runtime role can't write the fund's books, and nothing names a student", async () => {
    const runtime = new pg.Client(db.appUrl); await runtime.connect();
    try {
      await runtime.query("SELECT set_config('app.district_id',$1,false), set_config('app.user_id',$2,false), set_config('app.role','superintendent',false), set_config('app.school_id','',false)", [ID.d1, USERS.supt1[0]]);
      await assert.rejects(runtime.query(`INSERT INTO preservation_fund_disbursements(district_id,category,description,payee,invoice_ref,amount_cents,requested_by,status)
        VALUES($1,'storage','Direct insert attempt','X','I-1',100,$2,'approved')`, [ID.d1, USERS.supt1[0]]), /permission denied/);
      await assert.rejects(runtime.query("UPDATE preservation_fund_disbursements SET status='paid'"), /permission denied/);
      await assert.rejects(runtime.query("INSERT INTO preservation_fund_votes(district_id,disbursement_id,voter,decision,no_conflict) VALUES($1,$2,$3,'approve',true)", [ID.d1, req1.id, USERS.supt1[0]]), /permission denied/);
      await assert.rejects(runtime.query("DELETE FROM preservation_fund_ledger"), /permission denied/);
      await assert.rejects(runtime.query("UPDATE preservation_fund_governance_records SET reference='changed'"), /permission denied/);
      await runtime.query("SELECT set_config('app.role','parent',false), set_config('app.user_id',$1,false)", [USERS.pa[0]]);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM preservation_fund_disbursements")).rows[0].n, 0, "families don't see disbursements");
      await assert.rejects(runtime.query("SELECT eduos_preservation_fund_request(NULL,'storage','Parent attempt here','X','I-9',100)"), /forbidden/);
      await assert.rejects(runtime.query("INSERT INTO preservation_fund_governance_records(district_id,kind,reference,approved_on,recorded_by) VALUES($1,'legal','Parent attempt',current_date,$2)", [ID.d1, USERS.pa[0]]), /row-level security/);
    } finally { await runtime.end(); }
    await assert.rejects(admin.query("UPDATE preservation_fund_ledger SET amount_cents=-1"), /append-only/);
    await assert.rejects(admin.query("DELETE FROM preservation_fund_disbursements"), /kept/);
    await assert.rejects(admin.query("UPDATE preservation_fund_disbursements SET amount_cents=1"), /fixed/);
    const cols = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name LIKE 'preservation_fund%'")).rows.map(r => r.column_name);
    assert.ok(!cols.some(c => /student/.test(c)), cols.join(","));
  });
});
