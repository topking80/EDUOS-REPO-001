// TC-06a: sending a student's history to another district (db/129).
//
// Records office (principal, a vice principal acting as one, superintendent):
//   POST /api/students/:id/history-transfers {receivingDistrict, basis, note, includeFamilyItems}
//   GET  /api/students/:id/history-transfers
//   GET  /api/history-transfers/:id/package      the signed file (a download)
//   POST /api/history-transfers/:id/cancel {note}
// Family (the student once they hold their own rights, else a guardian):
//   GET  /api/family/history-transfers
//   POST /api/family/history-transfers/:id {decision: "approve" | "decline"}
//
// Nothing is sent anywhere: the records office downloads the package and
// sends it through its usual records channel. Transfers stay off until this
// deployment has a signing secret.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { TRANSFER_FORMAT, TRANSFER_BASES, transferKeys, signTransfer, verifyTransfer, readTransfer } from "./history-transfer.js";

const OFFICE = ["principal", "superintendent"];
const out = t => ({ id: t.id, receivingDistrict: t.receiving_district, basis: t.basis, note: t.basis_note, includeFamily: t.include_family,
  familyDecision: t.family_decision, status: t.status, requestedBy: t.requested_by_name, createdAt: t.created_at, readyAt: t.ready_at,
  items: t.item_count, packageSha256: t.package_sha256, downloads: t.download_count, firstDownloadedAt: t.first_downloaded_at,
  cancelledAt: t.cancelled_at, cancelNote: t.cancel_note, deliveredTo: t.delivered_to_name ?? null, deliveredAt: t.delivered_at ?? null });

export function registerHistoryTransferRoutes(app, { keys = transferKeys() } = {}) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `ht:${req.actor?.userId}` });
  const office = (req, res, next) => OFFICE.includes(req.actor?.role) ? next() : res.status(403).json({ error: "records_office_only" });
  const run = (fn, code = 200) => async (req, res, next) => {
    try { const data = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(code).json({ data }); }
    catch (e) { sendError(res, next, e); }
  };

  app.post("/api/students/:id/history-transfers", limiter, requireSession, requireCsrf, office, run(async (c, req) => {
    if (!keys) throw new HttpError(503, "transfer_signing_not_configured");
    const b = req.body || {};
    if (!validId(req.params.id) || !cleanText(b.receivingDistrict, 200, 2) || !TRANSFER_BASES.includes(b.basis) || !cleanText(b.note, 500, 5)
        || typeof b.includeFamilyItems !== "boolean") throw new HttpError(400, "invalid_transfer", { bases: TRANSFER_BASES });
    const r = (await one(c, `SELECT eduos_history_transfer_start($1,$2,$3,$4,$5) AS out`, [req.params.id, b.receivingDistrict, b.basis, b.note, b.includeFamilyItems])).out;
    if (r.error) throw new HttpError(404, r.error);
    await audit(c, req, "start", "history_transfer", r.id, `to=${b.receivingDistrict.trim().slice(0, 100)};basis=${b.basis};family=${b.includeFamilyItems}`);
    return out(await one(c, `SELECT t.*, u.display_name AS requested_by_name FROM history_transfers t JOIN users u ON u.id=t.requested_by WHERE t.id=$1`, [r.id]));
  }, 201));

  app.get("/api/students/:id/history-transfers", requireSession, office, run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_student_id");
    const list = await rows(c, `SELECT t.*, u.display_name AS requested_by_name, dd.name AS delivered_to_name FROM history_transfers t JOIN users u ON u.id=t.requested_by
        LEFT JOIN districts dd ON dd.id=t.delivered_to WHERE t.student_id=$1 ORDER BY t.created_at DESC LIMIT 50`, [req.params.id]);
    return { signingReady: Boolean(keys), keyFingerprint: keys?.fingerprint || null, transfers: list.map(out) };
  }));

  app.post("/api/history-transfers/:id/cancel", limiter, requireSession, requireCsrf, office, run(async (c, req) => {
    if (!validId(req.params.id) || !cleanText(req.body?.note, 300, 3)) throw new HttpError(400, "note_required");
    const r = (await one(c, `SELECT eduos_history_transfer_cancel($1,$2) AS s`, [req.params.id, req.body.note.trim()])).s;
    if (!["cancelled", "cancelled_and_withdrawn"].includes(r)) throw new HttpError(r === "not_found" ? 404 : 409, r);
    await audit(c, req, "cancel", "history_transfer", req.params.id, `${req.body.note.trim().slice(0, 200)}${r === "cancelled_and_withdrawn" ? ";delivery withdrawn" : ""}`);
    return { id: req.params.id, status: "cancelled", deliveryWithdrawn: r === "cancelled_and_withdrawn" };
  }));

  // The signed package: fixed content, so the same file (and hash) every time.
  const buildPackage = async (c, id) => {
    const t = await one(c, `SELECT t.*, s.display_name, s.local_student_number, s.grade_level, sc.name AS school_name, d.name AS district_name
        FROM history_transfers t JOIN students s ON s.id=t.student_id JOIN schools sc ON sc.id=t.school_id JOIN districts d ON d.id=t.district_id WHERE t.id=$1`, [id]);
    if (!t) throw new HttpError(404, "transfer_not_found");
    if (t.status !== "ready") throw new HttpError(409, t.status === "awaiting_family" ? "awaiting_family_decision" : "transfer_cancelled");
    const items = await rows(c, `SELECT * FROM eduos_history_transfer_contents($1)`, [t.id]);
    // Fixed content: the same package (and hash) every time it's downloaded.
    const body = {
      format: TRANSFER_FORMAT, packageId: t.id, createdAt: t.ready_at.toISOString(),
      source: { districtId: t.district_id, districtName: t.district_name, schoolName: t.school_name },
      receiving: { name: t.receiving_district }, basis: { kind: t.basis, note: t.basis_note },
      includes: { records: true, familyItems: t.family_decision === "approved" },
      student: { name: t.display_name, localStudentNumber: t.local_student_number, gradeLevel: t.grade_level },
      items: items.map(i => ({ sourceEntryId: i.entry_id, revision: i.revision_no, type: i.snapshot.entryType, kind: i.snapshot.classification,
        title: i.snapshot.title, body: i.snapshot.body || "", occurredAt: i.snapshot.occurredAt, schoolYear: i.snapshot.schoolYear,
        source: i.snapshot.sourceType, audience: i.snapshot.audience, author: i.author_name || null, photos: i.photos })),
      note: "Signed by the sending district. Photos are listed by their descriptions; image files are not included."
    };
    return { t, items, signed: signTransfer(body, keys) };
  };

  app.get("/api/history-transfers/:id/package", limiter, requireSession, office, async (req, res, next) => {
    if (!keys) return res.status(503).json({ error: "transfer_signing_not_configured" });
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_transfer_id" });
    try {
      const pkg = await withTenantTransaction(req.actor, async c => {
        const { t, items, signed } = await buildPackage(c, req.params.id);
        const r = (await one(c, `SELECT eduos_history_transfer_downloaded($1,$2) AS s`, [t.id, signed.signature.sha256])).s;
        if (r !== "ok") throw new HttpError(409, r);
        await audit(c, req, "download", "history_transfer", t.id, `items=${items.length};sha256=${signed.signature.sha256}`);
        return { signed, name: t.display_name };
      });
      const base = `history-transfer-${pkg.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "student"}-${pkg.signed.packageId.slice(0, 8)}`;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.json"`);
      res.type("application/json").send(JSON.stringify(pkg.signed, null, 2));
    } catch (e) { sendError(res, next, e); }
  });

  // TC-06c: online delivery to another district on this EduOS deployment.
  app.get("/api/history-delivery/directory", requireSession, office, run(async c =>
    (await rows(c, "SELECT * FROM eduos_history_delivery_directory()")).map(d => ({ id: d.district_id, name: d.name }))));
  app.get("/api/history-delivery/settings", requireSession, office, run(async c =>
    ({ accepting: !!(await one(c, "SELECT accepting FROM history_delivery_settings WHERE district_id=eduos_ctx_district()"))?.accepting })));
  app.put("/api/history-delivery/settings", limiter, requireSession, requireCsrf, run(async (c, req) => {
    if (req.actor.role !== "superintendent") throw new HttpError(403, "superintendent_only");
    if (typeof req.body?.accepting !== "boolean") throw new HttpError(400, "invalid_setting");
    await c.query(`INSERT INTO history_delivery_settings(district_id, accepting, changed_by) VALUES ($1,$2,$3)
      ON CONFLICT (district_id) DO UPDATE SET accepting=EXCLUDED.accepting, changed_by=EXCLUDED.changed_by, changed_at=now()`, [req.actor.districtId, req.body.accepting, req.actor.userId]);
    await audit(c, req, req.body.accepting ? "accept_online" : "stop_online", "history_delivery_settings", req.actor.districtId);
    return { accepting: req.body.accepting };
  }));
  app.post("/api/history-transfers/:id/deliver", limiter, requireSession, requireCsrf, office, run(async (c, req) => {
    if (!keys) throw new HttpError(503, "transfer_signing_not_configured");
    if (!validId(req.params.id) || !validId(req.body?.districtId)) throw new HttpError(400, "district_required");
    const { t, signed } = await buildPackage(c, req.params.id);
    const v = verifyTransfer(signed), r = v.ok ? readTransfer(v.body) : v;
    if (!r.ok) throw new HttpError(500, "package_check_failed");
    const out = (await one(c, "SELECT eduos_history_transfer_deliver($1,$2,$3,$4,$5,$6,$7) AS out",
      [t.id, req.body.districtId, signed.signature.sha256, v.fingerprint, r.meta, JSON.stringify(r.items), signed])).out;
    if (out.error) throw new HttpError({ not_found: 404, district_not_receiving: 404 }[out.error] || 409, out.error);
    await audit(c, req, "deliver", "history_transfer", t.id, `to=${req.body.districtId};items=${r.items.length};sha256=${signed.signature.sha256}`);
    return { delivered: true, deliveredAt: out.deliveredAt };
  }));

  app.get("/api/family/history-transfers", requireSession, run(async c =>
    (await rows(c, `SELECT * FROM eduos_history_transfer_family_pending()`)).map(t => ({ id: t.id, studentId: t.student_id, studentName: t.student_name,
      school: t.school_name, receivingDistrict: t.receiving_district, basis: t.basis, note: t.basis_note, createdAt: t.created_at }))));

  app.post("/api/family/history-transfers/:id", limiter, requireSession, requireCsrf, run(async (c, req) => {
    const d = req.body?.decision;
    if (!validId(req.params.id) || !["approve", "decline"].includes(d)) throw new HttpError(400, "invalid_decision");
    const r = (await one(c, `SELECT eduos_history_transfer_family_decide($1,$2) AS s`, [req.params.id, d === "approve"])).s;
    if (r === "not_found") throw new HttpError(404, "transfer_not_found");
    if (r === "already_decided") throw new HttpError(409, r);
    await audit(c, req, d, "history_transfer_family", req.params.id);
    return { id: req.params.id, decision: r };
  }));
}
