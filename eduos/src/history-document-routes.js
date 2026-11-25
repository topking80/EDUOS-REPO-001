// TC-02: guardian plain-text document contributions.
// Files are UTF-8 text only; never rendered inline or treated as HTML.
import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, one, validId, HttpError, sendError } from "./role-app-util.js";
import { historyMedia } from "./history-media-routes.js";

const MAX_BYTES = 5 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.txt$/;
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const BEGIN_ERRORS = {
  contribution_not_found: 404, contribution_not_editable: 409,
  documents_not_enabled: 409, document_too_large: 413,
  invalid_document_name: 400, too_many_documents: 409, student_storage_full: 409
};

function decodeText(buffer) {
  let value;
  try { value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new HttpError(415, "invalid_utf8_text"); }
  // Plain text may contain tab/newline/CR, but not NUL, terminal controls,
  // bidi overrides, or other C0/C1 control characters.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(value))
    throw new HttpError(415, "unsupported_text_control");
  return value;
}

export function registerHistoryDocumentRoutes(app, providers = historyMedia()) {
  const { storage, scanner } = providers;
  const ready = Boolean(storage && scanner);
  const limiter = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => `hd:${req.actor?.userId}` });
  const raw = express.raw({ type: "text/plain", limit: "5mb" });

  app.put("/api/history/document-policy", limiter, requireSession, requireCsrf, async (req, res, next) => {
    if (req.actor.role !== "superintendent") return res.status(403).json({ error: "superintendent_only" });
    const b = req.body || {};
    const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
    if (typeof b.documentsEnabled !== "boolean" || !int(b.maxDocumentBytes, 1024, MAX_BYTES) ||
        !int(b.maxDocumentsPerContribution, 1, 10)) return res.status(400).json({ error: "invalid_document_policy" });
    if (b.documentsEnabled && !ready) return res.status(409).json({ error: "media_storage_not_configured" });
    try {
      const row = await withTenantTransaction(req.actor, async c => {
        const p = await one(c, `INSERT INTO district_history_media_policies
          (district_id,images_enabled,max_image_bytes,max_per_entry,max_bytes_per_student,
           documents_enabled,max_document_bytes,max_documents_per_contribution,set_by)
          VALUES($1,false,10485760,6,262144000,$2,$3,$4,$5)
          ON CONFLICT(district_id) DO UPDATE SET documents_enabled=EXCLUDED.documents_enabled,
            max_document_bytes=EXCLUDED.max_document_bytes,
            max_documents_per_contribution=EXCLUDED.max_documents_per_contribution,
            set_by=EXCLUDED.set_by,set_at=now()
          RETURNING documents_enabled,max_document_bytes,max_documents_per_contribution`,
          [req.actor.districtId,b.documentsEnabled,b.maxDocumentBytes,b.maxDocumentsPerContribution,req.actor.userId]);
        await audit(c,req,"set","history_document_policy",req.actor.districtId,JSON.stringify(p));
        return p;
      });
      res.setHeader("Cache-Control","no-store");
      res.json({ data: { documentsEnabled: row.documents_enabled, maxDocumentBytes: row.max_document_bytes,
        maxDocumentsPerContribution: row.max_documents_per_contribution, storageReady: ready } });
    } catch(e) { sendError(res,next,e); }
  });

  app.post("/api/family/children/:studentId/history-contributions/:contributionId/documents",
    limiter, requireSession, requireCsrf, raw, async (req,res,next) => {
      if (!ready) return res.status(503).json({ error: "media_storage_not_configured" });
      if (!validId(req.params.studentId) || !validId(req.params.contributionId))
        return res.status(400).json({ error: "invalid_contribution_id" });
      const fileName = typeof req.query.name === "string" ? req.query.name.trim() : "";
      if (!NAME_RE.test(fileName)) return res.status(400).json({ error: "invalid_document_name" });
      if (!/^text\\/plain(?:\\s*;\\s*charset=utf-8)?$/i.test(String(req.headers["content-type"] || "").trim()) ||
          !Buffer.isBuffer(req.body) || !req.body.length || req.body.length > MAX_BYTES)
        return res.status(415).json({ error: "unsupported_document_type", accepted: ["text/plain; charset=utf-8"] });
      const key = req.headers["idempotency-key"];
      if (key !== undefined && (typeof key !== "string" || !KEY_RE.test(key)))
        return res.status(400).json({ error: "invalid_idempotency_key" });
      try {
        decodeText(req.body);
        const asset = crypto.randomUUID();
        const begun = await withTenantTransaction(req.actor, async c => {
          const matches = await one(c,`SELECT 1 FROM student_history_contributions
            WHERE id=$1 AND student_id=$2 AND district_id=$3`,
            [req.params.contributionId,req.params.studentId,req.actor.districtId]);
          if (!matches) throw new HttpError(404,"contribution_not_found");
          const out = (await one(c,`SELECT eduos_history_contribution_document_begin($1,$2,$3,$4,$5,$6) AS out`,
            [req.params.contributionId,asset,`history/${req.actor.districtId}/pending/${asset}.txt`,req.body.length,fileName,key || null])).out;
          if (out.error) throw new HttpError(BEGIN_ERRORS[out.error] || 400,out.error,out);
          return out;
        });
        if (begun.existing) return res.status(200).json({ data: { assetId: begun.assetId,status: begun.status,existing: true } });
        const record = (scan,processing,extra={}) => withTenantTransaction(req.actor,c =>
          one(c,`SELECT eduos_history_contribution_document_set($1,$2,$3,$4,$5) AS ok`,
            [asset,extra.key ?? null,extra.bytes ?? null,scan,processing]));
        const scanned = await scanner.scan(req.body);
        if (scanned.verdict !== "clean") {
          await record(scanned.verdict === "infected" ? "blocked" : "pending","failed");
          await withTenantTransaction(req.actor,c=>audit(c,req,"blocked","history_document",asset,
            scanned.verdict === "infected" ? `infected:${scanned.signature}` : `scan_error:${scanned.reason}`));
          return res.status(422).json({ error: scanned.verdict === "infected" ? "document_failed_security_scan" : "security_scan_unavailable" });
        }
        const storageKey = `history/${req.actor.districtId}/${begun.studentId}/${asset}.txt`;
        try { await storage.put(storageKey,req.body,"text/plain; charset=utf-8"); }
        catch(e) { await record("clean","failed"); throw e; }
        const saved = await record("clean","processed",{key:storageKey,bytes:req.body.length});
        if (!saved?.ok) {
          await storage.remove(storageKey).catch(()=>{});
          return res.status(409).json({ error: "contribution_no_longer_pending" });
        }
        await withTenantTransaction(req.actor,c=>audit(c,req,"add","history_document",asset,
          `contribution=${req.params.contributionId};bytes=${req.body.length}`));
        res.setHeader("Cache-Control","no-store");
        res.status(201).json({ data: { assetId:asset,fileName,status:"processed",bytes:req.body.length } });
      } catch(e) { sendError(res,next,e); }
    });

  app.get("/api/history/documents/:assetId",requireSession,async(req,res,next)=>{
    if (!validId(req.params.assetId)) return res.status(400).json({error:"invalid_asset_id"});
    if (!storage) return res.status(503).json({error:"media_storage_not_configured"});
    try {
      const doc = await withTenantTransaction(req.actor,c=>
        one(c,`SELECT * FROM eduos_history_contribution_document_get($1)`,[req.params.assetId]));
      if (!doc || doc.scan_status !== "clean" || doc.processing_status !== "processed")
        return res.status(404).json({error:"document_not_found"});
      const body = await storage.get(doc.storage_key,MAX_BYTES);
      // Verify bytes remain valid and inert even if the bucket is tampered with.
      decodeText(body);
      res.setHeader("Content-Type","text/plain; charset=utf-8");
      res.setHeader("Content-Disposition",`attachment; filename="${doc.file_name}"`);
      res.setHeader("X-Content-Type-Options","nosniff");
      res.setHeader("Content-Security-Policy","default-src 'none'; sandbox");
      res.setHeader("Cache-Control","no-store");
      res.setHeader("Referrer-Policy","no-referrer");
      await withTenantTransaction(req.actor,c=>audit(c,req,"download","history_document",doc.asset_id));
      res.status(200).send(body);
    } catch(e) { sendError(res,next,e); }
  });
}
