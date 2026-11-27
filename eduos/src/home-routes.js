// 32.2.0: GET /api/home returns the role home dashboard in one request:
// counts and next steps for the signed-in role. It reads only what that role
// can already read through the list endpoints (same scope rules, RLS on top),
// returns counts rather than records except the caller's own children/self,
// and audits the read like the other student-record reads.
import { requireSession } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { gradeNumber, YOUNG_LEARNER_MAX_GRADE } from "./mesh-routes.js";

const one = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const roster = uid => `EXISTS(SELECT 1 FROM teacher_student_rosters tr WHERE tr.student_id=s.id AND tr.teacher_user_id=${uid})`;
const APPS_FOR_SCHOOL = `(SELECT count(DISTINCT a.id)::int FROM apps a JOIN app_assignments x ON x.app_id=a.id AND x.revoked_at IS NULL
   WHERE a.status='active' AND (x.scope='district' OR x.school_id=$1)
     AND EXISTS(SELECT 1 FROM app_licenses l WHERE l.app_id=a.id AND l.status='active' AND l.starts_on<=current_date AND (l.ends_on IS NULL OR l.ends_on>=current_date)))`;

export function registerHomeRoutes(app) {
  app.get("/api/home", requireSession, async (req, res, next) => {
    const a = req.actor;
    try {
      const data = await withTenantTransaction(a, async client => {
        let home;
        if (a.role === "superintendent") {
          home = await one(client, `SELECT
            (SELECT count(*) FROM schools WHERE status='active')::int AS schools,
            (SELECT count(*) FROM students)::int AS students,
            (SELECT count(*) FROM district_users WHERE district_id=$1)::int AS people,
            (SELECT count(*) FROM student_intervention_cases WHERE status<>'closed')::int AS open_cases,
            (SELECT count(*) FROM student_intervention_cases WHERE status<>'closed' AND priority IN ('high','urgent'))::int AS urgent_cases,
            (SELECT count(*) FROM attendance_events WHERE status='absent' AND event_date>=current_date-6)::int AS absences_7d,
            (SELECT count(*) FROM access_requests WHERE status='pending')::int AS pending_access_requests,
            (SELECT count(*) FROM app_requests WHERE status='pending')::int AS pending_app_requests,
            (SELECT count(*) FROM apps WHERE status='active')::int AS apps,
            (SELECT count(*) FROM app_launches WHERE launched_at>now()-interval '30 days')::int AS launches_30d`, [a.districtId]);
        } else if (a.role === "it_admin") {
          home = await one(client, `SELECT
            (SELECT count(*) FROM schools WHERE status='active')::int AS schools,
            (SELECT count(*) FROM district_users WHERE district_id=$1)::int AS people,
            (SELECT count(*) FROM apps WHERE status='active')::int AS apps,
            (SELECT count(*) FROM app_licenses WHERE status='active' AND ends_on BETWEEN current_date AND current_date+60)::int AS licenses_expiring_60d,
            (SELECT count(*) FROM apps WHERE status='active' AND data_sharing_scope<>'none' AND (dpa_status NOT IN ('signed','sdpc_signed') OR dpa_expires_on<current_date))::int AS apps_missing_dpa,
            (SELECT count(*) FROM app_requests WHERE status='pending')::int AS pending_app_requests,
            (SELECT count(*) FROM webhook_subscriptions WHERE status='active')::int AS active_webhooks,
            (SELECT count(*) FROM webhook_subscriptions WHERE status='disabled')::int AS disabled_webhooks,
            (SELECT count(*) FROM sis_sync_runs WHERE created_at>now()-interval '7 days')::int AS sis_runs_7d,
            (SELECT count(*) FROM sis_sync_runs WHERE status='failed' AND created_at>now()-interval '7 days')::int AS sis_failures_7d`, [a.districtId]);
          home.integrations = { webhooksEnabled: Boolean(config.webhookSigningKey), ltiEnabled: Boolean(config.ltiPlatformKey) };
        } else if (a.role === "principal") {
          home = await one(client, `SELECT
            (SELECT name FROM schools WHERE id=$1) AS school_name,
            (SELECT count(*) FROM students WHERE school_id=$1)::int AS students,
            (SELECT count(*) FROM memberships WHERE school_id=$1 AND role='teacher' AND status='active')::int AS teachers,
            (SELECT count(*) FROM student_intervention_cases WHERE school_id=$1 AND status<>'closed')::int AS open_cases,
            (SELECT count(*) FROM student_intervention_cases WHERE school_id=$1 AND status<>'closed' AND follow_up_at<now())::int AS overdue_follow_ups,
            (SELECT count(*) FROM attendance_events e JOIN students s ON s.id=e.student_id WHERE s.school_id=$1 AND e.status='absent' AND e.event_date=current_date)::int AS absent_today,
            (SELECT count(*) FROM attendance_events e JOIN students s ON s.id=e.student_id WHERE s.school_id=$1 AND e.status='absent' AND e.event_date>=current_date-6)::int AS absences_7d,
            (SELECT count(*) FROM guardian_invitations WHERE school_id=$1 AND status='pending')::int AS pending_invitations,
            (SELECT count(*) FROM app_requests WHERE school_id=$1 AND status='pending')::int AS pending_app_requests,
            ${APPS_FOR_SCHOOL} AS apps_available`, [a.schoolId]);
        } else if (a.role === "teacher") {
          home = await one(client, `SELECT
            (SELECT name FROM schools WHERE id=$1) AS school_name,
            (SELECT count(*) FROM students s WHERE s.school_id=$1 AND ${roster("$2")})::int AS students,
            (SELECT count(*) FROM assignments WHERE school_id=$1 AND created_by=$2 AND status='published')::int AS open_assignments,
            (SELECT count(*) FROM assignments WHERE school_id=$1 AND created_by=$2 AND status='draft')::int AS draft_assignments,
            (SELECT count(*) FROM assignment_submissions sub JOIN assignments x ON x.id=sub.assignment_id
               WHERE x.school_id=$1 AND x.created_by=$2 AND sub.score IS NULL)::int AS to_grade,
            (SELECT count(*) FROM student_intervention_cases c WHERE c.school_id=$1 AND c.status<>'closed'
               AND (c.owner_user_id=$2 OR c.created_by=$2))::int AS my_open_cases,
            (SELECT count(*) FROM attendance_events e JOIN students s ON s.id=e.student_id
               WHERE s.school_id=$1 AND ${roster("$2")} AND e.status='absent' AND e.event_date>=current_date-6)::int AS absences_7d,
            ${APPS_FOR_SCHOOL} AS apps_available`, [a.schoolId, a.userId]);
        } else if (a.role === "parent" || a.role === "pupil") {
          const rel = a.role === "parent" ? ["parent", "guardian"] : ["pupil"];
          const kids = await client.query(
            `SELECT s.id,s.display_name,s.grade_level,s.school_id,sc.name AS school_name,
                    (SELECT count(*) FROM attendance_events e WHERE e.student_id=s.id AND e.status='absent' AND e.event_date>=current_date-29)::int AS absences_30d,
                    (SELECT count(*) FROM attendance_events e WHERE e.student_id=s.id AND e.status IN ('absent','tardy') AND e.family_acknowledged_at IS NULL)::int AS to_acknowledge,
                    (SELECT count(*) FROM assignments x WHERE x.school_id=s.school_id AND x.status='published' AND x.due_at BETWEEN now() AND now()+interval '7 days'
                       AND NOT EXISTS(SELECT 1 FROM assignment_submissions sub WHERE sub.assignment_id=x.id AND sub.student_id=s.id))::int AS due_7d,
                    (SELECT count(*) FROM assignments x WHERE x.school_id=s.school_id AND x.status='published' AND x.due_at<now()
                       AND NOT EXISTS(SELECT 1 FROM assignment_submissions sub WHERE sub.assignment_id=x.id AND sub.student_id=s.id))::int AS overdue,
                    (SELECT count(*) FROM assignment_submissions sub WHERE sub.student_id=s.id AND sub.score IS NOT NULL AND sub.held_at IS NULL AND sub.graded_at>now()-interval '14 days')::int AS recently_graded,
                    ${a.role === "parent" ? `(SELECT count(*) FROM student_intervention_cases c WHERE c.student_id=s.id AND c.status<>'closed' AND c.family_visible)::int` : "0"} AS shared_plans
               FROM student_user_links l JOIN students s ON s.id=l.student_id JOIN schools sc ON sc.id=s.school_id
              WHERE l.user_id=$1 AND l.status='active' AND l.relationship=ANY($2) ORDER BY s.display_name`, [a.userId, rel]);
          const nums = kids.rows.map(k => gradeNumber(k.grade_level)).filter(n => n !== null);
          home = { children: kids.rows, youngLearner: a.role === "pupil" && nums.length > 0 && Math.min(...nums) <= YOUNG_LEARNER_MAX_GRADE };
          await client.query(
            `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,outcome,detail,request_id,school_id)
             VALUES($1,$2,$3,'read','home_summary','success',$4,$5,$6)`,
            [a.districtId, a.userId, a.role, `children=${kids.rowCount}`, req.requestId, a.schoolId || null]);
        } else return null;
        return home;
      });
      if (!data) return res.status(403).json({ error: "unsupported_role" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ role: a.role, data });
    } catch (e) { next(e); }
  });
}
