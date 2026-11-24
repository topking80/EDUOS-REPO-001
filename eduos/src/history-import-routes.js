// TC-06b: receiving a student's history from another district (db/130).
//
// Receiving records office (principal, a vice principal acting as one, superintendent):
//   POST /api/history-imports                     the signed file, as received (JSON, up to 8 MB)
//   GET  /api/history-imports                     what's been received
//   GET  /api/history-imports/:id                 one, with its items and suggested students
//   GET  /api/history-imports/:id/file            the file exactly as received
//   POST /api/history-imports/:id/confirm {fingerprint, studentId}
//   POST /api/history-imports/:id/decisions {decisions: [{pos, decision: "accept"|"reject", note?}]}
//   POST /api/history-imports/:id/close {note}    reject what's left (or the whole file)
//
// Nothing is added until a person confirms the sender's fingerprint (got from
// the sending district another way), chooses the student and accepts items.
import express from "express";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { verifyTransfer, readTransfer } from "./history-transfer.js";

export const HISTORY_IMPORT_PATHS = new Set(["/api/history-imports"]);
const OFFICE = ["principal", "superintendent"];
const DECISIONS = { accept: true, reject: false };
const summary = i => ({ id: i.id, status: i.status, from: { district: i.source_district_name, school: i.source_school_name, districtId: i.source_district_id },
  addressedTo: i.addressed_to, basis: i.basis, basisNote: i.basis_note, includesFamily: i.includes_family,
  student: { name: i.student_name, number: i.student_number, grade: i.student_grade }, localStudent: i.student_id ? { id: i.student_id, name: i.local_name } : null,
  fingerprint: i.sender_fingerprint, packageSha256: i.package_sha256, packagedAt: i.packaged_at, items: i.item_count,
  accepted: i.accepted ?? null, rejected: i.rejected ?? null, receivedBy: i.received_by_name, receivedAt: i.received_at,
  confirmedBy: i.confirmed_by_name || null, confirmedAt: i.confirmed_at, closedAt: i.closed_at, closeNote: i.close_note });
const SELECT = `SELECT i.id, i.status, i.source_district_name, i.source_school_name, i.source_district_id, i.addressed_to, i.basis, i.basis_note, i.includes_family,
    i.student_name, i.student_number, i.student_grade, i.student_id, s.display_name AS local_name, i.sender_fingerprint, i.package_sha256, i.packaged_at, i.item_count,
    i.received_at, ru.display_name AS received_by_name, i.confirmed_at, cu.display_name AS confirmed_by_name, i.closed_at, i.close_note,
    (SELECT count(*)::int FROM history_import_items x WHERE x.import_id=i.id AND x.decision='accepted') AS accepted,
    (SELECT count(*)::int FROM history_import_items x WHERE x.import_id=i.id AND x.decision='rejected') AS rejected
  FROM history_imports i JOIN users ru ON ru.id=i.received_by LEFT JOIN users cu ON cu.id=i.confirmed_by LEFT JOIN students s ON s.id=i.student_id`;

export function registerHistoryImportRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `hi:${req.actor?.userId}` });
  const office = (req, res, next) => OFFICE.includes(req.actor?.role) ? next() : res.status(403).json({ error: "records_office_only" });
  const fileJson = express.json({ limit: "8mb", strict: true, type: () => true });
  const run = (fn, code = 200) => async (req, res, next) => {
    try { const data = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(typeof code === "function" ? code(data) : code).json({ data }); }
    catch (e) { sendError(res, next, e); }
  };
  const load = async (c, id) => {
    if (!validId(id)) throw new HttpError(400, "invalid_import_id");
    const i = await one(c, `${SELECT} WHERE i.id=$1`, [id]);
    if (!i) throw new HttpError(404, "import_not_found");
    return i;
  };

  app.post("/api/history-imports", limiter, requireSession, requireCsrf, office, fileJson, run(async (c, req) => {
    const v = verifyTransfer(req.body);
    if (!v.ok) throw new HttpError(400, v.reason);
    const r = readTransfer(v.body);
    if (!r.ok) throw new HttpError(400, r.reason);
    const sha = req.body.signature.sha256;
    const out = (await one(c, `SELECT eduos_history_import_receive($1,$2,$3,$4,$5) AS out`, [sha, v.fingerprint, r.meta, JSON.stringify(r.items), req.body])).out;
    if (out.error) throw new HttpError(out.error === "received_elsewhere" ? 409 : 403, out.error);
    if (!out.existing) await audit(c, req, "receive", "history_import", out.id, `from=${r.meta.sourceDistrictName.slice(0, 100)};items=${r.items.length};sha256=${sha}`);
    return { ...summary(await load(c, out.id)), existing: out.existing };
  }, d => d.existing ? 200 : 201));

  app.get("/api/history-imports", requireSession, office, run(async c =>
    (await rows(c, `${SELECT} ORDER BY (i.status IN ('received','reviewing')) DESC, i.received_at DESC LIMIT 100`)).map(summary)));

  app.get("/api/history-imports/:id", requireSession, office, run(async (c, req) => {
    const i = await load(c, req.params.id);
    const items = await rows(c, `SELECT x.pos, x.item, x.decision, x.decision_note, x.decided_at, u.display_name AS decided_by, x.entry_id
        FROM history_import_items x LEFT JOIN users u ON u.id=x.decided_by WHERE x.import_id=$1 ORDER BY x.pos`, [i.id]);
    const candidates = i.status === "received" ? await rows(c, `SELECT * FROM eduos_history_import_candidates($1)`, [i.id]) : [];
    // Fingerprints this office confirmed before for the same sending district.
    const known = await rows(c, `SELECT DISTINCT ON (sender_fingerprint) sender_fingerprint, confirmed_at FROM history_imports
        WHERE source_district_id=$1 AND confirmed_at IS NOT NULL AND id<>$2 ORDER BY sender_fingerprint, confirmed_at DESC`, [i.source_district_id, i.id]);
    return { ...summary(i),
      items: items.map(x => ({ pos: x.pos, title: x.item.title, kind: x.item.kind, type: x.item.type, body: x.item.body, occurredAt: x.item.occurredAt,
        schoolYear: x.item.schoolYear, author: x.item.author, decision: x.decision, note: x.decision_note, decidedBy: x.decided_by, decidedAt: x.decided_at, entryId: x.entry_id })),
      candidates: candidates.map(s => ({ id: s.id, name: s.display_name, number: s.local_student_number, grade: s.grade_level, school: s.school_name, sameName: s.same_name, sameNumber: s.same_number })),
      knownFingerprints: known.map(k => ({ fingerprint: k.sender_fingerprint, confirmedAt: k.confirmed_at })) };
  }));

  app.get("/api/history-imports/:id/file", requireSession, office, async (req, res, next) => {
    try {
      const pkg = await withTenantTransaction(req.actor, async c => {
        if (!validId(req.params.id)) throw new HttpError(400, "invalid_import_id");
        const r = await one(c, `SELECT package FROM history_imports WHERE id=$1`, [req.params.id]);
        if (!r) throw new HttpError(404, "import_not_found");
        return r.package;
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="received-history-transfer-${req.params.id.slice(0, 8)}.json"`);
      res.type("application/json").send(JSON.stringify(pkg, null, 2));
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/history-imports/:id/confirm", limiter, requireSession, requireCsrf, office, run(async (c, req) => {
    const b = req.body || {};
    if (!validId(req.params.id) || !cleanText(b.fingerprint, 100, 8) || !validId(b.studentId)) throw new HttpError(400, "fingerprint_and_student_required");
    const r = (await one(c, `SELECT eduos_history_import_confirm($1,$2,$3) AS s`, [req.params.id, b.fingerprint, b.studentId])).s;
    if (r !== "reviewing") throw new HttpError({ not_found: 404, student_not_found: 404, fingerprint_mismatch: 422 }[r] || 409, r);
    await audit(c, req, "confirm", "history_import", req.params.id, `student=${b.studentId}`);
    return summary(await load(c, req.params.id));
  }));

  app.post("/api/history-imports/:id/decisions", limiter, requireSession, requireCsrf, office, run(async (c, req) => {
    const list = req.body?.decisions;
    if (!validId(req.params.id) || !Array.isArray(list) || !list.length || list.length > 500
        || !list.every(d => d && Number.isInteger(d.pos) && d.pos >= 1 && d.decision in DECISIONS && (d.note === undefined || d.note === null || cleanText(d.note, 300, 0))))
      throw new HttpError(400, "invalid_decisions");
    const results = [];
    for (const d of list) {
      const s = (await one(c, `SELECT eduos_history_import_decide($1,$2,$3,$4) AS s`, [req.params.id, d.pos, DECISIONS[d.decision], d.note?.trim() || null])).s;
      if (["not_found", "not_confirmed", "closed", "already_decided", "item_not_found"].includes(s)) throw new HttpError(s === "not_found" || s === "item_not_found" ? 404 : 409, s);
      results.push({ pos: d.pos, result: s });
    }
    const n = k => results.filter(r => r.result === k).length;
    await audit(c, req, "decide", "history_import", req.params.id, `accepted=${n("accepted")};rejected=${n("rejected")};duplicate=${n("duplicate")}`);
    return { results, import: summary(await load(c, req.params.id)) };
  }));

  app.post("/api/history-imports/:id/close", limiter, requireSession, requireCsrf, office, run(async (c, req) => {
    if (!validId(req.params.id) || !cleanText(req.body?.note, 300, 3)) throw new HttpError(400, "note_required");
    const r = (await one(c, `SELECT eduos_history_import_close($1,$2) AS s`, [req.params.id, req.body.note.trim()])).s;
    if (!["completed", "rejected"].includes(r)) throw new HttpError(r === "not_found" ? 404 : 409, r);
    await audit(c, req, "close", "history_import", req.params.id, req.body.note.trim().slice(0, 200));
    return summary(await load(c, req.params.id));
  }));
}
