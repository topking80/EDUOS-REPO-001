// FED-06: a district's side of the exchange gateway (aggregates only).
//   GET  /api/district/exchange          superintendent: this EduOS's exchange key, datasets
//   POST /api/district/exchange/reports  superintendent: {terms}, the agreement's terms file from
//                                        Master Control; builds, minimizes and signs today's
//                                        snapshot report for it; returns the file
// The report is built only from terms signed by Master Control (checked with
// MC_POLICY_PUBLIC_KEY), so its fields, purpose and minimum cell size are
// exactly what both sides approved. It is a snapshot of what EduOS holds
// today (as_of = today), never labelled as an earlier period. Only
// allow-listed school-level counts leave; small cells are suppressed (with
// secondary suppression). No student rows. The superintendent delivers the
// file in Master Control, which checks it against the agreement again.
import rateLimit from "express-rate-limit";
import { readFileSync } from "node:fs";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, HttpError, sendError } from "./role-app-util.js";
import { DATASETS, PURPOSES, MIN_CELL_FLOOR, DEFAULT_MIN_CELL, ENVELOPE_FORMAT, minimize, exchangeKeys, signEnvelope, verifyTerms } from "./federation/exchange.js";
import { parsePublicKey } from "./federation/policy-bundle.js";
import { rulesInForce, recipientAllowed } from "./jurisdiction-rules.js";

function secret() {
  const file = process.env.EXCHANGE_SIGNING_SECRET_FILE;
  if (file) { try { return readFileSync(file, "utf8").trim(); } catch { return ""; } }
  return process.env.EXCHANGE_SIGNING_SECRET || "";
}
const keys = () => exchangeKeys(secret());
const mcKey = () => parsePublicKey(process.env.MC_POLICY_PUBLIC_KEY || "");
const today = () => new Date().toISOString().slice(0, 10);

const QUERIES = {
  enrollment_by_grade: `SELECT s.school_id, sc.name AS school_name, coalesce(nullif(btrim(s.grade_level), ''), 'unknown') AS grade_level, count(*)::int AS student_count
    FROM students s JOIN schools sc ON sc.id = s.school_id AND sc.district_id = s.district_id
   WHERE s.district_id = $1 GROUP BY 1, 2, 3 ORDER BY 2, 3`,
  sports_participation: `SELECT r.school_id, sc.name AS school_name, count(DISTINCT r.student_id)::int AS participant_count
    FROM activity_roster_entries r JOIN school_activities a ON a.id = r.activity_id AND a.district_id = r.district_id AND a.kind = 'sport'
    JOIN schools sc ON sc.id = r.school_id AND sc.district_id = r.district_id
   WHERE r.district_id = $1 AND r.status = 'active' GROUP BY 1, 2 ORDER BY 2`,
};

export function registerExchangeRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `xr:${req.actor?.userId}` });
  const superintendent = (req, res, next) => req.actor?.role === "superintendent" ? next() : res.status(403).json({ error: "superintendent_only" });

  app.get("/api/district/exchange", requireSession, superintendent, (req, res) => {
    const k = keys();
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: { configured: !!k, termsKeyConfigured: !!mcKey(), publicKey: k?.public || null, fingerprint: k?.fingerprint || null, datasets: DATASETS, purposes: PURPOSES, minCellFloor: MIN_CELL_FLOOR, defaultMinCell: DEFAULT_MIN_CELL } });
  });

  app.post("/api/district/exchange/reports", limiter, requireSession, requireCsrf, superintendent, async (req, res, next) => {
    try {
      const k = keys();
      if (!k) throw new HttpError(503, "exchange_signing_not_configured");
      const trusted = mcKey();
      if (!trusted) throw new HttpError(503, "policy_key_not_configured");
      const t = verifyTerms(req.body?.terms, trusted, req.actor.districtId, today());
      if (!t.ok) throw new HttpError(t.reason.startsWith("agreement_") ? 409 : 400, t.reason);
      const terms = t.terms, ds = DATASETS[terms.dataset], fields = terms.fields, minCell = terms.min_cell_size, asOf = today();
      const env = await withTenantTransaction(req.actor, async c => {
        // FED-07: the district's own jurisdiction rules, from its policy bundles.
        const rules = await rulesInForce(c, asOf);
        if (rules.consentRequired && !terms.consent_reference) throw new HttpError(409, "consent_reference_required");
        if (!recipientAllowed(rules, terms.recipient?.jurisdiction_id)) throw new HttpError(409, "recipient_outside_residency");
        const district = await one(c, "SELECT name FROM districts WHERE id=$1", [req.actor.districtId]);
        const raw = await rows(c, QUERIES[terms.dataset], [req.actor.districtId]);
        const minimized = minimize(terms.dataset, raw, fields, minCell);
        const body = { format: ENVELOPE_FORMAT, agreement_id: terms.agreement_id, producer: { tenant_ref: req.actor.districtId, name: district?.name || null },
          recipient: terms.recipient?.name || null, dataset: terms.dataset, fields, purpose: terms.purpose,
          snapshot: true, as_of: asOf, period: { from: asOf, to: asOf },
          suppression: { min_cell_size: minCell, suppressed_cells: minimized.filter(r => r.suppressed).length, secondary: !!ds.group },
          generated_at: asOf, rows: minimized };
        const signed = signEnvelope(body, k);
        await audit(c, req, "export_aggregate", "exchange_report", null,
          `agreement=${terms.agreement_id};dataset=${terms.dataset};purpose=${terms.purpose};as_of=${asOf};rows=${minimized.length};suppressed=${body.suppression.suppressed_cells};sha256=${signed.signature.sha256}`);
        return signed;
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="exchange-${t.terms.agreement_id}-${today()}.json"`);
      res.type("application/json").send(JSON.stringify(env, null, 2));
    } catch (e) { sendError(res, next, e); }
  });
}
