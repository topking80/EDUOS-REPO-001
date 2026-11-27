// HSP-06 part 2: compliance profiles for homeschool families and private
// schools (db/168). The same routes exist under /api/homeschool and
// /api/private-school:
//
//   GET  …/compliance/templates                 published templates for this kind of tenant
//   GET  …/compliance?schoolYear=               the profile for that year, progress, checklist, deadlines
//   POST …/compliance {schoolYear, templateId} or {schoolYear, label, requirements}   adopt (family owner, school admin)
//   POST …/compliance/:id/end                   stop using it for that year
//   POST …/compliance/:id/retention {years}     how long you intend to keep records
//   PUT  …/compliance/:id/checklist/:key {status, learnerId?, doneOn?, evidenceRef?, note?}
//
// A planning aid: EduOS computes days and hours from the tenant's own
// attendance and records what the tenant says it has done. It doesn't decide
// compliance and files nothing with any agency.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { rows, one, validId, cleanText, HttpError } from "./role-app-util.js";
import { family, familyAudit } from "./homeschool-routes.js";
import { school, psAudit } from "./private-school-routes.js";
import { validateRequirements, schoolYearRange, deadlineDate, currentSchoolYear, DISCLAIMER } from "./compliance-requirements.js";

const SY = v => typeof v === "string" && /^\d{4}-\d{4}$/.test(v) && Number(v.slice(5)) === Number(v.slice(0, 4)) + 1;
const DAY = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const today = () => new Date().toISOString().slice(0, 10);
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : v;
const templateOut = t => ({ id: t.id, jurisdiction: t.jurisdiction, title: t.title, version: t.version, requirements: t.requirements, sources: t.sources,
  authority: { name: t.authority_name, url: t.authority_url }, effectiveFrom: ymd(t.effective_from), lastReviewedOn: ymd(t.last_reviewed_on), reviewedBy: t.reviewed_by, status: t.status });

function routes(app, base, wrap, kind) {
  const isFamily = kind === "homeschool_family";
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => `cmp:${req.actor?.userId}` });
  const tenant = req => isFamily ? { family: req.actor.familyId, school: null } : { family: null, school: req.actor.privateSchoolId };
  const audit = (c, req, action, id, detail) => isFamily ? familyAudit(c, req, action, "compliance_profile", id, detail) : psAudit(c, req, action, "compliance_profile", id, detail);
  const canAdopt = req => isFamily ? req.actor.familyRole === "owner" : req.actor.privateSchoolRole === "school_admin";
  const canCheck = req => isFamily ? ["owner", "co_educator"].includes(req.actor.familyRole) : ["school_admin", "registrar"].includes(req.actor.privateSchoolRole);
  const canRead = req => isFamily ? ["owner", "co_educator"].includes(req.actor.familyRole) : ["school_admin", "registrar", "campus_admin"].includes(req.actor.privateSchoolRole);
  const need = (ok, code) => { if (!ok) throw new HttpError(403, code); };

  async function progress(c, sy) {
    const { from, to } = schoolYearRange(sy);
    if (isFamily) return (await rows(c, `SELECT l.id, l.display_name,
        count(DISTINCT a.day) FILTER (WHERE a.kind <> 'absent' AND a.minutes > 0) AS days, coalesce(sum(a.minutes) FILTER (WHERE a.kind <> 'absent'), 0) AS minutes
        FROM family_learners l LEFT JOIN family_attendance a ON a.learner_id=l.id AND a.voided_at IS NULL AND a.day BETWEEN $1 AND $2
        WHERE l.status='active' GROUP BY l.id, l.display_name ORDER BY l.display_name`, [from, to]))
      .map(r => ({ learnerId: r.id, learner: r.display_name, days: Number(r.days), hours: Math.round(Number(r.minutes) / 6) / 10 }));
    const d = await one(c, "SELECT count(DISTINCT day)::int AS days FROM ps_attendance WHERE voided_at IS NULL AND day BETWEEN $1 AND $2", [from, to]);
    return [{ learnerId: null, learner: "School", days: d.days, hours: null, note: "Days with attendance taken" }];
  }

  app.get(`${base}/compliance/templates`, requireSession, wrap(async (c, req) => {
    need(canRead(req), "not_allowed");
    const j = /^US-[A-Z]{2}$/.test(req.query.jurisdiction ?? "") ? req.query.jurisdiction : null;
    return (await rows(c, "SELECT * FROM compliance_templates WHERE status='published' AND applies_to=$1 AND ($2::text IS NULL OR jurisdiction=$2) ORDER BY jurisdiction, version DESC", [kind, j])).map(templateOut);
  }));

  app.get(`${base}/compliance`, requireSession, wrap(async (c, req) => {
    need(canRead(req), "not_allowed");
    const sy = SY(req.query.schoolYear) ? req.query.schoolYear : currentSchoolYear();
    const p = await one(c, "SELECT p.*, t.title AS t_title, t.version, t.sources, t.authority_name, t.authority_url, t.last_reviewed_on, t.reviewed_by, t.effective_from, t.jurisdiction, t.status AS t_status FROM compliance_profiles p LEFT JOIN compliance_templates t ON t.id=p.template_id WHERE p.school_year=$1 AND p.status='active'", [sy]);
    if (!p) return { schoolYear: sy, profile: null, disclaimer: DISCLAIMER, canAdopt: canAdopt(req) };
    const r = p.requirements, checks = await rows(c, "SELECT * FROM compliance_checklist WHERE profile_id=$1", [p.id]);
    const learners = isFamily ? await rows(c, "SELECT id, display_name FROM family_learners WHERE status='active' ORDER BY display_name") : [];
    const state = (key, learnerId = null) => { const x = checks.find(k => k.item_key === key && (k.learner_id ?? null) === learnerId);
      return x ? { status: x.status, doneOn: ymd(x.done_on), evidenceRef: x.evidence_ref, note: x.note } : { status: "to_do" }; };
    const now = today(), soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const deadlines = (r.deadlines || []).map(d => { const due = deadlineDate(sy, d.month, d.day), s = state(d.key);
      return { key: d.key, label: d.label, note: d.note, due, ...s, flag: s.status !== "to_do" ? null : due < now ? "overdue" : due <= soon ? "due_soon" : null }; });
    const items = (list, perLearnerOk) => (list || []).map(x => ({ key: x.key, label: x.label, note: x.note, grades: x.grades,
      ...(perLearnerOk && x.perLearner && isFamily ? { perLearner: learners.map(l => ({ learnerId: l.id, learner: l.display_name, ...state(x.key, l.id) })) } : state(x.key)) }));
    const prog = await progress(c, sy);
    return { schoolYear: sy, disclaimer: DISCLAIMER, canAdopt: canAdopt(req), canCheck: canCheck(req),
      profile: { id: p.id, label: p.label, custom: !p.template_id, retentionYears: p.retention_years ?? r.retentionYears ?? null, adoptedAt: p.adopted_at,
        template: p.template_id ? { title: p.t_title, version: p.version, jurisdiction: p.jurisdiction, sources: p.sources, authority: { name: p.authority_name, url: p.authority_url },
          effectiveFrom: ymd(p.effective_from), lastReviewedOn: ymd(p.last_reviewed_on), reviewedBy: p.reviewed_by, retired: p.t_status === "retired" } : null,
        provenance: p.template_id ? `From the platform's template "${p.t_title}" (${p.version}), last reviewed ${ymd(p.last_reviewed_on)} by ${p.reviewed_by}. Copied when you adopted it.`
          : `Set by your ${isFamily ? "family" : "school"}. Not reviewed by EduOS.` },
      instruction: r.instruction ? { required: r.instruction, progress: prog.map(x => ({ ...x,
        daysMet: r.instruction.days ? x.days >= r.instruction.days : null, hoursMet: r.instruction.hours && x.hours != null ? x.hours >= r.instruction.hours : null })) } : { required: null, progress: prog },
      subjects: r.subjects || [], deadlines, documents: items(r.documents, true), assessments: items(r.assessments, false) };
  }));

  app.post(`${base}/compliance`, limiter, requireSession, requireCsrf, wrap(async (c, req) => {
    need(canAdopt(req), isFamily ? "family_owner_only" : "school_admin_only");
    const b = req.body || {};
    if (!SY(b.schoolYear)) throw new HttpError(400, "invalid_school_year");
    let requirements, label, templateId = null;
    if (b.templateId != null) {
      if (!validId(b.templateId)) throw new HttpError(400, "invalid_id");
      const t = await one(c, "SELECT * FROM compliance_templates WHERE id=$1 AND status='published' AND applies_to=$2", [b.templateId, kind]);
      if (!t) throw new HttpError(404, "template_not_found");
      requirements = t.requirements; label = `${t.title} (${t.version})`; templateId = t.id;
    } else {
      const v = validateRequirements(b.requirements);
      if (!v.ok) throw new HttpError(400, "invalid_requirements", { detail: v.error });
      if (!cleanText(b.label, 200, 3)) throw new HttpError(400, "label_required");
      requirements = b.requirements; label = b.label.trim();
    }
    if (await one(c, "SELECT 1 FROM compliance_profiles WHERE school_year=$1 AND status='active'", [b.schoolYear])) throw new HttpError(409, "already_have_a_profile_for_that_year");
    const t = tenant(req);
    const p = await one(c, `INSERT INTO compliance_profiles(tenant_kind, family_id, school_id, school_year, template_id, requirements, label, adopted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [kind, t.family, t.school, b.schoolYear, templateId, JSON.stringify(requirements), label, req.actor.userId]);
    await audit(c, req, "adopt", p.id, `${b.schoolYear};${templateId ? `template=${templateId}` : "custom"}`);
    return { id: p.id };
  }, 201));

  const profileOf = async (c, id) => {
    if (!validId(id)) throw new HttpError(400, "invalid_id");
    const p = await one(c, "SELECT * FROM compliance_profiles WHERE id=$1", [id]);
    if (!p) throw new HttpError(404, "profile_not_found");
    return p;
  };
  app.post(`${base}/compliance/:id/end`, limiter, requireSession, requireCsrf, wrap(async (c, req) => {
    need(canAdopt(req), isFamily ? "family_owner_only" : "school_admin_only");
    const p = await profileOf(c, req.params.id);
    if (p.status !== "active") throw new HttpError(409, "already_ended");
    await c.query("UPDATE compliance_profiles SET status='ended', ended_by=$2, ended_at=now() WHERE id=$1", [p.id, req.actor.userId]);
    await audit(c, req, "end", p.id, p.school_year);
    return { ended: true };
  }));
  app.post(`${base}/compliance/:id/retention`, limiter, requireSession, requireCsrf, wrap(async (c, req) => {
    need(canAdopt(req), isFamily ? "family_owner_only" : "school_admin_only");
    const p = await profileOf(c, req.params.id), y = req.body?.years;
    if (!(y === null || (Number.isInteger(y) && y >= 1 && y <= 100))) throw new HttpError(400, "invalid_years");
    await c.query("UPDATE compliance_profiles SET retention_years=$2 WHERE id=$1", [p.id, y]);
    await audit(c, req, "set_retention", p.id, String(y));
    return { retentionYears: y };
  }));
  app.put(`${base}/compliance/:id/checklist/:key`, limiter, requireSession, requireCsrf, wrap(async (c, req) => {
    need(canCheck(req), "not_allowed");
    const p = await profileOf(c, req.params.id), key = req.params.key, b = req.body || {};
    if (p.status !== "active") throw new HttpError(409, "profile_ended");
    const r = p.requirements, item = [...(r.deadlines || []), ...(r.documents || []), ...(r.assessments || [])].find(x => x.key === key);
    if (!item) throw new HttpError(404, "item_not_found");
    if (!["done", "not_applicable", "to_do"].includes(b.status) || (b.doneOn != null && (!DAY(b.doneOn) || b.doneOn > today())) || (b.evidenceRef != null && !cleanText(b.evidenceRef, 300, 2))
      || (b.note != null && (typeof b.note !== "string" || b.note.length > 500)) || (b.learnerId != null && !validId(b.learnerId)))
      throw new HttpError(400, "invalid_item", { hint: "status (done, not_applicable, to_do), doneOn, evidenceRef (where you keep it), note, learnerId (per-learner documents)" });
    const perLearner = isFamily && (r.documents || []).some(d => d.key === key && d.perLearner);
    if (perLearner !== (b.learnerId != null)) throw new HttpError(400, perLearner ? "learner_required" : "not_a_per_learner_item");
    if (b.learnerId && !(await one(c, "SELECT 1 FROM family_learners WHERE id=$1", [b.learnerId]))) throw new HttpError(404, "learner_not_found");
    const doneOn = b.status === "done" ? (b.doneOn ?? today()) : null, t = tenant(req);
    await c.query(`INSERT INTO compliance_checklist(profile_id, family_id, school_id, item_key, learner_id, status, done_on, evidence_ref, note, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (profile_id, item_key, coalesce(learner_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET status=EXCLUDED.status, done_on=EXCLUDED.done_on, evidence_ref=EXCLUDED.evidence_ref, note=EXCLUDED.note, recorded_by=EXCLUDED.recorded_by, recorded_at=now()`,
      [p.id, t.family, t.school, key, b.learnerId ?? null, b.status, doneOn, b.evidenceRef?.trim() ?? null, b.note ?? null, req.actor.userId]);
    await audit(c, req, "check", p.id, `${key};${b.status}${b.learnerId ? `;learner=${b.learnerId}` : ""}`);
    return { key, status: b.status, doneOn };
  }));
}

export function registerComplianceRoutes(app) {
  routes(app, "/api/homeschool", family, "homeschool_family");
  routes(app, "/api/private-school", school, "private_school");
}
