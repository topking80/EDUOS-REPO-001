// TC-12: the district community preservation fund (db/137). SANDBOX / LEDGER ONLY.
//
//   GET  /api/preservation-fund                        anyone in the district: the fund's disclosures and, if published, totals
//   GET  /api/preservation-fund/settings               superintendent
//   PUT  /api/preservation-fund/settings               superintendent (all off by default)
//   GET  /api/preservation-fund/governance             finance: documented approvals
//   POST /api/preservation-fund/governance {kind,reference,approvedOn}  superintendent
//   GET  /api/preservation-fund/report                 finance: balances, disbursements, ledger
//   POST /api/preservation-fund/disbursements          finance: request
//   POST /api/preservation-fund/disbursements/:id/vote {decision,noConflict,note}  finance, not the requester
//   POST /api/preservation-fund/disbursements/:id/pay {paymentRef}  finance, not the requester (records only)
//   POST /api/preservation-fund/disbursements/:id/close {reason}    withdraw (requester) or cancel (approved)
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { audit, rows, one, validId, HttpError } from "./role-app-util.js";
import { wrap } from "./route-helpers.js";
import { isDonationFinance } from "./donation-accounting-routes.js";

export const FUND_CATEGORIES = Object.freeze({ storage: "Storage", archival_media: "Archival media", format_migration: "Moving old files to readable formats",
  backup: "Backups", archive_accessibility: "Making the archive accessible", other_preservation: "Other district-wide preservation" });
export const FUND_LIMITS = "The fund pays only for district-wide preservation. It can't buy any student more storage or any kind of preferential access.";
const DEFAULTS = Object.freeze({ enabled: false, collection_paused: false, disbursement_paused: false, pause_reason: null, fund_name: "Student history preservation fund",
  purpose: "Keeping student histories safe and readable for the long term, for every student in the district.",
  eligible_categories: ["storage", "archival_media", "format_migration", "backup", "archive_accessibility"], allocation_rules: null, governance_text: null,
  refund_policy: null, approvals_required: 2, public_report: false, report_min_donors: 5, updated_at: null });
const PG = { P0002: [404, "not_found"], "55000": [409, null], "22023": [400, null], "42501": [403, null], "23514": [400, "invalid_value"] };
const pgWrap = fn => wrap(async (c, req, res) => {
  try { return await fn(c, req, res); }
  catch (e) { const m = PG[e?.code]; if (m && !(e instanceof HttpError)) throw new HttpError(m[0], m[1] || (/^[a-z_]+$/.test(e.message) ? e.message : "forbidden")); throw e; }
});
const finance = fn => pgWrap(async (c, req, res) => { if (!(await isDonationFinance(c))) throw new HttpError(403, "forbidden"); return fn(c, req, res); });
const supt = fn => pgWrap(async (c, req, res) => { if (req.actor.role !== "superintendent") throw new HttpError(403, "forbidden"); return fn(c, req, res); });
const text = (v, lo, hi) => typeof v === "string" && v.trim().length >= lo && v.trim().length <= hi && !/[\u0000-\u0008\u000b-\u001f]/.test(v);
const optText = (v, lo, hi) => v === undefined || v === null || v === "" || text(v, lo, hi);
const loadFund = async (c, d) => (await one(c, "SELECT * FROM preservation_fund_settings WHERE district_id=$1", [d])) || { ...DEFAULTS };
const settingsOut = s => ({ enabled: s.enabled, collectionPaused: s.collection_paused, disbursementPaused: s.disbursement_paused, pauseReason: s.pause_reason,
  fundName: s.fund_name, purpose: s.purpose, eligibleCategories: s.eligible_categories, allocationRules: s.allocation_rules, governanceText: s.governance_text,
  refundPolicy: s.refund_policy, approvalsRequired: s.approvals_required, publicReport: s.public_report, reportMinDonors: s.report_min_donors, updatedAt: s.updated_at });
const govState = async (c, d) => {
  const recs = await rows(c, `SELECT g.*, u.display_name AS recorded_by_name FROM preservation_fund_governance_records g JOIN users u ON u.id=g.recorded_by
      WHERE g.district_id=$1 ORDER BY g.recorded_at DESC`, [d]);
  const have = new Set(recs.map(r => r.kind));
  return { records: recs.map(r => ({ id: r.id, kind: r.kind, reference: r.reference, approvedOn: r.approved_on, recordedBy: r.recorded_by_name, recordedAt: r.recorded_at })),
    missing: ["legal", "finance", "governance"].filter(k => !have.has(k)) };
};
const disbOut = (x, votes = []) => ({ id: x.id, status: x.status, category: x.category, categoryLabel: FUND_CATEGORIES[x.category], description: x.description,
  payee: x.payee, invoiceRef: x.invoice_ref, amountCents: x.amount_cents, source: x.source_school_id ? { schoolId: x.source_school_id, name: x.school_name } : { unrestricted: true },
  requestedBy: x.requested_by_name, requestedById: x.requested_by, requestedAt: x.requested_at, decidedAt: x.decided_at, paidAt: x.paid_at, paymentRef: x.payment_ref,
  closeReason: x.close_reason, test: x.test_mode,
  votes: votes.filter(v => v.disbursement_id === x.id).map(v => ({ voter: v.voter_name, voterId: v.voter, decision: v.decision, noConflict: v.no_conflict, note: v.note, decidedAt: v.decided_at })) });

export function registerPreservationFundRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `fund:${req.actor?.userId}` });

  app.get("/api/preservation-fund", requireSession, pgWrap(async (c, req) => {
    const s = await loadFund(c, req.actor.districtId);
    const open = (await one(c, "SELECT eduos_preservation_fund_collection_open($1) AS ok", [req.actor.districtId])).ok === true;
    const summary = (await one(c, "SELECT eduos_preservation_fund_summary() AS r")).r;
    return { fundName: s.fund_name, purpose: s.purpose, eligibleCategories: s.eligible_categories.map(k => ({ key: k, label: FUND_CATEGORIES[k] })),
      allocationRules: s.allocation_rules, governanceText: s.governance_text, refundPolicy: s.refund_policy, approvalsRequired: s.approvals_required,
      collecting: open, paused: s.collection_paused || s.disbursement_paused ? { collection: s.collection_paused, disbursement: s.disbursement_paused, reason: s.pause_reason } : null,
      limits: FUND_LIMITS, summary, sandboxOnly: true };
  }));

  app.get("/api/preservation-fund/settings", requireSession, supt(async (c, req) => ({ ...settingsOut(await loadFund(c, req.actor.districtId)),
    governance: await govState(c, req.actor.districtId), categories: FUND_CATEGORIES })));

  app.put("/api/preservation-fund/settings", limiter, requireSession, requireCsrf, supt(async (c, req) => {
    const b = req.body || {}, bool = v => typeof v === "boolean";
    if (!bool(b.enabled) || !bool(b.collectionPaused ?? false) || !bool(b.disbursementPaused ?? false) || !optText(b.pauseReason, 5, 500)
        || !text(b.fundName ?? DEFAULTS.fund_name, 3, 120) || !text(b.purpose ?? DEFAULTS.purpose, 20, 1000)
        || !Array.isArray(b.eligibleCategories ?? DEFAULTS.eligible_categories) || !(b.eligibleCategories ?? DEFAULTS.eligible_categories).length
        || !(b.eligibleCategories ?? DEFAULTS.eligible_categories).every(k => Object.hasOwn(FUND_CATEGORIES, k))
        || !optText(b.allocationRules, 10, 2000) || !optText(b.governanceText, 10, 2000) || !optText(b.refundPolicy, 10, 1000)
        || !(b.approvalsRequired === undefined || (Number.isSafeInteger(b.approvalsRequired) && b.approvalsRequired >= 2 && b.approvalsRequired <= 5))
        || !bool(b.publicReport ?? false) || !(b.reportMinDonors === undefined || (Number.isSafeInteger(b.reportMinDonors) && b.reportMinDonors >= 3 && b.reportMinDonors <= 100)))
      throw new HttpError(400, "invalid_fund_settings");
    if ((b.collectionPaused || b.disbursementPaused) && !b.pauseReason) throw new HttpError(400, "pause_reason_required");
    const t = v => (v ? v.trim() : null);
    const vals = [req.actor.districtId, b.enabled, b.collectionPaused === true, b.disbursementPaused === true, t(b.pauseReason), (b.fundName ?? DEFAULTS.fund_name).trim(),
      (b.purpose ?? DEFAULTS.purpose).trim(), [...new Set(b.eligibleCategories ?? DEFAULTS.eligible_categories)], t(b.allocationRules), t(b.governanceText), t(b.refundPolicy),
      b.approvalsRequired ?? 2, b.publicReport === true, b.reportMinDonors ?? 5, req.actor.userId];
    const row = await one(c, `INSERT INTO preservation_fund_settings(district_id,enabled,collection_paused,disbursement_paused,pause_reason,fund_name,purpose,eligible_categories,
        allocation_rules,governance_text,refund_policy,approvals_required,public_report,report_min_donors,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (district_id) DO UPDATE SET enabled=EXCLUDED.enabled,collection_paused=EXCLUDED.collection_paused,disbursement_paused=EXCLUDED.disbursement_paused,
        pause_reason=EXCLUDED.pause_reason,fund_name=EXCLUDED.fund_name,purpose=EXCLUDED.purpose,eligible_categories=EXCLUDED.eligible_categories,
        allocation_rules=EXCLUDED.allocation_rules,governance_text=EXCLUDED.governance_text,refund_policy=EXCLUDED.refund_policy,approvals_required=EXCLUDED.approvals_required,
        public_report=EXCLUDED.public_report,report_min_donors=EXCLUDED.report_min_donors,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, vals);
    await audit(c, req, "set", "preservation_fund_settings", req.actor.districtId, JSON.stringify({ enabled: row.enabled, collectionPaused: row.collection_paused,
      disbursementPaused: row.disbursement_paused, approvalsRequired: row.approvals_required, publicReport: row.public_report }));
    return settingsOut(row);
  }));

  app.get("/api/preservation-fund/governance", requireSession, finance(async (c, req) => govState(c, req.actor.districtId)));

  app.post("/api/preservation-fund/governance", limiter, requireSession, requireCsrf, supt(async (c, req) => {
    const b = req.body || {};
    if (!["legal", "finance", "governance"].includes(b.kind) || !text(b.reference, 5, 300) || typeof b.approvedOn !== "string"
        || !/^\d{4}-\d{2}-\d{2}$/.test(b.approvedOn) || Number.isNaN(Date.parse(`${b.approvedOn}T00:00:00Z`)) || b.approvedOn > new Date().toISOString().slice(0, 10))
      throw new HttpError(400, "invalid_governance_record");
    const r = await one(c, `INSERT INTO preservation_fund_governance_records(district_id,kind,reference,approved_on,recorded_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [req.actor.districtId, b.kind, b.reference.trim(), b.approvedOn, req.actor.userId]);
    await audit(c, req, "document", "preservation_fund_governance", r.id, b.kind);
    return { id: r.id, ...(await govState(c, req.actor.districtId)) };
  }));

  app.get("/api/preservation-fund/report", requireSession, finance(async (c, req) => {
    const d = req.actor.districtId;
    const s = await loadFund(c, d);
    const sources = await rows(c, `SELECT NULL::uuid AS id, 'Unrestricted' AS name UNION ALL SELECT s.id, s.name FROM schools s WHERE s.district_id=$1
        AND EXISTS (SELECT 1 FROM history_donations g WHERE g.school_id=s.id AND g.status IN ('succeeded','refunded'))`, [d]);
    const balances = [];
    for (const src of sources) {
      const b = await one(c, `SELECT eduos_preservation_fund_available($1::uuid,$2::uuid)::bigint AS available,
          coalesce((SELECT sum(l.amount_cents) FROM history_donation_ledger l JOIN history_donations g ON g.id=l.donation_id WHERE l.district_id=$1 AND g.school_id IS NOT DISTINCT FROM $2::uuid),0)::bigint AS gifts_net,
          coalesce((SELECT -sum(f.amount_cents) FROM preservation_fund_ledger f WHERE f.district_id=$1 AND f.source_school_id IS NOT DISTINCT FROM $2::uuid),0)::bigint AS paid`, [d, src.id]);
      balances.push({ source: src.id ? { schoolId: src.id, name: src.name } : { unrestricted: true, name: "Unrestricted" },
        giftsNetCents: Number(b.gifts_net), paidCents: Number(b.paid), availableCents: Number(b.available) });
    }
    const list = await rows(c, `SELECT x.*, s.name AS school_name, u.display_name AS requested_by_name FROM preservation_fund_disbursements x
        LEFT JOIN schools s ON s.id=x.source_school_id JOIN users u ON u.id=x.requested_by WHERE x.district_id=$1 ORDER BY x.requested_at DESC LIMIT 200`, [d]);
    const votes = await rows(c, `SELECT v.*, u.display_name AS voter_name FROM preservation_fund_votes v JOIN users u ON u.id=v.voter WHERE v.district_id=$1 ORDER BY v.decided_at`, [d]);
    await audit(c, req, "read", "preservation_fund_report", d, null);
    return { settings: settingsOut(s), balances, disbursements: list.map(x => disbOut(x, votes)), categories: FUND_CATEGORIES, me: req.actor.userId, sandboxOnly: true };
  }));

  const loadDisb = async (c, id) => {
    const x = await one(c, `SELECT x.*, s.name AS school_name, u.display_name AS requested_by_name FROM preservation_fund_disbursements x
        LEFT JOIN schools s ON s.id=x.source_school_id JOIN users u ON u.id=x.requested_by WHERE x.id=$1`, [id]);
    const votes = await rows(c, "SELECT v.*, u.display_name AS voter_name FROM preservation_fund_votes v JOIN users u ON u.id=v.voter WHERE v.disbursement_id=$1 ORDER BY v.decided_at", [id]);
    return disbOut(x, votes);
  };

  app.post("/api/preservation-fund/disbursements", limiter, requireSession, requireCsrf, finance(async (c, req) => {
    const b = req.body || {};
    if (!Object.hasOwn(FUND_CATEGORIES, b.category) || !text(b.description, 10, 1000) || !text(b.payee, 2, 200) || !text(b.invoiceRef, 2, 120)
        || !Number.isSafeInteger(b.amountCents) || b.amountCents < 100 || b.amountCents > 100000000
        || !(b.sourceSchoolId === undefined || b.sourceSchoolId === null || validId(b.sourceSchoolId)))
      throw new HttpError(400, "invalid_disbursement");
    const id = (await one(c, "SELECT eduos_preservation_fund_request($1::uuid,$2,$3,$4,$5,$6::int) AS id",
      [b.sourceSchoolId || null, b.category, b.description, b.payee, b.invoiceRef, b.amountCents])).id;
    await audit(c, req, "request", "preservation_fund_disbursement", id, `amount=${b.amountCents};category=${b.category};sandbox=true`);
    return await loadDisb(c, id);
  }));

  app.post("/api/preservation-fund/disbursements/:id/vote", limiter, requireSession, requireCsrf, finance(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const b = req.body || {};
    if (!["approve", "reject"].includes(b.decision) || typeof b.noConflict !== "boolean" || !(b.note === undefined || b.note === null || (typeof b.note === "string" && b.note.length <= 500)))
      throw new HttpError(400, "invalid_vote");
    if (b.decision === "reject" && !text(b.note || "", 5, 500)) throw new HttpError(400, "reason_required");
    const st = (await one(c, "SELECT eduos_preservation_fund_vote($1,$2,$3,$4) AS st", [req.params.id, b.decision, b.noConflict, b.note || null])).st;
    await audit(c, req, b.decision, "preservation_fund_disbursement", req.params.id, `status=${st}`);
    return await loadDisb(c, req.params.id);
  }));

  app.post("/api/preservation-fund/disbursements/:id/pay", limiter, requireSession, requireCsrf, finance(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    if (!text(req.body?.paymentRef, 2, 120)) throw new HttpError(400, "payment_ref_required");
    await one(c, "SELECT eduos_preservation_fund_pay($1,$2) AS id", [req.params.id, req.body.paymentRef]);
    await audit(c, req, "pay", "preservation_fund_disbursement", req.params.id, "sandbox=true");
    return await loadDisb(c, req.params.id);
  }));

  app.post("/api/preservation-fund/disbursements/:id/close", limiter, requireSession, requireCsrf, finance(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    if (!text(req.body?.reason, 5, 500)) throw new HttpError(400, "reason_required");
    const st = (await one(c, "SELECT eduos_preservation_fund_close($1,$2) AS st", [req.params.id, req.body.reason])).st;
    await audit(c, req, st, "preservation_fund_disbursement", req.params.id, null);
    return await loadDisb(c, req.params.id);
  }));
}
