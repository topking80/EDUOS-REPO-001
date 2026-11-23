// SPORTS-01: MaxPreps and Hudl by link and by file, with family opt-in (db/115).
//
//   GET  /api/activities/:id/links              the team's MaxPreps / Hudl pages (anyone at the school)
//   PUT  /api/activities/:id/links/:service     the team's coaches or school leaders: {url}
//   POST /api/activities/:id/links/:service/remove
//   GET  /api/family/sports-sharing             a family: each child's opt-ins
//   PUT  /api/family/sports-sharing/:studentId  {maxpreps: bool, hudl: bool}
//   GET  /api/activities/:id/exports            the team's managers: who's in a roster file for each service, and the log
//   GET  /api/activities/:id/exports/:service/:kind.csv   roster (opted-in athletes only) or schedule
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, HttpError, sendError } from "./role-app-util.js";
import { SERVICES, SERVICE_NAME, serviceLink, csv, splitName } from "./sports-sharing.js";

const SCHOOL_ROLES = ["pupil", "parent", "teacher", "coach", "principal", "vice_principal", "superintendent"];
const ymd = d => d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

export function registerSportsSharingRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { sendError(res, next, e); }
  };
  const team = async (c, req, manage) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const a = await one(c, `SELECT a.id,a.school_id,a.title,a.kind,eduos_manages_team(a.id) AS manages FROM school_activities a WHERE a.id=$1`, [req.params.id]);
    if (!a || (req.actor.role !== "superintendent" && a.school_id !== req.actor.schoolId && !a.manages)) throw new HttpError(404, "activity_not_found");
    if (manage && !a.manages) throw new HttpError(403, "team_managers_only");
    return a;
  };

  // ---------- links ----------
  app.get("/api/activities/:id/links", requireSession, only(SCHOOL_ROLES), run(async (c, req) => {
    const a = await team(c, req, false);
    return (await rows(c, `SELECT service,url,added_at FROM activity_external_links WHERE activity_id=$1 AND removed_at IS NULL ORDER BY service`, [a.id]))
      .map(l => ({ service: l.service, name: SERVICE_NAME[l.service], url: l.url }));
  }));

  app.put("/api/activities/:id/links/:service", limiter, requireSession, requireCsrf, only(["teacher", "coach", "principal", "vice_principal"]), run(async (c, req) => {
    const a = await team(c, req, true);
    const url = serviceLink(req.params.service, req.body?.url);
    if (!url) throw new HttpError(400, "link_must_be_on_that_service");
    await c.query(`UPDATE activity_external_links SET removed_at=now() WHERE activity_id=$1 AND service=$2 AND removed_at IS NULL`, [a.id, req.params.service]);
    await c.query(`INSERT INTO activity_external_links(district_id,school_id,activity_id,service,url,added_by) VALUES($1,$2,$3,$4,$5,$6)`,
      [req.actor.districtId, a.school_id, a.id, req.params.service, url, req.actor.userId]);
    await audit(c, req, "update", "activity_link", a.id, req.params.service);
    return { service: req.params.service, url };
  }));

  app.post("/api/activities/:id/links/:service/remove", limiter, requireSession, requireCsrf, only(["teacher", "coach", "principal", "vice_principal"]), run(async (c, req) => {
    const a = await team(c, req, true);
    const r = await one(c, `UPDATE activity_external_links SET removed_at=now() WHERE activity_id=$1 AND service=$2 AND removed_at IS NULL RETURNING id`, [a.id, req.params.service]);
    if (!r) throw new HttpError(404, "link_not_found");
    await audit(c, req, "remove", "activity_link", a.id, req.params.service);
    return { removed: true };
  }));

  // ---------- family opt-in ----------
  app.get("/api/family/sports-sharing", requireSession, only(["parent"]), run(async (c, req) => {
    const kids = await rows(c, `SELECT DISTINCT s.id,s.display_name AS name,s.school_id FROM student_user_links l JOIN students s ON s.id=l.student_id
        WHERE l.user_id=$1 AND l.relationship IN ('parent','guardian') AND l.status='active' ORDER BY s.display_name`, [req.actor.userId]);
    const consents = kids.length ? await rows(c, `SELECT k.student_id,k.service,k.granted_at,u.display_name AS by FROM athlete_sharing_consents k JOIN users u ON u.id=k.granted_by
        WHERE k.student_id = ANY($1) AND k.revoked_at IS NULL`, [kids.map(k => k.id)]) : [];
    const teams = kids.length ? await rows(c, `SELECT r.student_id,a.title FROM activity_roster_entries r JOIN school_activities a ON a.id=r.activity_id WHERE r.student_id = ANY($1) AND r.status='active' AND a.kind='sport'`, [kids.map(k => k.id)]) : [];
    return kids.map(k => ({ studentId: k.id, name: k.name, teams: teams.filter(t => t.student_id === k.id).map(t => t.title),
      ...Object.fromEntries(SERVICES.map(sv => { const g = consents.find(x => x.student_id === k.id && x.service === sv); return [sv, g ? { since: g.granted_at, by: g.by } : null]; })) }));
  }));

  app.put("/api/family/sports-sharing/:studentId", limiter, requireSession, requireCsrf, only(["parent"]), run(async (c, req) => {
    const sid = req.params.studentId, b = req.body || {};
    if (!validId(sid) || !SERVICES.some(sv => typeof b[sv] === "boolean")) throw new HttpError(400, "invalid_choice");
    const kid = await one(c, `SELECT s.id,s.school_id FROM students s WHERE s.id=$1 AND eduos_is_family_of(s.id)`, [sid]);
    if (!kid) throw new HttpError(404, "student_not_found");
    for (const sv of SERVICES) {
      if (typeof b[sv] !== "boolean") continue;
      const open = await one(c, `SELECT id FROM athlete_sharing_consents WHERE student_id=$1 AND service=$2 AND revoked_at IS NULL`, [sid, sv]);
      if (b[sv] && !open) await c.query(`INSERT INTO athlete_sharing_consents(district_id,school_id,student_id,service,granted_by) VALUES($1,$2,$3,$4,$5)`, [req.actor.districtId, kid.school_id, sid, sv, req.actor.userId]);
      if (!b[sv] && open) await c.query(`UPDATE athlete_sharing_consents SET revoked_at=now(),revoked_by=$2 WHERE id=$1`, [open.id, req.actor.userId]);
      if (b[sv] !== Boolean(open)) await audit(c, req, b[sv] ? "grant" : "revoke", "athlete_sharing", sid, sv);
    }
    return { saved: true };
  }));

  // ---------- exports ----------
  const roster = (c, activityId, service) => rows(c, `SELECT s.id,s.display_name AS name,s.grade_level AS grade,r.jersey_number AS jersey,r.position,
      EXISTS (SELECT 1 FROM athlete_sharing_consents k WHERE k.student_id=s.id AND k.service=$2 AND k.revoked_at IS NULL) AS shared
      FROM activity_roster_entries r JOIN students s ON s.id=r.student_id WHERE r.activity_id=$1 AND r.status='active' ORDER BY r.jersey_number NULLS LAST,s.display_name`, [activityId, service]);

  app.get("/api/activities/:id/exports", requireSession, only(["teacher", "coach", "principal", "vice_principal"]), run(async (c, req) => {
    const a = await team(c, req, true);
    const services = {};
    for (const sv of SERVICES) { const r = await roster(c, a.id, sv); services[sv] = { included: r.filter(x => x.shared).length, withheld: r.filter(x => !x.shared).length }; }
    const log = await rows(c, `SELECT e.service,e.kind,e.included,e.withheld,e.exported_at,u.display_name AS by FROM sports_exports e JOIN users u ON u.id=e.exported_by
        WHERE e.activity_id=$1 ORDER BY e.exported_at DESC LIMIT 20`, [a.id]);
    return { team: a.title, services, log: log.map(l => ({ service: l.service, kind: l.kind, included: l.included, withheld: l.withheld, at: l.exported_at, by: l.by })) };
  }));

  app.get("/api/activities/:id/exports/:service/:file", requireSession, only(["teacher", "coach", "principal", "vice_principal"]), async (req, res, next) => {
    const { service, file } = req.params, kind = file === "roster.csv" ? "roster" : file === "schedule.csv" ? "schedule" : null;
    if (!SERVICES.includes(service) || !kind) return res.status(404).json({ error: "not_found" });
    try {
      const out = await withTenantTransaction(req.actor, async c => {
        const a = await team(c, req, true);
        let body, included, withheld = 0;
        if (kind === "roster") {
          const r = await roster(c, a.id, service);
          const shared = r.filter(x => x.shared);
          included = shared.length; withheld = r.length - shared.length;
          body = csv(["Jersey", "First Name", "Last Name", "Grade", "Position"], shared.map(x => { const [first, last] = splitName(x.name); return [x.jersey ?? "", first, last, x.grade ?? "", x.position || ""]; }));
        } else {
          const ev = await rows(c, `SELECT e.starts_at,e.title,e.venue,e.status,r.opponent,r.home_score,r.away_score FROM school_events e
              LEFT JOIN activity_event_results r ON r.event_id=e.id AND r.status='published' WHERE e.activity_id=$1 AND e.status IN ('published','completed') ORDER BY e.starts_at`, [a.id]);
          included = ev.length;
          body = csv(["Date", "Time", "Event", "Opponent", "Venue", "Home Score", "Away Score"], ev.map(e => [ymd(e.starts_at), new Date(e.starts_at).toISOString().slice(11, 16) + " UTC",
            e.title, e.opponent ?? "", e.venue || "", e.home_score ?? "", e.away_score ?? ""]));
        }
        await c.query(`INSERT INTO sports_exports(district_id,school_id,activity_id,service,kind,included,withheld,exported_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [req.actor.districtId, a.school_id, a.id, service, kind, included, withheld, req.actor.userId]);
        await audit(c, req, "export", "sports_" + kind, a.id, `${service} included=${included} withheld=${withheld}`);
        return { body, withheld, name: `${a.title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "team"}-${service}-${kind}.csv` };
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${out.name}"`);
      res.setHeader("X-Withheld-Count", String(out.withheld));
      res.send(out.body);
    } catch (e) { sendError(res, next, e); }
  });
}
