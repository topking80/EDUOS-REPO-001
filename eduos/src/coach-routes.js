// COACH-01: the coach workspace ("My teams").
//
// GET /api/coach/teams: the teams (and clubs) the signed-in teacher or coach
// profile is assigned to at this school, each with what a coach needs today:
// the next practices and games, the roster with eligibility (sports, by the
// district's rules, computed now and not stored) and the latest permission
// slip's answers, and recent results. Plus the other schools where this person
// has a coach profile, so the app can offer to switch.
//
// Nothing new is exposed: rosters, eligibility and slips come through the same
// row policies as before (db/060, db/105), which allow only the team's staff.
import { requireSession } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, sendError } from "./role-app-util.js";
import { evaluateTeam } from "./sports-eligibility.js";

export function registerCoachRoutes(app) {
  app.get("/api/coach/teams", requireSession, async (req, res, next) => {
    const a = req.actor;
    if (!["teacher", "coach"].includes(a.role)) return res.status(403).json({ error: "coaches_only" });
    try {
      const data = await withTenantTransaction(a, async c => {
        const teams = await rows(c, `SELECT x.id,x.kind,x.title,x.meeting_details,x.status,s.staff_role FROM activity_staff s
            JOIN school_activities x ON x.id=s.activity_id AND x.district_id=s.district_id
           WHERE s.district_id=$1 AND s.school_id=$2 AND s.user_id=$3 AND s.ended_at IS NULL AND x.status<>'archived' ORDER BY x.kind DESC,x.title`,
          [a.districtId, a.schoolId, a.userId]);
        const out = [];
        for (const t of teams) {
          const events = await rows(c, `SELECT id,title,starts_at,ends_at,venue,status FROM school_events WHERE activity_id=$1 AND status IN ('draft','published')
              AND ends_at>=now()-interval '12 hours' ORDER BY starts_at LIMIT 3`, [t.id]);
          const roster = await rows(c, `SELECT r.student_id,s.display_name AS name,s.grade_level AS grade,r.jersey_number AS jersey FROM activity_roster_entries r
              JOIN students s ON s.id=r.student_id AND s.district_id=r.district_id WHERE r.activity_id=$1 AND r.status='active' ORDER BY s.display_name`, [t.id]);
          let eligibility = null;
          if (t.kind === "sport" && (await one(c, "SELECT eduos_can_see_eligibility($1) AS ok", [t.id])).ok) {
            const team = evaluateTeam((await one(c, "SELECT eduos_sports_eligibility_inputs($1) AS j", [t.id])).j);
            eligibility = new Map(team.students.map(s => [s.studentId, s.status]));
          }
          const slip = await one(c, `SELECT id,title,due_on,status FROM activity_permission_slips WHERE activity_id=$1 AND status='open' ORDER BY created_at DESC LIMIT 1`, [t.id]);
          let answers = new Map();
          if (slip) {
            const resp = await rows(c, `SELECT DISTINCT ON (student_id) student_id,decision FROM activity_permission_slip_signatures WHERE slip_id=$1 ORDER BY student_id,signed_at DESC`, [slip.id]);
            answers = new Map(resp.map(r => [r.student_id, r.decision]));
          }
          const results = await rows(c, `SELECT e.title,e.starts_at,r.opponent,r.home_score,r.away_score,r.status FROM activity_event_results r JOIN school_events e ON e.id=r.event_id
              WHERE r.activity_id=$1 ORDER BY e.starts_at DESC LIMIT 3`, [t.id]);
          out.push({ id: t.id, kind: t.kind, title: t.title, role: t.staff_role, meetingDetails: t.meeting_details, status: t.status, events, results,
            slip: slip ? { id: slip.id, title: slip.title, dueOn: slip.due_on, granted: roster.filter(r => answers.get(r.student_id) === "granted").length,
              declined: roster.filter(r => answers.get(r.student_id) === "declined").length, pending: roster.filter(r => !answers.has(r.student_id)).length } : null,
            roster: roster.map(r => ({ studentId: r.student_id, name: r.name, grade: r.grade, jersey: r.jersey,
              eligibility: eligibility ? (eligibility.get(r.student_id) || "not_enough_records") : null,
              slip: slip ? (answers.get(r.student_id) || "pending") : null })) });
          if (eligibility) await audit(c, req, "view", "sports_eligibility", t.id, `roster=${roster.length};via=coach_workspace`);
        }
        // Other schools where this person coaches (coach profiles), to switch to.
        const elsewhere = await rows(c, `SELECT m.id AS membership_id,m.school_id,sc.name AS school FROM memberships m JOIN schools sc ON sc.id=m.school_id
            WHERE m.user_id=$1 AND m.district_id=$2 AND m.role='coach' AND m.status='active' AND m.school_id<>$3 ORDER BY sc.name`, [a.userId, a.districtId, a.schoolId]);
        return { teams: out, elsewhere };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });
}
