// SEC-02: how the row-security coverage test reads a policy expression.
export const KEYWORDS = new Set(["and", "or", "not", "is", "null", "true", "false", "any", "array", "text", "uuid", "case", "when", "then", "else", "end",
  "current_setting", "nullif", "coalesce", "app", "district_id", "school_id", "role",
  "eduos_ctx_district", "eduos_ctx_school", "eduos_ctx_role", "eduos_is_table_owner", "eduos_is_district_role", "eduos_owner_session"]);
const OWNER_ONLY = new Set(["or", "eduos_is_table_owner", "eduos_owner_session"]);
/** A permissive policy that only lets the table owner through grants the runtime role nothing. */
export function isOwnerOnly(expr) {
  const ids = String(expr ?? "").toLowerCase().match(/[a-z_][a-z0-9_]*/g) || [];
  return ids.length > 0 && ids.every(id => OWNER_ONLY.has(id));
}
/** A policy expression is broad when, string literals aside, it only names district, school, role or owner checks. */
export function isBroad(expr) {
  if (expr == null) return true; // no USING clause: every row
  const ids = String(expr).replace(/'(?:[^']|'')*'/g, " ").toLowerCase().match(/[a-z_][a-z0-9_]*/g) || [];
  return ids.every(id => KEYWORDS.has(id));
}

