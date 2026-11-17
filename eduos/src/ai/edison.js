// EduOS 37.6.0 Edison: operations trends for school leaders, computed ONLY
// from what the EDEN aggregation gate releases (src/eden/aggregation-gate.js:
// allow-listed count tables, minimum cell size 5, complementary suppression,
// identifier scan). Raw counts come from eduos_edison_source (059) and go
// straight into release(); nothing else of them is kept or returned.
//   GET  /api/edison/trends  the released trends (no AI involved)
//   POST /api/edison/brief   an AI brief over those released numbers only,
//                            through the staff AI gateway (use case ops_trends)
// No student is profiled, scored or predicted: there are no student rows here.
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { requireSession, requireCsrf } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { HttpError, audit, rows, sendError } from "../role-app-util.js";
import { release, buildIdentifierIndex, GateError, K_MIN } from "../eden/aggregation-gate.js";
import { USECASES, policyOf } from "./gateway.js";
import { createProvider } from "./providers.js";
import { invokeAi } from "./invoke.js";
import { attendanceDay, transportDay, enrollmentTotal, schoolDays } from "./edison-trends.js";

const USECASE = "ops_trends";
const ROLES = USECASES[USECASE].roles;
export const MAX_DAYS = 20, MAX_SCHOOLS = 50;

/**
 * Trends in the caller's scope. Returns { context, schools } where context is
 * what Edison (and an AI model) may see: gate-released counts with school
 * labels; `schools` maps labels to the caller's own schools for the UI.
 */
export async function edisonTrends(c, actor, { days = 10 } = {}) {
  const school = actor.role === "superintendent" ? null : actor.schoolId;
  if (actor.role !== "superintendent" && !school) throw new HttpError(403, "school_scope_required");
  const list = await rows(c, `SELECT id,name FROM schools WHERE district_id=$1 AND status='active' AND ($2::uuid IS NULL OR id=$2) ORDER BY name LIMIT ${MAX_SCHOOLS}`, [actor.districtId, school]);
  const ix = (await rows(c, `SELECT eduos_edison_identifiers() AS x`))[0].x;
  const identifiers = buildIdentifierIndex(ix);
  const blocked = [];
  const gate = async (kind, schoolId, period, day) => {
    const src = (await rows(c, `SELECT eduos_edison_source($1,$2,$3::date) AS x`, [kind, schoolId, day]))[0].x;
    try { return release({ kind, schoolId, period, cells: src.cells }, { identifiers }); }
    catch (e) { if (!(e instanceof GateError)) throw e; blocked.push({ kind, period, reason: e.code }); return null; }
  };
  const out = [], map = [];
  for (const [i, s] of list.entries()) {
    const label = `School ${i + 1}`;
    const today = (await rows(c, `SELECT eduos_school_today($1)::text AS d`, [s.id]))[0].d;
    const attendance = [];
    for (const day of schoolDays(today, days)) {
      const r = await gate("attendance_daily", s.id, day, day);
      if (r) attendance.push(attendanceDay(r));
    }
    const t = await gate("transport_checkins_daily", s.id, today, today);
    const e = await gate("enrollment_by_grade", s.id, "current", today);
    out.push({ label, today, attendance, transport: t ? transportDay(t) : null, enrolled: e ? enrollmentTotal(e) : null });
    map.push({ label, schoolId: s.id, name: s.name });
  }
  return { context: { scope: school ? "school" : "district", days, k: K_MIN, schools: out, withheld: blocked.length }, schools: map };
}

const daysOf = (v) => { const n = v === undefined ? 10 : Number(v); if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new HttpError(400, "invalid_days", { max: MAX_DAYS }); return n; };

export function registerEdisonRoutes(app, { provider = createProvider(config) } = {}) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `edison:${req.actor?.userId}` });
  const roleOk = (req, res, next) => ROLES.includes(req.actor?.role) ? next() : res.status(403).json({ error: "edison_school_leaders_only" });

  app.get("/api/edison/trends", requireSession, roleOk, limiter, async (req, res, next) => {
    try {
      const days = daysOf(req.query.days);
      const data = await withTenantTransaction(req.actor, async (c) => {
        const t = await edisonTrends(c, req.actor, { days });
        const p = await policyOf(c, req.actor.districtId);
        await audit(c, req, "read", "edison_trends", null, `days=${days};schools=${t.schools.length};withheld=${t.context.withheld}`);
        return { ...t.context, schools: t.context.schools.map((s, i) => ({ ...s, ...t.schools[i] })), briefEnabled: p.enabled_usecases.includes(USECASE) };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/edison/brief", requireSession, requireCsrf, roleOk, limiter, async (req, res, next) => {
    try {
      const days = daysOf(req.body?.days);
      // The model gets the released context only: school labels, dates and
      // published counts. School names stay here (mapped back for the UI).
      let map;
      const r = await invokeAi(req, { provider, usecase: USECASE, prepare: async (c) => {
        const t = await edisonTrends(c, req.actor, { days });
        map = t.schools;
        return { input: { context: t.context } };
      } });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: { text: r.out.text, source: r.source, tokens: r.tokensIn + r.tokensOut, basis: r.input.context, schools: map } });
    } catch (e) { sendError(res, next, e); }
  });
}
