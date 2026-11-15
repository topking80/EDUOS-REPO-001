// District-approved OS updates for EduOS edge devices (db/039).
//
// Superintendents and IT admins approve an OS version for canary devices and,
// once the canary gate passes, promote it to every device. Principals can see
// the status. Devices ask GET /api/edge/update-target with their device token
// (db/038) for the version they should run.
import crypto from "node:crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { pool, withTenantTransaction } from "./db.js";
import { HttpError, audit, rows, one, validId, sendError } from "./role-app-util.js";

const APPROVERS = ["superintendent", "it_admin"];
const VIEWERS = [...APPROVERS, "principal"];
const VERSION_RE = /^\d{2,3}\.\d{8}\.\d+\.\d+$/;
const TOKEN_RE = /^edh1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const FRESH_MINUTES = 60; // a canary that hasn't reported for an hour doesn't count
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function policyOf(c, districtId) {
  return (await one(c, "SELECT require_approval, min_canaries, soak_hours, updated_at FROM edge_update_policy WHERE district_id=$1", [districtId]))
    || { require_approval: false, min_canaries: 2, soak_hours: 24, updated_at: null };
}

/**
 * Whether a canary release may be promoted: at least min_canaries canary
 * devices, reporting within the last hour, run it healthy (not held) and have
 * done so for soak_hours, and no device has rolled back from it.
 */
export async function canaryGate(c, districtId, release, policy) {
  const canaries = await rows(c, `
    SELECT d.id, d.name, d.last_seen_at, d.last_report->'os' AS os,
           (SELECT min(r.received_at) FROM edge_device_reports r
             WHERE r.device_id = d.id AND r.received_at >= $3
               AND r.report->'os'->>'booted_version' = $2) AS first_on_version
      FROM edge_devices d
     WHERE d.district_id = $1 AND d.revoked_at IS NULL AND d.update_cohort = 'canary'`,
    [districtId, release.version, release.approved_at]);
  const now = Date.now();
  const healthy = canaries.filter(d => d.os?.booted_version === release.version
    && ["healthy", "first_boot"].includes(d.os?.last_verify) && d.os?.updates !== "held"
    && d.last_seen_at && now - new Date(d.last_seen_at).getTime() <= FRESH_MINUTES * 60_000);
  const soaked = healthy.filter(d => d.first_on_version && now - new Date(d.first_on_version).getTime() >= policy.soak_hours * 3_600_000);
  const rolledBack = await rows(c, `SELECT name FROM edge_devices WHERE district_id=$1 AND revoked_at IS NULL
      AND last_report->'os'->>'rollback_from_version' = $2 ORDER BY name`, [districtId, release.version]);
  const blockers = [];
  if (rolledBack.length) blockers.push(`rolled back on ${rolledBack.map(d => d.name).join(", ")}`);
  if (soaked.length < policy.min_canaries) {
    blockers.push(healthy.length < policy.min_canaries
      ? `${healthy.length} of ${policy.min_canaries} canaries healthy on it`
      : `${soaked.length} of ${policy.min_canaries} canaries have run it for ${policy.soak_hours} h`);
  }
  return { ready: blockers.length === 0, canaries: canaries.length, healthy: healthy.length, soaked: soaked.length,
    required: policy.min_canaries, soakHours: policy.soak_hours, rolledBack: rolledBack.map(d => d.name), blockers };
}

export function registerEdgeUpdateRoutes(app) {
  const targetLimiter = rateLimit({
    windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => {
      const device = (TOKEN_RE.exec(String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")) || [])[1];
      return device ? `edge-target:${device}` : `edge-target-ip:${ipKeyGenerator(req.ip)}`;
    },
  });

  // Device: which OS version should I run? (no session; device token). The
  // device's cohort is the one the district assigned (edge_devices.update_cohort);
  // anything the device sends about its cohort is ignored.
  app.get("/api/edge/update-target", targetLimiter, async (req, res, next) => {
    const m = TOKEN_RE.exec(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!m) return res.status(401).json({ error: "device_token_required" });
    try {
      const r = await pool.query("SELECT eduos_edge_update_target($1, $2) AS out", [m[1], sha256(m[2])]);
      if (!r.rows[0].out) return res.status(401).json({ error: "invalid_device_token" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: r.rows[0].out });
    } catch (e) { next(e); }
  });

  app.get("/api/edge/updates", requireSession, async (req, res, next) => {
    const a = req.actor;
    if (!VIEWERS.includes(a.role)) return res.status(403).json({ error: "edge_updates_access_denied" });
    try {
      const data = await withTenantTransaction(a, async (c) => {
        const policy = await policyOf(c, a.districtId);
        const releases = await rows(c, `SELECT r.id, r.version, r.stage, r.approved_at, ua.display_name AS approved_by_name,
              r.promoted_at, up.display_name AS promoted_by_name, r.withdrawn_at, r.withdraw_reason
            FROM edge_update_releases r JOIN users ua ON ua.id = r.approved_by LEFT JOIN users up ON up.id = r.promoted_by
            WHERE r.district_id = $1 ORDER BY eduos_os_version_key(r.version) DESC LIMIT 50`, [a.districtId]);
        for (const r of releases) if (r.stage === "canary") r.gate = await canaryGate(c, a.districtId, { ...r }, policy);
        const fleet = await rows(c, `SELECT coalesce(last_report->'os'->>'booted_version', 'unknown') AS version,
              update_cohort AS cohort, count(*)::int AS devices
            FROM edge_devices WHERE district_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR school_id = $2)
            GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [a.districtId, APPROVERS.includes(a.role) ? null : a.schoolId]);
        return { policy, releases, fleet, canApprove: APPROVERS.includes(a.role) };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Which devices are canaries: a district decision, audited.
  app.post("/api/edge/updates/devices/:id/cohort", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, cohort = req.body?.cohort;
    if (!APPROVERS.includes(a.role)) return res.status(403).json({ error: "edge_updates_approval_denied" });
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_device_id" });
    if (!["canary", "standard"].includes(cohort)) return res.status(400).json({ error: "invalid_cohort" });
    try {
      const data = await withTenantTransaction(a, async (c) => {
        const r = await one(c, `UPDATE edge_devices SET update_cohort=$1, cohort_set_by=$2, cohort_set_at=now()
            WHERE id=$3 AND district_id=$4 AND revoked_at IS NULL RETURNING id, name, update_cohort`, [cohort, a.userId, req.params.id, a.districtId]);
        if (!r) throw new HttpError(404, "device_not_found");
        await audit(c, req, "set_cohort", "edge_device", r.id, `cohort=${cohort}`);
        return r;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.put("/api/edge/updates/policy", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, b = req.body || {};
    if (!APPROVERS.includes(a.role)) return res.status(403).json({ error: "edge_updates_approval_denied" });
    const ok = typeof b.requireApproval === "boolean" && Number.isInteger(b.minCanaries) && b.minCanaries >= 1 && b.minCanaries <= 100
      && Number.isInteger(b.soakHours) && b.soakHours >= 0 && b.soakHours <= 720;
    if (!ok) return res.status(400).json({ error: "invalid_update_policy" });
    try {
      const data = await withTenantTransaction(a, async (c) => {
        const r = await one(c, `INSERT INTO edge_update_policy(district_id, require_approval, min_canaries, soak_hours, updated_by, updated_at)
            VALUES ($1,$2,$3,$4,$5,now())
            ON CONFLICT (district_id) DO UPDATE SET require_approval=EXCLUDED.require_approval, min_canaries=EXCLUDED.min_canaries,
              soak_hours=EXCLUDED.soak_hours, updated_by=EXCLUDED.updated_by, updated_at=now()
            RETURNING require_approval, min_canaries, soak_hours, updated_at`, [a.districtId, b.requireApproval, b.minCanaries, b.soakHours, a.userId]);
        await audit(c, req, "update", "edge_update_policy", null, `require_approval=${b.requireApproval}; min_canaries=${b.minCanaries}; soak_hours=${b.soakHours}`);
        return r;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/edge/updates/releases", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, version = typeof req.body?.version === "string" ? req.body.version.trim() : "";
    if (!APPROVERS.includes(a.role)) return res.status(403).json({ error: "edge_updates_approval_denied" });
    if (!VERSION_RE.test(version)) return res.status(400).json({ error: "invalid_os_version", example: "45.20261110.3.0" });
    try {
      const data = await withTenantTransaction(a, async (c) => {
        if (await one(c, "SELECT 1 FROM edge_update_releases WHERE district_id=$1 AND version=$2", [a.districtId, version])) throw new HttpError(409, "version_already_approved");
        const r = await one(c, `INSERT INTO edge_update_releases(district_id, version, approved_by) VALUES ($1,$2,$3) RETURNING id, version, stage, approved_at`,
          [a.districtId, version, a.userId]);
        await audit(c, req, "approve_canary", "edge_update_release", r.id, `version=${version}`);
        return r;
      });
      res.status(201).json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/edge/updates/releases/:id/promote", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor;
    if (!APPROVERS.includes(a.role)) return res.status(403).json({ error: "edge_updates_approval_denied" });
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_release_id" });
    try {
      const data = await withTenantTransaction(a, async (c) => {
        const rel = await one(c, "SELECT id, version, stage, approved_at FROM edge_update_releases WHERE id=$1 AND district_id=$2 FOR UPDATE", [req.params.id, a.districtId]);
        if (!rel) throw new HttpError(404, "release_not_found");
        if (rel.stage !== "canary") throw new HttpError(409, "release_not_in_canary");
        const gate = await canaryGate(c, a.districtId, rel, await policyOf(c, a.districtId));
        // The gate is the rule: no override. A district that needs to move faster
        // lowers min_canaries or soak_hours, which is itself audited.
        if (!gate.ready) throw new HttpError(409, "canary_gate_not_passed", { gate });
        const r = await one(c, `UPDATE edge_update_releases SET stage='promoted', promoted_by=$1, promoted_at=now() WHERE id=$2 RETURNING id, version, stage, promoted_at`,
          [a.userId, rel.id]);
        await audit(c, req, "promote", "edge_update_release", rel.id, `version=${rel.version}; healthy_canaries=${gate.soaked}`);
        return r;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/edge/updates/releases/:id/withdraw", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!APPROVERS.includes(a.role)) return res.status(403).json({ error: "edge_updates_approval_denied" });
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_release_id" });
    if (reason.length < 3 || reason.length > 300) return res.status(400).json({ error: "withdraw_reason_required" });
    try {
      const data = await withTenantTransaction(a, async (c) => {
        const r = await one(c, `UPDATE edge_update_releases SET stage='withdrawn', withdrawn_by=$1, withdrawn_at=now(), withdraw_reason=$2
            WHERE id=$3 AND district_id=$4 AND stage <> 'withdrawn' RETURNING id, version, stage, withdrawn_at`, [a.userId, reason, req.params.id, a.districtId]);
        if (!r) throw new HttpError(404, "release_not_found");
        await audit(c, req, "withdraw", "edge_update_release", r.id, `version=${r.version}`);
        return r;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });
}
