// 37.7.0 commerce (SANDBOX) against real PostgreSQL under the runtime role:
// paid tickets with holds, guardian-only payment, the 85/10/5 settlement into
// an append-only ledger and EDAL, receipts, QR check-in, refunds, the
// marketplace purchase on the 37.6 fee hook, and the fail-closed defaults.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";
import { entryHash } from "../../src/edal.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const ALL = { dpa_signed: true, coppa: true, ferpa_school_official: true, data_minimized: true, no_ads_or_profiling: true, no_tracking_or_biometrics: true, deletion_on_request: true, security_reviewed: true };
const key = tag => `commerce-test-${tag}-${"x".repeat(8)}`;
const future = h => new Date(Date.now() + h * 3600_000).toISOString();

describe("37.7.0 commerce (sandbox) against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, env, s = {}, eventId, adultId, studentTypeId, firstPayment, firstCodes, secondPayment;
  const as = name => client(server.base, s[name]);
  const ledger = async pid => Object.fromEntries((await admin.query(
    "SELECT entry_kind||':'||line AS k, amount_cents::int AS a FROM commerce_ledger_entries WHERE payment_id=$1", [pid])).rows.map(r => [r.k, r.a]));
  const sold = async id => (await admin.query("SELECT sold_count FROM event_ticket_types WHERE id=$1", [id])).rows[0].sold_count;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "p2", "t1", "pa", "pb", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    // 37.7.1: the processor is a district choice; this suite uses the built-in sandbox.
    const none = await as("pa")("GET", "/api/commerce/status");
    assert.deepEqual([none.body.data.provider, none.body.data.enabled, none.body.data.methods], ["none", false, []], "nothing is offered by default");
    const pick = await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["sandbox"], defaultMethod: "sandbox" });
    assert.equal(pick.status, 200, JSON.stringify(pick.body));
    const act = await as("p1")("POST", "/api/activities", { kind: "sport", title: "Falcons Football", status: "published" });
    assert.equal(act.status, 201, JSON.stringify(act.body));
    const ev = await as("p1")("POST", `/api/activities/${act.body.data.id}/events`, { title: "Friday Night Football", startsAt: future(48), endsAt: future(51), venue: "Main field", publish: true });
    assert.equal(ev.status, 201, JSON.stringify(ev.body)); eventId = ev.body.data.id;
    const adult = await as("p1")("POST", `/api/events/${eventId}/ticket-types`, { name: "Adult", priceCents: 1000, capacity: 3, salesOpen: true });
    assert.equal(adult.status, 201, JSON.stringify(adult.body)); adultId = adult.body.data.id;
    studentTypeId = (await as("p1")("POST", `/api/events/${eventId}/ticket-types`, { name: "Student", priceCents: 0, capacity: 50, salesOpen: true })).body.data.id;
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("is off until the superintendent enables it; pupils can never pay; free tickets still work", async () => {
    const st = await as("pa")("GET", "/api/commerce/status");
    assert.equal(st.status, 200);
    assert.deepEqual([st.body.data.provider, st.body.data.enabled, st.body.data.live, st.body.data.canPay], ["sandbox", false, false, true]);
    assert.deepEqual(st.body.data.settings.split, { schoolBps: 8500, districtBps: 1000, stateBps: 500 });
    const off = await as("pa")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 1, idempotencyKey: key("off") });
    assert.equal(off.status, 503); assert.equal(off.body.error, "paid_ticketing_not_configured");
    const kid = await as("pu")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 1, idempotencyKey: key("kid") });
    assert.equal(kid.status, 403); assert.equal(kid.body.error, "guardian_payment_required");
    assert.equal((await as("pu")("GET", "/api/commerce/status")).body.data.canPay, false);
    const free = await as("pu")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: studentTypeId, quantity: 1, idempotencyKey: key("free") });
    assert.equal(free.status, 201, JSON.stringify(free.body)); assert.equal(free.body.data.order.status, "complimentary");
    assert.equal((await as("pu")("GET", "/api/commerce/my")).status, 403);
  });

  it("only the superintendent changes settings, and the split must total 100%", async () => {
    assert.equal((await as("p1")("PUT", "/api/commerce/settings", { enabled: true })).status, 403);
    assert.equal((await as("pa")("PUT", "/api/commerce/settings", { enabled: true })).status, 403);
    const bad = await as("supt1")("PUT", "/api/commerce/settings", { enabled: true, split: { schoolBps: 8000, districtBps: 1000, stateBps: 500 } });
    assert.equal(bad.status, 400); assert.equal(bad.body.error, "split_must_total_100_percent");
    assert.equal((await as("supt1")("PUT", "/api/commerce/settings", { networkFeeBps: 5000 })).status, 400);
    const ok = await as("supt1")("PUT", "/api/commerce/settings", { enabled: true, stateFundLabel: "State school fund" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.enabled, true); assert.equal(ok.body.data.networkFeeBps, 300);
    assert.equal((await as("supt2")("GET", "/api/commerce/status")).body.data.enabled, false, "another district stays off");
  });

  it("a guardian checks out: seats are held, the payment waits, a replay returns the same payment", async () => {
    const r = await as("pa")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 2, idempotencyKey: key("pa1") });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = r.body.data.payment; firstPayment = p.id;
    assert.deepEqual([r.body.data.order.status, p.status, p.amountCents, p.processingFeeCents, p.sandbox], ["payment_pending", "requires_confirmation", 2000, 88, true]);
    assert.ok(p.holdExpiresAt);
    assert.equal(await sold(adultId), 2, "held");
    const again = await as("pa")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 2, idempotencyKey: key("pa1") });
    assert.equal(again.status, 201); assert.equal(again.body.data.replayed, true); assert.equal(again.body.data.payment.id, p.id);
    assert.equal(await sold(adultId), 2, "a replay holds nothing more");
    assert.equal((await as("pb")("POST", `/api/commerce/payments/${p.id}/confirm`, {})).status, 404, "someone else's payment");
    assert.equal((await as("pu")("POST", `/api/commerce/payments/${p.id}/confirm`, {})).status, 403);
    assert.equal((await as("pa")("POST", `/api/commerce/payments/${p.id}/confirm`, { testOutcome: "4242424242424242" })).status, 400);
  });

  it("payment succeeds: tickets with QR codes, an 85/10/5 settlement in the ledger and EDAL, a receipt", async () => {
    const r = await as("pa")("POST", `/api/commerce/payments/${firstPayment}/confirm`, { testOutcome: "sandbox_success" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.status, "succeeded"); assert.equal(d.tickets.length, 2);
    firstCodes = d.tickets.map(t => t.code);
    assert.ok(d.tickets.every(t => t.code.length >= 32 && Array.isArray(t.qr) && t.qr.length > 20));
    assert.match(d.receipt.number, /^R-\d{8}-[0-9A-F]{10}$/);
    // 2000 gross: 88 processor, 60 network (3%), net 1852 -> 1574.2 / 185.2 / 92.6 -> 1574 / 185 / 93 (largest remainder).
    assert.deepEqual(await ledger(firstPayment), { "settlement:gross": 2000, "settlement:processing_fee": 88, "settlement:network_fee": 60,
      "settlement:school_share": 1574, "settlement:district_share": 185, "settlement:state_share": 93 });
    const stored = await admin.query("SELECT ticket_code_hash FROM event_tickets t JOIN event_ticket_orders o ON o.id=t.order_id WHERE o.buyer_user_id=$1 AND o.status='paid'", [USERS.pa[0]]);
    assert.equal(stored.rows.length, 2);
    assert.ok(stored.rows.every(x => /^[0-9a-f]{64}$/.test(x.ticket_code_hash) && !firstCodes.includes(x.ticket_code_hash)), "only hashes are stored");
    const e = (await admin.query("SELECT * FROM edal_entries WHERE id=$1", [d.receipt.edal.id])).rows[0];
    assert.equal(e.kind, "commerce_settlement"); assert.equal(e.subject_student_id, null); assert.equal(e.school_id, ID.s1);
    assert.equal(entryHash({ ...e, seq: Number(e.seq) }), e.entry_hash, "the EDAL entry hash recomputes");
    const prev = (await admin.query("SELECT entry_hash FROM edal_entries WHERE district_id=$1 AND seq=$2", [ID.d1, Number(e.seq) - 1])).rows[0];
    assert.equal(e.prev_hash, prev ? prev.entry_hash : "0".repeat(64));
    assert.equal((await as("pa")("POST", `/api/commerce/payments/${firstPayment}/confirm`, {})).status, 409, "only once");
  });

  it("holds respect capacity; a decline or an expired hold releases the seats", async () => {
    const over = await as("pb")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 2, idempotencyKey: key("pb-over") });
    assert.equal(over.status, 409); assert.equal(over.body.error, "ticket_capacity_exceeded");
    const one = await as("pb")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 1, idempotencyKey: key("pb-decl") });
    assert.equal(one.status, 201); assert.equal(await sold(adultId), 3);
    const dec = await as("pb")("POST", `/api/commerce/payments/${one.body.data.payment.id}/confirm`, { testOutcome: "sandbox_decline" });
    assert.equal(dec.status, 200); assert.equal(dec.body.data.status, "declined");
    assert.equal(await sold(adultId), 2, "released");
    assert.equal((await admin.query("SELECT status FROM event_ticket_orders WHERE id=$1", [one.body.data.order.id])).rows[0].status, "cancelled");
    const held = await as("pb")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 1, idempotencyKey: key("pb-hold") });
    assert.equal(held.status, 201);
    await admin.query("UPDATE event_ticket_orders SET hold_expires_at=now()-interval '1 minute' WHERE id=$1", [held.body.data.order.id]);
    const late = await as("pb")("POST", `/api/commerce/payments/${held.body.data.payment.id}/confirm`, {});
    assert.equal(late.status, 200); assert.equal(late.body.data.status, "expired");
    assert.equal(await sold(adultId), 2);
    assert.equal((await admin.query("SELECT status FROM commerce_payments WHERE id=$1", [held.body.data.payment.id])).rows[0].status, "expired");
    assert.deepEqual(await ledger(held.body.data.payment.id), {}, "nothing settles");
  });

  it("receipts: the payer, the school's principal and the superintendent; nobody else", async () => {
    const mine = await as("pa")("GET", "/api/commerce/my");
    assert.equal(mine.status, 200);
    const pay = mine.body.data.payments.find(p => p.id === firstPayment);
    assert.equal(pay.receipts.length, 1);
    const rid = pay.receipts[0].id;
    const rec = await as("pa")("GET", `/api/commerce/receipts/${rid}`);
    assert.equal(rec.status, 200); assert.equal(rec.body.data.amountCents, 2000); assert.equal(rec.body.data.stateFundLabel, "State school fund");
    assert.equal(rec.body.data.lines.find(l => l.line === "school_share").amount, 1574);
    for (const [who, code] of [["pb", 404], ["p2", 404], ["supt2", 404], ["p1", 200], ["supt1", 200]])
      assert.equal((await as(who)("GET", `/api/commerce/receipts/${rid}`)).status, code, who);
    assert.ok(!(await as("pb")("GET", "/api/commerce/my")).body.data.payments.some(p => p.id === firstPayment));
    // Families see only their own ticket orders at the database level, too.
    const theirs = await as("pb")("GET", "/api/my/tickets");
    assert.ok(theirs.body.data.every(t => t.order_status !== "paid"));
  });

  it("QR check-in works for staff, once per ticket (the runtime role can now update tickets)", async () => {
    assert.equal((await as("pa")("POST", `/api/events/${eventId}/check-in`, { ticketCode: firstCodes[0] })).status, 403);
    const ok = await as("p1")("POST", `/api/events/${eventId}/check-in`, { ticketCode: firstCodes[0] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.data.status, "checked_in");
    assert.equal((await as("p1")("POST", `/api/events/${eventId}/check-in`, { ticketCode: firstCodes[0] })).status, 409);
    assert.equal((await as("p1")("POST", `/api/events/${eventId}/check-in`, { ticketCode: "x".repeat(32) })).status, 404);
  });

  it("refunds: school leaders only, never after a ticket was scanned, and the ledger reverses exactly", async () => {
    assert.equal((await as("pa")("POST", `/api/commerce/payments/${firstPayment}/refund`, {})).status, 403);
    assert.equal((await as("p2")("POST", `/api/commerce/payments/${firstPayment}/refund`, {})).status, 404, "another school");
    const used = await as("p1")("POST", `/api/commerce/payments/${firstPayment}/refund`, {});
    assert.equal(used.status, 409); assert.equal(used.body.error, "ticket_already_used");
    const buy = await as("pa")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 1, idempotencyKey: key("pa2") });
    assert.equal(buy.status, 201); secondPayment = buy.body.data.payment.id;
    const paid = await as("pa")("POST", `/api/commerce/payments/${secondPayment}/confirm`, {});
    assert.equal(paid.body.data.status, "succeeded");
    assert.equal(await sold(adultId), 3);
    const r = await as("p1")("POST", `/api/commerce/payments/${secondPayment}/refund`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.status, "refunded");
    assert.equal(await sold(adultId), 2, "the seat is back on sale");
    const l = await ledger(secondPayment);
    for (const [k, v] of Object.entries(l)) if (k.startsWith("settlement:")) assert.equal(l["refund:" + k.slice(11)], -v, k);
    assert.equal(Object.keys(l).length % 2, 0);
    const code = paid.body.data.tickets[0].code;
    assert.equal((await as("p1")("POST", `/api/events/${eventId}/check-in`, { ticketCode: code })).status, 409, "a refunded ticket doesn't scan");
    assert.equal((await as("p1")("POST", `/api/commerce/payments/${secondPayment}/refund`, {})).status, 409, "only once");
    const kinds = (await admin.query("SELECT kind FROM commerce_receipts WHERE payment_id=$1 ORDER BY kind", [secondPayment])).rows.map(x => x.kind);
    assert.deepEqual(kinds, ["payment", "refund"]);
  });

  it("the ledger and receipts are append-only, and the runtime role cannot write them directly", async () => {
    await assert.rejects(admin.query("UPDATE commerce_ledger_entries SET amount_cents=0 WHERE payment_id=$1", [firstPayment]), /append-only/);
    await assert.rejects(admin.query("DELETE FROM commerce_receipts WHERE payment_id=$1", [firstPayment]), /append-only/);
    await assert.rejects(admin.query("UPDATE commerce_payments SET amount_cents=1 WHERE id=$1", [firstPayment]), /terms are fixed/);
    await assert.rejects(admin.query("UPDATE commerce_payments SET status='requires_confirmation' WHERE id=$1", [firstPayment]), /cannot go from/);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      for (const [k, v] of [["app.district_id", ID.d1], ["app.user_id", USERS.supt1[0]], ["app.role", "superintendent"]]) await app.query("SELECT set_config($1,$2,true)", [k, v]);
      await assert.rejects(app.query(`INSERT INTO commerce_ledger_entries(district_id,payment_id,entry_kind,line,recipient,amount_cents,edal_entry_id)
        SELECT district_id,payment_id,'settlement','sales_tax','tax_authority',1,edal_entry_id FROM commerce_ledger_entries LIMIT 1`), /permission denied/);
      await app.query("ROLLBACK");
      // Even the superintendent can't record a settlement for someone else's payment.
      await app.query("BEGIN");
      for (const [k, v] of [["app.district_id", ID.d1], ["app.user_id", USERS.supt1[0]], ["app.role", "superintendent"]]) await app.query("SELECT set_config($1,$2,true)", [k, v]);
      await assert.rejects(app.query("SELECT * FROM eduos_commerce_record($1,'settlement',gen_random_uuid(),'[]'::jsonb,'x')", [firstPayment]), /only the payer/);
      await app.query("ROLLBACK");
    } finally { await app.end(); }
  });

  it("revenue report: principal sees their school, superintendent all; families and other districts nothing", async () => {
    const p1 = await as("p1")("GET", "/api/commerce/report");
    assert.equal(p1.status, 200);
    assert.equal(p1.body.data.scope, "school");
    assert.equal(p1.body.data.totals.school_share, 1574, "the refunded sale nets to zero");
    assert.equal(p1.body.data.payments.length, 2);
    assert.equal(p1.body.data.payments.find(p => p.id === firstPayment).refundable, false, "a scanned order isn't refundable");
    assert.equal((await as("p2")("GET", "/api/commerce/report")).body.data.payments.length, 0);
    assert.equal((await as("supt1")("GET", "/api/commerce/report")).body.data.bySchool[0].totals.gross, 2000);
    assert.equal((await as("supt2")("GET", "/api/commerce/report")).body.data.payments.length, 0);
    for (const who of ["pa", "pu", "t1"]) assert.equal((await as(who)("GET", "/api/commerce/report")).status, 403, who);
  });

  it("marketplace: the district pays for an approved license; 5% fee, vendor payable, refund", async () => {
    const v = await as("supt1")("POST", "/api/marketplace/vendors", { name: "MathCo", website: "https://mathco.example" });
    const l = await as("supt1")("POST", "/api/marketplace/listings", { vendorId: v.body.data.id, name: "Math Garden", category: "Math", description: "Adaptive practice.", launchUrl: "https://mathgarden.example/launch" });
    const listingId = l.body.data.id;
    assert.equal((await as("supt1")("POST", `/api/marketplace/listings/${listingId}/review`, { status: "approved", checklist: ALL, dpaExpiresOn: "2099-06-30" })).status, 200);
    const req = await as("t1")("POST", `/api/marketplace/listings/${listingId}/request`, { reason: "Grade 3 math", seats: 30 });
    assert.equal((await as("supt1")("POST", `/api/marketplace/requests/${req.body.data.id}/approve`, {})).status, 200);
    const list = await as("supt1")("GET", "/api/commerce/marketplace");
    assert.equal(list.status, 200); const fe = list.body.data.licenses[0];
    assert.equal(fe.purchase, null); assert.equal(fe.seatLimit, 30);
    assert.equal((await as("p1")("GET", "/api/commerce/marketplace")).status, 403);
    const unpriced = await as("supt1")("POST", `/api/commerce/marketplace/fee-events/${fe.feeEventId}/checkout`, { idempotencyKey: key("m0") });
    assert.equal(unpriced.status, 409); assert.equal(unpriced.body.error, "listing_not_priced");
    assert.equal((await as("p1")("POST", `/api/commerce/marketplace/listings/${listingId}/price`, { unitPriceCents: 1250 })).status, 403);
    assert.equal((await as("supt1")("POST", `/api/commerce/marketplace/listings/${listingId}/price`, { unitPriceCents: 1250, priceUnit: "seat" })).status, 200);
    const co = await as("supt1")("POST", `/api/commerce/marketplace/fee-events/${fe.feeEventId}/checkout`, { idempotencyKey: key("m1") });
    assert.equal(co.status, 201, JSON.stringify(co.body));
    assert.deepEqual([co.body.data.purchase.quantity, co.body.data.payment.amountCents, co.body.data.payment.processingFeeCents], [30, 37500, 1118]);
    assert.equal((await as("supt1")("POST", `/api/commerce/marketplace/fee-events/${fe.feeEventId}/checkout`, { idempotencyKey: key("m2") })).status, 409, "one purchase per license");
    assert.equal((await as("supt1")("POST", `/api/commerce/marketplace/fee-events/${fe.feeEventId}/checkout`, { idempotencyKey: key("m1") })).body.data.replayed, true);
    const ok = await as("supt1")("POST", `/api/commerce/payments/${co.body.data.payment.id}/confirm`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.data.status, "succeeded");
    assert.deepEqual(await ledger(co.body.data.payment.id), { "settlement:gross": 37500, "settlement:processing_fee": 1118, "settlement:marketplace_fee": 1875, "settlement:vendor_payable": 34507 });
    assert.equal((await as("p1")("POST", `/api/commerce/payments/${co.body.data.payment.id}/refund`, {})).status, 404, "principals don't refund district purchases");
    const rf = await as("supt1")("POST", `/api/commerce/payments/${co.body.data.payment.id}/refund`, {});
    assert.equal(rf.status, 200, JSON.stringify(rf.body));
    assert.equal((await ledger(co.body.data.payment.id))["refund:vendor_payable"], -34507);
  });

  it("retention releases stale holds and keeps the financial record", async () => {
    const held = await as("pa")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 1, idempotencyKey: key("pa-ret") });
    assert.equal(held.status, 201);
    await admin.query("UPDATE event_ticket_orders SET hold_expires_at=now()-interval '1 minute' WHERE id=$1", [held.body.data.order.id]);
    const before = (await admin.query("SELECT count(*)::int AS n FROM commerce_ledger_entries")).rows[0].n;
    const out = await run(["src/retention.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /"commerce_holds_released":1/);
    assert.equal((await admin.query("SELECT status FROM event_ticket_orders WHERE id=$1", [held.body.data.order.id])).rows[0].status, "cancelled");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM commerce_ledger_entries")).rows[0].n, before);
  });

  it("when the district offers no payment method, paid checkout stays off (37.7.1: no server-wide provider)", async () => {
    const off = await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: [], defaultMethod: null });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const st = await as("pa")("GET", "/api/commerce/status");
    assert.deepEqual([st.body.data.provider, st.body.data.enabled], ["none", false], "settings say enabled, but nothing is offered");
    const r = await as("pa")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 1, idempotencyKey: key("none") });
    assert.equal(r.status, 503); assert.equal(r.body.reason, "district_payment_provider_not_connected");
    const asked = await as("pa")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: adultId, quantity: 1, idempotencyKey: key("none2"), paymentMethod: "sandbox" });
    assert.equal(asked.status, 409); assert.equal(asked.body.error, "payment_method_not_available");
  });
});
