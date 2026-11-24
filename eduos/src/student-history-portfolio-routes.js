// TC-04: a student's history as a browsable portfolio. Only items that have
// been accepted into the history (status 'published') appear; which of those a
// viewer sees is decided by the database relationship rules (db/088, db/090),
// so search, filters and paging can't reveal anything else. Grouped by school
// year in the app; text only until media storage is configured.
import { requireSession } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { one, validId, HttpError, sendError } from "./role-app-util.js";

const ENTRY_TYPES = ["achievement", "project", "coursework", "reflection", "event", "portfolio_artifact", "educator_note", "system_milestone"];
const KINDS = ["official_record", "family_memory", "student_portfolio", "teacher_artifact", "system_milestone"];
const PAGE = 50;

// School years run August to July ("2026-27"), unless the entry names one.
const YEAR = `coalesce(e.school_year,
  (extract(year FROM e.occurred_at AT TIME ZONE 'UTC')::int - (extract(month FROM e.occurred_at AT TIME ZONE 'UTC') < 8)::int)::text || '-' ||
  lpad(((extract(year FROM e.occurred_at AT TIME ZONE 'UTC')::int - (extract(month FROM e.occurred_at AT TIME ZONE 'UTC') < 8)::int + 1) % 100)::text, 2, '0'))`;

const encodeCursor = row => Buffer.from(`${row.occurred_at.toISOString()}|${row.id}`).toString("base64url");
function decodeCursor(value) {
  if (value === undefined) return null;
  const [at, id] = Buffer.from(String(value), "base64url").toString("utf8").split("|");
  if (!validId(id) || !Number.isFinite(Date.parse(at))) throw new HttpError(400, "invalid_cursor");
  return { at, id };
}
const likePattern = q => `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;

/**
 * How the session may see a student's history, or 404. A pupil may leave out
 * the student (their own). Shared by the portfolio and the export.
 */
export async function historyAccess(client, actor, studentIdIn) {
  let studentId = studentIdIn;
  if (!studentId && actor.role === "pupil") {
    studentId = (await one(client, `SELECT student_id FROM student_user_links
        WHERE user_id=$1 AND district_id=$2 AND relationship='pupil' AND status='active' LIMIT 1`, [actor.userId, actor.districtId]))?.student_id;
  }
  if (!studentId) throw new HttpError(400, "student_required");
  const student = await one(client, "SELECT id, school_id, display_name FROM students WHERE id=$1 AND district_id=$2", [studentId, actor.districtId]);
  const related = student && (await one(client, "SELECT eduos_history_relation($1,$2,$3) AS r", [actor.districtId, student.school_id, student.id])).r;
  // TC-05: read-only access by a sharing grant, an emergency window, or a
  // guardian's own items after the student took over their rights.
  const access = related || (student && (await one(client, `SELECT CASE
      WHEN eduos_history_emergency($1,$2,$3) THEN 'emergency'
      WHEN EXISTS (SELECT 1 FROM history_sharing_grants g WHERE g.student_id=$3 AND g.grantee_user_id=$4 AND g.revoked_at IS NULL AND g.expires_at>now())
        AND NOT eduos_custody_blocked($3,$4) AND eduos_student_holds_rights($3) THEN 'grant'
      WHEN eduos_student_holds_rights($3) AND eduos_is_linked_guardian($3) THEN 'guardian' END AS a`,
    [actor.districtId, student.school_id, student.id, actor.userId])).a);
  if (!access) throw new HttpError(404, "student_not_found");
  return { student, access };
}
export { YEAR as SCHOOL_YEAR_SQL };

export function registerStudentHistoryPortfolioRoutes(app) {
  app.get("/api/history/portfolio", requireSession, async (req, res, next) => {
    try {
      const q = req.query;
      if ((q.type !== undefined && !ENTRY_TYPES.includes(q.type)) || (q.kind !== undefined && !KINDS.includes(q.kind))
          || (q.year !== undefined && !/^\d{4}-\d{2}$|^[\w .–-]{1,32}$/.test(String(q.year)))
          || (q.q !== undefined && (typeof q.q !== "string" || q.q.trim().length > 100))
          || (q.studentId !== undefined && !validId(q.studentId)))
        throw new HttpError(400, "invalid_portfolio_query");
      const cursor = decodeCursor(q.cursor);
      const data = await withTenantTransaction(req.actor, async client => {
        const { student, access } = await historyAccess(client, req.actor, q.studentId);

        const params = [student.id, q.type ?? null, q.kind ?? null, q.year ?? null, q.q?.trim() ? likePattern(q.q.trim()) : null];
        const filters = `e.student_id=$1 AND e.status='published'
          AND ($2::text IS NULL OR e.entry_type=$2) AND ($3::text IS NULL OR e.classification=$3)
          AND ($4::text IS NULL OR ${YEAR}=$4)
          AND ($5::text IS NULL OR e.title ILIKE $5 OR e.body ILIKE $5)`;
        const rows = (await client.query(`
          SELECT e.id, e.entry_type, e.classification, e.title, e.body, e.occurred_at, e.source_type, ${YEAR} AS school_year,
                 u.display_name AS author_name
            FROM student_history_entries e LEFT JOIN users u ON u.id=e.author_user_id
           WHERE ${filters}
             AND ($6::timestamptz IS NULL OR (e.occurred_at, e.id) < ($6::timestamptz, $7::uuid))
           ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${PAGE + 1}`, [...params, cursor?.at ?? null, cursor?.id ?? null])).rows;
        // What the filters can offer, from the same visible items (unfiltered).
        const facets = (await client.query(`
          SELECT ${YEAR} AS school_year, e.entry_type, e.classification, count(*)::int AS n
            FROM student_history_entries e WHERE e.student_id=$1 AND e.status='published'
           GROUP BY 1,2,3`, [student.id])).rows;
        await client.query(`INSERT INTO history_access_log(district_id,student_id,user_id,access,action,item_count) VALUES($1,$2,$3,$4,'view_history',$5)`,
          [req.actor.districtId, student.id, req.actor.userId, access, Math.min(rows.length, PAGE)]);
        const more = rows.length > PAGE;
        const page = more ? rows.slice(0, PAGE) : rows;
        const distinct = key => [...new Set(facets.map(f => f[key]))].sort();
        return {
          student: { id: student.id, name: student.display_name },
          items: page.map(r => ({ id: r.id, entryType: r.entry_type, kind: r.classification, title: r.title, body: r.body,
            occurredAt: r.occurred_at, schoolYear: r.school_year, source: r.source_type, authorName: r.author_name })),
          nextCursor: more ? encodeCursor(page.at(-1)) : null,
          facets: { years: distinct("school_year").reverse(), types: distinct("entry_type"), kinds: distinct("classification"),
            total: facets.reduce((n, f) => n + f.n, 0) }
        };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (error) { sendError(res, next, error); }
  });
}
