// HSP-05: private school tuition and finance against real PostgreSQL, as the
// non-owner runtime role: providers, accounts, invoices with approved aid,
// payments and receipts, refunds, reconciliation, separation of duties,
// guardian visibility and isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const TABLES = ["ps_payment_providers", "ps_billing_accounts", "ps_billing_account_learners", "ps_invoices", "ps_invoice_lines", "ps_payments", "ps_refunds", "ps_reconciliations"];
const today = () => new Date().toISOString().slice(0, 10);
const YEAR = new Date().getUTCFullYear();

describe("HSP-05 private school tuition and finance", { skip }, () => {
  let db, idp, server, admin, env, s = {}, ids = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const B = "/api/private-school/billing";
  const switchTo = async (name, membershipId) => {
    const r = await fetch(`${server.base}/api/session/context`, { method: "POST", headers: { "content-type": "application/json", cookie: s[name].cookie, "x-csrf-token": s[name].csrf },
      body: JSON.stringify({ kind: "private_school", membershipId }) });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
    s[name] = { cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => !c.endsWith("=")), csrf: j.csrfToken };
  };
  const join = async (by, body, who) => {
    const t = ok(await as(by)("POST", "/api/private-school/invitations", body), 201).token;
    const r = ok(await as(who)("POST", "/api/private-school/invitations/accept", { token: t }));
    await switchTo(who, r.membershipId);
    return r.membershipId;
  };

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["pa", "pb", "t1", "p1", "supt1", "supt1b"]) s[n] = await login(server.base, idp, n, { email_verified: true });
    const r = ok(await as("pa")("POST", "/api/private-school/schools", { legalName: "Hillside Academy, Inc.", displayName: "Hillside Academy", campusName: "Main Campus" }), 201);
    ids.school = r.schoolId; ids.main = r.campusId;
    await switchTo("pa", r.membershipId);
    assert.equal((await run(["src/private-school-verify.js", "--school", ids.school, "--ref", "Registry", "--by", "Trust"], { ...env, DATABASE_URL: db.ownerUrl })).code, 0);
    ids.ava = ok(await as("pa")("POST", "/api/private-school/learners", { displayName: "Ava Lin", campusId: ids.main, gradeLevel: "4" }), 201).id;
    ids.ben = ok(await as("pa")("POST", "/api/private-school/learners", { displayName: "Ben Lin", campusId: ids.main, gradeLevel: "2" }), 201).id;
    await join("pa", { email: USERS.supt1[2], role: "finance" }, "supt1");
    await join("pa", { email: USERS.t1[2], role: "teacher", campusId: ids.main }, "t1");
    await join("pa", { email: USERS.p1[2], role: "registrar" }, "p1");
    ids.payer = await join("pa", { email: USERS.pb[2], role: "guardian", learnerIds: [ids.ava, ids.ben] }, "pb");
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("billing tables have forced RLS; only finance and the school admin reach billing", async () => {
    const { rows } = await admin.query("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind='r'", [TABLES]);
    assert.equal(rows.length, TABLES.length); for (const r of rows) assert.ok(r.relforcerowsecurity, r.relname);
    for (const who of ["t1", "p1", "pb"]) assert.equal((await as(who)("GET", `${B}/invoices`)).body.error, "finance_only", who);
    assert.deepEqual(ok(await as("supt1")("GET", `${B}/learners`)).map(l => Object.keys(l).sort()), [["displayName", "enrolled", "id"], ["displayName", "enrolled", "id"]], "names only");
    assert.deepEqual(ok(await as("supt1")("GET", "/api/private-school/learners")), [], "finance still holds no learner records");
  });

  it("a provider is approved by a school admin other than whoever proposed it", async () => {
    const p = ok(await as("supt1")("POST", `${B}/providers`, { provider: "square", label: "Square (front office)", accountReference: "sq-merchant-4471" }), 201);
    assert.equal((await as("supt1")("POST", `${B}/providers/${p.id}/approve`, {})).body.error, "school_admin_only");
    ok(await as("pa")("POST", `${B}/providers/${p.id}/approve`, {}));
    ids.provider = p.id;
    const own = ok(await as("pa")("POST", `${B}/providers`, { provider: "manual", label: "Office checks" }), 201);
    assert.equal((await as("pa")("POST", `${B}/providers/${own.id}/approve`, {})).body.error, "approve_someone_elses_proposal");
  });

  it("an invoice with tuition, a fee and aid: aid needs a school admin's approval before it's issued", async () => {
    ids.account = ok(await as("supt1")("POST", `${B}/accounts`, { name: "Lin family", payerMembershipId: ids.payer, learnerIds: [ids.ava, ids.ben] }), 201).id;
    assert.equal((await as("supt1")("POST", `${B}/accounts`, { name: "Teacher", payerMembershipId: (await as("pa")("GET", "/api/private-school/members")).body.data.members.find(m => m.role === "teacher").id })).body.error,
      "payer_must_be_a_guardian");
    const inv = ok(await as("supt1")("POST", `${B}/invoices`, { accountId: ids.account, title: "Fall tuition", dueOn: "2027-09-01", lines: [
      { kind: "tuition", description: "Fall tuition", learnerId: ids.ava, amountCents: 600000 }, { kind: "tuition", description: "Fall tuition", learnerId: ids.ben, amountCents: 600000 },
      { kind: "fee", description: "Activity fee", amountCents: 15000 }, { kind: "aid", description: "Sibling discount", learnerId: ids.ben, amountCents: -60000 }] }), 201);
    ids.invoice = inv.id;
    assert.equal(inv.totalCents, 1155000);
    assert.equal((await as("supt1")("POST", `${B}/invoices`, { accountId: ids.account, title: "x", lines: [{ kind: "aid", description: "x", amountCents: 500 }] })).status, 400, "aid reduces the bill");
    assert.equal((await as("supt1")("POST", `${B}/invoices/${inv.id}/issue`, {})).body.error, "aid_needs_approval");
    const aid = inv.lines.find(l => l.kind === "aid");
    assert.equal((await as("supt1")("POST", `${B}/invoice-lines/${aid.id}/approve`, {})).body.error, "school_admin_only");
    ok(await as("pa")("POST", `${B}/invoice-lines/${aid.id}/approve`, {}));
    assert.deepEqual(ok(await as("pb")("GET", `${B}/mine`))[0].invoices, [], "drafts aren't shown to the family");
    const issued = ok(await as("supt1")("POST", `${B}/invoices/${inv.id}/issue`, {}));
    assert.equal(issued.number, `INV-${YEAR}-0001`); assert.equal(issued.status, "issued");
    assert.equal((await as("supt1")("POST", `${B}/invoices/${inv.id}/lines`, { kind: "fee", description: "Late fee", amountCents: 100 })).body.error, "invoice_not_draft", "issued invoices don't change");
    // The school admin's own aid line can't be approved by themself.
    const d = ok(await as("pa")("POST", `${B}/invoices`, { accountId: ids.account, title: "Spring", lines: [{ kind: "tuition", description: "Spring", amountCents: 1000 }, { kind: "discount", description: "Early", amountCents: -100 }] }), 201);
    assert.equal((await as("pa")("POST", `${B}/invoice-lines/${d.lines.find(l => l.kind === "discount").id}/approve`, {})).body.error, "approve_someone_elses_line");
  });

  it("payments get receipts and can't exceed the balance; the family sees the invoice, payments and balance", async () => {
    assert.equal((await as("supt1")("POST", `${B}/invoices/${ids.invoice}/payments`, { amountCents: 2000000, method: "check", reference: "1001", receivedOn: today() })).body.error, "more_than_the_balance");
    const p1 = ok(await as("supt1")("POST", `${B}/invoices/${ids.invoice}/payments`, { amountCents: 500000, method: "check", reference: "Check 1001", receivedOn: today() }), 201);
    assert.equal(p1.receiptNumber, `RCT-${YEAR}-0001`); assert.equal(p1.balanceCents, 655000);
    const p2 = ok(await as("supt1")("POST", `${B}/invoices/${ids.invoice}/payments`, { amountCents: 100000, method: "provider", providerId: ids.provider, reference: "sq_txn_88", receivedOn: today() }), 201);
    ids.payment = p2.id;
    assert.equal((await as("supt1")("POST", `${B}/invoices/${ids.invoice}/payments`, { amountCents: 100, method: "provider", receivedOn: today() })).status, 400, "a provider payment names its provider");
    const mine = ok(await as("pb")("GET", `${B}/mine`));
    assert.equal(mine[0].balanceCents, 555000);
    assert.deepEqual(mine[0].invoices[0].payments.map(p => p.receiptNumber), [`RCT-${YEAR}-0001`, `RCT-${YEAR}-0002`]);
    const rc = ok(await as("pb")("GET", `${B}/payments/${ids.payment}/receipt`));
    assert.deepEqual([rc.receiptNumber, rc.amountCents, rc.invoiceNumber], [`RCT-${YEAR}-0002`, 100000, `INV-${YEAR}-0001`]);
    assert.match(rc.statement, /keeps no card or bank details/);
    const { rows } = await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('ps_payments','ps_payment_providers') AND column_name ~ '(card|pan|cvv|routing|account_number|secret)'");
    assert.deepEqual(rows, [], "no card or bank columns exist");
    await assert.rejects(admin.query("UPDATE ps_payments SET amount_cents=1"), /append-only/);
  });

  it("refunds: requested by finance, decided by a school admin; reconciliation prepared by one and signed off by another", async () => {
    assert.equal((await as("supt1")("POST", `${B}/payments/${ids.payment}/refunds`, { amountCents: 200000, reason: "Overpaid" })).body.error, "more_than_the_payment");
    const r = ok(await as("supt1")("POST", `${B}/payments/${ids.payment}/refunds`, { amountCents: 25000, reason: "Withdrew from the activity" }), 201);
    assert.equal((await as("supt1")("POST", `${B}/refunds/${r.id}/decide`, { approve: true })).body.error, "school_admin_only");
    const rec0 = ok(await as("supt1")("POST", `${B}/reconciliations`, { from: today(), to: today() }), 201);
    assert.equal((await as("pa")("POST", `${B}/reconciliations/${rec0.id}/sign-off`, {})).body.error, "refunds_awaiting_a_decision");
    ok(await as("pa")("POST", `${B}/refunds/${r.id}/decide`, { approve: true }));
    assert.equal((await as("pa")("POST", `${B}/reconciliations/${rec0.id}/sign-off`, {})).body.error, "totals_changed_since_prepared", "the approved refund changed the totals");
    const rec = ok(await as("supt1")("POST", `${B}/reconciliations`, { from: today(), to: today(), note: "Day close" }), 201);
    assert.deepEqual([rec.totals.invoicedCents, rec.totals.receivedCents, rec.totals.refundedCents, rec.totals.netCents, rec.totals.byMethod],
      [1155000, 600000, 25000, 575000, { check: 500000, provider: 100000 }]);
    ok(await as("pa")("POST", `${B}/reconciliations/${rec.id}/sign-off`, {}));
    const own = ok(await as("pa")("POST", `${B}/reconciliations`, { from: today(), to: today() }), 201);
    assert.equal((await as("pa")("POST", `${B}/reconciliations/${own.id}/sign-off`, {})).body.error, "sign_off_someone_elses_reconciliation");
    assert.equal(ok(await as("pb")("GET", `${B}/mine`))[0].balanceCents, 580000, "the refund is back on the balance");
    assert.equal((await as("supt1")("POST", `${B}/invoices/${ids.invoice}/void`, { reason: "Wrong family" })).body.error, "refund_payments_first");
    const { rows } = await admin.query("SELECT action FROM private_school_audit_events WHERE school_id=$1 AND resource_type LIKE 'ps_%' ORDER BY id", [ids.school]);
    for (const a of ["propose", "approve", "create", "issue", "record_payment", "request_refund", "approve_refund", "prepare", "sign_off"]) assert.ok(rows.some(r => r.action === a), a);
  });

  it("another school and a district reach none of it, as the runtime role too", async () => {
    const r = ok(await as("supt1b")("POST", "/api/private-school/schools", { legalName: "Other Prep LLC", displayName: "Other Prep", campusName: "Campus" }), 201);
    await switchTo("supt1b", r.membershipId);
    assert.deepEqual(ok(await as("supt1b")("GET", `${B}/invoices`)), []);
    assert.equal((await as("supt1b")("GET", `${B}/invoices/${ids.invoice}`)).status, 404);
    assert.equal((await as("supt1b")("GET", `${B}/payments/${ids.payment}/receipt`)).status, 404);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','superintendent',true)", [ID.d1, USERS.supt1[0]]);
      for (const t of TABLES) assert.equal((await app.query(`SELECT * FROM ${t}`)).rowCount, 0, `a district sees no ${t}`);
      await app.query("ROLLBACK");
      await assert.rejects(app.query("SELECT * FROM ps_invoice_counters"), /permission denied/);
      await assert.rejects(app.query("DELETE FROM ps_payments"), /permission denied/);
    } finally { await app.end(); }
  });
});
