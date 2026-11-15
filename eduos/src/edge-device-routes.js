// Edge Phase 2: health telemetry from EduOS edge devices (db/038).
//
// District IT registers a device and receives a one-time device token. The
// device's health agent posts its report to POST /api/edge/health with
// "Authorization: Bearer <token>". There is no user session or cookie on that
// request, so CSRF does not apply; the token is the device's identity, and it
// is stored only as a SHA-256 hash. Reports are reduced to an allowlist of
// device metrics, compliance flags and OS update state: nothing else is kept.
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { pool, withTenantTransaction } from "./db.js";
import { HttpError, audit, rows, one, validId, sendError } from "./role-app-util.js";
import { sanitizeReport } from "./edge-report.js";

export { sanitizeReport };

const MANAGERS = ["superintendent", "it_admin", "principal"];
const DISTRICT = ["superintendent", "it_admin"];
const DEVICE_ROLES = ["teacher", "student", "admin", "edge", "district", "state", "school-node"];
const TOKEN_RE = /^edh1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const STALE_MINUTES = 20; // the agent reports every 5 minutes by default

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function scopeSchool(a) {
  if (DISTRICT.includes(a.role)) return null;
  if (!a.schoolId) throw new HttpError(403, "school_scope_required");
  return a.schoolId;
}

export function registerEdgeDeviceRoutes(app) {
  // Per-device limit (agents report every few minutes) and a per-address cap.
  const deviceLimiter = rateLimit({
    windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `edge:${(TOKEN_RE.exec(String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")) || [])[1] || req.ip}`,
  });
  const addressLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });

  app.post("/api/edge/health", addressLimiter, deviceLimiter, async (req, res, next) => {
    const m = TOKEN_RE.exec(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!m) return res.status(401).json({ error: "device_token_required" });
    const report = sanitizeReport(req.body);
    if (!report) return res.status(400).json({ error: "invalid_health_report" });
    try {
      const r = await pool.query("SELECT eduos_edge_record_health($1, $2, $3::jsonb) AS out", [m[1], sha256(m[2]), JSON.stringify(report)]);
      if (!r.rows[0].out) return res.status(401).json({ error: "invalid_device_token" });
      res.setHeader("Cache-Control", "no-store");
      res.status(202).json({ data: { accepted: true } });
    } catch (e) { next(e); }
  });

  app.get("/api/edge/devices", requireSession, async (req, res, next) => {
    const a = req.actor;
    if (!MANAGERS.includes(a.role)) return res.status(403).json({ error: "edge_devices_access_denied" });
    try {
      const data = await withTenantTransaction(a, async (c) => {
        const list = await rows(c, `SELECT d.id, d.name, d.device_role, d.school_id, s.name AS school_name, d.created_at, d.revoked_at,
              d.last_seen_at, d.last_report, d.report_count,
              (d.revoked_at IS NULL AND (d.last_seen_at IS NULL OR d.last_seen_at < now() - make_interval(mins => $3))) AS stale
            FROM edge_devices d LEFT JOIN schools s ON s.id = d.school_id
            WHERE d.district_id = $1 AND ($2::uuid IS NULL OR d.school_id = $2)
            ORDER BY d.revoked_at IS NOT NULL, d.last_seen_at DESC NULLS LAST, d.name LIMIT 500`, [a.districtId, scopeSchool(a), STALE_MINUTES]);
        return { devices: list, staleAfterMinutes: STALE_MINUTES };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/edge/devices", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, b = req.body || {};
    if (!MANAGERS.includes(a.role)) return res.status(403).json({ error: "edge_devices_access_denied" });
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 80 || !DEVICE_ROLES.includes(b.deviceRole)) return res.status(400).json({ error: "valid_device_fields_required", roles: DEVICE_ROLES });
    try {
      const data = await withTenantTransaction(a, async (c) => {
        let school = a.schoolId || null;
        if (DISTRICT.includes(a.role)) {
          school = null;
          if (b.schoolId !== undefined && b.schoolId !== null) {
            if (!validId(b.schoolId)) throw new HttpError(400, "invalid_school_id");
            if (!(await one(c, "SELECT 1 FROM schools WHERE id=$1 AND district_id=$2", [b.schoolId, a.districtId]))) throw new HttpError(400, "school_not_in_district");
            school = b.schoolId;
          }
        } else if (!school) throw new HttpError(403, "school_scope_required");
        const id = crypto.randomUUID(), secret = crypto.randomBytes(32).toString("base64url");
        await c.query(`INSERT INTO edge_devices(id, district_id, school_id, name, device_role, token_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, a.districtId, school, name, b.deviceRole, sha256(secret), a.userId]);
        await audit(c, req, "create", "edge_device", id, `role=${b.deviceRole}`);
        // The token is returned once and never stored in clear.
        return { id, name, deviceRole: b.deviceRole, schoolId: school, token: `edh1.${id}.${secret}` };
      });
      res.status(201).json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/edge/devices/:id/revoke", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor;
    if (!MANAGERS.includes(a.role)) return res.status(403).json({ error: "edge_devices_access_denied" });
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_device_id" });
    try {
      const data = await withTenantTransaction(a, async (c) => {
        const r = await one(c, `UPDATE edge_devices SET revoked_at = now(), revoked_by = $1
            WHERE id = $2 AND district_id = $3 AND ($4::uuid IS NULL OR school_id = $4) AND revoked_at IS NULL RETURNING id, revoked_at`,
          [a.userId, req.params.id, a.districtId, scopeSchool(a)]);
        if (!r) throw new HttpError(404, "device_not_found");
        await audit(c, req, "revoke", "edge_device", r.id);
        return r;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });
}
