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


/** Why this caller can't run this use case, or null. Pure, for tests. */
export function denial({ usecase, role, enabled }) {
  const u = USECASES[usecase];
  if (!u) return "unknown_ai_usecase";
  if (!u.roles.includes(role)) return "ai_usecase_not_for_your_role";
  if (!enabled.includes(usecase)) return "ai_usecase_not_enabled";
  return null;
}

export async function policyOf(c, districtId) {
  const r = (await c.query("SELECT enabled_usecases, daily_token_cap, user_daily_token_cap, external_provider_enabled, external_provider_acknowledged_at, updated_at FROM ai_district_policy WHERE district_id=$1", [districtId])).rows[0];
  return r || { enabled_usecases: [], daily_token_cap: 200000, user_daily_token_cap: 20000, external_provider_enabled: false, external_provider_acknowledged_at: null, updated_at: null };
}

// Today's tokens. A reservation ('pending') counts in full until it is
// settled or given back, for the rest of the day if need be: it never lapses
// on a timer. A request whose bookkeeping failed after the provider was
// called, or a server that stopped mid-request, therefore leaves the budget
// over-counted (safe), never under-counted.
const USED = `tokens_in + tokens_out`;
export async function usedToday(c, districtId, userId) {
  const r = (await c.query(`SELECT coalesce(sum(${USED}), 0)::int AS district,
      coalesce(sum(${USED}) FILTER (WHERE user_id = $2), 0)::int AS mine
    FROM ai_usage WHERE district_id = $1 AND created_at >= date_trunc('day', now())`, [districtId, userId])).rows[0];
  return { district: r.district, user: r.mine };
}

/**
 * Atomically checks both daily budgets and reserves room for this request
 * (a 'pending' usage row) before anything is sent to a model. Requests in one
 * district take turns here (a transaction-scoped advisory lock), so
 * simultaneous requests can't all pass the same check. Returns the
 * reservation id, or throws with a status (403 tool off, 429 budget).
 */
export const lockDistrictAi = (c, districtId) => c.query("SELECT pg_advisory_xact_lock(hashtext('eduos-ai-budget'), hashtext($1::text))", [districtId]);

export async function reserveBudget(c, actor, usecase, reserve, { requireExternal = false } = {}) {
  await lockDistrictAi(c, actor.districtId);
  // Read the policy only now, under the lock that policy changes also take:
  // a request can't reserve against a budget or a tool the superintendent
  // has just lowered or turned off.
  const policy = await policyOf(c, actor.districtId);
  if (requireExternal && !policy.external_provider_enabled) throw Object.assign(new Error("ai_external_provider_disabled"), { status: 403 });
  const why = denial({ usecase, role: actor.role, enabled: policy.enabled_usecases });
  if (why) throw Object.assign(new Error(why), { status: 403 });
  // A request that could never fit is refused as such, not as "used up".
  if (reserve > policy.daily_token_cap || reserve > policy.user_daily_token_cap) throw Object.assign(new Error("ai_request_exceeds_budget"), { status: 429 });
  const used = await usedToday(c, actor.districtId, actor.userId);
  if (used.district + reserve > policy.daily_token_cap) throw Object.assign(new Error("ai_district_budget_reached"), { status: 429 });
  if (used.user + reserve > policy.user_daily_token_cap) throw Object.assign(new Error("ai_your_budget_reached"), { status: 429 });
  return (await c.query(`INSERT INTO ai_usage(district_id, school_id, user_id, role, usecase, provider, outcome, tokens_in, tokens_out)
      VALUES ($1,$2,$3,$4,$5,'local','pending',$6,0) RETURNING id`, [actor.districtId, actor.schoolId || null, actor.userId, actor.role, usecase, reserve])).rows[0].id;
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
    // The school's own date (the one its attendance is counted for), not UTC's.
    day: (await c.query(`SELECT string_agg(DISTINCT eduos_school_today(id)::text, ' / ') AS d FROM schools
        WHERE district_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR id = $2)`, args)).rows[0].d || new Date().toISOString().slice(0, 10),
    schools: (await one("SELECT count(*)::int AS n FROM schools WHERE district_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR id = $2)")).n,
    attendance: { marked: att.reduce((n, r) => n + r.n, 0), present: by.present || 0, tardy: by.tardy || 0, absent: by.absent || 0, excused: by.excused || 0 },
    activeSafetyIncidents: (await one("SELECT count(*)::int AS n FROM safety_incidents WHERE district_id = $1 AND ($2::uuid IS NULL OR school_id = $2) AND status IN ('pending','active','reunification')")).n,
    openServiceWork: (await one("SELECT count(*)::int AS n FROM school_service_work WHERE district_id = $1 AND ($2::uuid IS NULL OR school_id = $2) AND status IN ('open','in_progress')")).n,
    coverageNeeded: (await one("SELECT count(*)::int AS n FROM substitute_coverage_requests WHERE district_id = $1 AND ($2::uuid IS NULL OR school_id = $2) AND status IN ('pending','approved') AND ends_at >= now()")).n,
  };
}

