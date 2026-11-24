// TC-09: voluntary donations toward preserving student history (db/135).
// SANDBOX ONLY: gifts complete only through the built-in sandbox processor,
// so nothing is charged. The district's payment setup (db/066) decides which
// methods exist; a method carried by a real processor answers
// 409 donations_sandbox_only until hosted donation checkout is built.
//
// Anyone signed in (not students):
//   GET  /api/donations/status                     is giving on, amounts, schools, methods
//   POST /api/donations                            {amountCents, schoolId?, anonymous?, paymentMethod?, idempotencyKey}
//   POST /api/donations/:id/confirm                {testOutcome: sandbox_success | sandbox_decline}
//   GET  /api/donations/mine                       my gifts
//   GET  /api/donations/:id/acknowledgement        the record of a gift (donor or superintendent)
// Superintendent:
//   GET  /api/donations                            the district's gifts (anonymous donors hidden)
//   GET  /api/donations/settings, PUT              on/off, amounts, acknowledgement and tax-receipt wording
//
// A gift never names or touches a student, and never changes a storage limit
// or anything a student gets.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { config } from "./config.js";
import { audit, rows, one, validId, HttpError } from "./role-app-util.js";
import { wrap, created } from "./route-helpers.js";
import { resolveCheckout, checkoutMethods } from "./commerce/setup.js";
import { SANDBOX_OUTCOMES, sandboxProvider } from "./commerce/payments.js";
import { isDonationFinance } from "./donation-accounting-routes.js";

export const DONATION_STATEMENT = "Gifts are voluntary. They never change storage limits, what is kept, or anything a student gets.";
export const DONATION_FEES = "The payment processor keeps a fee from each gift (in test mode 2.9% plus 30 cents), shown before you give.";
export const DONATION_HELP = "One-time gifts only for now. For a refund or a question, contact your district office.";
const DEFAULT_ACK = "Thank you for your voluntary gift to help keep student histories safe. This is a record of your gift.";
const DEFAULTS = Object.freeze({ enabled: false, min_cents: 100, max_cents: 50000, suggested_cents: [1000, 2500, 5000], acknowledgement_text: DEFAULT_ACK,
  tax_wording_enabled: false, tax_wording: null, updated_at: null });
const settingsOut = s => ({ enabled: s.enabled, minCents: s.min_cents, maxCents: s.max_cents, suggestedCents: (s.suggested_cents || []).map(Number),
  acknowledgementText: s.acknowledgement_text, taxWordingEnabled: s.tax_wording_enabled, taxWording: s.tax_wording, updatedAt: s.updated_at });
export const loadDonationSettings = async (c, districtId) =>
  (await one(c, "SELECT * FROM district_donation_settings WHERE district_id=$1", [districtId])) || { ...DEFAULTS };
const donationOut = (g, { forOffice = false } = {}) => ({ id: g.id, status: g.status, amountCents: g.amount_cents, currency: g.currency,
  processingFeeCents: g.processing_fee_cents, designation: g.school_name ? { schoolId: g.school_id, name: g.school_name } : { district: true },
  anonymous: g.anonymous, donor: forOffice ? (g.anonymous ? "Anonymous" : g.donor_name) : undefined, method: g.payment_method, test: g.mode === "test",
  createdAt: g.created_at, confirmedAt: g.confirmed_at, refundedAt: g.refunded_at, acknowledgement: g.ack_number ? { id: g.ack_id, number: g.ack_number } : null,
  refundNotice: g.refund_number ? { number: g.refund_number } : null });
const ackOut = a => ({ id: a.id, number: a.number, issuedAt: a.issued_at, district: a.district_name, designation: a.designation, donor: a.donor_name,
  amountCents: a.amount_cents, currency: a.currency, body: a.body, taxWording: a.tax_wording, test: a.test_mode,
  note: a.test_mode ? "Test gift through the sandbox. No money moved." : undefined });
const GIFTS_SQL = `SELECT g.*, s.name AS school_name, a.id AS ack_id, a.number AS ack_number, f.number AS refund_number FROM history_donations g
  LEFT JOIN schools s ON s.id=g.school_id LEFT JOIN history_donation_acknowledgements a ON a.donation_id=g.id
  LEFT JOIN history_donation_refunds f ON f.donation_id=g.id`;
const PG = { P0002: [404, "not_found"], "55000": [409, null], "22023": [400, null], "23503": [400, "invalid_value"] };
const pgWrap = fn => wrap(async (c, req, res) => {
  try { return await fn(c, req, res); }
  catch (e) { const m = PG[e?.code]; if (m && !(e instanceof HttpError)) throw new HttpError(m[0], m[1] || (/^[a-z_]+$/.test(e.message) ? e.message : "invalid_value")); throw e; }
});
const notPupil = (req, res, next) => req.actor?.role === "pupil"
  ? res.status(403).json({ error: "guardian_payment_required", reason: "Students can't give or pay." }) : next();
const supt = (req, res, next) => req.actor?.role === "superintendent" ? next() : res.status(403).json({ error: "forbidden" });

export function registerDonationRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `don:${req.actor?.userId}` });

  app.get("/api/donations/status", requireSession, pgWrap(async (c, req) => {
    const s = await loadDonationSettings(c, req.actor.districtId);
    const cm = await checkoutMethods(c, req.actor.districtId);
    const methods = cm.methods.map(m => ({ method: m.method, label: m.label, default: m.default, available: m.ready && m.processor === "sandbox",
      reason: !m.ready ? m.reason : m.processor !== "sandbox" ? "donations_sandbox_only" : null }));
    const schools = await rows(c, "SELECT id, name FROM schools WHERE district_id=$1 ORDER BY name", [req.actor.districtId]);
    const usable = methods.some(m => m.available);
    // TC-12 (db/137): gifts go into the preservation fund, which stays closed until
    // the district documents its approvals and opens it.
    const fundOpen = (await one(c, "SELECT eduos_preservation_fund_collection_open($1) AS ok", [req.actor.districtId])).ok === true;
    return { enabled: s.enabled && fundOpen && usable, districtEnabled: s.enabled, fundOpen,
      reason: !s.enabled ? "donations_not_enabled" : !fundOpen ? "fund_collection_closed" : !usable ? "no_sandbox_method" : null,
      canGive: req.actor.role !== "pupil", sandboxOnly: true, liveSwitch: config.commerceLivePaymentsEnabled === true,
      minCents: s.min_cents, maxCents: s.max_cents, suggestedCents: (s.suggested_cents || []).map(Number), schools, methods,
      statement: DONATION_STATEMENT, fees: DONATION_FEES, help: DONATION_HELP, changesStorage: false };
  }));

  app.post("/api/donations", limiter, requireSession, requireCsrf, notPupil, pgWrap(async (c, req) => {
    const a = req.actor, b = req.body || {};
    const s = await loadDonationSettings(c, a.districtId);
    if (!s.enabled) throw new HttpError(503, "donations_not_enabled");
    if (!(await one(c, "SELECT eduos_preservation_fund_collection_open($1) AS ok", [a.districtId])).ok) throw new HttpError(503, "fund_collection_closed");
    if (!Number.isSafeInteger(b.amountCents) || b.amountCents < s.min_cents || b.amountCents > s.max_cents)
      throw new HttpError(400, "invalid_amount", { minCents: s.min_cents, maxCents: s.max_cents });
    if (b.schoolId !== undefined && b.schoolId !== null && !validId(b.schoolId)) throw new HttpError(400, "invalid_school");
    if (typeof b.idempotencyKey !== "string" || b.idempotencyKey.length < 16 || b.idempotencyKey.length > 120) throw new HttpError(400, "invalid_idempotency_key");
    if (b.anonymous !== undefined && typeof b.anonymous !== "boolean") throw new HttpError(400, "invalid_value");
    if (b.paymentMethod !== undefined && (typeof b.paymentMethod !== "string" || b.paymentMethod.length > 20)) throw new HttpError(400, "invalid_payment_method");
    const prior = await one(c, `${GIFTS_SQL} WHERE g.district_id=$1 AND g.donor_user_id=$2 AND g.idempotency_key=$3`, [a.districtId, a.userId, b.idempotencyKey]);
    if (prior) {
      if (prior.amount_cents !== b.amountCents || (prior.school_id || null) !== (b.schoolId || null)) throw new HttpError(409, "idempotency_key_reused");
      return donationOut(prior);
    }
    if (b.schoolId && !(await one(c, "SELECT 1 FROM schools WHERE id=$1 AND district_id=$2", [b.schoolId, a.districtId]))) throw new HttpError(400, "invalid_school");
    const { adapter, method, processor } = await resolveCheckout(c, a.districtId, b.paymentMethod);
    if (processor !== "sandbox") throw new HttpError(409, "donations_sandbox_only", { method, reason: "Gifts can only be tested through the sandbox for now." });
    // The sandbox makes no network call, so it can run inside the transaction.
    const fee = adapter.feeFor(b.amountCents);
    const p = await adapter.createPayment({ amountCents: b.amountCents, currency: "USD" });
    const name = a.displayName || (await one(c, "SELECT display_name FROM users WHERE id=$1", [a.userId]))?.display_name || "Donor";
    const g = await one(c, `INSERT INTO history_donations(district_id,school_id,donor_user_id,donor_name,anonymous,amount_cents,processing_fee_cents,payment_method,provider,mode,provider_ref,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'sandbox','test',$9,$10) RETURNING *`,
      [a.districtId, b.schoolId || null, a.userId, name.slice(0, 200), b.anonymous === true, b.amountCents, fee, method, p.providerRef, b.idempotencyKey]);
    await audit(c, req, "start", "history_donation", g.id, `amount=${g.amount_cents};school=${g.school_id || "district"};method=${method};sandbox=true`);
    return created(donationOut({ ...g, school_name: b.schoolId ? (await one(c, "SELECT name FROM schools WHERE id=$1", [b.schoolId]))?.name : null }));
  }));

  app.post("/api/donations/:id/confirm", limiter, requireSession, requireCsrf, notPupil, pgWrap(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const outcome = req.body?.testOutcome ?? "sandbox_success";
    if (!SANDBOX_OUTCOMES.includes(outcome)) throw new HttpError(400, "invalid_test_outcome", { allowed: SANDBOX_OUTCOMES });
    const g = await one(c, "SELECT * FROM history_donations WHERE id=$1 AND donor_user_id=$2", [req.params.id, req.actor.userId]);
    if (!g) throw new HttpError(404, "not_found");
    let ackId = null;
    if (g.status === "pending") {
      // Every gift's provider is the sandbox (db/135 allows nothing else).
      const r = await sandboxProvider().confirmPayment(g.provider_ref, { testOutcome: outcome });
      ackId = (await one(c, "SELECT eduos_history_donation_record($1,$2,$3) AS id", [g.id, r.status === "succeeded" ? "succeeded" : "declined", r.declineCode || null])).id;
      await audit(c, req, r.status === "succeeded" ? "succeeded" : "declined", "history_donation", g.id, `amount=${g.amount_cents};sandbox=true`, r.status === "succeeded" ? "success" : "failure");
    } else if (g.status !== "succeeded") throw new HttpError(409, "donation_not_pending", { status: g.status });
    const out = await one(c, `${GIFTS_SQL} WHERE g.id=$1`, [g.id]);
    const ack = out.ack_id ? await one(c, "SELECT * FROM history_donation_acknowledgements WHERE id=$1", [ackId || out.ack_id]) : null;
    return { donation: donationOut(out), acknowledgement: ack ? ackOut(ack) : null };
  }));

  app.get("/api/donations/mine", requireSession, pgWrap(async (c, req) =>
    (await rows(c, `${GIFTS_SQL} WHERE g.district_id=$1 AND g.donor_user_id=$2 ORDER BY g.created_at DESC LIMIT 100`, [req.actor.districtId, req.actor.userId])).map(g => donationOut(g))));

  app.get("/api/donations/:id/acknowledgement", requireSession, pgWrap(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const a = await one(c, `SELECT a.* FROM history_donation_acknowledgements a JOIN history_donations g ON g.id=a.donation_id
        WHERE a.donation_id=$1`, [req.params.id]); // RLS: the donor or finance (db/136)
    if (!a) throw new HttpError(404, "not_found");
    await audit(c, req, "read", "history_donation_acknowledgement", a.id, null);
    return ackOut(a);
  }));

  // The superintendent or a named finance reviewer (db/136).
  app.get("/api/donations", requireSession, pgWrap(async (c, req) => {
    if (!(await isDonationFinance(c))) throw new HttpError(403, "forbidden");
    const list = await rows(c, `${GIFTS_SQL} WHERE g.district_id=$1 ORDER BY g.created_at DESC LIMIT 200`, [req.actor.districtId]);
    const t = await one(c, `SELECT count(*) FILTER (WHERE status='succeeded')::int AS gifts, coalesce(sum(amount_cents) FILTER (WHERE status='succeeded'),0)::bigint AS gross,
        coalesce(sum(processing_fee_cents) FILTER (WHERE status='succeeded'),0)::bigint AS fees FROM history_donations WHERE district_id=$1`, [req.actor.districtId]);
    await audit(c, req, "read", "history_donations", req.actor.districtId, null);
    return { totals: { gifts: t.gifts, grossCents: Number(t.gross), feesCents: Number(t.fees), netCents: Number(t.gross) - Number(t.fees) },
      gifts: list.map(g => donationOut(g, { forOffice: true })), sandboxOnly: true };
  }));

  app.get("/api/donations/settings", requireSession, supt, pgWrap(async (c, req) => settingsOut(await loadDonationSettings(c, req.actor.districtId))));

  app.put("/api/donations/settings", limiter, requireSession, requireCsrf, supt, pgWrap(async (c, req) => {
    const b = req.body || {}, int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
    const text = (v, lo, hi) => typeof v === "string" && v.trim().length >= lo && v.trim().length <= hi && !/[\u0000-\u0008\u000b-\u001f]/.test(v);
    if (typeof b.enabled !== "boolean" || !int(b.minCents, 100, 100000) || !int(b.maxCents, 100, 10000000) || b.minCents > b.maxCents
        || !Array.isArray(b.suggestedCents) || b.suggestedCents.length > 6 || !b.suggestedCents.every(v => int(v, b.minCents, b.maxCents))
        || !text(b.acknowledgementText ?? DEFAULT_ACK, 20, 1000) || typeof (b.taxWordingEnabled ?? false) !== "boolean"
        || !(b.taxWording === undefined || b.taxWording === null || b.taxWording === "" || text(b.taxWording, 10, 1000)))
      throw new HttpError(400, "invalid_donation_settings");
    const wording = b.taxWording ? b.taxWording.trim() : null;
    if (b.taxWordingEnabled && !wording) throw new HttpError(400, "tax_wording_required");
    const row = await one(c, `INSERT INTO district_donation_settings(district_id,enabled,min_cents,max_cents,suggested_cents,acknowledgement_text,tax_wording_enabled,tax_wording,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (district_id) DO UPDATE SET enabled=EXCLUDED.enabled,min_cents=EXCLUDED.min_cents,max_cents=EXCLUDED.max_cents,
        suggested_cents=EXCLUDED.suggested_cents,acknowledgement_text=EXCLUDED.acknowledgement_text,tax_wording_enabled=EXCLUDED.tax_wording_enabled,
        tax_wording=EXCLUDED.tax_wording,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
      [req.actor.districtId, b.enabled, b.minCents, b.maxCents, b.suggestedCents, (b.acknowledgementText ?? DEFAULT_ACK).trim(), b.taxWordingEnabled === true, wording, req.actor.userId]);
    await audit(c, req, "set", "donation_settings", req.actor.districtId, JSON.stringify({ enabled: row.enabled, minCents: row.min_cents, maxCents: row.max_cents, taxWordingEnabled: row.tax_wording_enabled }));
    return settingsOut(row);
  }));
}
