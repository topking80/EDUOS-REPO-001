// HSP-05: private school tuition and finance, in a private-school session (db/164).
//
//   Providers      GET/POST /api/private-school/billing/providers; POST .../providers/:id/approve | /disable (school admin, not the proposer)
//   Accounts       GET/POST /api/private-school/billing/accounts {name, payerMembershipId (a guardian), learnerIds}; GET .../accounts/:id
//   Learners       GET /api/private-school/billing/learners        names only, for invoice lines
//   Invoices       GET/POST /api/private-school/billing/invoices {accountId, title, dueOn?, lines: [{kind, description, learnerId?, amountCents}]}
//                  GET .../invoices/:id; POST .../invoices/:id/lines; DELETE .../invoices/:id/lines/:lineId (drafts)
//                  POST .../invoice-lines/:id/approve            aid and discounts: a school admin, not who added them
//                  POST .../invoices/:id/issue                   numbers it (INV-YYYY-NNNN) and freezes it
//                  POST .../invoices/:id/void {reason}           only with nothing paid on it
//   Payments       POST .../invoices/:id/payments {amountCents, method, providerId?, reference?, receivedOn}: a receipt (RCT-YYYY-NNNN)
//                  GET  .../payments/:id/receipt
//   Refunds        POST .../payments/:id/refunds {amountCents, reason}; POST .../refunds/:id/decide {approve} (school admin, not the requester)
//   Reconciliation GET .../reconciliation?from&to; POST .../reconciliations {from, to, note?}; POST .../reconciliations/:id/sign-off (school admin, not the preparer)
//   Guardians      GET /api/private-school/billing/mine            their accounts, issued invoices, payments, refunds, balances
//
// No card or bank details are kept: providers are account references and
// payments record a method and reference. Money is in US cents.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { rows, one, validId, cleanText, HttpError } from "./role-app-util.js";
import { school, psAudit } from "./private-school-routes.js";

const PROVIDERS = ["manual", "paypal", "square", "btcpay", "other"];
const KINDS = ["tuition", "fee", "aid", "discount", "credit"];
const METHODS = ["check", "ach", "cash", "provider", "other"];
const DAY = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const cents = v => Number.isInteger(v) && Math.abs(v) <= 100000000;
const today = () => new Date().toISOString().slice(0, 10);
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : v;
const num = v => v == null ? null : Number(v);
const finance = req => ["finance", "school_admin"].includes(req.actor.privateSchoolRole);
const needFinance = req => { if (!finance(req)) throw new HttpError(403, "finance_only"); };
const needAdmin = req => { if (req.actor.privateSchoolRole !== "school_admin") throw new HttpError(403, "school_admin_only"); };
const lineOk = l => l && KINDS.includes(l.kind) && cleanText(l.description, 200) && cents(l.amountCents) && l.amountCents !== 0
  && ((["tuition", "fee"].includes(l.kind)) === (l.amountCents > 0)) && (l.learnerId == null || validId(l.learnerId));

async function invoiceFull(c, id) {
  if (!validId(id)) throw new HttpError(400, "invalid_id");
  const i = await one(c, "SELECT i.*, a.name AS account FROM ps_invoices i JOIN ps_billing_accounts a ON a.id=i.account_id WHERE i.id=$1", [id]);
  if (!i) throw new HttpError(404, "invoice_not_found");
  const lines = await rows(c, `SELECT x.*, l.display_name AS learner FROM ps_invoice_lines x LEFT JOIN private_school_learners l ON l.id=x.learner_id WHERE x.invoice_id=$1 ORDER BY x.kind IN ('tuition','fee') DESC, x.description`, [i.id]);
  const payments = await rows(c, "SELECT * FROM ps_payments WHERE invoice_id=$1 ORDER BY received_on, recorded_at", [i.id]);
  const refunds = payments.length ? await rows(c, "SELECT * FROM ps_refunds WHERE payment_id = ANY($1) ORDER BY requested_at", [payments.map(p => p.id)]) : [];
  const total = i.total_cents != null ? Number(i.total_cents) : lines.reduce((n, l) => n + Number(l.amount_cents), 0);
  const paid = payments.reduce((n, p) => n + Number(p.amount_cents), 0), refunded = refunds.filter(r => r.status === "approved").reduce((n, r) => n + Number(r.amount_cents), 0);
  return { i, lines, payments, refunds, total, paid, refunded, balance: i.status === "void" ? 0 : total - paid + refunded };
}
const invoiceOut = f => ({ id: f.i.id, accountId: f.i.account_id, account: f.i.account, number: f.i.number, title: f.i.title, status: f.i.status, dueOn: ymd(f.i.due_on), issuedAt: f.i.issued_at,
  voidReason: f.i.void_reason, totalCents: f.total, paidCents: f.paid, refundedCents: f.refunded, balanceCents: f.balance,
  lines: f.lines.map(l => ({ id: l.id, kind: l.kind, description: l.description, learnerId: l.learner_id, learner: l.learner, amountCents: Number(l.amount_cents),
    needsApproval: ["aid", "discount"].includes(l.kind) && !l.approved_by, approved: !!l.approved_by })),
  payments: f.payments.map(p => ({ id: p.id, amountCents: Number(p.amount_cents), method: p.method, reference: p.reference, receivedOn: ymd(p.received_on), receiptNumber: p.receipt_number })),
  refunds: f.refunds.map(r => ({ id: r.id, paymentId: r.payment_id, amountCents: Number(r.amount_cents), reason: r.reason, status: r.status })) });

// Period totals for reconciliation: issued invoices, payments received, approved refunds, by method.
async function periodTotals(c, from, to) {
  const inv = await one(c, "SELECT count(*)::int AS n, coalesce(sum(total_cents), 0)::bigint AS cents FROM ps_invoices WHERE status='issued' AND issued_at::date BETWEEN $1 AND $2", [from, to]);
  const pays = await rows(c, "SELECT method, count(*)::int AS n, coalesce(sum(amount_cents), 0)::bigint AS cents FROM ps_payments WHERE received_on BETWEEN $1 AND $2 GROUP BY method ORDER BY method", [from, to]);
  const ref = await one(c, "SELECT count(*)::int AS n, coalesce(sum(amount_cents), 0)::bigint AS cents FROM ps_refunds WHERE status='approved' AND decided_at::date BETWEEN $1 AND $2", [from, to]);
  const pending = await one(c, "SELECT count(*)::int AS n FROM ps_refunds WHERE status='requested'");
  const received = pays.reduce((n, p) => n + Number(p.cents), 0);
  return { invoices: inv.n, invoicedCents: Number(inv.cents), payments: pays.reduce((n, p) => n + p.n, 0), receivedCents: received,
    byMethod: Object.fromEntries(pays.map(p => [p.method, Number(p.cents)])), refunds: ref.n, refundedCents: Number(ref.cents), netCents: received - Number(ref.cents), pendingRefunds: pending.n };
}

export function registerPrivateSchoolFinanceRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `psf:${req.actor?.userId}` });
  const B = "/api/private-school/billing";

  // ---------- providers ----------
  app.get(`${B}/providers`, requireSession, school(async (c, req) => {
    needFinance(req);
    return (await rows(c, "SELECT * FROM ps_payment_providers ORDER BY proposed_at")).map(p => ({ id: p.id, provider: p.provider, label: p.label, accountReference: p.account_reference, status: p.status }));
  }));
  app.post(`${B}/providers`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needFinance(req);
    const b = req.body || {};
    if (!PROVIDERS.includes(b.provider) || !cleanText(b.label, 80, 2) || (b.accountReference != null && !cleanText(b.accountReference, 120, 2))) throw new HttpError(400, "invalid_provider");
    const p = await one(c, "INSERT INTO ps_payment_providers(school_id, provider, label, account_reference, proposed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, status",
      [req.actor.privateSchoolId, b.provider, b.label.trim(), b.accountReference?.trim() ?? null, req.actor.userId]);
    await psAudit(c, req, "propose", "ps_payment_provider", p.id, b.provider);
    return p;
  }, 201));
  const providerAct = act => school(async (c, req) => {
    req.params.act = act;
    needAdmin(req);
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const p0 = await one(c, "SELECT * FROM ps_payment_providers WHERE id=$1", [req.params.id]);
    if (!p0) throw new HttpError(404, "provider_not_found");
    if (req.params.act === "approve") {
      if (p0.status !== "proposed") throw new HttpError(409, "not_proposed");
      if (p0.proposed_by === req.actor.userId) throw new HttpError(409, "approve_someone_elses_proposal");
      await c.query("UPDATE ps_payment_providers SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1", [p0.id, req.actor.userId]);
    } else await c.query("UPDATE ps_payment_providers SET status='disabled' WHERE id=$1", [p0.id]);
    await psAudit(c, req, req.params.act, "ps_payment_provider", p0.id);
    return { id: p0.id, status: req.params.act === "approve" ? "approved" : "disabled" };
  });
  app.post(`${B}/providers/:id/approve`, limiter, requireSession, requireCsrf, providerAct("approve"));
  app.post(`${B}/providers/:id/disable`, limiter, requireSession, requireCsrf, providerAct("disable"));

  // ---------- accounts ----------
  app.get(`${B}/learners`, requireSession, school(async (c, req) => { needFinance(req); return (await rows(c, "SELECT * FROM eduos_ps_billing_learners()")).map(l => ({ id: l.id, displayName: l.display_name, enrolled: l.enrollment_status === "enrolled" })); }));

  app.get(`${B}/accounts`, requireSession, school(async (c, req) => {
    needFinance(req);
    const list = await rows(c, `SELECT a.*, u.display_name AS payer FROM ps_billing_accounts a JOIN private_school_memberships m ON m.id=a.payer_membership_id JOIN users u ON u.id=m.user_id ORDER BY a.name`);
    const out = [];
    for (const a of list) {
      const inv = await rows(c, "SELECT id FROM ps_invoices WHERE account_id=$1 AND status='issued'", [a.id]);
      let balance = 0; for (const x of inv) balance += (await invoiceFull(c, x.id)).balance;
      out.push({ id: a.id, name: a.name, payer: a.payer, status: a.status, balanceCents: balance });
    }
    return out;
  }));
  app.post(`${B}/accounts`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needFinance(req);
    const b = req.body || {}, learnerIds = Array.isArray(b.learnerIds) ? [...new Set(b.learnerIds)] : [];
    if (!cleanText(b.name, 120, 2) || !validId(b.payerMembershipId) || learnerIds.some(x => !validId(x)) || learnerIds.length > 20) throw new HttpError(400, "invalid_account");
    if (!(await one(c, "SELECT id FROM private_school_memberships WHERE id=$1 AND role='guardian' AND status='active'", [b.payerMembershipId]))) throw new HttpError(400, "payer_must_be_a_guardian");
    const known = new Set((await rows(c, "SELECT id FROM eduos_ps_billing_learners()")).map(l => l.id));
    if (learnerIds.some(x => !known.has(x))) throw new HttpError(404, "learner_not_found");
    const a = await one(c, "INSERT INTO ps_billing_accounts(school_id, name, payer_membership_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id", [req.actor.privateSchoolId, b.name.trim(), b.payerMembershipId, req.actor.userId]);
    for (const l of learnerIds) await c.query("INSERT INTO ps_billing_account_learners(school_id, account_id, learner_id) VALUES ($1,$2,$3)", [req.actor.privateSchoolId, a.id, l]);
    await psAudit(c, req, "create", "ps_billing_account", a.id, `learners=${learnerIds.length}`);
    return { id: a.id };
  }, 201));
  app.get(`${B}/accounts/:id`, requireSession, school(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const a = await one(c, "SELECT * FROM ps_billing_accounts WHERE id=$1", [req.params.id]);
    if (!a) throw new HttpError(404, "account_not_found");
    const inv = await rows(c, "SELECT id FROM ps_invoices WHERE account_id=$1 ORDER BY created_at DESC", [a.id]);
    const invoices = []; for (const x of inv) invoices.push(invoiceOut(await invoiceFull(c, x.id)));
    return { id: a.id, name: a.name, status: a.status, invoices, balanceCents: invoices.filter(i => i.status === "issued").reduce((n, i) => n + i.balanceCents, 0) };
  }));

  // ---------- invoices ----------
  app.get(`${B}/invoices`, requireSession, school(async (c, req) => {
    needFinance(req);
    const status = ["draft", "issued", "void"].includes(req.query.status) ? req.query.status : null;
    const list = await rows(c, "SELECT id FROM ps_invoices WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT 200", [status]);
    const out = []; for (const x of list) out.push(invoiceOut(await invoiceFull(c, x.id)));
    return out;
  }));
  app.post(`${B}/invoices`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needFinance(req);
    const b = req.body || {}, lines = Array.isArray(b.lines) ? b.lines : [];
    if (!validId(b.accountId) || !cleanText(b.title, 160) || (b.dueOn != null && !DAY(b.dueOn)) || lines.length > 50 || lines.some(l => !lineOk(l)))
      throw new HttpError(400, "invalid_invoice", { hint: "accountId, title, dueOn, lines: [{kind: tuition|fee (positive) or aid|discount|credit (negative), description, learnerId, amountCents}]" });
    if (!(await one(c, "SELECT id FROM ps_billing_accounts WHERE id=$1 AND status='active'", [b.accountId]))) throw new HttpError(404, "account_not_found");
    const i = await one(c, "INSERT INTO ps_invoices(school_id, account_id, title, due_on, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id", [req.actor.privateSchoolId, b.accountId, b.title.trim(), b.dueOn ?? null, req.actor.userId]);
    for (const l of lines) await c.query("INSERT INTO ps_invoice_lines(school_id, invoice_id, kind, description, learner_id, amount_cents, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [req.actor.privateSchoolId, i.id, l.kind, l.description.trim(), l.learnerId ?? null, l.amountCents, req.actor.userId]);
    await psAudit(c, req, "create", "ps_invoice", i.id, `lines=${lines.length}`);
    return invoiceOut(await invoiceFull(c, i.id));
  }, 201));
  app.get(`${B}/invoices/:id`, requireSession, school(async (c, req) => invoiceOut(await invoiceFull(c, req.params.id))));
  app.post(`${B}/invoices/:id/lines`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needFinance(req);
    const f = await invoiceFull(c, req.params.id), l = req.body || {};
    if (f.i.status !== "draft") throw new HttpError(409, "invoice_not_draft");
    if (!lineOk(l)) throw new HttpError(400, "invalid_line");
    await c.query("INSERT INTO ps_invoice_lines(school_id, invoice_id, kind, description, learner_id, amount_cents, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [req.actor.privateSchoolId, f.i.id, l.kind, l.description.trim(), l.learnerId ?? null, l.amountCents, req.actor.userId]);
    await psAudit(c, req, "add_line", "ps_invoice", f.i.id, l.kind);
    return invoiceOut(await invoiceFull(c, f.i.id));
  }, 201));
  app.delete(`${B}/invoices/:id/lines/:lineId`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needFinance(req);
    if (!validId(req.params.id) || !validId(req.params.lineId)) throw new HttpError(400, "invalid_id");
    const r = await c.query("DELETE FROM ps_invoice_lines WHERE id=$1 AND invoice_id=$2", [req.params.lineId, req.params.id]);
    if (!r.rowCount) throw new HttpError(404, "line_not_found");
    await psAudit(c, req, "remove_line", "ps_invoice", req.params.id);
    return { removed: true };
  }));
  app.post(`${B}/invoice-lines/:id/approve`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needAdmin(req);
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const l = await one(c, "SELECT x.*, i.status FROM ps_invoice_lines x JOIN ps_invoices i ON i.id=x.invoice_id WHERE x.id=$1", [req.params.id]);
    if (!l) throw new HttpError(404, "line_not_found");
    if (!["aid", "discount"].includes(l.kind)) throw new HttpError(400, "only_aid_and_discounts_need_approval");
    if (l.status !== "draft") throw new HttpError(409, "invoice_not_draft");
    if (l.created_by === req.actor.userId) throw new HttpError(409, "approve_someone_elses_line");
    await c.query("UPDATE ps_invoice_lines SET approved_by=$2, approved_at=now() WHERE id=$1", [l.id, req.actor.userId]);
    await psAudit(c, req, "approve", "ps_invoice_line", l.id, `${l.kind};${l.amount_cents}`);
    return { approved: true };
  }));
  app.post(`${B}/invoices/:id/issue`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needFinance(req);
    const f = await invoiceFull(c, req.params.id);
    if (f.i.status !== "draft") throw new HttpError(409, "invoice_not_draft");
    if (!f.lines.length) throw new HttpError(400, "invoice_has_no_lines");
    if (f.lines.some(l => ["aid", "discount"].includes(l.kind) && !l.approved_by)) throw new HttpError(409, "aid_needs_approval");
    if (f.total < 0) throw new HttpError(400, "invoice_total_below_zero");
    const number = (await one(c, "SELECT eduos_ps_next_number('invoice') AS n")).n;
    await c.query("UPDATE ps_invoices SET status='issued', number=$2, issued_by=$3, issued_at=now(), total_cents=$4 WHERE id=$1", [f.i.id, number, req.actor.userId, f.total]);
    await psAudit(c, req, "issue", "ps_invoice", f.i.id, `${number};${f.total}`);
    return invoiceOut(await invoiceFull(c, f.i.id));
  }));
  app.post(`${B}/invoices/:id/void`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needFinance(req);
    const reason = req.body?.reason;
    if (!cleanText(reason, 300, 3)) throw new HttpError(400, "reason_required");
    const f = await invoiceFull(c, req.params.id);
    if (f.i.status === "void") throw new HttpError(409, "already_void");
    if (f.paid - f.refunded > 0) throw new HttpError(409, "refund_payments_first");
    await c.query("UPDATE ps_invoices SET status='void', voided_by=$2, voided_at=now(), void_reason=$3 WHERE id=$1", [f.i.id, req.actor.userId, reason.trim()]);
    await psAudit(c, req, "void", "ps_invoice", f.i.id, reason.trim());
    return { voided: true };
  }));

  // ---------- payments, receipts, refunds ----------
  app.post(`${B}/invoices/:id/payments`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needFinance(req);
    const b = req.body || {};
    if (!Number.isInteger(b.amountCents) || b.amountCents <= 0 || b.amountCents > 100000000 || !METHODS.includes(b.method) || !DAY(b.receivedOn) || b.receivedOn > today()
      || (b.reference != null && !cleanText(b.reference, 120)) || (b.method === "provider") !== validId(b.providerId))
      throw new HttpError(400, "invalid_payment", { hint: "amountCents, method (check, ach, cash, provider with providerId, other), reference, receivedOn (not in the future)" });
    const f = await invoiceFull(c, req.params.id);
    if (f.i.status !== "issued") throw new HttpError(409, "invoice_not_issued");
    if (b.amountCents > f.balance) throw new HttpError(409, "more_than_the_balance", { balanceCents: f.balance });
    if (b.providerId && !(await one(c, "SELECT id FROM ps_payment_providers WHERE id=$1 AND status='approved'", [b.providerId]))) throw new HttpError(409, "provider_not_approved");
    const receipt = (await one(c, "SELECT eduos_ps_next_number('receipt') AS n")).n;
    const p = await one(c, `INSERT INTO ps_payments(school_id, invoice_id, amount_cents, method, provider_id, reference, received_on, receipt_number, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [req.actor.privateSchoolId, f.i.id, b.amountCents, b.method, b.providerId ?? null, b.reference?.trim() ?? null, b.receivedOn, receipt, req.actor.userId]);
    await psAudit(c, req, "record_payment", "ps_payment", p.id, `${receipt};${b.amountCents};${b.method}`);
    return { id: p.id, receiptNumber: receipt, balanceCents: f.balance - b.amountCents };
  }, 201));
  app.get(`${B}/payments/:id/receipt`, requireSession, school(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const p = await one(c, `SELECT p.*, i.number AS invoice_number, i.title, a.name AS account, s.display_name AS school, s.legal_name FROM ps_payments p JOIN ps_invoices i ON i.id=p.invoice_id
        JOIN ps_billing_accounts a ON a.id=i.account_id JOIN private_schools s ON s.id=p.school_id WHERE p.id=$1`, [req.params.id]);
    if (!p) throw new HttpError(404, "payment_not_found");
    return { receiptNumber: p.receipt_number, school: p.school, legalName: p.legal_name, account: p.account, invoiceNumber: p.invoice_number, invoiceTitle: p.title,
      amountCents: Number(p.amount_cents), method: p.method, reference: p.reference, receivedOn: ymd(p.received_on),
      statement: "A receipt for a payment recorded by the school. EduOS keeps no card or bank details. For tax purposes, ask the school." };
  }));
  app.post(`${B}/payments/:id/refunds`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needFinance(req);
    const b = req.body || {};
    if (!validId(req.params.id) || !Number.isInteger(b.amountCents) || b.amountCents <= 0 || !cleanText(b.reason, 300, 3)) throw new HttpError(400, "invalid_refund");
    const p = await one(c, "SELECT * FROM ps_payments WHERE id=$1", [req.params.id]);
    if (!p) throw new HttpError(404, "payment_not_found");
    const used = await one(c, "SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM ps_refunds WHERE payment_id=$1 AND status IN ('requested','approved')", [p.id]);
    if (b.amountCents + Number(used.n) > Number(p.amount_cents)) throw new HttpError(409, "more_than_the_payment");
    const r = await one(c, "INSERT INTO ps_refunds(school_id, payment_id, amount_cents, reason, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, status",
      [req.actor.privateSchoolId, p.id, b.amountCents, b.reason.trim(), req.actor.userId]);
    await psAudit(c, req, "request_refund", "ps_refund", r.id, `${b.amountCents}`);
    return r;
  }, 201));
  app.post(`${B}/refunds/:id/decide`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needAdmin(req);
    if (!validId(req.params.id) || typeof req.body?.approve !== "boolean") throw new HttpError(400, "invalid_decision");
    const r0 = await one(c, "SELECT * FROM ps_refunds WHERE id=$1", [req.params.id]);
    if (!r0) throw new HttpError(404, "refund_not_found");
    if (r0.status !== "requested") throw new HttpError(409, "already_decided");
    if (r0.requested_by === req.actor.userId) throw new HttpError(409, "decide_someone_elses_request");
    const status = req.body.approve ? "approved" : "rejected";
    await c.query("UPDATE ps_refunds SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1", [r0.id, status, req.actor.userId]);
    await psAudit(c, req, status === "approved" ? "approve_refund" : "reject_refund", "ps_refund", r0.id, `${r0.amount_cents}`);
    return { id: r0.id, status };
  }));

  // ---------- reconciliation ----------
  const period = q => { const from = DAY(q.from) ? q.from : null, to = DAY(q.to) ? q.to : null; if (!from || !to || to < from) throw new HttpError(400, "invalid_period"); return { from, to }; };
  app.get(`${B}/reconciliation`, requireSession, school(async (c, req) => { needFinance(req); const { from, to } = period(req.query); return { from, to, ...(await periodTotals(c, from, to)) }; }));
  app.post(`${B}/reconciliations`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needFinance(req);
    const { from, to } = period(req.body || {}), note = req.body?.note;
    if (note != null && (typeof note !== "string" || note.length > 1000)) throw new HttpError(400, "invalid_note");
    const totals = await periodTotals(c, from, to);
    const r = await one(c, "INSERT INTO ps_reconciliations(school_id, period_from, period_to, totals, note, prepared_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [req.actor.privateSchoolId, from, to, JSON.stringify(totals), note ?? null, req.actor.userId]);
    await psAudit(c, req, "prepare", "ps_reconciliation", r.id, `${from}..${to};net=${totals.netCents}`);
    return { id: r.id, from, to, totals };
  }, 201));
  app.get(`${B}/reconciliations`, requireSession, school(async (c, req) => {
    needFinance(req);
    return (await rows(c, `SELECT r.*, p.display_name AS prepared, s.display_name AS signed FROM ps_reconciliations r JOIN users p ON p.id=r.prepared_by LEFT JOIN users s ON s.id=r.signed_off_by
        ORDER BY r.period_to DESC, r.prepared_at DESC LIMIT 50`)).map(r => ({ id: r.id, from: ymd(r.period_from), to: ymd(r.period_to), totals: r.totals, note: r.note, preparedBy: r.prepared,
        signedOffBy: r.signed, signedOffAt: r.signed_off_at }));
  }));
  app.post(`${B}/reconciliations/:id/sign-off`, limiter, requireSession, requireCsrf, school(async (c, req) => {
    needAdmin(req);
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const r = await one(c, "SELECT * FROM ps_reconciliations WHERE id=$1", [req.params.id]);
    if (!r) throw new HttpError(404, "reconciliation_not_found");
    if (r.signed_off_by) throw new HttpError(409, "already_signed_off");
    if (r.prepared_by === req.actor.userId) throw new HttpError(409, "sign_off_someone_elses_reconciliation");
    const now = await periodTotals(c, ymd(r.period_from), ymd(r.period_to));
    // jsonb reorders keys, so compare a canonical form.
    const canon = o => JSON.stringify(o, (k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v);
    if (canon({ ...now, pendingRefunds: 0 }) !== canon({ ...r.totals, pendingRefunds: 0 })) throw new HttpError(409, "totals_changed_since_prepared", { now });
    if (now.pendingRefunds) throw new HttpError(409, "refunds_awaiting_a_decision");
    await c.query("UPDATE ps_reconciliations SET signed_off_by=$2, signed_off_at=now() WHERE id=$1", [r.id, req.actor.userId]);
    await psAudit(c, req, "sign_off", "ps_reconciliation", r.id);
    return { signedOff: true };
  }));

  // ---------- guardians ----------
  app.get(`${B}/mine`, requireSession, school(async (c, req) => {
    if (req.actor.privateSchoolRole !== "guardian") throw new HttpError(403, "guardians_only");
    const accounts = await rows(c, "SELECT * FROM ps_billing_accounts ORDER BY name");
    const out = [];
    for (const a of accounts) {
      const inv = await rows(c, "SELECT id FROM ps_invoices WHERE account_id=$1 ORDER BY issued_at DESC", [a.id]);
      const invoices = []; for (const x of inv) invoices.push(invoiceOut(await invoiceFull(c, x.id)));
      out.push({ id: a.id, name: a.name, invoices, balanceCents: invoices.filter(i => i.status === "issued").reduce((n, i) => n + i.balanceCents, 0) });
    }
    return out;
  }));
}
