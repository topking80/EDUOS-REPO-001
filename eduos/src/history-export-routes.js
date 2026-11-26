// TC-05 (export): download a copy of one student's history (db/125).
//
//   GET /api/history/export?studentId=&format=html|json
//
// The copy holds exactly the published items this person can already see
// (the same database rules as the portfolio), made on request and sent
// straight back as a download: nothing is stored, and there is no link to
// share. Every download is logged under "Who looked" and audited. Teachers
// and emergency access read only; one student per request; 5 per student per
// hour and 20 a day per person.
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, HttpError, sendError, validId } from "./role-app-util.js";
import { historyAccess, SCHOOL_YEAR_SQL } from "./student-history-portfolio-routes.js";
import { renderHistoryExport, EXPORT_FORMAT } from "./history-export.js";

export const EXPORTERS = ["student", "guardian", "grant", "school_lead", "district"];
const MAX_ITEMS = 5000;

export function registerHistoryExportRoutes(app) {
  const limiter = rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `hx:${req.actor?.userId}` });

  app.get("/api/history/export", requireSession, limiter, async (req, res, next) => {
    const format = req.query.format ?? "html";
    if (!["html", "json"].includes(format) || (req.query.studentId !== undefined && !validId(req.query.studentId)))
      return res.status(400).json({ error: "invalid_export_request" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const { student, access } = await historyAccess(client, req.actor, req.query.studentId);
        if (!EXPORTERS.includes(access)) throw new HttpError(403, "export_not_allowed", { access });
        const limit = (await one(client, `SELECT eduos_history_export_allowed($1) AS why`, [student.id])).why;
        if (limit) throw new HttpError(429, limit);
        const items = await rows(client, `
          SELECT e.id, e.entry_type, e.classification, e.title, e.body, e.occurred_at, e.source_type, ${SCHOOL_YEAR_SQL} AS school_year, u.display_name AS author_name
            FROM student_history_entries e LEFT JOIN users u ON u.id=e.author_user_id
           WHERE e.student_id=$1 AND e.status='published' ORDER BY e.occurred_at, e.id LIMIT ${MAX_ITEMS + 1}`, [student.id]);
        if (items.length > MAX_ITEMS) throw new HttpError(413, "history_too_large_to_download");
        const photos = items.length ? await rows(client, `SELECT entry_id,caption,alt_text FROM eduos_history_entry_photos($1::uuid[])`, [items.map(i => i.id)]) : [];
        const documents = items.length ? await rows(client, `SELECT entry_id,file_name,byte_size FROM eduos_history_entry_documents($1::uuid[])`, [items.map(i => i.id)]) : [];
        for (const i of items) {
          i.photos = photos.filter(p => p.entry_id === i.id).map(p => ({ caption: p.caption, description: p.alt_text }));
          i.documents = documents.filter(d => d.entry_id === i.id).map(d => ({ fileName: d.file_name, bytes: Number(d.byte_size) }));
        }
        const me = await one(client, `SELECT display_name FROM users WHERE id=$1`, [req.actor.userId]);
        await client.query(`INSERT INTO history_access_log(district_id,student_id,user_id,access,action,item_count) VALUES($1,$2,$3,$4,'export_history',$5)`,
          [req.actor.districtId, student.id, req.actor.userId, access, items.length]);
        await audit(client, req, "export", "student_history", student.id, `format=${format};items=${items.length};access=${access}`);
        return { student, access, items, by: me?.display_name || "" };
      });
      const doc = {
        format: EXPORT_FORMAT, exportedAt: new Date().toISOString(),
        exportedBy: { name: out.by, as: out.access }, student: { name: out.student.display_name },
        note: "A copy of the published items this person could see on the day it was made. Photos are listed by their descriptions and documents by filename; binary attachments are not included.",
        items: out.items.map(r => ({ type: r.entry_type, kind: r.classification, title: r.title, body: r.body, occurredAt: r.occurred_at,
          schoolYear: r.school_year, source: r.source_type, author: r.author_name,
          ...(r.photos.length ? { photos: r.photos } : {}), ...(r.documents.length ? { documents: r.documents } : {}) }))
      };
      doc.sha256 = crypto.createHash("sha256").update(JSON.stringify(doc.items)).digest("hex");
      const base = `history-${out.student.display_name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "student"}-${doc.exportedAt.slice(0, 10)}`;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.${format}"`);
      if (format === "json") return res.type("application/json").send(JSON.stringify(doc, null, 2));
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
      res.type("text/html").send(renderHistoryExport(doc));
    } catch (e) { sendError(res, next, e); }
  });
}
