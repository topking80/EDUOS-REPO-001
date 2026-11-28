// COS-01 (db/186, docs/CHIEF-OF-STAFF.md): the district Chief of Staff.
// Coordination only. The office (the chief of staff and the superintendent)
// sees the district at a glance in counts and keeps a follow-up tracker. Any
// staff member assigned a follow-up sees it and moves its status. Nothing here
// reads a student, staff or family record, and nothing here decides anything:
// the overview only counts what waits for a decision.
//
//   GET   /api/cos/overview          office: per-school counts + follow-up totals
//   GET   /api/cos/staff             office: staff to assign follow-ups to
//   GET   /api/cos/followups         office: all (filter ?status=); staff: their own
//   POST  /api/cos/followups         office: create
//   PATCH /api/cos/followups/:id     office: any field; owner: status and note
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { findStudentIdentifiers } from "./student-identifiers.js";
import { normalizeName } from "./redact-names.js";

export const COS_OFFICE = Object.freeze(["chief_of_staff", "superintendent"]);
const NOT_STAFF = ["parent", "pupil"];
const STATUSES = ["open", "in_progress", "done", "cancelled"];
const OWNER_STATUSES = ["open", "in_progress", "done"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const view = f => ({ id: f.id, title: f.title, detail: f.detail, schoolId: f.school_id, schoolName: f.school_name || null,
  ownerUserId: f.owner_user_id, ownerName: f.owner_name || null, dueOn: f.due_on, status: f.status, closeNote: f.close_note,
  createdAt: f.created_at, updatedAt: f.updated_at, closedAt: f.closed_at, overdue: Boolean(f.overdue) });

const SELECT = `SELECT f.*, to_char(f.due_on, 'YYYY-MM-DD') AS due_on, s.name AS school_name, u.display_name AS owner_name,
    (f.status IN ('open','in_progress') AND f.due_on < current_date) AS overdue
  FROM cos_followups f LEFT JOIN schools s ON s.id=f.school_id AND s.district_id=f.district_id LEFT JOIN users u ON u.id=f.owner_user_id`;

/**
 * Follow-ups are for coordination, not casework: text that names a student
 * of the district in full, or gives a student number, is refused. A first name
 * on its own (a colleague can share it) is allowed.
 */
export async function namesAStudent(c, districtId, text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  const found = await findStudentIdentifiers(c, districtId, t);
  if (found.numbers.length) return true;
  const words = new Set(normalizeName(t).toLowerCase().split(/[^\p{L}\p{M}\p{N}'’-]+/u).filter(Boolean));
  return found.names.some(n => {
    const parts = normalizeName(n).toLowerCase().split(/[^\p{L}\p{M}\p{N}'’-]+/u).filter(Boolean);
    return parts.length > 1 && parts.every(p => words.has(p));
  });
}

export function registerChiefOfStaffRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `cos:${req.actor?.userId}` });
  const run = (who, fn) => async (req, res, next) => {
    try {
      if (req.actor?.tenantKind && req.actor.tenantKind !== "district") throw new HttpError(403, "district_context_required");
      const office = COS_OFFICE.includes(req.actor.role);
      if (who === "office" && !office) throw new HttpError(403, "chief_of_staff_office_only");
      if (who === "staff" && !office && NOT_STAFF.includes(req.actor.role)) throw new HttpError(403, "staff_only");
      const data = await withTenantTransaction(req.actor, c => fn(c, req, office));
      res.setHeader("Cache-Control", "no-store");
      res.status(data?.created ? 201 : 200).json({ data: data?.created ? data.item : data });
    } catch (e) { sendError(res, next, e); }
  };

  const checkText = async (c, req, ...texts) => {
    if (await namesAStudent(c, req.actor.districtId, texts.filter(Boolean).join("\n")))
      throw new HttpError(400, "follow_up_names_a_student");
  };
  const checkOwner = async (c, userId) => {
    if (!validId(userId)) throw new HttpError(400, "invalid_owner");
    const staff = await one(c, "SELECT 1 FROM eduos_cos_staff() WHERE user_id=$1", [userId]);
    if (!staff) throw new HttpError(400, "owner_must_be_district_staff");
  };
  const checkSchool = async (c, schoolId) => {
    if (schoolId === null || schoolId === undefined) return null;
    if (!validId(schoolId) || !(await one(c, "SELECT 1 FROM schools WHERE id=$1", [schoolId]))) throw new HttpError(400, "invalid_school");
    return schoolId;
  };
  const checkDue = due => {
    if (due === null || due === undefined) return null;
    if (typeof due !== "string" || !DATE_RE.test(due) || Number.isNaN(Date.parse(due))) throw new HttpError(400, "invalid_due_date");
    return due;
  };

  app.get("/api/cos/overview", requireSession, run("office", async c => {
    const overview = (await one(c, "SELECT eduos_cos_overview() AS o")).o;
    const totals = await one(c, `SELECT count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open,
        count(*) FILTER (WHERE status IN ('open','in_progress') AND due_on < current_date)::int AS overdue,
        count(*) FILTER (WHERE status IN ('open','in_progress') AND due_on BETWEEN current_date AND current_date + 6)::int AS due_this_week,
        count(*) FILTER (WHERE status='done' AND closed_at >= now() - interval '7 days')::int AS done_this_week
      FROM cos_followups`);
    return { ...overview, followups: { open: totals.open, overdue: totals.overdue, dueThisWeek: totals.due_this_week, doneThisWeek: totals.done_this_week } };
  }));

  app.get("/api/cos/staff", requireSession, run("office", async c =>
    (await rows(c, "SELECT user_id, display_name, role, school_id, school_name FROM eduos_cos_staff() ORDER BY display_name"))
      .map(s => ({ userId: s.user_id, name: s.display_name, role: s.role, schoolId: s.school_id, schoolName: s.school_name }))));

  app.get("/api/cos/followups", requireSession, run("staff", async (c, req, office) => {
    const status = req.query.status;
    if (status !== undefined && !STATUSES.includes(status) && status !== "active") throw new HttpError(400, "invalid_status");
    const where = [], params = [];
    // Row security already limits staff to their own; say so in the query too.
    if (!office) { params.push(req.actor.userId); where.push(`f.owner_user_id=$${params.length}`); }
    if (status === "active") where.push("f.status IN ('open','in_progress')");
    else if (status) { params.push(status); where.push(`f.status=$${params.length}`); }
    return (await rows(c, `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY (f.status IN ('done','cancelled')), f.due_on NULLS LAST, f.created_at LIMIT 300`, params)).map(view);
  }));

  app.post("/api/cos/followups", limiter, requireSession, requireCsrf, run("office", async (c, req) => {
    const b = req.body || {};
    if (!cleanText(b.title, 160, 3)) throw new HttpError(400, "invalid_title");
    if (b.detail !== undefined && b.detail !== null && !cleanText(b.detail, 2000, 0)) throw new HttpError(400, "invalid_detail");
    await checkOwner(c, b.ownerUserId);
    const schoolId = await checkSchool(c, b.schoolId);
    const due = checkDue(b.dueOn);
    await checkText(c, req, b.title, b.detail);
    const r = await one(c, `INSERT INTO cos_followups(district_id,school_id,title,detail,owner_user_id,due_on,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [req.actor.districtId, schoolId, b.title.trim(), b.detail?.trim() || null, b.ownerUserId, due, req.actor.userId]);
    await audit(c, req, "create", "cos_followup", r.id, `owner=${b.ownerUserId}${due ? `;due=${due}` : ""}`);
    return { created: true, item: view(await one(c, `${SELECT} WHERE f.id=$1`, [r.id])) };
  }));

  app.patch("/api/cos/followups/:id", limiter, requireSession, requireCsrf, run("staff", async (c, req, office) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const b = req.body || {};
    const cur = await one(c, "SELECT *, to_char(due_on, 'YYYY-MM-DD') AS due_str FROM cos_followups WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!cur || (!office && cur.owner_user_id !== req.actor.userId)) throw new HttpError(404, "follow_up_not_found");
    const editable = office ? ["title", "detail", "ownerUserId", "schoolId", "dueOn", "status", "closeNote"] : ["status", "closeNote"];
    const extra = Object.keys(b).filter(k => !editable.includes(k));
    if (extra.length) throw new HttpError(office ? 400 : 403, office ? "unknown_field" : "owner_may_only_update_status");
    if (!Object.keys(b).length) throw new HttpError(400, "nothing_to_change");
    const next = { title: cur.title, detail: cur.detail, owner: cur.owner_user_id, school: cur.school_id, due: cur.due_str, status: cur.status, note: cur.close_note };
    if ("title" in b) { if (!cleanText(b.title, 160, 3)) throw new HttpError(400, "invalid_title"); next.title = b.title.trim(); }
    if ("detail" in b) { if (b.detail !== null && !cleanText(b.detail, 2000, 0)) throw new HttpError(400, "invalid_detail"); next.detail = b.detail?.trim() || null; }
    if ("ownerUserId" in b) { await checkOwner(c, b.ownerUserId); next.owner = b.ownerUserId; }
    if ("schoolId" in b) next.school = await checkSchool(c, b.schoolId);
    if ("dueOn" in b) next.due = checkDue(b.dueOn);
    if ("status" in b) {
      if (!(office ? STATUSES : OWNER_STATUSES).includes(b.status)) throw new HttpError(office ? 400 : 403, office ? "invalid_status" : "owner_cannot_cancel");
      next.status = b.status;
    }
    if ("closeNote" in b) { if (b.closeNote !== null && !cleanText(b.closeNote, 500, 0)) throw new HttpError(400, "invalid_close_note"); next.note = b.closeNote?.trim() || null; }
    await checkText(c, req, "title" in b ? next.title : null, "detail" in b ? next.detail : null, "closeNote" in b ? next.note : null);
    const closed = ["done", "cancelled"].includes(next.status);
    await c.query(`UPDATE cos_followups SET title=$2, detail=$3, owner_user_id=$4, school_id=$5, due_on=$6, status=$7, close_note=$8,
        closed_at=CASE WHEN $9 THEN coalesce(CASE WHEN status IN ('done','cancelled') THEN closed_at END, now()) END WHERE id=$1`,
      [cur.id, next.title, next.detail, next.owner, next.school, next.due, next.status, next.note, closed]);
    await audit(c, req, "update", "cos_followup", cur.id, `fields=${Object.keys(b).sort().join(",")}${"status" in b ? `;status=${next.status}` : ""}`);
    return view(await one(c, `${SELECT} WHERE f.id=$1`, [cur.id]));
  }));
}
