// TC-05: privacy controls for Student History and Time Capsules (db/118).
//
// The records office (the school's principal / vice principal, the superintendent):
//   GET  /api/students/:id/history-privacy           restrictions, rights transition, grants, emergency access, who looked
//   POST /api/students/:id/custody-restrictions      {userId, kind, basis, documentRef?, endsOn?}
//   POST /api/custody-restrictions/:id/lift          {note}
//   POST /api/students/:id/rights-transition         {basis, effectiveOn}
//   POST /api/students/:id/rights-transition/reverse {note}  (recorded in error)
// The student, once they hold their rights:
//   GET  /api/history/sharing                        my rights status, my guardians, my grants (and grants to me)
//   POST /api/history/sharing                        {granteeUserId, classifications, days}
//   POST /api/history/sharing/:id/revoke
// Counselor, nurse or school resource officer:
//   POST /api/students/:id/emergency-access          {reason}: official records, four hours
//   POST /api/emergency-access/:id/close
// Superintendent:
//   GET  /api/history/emergency-access?review=pending
//   POST /api/emergency-access/:id/review            {note}
// The student, their guardians (before the transition), the records office:
//   GET  /api/students/:id/history-access-log
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";

const CLASSES = ["family_memory", "student_portfolio", "teacher_artifact", "official_record"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = d => typeof d === "string" && DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const ymd = d => d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

export function registerHistoryPrivacyRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const only = roles => (req, res, next) => roles.includes(req.actor?.role) ? next() : res.status(403).json({ error: "forbidden" });
  const run = (fn, ok = 200) => async (req, res, next) => {
    try { const out = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(ok).json({ data: out }); }
    catch (e) { if (e.code === "23505") return res.status(409).json({ error: "already_exists" }); sendError(res, next, e); }
  };
  const OFFICE = ["principal", "vice_principal", "superintendent"];
  // A student the records office may act on.
  const officeStudent = async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const s = await one(c, `SELECT id,school_id,display_name FROM students WHERE id=$1 AND eduos_records_office(school_id)`, [req.params.id]);
    if (!s) throw new HttpError(404, "student_not_found");
    return s;
  };
  const guardians = (c, studentId) => rows(c, `SELECT u.id,u.display_name AS name,eduos_custody_blocked($1,u.id) AS restricted FROM student_user_links l JOIN users u ON u.id=l.user_id
      WHERE l.student_id=$1 AND l.relationship IN ('parent','guardian') AND l.status='active' ORDER BY u.display_name`, [studentId]);

  // ---------- the records office ----------
  app.get("/api/students/:id/history-privacy", requireSession, only(OFFICE), run(async (c, req) => {
    const s = await officeStudent(c, req);
    const restrictions = await rows(c, `SELECT r.*,u.display_name AS person,b.display_name AS set_by_name,l.display_name AS lifted_by_name FROM student_custody_restrictions r
        JOIN users u ON u.id=r.restricted_user_id JOIN users b ON b.id=r.set_by LEFT JOIN users l ON l.id=r.lifted_by WHERE r.student_id=$1 ORDER BY r.set_at DESC`, [s.id]);
    const transition = await one(c, `SELECT t.*,u.display_name AS recorded_by_name FROM student_rights_transitions t JOIN users u ON u.id=t.recorded_by WHERE t.student_id=$1 AND t.reversed_at IS NULL`, [s.id]);
    const grants = await rows(c, `SELECT g.id,g.classifications,g.expires_at,g.revoked_at,u.display_name AS grantee FROM history_sharing_grants g JOIN users u ON u.id=g.grantee_user_id WHERE g.student_id=$1 ORDER BY g.created_at DESC`, [s.id]);
    const emergency = await rows(c, `SELECT a.id,a.role,a.reason,a.opened_at,a.expires_at,a.closed_at,a.reviewed_at,u.display_name AS person FROM history_emergency_access a JOIN users u ON u.id=a.user_id
        WHERE a.student_id=$1 ORDER BY a.opened_at DESC LIMIT 50`, [s.id]);
    await audit(c, req, "read", "history_privacy", s.id, null);
    return { student: { id: s.id, name: s.display_name }, guardians: await guardians(c, s.id),
      restrictions: restrictions.map(r => ({ id: r.id, person: r.person, kind: r.kind, basis: r.basis, documentRef: r.document_ref, setBy: r.set_by_name, setAt: r.set_at,
        endsOn: ymd(r.ends_on), liftedBy: r.lifted_by_name, liftedAt: r.lifted_at, liftNote: r.lift_note })),
      transition: transition ? { basis: transition.basis, effectiveOn: ymd(transition.effective_on), recordedBy: transition.recorded_by_name } : null,
      grants: grants.map(g => ({ id: g.id, grantee: g.grantee, classifications: g.classifications, expiresAt: g.expires_at, revoked: Boolean(g.revoked_at) })),
      emergency: emergency.map(a => ({ id: a.id, person: a.person, role: a.role, reason: a.reason, openedAt: a.opened_at, expiresAt: a.expires_at, closed: Boolean(a.closed_at), reviewed: Boolean(a.reviewed_at) })) };
  }));

  app.post("/api/students/:id/custody-restrictions", limiter, requireSession, requireCsrf, only(OFFICE), run(async (c, req) => {
    const s = await officeStudent(c, req), b = req.body || {};
    if (!validId(b.userId) || !["court_order", "disputed"].includes(b.kind) || !cleanText(b.basis, 300, 5) || (b.documentRef && !cleanText(b.documentRef, 200))
        || (b.endsOn != null && b.endsOn !== "" && !validDate(b.endsOn))) throw new HttpError(400, "invalid_restriction");
    if (!(await guardians(c, s.id)).some(g => g.id === b.userId)) throw new HttpError(400, "not_a_guardian_of_this_student");
    const r = await one(c, `INSERT INTO student_custody_restrictions(district_id,school_id,student_id,restricted_user_id,kind,basis,document_ref,set_by,ends_on)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [req.actor.districtId, s.school_id, s.id, b.userId, b.kind, b.basis.trim(), b.documentRef?.trim() || null, req.actor.userId, b.endsOn || null]);
    await audit(c, req, "create", "custody_restriction", r.id, b.kind);
    return r;
  }, 201));

  app.post("/api/custody-restrictions/:id/lift", limiter, requireSession, requireCsrf, only(OFFICE), run(async (c, req) => {
    if (!validId(req.params.id) || !cleanText(req.body?.note, 300, 5)) throw new HttpError(400, "note_required");
    const r = await one(c, `UPDATE student_custody_restrictions SET lifted_at=now(),lifted_by=$2,lift_note=$3 WHERE id=$1 AND lifted_at IS NULL RETURNING id`, [req.params.id, req.actor.userId, req.body.note.trim()]);
    if (!r) throw new HttpError(404, "restriction_not_found");
    await audit(c, req, "lift", "custody_restriction", r.id, null);
    return { lifted: true };
  }));

  app.post("/api/students/:id/rights-transition", limiter, requireSession, requireCsrf, only(OFFICE), run(async (c, req) => {
    const s = await officeStudent(c, req), b = req.body || {};
    if (!["age_18", "postsecondary", "emancipated", "other"].includes(b.basis) || !validDate(b.effectiveOn)) throw new HttpError(400, "invalid_transition");
    await c.query(`INSERT INTO student_rights_transitions(district_id,school_id,student_id,basis,effective_on,recorded_by) VALUES($1,$2,$3,$4,$5,$6)`,
      [req.actor.districtId, s.school_id, s.id, b.basis, b.effectiveOn, req.actor.userId]);
    await audit(c, req, "create", "rights_transition", s.id, b.basis);
    return { basis: b.basis, effectiveOn: b.effectiveOn };
  }, 201));

  app.post("/api/students/:id/rights-transition/reverse", limiter, requireSession, requireCsrf, only(OFFICE), run(async (c, req) => {
    const s = await officeStudent(c, req);
    if (!cleanText(req.body?.note, 300, 5)) throw new HttpError(400, "note_required");
    const t = await one(c, `UPDATE student_rights_transitions SET reversed_at=now(),reversed_by=$2,reverse_note=$3 WHERE student_id=$1 AND reversed_at IS NULL RETURNING id`, [s.id, req.actor.userId, req.body.note.trim()]);
    if (!t) throw new HttpError(404, "no_transition");
    // Grants work only while the student holds their rights (db/118), so they stop with it.
    await audit(c, req, "reverse", "rights_transition", s.id, null);
    return { reversed: true };
  }));

  // ---------- the student's sharing ----------
  const myStudent = async c => (await one(c, `SELECT l.student_id AS id,s.school_id FROM student_user_links l JOIN students s ON s.id=l.student_id
      WHERE l.user_id=eduos_ctx_user() AND l.relationship='pupil' AND l.status='active' LIMIT 1`));

  app.get("/api/history/sharing", requireSession, only(["pupil", "parent"]), run(async (c, req) => {
    if (req.actor.role === "parent") {
      // Grants to me, and children who now hold their own rights.
      const toMe = await rows(c, `SELECT g.id,g.classifications,g.expires_at,s.display_name AS student,s.id AS student_id FROM history_sharing_grants g JOIN students s ON s.id=g.student_id
          WHERE g.grantee_user_id=$1 AND g.revoked_at IS NULL AND g.expires_at>now()`, [req.actor.userId]);
      const adults = await rows(c, `SELECT s.id,s.display_name AS name FROM student_user_links l JOIN students s ON s.id=l.student_id
          WHERE l.user_id=$1 AND l.relationship IN ('parent','guardian') AND l.status='active' AND eduos_student_holds_rights(s.id)`, [req.actor.userId]);
      return { grantsToMe: toMe.map(g => ({ id: g.id, studentId: g.student_id, student: g.student, classifications: g.classifications, expiresAt: g.expires_at })),
        holdsOwnRights: adults.map(a => ({ studentId: a.id, name: a.name })) };
    }
    const me = await myStudent(c);
    if (!me) throw new HttpError(404, "student_not_found");
    const holds = (await one(c, `SELECT eduos_student_holds_rights($1) AS h`, [me.id])).h;
    const t = holds ? await one(c, `SELECT basis,effective_on FROM student_rights_transitions WHERE student_id=$1 AND reversed_at IS NULL`, [me.id]) : null;
    const grants = await rows(c, `SELECT g.id,g.classifications,g.expires_at,g.revoked_at,u.display_name AS grantee FROM history_sharing_grants g JOIN users u ON u.id=g.grantee_user_id
        WHERE g.student_id=$1 ORDER BY g.created_at DESC`, [me.id]);
    return { holdsOwnRights: holds, transition: t ? { basis: t.basis, effectiveOn: ymd(t.effective_on) } : null,
      guardians: holds ? (await rows(c, `SELECT u.id,u.display_name AS name FROM student_user_links l JOIN users u ON u.id=l.user_id
          WHERE l.student_id=$1 AND l.relationship IN ('parent','guardian') AND l.status='active' AND NOT eduos_custody_blocked($1,u.id) ORDER BY u.display_name`, [me.id])) : [],
      grants: grants.map(g => ({ id: g.id, grantee: g.grantee, classifications: g.classifications, expiresAt: g.expires_at, active: !g.revoked_at && new Date(g.expires_at) > new Date() })) };
  }));

  app.post("/api/history/sharing", limiter, requireSession, requireCsrf, only(["pupil"]), run(async (c, req) => {
    const b = req.body || {}, me = await myStudent(c);
    if (!me) throw new HttpError(404, "student_not_found");
    const classes = Array.isArray(b.classifications) ? [...new Set(b.classifications)] : [];
    if (!validId(b.granteeUserId) || !classes.length || !classes.every(x => CLASSES.includes(x)) || !Number.isInteger(b.days) || b.days < 1 || b.days > 365) throw new HttpError(400, "invalid_grant");
    if (!(await one(c, `SELECT eduos_student_holds_rights($1) AS h`, [me.id])).h) throw new HttpError(409, "rights_not_yet_yours");
    const g = await one(c, `INSERT INTO history_sharing_grants(district_id,school_id,student_id,granted_by,grantee_user_id,classifications,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now() + make_interval(days => $7)) RETURNING id,expires_at`, [req.actor.districtId, me.school_id, me.id, req.actor.userId, b.granteeUserId, classes, b.days]);
    await audit(c, req, "grant", "history_sharing", g.id, classes.join(","));
    return { id: g.id, expiresAt: g.expires_at };
  }, 201));

  app.post("/api/history/sharing/:id/revoke", limiter, requireSession, requireCsrf, only(["pupil"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const g = await one(c, `UPDATE history_sharing_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1 AND granted_by=$2 AND revoked_at IS NULL RETURNING id`, [req.params.id, req.actor.userId]);
    if (!g) throw new HttpError(404, "grant_not_found");
    await audit(c, req, "revoke", "history_sharing", g.id, null);
    return { revoked: true };
  }));

  // ---------- emergency access ----------
  app.post("/api/students/:id/emergency-access", limiter, requireSession, requireCsrf, only(["counselor", "nurse", "sro"]), run(async (c, req) => {
    if (!validId(req.params.id) || !cleanText(req.body?.reason, 500, 20)) throw new HttpError(400, "reason_required");
    const s = await one(c, `SELECT id,school_id FROM students WHERE id=$1 AND school_id=$2`, [req.params.id, req.actor.schoolId]);
    if (!s) throw new HttpError(404, "student_not_found");
    const a = await one(c, `INSERT INTO history_emergency_access(district_id,school_id,student_id,user_id,role,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '4 hours') RETURNING id,expires_at`,
      [req.actor.districtId, s.school_id, s.id, req.actor.userId, req.actor.role, req.body.reason.trim()]);
    await audit(c, req, "emergency_access", "student_history", s.id, `access=${a.id}`);
    return { id: a.id, expiresAt: a.expires_at, sees: "official records only" };
  }, 201));

  // The same, by the student's ID number (staff without a class list find the student this way).
  app.post("/api/history/emergency-access", limiter, requireSession, requireCsrf, only(["counselor", "nurse", "sro"]), run(async (c, req) => {
    const n = req.body?.studentNumber;
    if (typeof n !== "string" || !n.trim() || n.length > 40 || !cleanText(req.body?.reason, 500, 20)) throw new HttpError(400, "reason_required");
    const s = await one(c, `SELECT id,school_id,display_name FROM students WHERE local_student_number=$1 AND school_id=$2`, [n.trim(), req.actor.schoolId]);
    if (!s) throw new HttpError(404, "student_not_found");
    const a = await one(c, `INSERT INTO history_emergency_access(district_id,school_id,student_id,user_id,role,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '4 hours') RETURNING id,expires_at`,
      [req.actor.districtId, s.school_id, s.id, req.actor.userId, req.actor.role, req.body.reason.trim()]);
    await audit(c, req, "emergency_access", "student_history", s.id, `access=${a.id}`);
    return { id: a.id, studentId: s.id, student: s.display_name, expiresAt: a.expires_at, sees: "official records only" };
  }, 201));

  app.post("/api/emergency-access/:id/close", limiter, requireSession, requireCsrf, only(["counselor", "nurse", "sro"]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const a = await one(c, `UPDATE history_emergency_access SET closed_at=now() WHERE id=$1 AND user_id=$2 AND closed_at IS NULL RETURNING id`, [req.params.id, req.actor.userId]);
    if (!a) throw new HttpError(404, "access_not_found");
    return { closed: true };
  }));

  app.get("/api/history/emergency-access", requireSession, only(["superintendent"]), run(async (c, req) => {
    const pending = req.query.review === "pending";
    return (await rows(c, `SELECT a.*,u.display_name AS person,s.display_name AS student,sc.name AS school,r.display_name AS reviewer FROM history_emergency_access a
        JOIN users u ON u.id=a.user_id JOIN students s ON s.id=a.student_id JOIN schools sc ON sc.id=a.school_id LEFT JOIN users r ON r.id=a.reviewed_by
        WHERE ($1=false OR a.reviewed_at IS NULL) ORDER BY a.opened_at DESC LIMIT 200`, [pending])).map(a => ({ id: a.id, person: a.person, role: a.role, student: a.student, school: a.school,
      reason: a.reason, openedAt: a.opened_at, expiresAt: a.expires_at, closedAt: a.closed_at, reviewedBy: a.reviewer, note: a.review_note }));
  }));

  app.post("/api/emergency-access/:id/review", limiter, requireSession, requireCsrf, only(["superintendent"]), run(async (c, req) => {
    if (!validId(req.params.id) || !cleanText(req.body?.note, 500)) throw new HttpError(400, "note_required");
    const a = await one(c, `UPDATE history_emergency_access SET reviewed_at=now(),reviewed_by=$2,review_note=$3,closed_at=coalesce(closed_at,now()) WHERE id=$1 AND reviewed_at IS NULL RETURNING id`,
      [req.params.id, req.actor.userId, req.body.note.trim()]);
    if (!a) throw new HttpError(404, "access_not_found");
    await audit(c, req, "review", "history_emergency_access", a.id, null);
    return { reviewed: true };
  }));

  // ---------- who looked ----------
  app.get("/api/students/:id/history-access-log", requireSession, only(["pupil", "parent", ...OFFICE]), run(async (c, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    return (await rows(c, `SELECT g.access,g.action,g.item_count,g.at,u.display_name AS who,(g.user_id=$2) AS me FROM history_access_log g JOIN users u ON u.id=g.user_id
        WHERE g.student_id=$1 ORDER BY g.at DESC LIMIT 200`, [req.params.id, req.actor.userId]))
      .map(g => ({ who: g.me ? "You" : g.who, access: g.access, action: g.action, items: g.item_count, at: g.at }));
  }));
}
