// 37.6.0: sports eligibility (coach and athletic director only), athletic
// directors, and guardian e-sign permission slips. db/060 enforces the same
// rules with RLS; these routes add validation, audit and clear errors.
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { evaluateTeam } from "./sports-eligibility.js";

const STAFF = ["superintendent", "it_admin", "principal", "vice_principal", "teacher"];
const AD_ROLES = ["teacher", "vice_principal", "principal"];
const wrap = fn => async (req, res, next) => {
  try { const data = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.json({ data }); }
  catch (e) { sendError(res, next, e); }
};
const write = (fn, status = 200) => async (req, res, next) => {
  try { const data = await withTenantTransaction(req.actor, c => fn(c, req)); res.status(status).json({ data }); }
  catch (e) { sendError(res, next, e); }
};
const isLead = (a, schoolId) => a.role === "superintendent" || (a.role === "principal" && a.schoolId === schoolId);
const policyOut = r => ({ minCoursePercent: Number(r.min_course_percent), minAttendancePercent: Number(r.min_attendance_percent), windowDays: r.window_days, minRecords: r.min_records });
const DEFAULT_POLICY = { minCoursePercent: 60, minAttendancePercent: 90, windowDays: 30, minRecords: 5 };
const slipOut = s => ({ id: s.id, activityId: s.activity_id, eventId: s.event_id, title: s.title, body: s.body, bodySha256: s.body_sha256, dueOn: s.due_on, status: s.status, createdAt: s.created_at });
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : v;

async function activityIn(c, a, id) {
  return one(c, `SELECT id,school_id,kind,title,status FROM school_activities WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3)`,
    [id, a.districtId, ["superintendent", "it_admin"].includes(a.role) ? null : a.schoolId]);
}
async function canManageRoster(c, activity) {
  return (await one(c, "SELECT eduos_can_manage_roster($1,$2) AS ok", [activity.id, activity.school_id])).ok;
}
// Latest decision per guardian and learner; the slip status per learner is
// "granted" only when the latest answer from a guardian grants it.
async function slipResponses(c, slipId) {
  return rows(c, `SELECT DISTINCT ON (x.student_id, x.guardian_user_id) x.student_id, x.guardian_user_id, x.decision, x.signed_name, x.signed_at
    FROM activity_permission_slip_signatures x WHERE x.slip_id=$1 ORDER BY x.student_id, x.guardian_user_id, x.signed_at DESC`, [slipId]);
}
function learnerStatus(responses, studentId) {
  const mine = responses.filter(r => r.student_id === studentId).sort((x, y) => new Date(y.signed_at) - new Date(x.signed_at));
  if (!mine.length) return { decision: "pending" };
  return { decision: mine[0].decision, signedName: mine[0].signed_name, signedAt: mine[0].signed_at };
}

export function registerSportsEligibilityRoutes(app) {
  // District rules. Reading them is fine for staff; only the superintendent sets them.
  app.get("/api/sports/eligibility-policy", requireSession, wrap(async (c, req) => {
    if (!STAFF.includes(req.actor.role)) throw new HttpError(403, "staff_only");
    const r = await one(c, "SELECT * FROM sports_eligibility_policy WHERE district_id=$1", [req.actor.districtId]);
    return { ...(r ? policyOut(r) : DEFAULT_POLICY), set: Boolean(r), updatedAt: r?.updated_at || null };
  }));
  app.put("/api/sports/eligibility-policy", requireSession, requireCsrf, write(async (c, req) => {
    const a = req.actor, b = req.body || {};
    if (a.role !== "superintendent") throw new HttpError(403, "superintendent_required");
    const n = (v, lo, hi, int = false) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi && (!int || Number.isInteger(v));
    if (!n(b.minCoursePercent, 0, 100) || !n(b.minAttendancePercent, 0, 100) || !n(b.windowDays, 7, 120, true) || !n(b.minRecords, 1, 60, true))
      throw new HttpError(400, "invalid_eligibility_policy");
    const r = await one(c, `INSERT INTO sports_eligibility_policy(district_id,min_course_percent,min_attendance_percent,window_days,min_records,updated_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(district_id) DO UPDATE SET min_course_percent=EXCLUDED.min_course_percent,
      min_attendance_percent=EXCLUDED.min_attendance_percent,window_days=EXCLUDED.window_days,min_records=EXCLUDED.min_records,
      updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
      [a.districtId, b.minCoursePercent, b.minAttendancePercent, b.windowDays, b.minRecords, a.userId]);
    await audit(c, req, "update", "sports_eligibility_policy", a.districtId, `course=${b.minCoursePercent};attendance=${b.minAttendancePercent};window=${b.windowDays};records=${b.minRecords}`);
    return { ...policyOut(r), set: true, updatedAt: r.updated_at };
  }));

  // Athletic directors: granted per school by its principal or the superintendent.
  app.get("/api/schools/:id/athletic-directors", requireSession, wrap(async (c, req) => {
    const a = req.actor; if (!validId(req.params.id)) throw new HttpError(400, "invalid_school_id");
    if (!isLead(a, req.params.id)) throw new HttpError(403, "school_lead_required");
    const directors = (await rows(c, `SELECT x.id,x.user_id,u.display_name,x.assigned_at FROM school_athletic_directors x JOIN users u ON u.id=x.user_id
      WHERE x.district_id=$1 AND x.school_id=$2 AND x.revoked_at IS NULL ORDER BY u.display_name`, [a.districtId, req.params.id]))
      .map(r => ({ id: r.id, userId: r.user_id, name: r.display_name, assignedAt: r.assigned_at }));
    // Staff of this school who could be named (names only, for the picker).
    const candidates = (await rows(c, `SELECT DISTINCT u.id,u.display_name,m.role FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.district_id=$1 AND m.school_id=$2 AND m.role=ANY($3) AND m.status='active' AND u.status='active' ORDER BY u.display_name LIMIT 500`,
      [a.districtId, req.params.id, AD_ROLES])).map(r => ({ userId: r.id, name: r.display_name, role: r.role }));
    return { directors, candidates };
  }));
  app.post("/api/schools/:id/athletic-directors", requireSession, requireCsrf, write(async (c, req) => {
    const a = req.actor, b = req.body || {};
    if (!validId(req.params.id) || !validId(b.userId)) throw new HttpError(400, "invalid_athletic_director");
    if (!isLead(a, req.params.id)) throw new HttpError(403, "school_lead_required");
    const staff = await one(c, `SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.district_id=$1 AND m.school_id=$2
      AND m.user_id=$3 AND m.role=ANY($4) AND m.status='active' AND u.status='active' LIMIT 1`, [a.districtId, req.params.id, b.userId, AD_ROLES]);
    if (!staff) throw new HttpError(400, "athletic_director_must_be_school_staff");
    if (await one(c, "SELECT id FROM school_athletic_directors WHERE district_id=$1 AND school_id=$2 AND user_id=$3 AND revoked_at IS NULL", [a.districtId, req.params.id, b.userId]))
      throw new HttpError(409, "already_athletic_director");
    const r = await one(c, `INSERT INTO school_athletic_directors(district_id,school_id,user_id,assigned_by) VALUES($1,$2,$3,$4) RETURNING id,user_id,assigned_at`,
      [a.districtId, req.params.id, b.userId, a.userId]);
    await audit(c, req, "assign", "athletic_director", r.id, `school=${req.params.id};user=${b.userId}`);
    return { id: r.id, userId: r.user_id, assignedAt: r.assigned_at };
  }, 201));
  app.post("/api/athletic-directors/:id/revoke", requireSession, requireCsrf, write(async (c, req) => {
    const a = req.actor; if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const r = await one(c, "SELECT id,school_id FROM school_athletic_directors WHERE id=$1 AND district_id=$2 AND revoked_at IS NULL FOR UPDATE", [req.params.id, a.districtId]);
    if (!r || !isLead(a, r.school_id)) throw new HttpError(404, "athletic_director_not_found");
    await c.query("UPDATE school_athletic_directors SET revoked_at=now(),revoked_by=$2 WHERE id=$1", [r.id, a.userId]);
    await audit(c, req, "revoke", "athletic_director", r.id, `school=${r.school_id}`);
    return { revoked: true };
  }));
  // What the signed-in staff member can do here (drives the UI only).
  app.get("/api/sports/my-roles", requireSession, wrap(async (c, req) => {
    const a = req.actor;
    const ad = AD_ROLES.includes(a.role) && a.schoolId ? (await one(c, "SELECT eduos_is_athletic_director($1) AS ok", [a.schoolId])).ok : false;
    const coach = a.role === "teacher" ? await rows(c, "SELECT activity_id FROM activity_staff WHERE district_id=$1 AND user_id=$2 AND staff_role='coach'", [a.districtId, a.userId]) : [];
    return { athleticDirector: ad, coachOf: coach.map(r => r.activity_id) };
  }));

  // Eligibility: pass/fail by rule for the active roster. Anyone else gets 404.
  app.get("/api/activities/:id/eligibility", requireSession, wrap(async (c, req) => {
    const a = req.actor; if (!validId(req.params.id)) throw new HttpError(400, "invalid_activity_id");
    if (!(await one(c, "SELECT eduos_can_see_eligibility($1) AS ok", [req.params.id])).ok) throw new HttpError(404, "activity_not_found");
    const inputs = (await one(c, "SELECT eduos_sports_eligibility_inputs($1) AS j", [req.params.id])).j;
    const team = evaluateTeam(inputs);
    const counts = team.students.reduce((m, s) => (m[s.status] = (m[s.status] || 0) + 1, m), {});
    await audit(c, req, "view", "sports_eligibility", req.params.id, `roster=${team.students.length};eligible=${counts.eligible || 0};not_eligible=${counts.not_eligible || 0};not_enough_records=${counts.not_enough_records || 0}`);
    return { ...team, computedAt: new Date().toISOString(), note: "Computed now from district rules. Not stored, not a score." };
  }));

  // Permission slips.
  app.post("/api/activities/:id/permission-slips", requireSession, requireCsrf, write(async (c, req) => {
    const a = req.actor, b = req.body || {};
    if (!validId(req.params.id) || !cleanText(b.title, 120, 2) || !cleanText(b.body, 4000, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(b.dueOn || "") || !Number.isFinite(Date.parse(b.dueOn))
      || (b.eventId != null && !validId(b.eventId))) throw new HttpError(400, "invalid_permission_slip");
    const activity = await activityIn(c, a, req.params.id);
    if (!activity) throw new HttpError(404, "activity_not_found");
    if (!await canManageRoster(c, activity)) throw new HttpError(403, "activity_assignment_required");
    if (b.dueOn < new Date().toISOString().slice(0, 10)) throw new HttpError(400, "due_date_in_past");
    const s = await one(c, `INSERT INTO activity_permission_slips(district_id,school_id,activity_id,event_id,title,body,body_sha256,due_on,created_by)
      VALUES($1,$2,$3,$4,$5,$6,repeat('0',64),$7,$8) RETURNING *`,
      [a.districtId, activity.school_id, activity.id, b.eventId || null, b.title.trim(), b.body.trim(), b.dueOn, a.userId]);
    await audit(c, req, "create", "permission_slip", s.id, `activity=${activity.id};sha256=${s.body_sha256}`);
    return { ...slipOut(s), dueOn: ymd(s.due_on) };
  }, 201));
  app.get("/api/activities/:id/permission-slips", requireSession, wrap(async (c, req) => {
    const a = req.actor; if (!validId(req.params.id)) throw new HttpError(400, "invalid_activity_id");
    const activity = await activityIn(c, a, req.params.id);
    if (!activity || !await canManageRoster(c, activity)) throw new HttpError(404, "activity_not_found");
    const roster = await rows(c, `SELECT r.student_id,s.display_name FROM activity_roster_entries r JOIN students s ON s.id=r.student_id AND s.district_id=r.district_id
      WHERE r.district_id=$1 AND r.activity_id=$2 AND r.status='active' ORDER BY s.display_name`, [a.districtId, activity.id]);
    const slips = await rows(c, "SELECT * FROM activity_permission_slips WHERE district_id=$1 AND activity_id=$2 ORDER BY created_at DESC LIMIT 50", [a.districtId, activity.id]);
    const out = [];
    for (const s of slips) {
      const resp = await slipResponses(c, s.id);
      const learners = roster.map(r => ({ studentId: r.student_id, name: r.display_name, ...learnerStatus(resp, r.student_id) }));
      out.push({ ...slipOut(s), dueOn: ymd(s.due_on), learners,
        summary: { granted: learners.filter(l => l.decision === "granted").length, declined: learners.filter(l => l.decision === "declined").length, pending: learners.filter(l => l.decision === "pending").length } });
    }
    return out;
  }));
  app.post("/api/permission-slips/:id/close", requireSession, requireCsrf, write(async (c, req) => {
    const a = req.actor; if (!validId(req.params.id)) throw new HttpError(400, "invalid_id");
    const s = await one(c, "SELECT * FROM activity_permission_slips WHERE id=$1 AND district_id=$2 FOR UPDATE", [req.params.id, a.districtId]);
    if (!s || !await canManageRoster(c, { id: s.activity_id, school_id: s.school_id })) throw new HttpError(404, "permission_slip_not_found");
    await c.query("UPDATE activity_permission_slips SET status='closed',closed_at=now() WHERE id=$1", [s.id]);
    await audit(c, req, "close", "permission_slip", s.id, `activity=${s.activity_id}`);
    return { closed: true };
  }));
  // Families: open and recent slips for their own learners on a roster.
  app.get("/api/my/permission-slips", requireSession, wrap(async (c, req) => {
    const a = req.actor; if (!["parent", "pupil"].includes(a.role)) throw new HttpError(403, "family_only");
    const kids = await rows(c, `SELECT r.activity_id,r.student_id,s.display_name FROM activity_roster_entries r
      JOIN students s ON s.id=r.student_id AND s.district_id=r.district_id
      JOIN student_user_links l ON l.student_id=r.student_id AND l.district_id=r.district_id AND l.user_id=$2 AND l.status='active'
      WHERE r.district_id=$1 AND r.status='active' AND eduos_is_linked_student(r.student_id)`, [a.districtId, a.userId]);
    if (!kids.length) return [];
    const slips = await rows(c, `SELECT p.*,sa.title AS activity_title FROM activity_permission_slips p JOIN school_activities sa ON sa.id=p.activity_id AND sa.district_id=p.district_id
      WHERE p.district_id=$1 AND p.activity_id=ANY($2::uuid[]) AND (p.status='open' OR p.due_on >= current_date - 30) ORDER BY p.due_on, p.created_at`,
      [a.districtId, [...new Set(kids.map(k => k.activity_id))]]);
    const out = [];
    for (const s of slips) {
      const resp = await slipResponses(c, s.id);
      for (const k of kids.filter(k => k.activity_id === s.activity_id)) {
        const mine = resp.filter(r => r.student_id === k.student_id && (a.role === "pupil" || r.guardian_user_id === a.userId));
        out.push({ ...slipOut(s), dueOn: ymd(s.due_on), activityTitle: s.activity_title, studentId: k.student_id, studentName: k.display_name,
          canSign: a.role === "parent" && s.status === "open", ...learnerStatus(mine, k.student_id) });
      }
    }
    return out;
  }));
  app.post("/api/permission-slips/:id/sign", requireSession, requireCsrf, write(async (c, req) => {
    const a = req.actor, b = req.body || {};
    if (a.role !== "parent") throw new HttpError(403, "guardian_only");
    if (!validId(req.params.id) || !validId(b.studentId) || !["granted", "declined"].includes(b.decision) || !cleanText(b.signedName, 120, 2)
      || !/^[a-f0-9]{64}$/.test(b.bodySha256 || "") || b.consent !== true) throw new HttpError(400, "invalid_signature");
    const s = await one(c, "SELECT * FROM activity_permission_slips WHERE id=$1 AND district_id=$2", [req.params.id, a.districtId]);
    if (!s || !(await one(c, "SELECT eduos_is_linked_student($1) AS ok", [b.studentId])).ok) throw new HttpError(404, "permission_slip_not_found");
    if (s.status !== "open") throw new HttpError(409, "permission_slip_closed");
    if (s.body_sha256 !== b.bodySha256) throw new HttpError(409, "permission_slip_text_changed");
    if (!await one(c, "SELECT 1 FROM activity_roster_entries WHERE district_id=$1 AND activity_id=$2 AND student_id=$3 AND status='active'", [a.districtId, s.activity_id, b.studentId]))
      throw new HttpError(404, "permission_slip_not_found");
    const r = await one(c, `INSERT INTO activity_permission_slip_signatures(district_id,school_id,slip_id,student_id,guardian_user_id,decision,signed_name,body_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,decision,signed_at`,
      [a.districtId, s.school_id, s.id, b.studentId, a.userId, b.decision, b.signedName.trim(), b.bodySha256]);
    await audit(c, req, "sign", "permission_slip", s.id, `student=${b.studentId};decision=${b.decision};sha256=${b.bodySha256}`);
    return { id: r.id, decision: r.decision, signedAt: r.signed_at };
  }, 201));
}
