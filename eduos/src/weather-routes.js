// SAFE-04: National Weather Service prompts (db/124, src/weather-alerts.js).
//
//   GET  /api/safety/weather                      setting, school locations, active alerts, pass-on flags
//   PUT  /api/safety/weather/settings {enabled}    superintendent
//   PUT  /api/safety/weather/share {schoolId, passOn}  principal / VP / superintendent
//   PUT  /api/safety/weather/points {schoolId, lat, lon} | {schoolId, clear: true}
//   POST /api/safety/weather/:id/dismiss {note}    a warning's prompt, with a reason
//   POST /api/safety/weather/:id/started {incidentId}  the alert someone started from it
//
// The principal (a vice principal acts as one) works their own school; the
// superintendent the district. Nothing here starts an alert.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { HAZARD_KIND, HAZARD_LABEL } from "./safety-model.js";
import { config } from "./config.js";

const LEADS = ["principal", "superintendent"];
export const alertOut = a => ({ id: a.id, schoolId: a.school_id, school: a.school, event: a.event, level: a.level, hazard: a.hazard,
  hazardLabel: a.hazard ? HAZARD_LABEL[a.hazard] : null, suggestedKind: a.hazard ? HAZARD_KIND[a.hazard] : null,
  severity: a.severity, headline: a.headline, area: a.area, instruction: a.instruction, onset: a.onset, expires: a.expires,
  firstSeenAt: a.first_seen_at, decision: a.decision, decidedBy: a.decided_by_name || null, decidedAt: a.decided_at, note: a.decision_note, incidentId: a.incident_id,
  prompt: a.level === "warning" && Boolean(a.hazard) && !a.decision });
export const ACTIVE_ALERTS = `SELECT a.*,s.name AS school,u.display_name AS decided_by_name FROM school_weather_alerts a JOIN schools s ON s.id=a.school_id
  LEFT JOIN users u ON u.id=a.decided_by
  WHERE a.ended_at IS NULL AND (a.expires IS NULL OR a.expires > now()) AND ($1::uuid IS NULL OR a.school_id=$1)
  ORDER BY (a.level='warning') DESC, a.first_seen_at DESC LIMIT 50`;

export function registerWeatherRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const lead = (req, res, next) => LEADS.includes(req.actor?.role) ? next() : res.status(403).json({ error: "role_not_allowed" });
  const scopeOf = a => a.role === "superintendent" ? null : a.schoolId;
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { sendError(res, next, e); }
  };

  app.get("/api/safety/weather", requireSession, requirePermission("safety", "read"), lead, run(async (c, req) => {
    const a = req.actor;
    const setting = await one(c, `SELECT enabled FROM district_weather_settings WHERE district_id=$1`, [a.districtId]);
    const schools = await rows(c, `SELECT s.id,s.name,p.lat,p.lon FROM schools s LEFT JOIN school_weather_points p ON p.school_id=s.id
        WHERE s.status='active' AND ($1::uuid IS NULL OR s.id=$1) ORDER BY s.name`, [scopeOf(a)]);
    const shares = await rows(c, `SELECT school_id,pass_on FROM school_weather_share_settings WHERE ($1::uuid IS NULL OR school_id=$1)`, [scopeOf(a)]);
    const passOnBy = Object.fromEntries(shares.map(s => [s.school_id, s.pass_on]));
    const alerts = await rows(c, ACTIVE_ALERTS, [scopeOf(a)]);
    return { enabled: Boolean(setting?.enabled), running: Boolean(config.weatherAlertsUserAgent), canToggle: a.role === "superintendent",
      canPassOn: ["principal", "vice_principal", "superintendent"].includes(a.role),
      schools: schools.map(s => ({ id: s.id, name: s.name, lat: s.lat === null ? null : Number(s.lat), lon: s.lon === null ? null : Number(s.lon), passOn: Boolean(passOnBy[s.id]) })),
      alerts: alerts.map(alertOut) };
  }));

  app.put("/api/safety/weather/settings", limiter, requireSession, requireCsrf, (req, res, next) => req.actor.role === "superintendent" ? next() : res.status(403).json({ error: "superintendent_only" }),
    run(async (c, req) => {
      if (typeof req.body?.enabled !== "boolean") throw new HttpError(400, "invalid_setting");
      await c.query(`INSERT INTO district_weather_settings(district_id,enabled,set_by) VALUES($1,$2,$3)
          ON CONFLICT (district_id) DO UPDATE SET enabled=EXCLUDED.enabled,set_by=EXCLUDED.set_by,set_at=now()`, [req.actor.districtId, req.body.enabled, req.actor.userId]);
      await audit(c, req, req.body.enabled ? "enable" : "disable", "weather_alerts", req.actor.districtId);
      return { enabled: req.body.enabled };
    }));

  app.put("/api/safety/weather/share", limiter, requireSession, requireCsrf,
    (req, res, next) => ["principal", "vice_principal", "superintendent"].includes(req.actor?.role) ? next() : res.status(403).json({ error: "role_not_allowed" }),
    run(async (c, req) => {
      const a = req.actor, { schoolId, passOn } = req.body || {};
      if (typeof passOn !== "boolean" || !validId(schoolId)) throw new HttpError(400, "invalid_setting");
      if (a.role !== "superintendent" && schoolId !== a.schoolId) throw new HttpError(404, "school_not_found");
      if (!(await one(c, `SELECT id FROM schools WHERE id=$1`, [schoolId]))) throw new HttpError(404, "school_not_found");
      await c.query(`INSERT INTO school_weather_share_settings(school_id,district_id,pass_on,set_by) VALUES($1,$2,$3,$4)
          ON CONFLICT (school_id) DO UPDATE SET pass_on=EXCLUDED.pass_on,set_by=EXCLUDED.set_by,set_at=now()`, [schoolId, a.districtId, passOn, a.userId]);
      await audit(c, req, passOn ? "enable" : "disable", "weather_pass_on", schoolId);
      return { schoolId, passOn };
    }));

  app.put("/api/safety/weather/points", limiter, requireSession, requireCsrf, lead, run(async (c, req) => {
    const a = req.actor, { schoolId, lat, lon, clear = false } = req.body || {};
    if (!validId(schoolId) || (a.role !== "superintendent" && schoolId !== a.schoolId)) throw new HttpError(404, "school_not_found");
    if (!(await one(c, `SELECT id FROM schools WHERE id=$1`, [schoolId]))) throw new HttpError(404, "school_not_found");
    if (clear === true) {
      await c.query(`DELETE FROM school_weather_points WHERE school_id=$1`, [schoolId]);
      await audit(c, req, "clear", "weather_point", schoolId);
      return { schoolId, lat: null, lon: null };
    }
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) throw new HttpError(400, "invalid_location");
    const r = Math.round(la * 1e4) / 1e4, s = Math.round(lo * 1e4) / 1e4;
    await c.query(`INSERT INTO school_weather_points(school_id,district_id,lat,lon,set_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (school_id) DO UPDATE SET lat=EXCLUDED.lat,lon=EXCLUDED.lon,set_by=EXCLUDED.set_by,set_at=now()`, [schoolId, a.districtId, r, s, a.userId]);
    await audit(c, req, "set", "weather_point", schoolId);
    return { schoolId, lat: r, lon: s };
  }));

  const alertFor = async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const x = await one(c, `SELECT * FROM school_weather_alerts WHERE id=$1`, [req.params.id]);
    if (!x || (req.actor.role !== "superintendent" && x.school_id !== req.actor.schoolId)) throw new HttpError(404, "alert_not_found");
    if (x.decision) throw new HttpError(409, "already_decided");
    if (x.ended_at || (x.expires && new Date(x.expires).getTime() <= Date.now()))
      throw new HttpError(410, "alert_no_longer_active");
    return x;
  };

  // The preflight above gives a useful error, but it is not a concurrency
  // control. Claim the decision with one conditional UPDATE so two leaders
  // cannot both act on the same warning.
  const claimDecision = async (c, id, values) => {
    const changed = await c.query(
      `UPDATE school_weather_alerts
          SET decision=$2,decided_by=$3,decided_at=now(),decision_note=$4,incident_id=$5
        WHERE id=$1 AND decision IS NULL AND ended_at IS NULL
          AND (expires IS NULL OR expires > now())
        RETURNING id`,
      [id, values.decision, values.userId, values.note ?? null, values.incidentId ?? null]);
    if (changed.rowCount) return;
    const current = await one(c, `SELECT decision,ended_at,expires FROM school_weather_alerts WHERE id=$1`, [id]);
    if (!current) throw new HttpError(404, "alert_not_found");
    if (current.decision) throw new HttpError(409, "already_decided");
    throw new HttpError(410, "alert_no_longer_active");
  };

  app.post("/api/safety/weather/:id/dismiss", limiter, requireSession, requireCsrf, lead, run(async (c, req) => {
    const note = req.body?.note;
    if (!cleanText(note, 300, 3)) throw new HttpError(400, "note_required");
    const x = await alertFor(c, req);
    await claimDecision(c, x.id, { decision: "dismissed", userId: req.actor.userId, note: note.trim() });
    await audit(c, req, "dismiss", "weather_alert", x.id, `${x.event}: ${note.trim()}`.slice(0, 300));
    return { id: x.id, decision: "dismissed" };
  }));

  app.post("/api/safety/weather/:id/started", limiter, requireSession, requireCsrf, lead, run(async (c, req) => {
    const x = await alertFor(c, req);
    const incidentId = req.body?.incidentId;
    if (!validId(incidentId)) throw new HttpError(400, "invalid_incident_id");
    const i = await one(c, `SELECT id,school_id,hazard,status FROM safety_incidents WHERE id=$1`, [incidentId]);
    if (!i || i.school_id !== x.school_id || i.hazard !== x.hazard || !["pending", "active", "reunification"].includes(i.status)) throw new HttpError(400, "incident_does_not_match");
    await claimDecision(c, x.id, { decision: "started", userId: req.actor.userId, incidentId: i.id });
    await audit(c, req, "start_from_weather", "weather_alert", x.id, i.id);
    return { id: x.id, decision: "started", incidentId: i.id };
  }));
}
