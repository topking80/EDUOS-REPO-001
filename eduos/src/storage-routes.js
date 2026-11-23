// TEACH-06: approved storage for teachers' work (db/114, src/portfolio-file.js).
//
// Storage devices:
//   GET  /api/storage/devices                   a teacher's own; IT / superintendent: the district; principal: their school
//   POST /api/storage/devices {name, kind, serial?}   a teacher asks for one to be approved
//   POST /api/storage/devices/:id/decision      district IT: {decision, note}; approving returns the unlock code, once
//   POST /api/storage/devices/:id/retire        the owner or IT
// District cloud:
//   GET  /api/storage/settings
//   PUT  /api/storage/settings                  superintendent: {cloudEnabled, retentionDays}
// Offloading a package:
//   POST /api/portfolio/packages/:id/offload    {target:"device", deviceId} → the encrypted file; {target:"cloud"}
//   GET  /api/portfolio/cloud                   the district's copies of my packages
//   POST /api/portfolio/files/open {file, code} open a package file with its device's unlock code (any EduOS)
// Oversight:
//   GET  /api/storage/offloads                  who offloaded what, when, where
import express from "express";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { check, signingKeys } from "./portfolio-package.js";
import { newDeviceKeys, formatCode, keyFingerprint, encryptForDevice, decryptWithCode } from "./portfolio-file.js";

const KINDS = ["usb_drive", "external_drive", "laptop", "other"];
const OVERSEERS = ["it_admin", "superintendent", "principal"];
export const STORAGE_FILE_PATHS = new Set(["/api/portfolio/files/open"]);
const fileJson = express.json({ limit: "12mb", strict: true });
const deviceOut = d => ({ id: d.id, owner: d.owner, ownerId: d.owner_user_id, name: d.name, kind: d.kind, serial: d.serial, status: d.status, requestedAt: d.requested_at,
  decidedBy: d.decider, decidedAt: d.decided_at, note: d.decision_note, fingerprint: d.key_fingerprint });

export function registerStorageRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const openLimiter = rateLimit({ windowMs: 600_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { if (e.code === "23505") return res.status(409).json({ error: "already_exists" }); sendError(res, next, e); }
  };
  const ours = signingKeys()?.public || null;

  // ---------- devices ----------
  app.get("/api/storage/devices", requireSession, only(["teacher", ...OVERSEERS]), run(async (c, req) =>
    (await rows(c, `SELECT d.*,o.display_name AS owner,x.display_name AS decider FROM storage_devices d JOIN users o ON o.id=d.owner_user_id LEFT JOIN users x ON x.id=d.decided_by
       WHERE ($1<>'teacher' OR d.owner_user_id=$2) ORDER BY (d.status='pending') DESC,d.requested_at DESC LIMIT 1000`, [req.actor.role, req.actor.userId])).map(deviceOut)));

  app.post("/api/storage/devices", limiter, requireSession, requireCsrf, only(["teacher"]), run(async (c, req) => {
    const { name, kind, serial = null } = req.body || {};
    if (!cleanText(name, 80) || !KINDS.includes(kind) || (serial != null && serial !== "" && !cleanText(serial, 80))) throw new HttpError(400, "invalid_storage_device");
    const d = await one(c, `INSERT INTO storage_devices(district_id,school_id,owner_user_id,name,kind,serial) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.actor.districtId, req.actor.schoolId, req.actor.userId, name.trim(), kind, serial?.trim() || null]);
    await audit(c, req, "create", "storage_device", d.id, kind);
    return d;
  }, 201));

  app.post("/api/storage/devices/:id/decision", limiter, requireSession, requireCsrf, only(["it_admin"]), run(async (c, req) => {
    const { decision, note = null } = req.body || {};
    if (!validId(req.params.id) || !["approved", "rejected"].includes(decision) || (note != null && note !== "" && !cleanText(note, 500))) throw new HttpError(400, "invalid_decision");
    const keys = decision === "approved" ? newDeviceKeys() : null;
    const d = await one(c, `UPDATE storage_devices SET status=$2,decided_by=$3,decided_at=now(),decision_note=$4,public_key=$5,key_fingerprint=$6 WHERE id=$1 AND status='pending' RETURNING id,name`,
      [req.params.id, decision, req.actor.userId, note?.trim() || null, keys?.publicKey ?? null, keys ? keyFingerprint(keys.publicKey) : null]);
    if (!d) throw new HttpError(404, "storage_device_not_found");
    await audit(c, req, "decide", "storage_device", d.id, decision);
    return keys ? { status: decision, unlockCode: formatCode(keys.code), note: "Shown once. Give it to the teacher with the device; files saved to it open only with this code." } : { status: decision };
  }));

  app.post("/api/storage/devices/:id/retire", limiter, requireSession, requireCsrf, only(["teacher", "it_admin"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const d = await one(c, `UPDATE storage_devices SET status='retired',retired_at=now() WHERE id=$1 AND status<>'retired' AND ($2='it_admin' OR owner_user_id=$3) RETURNING id`,
      [req.params.id, req.actor.role, req.actor.userId]);
    if (!d) throw new HttpError(404, "storage_device_not_found");
    await audit(c, req, "retire", "storage_device", d.id, null);
    return { retired: true };
  }));

  // ---------- district cloud ----------
  app.get("/api/storage/settings", requireSession, run(async (c, req) => {
    const s = await one(c, `SELECT cloud_enabled,retention_days FROM district_storage_settings WHERE district_id=$1`, [req.actor.districtId]);
    return { cloudEnabled: Boolean(s?.cloud_enabled), retentionDays: s?.retention_days ?? 365 };
  }));
  app.put("/api/storage/settings", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    const { cloudEnabled, retentionDays } = req.body || {};
    if (typeof cloudEnabled !== "boolean" || !Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650) throw new HttpError(400, "invalid_settings");
    await c.query(`INSERT INTO district_storage_settings(district_id,cloud_enabled,retention_days,updated_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(district_id) DO UPDATE SET cloud_enabled=EXCLUDED.cloud_enabled,retention_days=EXCLUDED.retention_days,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [req.actor.districtId, cloudEnabled, retentionDays, req.actor.userId]);
    await audit(c, req, "update", "storage_settings", req.actor.districtId, `cloud=${cloudEnabled} days=${retentionDays}`);
    return { cloudEnabled, retentionDays };
  }));

  // ---------- offloading ----------
  app.post("/api/portfolio/packages/:id/offload", limiter, requireSession, requireCsrf, only(["teacher"]), run(async (c, req) => {
    const { target, deviceId } = req.body || {};
    if (!validId(req.params.id) || !["device", "cloud"].includes(target) || (target === "device" && !validId(deviceId))) throw new HttpError(400, "invalid_offload");
    const p = await one(c, `SELECT * FROM portfolio_packages WHERE id=$1 AND owner_user_id=$2 AND withdrawn_at IS NULL`, [req.params.id, req.actor.userId]);
    if (!p) throw new HttpError(404, "package_not_found");
    const log = dev => c.query(`INSERT INTO portfolio_offloads(district_id,school_id,owner_user_id,package_id,target,device_id,item_count,manifest_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.actor.districtId, req.actor.schoolId, req.actor.userId, p.id, target, dev, p.item_count, p.manifest_sha256]);
    if (target === "cloud") {
      const s = await one(c, `SELECT cloud_enabled,retention_days FROM district_storage_settings WHERE district_id=$1`, [req.actor.districtId]);
      if (!s?.cloud_enabled) throw new HttpError(409, "district_cloud_off");
      const copy = await one(c, `INSERT INTO portfolio_cloud_copies(district_id,owner_user_id,package_id,manifest,manifest_sha256,signature,signer_public_key,item_count,keep_until)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,current_date + $9::int) RETURNING id,keep_until`,
        [req.actor.districtId, req.actor.userId, p.id, p.manifest, p.manifest_sha256, p.signature, p.signer_public_key, p.item_count, s.retention_days]);
      await log(null);
      await audit(c, req, "offload", "portfolio_package", p.id, "district_cloud");
      return { target, keepUntil: copy.keep_until };
    }
    const d = await one(c, `SELECT id,name,public_key FROM storage_devices WHERE id=$1 AND owner_user_id=$2 AND status='approved'`, [deviceId, req.actor.userId]);
    if (!d) throw new HttpError(403, "storage_not_approved");
    const file = encryptForDevice({ deviceId: d.id, deviceName: d.name, publicKey: d.public_key },
      { manifest: p.manifest, sha256: p.manifest_sha256, signature: p.signature, publicKey: p.signer_public_key });
    await log(d.id);
    await audit(c, req, "offload", "portfolio_package", p.id, `device=${d.id}`);
    return { target, device: d.name, filename: `eduos-portfolio-${new Date().toISOString().slice(0, 10)}.json`, file };
  }));

  app.get("/api/portfolio/cloud", requireSession, only(["teacher"]), run(async (c, req) =>
    (await rows(c, `SELECT id,package_id,item_count,stored_at,keep_until,manifest->'issuedBy'->>'district' AS district FROM portfolio_cloud_copies WHERE owner_user_id=$1 ORDER BY stored_at DESC`, [req.actor.userId]))
      .map(x => ({ id: x.id, packageId: x.package_id, items: x.item_count, storedAt: x.stored_at, keepUntil: x.keep_until, district: x.district }))));

  app.post("/api/portfolio/files/open", requireSession, openLimiter, fileJson, requireCsrf, only(["teacher"]), run(async (c, req) => {
    const { file, code } = req.body || {};
    let payload;
    try { payload = decryptWithCode(file, code); } catch { throw new HttpError(400, "wrong_code_or_damaged_file"); }
    const v = check(payload.manifest, { sha256: payload.sha256, signature: payload.signature, publicKey: payload.publicKey });
    if (!v.ok) throw new HttpError(422, "package_failed_its_check");
    const signer = payload.publicKey ? { fingerprint: keyFingerprint(payload.publicKey), thisEduos: payload.publicKey === ours } : null;
    // The same package already here (made on this EduOS): use it.
    const existing = await one(c, `SELECT id FROM portfolio_packages WHERE owner_user_id=$1 AND manifest_sha256=$2 AND withdrawn_at IS NULL`, [req.actor.userId, payload.sha256]);
    if (existing) return { packageId: existing.id, fromOutside: false, signed: v.signed, signer, items: payload.manifest.items.length };
    const issuer = `${String(payload.manifest.issuedBy?.district || "Another district").slice(0, 150)} (another EduOS)`;
    const p = await one(c, `INSERT INTO portfolio_packages(owner_user_id,issued_by_district_id,external_issuer,manifest,manifest_sha256,signature,signer_public_key,item_count)
        VALUES($1,NULL,$2,$3,$4,$5,$6,$7) RETURNING id`, [req.actor.userId, issuer, payload.manifest, payload.sha256, payload.signature, payload.publicKey, payload.manifest.items.length]);
    await audit(c, req, "open_file", "portfolio_package", p.id, `signed=${v.signed}`);
    return { packageId: p.id, fromOutside: true, signed: v.signed, signer, items: payload.manifest.items.length };
  }, 201));

  app.get("/api/storage/offloads", requireSession, only(OVERSEERS), run(async (c, req) =>
    (await rows(c, `SELECT o.*,u.display_name AS owner,d.name AS device FROM portfolio_offloads o JOIN users u ON u.id=o.owner_user_id LEFT JOIN storage_devices d ON d.id=o.device_id
       ORDER BY o.at DESC LIMIT 500`)).map(o => ({ owner: o.owner, target: o.target, device: o.device, items: o.item_count, at: o.at, sha256: o.manifest_sha256 }))));
}
