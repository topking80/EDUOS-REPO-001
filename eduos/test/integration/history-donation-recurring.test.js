// TC-13: recurring gifts (db/139) against real PostgreSQL as the runtime role.
// SANDBOX ONLY. A donor chooses once, monthly or yearly; the first charge is
// confirmed like any gift, later charges are made by the schedule job, and
// every charge is its own gift with its own acknowledgement and ledger lines.
// The donor can stop it at any time; three declines in a row stop it; charges
// wait while the district has donations, recurring gifts or collection off.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";
import { openFund } from "./fund-helpers.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const fee = c => Math.round(c * 0.029) + 30;
const addMonths = (day, n) => { const d = new Date(`${day}T00:00:00Z`); const want = (d.getUTCMonth() + n) % 12; d.setUTCMonth(d.getUTCMonth() + n); if (d.getUTCMonth() !== (want + 12) % 12) d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);
const SETTINGS = { enabled: true, minCents: 500, maxCents: 100000, suggestedCents: [1000] };

describe("TC-13 recurring gifts against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, env, s = {}, monthly, yearly;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const err = (r, code, error) => { assert.equal(r.status, code, JSON.stringify(r.body)); if (error) assert.equal(r.body.error, error); };
  const start = (who, body) => as(who)("POST", "/api/donations", { amountCents: 1000, idempotencyKey: `k-${crypto.randomUUID()}`, ...body });
  const confirm = (who, id, testOutcome = "sandbox_success") => as(who)("POST", `/api/donations/${id}/confirm`, { testOutcome });
  const charge = async (asOf, outcome = "sandbox_success") => {
    const r = await run(["src/donation-schedules.js"], { ...env, DATABASE_URL: db.appUrl, DONATION_SCHEDULE_AS_OF: asOf, DONATION_SCHEDULE_TEST_OUTCOME: outcome });
    assert.equal(r.code, 0, r.out);
    return JSON.parse(r.out.trim().split("\n").pop());
  };
  const schedule = async (who, id) => ok(await as(who)("GET", "/api/donations/schedules/mine")).find(x => x.id === id);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, CAPSULE_RELEASE_INTERVAL_SECONDS: "0" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["t1", "supt1", "supt2", "pa", "pb", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    ok(await as("supt1")("PUT", "/api/donations/settings", SETTINGS));
    await openFund(as("supt1"));
    ok(await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["sandbox"], defaultMethod: "sandbox" }));
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("donors choose once, monthly or yearly; recurring is on by default and sandbox only", async () => {
    const st = ok(await as("pa")("GET", "/api/donations/status"));
    assert.deepEqual(st.frequencies, ["one_time", "monthly", "yearly"]);
    assert.equal(st.recurringEnabled, true);
    assert.equal(st.sandboxOnly, true);
    assert.match(st.help, /monthly or yearly/);
    assert.doesNotMatch(st.help, /One-time gifts only/);
    err(await start("pa", { frequency: "weekly" }), 400, "invalid_frequency");
    err(await start("pu", { frequency: "monthly" }), 403, "guardian_payment_required");
    const once = ok(await start("pa", {}), 201);
    assert.equal(once.frequency, "one_time");
    assert.equal(once.schedule, null);
    assert.equal(once.scheduleId, null);
  });

  it("a monthly gift starts with the donor's first charge and activates on success", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const g = ok(await start("pa", { amountCents: 2500, frequency: "monthly", idempotencyKey: key }), 201);
    assert.equal(g.schedule.status, "pending");
    assert.equal(g.schedule.frequency, "monthly");
    assert.equal(g.installment, 1);
    err(await start("pa", { amountCents: 2500, frequency: "yearly", idempotencyKey: key }), 409, "idempotency_key_reused");
    assert.equal(ok(await start("pa", { amountCents: 2500, frequency: "monthly", idempotencyKey: key }), 200).id, g.id, "same key, same gift");
    const r = ok(await confirm("pa", g.id));
    assert.match(r.acknowledgement.designation, /monthly gift, installment 1/);
    assert.ok(!/deductib/i.test(r.acknowledgement.body));
    monthly = await schedule("pa", g.schedule.id);
    assert.equal(monthly.status, "active");
    assert.equal(monthly.charges, 1);
    assert.equal(monthly.nextChargeOn, addMonths(today(), 1));
    assert.equal(monthly.test, true);
    assert.equal(monthly.canCancel, true);
    assert.equal(await schedule("pb", g.schedule.id), undefined, "another donor doesn't see it");
  });

  it("a declined first payment fails the schedule; nothing is charged later", async () => {
    const g = ok(await start("pb", { frequency: "monthly" }), 201);
    ok(await confirm("pb", g.id, "sandbox_decline"));
    const x = await schedule("pb", g.schedule.id);
    assert.equal(x.status, "failed");
    assert.equal(x.nextChargeOn, null);
    assert.equal(x.canCancel, false);
  });

  it("the schedule job charges what is due through the sandbox; each charge is a gift with ledger lines", async () => {
    assert.deepEqual(await charge(today()), { due: 0, succeeded: 0, declined: 0, stopped: 0, held: 0, skipped: 0, errors: 0 }, "nothing due yet");
    const next = monthly.nextChargeOn;
    const out = await charge(next);
    assert.equal(out.due, 1); assert.equal(out.succeeded, 1);
    assert.equal((await charge(next)).due, 0, "running again the same day charges nothing");
    const x = await schedule("pa", monthly.id);
    assert.equal(x.charges, 2);
    assert.equal(x.nextChargeOn, addMonths(today(), 2), "anchored on the first charge's day");
    const mine = ok(await as("pa")("GET", "/api/donations/mine")).filter(g => g.scheduleId === monthly.id);
    assert.deepEqual(mine.map(g => [g.installment, g.status]).sort(), [[1, "succeeded"], [2, "succeeded"]]);
    const second = mine.find(g => g.installment === 2);
    assert.match(second.acknowledgement.number, /^GIFT-/);
    assert.equal(second.processingFeeCents, fee(2500));
    assert.equal(second.test, true);
    const l = ok(await as("supt1")("GET", `/api/donations/ledger?from=${today()}&to=${today()}`));
    const lines = l.lines.filter(x => x.donationId === second.id);
    assert.deepEqual(lines.map(x => [x.kind, x.amountCents]).sort(), [["gift", 2500], ["processing_fee", -fee(2500)]]);
    assert.ok(lines.every(x => /^pay_sandbox_/.test(x.providerRef) && x.test));
    const rec = ok(await as("supt1")("GET", `/api/donations/reconciliation?from=${today()}&to=${today()}`));
    assert.equal(rec.matched, true, "the books still match");
    const fin = ok(await as("supt1")("GET", "/api/donations/schedules"));
    assert.ok(fin.schedules.some(x => x.id === monthly.id && x.donor === "Parent A"));
    err(await as("pa")("GET", "/api/donations/schedules"), 403);
    err(await as("supt2")("GET", "/api/donations/schedules").then(r => ({ ...r, status: r.body.data.schedules.length === 0 ? 200 : 500 })), 200);
  });

  it("charges wait while recurring gifts are off, and resume when they're back on", async () => {
    ok(await as("supt1")("PUT", "/api/donations/settings", { ...SETTINGS, recurringEnabled: false }));
    assert.deepEqual(ok(await as("pa")("GET", "/api/donations/status")).frequencies, ["one_time"]);
    err(await start("pa", { frequency: "monthly" }), 409, "recurring_not_enabled");
    const due = addMonths(today(), 2);
    const held = await charge(due);
    assert.equal(held.held, 1); assert.equal(held.succeeded, 0);
    assert.equal((await schedule("pa", monthly.id)).charges, 2, "not advanced, nobody charged");
    ok(await as("supt1")("PUT", "/api/donations/settings", SETTINGS));
    assert.equal((await charge(addMonths(today(), 4))).succeeded, 1, "two months late: one charge, not a burst");
    const x = await schedule("pa", monthly.id);
    assert.equal(x.charges, 3);
    assert.equal(x.nextChargeOn, addMonths(today(), 5), "on to the next date on the calendar");
  });

  it("the donor can cancel any time; past gifts stay; finance can cancel on request", async () => {
    err(await as("pb")("POST", `/api/donations/schedules/${monthly.id}/cancel`, {}), 404, "not_found");
    err(await as("supt2")("POST", `/api/donations/schedules/${monthly.id}/cancel`, {}), 404);
    const x = ok(await as("pa")("POST", `/api/donations/schedules/${monthly.id}/cancel`, {}));
    assert.equal(x.status, "cancelled"); assert.equal(x.nextChargeOn, null); assert.equal(x.endReason, "cancelled by the donor");
    err(await as("pa")("POST", `/api/donations/schedules/${monthly.id}/cancel`, {}), 409, "schedule_not_active");
    assert.equal((await charge(addMonths(today(), 6))).due, 0, "nothing more is charged");
    assert.equal(ok(await as("pa")("GET", "/api/donations/mine")).filter(g => g.scheduleId === monthly.id && g.status === "succeeded").length, 3);
    const g = ok(await start("t1", { frequency: "monthly" }), 201);
    ok(await confirm("t1", g.id));
    const y = ok(await as("supt1")("POST", `/api/donations/schedules/${g.schedule.id}/cancel`, { reason: "Donor phoned the office" }));
    assert.equal(y.status, "cancelled"); assert.equal(y.endReason, "Donor phoned the office");
  });

  it("three declines in a row stop a yearly gift", async () => {
    const g = ok(await start("pb", { amountCents: 5000, frequency: "yearly" }), 201);
    ok(await confirm("pb", g.id));
    yearly = await schedule("pb", g.schedule.id);
    assert.equal(yearly.frequency, "yearly");
    const y = n => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + n); return d.toISOString().slice(0, 10); };
    assert.equal(yearly.nextChargeOn, y(1));
    assert.equal((await charge(y(1), "sandbox_decline")).declined, 1);
    assert.equal((await schedule("pb", yearly.id)).consecutiveDeclines, 1);
    assert.equal((await charge(y(2), "sandbox_decline")).declined, 1);
    assert.equal((await charge(y(3), "sandbox_decline")).stopped, 1);
    const x = await schedule("pb", yearly.id);
    assert.equal(x.status, "stopped"); assert.equal(x.nextChargeOn, null); assert.equal(x.charges, 4);
    assert.equal((await charge(y(4))).due, 0);
    const declined = ok(await as("pb")("GET", "/api/donations/mine")).filter(g => g.scheduleId === yearly.id && g.status === "declined");
    assert.equal(declined.length, 3);
    assert.ok(declined.every(g => !g.acknowledgement));
  });

  it("the runtime role can't start an active schedule or change one directly", async () => {
    const runtime = new pg.Client(db.appUrl); await runtime.connect();
    try {
      await runtime.query("SELECT set_config('app.district_id',$1,false), set_config('app.user_id',$2,false), set_config('app.role','parent',false), set_config('app.school_id','',false)", [ID.d1, USERS.pa[0]]);
      await assert.rejects(runtime.query(`INSERT INTO history_donation_schedules(district_id,donor_user_id,donor_name,amount_cents,frequency,payment_method,idempotency_key,status,next_charge_on,anchor_on)
        VALUES($1,$2,'Parent A',1000,'monthly','sandbox',$3,'active',current_date,current_date)`, [ID.d1, USERS.pa[0], `k-${crypto.randomUUID()}`]), /row-level security/);
      await assert.rejects(runtime.query(`INSERT INTO history_donation_schedules(district_id,donor_user_id,donor_name,amount_cents,frequency,payment_method,idempotency_key,provider)
        VALUES($1,$2,'Parent A',1000,'monthly','sandbox',$3,'stripe')`, [ID.d1, USERS.pa[0], `k-${crypto.randomUUID()}`]), /check constraint|row-level security/);
      await assert.rejects(runtime.query("UPDATE history_donation_schedules SET status='active'"), /permission denied/);
      await assert.rejects(runtime.query("DELETE FROM history_donation_schedules"), /permission denied/);
      await assert.rejects(runtime.query("SELECT eduos_history_donation_complete($1)", [monthly.id]), /permission denied/);
      await assert.rejects(runtime.query("SELECT eduos_history_donation_schedule_charge($1,$2,1,current_date,'pay_sandbox_x',1,'refunded',null)", [ID.d1, monthly.id]), /invalid_outcome/);
      await runtime.query("SELECT set_config('app.user_id',$1,false)", [USERS.pb[0]]);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM history_donation_schedules WHERE donor_user_id=$1", [USERS.pa[0]])).rows[0].n, 0, "donors see only their own");
    } finally { await runtime.end(); }
    await assert.rejects(admin.query("DELETE FROM history_donation_schedules"), /kept/);
    await admin.query("SELECT set_config('app.district_id',$1,false)", [ID.d1]);
    await assert.rejects(admin.query("UPDATE history_donation_schedules SET amount_cents=1 WHERE id=$1", [monthly.id]), /terms are fixed/);
    await assert.rejects(admin.query("UPDATE history_donation_schedules SET status='active', next_charge_on=current_date WHERE id=$1", [monthly.id]), /cannot go from cancelled/);
  });
});
