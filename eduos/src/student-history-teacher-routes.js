// TC-03: teacher contributions to a student's history. A teacher submits an
// item for a student they teach; a principal, vice principal or
// superintendent reviews it (approve, ask for changes, reject); then the
// student's family accepts or declines it. Who may do what is enforced by the
// database (db/088, db/090); these routes validate input and map outcomes.
// Text only: media waits until private storage and scanning are configured.
import { randomUUID } from "node:crypto";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

const ENTRY_TYPES = ["project", "achievement", "coursework", "event", "reflection"];
const REASONS = ["needs_edits", "inaccurate", "privacy_concern", "other_students_identifiable", "not_appropriate",
  "duplicate", "not_relevant", "family_preference", "other"];
const REVIEWERS = ["principal", "vice_principal", "superintendent"];

// Workflow function errors -> HTTP.
const PG_ERRORS = { P0002: 404, "55000": 409, "42501": 403, "22023": 400 };
function mapError(error) {
  if (error instanceof HttpError) return error;
  const status = PG_ERRORS[error?.code];
  if (!status) return error;
  const code = /^[a-z_]+$/.test(error.message || "") ? error.message : status === 403 ? "forbidden" : "invalid_request";
  return new HttpError(status, code);
}
const handler = fn => async (req, res, next) => {
  try {
    const data = await withTenantTransaction(req.actor, client => fn(client, req));
    res.setHeader("Cache-Control", "no-store");
    res.status(req.method === "POST" && data?.created ? 201 : 200).json({ data: data?.created ?? data });
  } catch (error) { sendError(res, next, mapError(error)); }
};
const onlyRoles = (...roles) => (req, res, next) =>
  roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "role_not_allowed" });
const onlyKeys = (body, keys) => body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every(k => keys.includes(k));
const optionalNote = v => v === undefined || v === null || cleanText(v, 1000, 0);
const reasonOk = v => v === undefined || v === null || REASONS.includes(v);
const decisionsFor = (client, ids) => ids.length ? client.query(`
    SELECT entry_id, decision, reason_code, note, actor_relation, decided_at
      FROM student_history_entry_decisions WHERE entry_id = ANY($1::uuid[]) ORDER BY decided_at`, [ids]).then(r => r.rows) : [];
const view = (row, decisions = []) => ({
  id: row.id, studentId: row.student_id, studentName: row.student_name ?? undefined, entryType: row.entry_type,
  title: row.title, body: row.body, occurredAt: row.occurred_at, status: row.status,
  authorName: row.author_name ?? undefined, updatedAt: row.updated_at,
  decisions: decisions.filter(d => d.entry_id === row.id).map(d => ({ decision: d.decision, reasonCode: d.reason_code, note: d.note, by: d.actor_relation, at: d.decided_at }))
});

export function registerStudentHistoryTeacherRoutes(app) {
  // ---- teacher ----
  app.post("/api/students/:studentId/history/teacher-items", requireSession, requireCsrf, onlyRoles("teacher"), handler(async (client, req) => {
    const b = req.body;
    if (!validId(req.params.studentId) || !onlyKeys(b, ["title", "body", "occurredAt", "entryType"]) || !cleanText(b.title, 180)
        || !cleanText(b.body ?? "", 12000, 0) || typeof b.occurredAt !== "string" || !Number.isFinite(Date.parse(b.occurredAt))
        || !ENTRY_TYPES.includes(b.entryType ?? "project"))
      throw new HttpError(400, "invalid_history_item");
    const student = await one(client, "SELECT id, school_id FROM students WHERE id=$1 AND district_id=$2", [req.params.studentId, req.actor.districtId]);
    if (!student || student.school_id !== req.actor.schoolId) throw new HttpError(404, "student_not_found");
    const id = randomUUID();
    try {
      await client.query("SAVEPOINT item");
      await client.query(`INSERT INTO student_history_entries
          (id, district_id, school_id, student_id, entry_type, classification, title, body, occurred_at, audience, status, source_type, author_user_id)
        VALUES ($1,$2,$3,$4,$5,'teacher_artifact',$6,$7,$8,'family','draft','teacher',$9)`,
        [id, req.actor.districtId, student.school_id, student.id, b.entryType ?? "project", b.title.trim(), (b.body ?? "").trim(), b.occurredAt, req.actor.userId]);
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT item");
      // Row-level security refused it: not a student on this teacher's roster.
      if (e?.code === "42501") throw new HttpError(404, "student_not_on_your_roster");
      throw e;
    }
    await client.query("SELECT eduos_history_submit($1)", [id]);
    await audit(client, req, "submit", "student_history_entry", id, "teacher_artifact");
    return { created: { id, status: "submitted" } };
  }));

  app.get("/api/teacher/history-items", requireSession, onlyRoles("teacher"), handler(async (client, req) => {
    const rows = (await client.query(`
      SELECT e.id, e.student_id, s.display_name AS student_name, e.entry_type, e.title, e.body, e.occurred_at, e.status, e.updated_at
        FROM student_history_entries e JOIN students s ON s.id=e.student_id AND s.district_id=e.district_id
       WHERE e.author_user_id=$1 AND e.classification='teacher_artifact'
       ORDER BY e.updated_at DESC, e.id LIMIT 200`, [req.actor.userId])).rows;
    const decisions = await decisionsFor(client, rows.map(r => r.id));
    // MEDIA-01: each item's ready photos.
    const photos = rows.length ? (await client.query(`SELECT * FROM eduos_history_entry_photos($1::uuid[])`, [rows.map(r => r.id)])).rows : [];
    return rows.map(r => ({ ...view(r, decisions), photos: photos.filter(p => p.entry_id === r.id).map(p => ({ id: p.asset_id, caption: p.caption, alt: p.alt_text })) }));
  }));

  // Edit after the school asked for changes, then resubmit.
  app.patch("/api/teacher/history-items/:id", requireSession, requireCsrf, onlyRoles("teacher"), handler(async (client, req) => {
    const b = req.body;
    if (!validId(req.params.id) || !onlyKeys(b, ["title", "body"]) || (b.title === undefined && b.body === undefined)
        || (b.title !== undefined && !cleanText(b.title, 180)) || (b.body !== undefined && !cleanText(b.body, 12000, 0)))
      throw new HttpError(400, "invalid_history_item");
    const r = await client.query(`UPDATE student_history_entries
        SET title=coalesce($2, title), body=coalesce($3, body)
      WHERE id=$1 AND author_user_id=$4 AND classification='teacher_artifact' AND status='draft' RETURNING id`,
      [req.params.id, b.title?.trim() ?? null, b.body?.trim() ?? null, req.actor.userId]);
    if (!r.rowCount) throw new HttpError(404, "draft_not_found");
    await audit(client, req, "edit", "student_history_entry", req.params.id);
    return { id: req.params.id, status: "draft" };
  }));

  app.post("/api/teacher/history-items/:id/submit", requireSession, requireCsrf, onlyRoles("teacher"), handler(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_history_item_id");
    const status = (await one(client, "SELECT eduos_history_submit($1) AS s", [req.params.id])).s;
    await audit(client, req, "submit", "student_history_entry", req.params.id, "resubmitted");
    return { id: req.params.id, status };
  }));

  // ---- school review ----
  app.get("/api/history-review", requireSession, onlyRoles(...REVIEWERS), handler(async client => {
    const rows = (await client.query(`
      SELECT e.id, e.student_id, s.display_name AS student_name, e.entry_type, e.title, e.body, e.occurred_at, e.status, e.updated_at,
             u.display_name AS author_name
        FROM student_history_entries e
        JOIN students s ON s.id=e.student_id AND s.district_id=e.district_id
        LEFT JOIN users u ON u.id=e.author_user_id
       WHERE e.classification='teacher_artifact' AND e.status='submitted'
       ORDER BY e.updated_at, e.id LIMIT 200`)).rows;
    const decisions = await decisionsFor(client, rows.map(r => r.id));
    return rows.map(r => view(r, decisions));
  }));

  app.post("/api/history-review/:id", requireSession, requireCsrf, onlyRoles(...REVIEWERS), handler(async (client, req) => {
    const b = req.body;
    if (!validId(req.params.id) || !onlyKeys(b, ["decision", "reasonCode", "note"]) || !["approve", "request_changes", "reject"].includes(b.decision)
        || !reasonOk(b.reasonCode) || (b.decision !== "approve" && !b.reasonCode) || !optionalNote(b.note))
      throw new HttpError(400, "invalid_review");
    const status = (await one(client, "SELECT eduos_history_review($1,$2,$3,$4) AS s",
      [req.params.id, b.decision, b.reasonCode ?? null, b.note ?? null])).s;
    await audit(client, req, `review.${b.decision}`, "student_history_entry", req.params.id, b.reasonCode ?? null);
    return { id: req.params.id, status };
  }));

  // ---- family ----
  app.get("/api/family/children/:studentId/history-items/pending", requireSession, onlyRoles("parent"), handler(async (client, req) => {
    if (!validId(req.params.studentId)) throw new HttpError(400, "invalid_student_id");
    const rows = (await client.query(`
      SELECT e.id, e.student_id, e.entry_type, e.title, e.body, e.occurred_at, e.status, e.updated_at, u.display_name AS author_name
        FROM student_history_entries e LEFT JOIN users u ON u.id=e.author_user_id
       WHERE e.student_id=$1 AND e.classification='teacher_artifact' AND e.status='approved'
       ORDER BY e.updated_at, e.id LIMIT 200`, [req.params.studentId])).rows;
    return rows.map(r => view(r));
  }));

  app.post("/api/family/children/:studentId/history-items/:id", requireSession, requireCsrf, onlyRoles("parent"), handler(async (client, req) => {
    const b = req.body;
    if (!validId(req.params.studentId) || !validId(req.params.id) || !onlyKeys(b, ["decision", "reasonCode", "note"])
        || !["accept", "decline"].includes(b.decision) || !reasonOk(b.reasonCode) || !optionalNote(b.note))
      throw new HttpError(400, "invalid_decision");
    const entry = await one(client, "SELECT student_id FROM student_history_entries WHERE id=$1", [req.params.id]);
    if (!entry || entry.student_id !== req.params.studentId) throw new HttpError(404, "history_item_not_found");
    const status = (await one(client, "SELECT eduos_history_family_decide($1,$2,$3,$4) AS s",
      [req.params.id, b.decision, b.reasonCode ?? null, b.note ?? null])).s;
    await audit(client, req, `family.${b.decision}`, "student_history_entry", req.params.id, b.reasonCode ?? null);
    return { id: req.params.id, status };
  }));
}
