// SPORTS-02: MaxPreps / Hudl connectors with the school's own account (db/116,
// src/sports-connector.js, docs/SPORTS-CONNECTORS.md).
//
// The school's sports leads (principal, vice principal, athletic director); district IT decides:
//   GET  /api/sports/connectors
//   POST /api/sports/connectors              {service, baseUrl, key, sendRoster, sendSchedule, pullResults, pullFilm}
//   PUT  /api/sports/connectors/:id          change the key / site / what it does (needs approving again)
//   POST /api/sports/connectors/:id/decision IT: {decision, note}
//   POST /api/sports/connectors/:id/pause | resume | revoke
// The team's coaches (and the school's leaders):
//   PUT  /api/activities/:id/connectors/:service/team   {externalTeamId}
//   POST /api/activities/:id/connectors/:service/sync   run what the connector is approved to do
//   GET  /api/activities/:id/connectors                 connectors for this team, runs, results waiting, film
//   POST /api/sports/inbound/:id/decision               {decision}: approving makes a draft result
//   POST /api/sports/film/:id/hide
// Everyone at the school:
//   GET  /api/activities/:id/film
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { encryptSecret, decryptSecret } from "./integrations/secrets.js";
import { SERVICES, SERVICE_NAME, splitName } from "./sports-sharing.js";
import { connectorBase } from "./sports-connector.js";
import { ADAPTERS } from "./sports-adapters/index.js";

const ACTIONS = [["sendRoster", "send_roster"], ["sendSchedule", "send_schedule"], ["pullResults", "pull_results"], ["pullFilm", "pull_film"]];
const ymd = d => d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
const connOut = k => ({ id: k.id, schoolId: k.school_id, school: k.school, service: k.service, name: SERVICE_NAME[k.service], baseUrl: k.base_url, keyHint: `…${k.key_hint}`,
  sendRoster: k.send_roster, sendSchedule: k.send_schedule, pullResults: k.pull_results, pullFilm: k.pull_film, status: k.status,
  requestedBy: k.requester, requestedAt: k.requested_at, decidedBy: k.decider, decidedAt: k.decided_at, note: k.decision_note });

export function registerSportsConnectorRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const syncLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `sync:${req.actor?.userId}` });
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { if (e.code === "23505") return res.status(409).json({ error: "already_exists" }); sendError(res, next, e); }
  };
  const LEADS = ["principal", "vice_principal", "teacher"]; // teachers only as the school's athletic director (checked in SQL)
  const isLead = async (c, schoolId) => (await one(c, `SELECT eduos_sports_lead($1) AS ok`, [schoolId])).ok;
  const parse = b => {
    const flags = Object.fromEntries(ACTIONS.map(([k]) => [k, b[k] === true]));
    if (!SERVICES.includes(b.service) || !Object.values(flags).some(Boolean) || (flags.pullFilm && b.service !== "hudl")) return null;
    const base = connectorBase(b.service, b.baseUrl);
    if (!base || typeof b.key !== "string" || b.key.trim().length < 8 || b.key.length > 4000) return null;
    return { service: b.service, base, key: b.key.trim(), ...flags };
  };
  const loadConn = async (c, id) => {
    if (!validId(id)) throw new HttpError(400, "invalid_id");
    const k = await one(c, `SELECT k.*,s.name AS school,r.display_name AS requester,d.display_name AS decider FROM sports_connectors k JOIN schools s ON s.id=k.school_id
        JOIN users r ON r.id=k.requested_by LEFT JOIN users d ON d.id=k.decided_by WHERE k.id=$1`, [id]);
    if (!k) throw new HttpError(404, "connector_not_found");
    return k;
  };

  // ---------- connectors ----------
  app.get("/api/sports/connectors", requireSession, only([...LEADS, "it_admin", "superintendent"]), run(async (c, req) =>
    (await rows(c, `SELECT k.*,s.name AS school,r.display_name AS requester,d.display_name AS decider FROM sports_connectors k JOIN schools s ON s.id=k.school_id
       JOIN users r ON r.id=k.requested_by LEFT JOIN users d ON d.id=k.decided_by WHERE k.status<>'revoked' AND ($1<>'teacher' OR eduos_sports_lead(k.school_id))
       ORDER BY (k.status='pending') DESC,s.name,k.service`, [req.actor.role])).map(connOut)));

  app.post("/api/sports/connectors", limiter, requireSession, requireCsrf, only(LEADS), run(async (c, req) => {
    if (!config.integrationsKey) throw new HttpError(409, "connectors_need_integrations_key");
    if (!(await isLead(c, req.actor.schoolId))) throw new HttpError(403, "sports_leads_only");
    const v = parse(req.body || {});
    if (!v) throw new HttpError(400, "invalid_connector");
    const id = crypto.randomUUID();
    await c.query(`INSERT INTO sports_connectors(id,district_id,school_id,service,base_url,secret_enc,key_hint,send_roster,send_schedule,pull_results,pull_film,requested_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, req.actor.districtId, req.actor.schoolId, v.service, v.base,
      encryptSecret(config.integrationsKey, req.actor.districtId, id, v.key), v.key.slice(-4), v.sendRoster, v.sendSchedule, v.pullResults, v.pullFilm, req.actor.userId]);
    await audit(c, req, "create", "sports_connector", id, v.service);
    return connOut(await loadConn(c, id));
  }, 201));

  app.put("/api/sports/connectors/:id", limiter, requireSession, requireCsrf, only(LEADS), run(async (c, req) => {
    const k = await loadConn(c, req.params.id);
    if (!(await isLead(c, k.school_id))) throw new HttpError(403, "sports_leads_only");
    const v = parse({ ...req.body, service: k.service, key: req.body?.key || "keep-the-current-key" });
    if (!v) throw new HttpError(400, "invalid_connector");
    const secret = req.body?.key ? encryptSecret(config.integrationsKey, k.district_id, k.id, v.key) : k.secret_enc;
    await c.query(`UPDATE sports_connectors SET base_url=$2,secret_enc=$3,key_hint=$4,send_roster=$5,send_schedule=$6,pull_results=$7,pull_film=$8 WHERE id=$1`,
      [k.id, v.base, secret, req.body?.key ? v.key.slice(-4) : k.key_hint, v.sendRoster, v.sendSchedule, v.pullResults, v.pullFilm]);
    await audit(c, req, "update", "sports_connector", k.id, req.body?.key ? "key changed" : "settings");
    return connOut(await loadConn(c, k.id));
  }));

  app.post("/api/sports/connectors/:id/decision", limiter, requireSession, requireCsrf, only(["it_admin"]), run(async (c, req) => {
    const { decision, note = null } = req.body || {};
    if (!["approved", "rejected"].includes(decision) || (note != null && note !== "" && !cleanText(note, 500))) throw new HttpError(400, "invalid_decision");
    const k = await loadConn(c, req.params.id);
    if (k.status !== "pending") throw new HttpError(409, "not_waiting");
    await c.query(`UPDATE sports_connectors SET status=$2,decided_by=$3,decided_at=now(),decision_note=$4 WHERE id=$1`, [k.id, decision, req.actor.userId, note?.trim() || null]);
    await audit(c, req, "decide", "sports_connector", k.id, decision);
    return connOut(await loadConn(c, k.id));
  }));

  for (const [verb, from, to] of [["pause", ["approved"], "paused"], ["resume", ["paused"], "approved"], ["revoke", ["pending", "approved", "paused", "rejected"], "revoked"]]) {
    app.post(`/api/sports/connectors/:id/${verb}`, limiter, requireSession, requireCsrf, only([...LEADS, "it_admin"]), run(async (c, req) => {
      const k = await loadConn(c, req.params.id);
      if (req.actor.role !== "it_admin" && !(await isLead(c, k.school_id))) throw new HttpError(403, "sports_leads_only");
      if (!from.includes(k.status)) throw new HttpError(409, `cannot_${verb}`);
      await c.query(`UPDATE sports_connectors SET status=$2 WHERE id=$1`, [k.id, to]);
      await audit(c, req, verb, "sports_connector", k.id, null);
      return { status: to };
    }));
  }

  // ---------- teams ----------
  const team = async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const a = await one(c, `SELECT id,school_id,title FROM school_activities WHERE id=$1 AND kind='sport' AND eduos_manages_team(id)`, [req.params.id]);
    if (!a) throw new HttpError(404, "team_not_found");
    return a;
  };
  const connFor = (c, a, service) => one(c, `SELECT k.*,t.external_team_id FROM sports_connectors k LEFT JOIN sports_connector_teams t ON t.connector_id=k.id AND t.activity_id=$2
      WHERE k.school_id=$1 AND k.service=$3 AND k.status<>'revoked'`, [a.school_id, a.id, service]);

  app.put("/api/activities/:id/connectors/:service/team", limiter, requireSession, requireCsrf, run(async (c, req) => {
    const a = await team(c, req);
    const ext = req.body?.externalTeamId;
    if (!SERVICES.includes(req.params.service) || typeof ext !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(ext)) throw new HttpError(400, "invalid_team_id");
    const k = await connFor(c, a, req.params.service);
    if (!k) throw new HttpError(404, "connector_not_set_up");
    await c.query(`INSERT INTO sports_connector_teams(connector_id,district_id,activity_id,external_team_id,set_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(connector_id,activity_id) DO UPDATE SET external_team_id=EXCLUDED.external_team_id,set_by=EXCLUDED.set_by,set_at=now()`, [k.id, req.actor.districtId, a.id, ext, req.actor.userId]);
    await audit(c, req, "update", "sports_connector_team", a.id, req.params.service);
    return { externalTeamId: ext };
  }));

  app.post("/api/activities/:id/connectors/:service/sync", requireSession, syncLimiter, requireCsrf, run(async (c, req) => {
    const a = await team(c, req), service = req.params.service;
    if (!SERVICES.includes(service)) throw new HttpError(404, "not_found");
    const k = await connFor(c, a, service);
    if (!k) throw new HttpError(404, "connector_not_set_up");
    if (k.status !== "approved") throw new HttpError(409, "connector_not_approved");
    if (!k.external_team_id) throw new HttpError(409, "team_not_linked");
    const base = connectorBase(service, k.base_url);
    if (!base) throw new HttpError(409, "connector_site_not_allowed");
    const key = decryptSecret(config.integrationsKey, k.district_id, k.id, k.secret_enc);
    const { sendRoster, sendSchedule, pullResults, pullFilm } = ADAPTERS[service];
    const results = [];
    const log = (action, ok, count, withheld, message, offered = true) => {
      results.push({ action, ok, count, withheld, message, offered });
      return c.query(`INSERT INTO sports_connector_runs(district_id,connector_id,activity_id,action,ok,count,withheld,message,run_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.actor.districtId, k.id, a.id, action, ok, count, withheld, message?.slice(0, 300) || null, req.actor.userId]);
    };
    const events = await rows(c, `SELECT e.id,e.starts_at,e.title,e.venue,r.opponent,r.home_score,r.away_score FROM school_events e
        LEFT JOIN activity_event_results r ON r.event_id=e.id AND r.status='published' WHERE e.activity_id=$1 AND e.status IN ('published','completed') ORDER BY e.starts_at`, [a.id]);
    if (k.send_roster) {
      const roster = await rows(c, `SELECT s.display_name AS name,s.grade_level AS grade,r.jersey_number AS jersey,r.position,
          EXISTS (SELECT 1 FROM athlete_sharing_consents x WHERE x.student_id=s.id AND x.service=$2 AND x.revoked_at IS NULL) AS shared
          FROM activity_roster_entries r JOIN students s ON s.id=r.student_id WHERE r.activity_id=$1 AND r.status='active'`, [a.id, service]);
      const shared = roster.filter(r => r.shared);
      try {
        await sendRoster(base, key, k.external_team_id, shared.map(r => { const [firstName, lastName] = splitName(r.name); return { jersey: r.jersey, firstName, lastName, grade: r.grade, position: r.position || null }; }));
        await log("send_roster", true, shared.length, roster.length - shared.length, null);
      } catch (e) { await log("send_roster", false, 0, roster.length - shared.length, e.message, e.code !== "not_offered"); }
    }
    if (k.send_schedule) {
      try {
        await sendSchedule(base, key, k.external_team_id, events.map(e => ({ ref: e.id, date: ymd(e.starts_at), startsAt: new Date(e.starts_at).toISOString(), title: e.title,
          opponent: e.opponent ?? null, venue: e.venue || null, homeScore: e.home_score ?? null, awayScore: e.away_score ?? null })));
        await log("send_schedule", true, events.length, 0, null);
      } catch (e) { await log("send_schedule", false, 0, 0, e.message, e.code !== "not_offered"); }
    }
    if (k.pull_results) {
      try {
        const got = await pullResults(base, key, k.external_team_id);
        let added = 0;
        for (const r of got) {
          const ev = events.find(e => e.id === r.ref);
          if (!ev || ev.home_score != null) continue; // ours, and not already published
          const ins = await c.query(`INSERT INTO sports_inbound_results(district_id,connector_id,activity_id,event_id,opponent,home_score,away_score,team_stats) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
              ON CONFLICT DO NOTHING`, [req.actor.districtId, k.id, a.id, ev.id, r.opponent, r.homeScore, r.awayScore, r.teamStats]);
          added += ins.rowCount;
        }
        await log("pull_results", true, added, 0, null);
      } catch (e) { await log("pull_results", false, 0, 0, e.message, e.code !== "not_offered"); }
    }
    if (k.pull_film) {
      try {
        const got = await pullFilm(base, key, k.external_team_id);
        let added = 0;
        for (const f of got) {
          const ins = await c.query(`INSERT INTO sports_film_links(district_id,connector_id,activity_id,event_id,title,url) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [req.actor.districtId, k.id, a.id, events.some(e => e.id === f.ref) ? f.ref : null, f.title, f.url]);
          added += ins.rowCount;
        }
        await log("pull_film", true, added, 0, null);
      } catch (e) { await log("pull_film", false, 0, 0, e.message, e.code !== "not_offered"); }
    }
    await audit(c, req, "sync", "sports_connector", k.id, results.map(r => `${r.action}:${r.ok ? r.count : "failed"}`).join(" "));
    return { service, results };
  }));

  app.get("/api/activities/:id/connectors", requireSession, run(async (c, req) => {
    const a = await team(c, req);
    const conns = [];
    for (const sv of SERVICES) {
      const k = await connFor(c, a, sv);
      if (k) conns.push({ service: sv, name: SERVICE_NAME[sv], status: k.status, externalTeamId: k.external_team_id, sendRoster: k.send_roster, sendSchedule: k.send_schedule, pullResults: k.pull_results, pullFilm: k.pull_film });
    }
    const runs = await rows(c, `SELECT r.action,r.ok,r.count,r.withheld,r.message,r.at,k.service,u.display_name AS by FROM sports_connector_runs r JOIN sports_connectors k ON k.id=r.connector_id
        JOIN users u ON u.id=r.run_by WHERE r.activity_id=$1 ORDER BY r.at DESC LIMIT 20`, [a.id]);
    const waiting = await rows(c, `SELECT i.id,i.opponent,i.home_score,i.away_score,i.team_stats,i.received_at,e.title,e.starts_at,k.service FROM sports_inbound_results i
        JOIN school_events e ON e.id=i.event_id JOIN sports_connectors k ON k.id=i.connector_id WHERE i.activity_id=$1 AND i.status='pending' ORDER BY e.starts_at`, [a.id]);
    const film = await rows(c, `SELECT id,title,url,hidden_at FROM sports_film_links WHERE activity_id=$1 ORDER BY received_at DESC LIMIT 100`, [a.id]);
    return { connectors: conns.map(k => ({ ...k, adapter: ADAPTERS[k.service].name })), runs: runs.map(r => ({ service: r.service, action: r.action, ok: r.ok, count: r.count, withheld: r.withheld, message: r.message, at: r.at, by: r.by })),
      waiting: waiting.map(w => ({ id: w.id, service: w.service, event: w.title, date: ymd(w.starts_at), opponent: w.opponent, homeScore: w.home_score, awayScore: w.away_score, teamStats: w.team_stats })),
      film: film.map(f => ({ id: f.id, title: f.title, url: f.url, hidden: Boolean(f.hidden_at) })) };
  }));

  app.post("/api/sports/inbound/:id/decision", limiter, requireSession, requireCsrf, run(async (c, req) => {
    const { decision } = req.body || {};
    if (!validId(req.params.id) || !["approved", "rejected"].includes(decision)) throw new HttpError(400, "invalid_decision");
    const i = await one(c, `SELECT i.*,a.school_id FROM sports_inbound_results i JOIN school_activities a ON a.id=i.activity_id WHERE i.id=$1 AND i.status='pending' AND eduos_manages_team(i.activity_id)`, [req.params.id]);
    if (!i) throw new HttpError(404, "result_not_found");
    if (decision === "approved") {
      if (await one(c, `SELECT 1 FROM activity_event_results WHERE event_id=$1`, [i.event_id])) throw new HttpError(409, "result_already_recorded");
      const stats = Object.entries(i.team_stats || {}).map(([k, v]) => `${k} ${v}`).join(", ");
      // A draft: it's published the usual way, like any result a coach records.
      await c.query(`INSERT INTO activity_event_results(district_id,school_id,activity_id,event_id,opponent,home_score,away_score,summary,status,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9)`,
        [i.district_id, i.school_id, i.activity_id, i.event_id, i.opponent, i.home_score, i.away_score, stats ? `Team stats: ${stats}`.slice(0, 1500) : "", req.actor.userId]);
    }
    await c.query(`UPDATE sports_inbound_results SET status=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$1`, [i.id, decision, req.actor.userId]);
    await audit(c, req, "decide", "sports_inbound_result", i.id, decision);
    return { status: decision };
  }));

  app.post("/api/sports/film/:id/hide", limiter, requireSession, requireCsrf, run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const f = await one(c, `UPDATE sports_film_links SET hidden_at=now(),hidden_by=$2 WHERE id=$1 AND hidden_at IS NULL AND eduos_manages_team(activity_id) RETURNING id`, [req.params.id, req.actor.userId]);
    if (!f) throw new HttpError(404, "film_not_found");
    await audit(c, req, "hide", "sports_film", f.id, null);
    return { hidden: true };
  }));

  app.get("/api/activities/:id/film", requireSession, run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const a = await one(c, `SELECT id,school_id FROM school_activities WHERE id=$1`, [req.params.id]);
    if (!a || (req.actor.role !== "superintendent" && a.school_id !== req.actor.schoolId)) throw new HttpError(404, "activity_not_found");
    return (await rows(c, `SELECT f.title,f.url,e.title AS event FROM sports_film_links f LEFT JOIN school_events e ON e.id=f.event_id WHERE f.activity_id=$1 AND f.hidden_at IS NULL
       ORDER BY f.received_at DESC LIMIT 50`, [a.id])).map(f => ({ title: f.title, url: f.url, event: f.event }));
  }));
}
