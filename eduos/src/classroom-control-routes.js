// DEV-03: controlling a room's devices from the paired teacher's device (db/110).
//
// Teacher (paired with the room now):
//   POST /api/devices/:id/commands {capability, args}
// Teacher (their own) and the school's leaders / IT (all):
//   GET  /api/rooms/:id/commands              recent commands and how they went
// The device (its key, no session):
//   POST /api/classroom-agent/commands         collect waiting commands
//   POST /api/classroom-agent/commands/:id/result {ok, message}
import crypto from "node:crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { pool, withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, HttpError, sendError } from "./role-app-util.js";
import { parseCommand } from "./classroom-command.js";
import { KEY_RE } from "./pairing-routes.js";
import { deviceSafetyView } from "./safety-model.js";

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const keyOf = req => KEY_RE.exec(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
const commandOut = c => ({ id: c.id, deviceId: c.device_id, device: c.device, capability: c.capability, args: c.args, status: c.status,
  by: c.by, createdAt: c.created_at, finishedAt: c.finished_at, result: c.result });

export function registerClassroomControlRoutes(app) {
  // A teacher taps quickly (volume, lights): generous, but bounded.
  const sendLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `cmd:${req.actor?.userId || ipKeyGenerator(req.ip)}` });
  // Devices poll every few seconds.
  const agentLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => { const m = keyOf(req); return m ? `cdk-cmd:${m[1]}` : `cdk-cmd-ip:${ipKeyGenerator(req.ip)}`; } });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { sendError(res, next, e); }
  };

  app.post("/api/devices/:id/commands", requireSession, sendLimiter, requireCsrf, (req, res, next) => req.actor.role === "teacher" ? next() : res.status(403).json({ error: "forbidden" }),
    run(async (c, req) => {
      const { capability, args } = req.body || {};
      const clean = parseCommand(capability, args ?? {});
      if (!validId(req.params.id) || !clean) throw new HttpError(400, "invalid_command");
      // SAFE-02: during a safety alert the room's devices follow the alert, not commands.
      if ((await one(c, `SELECT eduos_safety_live_at($1) AS live`, [req.actor.schoolId])).live) throw new HttpError(409, "paused_for_safety");
      const r = (await one(c, `SELECT eduos_classroom_command($1,$2,$3::jsonb) AS out`, [req.params.id, capability, JSON.stringify(clean)])).out;
      if (r.error) throw new HttpError(r.error === "device_not_found" ? 404 : r.error === "device_not_ready" ? 409 : 403, r.error);
      await audit(c, req, "command", "classroom_device", req.params.id, capability);
      return { id: r.id, status: "queued" };
    }, 201));

  app.get("/api/rooms/:id/commands", requireSession, (req, res, next) => ["teacher", "principal", "vice_principal", "it_admin", "superintendent"].includes(req.actor.role) ? next() : res.status(403).json({ error: "forbidden" }),
    run(async (c, req) => {
      if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 200);
      return (await rows(c, `SELECT c.*,d.name AS device,u.display_name AS by FROM classroom_commands c JOIN classroom_devices d ON d.id=c.device_id
          JOIN users u ON u.id=c.issued_by WHERE c.room_id=$1 ORDER BY c.created_at DESC LIMIT $2`, [req.params.id, limit])).map(c =>
        commandOut(c.status === "queued" && new Date(c.expires_at) <= new Date() ? { ...c, status: "failed", result: "expired before the device collected it" } : c));
    }));

  app.post("/api/classroom-agent/commands", agentLimiter, async (req, res, next) => {
    const m = keyOf(req);
    if (!m) return res.status(401).json({ error: "device_key_required" });
    try {
      const r = (await pool.query(`SELECT eduos_classroom_agent_take($1,$2) AS out`, [m[1], sha256(m[2])])).rows[0].out;
      if (!r) return res.status(401).json({ error: "invalid_device_key" });
      // SAFE-02: what to show while an alert is live at the school (db/122).
      const safety = deviceSafetyView((await pool.query(`SELECT eduos_classroom_agent_safety($1,$2) AS out`, [m[1], sha256(m[2])])).rows[0].out);
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: { ...r, safety } });
    } catch (e) { next(e); }
  });

  // SAFE-02: a device that only shows things (a kiosk, a display without
  // commands) asks what to show: normal, an alert notice, dark, or all clear.
  app.post("/api/classroom-agent/safety", agentLimiter, async (req, res, next) => {
    const m = keyOf(req);
    if (!m) return res.status(401).json({ error: "device_key_required" });
    try {
      const r = (await pool.query(`SELECT eduos_classroom_agent_safety($1,$2) AS out`, [m[1], sha256(m[2])])).rows[0].out;
      if (!r) return res.status(401).json({ error: "invalid_device_key" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: { safety: deviceSafetyView(r) } });
    } catch (e) { next(e); }
  });

  app.post("/api/classroom-agent/commands/:id/result", agentLimiter, async (req, res, next) => {
    const m = keyOf(req);
    if (!m) return res.status(401).json({ error: "device_key_required" });
    const { ok, message = null } = req.body || {};
    if (!validId(req.params.id) || typeof ok !== "boolean" || (message !== null && (typeof message !== "string" || message.length > 200)))
      return res.status(400).json({ error: "invalid_result" });
    try {
      const r = (await pool.query(`SELECT eduos_classroom_agent_result($1,$2,$3,$4,$5) AS out`, [m[1], sha256(m[2]), req.params.id, ok, message])).rows[0].out;
      if (r === null) return res.status(401).json({ error: "invalid_device_key" });
      if (!r) return res.status(404).json({ error: "command_not_waiting" });
      res.json({ data: { recorded: true } });
    } catch (e) { next(e); }
  });
}
