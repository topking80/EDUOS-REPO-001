// TEACH-03: co-writing lessons and units (db/103).
//
// A draft lives outside any course, so co-writers at different schools never
// share a course, a roster or a student. Any editor can bring in colleagues
// (teachers and principals in the district), save, copy the draft into their
// own course as drafts, or publish it to the library (TEACH-02).
//
// Saving: the editor sends the version they started from. If someone saved in
// between, their changes and this editor's are merged field by field (and
// lesson by lesson in a unit, src/draft-merge.js); if both changed the same
// thing, nothing is saved and the editor gets the current text to reconcile.
// Every save is a revision. Words that match a student in the district are
// returned as a warning on save, and block publishing until confirmed.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { enqueueNotifications } from "./notify.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { mergeDraft, cleanDraftBody, missingForCourse } from "./draft-merge.js";
import { planText } from "./coaching-plan.js";
import { colleagues } from "./teacher-network-routes.js";
import { source, copyLesson, studentWordsIn, textOf, publish } from "./materials-routes.js";

const WRITERS = ["teacher", "principal"];
const draftText = (kind, body, summary) => kind === "practice" || kind === "playbook" ? [summary, planText(body.title, body)].filter(Boolean).join("\n") : textOf(body, summary);
const onlyWriters = (req, res, next) => WRITERS.includes(req.actor?.role) ? next() : res.status(403).json({ error: "teachers_and_principals_only" });
const blank = kind => kind === "lesson" ? { title: "", objective: "", content: "", standards: [], sources: [] }
  : kind === "unit" ? { title: "", summary: null, lessons: [{ title: "", objective: "", content: "", standards: [], sources: [] }] }
  : { title: "", sport: "", summary: null, items: [{ kind: "drill", title: "", minutes: null, description: "", equipment: "" }] };

async function draftFor(client, id, { lock = false } = {}) {
  return one(client, `SELECT d.* FROM collab_drafts d WHERE d.id=$1 AND eduos_is_draft_editor(d.id)${lock ? " FOR UPDATE" : ""}`, [id]);
}

async function addEditors(client, a, draft, ids) {
  const found = await colleagues(client, a, { ids, limit: ids.length });
  if (found.length !== ids.length) throw new HttpError(403, "editor_not_in_network");
  for (const c of found)
    await client.query(`INSERT INTO collab_draft_editors(draft_id,district_id,user_id,added_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(draft_id,user_id) DO UPDATE SET left_at=NULL`, [draft.id, a.districtId, c.user_id, a.userId]);
  if (found.length) await enqueueNotifications(client, { districtId: a.districtId, schoolId: draft.school_id, recipients: found.map(c => c.user_id),
    kind: "message", title: `You were invited to co-write: ${(draft.title || "a draft").slice(0, 100)}`, body: null, refType: "collab_draft", refId: draft.id });
  return found.length;
}

export function registerDraftsRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: Math.max(60, config.commsRateLimit), standardHeaders: true, legacyHeaders: false });
  const read = [requireSession, requirePermission("learning", "read"), onlyWriters];
  const write = [limiter, requireSession, requireCsrf, requirePermission("learning", "teach"), onlyWriters];

  app.get("/api/drafts", ...read, async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, client => rows(client, `SELECT d.id,d.kind,d.title,d.subject,d.grade_level,d.version,d.updated_at,
            u.display_name AS updated_by,
            (SELECT string_agg(eu.display_name, ', ' ORDER BY eu.display_name) FROM collab_draft_editors e JOIN users eu ON eu.id=e.user_id
              WHERE e.draft_id=d.id AND e.left_at IS NULL AND e.user_id<>$1) AS with_names
          FROM collab_drafts d JOIN users u ON u.id=d.updated_by WHERE eduos_is_draft_editor(d.id) ORDER BY d.updated_at DESC LIMIT 200`, [req.actor.userId]));
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Start a draft: blank, from a lesson or unit you manage, or from the library.
  app.post("/api/drafts", ...write, async (req, res, next) => {
    const { from, kind = null, sourceId = null, title = "", subject, gradeLevel } = req.body || {};
    if (!["blank", "lesson", "unit", "material", "plan"].includes(from) || (from === "blank" && (!["lesson", "unit", "practice", "playbook"].includes(kind) || !cleanText(subject, 40) || !cleanText(gradeLevel, 4)))
        || (from !== "blank" && !validId(sourceId)) || (title && !cleanText(title, 120))) return res.status(400).json({ error: "invalid_draft" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const a = req.actor;
        let d;
        if (from === "blank") d = { kind, subject: subject.trim(), grade: gradeLevel.trim(), body: { ...blank(kind), title: title.trim(), ...(kind === "practice" || kind === "playbook" ? { sport: subject.trim() } : {}) } };
        else if (from === "plan") {
          const p = await one(client, `SELECT kind,title,sport,level,body FROM coaching_plans WHERE id=$1 AND archived_at IS NULL`, [sourceId]);
          if (!p) throw new HttpError(404, "plan_not_found");
          d = { kind: p.kind, subject: p.sport, grade: p.level, body: { title: p.title, sport: p.sport, ...p.body } };
        }
        else if (from === "material") {
          const m = await one(client, `SELECT kind,subject,grade_level,body FROM shared_materials WHERE id=$1 AND status='shared'`, [sourceId]);
          if (!m) throw new HttpError(404, "material_not_found");
          d = { kind: m.kind, subject: m.subject, grade: m.grade_level, body: m.body };
        } else {
          const src = await source(client, from, sourceId);
          if (!src) throw new HttpError(404, `${from}_not_found`);
          d = { kind: from, subject: src.subject, grade: src.grade, body: src.body };
        }
        const body = cleanDraftBody(d.kind, d.body);
        if (!body) throw new HttpError(400, "invalid_draft");
        const label = body.title.trim() || "Untitled";
        const row = await one(client, `INSERT INTO collab_drafts(district_id,school_id,kind,title,subject,grade_level,body,created_by,updated_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id,version`, [a.districtId, a.schoolId, d.kind, label, d.subject, d.grade, body, a.userId]);
        await client.query(`INSERT INTO collab_draft_editors(draft_id,district_id,user_id,added_by) VALUES($1,$2,$3,$3)`, [row.id, a.districtId, a.userId]);
        await client.query(`INSERT INTO collab_draft_revisions(draft_id,district_id,version,title,body,edited_by) VALUES($1,$2,1,$3,$4,$5)`, [row.id, a.districtId, label, body, a.userId]);
        await audit(client, req, "create", "collab_draft", row.id, `kind=${d.kind};from=${from}`);
        return row;
      });
      res.status(201).json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/drafts/:id", ...read, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const d = await draftFor(client, req.params.id);
        if (!d) return null;
        const editors = await rows(client, `SELECT e.user_id,u.display_name AS name,s.name AS school FROM collab_draft_editors e JOIN users u ON u.id=e.user_id
            LEFT JOIN LATERAL (SELECT sc.name FROM memberships m JOIN schools sc ON sc.id=m.school_id WHERE m.user_id=e.user_id AND m.district_id=e.district_id
              AND m.status='active' AND m.role IN ('teacher','principal') ORDER BY m.is_default DESC LIMIT 1) s ON true
            WHERE e.draft_id=$1 AND e.left_at IS NULL ORDER BY e.added_at`, [d.id]);
        const revisions = await rows(client, `SELECT r.version,u.display_name AS edited_by,r.edited_at,r.merged FROM collab_draft_revisions r JOIN users u ON u.id=r.edited_by
            WHERE r.draft_id=$1 ORDER BY r.version DESC LIMIT 30`, [d.id]);
        const updatedBy = await one(client, `SELECT display_name FROM users WHERE id=$1`, [d.updated_by]);
        return { id: d.id, kind: d.kind, title: d.title, subject: d.subject, gradeLevel: d.grade_level, body: d.body, version: d.version,
          updatedAt: d.updated_at, updatedBy: updatedBy?.display_name, editors, revisions };
      });
      if (!data) return res.status(404).json({ error: "draft_not_found" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/drafts/:id/revisions/:version", ...read, async (req, res, next) => {
    const v = Number(req.params.version);
    if (!validId(req.params.id) || !Number.isInteger(v) || v < 1) return res.status(400).json({ error: "invalid_revision" });
    try {
      const data = await withTenantTransaction(req.actor, client => one(client, `SELECT r.version,r.title,r.body,r.edited_at,u.display_name AS edited_by,r.merged
          FROM collab_draft_revisions r JOIN users u ON u.id=r.edited_by WHERE r.draft_id=$1 AND r.version=$2`, [req.params.id, v]));
      if (!data) return res.status(404).json({ error: "revision_not_found" });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Save. baseVersion is the version this editor started from.
  app.put("/api/drafts/:id", ...write, async (req, res, next) => {
    const { baseVersion, body: raw } = req.body || {};
    if (!validId(req.params.id) || !Number.isInteger(baseVersion) || baseVersion < 1) return res.status(400).json({ error: "invalid_save" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const a = req.actor;
        const d = await draftFor(client, req.params.id, { lock: true });
        if (!d) throw new HttpError(404, "draft_not_found");
        const mine = cleanDraftBody(d.kind, raw);
        if (!mine) throw new HttpError(400, "invalid_draft_body");
        let body = mine, merged = false;
        if (baseVersion !== d.version) {
          if (baseVersion > d.version) throw new HttpError(400, "invalid_save");
          const base = await one(client, `SELECT body FROM collab_draft_revisions WHERE draft_id=$1 AND version=$2`, [d.id, baseVersion]);
          const m = mergeDraft(d.kind, base?.body, mine, d.body);
          if (m.conflicts.length) {
            const by = await one(client, `SELECT display_name FROM users WHERE id=$1`, [d.updated_by]);
            return { status: 409, body: { error: "edit_conflict", conflicts: m.conflicts, current: { version: d.version, body: d.body, updatedBy: by?.display_name, updatedAt: d.updated_at } } };
          }
          body = m.body; merged = true;
        }
        const label = body.title.trim() || "Untitled";
        const saved = await one(client, `UPDATE collab_drafts SET title=$2,body=$3,version=version+1,updated_by=$4,updated_at=now() WHERE id=$1 RETURNING version,updated_at`,
          [d.id, label, body, a.userId]);
        await client.query(`INSERT INTO collab_draft_revisions(draft_id,district_id,version,title,body,edited_by,merged) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [d.id, a.districtId, saved.version, label, body, a.userId, merged]);
        const warnings = await studentWordsIn(client, a.districtId, draftText(d.kind, body, null));
        await audit(client, req, "update", "collab_draft", d.id, `version=${saved.version}${merged ? ";merged" : ""}`);
        return { status: 200, body: { data: { version: saved.version, merged, body, warnings } } };
      });
      res.status(out.status).json(out.body);
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/drafts/:id/editors", ...write, async (req, res, next) => {
    const ids = Array.isArray(req.body?.userIds) && req.body.userIds.length >= 1 && req.body.userIds.length <= 20 && req.body.userIds.every(validId) ? [...new Set(req.body.userIds)] : null;
    if (!validId(req.params.id) || !ids) return res.status(400).json({ error: "invalid_editors" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const d = await draftFor(client, req.params.id);
        if (!d) throw new HttpError(404, "draft_not_found");
        const added = await addEditors(client, req.actor, d, ids.filter(id => id !== req.actor.userId));
        await audit(client, req, "add_editors", "collab_draft", d.id, `added=${added}`);
        return { added };
      });
      res.json({ data: out });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/drafts/:id/leave", ...write, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    try {
      const n = await withTenantTransaction(req.actor, async client => {
        const r = await client.query(`UPDATE collab_draft_editors SET left_at=now() WHERE draft_id=$1 AND user_id=$2 AND left_at IS NULL`, [req.params.id, req.actor.userId]);
        if (r.rowCount) await audit(client, req, "leave", "collab_draft", req.params.id, null);
        return r.rowCount;
      });
      if (!n) return res.status(404).json({ error: "not_an_editor" });
      res.json({ data: { left: true } });
    } catch (e) { sendError(res, next, e); }
  });

  // Into your own course, as drafts the school leader still approves.
  app.post("/api/drafts/:id/copy", ...write, async (req, res, next) => {
    const { courseId = null, unitId = null } = req.body || {};
    if (!validId(req.params.id) || (courseId !== null && !validId(courseId)) || (unitId !== null && !validId(unitId))) return res.status(400).json({ error: "invalid_copy" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const a = req.actor;
        const d = await draftFor(client, req.params.id);
        if (!d) throw new HttpError(404, "draft_not_found");
        const gaps = missingForCourse(d.kind, d.body);
        if (gaps.length) return { status: 409, body: { error: "draft_incomplete", missing: gaps } };
        if (d.kind === "practice" || d.kind === "playbook") {
          const { title, sport, ...plan } = d.body;
          const p = await one(client, `INSERT INTO coaching_plans(district_id,owner_user_id,kind,title,sport,level,body) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [a.districtId, a.userId, d.kind, title.trim(), sport.trim(), d.grade_level, plan]);
          await audit(client, req, "copy", "collab_draft", d.id, `kind=${d.kind};version=${d.version};into=coaching_plan`);
          return { status: 201, body: { data: { kind: d.kind, id: p.id } } };
        }
        if (!courseId) throw new HttpError(400, "invalid_copy");
        const course = await one(client, `SELECT id FROM courses WHERE id=$1 AND eduos_can_manage_course(id)`, [courseId]);
        if (!course) throw new HttpError(404, "course_not_found");
        let created;
        if (d.kind === "lesson") {
          if (!unitId) throw new HttpError(400, "unit_required");
          if (!await one(client, `SELECT 1 FROM course_units WHERE id=$1 AND course_id=$2`, [unitId, course.id])) throw new HttpError(400, "unit_not_in_course");
          created = await copyLesson(client, a, course.id, unitId, d.body, null);
        } else {
          const seq = (await one(client, `SELECT coalesce(max(seq),0)+1 AS n FROM course_units WHERE course_id=$1`, [course.id])).n;
          if (seq > 200) throw new HttpError(409, "course_full");
          created = (await one(client, `INSERT INTO course_units(district_id,course_id,seq,title,summary) VALUES($1,$2,$3,$4,$5) RETURNING id`,
            [a.districtId, course.id, seq, d.body.title, d.body.summary || null])).id;
          for (const l of d.body.lessons) await copyLesson(client, a, course.id, created, l, null);
        }
        await audit(client, req, "copy", "collab_draft", d.id, `kind=${d.kind};version=${d.version}`);
        return { status: 201, body: { data: { kind: d.kind, id: created } } };
      });
      res.status(out.status).json(out.body);
    } catch (e) { sendError(res, next, e); }
  });

  // Publish to the library (TEACH-02); publishing again updates that share.
  app.post("/api/drafts/:id/publish", ...write, async (req, res, next) => {
    const { summary = null, confirmNotStudents = false } = req.body || {};
    if (!validId(req.params.id) || (summary !== null && !cleanText(summary, 500)) || typeof confirmNotStudents !== "boolean") return res.status(400).json({ error: "invalid_publish" });
    try {
      const out = await withTenantTransaction(req.actor, async client => {
        const d = await draftFor(client, req.params.id);
        if (!d) throw new HttpError(404, "draft_not_found");
        const gaps = missingForCourse(d.kind, d.body);
        if (gaps.length) return { status: 409, body: { error: "draft_incomplete", missing: gaps } };
        const words = await studentWordsIn(client, req.actor.districtId, draftText(d.kind, d.body, summary));
        if (words.length && !confirmNotStudents) return { status: 409, body: { error: "may_mention_students", words } };
        return publish(client, req, { kind: d.kind, sourceId: d.id, src: { title: d.title, subject: d.subject, grade: d.grade_level, body: d.body }, summary, confirmed: words.length > 0 });
      });
      res.status(out.status).json(out.body);
    } catch (e) { sendError(res, next, e); }
  });
}
