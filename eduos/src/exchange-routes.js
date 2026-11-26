// FED-06: a district's side of the exchange gateway (aggregates only).
//   GET  /api/district/exchange          superintendent: this EduOS's exchange key, datasets
//   POST /api/district/exchange/reports  superintendent: build, minimize and sign an aggregate
//                                        report for one exchange agreement; returns the file
// The superintendent delivers the file in Master Control, which checks it
// against the agreement. Only allow-listed school-level counts leave; small
// cells are suppressed (with secondary suppression). No student rows.
import rateLimit from "express-rate-limit";
import { readFileSync } from "node:fs";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, cleanText, HttpError, sendError } from "./role-app-util.js";
import { DATASETS, PURPOSES, MIN_CELL_FLOOR, DEFAULT_MIN_CELL, ENVELOPE_FORMAT, minimize, exchangeKeys, signEnvelope } from "./federation/exchange.js";

function secret() {
  const file = process.env.EXCHANGE_SIGNING_SECRET_FILE;
  if (file) { try { return readFileSync(file, "utf8").trim(); } catch { return ""; } }
  return process.env.EXCHANGE_SIGNING_SECRET || "";
}
const keys = () => exchangeKeys(secret());
const DAY = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

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
    res.json({ data: { configured: !!k, publicKey: k?.public || null, fingerprint: k?.fingerprint || null, datasets: DATASETS, purposes: PURPOSES, minCellFloor: MIN_CELL_FLOOR, defaultMinCell: DEFAULT_MIN_CELL } });
  });

  app.post("/api/district/exchange/reports", limiter, requireSession, requireCsrf, superintendent, async (req, res, next) => {
    try {
      const k = keys();
      if (!k) throw new HttpError(503, "exchange_signing_not_configured");
      const b = req.body || {}, ds = DATASETS[b.dataset];
      const agreementId = typeof b.agreementId === "string" && /^xa-[0-9a-f]{16}$/.test(b.agreementId) ? b.agreementId : null;
      const minCell = b.minCellSize === undefined ? DEFAULT_MIN_CELL : b.minCellSize;
      if (!ds || !agreementId || !PURPOSES[b.purpose] || !DAY(b.periodFrom) || !DAY(b.periodTo) || b.periodTo < b.periodFrom) throw new HttpError(400, "agreement_dataset_purpose_and_period_required");
      if (!Number.isInteger(minCell) || minCell < MIN_CELL_FLOOR) throw new HttpError(400, "min_cell_too_small");
      const fields = Array.isArray(b.fields) && b.fields.length ? ds.fields.filter(f => b.fields.includes(f)) : ds.fields;
      if (ds.required.some(f => !fields.includes(f)) || b.fields?.some?.(f => !ds.fields.includes(f))) throw new HttpError(400, "fields_not_in_dataset");
      const env = await withTenantTransaction(req.actor, async c => {
        const district = await one(c, "SELECT name FROM districts WHERE id=$1", [req.actor.districtId]);
        const raw = await rows(c, QUERIES[b.dataset], [req.actor.districtId]);
        const minimized = minimize(b.dataset, raw, fields, minCell);
        const body = { format: ENVELOPE_FORMAT, agreement_id: agreementId, producer: { tenant_ref: req.actor.districtId, name: district?.name || null },
          recipient: cleanText(b.recipient, 200, 1) || null, dataset: b.dataset, fields, purpose: b.purpose, period: { from: b.periodFrom, to: b.periodTo },
          suppression: { min_cell_size: minCell, suppressed_cells: minimized.filter(r => r.suppressed).length, secondary: !!ds.group },
          generated_at: new Date().toISOString().slice(0, 10), rows: minimized };
        const signed = signEnvelope(body, k);
        await audit(c, req, "export_aggregate", "exchange_report", null,
          `agreement=${agreementId};dataset=${b.dataset};purpose=${b.purpose};rows=${minimized.length};suppressed=${body.suppression.suppressed_cells};sha256=${signed.signature.sha256}`);
        return signed;
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="exchange-${agreementId}-${b.periodFrom}.json"`);
      res.type("application/json").send(JSON.stringify(env, null, 2));
    } catch (e) { sendError(res, next, e); }
  });
}
