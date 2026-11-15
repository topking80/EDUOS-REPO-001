// Staff AI gateway: one place that decides who may use which AI use case, with
// what data, within what budget. Ported from EdOS app/backend/app/ai/gateway.py
// and rebuilt on EduOS sessions, roles and row-level security.
//
// Rules:
// - A use case runs only if the superintendent enabled it for the district and
//   the caller's role is allowed it. Students and families have none here
//   (student tutoring is Christie, with its own controls).
// - The AI never queries student records. Input is the text the staff member
//   typed, or for the operations brief, counts EduOS computes inside the
//   caller's own tenant transaction from what they may already see.
// - District and per-person daily token budgets.
// - Usage is recorded (use case, tokens, provider), never the prompt or the
//   answer. Every call is audited.

export const USECASES = Object.freeze({
  lesson_draft: { label: "Lesson draft", roles: ["teacher", "principal", "vice_principal", "superintendent"], input: { min: 3, max: 500 } },
  resource_summary: { label: "Summarize a resource", roles: ["teacher", "principal", "vice_principal", "superintendent", "counselor", "librarian"], input: { min: 20, max: 12000 } },
  writing_feedback: { label: "Writing feedback", roles: ["teacher", "principal", "vice_principal"], input: { min: 20, max: 12000 } },
  ops_brief: { label: "Operations brief", roles: ["principal", "vice_principal", "superintendent"], input: null },
});
export const POLICY_EDITORS = ["superintendent"];
export const POLICY_READERS = ["superintendent", "it_admin", "principal"];

export const estimateTokens = (text) => Math.max(1, Math.ceil(String(text || "").length / 4));

/** Why this caller can't run this use case, or null. Pure, for tests. */
export function denial({ usecase, role, enabled }) {
  const u = USECASES[usecase];
  if (!u) return "unknown_ai_usecase";
  if (!u.roles.includes(role)) return "ai_usecase_not_for_your_role";
  if (!enabled.includes(usecase)) return "ai_usecase_not_enabled";
  return null;
}

export async function policyOf(c, districtId) {
  const r = (await c.query("SELECT enabled_usecases, daily_token_cap, user_daily_token_cap, updated_at FROM ai_district_policy WHERE district_id=$1", [districtId])).rows[0];
  return r || { enabled_usecases: [], daily_token_cap: 200000, user_daily_token_cap: 20000, updated_at: null };
}

export async function usedToday(c, districtId, userId) {
  const r = (await c.query(`SELECT coalesce(sum(tokens_in + tokens_out), 0)::int AS district,
      coalesce(sum(tokens_in + tokens_out) FILTER (WHERE user_id = $2), 0)::int AS mine
    FROM ai_usage WHERE district_id = $1 AND created_at >= date_trunc('day', now())`, [districtId, userId])).rows[0];
  return { district: r.district, user: r.mine };
}

/**
 * The operations brief's only input: counts within the caller's scope (the
 * whole district for a superintendent, their own school otherwise). Runs in
 * the caller's tenant transaction, so row-level security applies as well.
 */
export async function opsContext(c, actor) {
  const school = actor.role === "superintendent" ? null : actor.schoolId;
  if (actor.role !== "superintendent" && !school) throw Object.assign(new Error("school_scope_required"), { status: 403 });
  const args = [actor.districtId, school];
  const one = async (sql) => (await c.query(sql, args)).rows[0];
  const att = (await c.query(`SELECT ae.status, count(*)::int AS n FROM attendance_events ae
      JOIN students s ON s.id = ae.student_id AND s.district_id = ae.district_id
     WHERE ae.district_id = $1 AND ($2::uuid IS NULL OR s.school_id = $2) AND ae.event_date = eduos_school_today(s.school_id)
     GROUP BY ae.status`, args)).rows;
  const by = Object.fromEntries(att.map(r => [r.status, r.n]));
  return {
    scope: school ? "school" : "district",
    day: new Date().toISOString().slice(0, 10),
    schools: (await one("SELECT count(*)::int AS n FROM schools WHERE district_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR id = $2)")).n,
    attendance: { marked: att.reduce((n, r) => n + r.n, 0), present: by.present || 0, tardy: by.tardy || 0, absent: by.absent || 0, excused: by.excused || 0 },
    activeSafetyIncidents: (await one("SELECT count(*)::int AS n FROM safety_incidents WHERE district_id = $1 AND ($2::uuid IS NULL OR school_id = $2) AND status IN ('pending','active','reunification')")).n,
    openServiceWork: (await one("SELECT count(*)::int AS n FROM school_service_work WHERE district_id = $1 AND ($2::uuid IS NULL OR school_id = $2) AND status IN ('open','in_progress')")).n,
    coverageNeeded: (await one("SELECT count(*)::int AS n FROM substitute_coverage_requests WHERE district_id = $1 AND ($2::uuid IS NULL OR school_id = $2) AND status IN ('pending','approved') AND ends_at >= now()")).n,
  };
}

/** Names and student numbers of the students the caller could see, removed
 *  from text before it leaves the server (on top of the generic redaction of
 *  emails, phone numbers, URLs and id-like strings). */
export async function namesToRedact(c, actor) {
  const r = actor.role === "teacher"
    ? await c.query(`SELECT s.display_name, s.local_student_number FROM teacher_student_rosters r JOIN students s ON s.id = r.student_id AND s.district_id = r.district_id
        WHERE r.district_id = $1 AND r.teacher_user_id = $2 LIMIT 2000`, [actor.districtId, actor.userId])
    : await c.query("SELECT display_name, local_student_number FROM students WHERE district_id = $1 AND school_id = $2 LIMIT 5000", [actor.districtId, actor.schoolId]);
  return r.rows.flatMap(x => [x.display_name, x.local_student_number]);
}
