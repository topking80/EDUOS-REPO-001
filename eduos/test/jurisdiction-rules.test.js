// FED-07: jurisdiction rules from policy bundles, and the restrict-only
// enum used for data residency.
import test from "node:test";
import assert from "node:assert/strict";
import { rulesFrom, residencyStatus, recipientAllowed, applyRetentionMinimums } from "../src/jurisdiction-rules.js";
import { validateAuthorityModel, resolvePolicy } from "../src/federation/authority.js";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("../src/federation/authority-catalog.json", import.meta.url), "utf8"));

test("rules default to the catalog and fall back to the strictest reading of a value EduOS doesn't understand", () => {
  const d = rulesFrom([]);
  assert.deepEqual([d.residency, d.auditYears, d.legalHold, d.consentRequired], ["any", 0, false, false]);
  const odd = rulesFrom([{ id: "records.legal_hold", value: "yes" }, { id: "data.residency.scope", value: "moon" }, { id: "records.audit.minimum_years", value: -1 }]);
  assert.deepEqual([odd.legalHold, odd.residency, odd.auditYears], [true, "in_state", 100]);
});

test("residency: declared hosting against the scope, and which recipients are allowed", () => {
  const tx = s => ({ ...rulesFrom([{ id: "data.residency.scope", value: s }]), jurisdictionId: "US-TX" });
  assert.equal(residencyStatus(tx("any"), undefined).status, "met");
  assert.equal(residencyStatus(tx("us"), undefined).status, "undeclared");
  assert.equal(residencyStatus(tx("us"), "US-VA").status, "met");
  assert.equal(residencyStatus(tx("in_state"), "US").status, "undeclared", "a country alone doesn't show the state");
  assert.equal(residencyStatus(tx("in_state"), "US-VA").status, "not_met");
  assert.equal(residencyStatus(tx("in_state"), "US-TX").status, "met");
  assert.equal(residencyStatus(tx("in_state"), "Mars").status, "undeclared");
  assert.equal(recipientAllowed(tx("in_state"), "US-TX"), true);
  assert.equal(recipientAllowed(tx("in_state"), "US-OK"), false);
  assert.equal(recipientAllowed(tx("in_state"), null), false);
  assert.equal(recipientAllowed(tx("us"), "US-OK"), true);
  assert.equal(recipientAllowed(tx("any"), null), true);
});

test("retention minimums only ever raise the configured days", () => {
  const base = { auditDays: 365, closedCaseDays: 2555, roleApps: { safetyDays: 2555, notificationDays: 180 } };
  const { settings, raised } = applyRetentionMinimums(base, rulesFrom([{ id: "records.audit.minimum_years", value: 3 }, { id: "records.safety.minimum_years", value: 1 }]));
  assert.equal(settings.auditDays, 3 * 366); assert.deepEqual(raised, ["audit"]);
  assert.equal(settings.roleApps.safetyDays, base.roleApps.safetyDays, "the server already keeps safety records longer");
  assert.equal(settings.closedCaseDays, base.closedCaseDays);
});

test("a restrict-only enum can only be narrowed below; the catalog validates", () => {
  assert.equal(validateAuthorityModel({ ...catalog, nodes: [], role_assignments: [], delegations: [], policy_settings: [] }).ok, true);
  const bad = { ...catalog, nodes: [], role_assignments: [], delegations: [], policy_settings: [],
    policy_definitions: [{ ...catalog.policy_definitions.find(p => p.id === "data.residency.scope"), value_type: "integer", min: 0, max: 2, default: 0 }] };
  assert.match(validateAuthorityModel(bad).errors.join(";"), /narrower is for enums/);
  const model = { ...catalog, policy_settings: [
    { id: "ps-s", policy_id: "data.residency.scope", node_id: "sea", value: "us", version: 1, status: "active", effective_from: "2026-01-01", reason: "r" },
    { id: "ps-d", policy_id: "data.residency.scope", node_id: "dist", value: "any", version: 1, status: "active", effective_from: "2026-01-01", reason: "r" }],
    nodes: [{ id: "p", kind: "platform", status: "active", effective_from: "2026-01-01" },
      { id: "sea", kind: "state_education_authority", parent_id: "p", jurisdiction_id: "US-TX", status: "active", effective_from: "2026-01-01" },
      { id: "dist", kind: "district", parent_id: "sea", jurisdiction_id: "US-TX", tenant_ref: "t", status: "active", effective_from: "2026-01-01" }] };
  const wider = resolvePolicy(model, "data.residency.scope", "dist", "2026-06-01");
  assert.equal(wider.value, "us"); assert.equal(wider.conflicts[0].reason, "looser_than_inherited");
  model.policy_settings[1].value = "in_state";
  assert.equal(resolvePolicy(model, "data.residency.scope", "dist", "2026-06-01").value, "in_state");
});
