// FED-05: receive the district's signed policy bundles from Master Control.
//   GET  /api/district/policy-bundles   superintendent, IT administrator
//   POST /api/district/policy-bundles   superintendent: the bundle file, as issued
// Bundles are checked (signature against MC_POLICY_PUBLIC_KEY, addressed to
// this district, newer than any received) and kept as received. Nothing is
// applied: no district setting changes, except that EduOS follows the
// jurisdiction rules in the newest bundle in force (FED-07):
//   GET  /api/district/jurisdiction-rules  superintendent, IT administrator
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, HttpError, sendError } from "./role-app-util.js";
import { parsePublicKey, verifyBundle } from "./federation/policy-bundle.js";
import { rulesInForce, residencyStatus } from "./jurisdiction-rules.js";

const trusted = () => parsePublicKey(process.env.MC_POLICY_PUBLIC_KEY || "");
const view = r => ({ id: r.id, bundleId: r.bundle_id, releaseId: r.release_id, version: r.version, sha256: r.sha256, kind: r.bundle.kind,
  rollbackOf: r.bundle.rollback_of || null, issuedAt: r.bundle.issued_at, effectiveFrom: r.bundle.effective_from, issuer: r.bundle.issuer?.name || null,
  policies: r.bundle.policies, receivedAt: r.received_at, receivedBy: r.received_by_name });

export function registerPolicyBundleRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `pb:${req.actor?.userId}` });
  const roles = list => (req, res, next) => list.includes(req.actor?.role) ? next() : res.status(403).json({ error: "district_administration_only" });
  const run = fn => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(out.status || 200).json({ data: out.data }); }
    catch (e) { sendError(res, next, e); }
  };
  const SELECT = "SELECT b.*, u.display_name AS received_by_name FROM district_policy_bundles b JOIN users u ON u.id=b.received_by";

  app.get("/api/district/policy-bundles", requireSession, roles(["superintendent", "it_admin"]), run(async c => {
    const key = trusted();
    const list = (await rows(c, `${SELECT} ORDER BY b.version DESC LIMIT 50`)).map(view);
    return { data: { configured: !!key, fingerprint: key?.fingerprint || null, latest: list[0] || null, bundles: list } };
  }));

  app.get("/api/district/jurisdiction-rules", requireSession, roles(["superintendent", "it_admin"]), run(async c => {
    const rules = await rulesInForce(c);
    return { data: { ...rules, residency: residencyStatus(rules) } };
  }));

  app.post("/api/district/policy-bundles", limiter, requireSession, requireCsrf, roles(["superintendent"]), run(async (c, req) => {
    const key = trusted();
    if (!key) throw new HttpError(503, "policy_key_not_configured");
    const v = verifyBundle(req.body, key);
    if (!v.ok) throw new HttpError(400, v.reason);
    if (v.body.district.tenant_ref !== req.actor.districtId) throw new HttpError(400, "not_for_this_district");
    const same = await one(c, `${SELECT} WHERE b.bundle_id=$1`, [v.body.bundle_id]);
    if (same) return { data: { ...view(same), existing: true } };
    const latest = await one(c, "SELECT version, sha256 FROM district_policy_bundles ORDER BY version DESC LIMIT 1");
    if (latest && v.body.version <= latest.version) throw new HttpError(409, "older_than_received", { latestVersion: latest.version });
    const gap = !!latest && v.body.previous_sha256 !== latest.sha256;
    const r = await one(c, `INSERT INTO district_policy_bundles(district_id, bundle_id, release_id, version, sha256, previous_sha256, key_fingerprint, bundle, received_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [req.actor.districtId, v.body.bundle_id, v.body.release_id, v.body.version, v.sha256,
      v.body.previous_sha256 || null, key.fingerprint, req.body, req.actor.userId]);
    await audit(c, req, "receive", "policy_bundle", r.id, `version=${v.body.version};release=${v.body.release_id};sha256=${v.sha256}${gap ? ";gap" : ""}`);
    return { status: 201, data: { ...view(await one(c, `${SELECT} WHERE b.id=$1`, [r.id])), existing: false, gap } };
  }));
}
