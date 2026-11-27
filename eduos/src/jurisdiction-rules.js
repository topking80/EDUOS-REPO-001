// FED-07: the jurisdiction rules in force for a district, from the signed
// policy bundles it received from Master Control (FED-05). A bundle is in
// force from its effective_from date; the newest one in force wins. With no
// bundle in force every rule is at its catalog default.
//
// What EduOS does with them:
//   * retention minimums: the retention job never purges sooner (src/retention.js);
//   * legal hold: the retention job deletes no district records, and student
//     records can't be deleted;
//   * consent reference: no exchange report from terms without one;
//   * residency: exchange reports only to recipients the scope allows, and the
//     hosting location the operator declares (EDUOS_DATA_LOCATION) is compared
//     with the scope and shown to the district. EduOS can't check where it is
//     really hosted; the status says "declared".
import { readFileSync } from "node:fs";
import { mcKeyRing } from "./federation/key-ring.js";

const catalog = JSON.parse(readFileSync(new URL("./federation/authority-catalog.json", import.meta.url), "utf8"));

export const RULES = {
  residency: "data.residency.scope",
  auditYears: "records.audit.minimum_years",
  closedCaseYears: "records.closed_cases.minimum_years",
  safetyYears: "records.safety.minimum_years",
  historyYears: "history.retention.minimum_years",
  legalHold: "records.legal_hold",
  consentRequired: "exchange.consent_reference.required",
};
const def = id => catalog.policy_definitions.find(p => p.id === id);
const today = () => new Date().toISOString().slice(0, 10);

/** Rule values from one bundle's policy list (or defaults), checked against the catalog. */
export function rulesFrom(policies = [], meta = {}) {
  const out = { ...meta };
  for (const [key, id] of Object.entries(RULES)) {
    const pd = def(id), p = (policies || []).find(x => x.id === id);
    let v = p ? p.value : pd.default;
    const ok = pd.value_type === "boolean" ? typeof v === "boolean"
      : pd.value_type === "integer" ? Number.isInteger(v) && v >= (pd.min ?? 0) && v <= (pd.max ?? 100)
      : pd.allowed_values.includes(v);
    // A value EduOS doesn't understand falls back to the strictest reading.
    if (!ok) v = pd.value_type === "boolean" ? pd.stricter === "true" : pd.value_type === "integer" ? pd.max : pd.allowed_values.at(-1);
    out[key] = v;
  }
  return out;
}

/**
 * The rules in force for the transaction's district on `on` (YYYY-MM-DD).
 * FED-08: bundles signed with a revoked Master Control key aren't followed.
 */
export async function rulesInForce(client, on = today(), revoked = [...mcKeyRing().revoked]) {
  const { rows: [b] } = await client.query(`SELECT version, bundle FROM district_policy_bundles
     WHERE (bundle->>'effective_from') <= $1 AND NOT (key_fingerprint = ANY($2::text[])) ORDER BY version DESC LIMIT 1`, [on, revoked]);
  if (!b) return rulesFrom([], { bundleVersion: null, jurisdictionId: null });
  return rulesFrom(b.bundle.policies, { bundleVersion: b.version, jurisdictionId: b.bundle.district?.jurisdiction_id || null, effectiveFrom: b.bundle.effective_from });
}

/** May data go to a recipient in `recipientJurisdiction` under these rules? */
export function recipientAllowed(rules, recipientJurisdiction) {
  if (rules.residency === "in_state") return !!rules.jurisdictionId && recipientJurisdiction === rules.jurisdictionId;
  if (rules.residency === "us") return /^US(-[A-Z]{2})?$/.test(recipientJurisdiction || "");
  return true;
}

/**
 * The declared hosting location against the residency scope.
 * EDUOS_DATA_LOCATION: "US" or a state such as "US-TX".
 */
export function residencyStatus(rules, location = process.env.EDUOS_DATA_LOCATION) {
  const declared = /^US(-[A-Z]{2})?$/.test(location || "") ? location : null;
  const base = { scope: rules.residency, declaredLocation: declared, jurisdictionId: rules.jurisdictionId };
  if (rules.residency === "any") return { ...base, status: "met" };
  if (!declared) return { ...base, status: "undeclared" };
  if (rules.residency === "us") return { ...base, status: "met" };
  // in_state: only a declared state can meet it.
  if (!rules.jurisdictionId || declared === "US") return { ...base, status: "undeclared" };
  return { ...base, status: declared === rules.jurisdictionId ? "met" : "not_met" };
}

const DAY_YEAR = 366; // never shorter than the years asked for, leap years included

/** Retention settings for one district, raised to the rules' minimums. */
export function applyRetentionMinimums(settings, rules) {
  const floor = (days, years) => Math.max(days, (years || 0) * DAY_YEAR);
  const raised = [];
  const audit = floor(settings.auditDays, rules.auditYears), cases = floor(settings.closedCaseDays, rules.closedCaseYears);
  const safety = floor(settings.roleApps.safetyDays, rules.safetyYears);
  if (audit !== settings.auditDays) raised.push("audit");
  if (cases !== settings.closedCaseDays) raised.push("closed_cases");
  if (safety !== settings.roleApps.safetyDays) raised.push("safety");
  return { settings: { ...settings, auditDays: audit, closedCaseDays: cases, roleApps: { ...settings.roleApps, safetyDays: safety } }, raised };
}
