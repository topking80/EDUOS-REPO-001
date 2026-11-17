// EduOS 37.6.0 enrollment funnel (deck p47): inquiry -> application ->
// documents -> review -> offer -> accept -> enrolled (creates the student and
// the guardian link), with a waitlist and new-student seats per school/grade.
//
// Families apply from their own signed-in parent account and see only their
// own applications. School leaders (principal for their school,
// superintendent for all) run the pipeline board. Documents are PDF/PNG/JPEG
// (magic bytes checked), at most 2 MB, readable only by the applying guardian
// and that school's leaders, and purged on the retention schedule
// (RETENTION_ENROLLMENT_DOCUMENT_DAYS, default 90, after the decision).
import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { enqueueNotifications, registerNotificationKind } from "./notify.js";
import { audit, rows, one, validId, HttpError } from "./role-app-util.js";
import { wrap, created, need, str, isoDate } from "./route-helpers.js";
import * as M from "./enrollment-model.js";

const LEADS = ["principal", "superintendent"];
registerNotificationKind("enrollment");
const ENROLLMENT_RATE_LIMIT = (() => {
  const v = Number(process.env.ENROLLMENT_RATE_LIMIT_PER_MIN || 30);
  if (!Number.isInteger(v) || v < 1 || v > 100000) throw new Error("ENROLLMENT_RATE_LIMIT_PER_MIN must be an integer from 1 to 100000");
  return v;
})();
const appView = (a, { family }) => ({
  id: a.id, schoolId: a.school_id, schoolName: a.school_name, schoolYear: a.school_year, grade: a.grade_level, status: a.status,
  statusLabel: M.LABELS[a.status], source: a.source, child: { firstName: a.child_first_name, lastName: a.child_last_name, birthDate: a.child_birth_date },
  guardian: { name: a.guardian_name, email: a.guardian_email, phone: a.guardian_phone, hasAccount: Boolean(a.guardian_user_id) },
  waitlistPosition: a.waitlist_position == null ? null : Number(a.waitlist_position), offerExpiresOn: a.offer_expires_on,
  studentId: a.student_id, submittedAt: a.submitted_at, createdAt: a.created_at, updatedAt: a.updated_at,
  documents: a.documents == null ? undefined : Number(a.documents), nextActions: M.nextActions(a.status, { family })
});
const APP_SQL = `SELECT a.*, sc.name AS school_name,
    (SELECT count(*) FROM enrollment_documents d WHERE d.application_id=a.id) AS documents,
    CASE WHEN a.status='waitlisted' THEN (SELECT count(*) FROM enrollment_applications w WHERE w.school_id=a.school_id AND w.school_year=a.school_year
       AND w.grade_level=a.grade_level AND w.status='waitlisted' AND w.waitlist_seq<=a.waitlist_seq) END AS waitlist_position
  FROM enrollment_applications a JOIN schools sc ON sc.id=a.school_id`;

async function appFor(client, id) {
  need(validId(id), 400, "invalid_application_id");
  const a = await one(client, `${APP_SQL} WHERE a.id=$1`, [id]);
  need(a, 404, "application_not_found");
  return a;
}
async function seats(client, a) {
  const s = await one(client, `SELECT * FROM eduos_enrollment_seats($1,$2,$3)`, [a.school_id, a.school_year, a.grade_level]);
  return { seats: s?.seats ?? null, committed: Number(s?.committed || 0), waitlisted: Number(s?.waitlisted || 0) };
}
async function principals(client, schoolId) {
  return (await rows(client, `SELECT user_id FROM memberships WHERE school_id=$1 AND role='principal' AND status='active'`, [schoolId])).map(r => r.user_id);
}

/** Apply one status change (family or staff), with seat + waitlist rules. */
async function transition(client, req, a, to, note) {
  const family = req.actor.role === "parent";
  need(M.canTransition(a.status, to, { family }), 409, "transition_not_allowed", { from: a.status, to, allowed: M.nextActions(a.status, { family }) });
  if (to === "offered") {
    const s = await seats(client, a);
    const st = M.seatState(s);
    need(!st.full, 409, "no_seats_left_use_waitlist", { seats: s.seats, committed: s.committed });
  }
  if (to === "documents" || to === "review") {
    // Documents stage needs at least one document before review (family side).
    if (family && to === "review") need(Number(a.documents) > 0, 409, "upload_a_document_first");
  }
  const sets = ["status=$2"], params = [a.id, to];
  if (to === "waitlisted") sets.push("waitlist_seq=nextval('enrollment_waitlist_seq')"); else sets.push("waitlist_seq=NULL");
  if (to === "applied") sets.push("submitted_at=coalesce(submitted_at, now())");
  if (to === "offered") sets.push("offer_expires_on=current_date + 14");
  if (["declined", "withdrawn", "accepted"].includes(to)) sets.push("decided_at=now()");
  await client.query(`UPDATE enrollment_applications SET ${sets.join(", ")} WHERE id=$1`, params);
  await client.query(`INSERT INTO enrollment_events(district_id,application_id,from_status,to_status,note,actor_user_id,actor_role) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [req.actor.districtId, a.id, a.status, to, note, req.actor.userId, req.actor.role]);
  const childFirst = a.child_first_name;
  if (!family && a.guardian_user_id) {
    const text = { documents: "Please upload the requested documents.", offered: "A seat is offered. Please accept or decline in the app.",
      waitlisted: "Your application is on the waitlist.", declined: "Please see the app for details.", review: "Your application is being reviewed.",
      accepted: "Enrollment is being completed by the school." }[to] || `Status: ${M.LABELS[to]}.`;
    await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: a.school_id, recipients: [a.guardian_user_id], kind: "enrollment",
      title: `Enrollment for ${childFirst}: ${M.LABELS[to]}`, body: text, refType: "enrollment_application", refId: a.id });
  }
  if (family && ["applied", "review", "accepted", "declined", "withdrawn"].includes(to)) {
    await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: a.school_id, recipients: await principals(client, a.school_id), kind: "enrollment",
      title: `Enrollment: ${M.LABELS[to]} (${a.grade_level === "K" ? "Kindergarten" : `grade ${a.grade_level}`}, ${a.school_year})`, body: "Open the enrollment board for details.",
      refType: "enrollment_application", refId: a.id });
  }
  await audit(client, req, `status.${to}`, "enrollment_application", a.id, `${a.status}->${to}`);
}

export function registerEnrollmentRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: ENROLLMENT_RATE_LIMIT, standardHeaders: true, legacyHeaders: false });
  const docBody = express.raw({ type: () => true, limit: M.DOC_MAX_BYTES });
  const familyOrLead = (req, res, next) => (req.actor && (req.actor.role === "parent" || LEADS.includes(req.actor.role))) ? next() : res.status(403).json({ error: "forbidden" });

  // ---- options for the family form ----
  app.get("/api/enrollment/options", requireSession, requirePermission("enrollment", "apply"), wrap(async client => {
    const y = new Date().getUTCFullYear(), m = new Date().getUTCMonth();
    const start = m >= 6 ? y + 1 : y;
    return { schools: await rows(client, `SELECT id,name FROM schools WHERE status='active' ORDER BY name`),
      schoolYears: [`${start}-${String((start + 1) % 100).padStart(2, "0")}`, `${start - 1}-${String(start % 100).padStart(2, "0")}`],
      grades: ["PK", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"], documentKinds: M.DOC_KINDS.map(k => ({ id: k, label: M.DOC_LABELS[k] })) };
  }));

  // ---- family: my applications ----
  app.get("/api/enrollment/mine", requireSession, requirePermission("enrollment", "apply"), wrap(async (client, req) => {
    const list = await rows(client, `${APP_SQL} WHERE a.guardian_user_id=$1 ORDER BY a.created_at DESC`, [req.actor.userId]);
    const out = [];
    for (const a of list) {
      const v = appView(a, { family: true });
      v.events = await rows(client, `SELECT to_status,note,at FROM enrollment_events WHERE application_id=$1 ORDER BY at`, [a.id]);
      v.files = await rows(client, `SELECT id,kind,filename,bytes,status,uploaded_at FROM enrollment_documents WHERE application_id=$1 ORDER BY uploaded_at`, [a.id]);
      out.push(v);
    }
    await audit(client, req, "read", "enrollment_application", null, `mine=${out.length}`);
    return { applications: out, stages: M.STAGES.map(s => ({ id: s, label: M.LABELS[s] })) };
  }));
  app.post("/api/enrollment/applications", limiter, requireSession, requireCsrf, requirePermission("enrollment", "apply"), wrap(async (client, req) => {
    const b = req.body || {};
    need(validId(b.schoolId) && M.SCHOOL_YEAR.test(b.schoolYear || "") && M.GRADE.test(b.gradeLevel || ""), 400, "invalid_school_year_or_grade");
    need(await one(client, `SELECT 1 FROM schools WHERE id=$1 AND status='active'`, [b.schoolId]), 404, "school_not_found");
    need(b.childBirthDate == null || b.childBirthDate === "" || isoDate(b.childBirthDate), 400, "invalid_birth_date");
    const me = await one(client, `SELECT display_name,email FROM users WHERE id=$1`, [req.actor.userId]);
    const phone = str(b.guardianPhone, 30, { optional: true });
    need(phone == null || /^[0-9 ()+.-]{7,30}$/.test(phone), 400, "invalid_phone");
    const status = b.submit === false ? "inquiry" : "applied";
    const r = await one(client, `INSERT INTO enrollment_applications(district_id,school_id,school_year,grade_level,status,source,child_first_name,child_last_name,child_birth_date,
        guardian_user_id,guardian_name,guardian_email,guardian_phone,submitted_at,created_by) VALUES($1,$2,$3,$4,$5,'family',$6,$7,$8,$9,$10,$11,$12,$13,$9) RETURNING id`,
      [req.actor.districtId, b.schoolId, b.schoolYear, b.gradeLevel, status, str(b.childFirstName, 80), str(b.childLastName, 80), b.childBirthDate || null,
       req.actor.userId, me.display_name, me.email || null, phone, status === "applied" ? new Date() : null]);
    await client.query(`INSERT INTO enrollment_events(district_id,application_id,from_status,to_status,note,actor_user_id,actor_role) VALUES($1,$2,NULL,$3,$4,$5,'parent')`,
      [req.actor.districtId, r.id, status, status === "applied" ? "Application submitted by family" : "Inquiry started by family", req.actor.userId]);
    if (status === "applied") await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: b.schoolId, recipients: await principals(client, b.schoolId), kind: "enrollment",
      title: `New enrollment application (${b.gradeLevel === "K" ? "Kindergarten" : `grade ${b.gradeLevel}`}, ${b.schoolYear})`, body: "Open the enrollment board to review it.", refType: "enrollment_application", refId: r.id });
    await audit(client, req, "create", "enrollment_application", r.id, status);
    return created({ id: r.id, status });
  }));

  // ---- staff: pipeline board ----
  app.get("/api/enrollment/board", requireSession, requirePermission("enrollment", "manage"), wrap(async (client, req) => {
    const schoolId = req.actor.role === "principal" ? req.actor.schoolId : (validId(req.query.schoolId) ? req.query.schoolId : null);
    const years = await rows(client, `SELECT DISTINCT school_year FROM enrollment_applications WHERE ($1::uuid IS NULL OR school_id=$1)
        UNION SELECT DISTINCT school_year FROM enrollment_capacity WHERE ($1::uuid IS NULL OR school_id=$1) ORDER BY 1 DESC`, [schoolId]);
    const year = M.SCHOOL_YEAR.test(req.query.year || "") ? req.query.year : years[0]?.school_year || null;
    const list = year ? await rows(client, `${APP_SQL} WHERE a.school_year=$1 AND ($2::uuid IS NULL OR a.school_id=$2) ORDER BY a.created_at`, [year, schoolId]) : [];
    const cap = year ? await rows(client, `SELECT c.school_id, sc.name AS school_name, c.grade_level, c.seats FROM enrollment_capacity c JOIN schools sc ON sc.id=c.school_id
        WHERE c.school_year=$1 AND ($2::uuid IS NULL OR c.school_id=$2) ORDER BY sc.name, CASE c.grade_level WHEN 'PK' THEN -1 WHEN 'K' THEN 0 ELSE c.grade_level::int END`, [year, schoolId]) : [];
    const capacity = cap.map(c => {
      const mine = list.filter(a => a.school_id === c.school_id && a.grade_level === c.grade_level);
      const committed = mine.filter(a => ["offered", "accepted", "enrolled"].includes(a.status)).length;
      return { schoolId: c.school_id, schoolName: c.school_name, grade: c.grade_level, seats: c.seats, committed, waitlisted: mine.filter(a => a.status === "waitlisted").length,
        ...M.seatState({ seats: c.seats, committed }) };
    });
    const columns = M.STATUSES.map(s => ({ id: s, label: M.LABELS[s], items: list.filter(a => a.status === s).map(a => appView(a, { family: false })) }));
    await audit(client, req, "read", "enrollment_board", schoolId, `year=${year} apps=${list.length}`);
    return { year, years: years.map(y => y.school_year), schoolId, columns, capacity };
  }));
  app.get("/api/enrollment/applications/:id", requireSession, familyOrLead, wrap(async (client, req) => {
    const a = await appFor(client, req.params.id);
    const family = req.actor.role === "parent";
    const v = appView(a, { family });
    v.events = await rows(client, `SELECT e.from_status,e.to_status,e.note,e.at,e.actor_role FROM enrollment_events e WHERE e.application_id=$1 ORDER BY e.at`, [a.id]);
    v.files = await rows(client, `SELECT id,kind,filename,mime,bytes,sha256,status,review_note,uploaded_at FROM enrollment_documents WHERE application_id=$1 ORDER BY uploaded_at`, [a.id]);
    if (!family) v.seats = { ...(await seats(client, a)) };
    await audit(client, req, "read", "enrollment_application", a.id);
    return v;
  }));
  app.post("/api/enrollment/inquiries", limiter, requireSession, requireCsrf, requirePermission("enrollment", "manage"), wrap(async (client, req) => {
    const b = req.body || {};
    const schoolId = req.actor.role === "principal" ? req.actor.schoolId : b.schoolId;
    need(validId(schoolId) && M.SCHOOL_YEAR.test(b.schoolYear || "") && M.GRADE.test(b.gradeLevel || ""), 400, "invalid_school_year_or_grade");
    const email = str(b.guardianEmail, 320, { optional: true });
    need(email == null || /^[^\s@]+@[^\s@]+$/.test(email), 400, "invalid_email");
    const phone = str(b.guardianPhone, 30, { optional: true });
    need(phone == null || /^[0-9 ()+.-]{7,30}$/.test(phone), 400, "invalid_phone");
    const r = await one(client, `INSERT INTO enrollment_applications(district_id,school_id,school_year,grade_level,status,source,child_first_name,child_last_name,
        guardian_name,guardian_email,guardian_phone,created_by) VALUES($1,$2,$3,$4,'inquiry','staff',$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.actor.districtId, schoolId, b.schoolYear, b.gradeLevel, str(b.childFirstName, 80), str(b.childLastName, 80), str(b.guardianName, 120), email, phone, req.actor.userId]);
    await client.query(`INSERT INTO enrollment_events(district_id,application_id,from_status,to_status,note,actor_user_id,actor_role) VALUES($1,$2,NULL,'inquiry',$3,$4,$5)`,
      [req.actor.districtId, r.id, str(b.note, 500, { optional: true }) || "Inquiry entered by school office", req.actor.userId, req.actor.role]);
    await audit(client, req, "create", "enrollment_inquiry", r.id);
    return created({ id: r.id });
  }));
  app.put("/api/enrollment/capacity", limiter, requireSession, requireCsrf, requirePermission("enrollment", "manage"), wrap(async (client, req) => {
    const b = req.body || {};
    const schoolId = req.actor.role === "principal" ? req.actor.schoolId : b.schoolId;
    need(validId(schoolId) && M.SCHOOL_YEAR.test(b.schoolYear || "") && M.GRADE.test(b.gradeLevel || ""), 400, "invalid_school_year_or_grade");
    need(Number.isInteger(b.seats) && b.seats >= 0 && b.seats <= 5000, 400, "invalid_seats");
    await client.query(`INSERT INTO enrollment_capacity(district_id,school_id,school_year,grade_level,seats,updated_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (district_id,school_id,school_year,grade_level) DO UPDATE SET seats=EXCLUDED.seats, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [req.actor.districtId, schoolId, b.schoolYear, b.gradeLevel, b.seats, req.actor.userId]);
    await audit(client, req, "capacity.set", "enrollment_capacity", schoolId, `${b.schoolYear} ${b.gradeLevel}=${b.seats}`);
    return { ok: true };
  }));

  // ---- status changes (family or staff, model + SQL trigger both check) ----
  app.post("/api/enrollment/applications/:id/status", limiter, requireSession, requireCsrf, familyOrLead, wrap(async (client, req) => {
    const a = await appFor(client, req.params.id);
    const to = String(req.body?.to || "");
    need(M.STATUSES.includes(to) && to !== "enrolled", 400, "invalid_status");
    await transition(client, req, a, to, str(req.body?.note, 500, { optional: true }));
    return { id: a.id, status: to };
  }));
  app.post("/api/enrollment/applications/:id/enroll", limiter, requireSession, requireCsrf, requirePermission("enrollment", "manage"), wrap(async (client, req) => {
    const a = await appFor(client, req.params.id);
    need(a.status === "accepted", 409, "only_accepted_offers_can_be_enrolled");
    let number = req.body?.studentNumber ? str(req.body.studentNumber, 40) : null;
    if (!number) {
      // Random, not counted: a principal can't see other schools' numbers.
      number = `ENR-${a.school_year.slice(0, 4)}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    }
    need(/^[A-Za-z0-9-]{3,40}$/.test(number), 400, "invalid_student_number");
    const sid = (await one(client, `SELECT eduos_enrollment_complete($1,$2) AS id`, [a.id, number])).id;
    if (a.guardian_user_id) await enqueueNotifications(client, { districtId: req.actor.districtId, schoolId: a.school_id, recipients: [a.guardian_user_id], kind: "enrollment",
      title: `${a.child_first_name} is enrolled`, body: `Welcome to ${a.school_name}! ${a.child_first_name} now appears in your EduOS app.`, refType: "enrollment_application", refId: a.id });
    await audit(client, req, "enroll", "enrollment_application", a.id, `student=${sid}`);
    return { studentId: sid, studentNumber: number, guardianLinked: Boolean(a.guardian_user_id),
      nextStep: a.guardian_user_id ? null : "Invite the guardian from Students > Guardian invitations so they can see this learner." };
  }));

  // ---- documents ----
  app.post("/api/enrollment/applications/:id/documents", limiter, requireSession, requireCsrf, familyOrLead,
    (req, res, next) => docBody(req, res, err => err ? res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "document_too_large" : "invalid_body", maxBytes: M.DOC_MAX_BYTES }) : next()),
    wrap(async (client, req) => {
      const a = await appFor(client, req.params.id);
      need(["inquiry", "applied", "documents", "review"].includes(a.status), 409, "documents_closed_for_this_application");
      const kind = String(req.query.kind || "");
      need(M.DOC_KINDS.includes(kind), 400, "invalid_document_kind");
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      need(buf.length > 0, 400, "empty_document");
      const sniffed = M.sniffDocument(buf);
      const declared = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      need(sniffed && sniffed === declared, 415, "pdf_png_or_jpeg_only");
      const filename = M.safeFilename(String(req.query.filename || kind), sniffed);
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const r = await one(client, `INSERT INTO enrollment_documents(district_id,school_id,application_id,kind,filename,mime,bytes,sha256,content,uploaded_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [req.actor.districtId, a.school_id, a.id, kind, filename, sniffed, buf.length, sha, buf, req.actor.userId]);
      await audit(client, req, "upload", "enrollment_document", r.id, `${kind} ${buf.length}B`);
      return created({ id: r.id, filename, mime: sniffed, bytes: buf.length, sha256: sha });
    }));
  app.get("/api/enrollment/documents/:id", requireSession, familyOrLead, async (req, res, next) => {
    try {
      if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_document_id" });
      const d = await withTenantTransaction(req.actor, async client => {
        const doc = await one(client, `SELECT id,filename,mime,content FROM enrollment_documents WHERE id=$1`, [req.params.id]);
        if (doc) await audit(client, req, "download", "enrollment_document", doc.id);
        return doc;
      });
      if (!d) return res.status(404).json({ error: "not_found" });
      res.setHeader("Content-Type", d.mime);
      res.setHeader("Content-Disposition", `attachment; filename="${d.filename.replace(/"/g, "")}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "no-store");
      res.end(d.content);
    } catch (e) { next(e); }
  });
  app.post("/api/enrollment/documents/:id/review", limiter, requireSession, requireCsrf, requirePermission("enrollment", "manage"), wrap(async (client, req) => {
    need(validId(req.params.id), 400, "invalid_document_id");
    const status = req.body?.status;
    need(["verified", "rejected"].includes(status), 400, "invalid_status");
    const r = await client.query(`UPDATE enrollment_documents SET status=$2, review_note=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1 RETURNING id`,
      [req.params.id, status, str(req.body?.note, 300, { optional: true }), req.actor.userId]);
    need(r.rowCount, 404, "not_found");
    await audit(client, req, `document.${status}`, "enrollment_document", req.params.id);
    return { id: req.params.id, status };
  }));
}
export { HttpError };
