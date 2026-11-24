// MEDIA-01: photos on student history items (db/126).
//
//   GET  /api/history/media-policy                  the district's limits (+ whether storage/scanning are set up)
//   PUT  /api/history/media-policy                  superintendent: on/off and limits
//   POST /api/history/entries/:id/photos?caption=&alt=   body: the image (image/jpeg|png|webp)
//                                                    header Idempotency-Key makes retries safe
//   POST /api/family/children/:studentId/history-contributions/:contributionId/photos  (MEDIA-02, the guardian)
//   POST /api/history/capsules/:id/photos            (MEDIA-03, the capsule's owner, while a draft)
//   GET  /api/history/photos/:assetId                -> 302 to a 60-second private link
//
// The server checks every photo before it is stored: the district's limits,
// ClamAV, a real decode as the declared type, re-encoding (no EXIF/GPS),
// and ClamAV again on the result. Only the processed photo reaches the
// private bucket. Anything that fails is kept out and never shown.
import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { audit, one, validId, HttpError, sendError } from "./role-app-util.js";
import { createS3Storage } from "./s3-storage.js";
import { createClamAvScanner } from "./clamav-scanner.js";
import { processHistoryImage, HISTORY_IMAGE_TYPES } from "./history-image.js";

const DEFAULTS = { imagesEnabled: false, maxImageBytes: 10485760, maxPerEntry: 6, maxBytesPerStudent: 262144000 };
const policyOut = p => p ? { imagesEnabled: p.images_enabled, maxImageBytes: p.max_image_bytes, maxPerEntry: p.max_per_entry, maxBytesPerStudent: Number(p.max_bytes_per_student) } : DEFAULTS;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const BEGIN_ERRORS = { entry_not_found: 404, entry_not_editable: 409, contribution_not_found: 404, contribution_not_editable: 409, capsule_not_found: 404, capsule_not_a_draft: 409,
  photos_not_enabled: 409, photo_too_large: 413, too_many_photos: 409, student_storage_full: 409 };
// Where a photo is being added: a history item, or a guardian's pending contribution.
const TARGETS = {
  entry: { begin: "eduos_history_media_begin", set: "eduos_history_media_set" },
  contribution: { begin: "eduos_history_contribution_photo_begin", set: "eduos_history_contribution_photo_set" },
  capsule: { begin: "eduos_capsule_photo_begin", set: "eduos_capsule_photo_set" }
};

let shared = null;
/** The one storage/scanner pair the API uses (contribution routes delete released photos through it). */
export const historyMedia = () => (shared ||= historyMediaProviders());

export function historyMediaProviders({ storage, scanner } = {}) {
  const nonProduction = (process.env.NODE_ENV || "development") !== "production";
  return {
    storage: storage !== undefined ? storage : createS3Storage({ ...config.mediaS3, allowHttpLoopback: nonProduction }),
    scanner: scanner !== undefined ? scanner : createClamAvScanner(config.clamav)
  };
}

export function registerHistoryMediaRoutes(app, providers = historyMedia()) {
  const { storage, scanner } = providers;
  const ready = Boolean(storage && scanner);
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `hm:${req.actor?.userId}` });
  const raw = express.raw({ type: Object.keys(HISTORY_IMAGE_TYPES), limit: "20mb" });

  app.get("/api/history/media-policy", requireSession, async (req, res, next) => {
    try {
      const p = await withTenantTransaction(req.actor, c => one(c, `SELECT * FROM district_history_media_policies WHERE district_id=$1`, [req.actor.districtId]));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: { ...policyOut(p), storageReady: ready, canEdit: req.actor.role === "superintendent", types: Object.keys(HISTORY_IMAGE_TYPES) } });
    } catch (e) { sendError(res, next, e); }
  });

  app.put("/api/history/media-policy", limiter, requireSession, requireCsrf, async (req, res, next) => {
    if (req.actor.role !== "superintendent") return res.status(403).json({ error: "superintendent_only" });
    const b = req.body || {};
    const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
    if (typeof b.imagesEnabled !== "boolean" || !int(b.maxImageBytes, 102400, 20971520) || !int(b.maxPerEntry, 1, 20) || !int(b.maxBytesPerStudent, 1048576, 5368709120))
      return res.status(400).json({ error: "invalid_media_policy" });
    if (b.imagesEnabled && !ready) return res.status(409).json({ error: "media_storage_not_configured" });
    try {
      const p = await withTenantTransaction(req.actor, async c => {
        const row = await one(c, `INSERT INTO district_history_media_policies(district_id,images_enabled,max_image_bytes,max_per_entry,max_bytes_per_student,set_by)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (district_id) DO UPDATE SET images_enabled=EXCLUDED.images_enabled,max_image_bytes=EXCLUDED.max_image_bytes,
            max_per_entry=EXCLUDED.max_per_entry,max_bytes_per_student=EXCLUDED.max_bytes_per_student,set_by=EXCLUDED.set_by,set_at=now() RETURNING *`,
          [req.actor.districtId, b.imagesEnabled, b.maxImageBytes, b.maxPerEntry, b.maxBytesPerStudent, req.actor.userId]);
        await audit(c, req, "set", "history_media_policy", req.actor.districtId, JSON.stringify(policyOut(row)));
        return row;
      });
      res.json({ data: policyOut(p) });
    } catch (e) { sendError(res, next, e); }
  });

  const acceptPhoto = (target, idParam) => async (req, res, next) => {
    const T = TARGETS[target];
    if (!ready) return res.status(503).json({ error: "media_storage_not_configured" });
    const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if ((req.query.caption !== undefined && typeof req.query.caption !== "string") || (req.query.alt !== undefined && typeof req.query.alt !== "string"))
      return res.status(400).json({ error: "describe_the_photo" });
    const caption = typeof req.query.caption === "string" ? req.query.caption.trim() : "", alt = typeof req.query.alt === "string" ? req.query.alt.trim() : "";
    const rawKey = req.headers["idempotency-key"];
    const key = typeof rawKey === "string" ? rawKey : null;
    if (rawKey !== undefined && key === null) return res.status(400).json({ error: "invalid_idempotency_key" });
    if (!validId(req.params[idParam])) return res.status(400).json({ error: `invalid_${target}_id` });
    const photo = Buffer.isBuffer(req.body) ? Buffer.from(req.body) : null;
    if (!HISTORY_IMAGE_TYPES[mime] || !photo || !photo.length) return res.status(415).json({ error: "unsupported_media_type", types: Object.keys(HISTORY_IMAGE_TYPES) });
    if (caption.length > 500 || alt.length < 3 || alt.length > 300) return res.status(400).json({ error: "describe_the_photo", hint: "alt text: 3 to 300 characters; caption: up to 500" });
    if (key !== null && !IDEMPOTENCY_RE.test(key)) return res.status(400).json({ error: "invalid_idempotency_key" });
    const asset = crypto.randomUUID();
    try {
      // 1. Reserve it within the district's limits (and the student's total).
      const begun = await withTenantTransaction(req.actor, async c => {
        const r = (await one(c, `SELECT ${T.begin}($1,$2,$3,$4,$5,$6,$7,$8) AS out`,
          [req.params[idParam], asset, `history/${req.actor.districtId}/pending/${asset}`, mime, photo.length, caption, alt, key])).out;
        if (r.error) throw new HttpError(BEGIN_ERRORS[r.error] || 400, r.error, r);
        return r;
      });
      if (begun.existing) return res.status(200).json({ data: { assetId: begun.assetId, status: begun.status, existing: true } });
      const record = async (scan, processing, extra = {}) => withTenantTransaction(req.actor, c =>
        one(c, `SELECT ${T.set}($1,$2,$3,$4,$5,$6,$7) AS ok`, [asset, extra.key ?? null, extra.bytes ?? null, scan, processing, extra.width ?? null, extra.height ?? null]));
      // 2. Scan what arrived. 3. Decode, re-encode, scan the result.
      const first = await scanner.scan(photo);
      if (first.verdict !== "clean") {
        await record("blocked", "failed");
        await withTenantTransaction(req.actor, c => audit(c, req, "blocked", "history_photo", asset, first.verdict === "infected" ? `infected:${first.signature}` : `scan_error:${first.reason}`));
        return res.status(422).json({ error: first.verdict === "infected" ? "photo_failed_security_scan" : "security_scan_unavailable" });
      }
      let out;
      try { out = await processHistoryImage(photo, mime); }
      catch (e) { await record("clean", "failed"); return res.status(e.status || 422).json({ error: e.message || "image_processing_failed" }); }
      const second = await scanner.scan(out.buffer);
      if (second.verdict !== "clean") { await record("blocked", "failed"); return res.status(422).json({ error: "photo_failed_security_scan" }); }
      // 4. Store only the processed photo, then mark it ready.
      const storageKey = `history/${req.actor.districtId}/${begun.studentId}/${asset}.${HISTORY_IMAGE_TYPES[mime]}`;
      await storage.put(storageKey, out.buffer, out.mimeType);
      await record("clean", "processed", { key: storageKey, bytes: out.buffer.length, width: out.width, height: out.height });
      await withTenantTransaction(req.actor, c => audit(c, req, "add", "history_photo", asset, `${target}=${req.params[idParam]};bytes=${out.buffer.length}`));
      res.status(201).json({ data: { assetId: asset, status: "processed", width: out.width, height: out.height, bytes: out.buffer.length } });
    } catch (e) { sendError(res, next, e); }
  };

  app.post("/api/history/entries/:id/photos", limiter, requireSession, requireCsrf, raw, acceptPhoto("entry", "id"));
  // MEDIA-02: a guardian's photos on their own family memory, while the school reviews it.
  app.post("/api/family/children/:studentId/history-contributions/:contributionId/photos", limiter, requireSession, requireCsrf, raw, acceptPhoto("contribution", "contributionId"));
  // MEDIA-03: the owner's own photos in a draft Time Capsule.
  app.post("/api/history/capsules/:id/photos", limiter, requireSession, requireCsrf, raw, acceptPhoto("capsule", "id"));

  app.get("/api/history/photos/:assetId", requireSession, async (req, res, next) => {
    if (!validId(req.params.assetId)) return res.status(400).json({ error: "invalid_asset_id" });
    if (!ready) return res.status(503).json({ error: "media_storage_not_configured" });
    try {
      const m = await withTenantTransaction(req.actor, async c =>
        (await one(c, `SELECT * FROM eduos_history_media_get($1,'read')`, [req.params.assetId]))
        || (await one(c, `SELECT * FROM eduos_history_contribution_photo_get($1)`, [req.params.assetId]))
        || one(c, `SELECT * FROM eduos_capsule_photo_get($1)`, [req.params.assetId]));
      if (!m || m.scan_status !== "clean" || m.processing_status !== "processed") return res.status(404).json({ error: "photo_not_found" });
      const link = storage.readUrl(m.storage_key, 60);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.redirect(302, link.url);
    } catch (e) { sendError(res, next, e); }
  });
}
