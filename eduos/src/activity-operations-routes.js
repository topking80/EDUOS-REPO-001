// Clubs & sports operations (db/152): attendance at an activity's meetings,
// practices and games, and athletic physical clearance status (dates only).
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, HttpError, sendError } from "./role-app-util.js";
import { ATTENDANCE_STATUSES, physicalStatus, validMarks } from "./activity-operations.js";

const DISTRICT = role => ["superintendent", "it_admin"].includes(role);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const wrap = fn => async (req, res, next) => {
  try {
    const data = await withTenantTransaction(req.actor, c => fn(c, req));
    res.setHeader("Cache-Control", "no-store");
    res.json({ data });
  } catch (e) { sendError(res, next, e); }
};

async function managedEvent(c, a, eventId) {
  const ev = await one(c, `SELECT e.id,e.title,e.starts_at,e.ends_at,e.status,e.activity_id,a.school_id,a.kind,a.title AS activity_title
      FROM school_events e JOIN school_activities a ON a.id=e.activity_id AND a.district_id=e.district_id
     WHERE e.id=$1 AND e.district_id=$2 AND ($3::uuid IS NULL OR a.school_id=$3)`, [eventId, a.districtId, DISTRICT(a.role) ? null : a.schoolId]);
  if (!ev) throw new HttpError(404, "event_not_found");
  const ok = await one(c, "SELECT eduos_can_manage_roster($1,$2) AS ok", [ev.activity_id, ev.school_id]);
  if (!ok?.ok) throw new HttpError(404, "event_not_found");
  return ev;
}

// Learners on the activity: the sport roster, plus club members through their pupil link.
function participants(c, districtId, activityId) {
  return rows(c, `SELECT s.id AS student_id,s.display_name,s.grade_level FROM students s
     WHERE s.district_id=$1 AND (
       EXISTS(SELECT 1 FROM activity_roster_entries r WHERE r.district_id=$1 AND r.activity_id=$2 AND r.student_id=s.id AND r.status='active')
       OR EXISTS(SELECT 1 FROM activity_memberships m JOIN student_user_links l ON l.user_id=m.user_id AND l.district_id=m.district_id
                  AND l.relationship='pupil' AND l.status='active'
                 WHERE m.district_id=$1 AND m.activity_id=$2 AND m.status='active' AND l.student_id=s.id))
     ORDER BY s.display_name LIMIT 500`, [districtId, activityId]);
}

export function registerActivityOperationsRoutes(app) {
  app.get("/api/events/:id/attendance", requireSession, wrap(async (c, req) => {
    const a = req.actor; if (!validId(req.params.id)) throw new HttpError(400, "invalid_event_id");
    const ev = await managedEvent(c, a, req.params.id);
    const people = await participants(c, a.districtId, ev.activity_id);
    const marks = await rows(c, "SELECT student_id,status,marked_at FROM activity_event_attendance WHERE district_id=$1 AND event_id=$2", [a.districtId, ev.id]);
    const byStudent = new Map(marks.map(m => [m.student_id, m]));
    const students = people.map(p => ({ studentId: p.student_id, name: p.display_name, grade: p.grade_level, status: byStudent.get(p.student_id)?.status || null, markedAt: byStudent.get(p.student_id)?.marked_at || null }));
    const counts = Object.fromEntries(ATTENDANCE_STATUSES.map(s => [s, students.filter(x => x.status === s).length]));
    return { event: { id: ev.id, title: ev.title, startsAt: ev.starts_at, activityId: ev.activity_id, activityTitle: ev.activity_title, kind: ev.kind }, students, counts, unmarked: students.filter(x => !x.status).length };
  }));

  app.put("/api/events/:id/attendance", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, b = req.body || {};
    if (!validId(req.params.id) || !validMarks(b.marks)) return res.status(400).json({ error: "invalid_attendance" });
    try {
      const data = await withTenantTransaction(a, async c => {
        const ev = await managedEvent(c, a, req.params.id);
        if (ev.status === "cancelled") throw new HttpError(409, "event_cancelled");
        if (new Date(ev.starts_at).getTime() > Date.now() + 60 * 60 * 1000) throw new HttpError(409, "event_not_started");
        const allowed = new Set((await participants(c, a.districtId, ev.activity_id)).map(p => p.student_id));
        for (const m of b.marks) if (!allowed.has(m.studentId)) throw new HttpError(409, "student_not_on_activity");
        for (const m of b.marks) {
          await c.query(`INSERT INTO activity_event_attendance(district_id,school_id,activity_id,event_id,student_id,status,marked_by)
              VALUES($1,$2,$3,$4,$5,$6,$7)
              ON CONFLICT(district_id,event_id,student_id) DO UPDATE SET status=EXCLUDED.status,marked_by=EXCLUDED.marked_by,marked_at=now()`,
            [a.districtId, ev.school_id, ev.activity_id, ev.id, m.studentId, m.status, a.userId]);
        }
        const counts = Object.fromEntries(ATTENDANCE_STATUSES.map(s => [s, b.marks.filter(m => m.status === s).length]));
        await audit(c, req, "mark", "activity_event_attendance", ev.id, `activity=${ev.activity_id};${ATTENDANCE_STATUSES.map(s => `${s}=${counts[s]}`).join(";")}`);
        return { eventId: ev.id, saved: b.marks.length, counts };
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Coach / athletic director / school lead: physical clearance status for a team.
  app.get("/api/activities/:id/physicals", requireSession, wrap(async (c, req) => {
    const a = req.actor; if (!validId(req.params.id)) throw new HttpError(400, "invalid_activity_id");
    const act = await one(c, "SELECT id,school_id,kind FROM school_activities WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3)", [req.params.id, a.districtId, DISTRICT(a.role) ? null : a.schoolId]);
    if (!act) throw new HttpError(404, "activity_not_found");
    if (!(await one(c, "SELECT (eduos_can_manage_roster($1,$2) OR eduos_can_record_physical($2)) AS ok", [act.id, act.school_id]))?.ok) throw new HttpError(404, "activity_not_found");
    if (act.kind !== "sport") throw new HttpError(400, "physicals_require_sport_team");
    const list = await rows(c, `SELECT r.student_id,s.display_name,s.grade_level,r.jersey_number,p.cleared_on,p.expires_on
        FROM activity_roster_entries r JOIN students s ON s.id=r.student_id AND s.district_id=r.district_id
        LEFT JOIN LATERAL (SELECT cleared_on,expires_on FROM student_physical_clearances x WHERE x.district_id=r.district_id AND x.student_id=r.student_id ORDER BY recorded_at DESC LIMIT 1) p ON true
       WHERE r.district_id=$1 AND r.activity_id=$2 AND r.status='active' ORDER BY s.display_name LIMIT 500`, [a.districtId, act.id]);
    const students = list.map(r => ({ studentId: r.student_id, name: r.display_name, grade: r.grade_level, jersey: r.jersey_number, ...physicalStatus(r.cleared_on ? r : null) }));
    const summary = Object.fromEntries(["cleared", "expiring", "expired", "missing"].map(s => [s, students.filter(x => x.status === s).length]));
    await audit(c, req, "view", "physical_clearance_status", act.id, Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(";"));
    return { activityId: act.id, students, summary };
  }));

  // School lead or athletic director records the dates from a signed physical form.
  app.post("/api/students/:id/physical-clearance", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, b = req.body || {};
    if (!validId(req.params.id) || !DATE.test(b.clearedOn || "") || !DATE.test(b.expiresOn || "")) return res.status(400).json({ error: "invalid_physical_clearance" });
    if (b.expiresOn <= b.clearedOn) return res.status(400).json({ error: "invalid_physical_clearance" });
    if (b.clearedOn > new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: "cleared_on_in_future" });
    try {
      const data = await withTenantTransaction(a, async c => {
        const st = await one(c, "SELECT id,school_id FROM students WHERE id=$1 AND district_id=$2 AND school_id=$3", [req.params.id, a.districtId, a.schoolId]);
        if (!st) throw new HttpError(404, "student_not_found");
        const ok = await one(c, "SELECT eduos_can_record_physical($1) AS ok", [st.school_id]);
        if (!ok?.ok) throw new HttpError(403, "physical_recorder_required");
        const r = await one(c, `INSERT INTO student_physical_clearances(district_id,school_id,student_id,cleared_on,expires_on,recorded_by)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING id,cleared_on,expires_on`, [a.districtId, st.school_id, st.id, b.clearedOn, b.expiresOn, a.userId]);
        await audit(c, req, "record", "physical_clearance", r.id, `student=${st.id};expires=${b.expiresOn}`);
        return { id: r.id, studentId: st.id, ...physicalStatus(r) };
      });
      res.status(201).json({ data });
    } catch (e) { if (e?.code === "23514") return res.status(400).json({ error: "invalid_physical_clearance" }); sendError(res, next, e); }
  });

  // Family view: their learner's clearance status (no medical details exist).
  app.get("/api/students/:id/physical-clearance", requireSession, wrap(async (c, req) => {
    const a = req.actor; if (!validId(req.params.id)) throw new HttpError(400, "invalid_student_id");
    const st = await one(c, "SELECT id,school_id FROM students WHERE id=$1 AND district_id=$2", [req.params.id, a.districtId]);
    if (!st || !(await one(c, "SELECT eduos_can_read_physical($1,$2) AS ok", [st.school_id, st.id]))?.ok) throw new HttpError(404, "student_not_found");
    const latest = await one(c, "SELECT cleared_on,expires_on FROM student_physical_clearances WHERE district_id=$1 AND student_id=$2 ORDER BY recorded_at DESC LIMIT 1", [a.districtId, st.id]);
    return { studentId: st.id, ...physicalStatus(latest) };
  }));

  // Guardian consent for clubs below high school (db/051, db/152).
  app.get("/api/my/club-approvals", requireSession, wrap(async (c, req) => {
    const a = req.actor;
    if (!["parent", "pupil"].includes(a.role)) throw new HttpError(403, "family_access_required");
    if (a.role === "pupil") {
      return rows(c, `SELECT m.id,m.activity_id,a.title AS activity_title,m.status,m.joined_at
          FROM activity_memberships m JOIN school_activities a ON a.id=m.activity_id AND a.district_id=m.district_id
         WHERE m.district_id=$1 AND m.user_id=$2 AND a.kind='club' ORDER BY m.joined_at DESC LIMIT 100`, [a.districtId, a.userId]);
    }
    return rows(c, `SELECT m.id,m.activity_id,a.title AS activity_title,m.status,m.joined_at,s.id AS student_id,s.display_name AS student_name,s.grade_level
        FROM activity_memberships m
        JOIN school_activities a ON a.id=m.activity_id AND a.district_id=m.district_id
        JOIN student_user_links kp ON kp.district_id=m.district_id AND kp.user_id=m.user_id AND kp.relationship='pupil' AND kp.status='active'
        JOIN student_user_links gp ON gp.district_id=m.district_id AND gp.student_id=kp.student_id AND gp.user_id=$2 AND gp.relationship IN ('parent','guardian') AND gp.status='active'
        JOIN students s ON s.id=kp.student_id AND s.district_id=m.district_id
       WHERE m.district_id=$1 AND a.kind='club' ORDER BY (m.status='pending') DESC,m.joined_at DESC LIMIT 100`, [a.districtId, a.userId]);
  }));

  app.post("/api/activity-memberships/:id/consent", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, decision = req.body?.decision;
    if (a.role !== "parent") return res.status(403).json({ error: "guardian_consent_only" });
    if (!validId(req.params.id) || !["active", "declined"].includes(decision)) return res.status(400).json({ error: "invalid_club_consent" });
    try {
      const data = await withTenantTransaction(a, async c => {
        const m = await one(c, `SELECT m.id,m.activity_id,m.user_id,m.status,a.kind,eduos_guardian_of_member(m.user_id) AS ok
            FROM activity_memberships m JOIN school_activities a ON a.id=m.activity_id AND a.district_id=m.district_id
           WHERE m.id=$1 AND m.district_id=$2 FOR UPDATE OF m`, [req.params.id, a.districtId]);
        if (!m || !m.ok) throw new HttpError(404, "membership_not_found");
        if (m.kind !== "club") throw new HttpError(400, "club_membership_required");
        const r = await one(c, `UPDATE activity_memberships SET status=$2,reviewed_by=$3 WHERE id=$1 RETURNING id,activity_id,status,reviewed_by`,
          [m.id, decision, a.userId]);
        await audit(c, req, "consent", "activity_membership", r.id, `activity=${m.activity_id};decision=${decision}`);
        return r;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });
}
