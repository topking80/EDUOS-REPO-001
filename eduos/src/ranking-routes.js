// RANK-01: the U.S. News indicators dashboard (db/117, src/ranking-indicators.js).
//
//   GET  /api/rankings/indicators                       the six indicators: weights, what each measures, fields
//   GET  /api/rankings/schools?year=2025-26             each school in scope: which figures are in, verified, missing
//   GET  /api/rankings/schools/:id                      one school, every year, with trends
//   PUT  /api/rankings/schools/:id/:year/:indicator     {values, sourceUrl?, sourceNote?}  principal (their school) / superintendent
//   POST /api/rankings/entries/:id/verify               superintendent (not their own entry)
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { INDICATORS, KINDS, cleanValues, display, validYear } from "./ranking-indicators.js";

const READERS = ["principal", "vice_principal", "superintendent"];
const https = u => { try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password && u.length <= 500; } catch { return false; } };
const entryOut = e => ({ id: e.id, year: e.data_year, indicator: e.indicator, values: e.vals, shown: display(e.indicator, e.vals), sourceUrl: e.source_url, sourceNote: e.source_note,
  enteredBy: e.enterer, enteredAt: e.entered_at, verifiedBy: e.verifier, verifiedAt: e.verified_at });
const ENTRY_SELECT = `SELECT e.*,u.display_name AS enterer,v.display_name AS verifier FROM school_ranking_entries e JOIN users u ON u.id=e.entered_by LEFT JOIN users v ON v.id=e.verified_by`;

export function registerRankingRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { sendError(res, next, e); }
  };
  const schoolsInScope = (c, req) => rows(c, `SELECT id,name FROM schools WHERE ($1='superintendent' OR id=$2) ORDER BY name`, [req.actor.role, req.actor.schoolId]);

  app.get("/api/rankings/indicators", requireSession, only(READERS), (req, res) => res.json({ data: {
    indicators: Object.entries(INDICATORS).map(([key, d]) => ({ key, name: d.name, weight: d.weight, about: d.about, fields: d.fields.map(([k, label]) => ({ key: k, label })) })),
    published: { key: "published_rank", name: KINDS.published_rank.name, about: KINDS.published_rank.about, fields: KINDS.published_rank.fields.map(([k, label]) => ({ key: k, label })) },
    note: "U.S. News ranks schools by comparing them across each state and nationally, and models expected results by demographics. EduOS tracks your own figures; it doesn't compute or predict a rank." } }));

  app.get("/api/rankings/schools", requireSession, only(READERS), run(async (c, req) => {
    const year = validYear(req.query.year) ? req.query.year : null;
    const schools = await schoolsInScope(c, req);
    const entries = await rows(c, `SELECT school_id,data_year,indicator,verified_at IS NOT NULL AS verified FROM school_ranking_entries WHERE superseded_at IS NULL AND ($1::text IS NULL OR data_year=$1)`, [year]);
    const years = [...new Set(entries.map(e => e.data_year))].sort().reverse();
    const y = year || years[0] || null;
    return { year: y, years, schools: schools.map(s => {
      const mine = entries.filter(e => e.school_id === s.id && e.data_year === y);
      const have = Object.keys(INDICATORS).filter(k => mine.some(e => e.indicator === k));
      return { id: s.id, name: s.name, entered: have.length, verified: mine.filter(e => e.verified && INDICATORS[e.indicator]).length,
        weightCovered: have.reduce((a, k) => a + INDICATORS[k].weight, 0), missing: Object.keys(INDICATORS).filter(k => !have.includes(k)) };
    }) };
  }));

  app.get("/api/rankings/schools/:id", requireSession, only(READERS), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const s = (await schoolsInScope(c, req)).find(x => x.id === req.params.id);
    if (!s) throw new HttpError(404, "school_not_found");
    const current = (await rows(c, `${ENTRY_SELECT} WHERE e.school_id=$1 AND e.superseded_at IS NULL ORDER BY e.data_year DESC`, [s.id])).map(entryOut);
    const history = await rows(c, `SELECT count(*)::int AS n FROM school_ranking_entries WHERE school_id=$1 AND superseded_at IS NOT NULL`, [s.id]);
    const years = [...new Set(current.map(e => e.year))].sort().reverse();
    return { id: s.id, name: s.name, years, changesKept: history[0].n,
      indicators: [...Object.keys(INDICATORS), "published_rank"].map(key => ({ key, name: KINDS[key].name, weight: INDICATORS[key]?.weight ?? null,
        byYear: years.map(y => current.find(e => e.indicator === key && e.year === y) || null) })) };
  }));

  app.put("/api/rankings/schools/:id/:year/:indicator", limiter, requireSession, requireCsrf, only(["principal", "superintendent"]), run(async (c, req) => {
    const { id, year, indicator } = req.params, b = req.body || {};
    if (!validId(id) || !validYear(year) || !KINDS[indicator]) throw new HttpError(400, "invalid_entry");
    const vals = cleanValues(indicator, b.values);
    if (!vals) throw new HttpError(400, "check_the_figures");
    const url = b.sourceUrl || null, note = typeof b.sourceNote === "string" && b.sourceNote.trim() ? b.sourceNote.trim() : null;
    if ((url && !https(url)) || (note && !cleanText(note, 300))) throw new HttpError(400, "invalid_source");
    if (!url && !note) throw new HttpError(400, "source_required");
    if (!(await schoolsInScope(c, req)).some(x => x.id === id)) throw new HttpError(404, "school_not_found");
    await c.query(`UPDATE school_ranking_entries SET superseded_at=now() WHERE school_id=$1 AND data_year=$2 AND indicator=$3 AND superseded_at IS NULL`, [id, year, indicator]);
    const e = await one(c, `INSERT INTO school_ranking_entries(district_id,school_id,data_year,indicator,vals,source_url,source_note,entered_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.actor.districtId, id, year, indicator, vals, url, note, req.actor.userId]);
    await audit(c, req, "update", "ranking_indicator", id, `${year} ${indicator}`);
    return entryOut(await one(c, `${ENTRY_SELECT} WHERE e.id=$1`, [e.id]));
  }));

  app.post("/api/rankings/entries/:id/verify", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const e = await one(c, `SELECT id,entered_by FROM school_ranking_entries WHERE id=$1 AND superseded_at IS NULL AND verified_at IS NULL`, [req.params.id]);
    if (!e) throw new HttpError(404, "entry_not_found");
    if (e.entered_by === req.actor.userId) throw new HttpError(403, "someone_else_verifies");
    await c.query(`UPDATE school_ranking_entries SET verified_by=$2,verified_at=now() WHERE id=$1`, [e.id, req.actor.userId]);
    await audit(c, req, "verify", "ranking_indicator", e.id, null);
    return { verified: true };
  }));
}
