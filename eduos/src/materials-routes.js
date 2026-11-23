// TEACH-02: the district's shared materials library (db/102).
//
// A teacher or principal shares a snapshot of a lesson or unit they manage.
// Colleagues at every school in the district browse it and copy it into their
// own course, where it lands as an unapproved draft with "Adapted from …"
// attribution (the school leader still approves a lesson before Christie uses
// it). Sharing again updates the snapshot (version + 1); copies already made
// don't change.
//
// Never student data: before sharing, the text is checked against the
// district's student names and numbers (student-identifiers.js). If any word
// matches, the share pauses and the teacher sees the matching words from their
// own text; they edit it, or confirm the words aren't students (history
// lessons say "Washington"). The confirmation is audited, without the words.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { findStudentIdentifiers } from "./student-identifiers.js";
import { namePatterns, numberPattern, normalizeName } from "./redact-names.js";

const AUTHORS = ["teacher", "principal"];
const READERS = [...AUTHORS, "superintendent"];

const only = (roles, error) => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error });

/** The words of `text` that match a student in the district (from the text itself, never the student records). */
export async function studentWordsIn(client, districtId, text) {
  const found = await findStudentIdentifiers(client, districtId, text);
  if (!found.names.length && !found.numbers.length) return [];
  const base = normalizeName(text), lower = base.toLowerCase();
  const occurs = p => lower.includes(p.toLowerCase());
  const sources = [...found.names.flatMap(n => namePatterns(n, occurs)), ...found.numbers.map(n => numberPattern(n, occurs)).filter(Boolean)];
  const words = new Set();
  for (const src of sources) for (const m of base.matchAll(new RegExp(src, "giu"))) words.add(m[0]);
  return [...words].sort((a, b) => a.localeCompare(b)).slice(0, 20);
}

async function lessonSnapshot(client, id) {
  const l = await one(client, `SELECT l.id,l.title,l.objective,l.content,l.course_id FROM lessons l WHERE l.id=$1`, [id]);
  if (!l) return null;
  const standards = await rows(client, `SELECT s.id,s.code,s.description FROM lesson_standards ls JOIN learning_standards s ON s.id=ls.standard_id
      WHERE ls.lesson_id=$1 ORDER BY s.code`, [id]);
  const sources = await rows(client, `SELECT ps.id AS "sourceId",ps.title,lsrc.prompts FROM lesson_sources lsrc JOIN primary_sources ps ON ps.id=lsrc.source_id
      WHERE lsrc.lesson_id=$1 ORDER BY lsrc.seq`, [id]);
  return { title: l.title, objective: l.objective, content: l.content, standards, sources, courseId: l.course_id };
}

/** The lesson or unit, if this person manages its course; and its snapshot. */
export async function source(client, kind, id) {
  if (kind === "lesson") {
    const l = await one(client, `SELECT l.id,c.subject,c.grade_level FROM lessons l JOIN courses c ON c.id=l.course_id WHERE l.id=$1 AND eduos_can_manage_course(l.course_id)`, [id]);
    if (!l) return null;
    const snap = await lessonSnapshot(client, id);
    const { courseId, ...body } = snap;
    return { title: body.title, subject: l.subject, grade: l.grade_level, body };
  }
  const u = await one(client, `SELECT u.id,u.title,u.summary,c.subject,c.grade_level FROM course_units u JOIN courses c ON c.id=u.course_id
      WHERE u.id=$1 AND eduos_can_manage_course(u.course_id)`, [id]);
  if (!u) return null;
  const lessons = [];
  for (const l of await rows(client, `SELECT id FROM lessons WHERE unit_id=$1 ORDER BY seq`, [id])) {
    const { courseId, ...body } = await lessonSnapshot(client, l.id);
    lessons.push(body);
  }
  if (!lessons.length) throw new HttpError(400, "unit_has_no_lessons");
  return { title: u.title, subject: u.subject, grade: u.grade_level, body: { title: u.title, summary: u.summary, lessons } };
}

export const textOf = (body, summary) => [summary, body.title, body.summary, body.objective, body.content,
  ...(body.lessons || []).flatMap(l => [l.title, l.objective, l.content, ...l.sources.flatMap(s => s.prompts)]),
  ...(body.sources || []).flatMap(s => s.prompts)].filter(Boolean).join("\n");

/** Copy one lesson snapshot into a unit the person manages, as a draft. */
export async function copyLesson(client, a, courseId, unitId, l, materialId) {
  const seq = (await one(client, `SELECT coalesce(max(seq),0)+1 AS n FROM lessons WHERE unit_id=$1`, [unitId])).n;
  if (seq > 200) throw new HttpError(409, "unit_full");
  const row = await one(client, `INSERT INTO lessons(district_id,course_id,unit_id,seq,title,objective,content,status,created_by,adapted_from)
      VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9) RETURNING id`, [a.districtId, courseId, unitId, seq, l.title, l.objective, l.content, a.userId, materialId]);
  for (const s of l.standards || [])
    if (await one(client, `SELECT 1 FROM learning_standards WHERE id=$1`, [s.id]))
      await client.query(`INSERT INTO lesson_standards(lesson_id,standard_id,district_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [row.id, s.id, a.districtId]);
  let n = 1;
  for (const s of l.sources || [])
    if (await one(client, `SELECT 1 FROM primary_sources WHERE id=$1 AND status='approved'`, [s.sourceId]))
      await client.query(`INSERT INTO lesson_sources(lesson_id,source_id,district_id,seq,prompts) VALUES($1,$2,$3,$4,$5)`, [row.id, s.sourceId, a.districtId, n++, s.prompts]);
  return row.id;
}

/** Put a snapshot in the library, or update the live share of the same source (version + 1). */
export async function publish(client, req, { kind, sourceId, src, summary, confirmed }) {
  const a = req.actor;
  const existing = await one(client, `SELECT id,version FROM shared_materials WHERE kind=$1 AND source_id=$2 AND status='shared'`, [kind, sourceId]);
  const m = existing
    ? await one(client, `UPDATE shared_materials SET title=$2,subject=$3,grade_level=$4,summary=$5,body=$6,version=version+1,updated_at=now()
        WHERE id=$1 RETURNING id,version`, [existing.id, src.title, src.subject, src.grade, summary?.trim() || null, src.body])
    : await one(client, `INSERT INTO shared_materials(district_id,school_id,author_user_id,kind,source_id,title,subject,grade_level,summary,body)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,version`,
        [a.districtId, a.schoolId, a.userId, kind, sourceId, src.title, src.subject, src.grade, summary?.trim() || null, src.body]);
  if (!m) throw new HttpError(403, "not_the_author");
  await audit(client, req, existing ? "update" : "share", "shared_material", m.id, `kind=${kind};version=${m.version}${confirmed ? ";confirmed_not_students" : ""}`);
  return { status: existing ? 200 : 201, body: { data: m } };
}

export function registerMaterialsRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: config.commsRateLimit, standardHeaders: true, legacyHeaders: false });
  const read = [requireSession, requirePermission("learning", "read"), only(READERS, "teacher_network_only")];
  const write = [limiter, requireSession, requireCsrf, requirePermission("learning", "teach"), only(AUTHORS, "teachers_and_principals_only")];

  app.get("/api/materials", ...read, async (req, res, next) => {
    const str = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
    const q = str(req.query.q, 80).replace(/[%_\\]/g, "\\$&"), subject = str(req.query.subject, 40), grade = str(req.query.grade, 4);
    const kind = ["lesson", "unit"].includes(req.query.kind) ? req.query.kind : null;
    try {
      const data = await withTenantTransaction(req.actor, client => rows(client, `SELECT m.id,m.kind,m.title,m.subject,m.grade_level,m.summary,m.version,m.status,m.updated_at,
            u.display_name AS author,s.name AS school,m.author_user_id=$1 AS mine,eduos_material_copies(m.id) AS copies,
            CASE WHEN m.kind='unit' THEN jsonb_array_length(m.body->'lessons') ELSE 1 END AS lessons
          FROM shared_materials m JOIN users u ON u.id=m.author_user_id JOIN schools s ON s.id=m.school_id
         WHERE m.status='shared' AND ($2='' OR m.title ILIKE '%'||$2||'%' OR m.summary ILIKE '%'||$2||'%' OR m.subject ILIKE '%'||$2||'%')
           AND ($3='' OR m.subject ILIKE $3) AND ($4='' OR m.grade_level=$4) AND ($5::text IS NULL OR m.kind=$5)
         ORDER BY m.updated_at DESC LIMIT 200`, [req.actor.userId, q, subject, grade, kind]));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/materials/:id", ...read, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const data = await withTenantTransaction(req.actor, client => one(client, `SELECT m.id,m.kind,m.title,m.subject,m.grade_level,m.summary,m.body,m.version,m.status,
            m.created_at,m.updated_at,u.display_name AS author,s.name AS school,m.author_user_id=$2 AS mine,eduos_material_copies(m.id) AS copies
          FROM shared_materials m JOIN users u ON u.id=m.author_user_id JOIN schools s ON s.id=m.school_id WHERE m.id=$1`, [req.params.id, req.actor.userId]));
      if (!data) return res.status(404).json({ error: "material_not_found" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Share (or update the share of) a lesson or unit you manage.
  app.post("/api/materials", ...write, async (req, res, next) => {
    const { kind, sourceId, summary = null, confirmNotStudents = false } = req.body || {};
    if (!["lesson", "unit"].includes(kind) || !validId(sourceId) || (summary !== null && !cleanText(summary, 500)) || typeof confirmNotStudents !== "boolean")
      return res.status(400).json({ error: "invalid_share" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const a = req.actor;
        const src = await source(client, kind, sourceId);
        if (!src) throw new HttpError(404, `${kind}_not_found`);
        const words = await studentWordsIn(client, a.districtId, textOf(src.body, summary));
        if (words.length && !confirmNotStudents) return { status: 409, body: { error: "may_mention_students", words } };
        return publish(client, req, { kind, sourceId, src, summary, confirmed: words.length > 0 });
      });
      res.status(out.status).json(out.body);
    } catch (e) { sendError(res, next, e); }
  });

  // Copy into your own course: a lesson into a unit, or a unit with its lessons.
  app.post("/api/materials/:id/copy", ...write, async (req, res, next) => {
    const { courseId, unitId = null } = req.body || {};
    if (!validId(req.params.id) || !validId(courseId) || (unitId !== null && !validId(unitId))) return res.status(400).json({ error: "invalid_copy" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const a = req.actor;
        const m = await one(client, `SELECT m.id,m.kind,m.title,m.body,m.version FROM shared_materials m WHERE m.id=$1 AND m.status='shared'`, [req.params.id]);
        if (!m) throw new HttpError(404, "material_not_found");
        const course = await one(client, `SELECT id FROM courses WHERE id=$1 AND eduos_can_manage_course(id)`, [courseId]);
        if (!course) throw new HttpError(404, "course_not_found");
        let created, lessons = [];
        if (m.kind === "lesson") {
          if (!unitId) throw new HttpError(400, "unit_required");
          if (!await one(client, `SELECT 1 FROM course_units WHERE id=$1 AND course_id=$2`, [unitId, course.id])) throw new HttpError(400, "unit_not_in_course");
          created = await copyLesson(client, a, course.id, unitId, m.body, m.id);
          lessons = [created];
        } else {
          const seq = (await one(client, `SELECT coalesce(max(seq),0)+1 AS n FROM course_units WHERE course_id=$1`, [course.id])).n;
          if (seq > 200) throw new HttpError(409, "course_full");
          created = (await one(client, `INSERT INTO course_units(district_id,course_id,seq,title,summary,adapted_from) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
            [a.districtId, course.id, seq, m.body.title, m.body.summary || null, m.id])).id;
          for (const l of m.body.lessons) lessons.push(await copyLesson(client, a, course.id, created, l, m.id));
        }
        await client.query(`INSERT INTO shared_material_copies(district_id,material_id,version,copied_by,course_id,created_id) VALUES($1,$2,$3,$4,$5,$6)`,
          [a.districtId, m.id, m.version, a.userId, course.id, created]);
        await audit(client, req, "copy", "shared_material", m.id, `kind=${m.kind};lessons=${lessons.length}`);
        return { kind: m.kind, id: created, lessonIds: lessons };
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  // The author withdraws; the author's school leader or the superintendent may too.
  app.post("/api/materials/:id/withdraw", limiter, requireSession, requireCsrf, only(READERS, "teacher_network_only"), async (req, res, next) => {
    const { reason = null } = req.body || {};
    if (!validId(req.params.id) || (reason !== null && !cleanText(reason, 500))) return res.status(400).json({ error: "invalid_withdraw" });
    try {
      const m = await withTenantTransaction(req.actor, async client => {
        const row = await one(client, `UPDATE shared_materials SET status='withdrawn',withdrawn_by=$2,withdrawn_at=now(),withdrawn_reason=$3,updated_at=now()
            WHERE id=$1 AND status='shared' AND (author_user_id=$2 OR eduos_is_moderator(school_id)) RETURNING id`, [req.params.id, req.actor.userId, reason?.trim() || null]);
        if (row) await audit(client, req, "withdraw", "shared_material", row.id, null);
        return row;
      });
      if (!m) return res.status(404).json({ error: "material_not_found" });
      res.json({ data: { withdrawn: true } });
    } catch (e) { sendError(res, next, e); }
  });
}
