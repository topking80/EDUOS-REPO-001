// TC-10: donation accounting, refunds, reconciliation and receipts (db/136). SANDBOX ONLY.
//
//   GET  /api/donations/finance/access          may I see the gift accounts?
//   GET  /api/donations/finance/reviewers       superintendent: who reviews
//   PUT  /api/donations/finance/reviewers/:userId {on}  superintendent: name or remove a reviewer
//   GET  /api/donations/ledger?from&to          finance: ledger lines and totals
//   POST /api/donations/:id/refund {reason}     finance: sandbox refund of a completed gift
//   GET  /api/donations/:id/refund-notice       the donor or finance: the plain refund notice
//   GET  /api/donations/reconciliation?from&to  finance: the report, gift records against the ledger
//   POST /api/donations/reconciliations {from,to,note}  finance: sign off a period
//   GET  /api/donations/reconciliations         finance: signed-off periods
//
// "Finance" is the district account (superintendent) or a school secretary the
// superintendent designated, signed in as school secretary (db/140).
// Nobody refunds their own gift, and nobody signs off a period in which they
// recorded a refund (both enforced in the database).
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { audit, rows, one, validId, HttpError } from "./role-app-util.js";
import { wrap } from "./route-helpers.js";
import { sandboxProvider } from "./commerce/payments.js";

const PG = { P0002: [404, "not_found"], "55000": [409, null], "22023": [400, null], "42501": [403, null] };
const pgWrap = fn => wrap(async (c, req, res) => {
  try { return await fn(c, req, res); }
  catch (e) { const m = PG[e?.code]; if (m && !(e instanceof HttpError)) throw new HttpError(m[0], m[1] || (/^[a-z_]+$/.test(e.message) ? e.message : "forbidden")); throw e; }
});
export const isDonationFinance = async c => (await one(c, "SELECT eduos_history_donation_finance() AS ok")).ok === true;
const finance = fn => pgWrap(async (c, req, res) => {
  if (!(await isDonationFinance(c))) throw new HttpError(403, "forbidden");
  return fn(c, req, res);
});
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = v => typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const period = q => {
  const today = new Date().toISOString().slice(0, 10);
  const from = q.from ?? `${today.slice(0, 7)}-01`, to = q.to ?? today;
  if (!validDay(from) || !validDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw new HttpError(400, "invalid_period");
  return { from, to };
};
const reconOut = r => ({ id: r.id, periodStart: r.period_start, periodEnd: r.period_end, gifts: r.gifts, grossCents: Number(r.gross_cents),
  feesCents: Number(r.fees_cents), refunds: r.refunds, refundedCents: Number(r.refunded_cents), netCents: Number(r.net_cents),
  ledgerNetCents: Number(r.ledger_net_cents), ledgerLines: r.ledger_lines, matched: r.matched, discrepancies: r.discrepancies, note: r.note,
  reconciledBy: r.reconciled_by_name, reconciledAt: r.reconciled_at, test: r.test_mode });
const LINE_TEXT = { gift: "Gift", processing_fee: "Processing fee", refund: "Refund" };

export function registerDonationAccountingRoutes(app) {
  // Runs after requireSession so each person has their own bucket.
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `donacct:${req.actor?.userId}` });

  app.get("/api/donations/finance/access", requireSession, pgWrap(async c => ({ finance: await isDonationFinance(c) })));

  app.get("/api/donations/finance/reviewers", requireSession, pgWrap(async (c, req) => {
    if (req.actor.role !== "superintendent") throw new HttpError(403, "forbidden");
    const list = await rows(c, `SELECT r.*, u.display_name AS name FROM history_donation_finance_reviewers r JOIN users u ON u.id=r.user_id WHERE r.district_id=$1 ORDER BY r.named_at DESC LIMIT 200`, [req.actor.districtId]);
    const staff = await rows(c, `SELECT DISTINCT u.id, u.display_name AS name FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.district_id=$1 AND m.status='active' AND m.role = 'school_secretary' ORDER BY name LIMIT 500`, [req.actor.districtId]);
    return { reviewers: list.filter(r => !r.removed_at).map(r => ({ userId: r.user_id, name: r.name, namedAt: r.named_at })),
      history: list.map(r => ({ userId: r.user_id, name: r.name, namedAt: r.named_at, removedAt: r.removed_at })), staff,
      eligible: "School secretaries", rules: ["Nobody refunds their own gift.", "Nobody signs off a period in which they recorded a refund."] };
  }));

  app.put("/api/donations/finance/reviewers/:userId", requireSession, limiter, requireCsrf, pgWrap(async (c, req) => {
    if (req.actor.role !== "superintendent") throw new HttpError(403, "forbidden");
    if (!validId(req.params.userId)) throw new HttpError(400, "invalid_id");
    if (typeof req.body?.on !== "boolean") throw new HttpError(400, "invalid_value");
    const id = (await one(c, "SELECT eduos_history_donation_reviewer_set($1,$2) AS id", [req.params.userId, req.body.on])).id;
    await audit(c, req, req.body.on ? "name" : "remove", "donation_finance_reviewer", req.params.userId, null);
    return { id, userId: req.params.userId, on: req.body.on };
  }));

  app.get("/api/donations/ledger", requireSession, finance(async (c, req) => {
    const { from, to } = period(req.query);
    const lines = await rows(c, `SELECT l.*, a.number FROM history_donation_ledger l LEFT JOIN history_donation_acknowledgements a ON a.donation_id=l.donation_id
        WHERE l.district_id=$1 AND l.recorded_at >= $2::date AND l.recorded_at < ($3::date + 1) ORDER BY l.seq LIMIT 2000`, [req.actor.districtId, from, to]);
    const sum = k => lines.filter(l => !k || l.kind === k).reduce((s, l) => s + l.amount_cents, 0);
    await audit(c, req, "read", "donation_ledger", req.actor.districtId, `${from}..${to}`);
    return { from, to, timezone: "UTC", sandboxOnly: true,
      totals: { giftsCents: sum("gift"), feesCents: sum("processing_fee"), refundsCents: sum("refund"), netCents: sum() },
      lines: lines.map(l => ({ id: l.id, seq: Number(l.seq), donationId: l.donation_id, number: l.number, kind: l.kind, label: LINE_TEXT[l.kind],
        amountCents: l.amount_cents, currency: l.currency, providerRef: l.provider_ref, test: l.test_mode, recordedAt: l.recorded_at })) };
  }));

  app.post("/api/donations/:id/refund", requireSession, limiter, requireCsrf, finance(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length < 5 || reason.length > 500 || /[\u0000-\u0008\u000b-\u001f]/.test(reason)) throw new HttpError(400, "reason_required");
    const g = await one(c, "SELECT * FROM history_donations WHERE id=$1 AND district_id=$2", [req.params.id, req.actor.districtId]);
    if (!g) throw new HttpError(404, "not_found");
    if (g.donor_user_id === req.actor.userId) throw new HttpError(403, "own_gift");
    if (g.status !== "succeeded") throw new HttpError(409, "donation_not_refundable", { status: g.status });
    // Every gift's provider is the sandbox (db/135 allows nothing else); it makes no network call.
    const r = await sandboxProvider().refundPayment(g.provider_ref, g.amount_cents);
    const id = (await one(c, "SELECT eduos_history_donation_refund($1,$2,$3) AS id", [g.id, r.refundRef, reason])).id;
    await audit(c, req, "refund", "history_donation", g.id, `amount=${g.amount_cents};sandbox=true`);
    const n = await one(c, "SELECT * FROM history_donation_refunds WHERE id=$1", [id]);
    return { id, number: n.number, amountCents: n.amount_cents, feeKeptCents: n.fee_kept_cents, test: n.test_mode };
  }));

  app.get("/api/donations/:id/refund-notice", requireSession, pgWrap(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    // RLS limits this to the donor and finance.
    const n = await one(c, `SELECT f.*, a.number AS gift_number, a.district_name, a.designation, a.donor_name FROM history_donation_refunds f
        JOIN history_donation_acknowledgements a ON a.donation_id=f.donation_id WHERE f.donation_id=$1 AND f.district_id=$2`, [req.params.id, req.actor.districtId]);
    if (!n) throw new HttpError(404, "not_found");
    await audit(c, req, "read", "history_donation_refund", n.id, null);
    return { number: n.number, giftNumber: n.gift_number, district: n.district_name, designation: n.designation, donor: n.donor_name,
      amountCents: n.amount_cents, currency: "USD", refundedAt: n.recorded_at, test: n.test_mode,
      body: `Your gift ${n.gift_number} was refunded in full.`, note: n.test_mode ? "Test refund through the sandbox. No money moved." : undefined };
  }));

  app.get("/api/donations/reconciliation", requireSession, finance(async (c, req) => {
    const { from, to } = period(req.query);
    const r = (await one(c, "SELECT eduos_history_donation_reconciliation($1,$2) AS r", [from, to])).r;
    const recordedRefund = !!(await one(c, `SELECT 1 FROM history_donation_refunds WHERE district_id=$1 AND recorded_by=$2
        AND recorded_at >= $3::date AND recorded_at < ($4::date + 1) LIMIT 1`, [req.actor.districtId, req.actor.userId, from, to]));
    return { ...r, timezone: "UTC", sandboxOnly: true, canSignOff: !recordedRefund,
      signOffBlocked: recordedRefund ? "You recorded a refund in this period, so someone else signs it off." : null };
  }));

  app.post("/api/donations/reconciliations", requireSession, limiter, requireCsrf, finance(async (c, req) => {
    const { from, to } = period(req.body || {});
    const note = req.body?.note;
    if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 1000)) throw new HttpError(400, "invalid_note");
    const id = (await one(c, "SELECT eduos_history_donation_reconcile($1,$2,$3) AS id", [from, to, note || null])).id;
    const r = await one(c, "SELECT r.*, u.display_name AS reconciled_by_name FROM history_donation_reconciliations r JOIN users u ON u.id=r.reconciled_by WHERE r.id=$1", [id]);
    await audit(c, req, "reconcile", "donation_reconciliation", id, `${from}..${to};matched=${r.matched}`, r.matched ? "success" : "failure");
    return reconOut(r);
  }));

  app.get("/api/donations/reconciliations", requireSession, finance(async (c, req) =>
    (await rows(c, `SELECT r.*, u.display_name AS reconciled_by_name FROM history_donation_reconciliations r JOIN users u ON u.id=r.reconciled_by
        WHERE r.district_id=$1 ORDER BY r.reconciled_at DESC LIMIT 100`, [req.actor.districtId])).map(reconOut)));
}
