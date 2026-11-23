// COACH-02: a coach's practice plans and playbooks (db/106, src/coaching-plan.js).
//
//   GET  /api/coaching/plans                 my plans
//   GET  /api/coaching/plans/:id             one plan
//   POST /api/coaching/plans                 new plan { kind, title, sport, level?, body, teamId? }
//   PUT  /api/coaching/plans/:id             save { baseVersion, title, sport, level, body, teamId }
//   POST /api/coaching/plans/:id/archive     put it away
//   POST /api/coaching/plans/:id/share       to the district library (student-name check)
//   GET  /api/coaching/library               practice plans and playbooks colleagues shared
//   POST /api/coaching/library/:id/copy      copy one into my plans
//
// Plans belong to the person (teacher, principal or coach profile). A plan
// may be attached to a team the person coaches at the current school. Plans
// name drills and plays, not players; sharing checks the text against the
// district's student names like lessons (TEACH-02).
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { PLAN_KINDS, cleanPlanBody, missingForPlan, planText, planMinutes } from "./coaching-plan.js";
import { studentWordsIn, publish } from "./materials-routes.js";

const COACHES = ["teacher", "principal", "coach"];
const only = (req, res, next) => COACHES.includes(req.actor?.role) ? next() : res.status(403).json({ error: "coaches_only" });
const LEVEL = v => v == null || v === "" ? "All" : (cleanText(v, 4) ? v.trim() : null);

/** A team the person coaches or advises at the current school (null if not). */
async function myTeam(c, a, teamId) {
  return one(c, `SELECT x.id,x.title FROM activity_staff s JOIN school_activities x ON x.id=s.activity_id
      WHERE s.district_id=$1 AND s.school_id=$2 AND s.user_id=$3 AND s.activity_id=$4 AND s.ended_at IS NULL`, [a.districtId, a.schoolId, a.userId, teamId]);
}
const planOut = p => ({ id: p.id, kind: p.kind, title: p.title, sport: p.sport, level: p.level, body: p.body, teamId: p.team_id, version: p.version,
  minutes: planMinutes(p.body), items: p.body.items.length, adaptedFrom: p.adapted_from, updatedAt: p.updated_at });

function parsePlan(b, { partial = false } = {}) {
  const level = LEVEL(b.level), body = cleanPlanBody(b.body);
  if (!body || level === null || !cleanText(b.title, 120) || !cleanText(b.sport, 40) || (!partial && !PLAN_KINDS.includes(b.kind)) || (b.teamId != null && !validId(b.teamId))) return null;
  const gaps = missingForPlan(b.title, body);
  return gaps.length ? { gaps } : { title: b.title.trim(), sport: b.sport.trim(), level, body, teamId: b.teamId || null };
}

export function registerCoachingRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const read = [requireSession, only];
  const write = [limiter, requireSession, requireCsrf, only];
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); if (out?.status) return res.status(out.status).json(out.body); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { sendError(res, next, e); }
  };

  app.get("/api/coaching/plans", ...read, run(async c => (await rows(c, `SELECT * FROM coaching_plans WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 300`))
    .map(p => { const { body, ...o } = planOut(p); return o; })));

  app.get("/api/coaching/plans/:id", ...read, run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const p = await one(c, `SELECT * FROM coaching_plans WHERE id=$1`, [req.params.id]);
    if (!p) throw new HttpError(404, "plan_not_found");
    return planOut(p);
  }));

  app.post("/api/coaching/plans", ...write, run(async (c, req) => {
    const a = req.actor, p = parsePlan(req.body || {});
    if (!p) throw new HttpError(400, "invalid_plan");
    if (p.gaps) return { status: 400, body: { error: "plan_incomplete", missing: p.gaps } };
    if (p.teamId && !await myTeam(c, a, p.teamId)) throw new HttpError(403, "not_your_team");
    const row = await one(c, `INSERT INTO coaching_plans(district_id,owner_user_id,kind,title,sport,level,body,team_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [a.districtId, a.userId, req.body.kind, p.title, p.sport, p.level, p.body, p.teamId]);
    await audit(c, req, "create", "coaching_plan", row.id, `kind=${row.kind};items=${p.body.items.length}`);
    return planOut(row);
  }, 201));

  app.put("/api/coaching/plans/:id", ...write, run(async (c, req) => {
    const a = req.actor, b = req.body || {};
    if (!validId(req.params.id) || !Number.isInteger(b.baseVersion)) throw new HttpError(400, "invalid_plan");
    const p = parsePlan(b, { partial: true });
    if (!p) throw new HttpError(400, "invalid_plan");
    if (p.gaps) return { status: 400, body: { error: "plan_incomplete", missing: p.gaps } };
    const cur = await one(c, `SELECT id,version,team_id FROM coaching_plans WHERE id=$1 AND archived_at IS NULL FOR UPDATE`, [req.params.id]);
    if (!cur) throw new HttpError(404, "plan_not_found");
    if (cur.version !== b.baseVersion) return { status: 409, body: { error: "plan_changed", version: cur.version } };
    if (p.teamId && p.teamId !== cur.team_id && !await myTeam(c, a, p.teamId)) throw new HttpError(403, "not_your_team");
    const row = await one(c, `UPDATE coaching_plans SET title=$2,sport=$3,level=$4,body=$5,team_id=$6,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
      [cur.id, p.title, p.sport, p.level, p.body, p.teamId]);
    await audit(c, req, "update", "coaching_plan", row.id, `version=${row.version}`);
    return planOut(row);
  }));

  app.post("/api/coaching/plans/:id/archive", ...write, run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const row = await one(c, `UPDATE coaching_plans SET archived_at=now(),updated_at=now() WHERE id=$1 AND archived_at IS NULL RETURNING id`, [req.params.id]);
    if (!row) throw new HttpError(404, "plan_not_found");
    await audit(c, req, "archive", "coaching_plan", row.id, null);
    return { archived: true };
  }));

  app.post("/api/coaching/plans/:id/share", ...write, run(async (c, req) => {
    const { summary = null, confirmNotStudents = false } = req.body || {};
    if (!validId(req.params.id) || (summary !== null && !cleanText(summary, 500)) || typeof confirmNotStudents !== "boolean") throw new HttpError(400, "invalid_share");
    const p = await one(c, `SELECT * FROM coaching_plans WHERE id=$1 AND archived_at IS NULL`, [req.params.id]);
    if (!p) throw new HttpError(404, "plan_not_found");
    const words = await studentWordsIn(c, req.actor.districtId, [summary, planText(p.title, p.body)].filter(Boolean).join("\n"));
    if (words.length && !confirmNotStudents) return { status: 409, body: { error: "may_mention_students", words } };
    return publish(c, req, { kind: p.kind, sourceId: p.id, src: { title: p.title, subject: p.sport, grade: p.level, body: { title: p.title, sport: p.sport, ...p.body } },
      summary, confirmed: words.length > 0 });
  }));

  app.get("/api/coaching/library", ...read, run(async (c, req) => {
    const str = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
    const q = str(req.query.q, 80).replace(/[%_\\]/g, "\\$&"), sport = str(req.query.sport, 40);
    return rows(c, `SELECT m.id,m.kind,m.title,m.subject AS sport,m.grade_level AS level,m.summary,m.version,m.updated_at,m.body,
        u.display_name AS author,s.name AS school,m.author_user_id=$1 AS mine,eduos_material_copies(m.id) AS copies
      FROM shared_materials m JOIN users u ON u.id=m.author_user_id JOIN schools s ON s.id=m.school_id
     WHERE m.status='shared' AND m.kind IN ('practice','playbook') AND ($2='' OR m.title ILIKE '%'||$2||'%' OR m.summary ILIKE '%'||$2||'%')
       AND ($3='' OR m.subject ILIKE $3) ORDER BY m.updated_at DESC LIMIT 200`, [req.actor.userId, q, sport]);
  }));

  app.post("/api/coaching/library/:id/copy", ...write, run(async (c, req) => {
    const a = req.actor;
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const m = await one(c, `SELECT id,kind,title,subject,grade_level,body,version FROM shared_materials WHERE id=$1 AND status='shared' AND kind IN ('practice','playbook')`, [req.params.id]);
    if (!m) throw new HttpError(404, "material_not_found");
    const body = cleanPlanBody(m.body);
    if (!body) throw new HttpError(409, "material_unreadable");
    const row = await one(c, `INSERT INTO coaching_plans(district_id,owner_user_id,kind,title,sport,level,body,adapted_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [a.districtId, a.userId, m.kind, m.title, m.subject, m.grade_level, body, m.id]);
    await c.query(`INSERT INTO shared_material_copies(district_id,material_id,version,copied_by,course_id,created_id) VALUES($1,$2,$3,$4,NULL,$5)`,
      [a.districtId, m.id, m.version, a.userId, row.id]);
    await audit(c, req, "copy", "shared_material", m.id, `kind=${m.kind};into=coaching_plan`);
    return planOut(row);
  }, 201));
}
