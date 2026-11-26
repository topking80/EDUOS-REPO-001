// FED-02: delegated authority, scoped roles, district autonomy and policy
// inheritance (src/federation/authority.js over the authority-model contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateAuthorityModel, authorize, resolvePolicy } from "../src/federation/authority.js";

const dir = new URL("../../docs/architecture/federation/", import.meta.url);
const seed = JSON.parse(readFileSync(new URL("authority-model.v0.1.json", dir), "utf8"));
const schema = JSON.parse(readFileSync(new URL("authority-model.schema.json", dir), "utf8"));

function validateSchemaSubset(value, def, path = "$") {
  const errors = [];
  if (def.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    for (const k of def.required ?? []) if (!Object.hasOwn(value, k)) errors.push(`${path}.${k} is required`);
    if (def.additionalProperties === false) for (const k of Object.keys(value)) if (!Object.hasOwn(def.properties ?? {}, k)) errors.push(`${path}.${k} is not declared`);
    for (const [k, child] of Object.entries(def.properties ?? {})) if (Object.hasOwn(value, k)) errors.push(...validateSchemaSubset(value[k], child, `${path}.${k}`));
  } else if (def.type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (def.minItems !== undefined && value.length < def.minItems) errors.push(`${path} has too few items`);
    if (def.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) errors.push(`${path} items must be unique`);
    if (def.items) value.forEach((v, i) => errors.push(...validateSchemaSubset(v, def.items, `${path}[${i}]`)));
  } else {
    const types = { string: v => typeof v === "string", integer: Number.isInteger, boolean: v => typeof v === "boolean" };
    if (def.type && types[def.type] && !types[def.type](value)) return [`${path} must be ${def.type}`];
    if (def.enum && !def.enum.includes(value)) errors.push(`${path} has an unsupported value`);
    if (def.minLength !== undefined && value.length < def.minLength) errors.push(`${path} is too short`);
    if (def.pattern && typeof value === "string" && !new RegExp(def.pattern).test(value)) errors.push(`${path} has an invalid format`);
    if (def.format === "date" && !(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))) errors.push(`${path} must be an ISO date`);
  }
  return errors;
}

// A small federation: two Texas districts and one in Oklahoma.
const ON = "2026-12-01";
const node = (id, kind, parent_id, jurisdiction_id, tenant_ref) => ({ id, kind, ...(parent_id && { parent_id }), ...(jurisdiction_id && { jurisdiction_id }), ...(tenant_ref && { tenant_ref }), status: "active", effective_from: "2026-01-01" });
const assign = (id, principal_id, role_id, node_id, extra = {}) => ({ id, principal_id, role_id, node_id, status: "active", effective_from: "2026-01-01", approval_reference: `appr-${id}`, ...extra });
function fixture() {
  const m = structuredClone(seed);
  m.nodes = [
    node("platform", "platform"),
    node("tx-sea", "state_education_authority", "platform", "US-TX"),
    node("ok-sea", "state_education_authority", "platform", "US-OK"),
    node("d1", "district", "tx-sea", "US-TX", "tenant-d1"),
    node("d2", "district", "tx-sea", "US-TX", "tenant-d2"),
    node("d3", "district", "ok-sea", "US-OK", "tenant-d3"),
    node("k1", "school", "d1", "US-TX", "tenant-d1"),
    node("k2", "school", "d2", "US-TX", "tenant-d2"),
  ];
  m.role_assignments = [
    assign("a-op", "op", "platform-operator", "platform"),
    assign("a-tea", "tea", "state-oversight", "tx-sea"),
    assign("a-osde", "osde", "state-oversight", "ok-sea"),
    assign("a-sup1", "sup1", "district-superintendent", "d1"),
    assign("a-sup2", "sup2", "district-superintendent", "d2"),
    assign("a-sup3", "sup3", "district-superintendent", "d3"),
    assign("a-it1", "it1", "district-it-admin", "d1"),
    assign("a-pr1", "pr1", "school-principal", "k1"),
  ];
  return m;
}
const can = (m, principal_id, capability_id, node_id, at = ON, purpose) => authorize(m, { principal_id, capability_id, node_id, at, purpose });
const errorsOf = m => validateAuthorityModel(m).errors.join("\n");

test("the seed is a valid model and conforms to the schema; nothing about real people or districts is seeded", () => {
  assert.deepEqual(validateAuthorityModel(seed).errors, []);
  assert.deepEqual(validateSchemaSubset(seed, schema), []);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  for (const k of ["nodes", "role_assignments", "delegations", "policy_settings"]) assert.deepEqual(seed[k], [], `${k} stays empty until real records are approved`);
  assert.deepEqual(validateAuthorityModel(fixture()).errors, []);
});

test("the catalog keeps student records in the district: identifiable, held only at district/school, never reaching past the tenant", () => {
  const caps = new Map(seed.capabilities.map(c => [c.id, c]));
  for (const c of seed.capabilities.filter(c => c.student_data === "identifiable")) {
    assert.match(c.id, /^student\.records\./);
    assert.deepEqual(c.assignable_levels, ["district", "school"]);
    assert.equal(c.reach, "tenant");
  }
  assert.equal(caps.get("student.storage_quota.set").district_reserved, true);
  assert.equal(caps.get("tenant.roles.assign").delegable, false, "the district keeps who-administers-what");
  // A catalog can't loosen the hard rules.
  const m = structuredClone(seed);
  m.capabilities.find(c => c.id === "student.records.read").assignable_levels = ["state_education_authority", "district", "school"];
  m.capabilities.push({ id: "student.records.export", domain: "x", student_data: "none", assignable_levels: ["platform"], reach: "descendants", delegable: true, description: "x" });
  const e = errorsOf(m);
  assert.match(e, /student\.records\.read: identifiable student data can't be held above a district/);
  assert.match(e, /student\.records\.export: student\.records\.\* capabilities are identifiable student data/);
});

test("the education hierarchy is platform, state authority, district, school; associations aren't nodes", () => {
  const bad = f => { const m = fixture(); f(m); return errorsOf(m); };
  assert.match(bad(m => { m.nodes.find(n => n.id === "k1").parent_id = "tx-sea"; }), /nodes\.k1: a school sits under a district/);
  assert.match(bad(m => { m.nodes.push(node("uil", "independent_association", "tx-sea", "US-TX")); }), /athletics associations are a separate graph/);
  assert.match(bad(m => { delete m.nodes.find(n => n.id === "d1").tenant_ref; }), /nodes\.d1: tenant_ref is required/);
  assert.match(bad(m => { m.nodes.find(n => n.id === "d1").jurisdiction_id = "US-OK"; }), /nodes\.d1: must share its parent's jurisdiction/);
  assert.match(bad(m => { m.nodes.find(n => n.id === "k1").tenant_ref = "tenant-d2"; }), /a school belongs to its district's tenant/);
  assert.match(bad(m => { m.nodes.push(node("platform-2", "platform")); }), /exactly one platform node/);
  assert.match(bad(m => { m.role_assignments.push(assign("a-x", "x", "state-oversight", "d1")); }), /a state_education_authority role is assigned at a state_education_authority, not a district/);
});

test("no platform or state role reaches identifiable student records; districts reach only their own", () => {
  const m = fixture();
  for (const who of ["op", "tea"]) for (const where of ["d1", "k1"]) {
    const r = can(m, who, "student.records.read", where);
    assert.equal(r.allowed, false, `${who} at ${where}`); assert.equal(r.reason, "student_data_outside_tenant_or_role");
  }
  assert.equal(can(m, "sup1", "student.records.read", "k1").allowed, true);
  assert.equal(can(m, "sup1", "student.records.read", "k2").allowed, false, "another district");
  assert.equal(can(m, "pr1", "student.records.read", "k1").allowed, true);
  assert.equal(can(m, "pr1", "student.records.read", "d1").allowed, false, "a principal's reach is their school");
  // Even an unvalidated model that hands a state role student records gets nothing.
  m.role_definitions.push({ id: "state-snoop", level: "state_education_authority", name: "x", capabilities: ["student.records.read"], status: "active" });
  m.role_assignments.push(assign("a-snoop", "snoop", "state-snoop", "tx-sea"));
  assert.match(errorsOf(m), /state-snoop: student\.records\.read can't be held at state_education_authority/);
  assert.equal(can(m, "snoop", "student.records.read", "k1").allowed, false);
});

test("state oversight sees aggregates and health below it but can't administer a district unless the district delegates it", () => {
  const m = fixture();
  assert.equal(can(m, "tea", "reporting.aggregate.view", "k1").allowed, true);
  assert.equal(can(m, "tea", "reporting.aggregate.view", "d3").allowed, false, "another state");
  assert.equal(can(m, "tea", "tenant.users.manage", "d1").allowed, false);
  assert.equal(can(m, "op", "school.operations.manage", "k1").allowed, false);
  assert.equal(can(m, "op", "federation.membership.manage", "d3").allowed, true);
  // District 1 asks the state to help run school operations for two weeks.
  m.delegations.push({ id: "dl-storm", from_assignment_id: "a-sup1", delegate_principal_id: "tea", delegate_home_node_id: "tx-sea", node_id: "d1",
    capabilities: ["school.operations.manage"], purpose: "storm recovery coordination", may_redelegate: false, status: "active",
    effective_from: "2026-12-01", effective_to: "2026-12-14", approval_reference: "board-2026-77" });
  assert.deepEqual(validateAuthorityModel(m).errors, []);
  const ok = can(m, "tea", "school.operations.manage", "k1", "2026-12-05", "storm recovery coordination");
  assert.equal(ok.allowed, true); assert.deepEqual(ok.basis, { type: "delegation", id: "dl-storm", chain: ["dl-storm"], from_assignment_id: "a-sup1", purpose: "storm recovery coordination" });
  assert.equal(can(m, "tea", "school.operations.manage", "k1", "2026-12-05", "routine audit").reason, "purpose_mismatch");
  assert.equal(can(m, "tea", "school.operations.manage", "k1", "2026-12-15").allowed, false, "ended");
  assert.equal(can(m, "tea", "school.operations.manage", "k2", "2026-12-05").allowed, false, "only the district that delegated");
  assert.equal(can(m, "tea", "tenant.users.manage", "d1", "2026-12-05").allowed, false, "only what was delegated");
});

test("student data and tenant role assignment can't be delegated out of the district; delegations never enlarge authority", () => {
  const m = fixture();
  const d = (id, extra) => ({ id, delegate_principal_id: "tea", delegate_home_node_id: "tx-sea", node_id: "d1", purpose: "p", may_redelegate: false, status: "active",
    effective_from: "2026-12-01", effective_to: "2026-12-31", approval_reference: "r", ...extra });
  m.delegations.push(d("dl-records", { from_assignment_id: "a-sup1", capabilities: ["student.records.read"] }));
  m.delegations.push(d("dl-roles", { from_assignment_id: "a-sup1", capabilities: ["tenant.roles.assign"] }));
  m.delegations.push(d("dl-big", { from_assignment_id: "a-it1", capabilities: ["school.operations.manage"] }));
  m.delegations.push(d("dl-forever", { from_assignment_id: "a-sup1", capabilities: ["audit.view"], effective_to: undefined }));
  const e = errorsOf(m);
  assert.match(e, /dl-records: student\.records\.read is student data; it can only be delegated within the same district/);
  assert.match(e, /dl-roles: tenant\.roles\.assign can't be delegated/);
  assert.match(e, /dl-big: the delegator doesn't hold school\.operations\.manage over d1/);
  assert.match(e, /dl-forever: a delegation needs an end date/);
  assert.equal(can(m, "tea", "student.records.read", "k1", "2026-12-05", "p").allowed, false);
  assert.equal(can(m, "tea", "tenant.roles.assign", "d1", "2026-12-05", "p").allowed, false);
  assert.equal(can(m, "tea", "school.operations.manage", "d1", "2026-12-05", "p").allowed, false);
});

test("revoking a link stops everything delegated through it from that date, without rewriting earlier dates", () => {
  const m = fixture();
  const link = (id, extra) => ({ id, node_id: "k1", capabilities: ["student.records.read"], purpose: "attendance review", status: "active",
    effective_from: "2026-12-01", effective_to: "2027-01-31", approval_reference: "r", ...extra });
  m.delegations.push(link("dl-c1", { from_assignment_id: "a-sup1", delegate_principal_id: "c1", delegate_home_node_id: "k1", may_redelegate: true }));
  m.delegations.push(link("dl-c2", { from_delegation_id: "dl-c1", delegate_principal_id: "c2", delegate_home_node_id: "k1", may_redelegate: false }));
  m.delegations.push(link("dl-c3", { from_delegation_id: "dl-c2", delegate_principal_id: "c3", delegate_home_node_id: "k1", may_redelegate: false }));
  assert.deepEqual(validateAuthorityModel(m).errors.filter(x => !x.includes("dl-c3")), []);
  assert.match(errorsOf(m), /dl-c3: the delegator doesn't hold student\.records\.read over k1/, "dl-c2 may not redelegate");
  assert.deepEqual(can(m, "c2", "student.records.read", "k1", "2026-12-10").basis.chain, ["dl-c2", "dl-c1"]);
  assert.equal(can(m, "c3", "student.records.read", "k1", "2026-12-10").allowed, false);
  Object.assign(m.delegations[0], { status: "revoked", revoked_on: "2026-12-20" });
  assert.equal(can(m, "c2", "student.records.read", "k1", "2026-12-19").allowed, true, "before the revocation");
  assert.equal(can(m, "c2", "student.records.read", "k1", "2026-12-20").allowed, false, "from the revocation date");
  // The superintendent leaving ends it too.
  Object.assign(m.delegations[0], { status: "active", revoked_on: undefined });
  Object.assign(m.role_assignments.find(a => a.id === "a-sup1"), { effective_to: "2026-12-24" });
  assert.equal(can(m, "c2", "student.records.read", "k1", "2026-12-25").allowed, false);
});

test("effective dates, suspended assignments and closed nodes deny", () => {
  const m = fixture();
  m.role_assignments.push(assign("a-new", "new", "school-principal", "k1", { effective_from: "2027-01-01" }));
  assert.equal(can(m, "new", "school.operations.manage", "k1").allowed, false);
  assert.equal(can(m, "new", "school.operations.manage", "k1", "2027-01-01").allowed, true);
  Object.assign(m.role_assignments.find(a => a.id === "a-pr1"), { status: "suspended", suspended_on: "2026-11-15" });
  assert.equal(can(m, "pr1", "school.operations.manage", "k1").allowed, false);
  assert.equal(can(m, "pr1", "school.operations.manage", "k1", "2026-11-14").allowed, true, "the past isn't rewritten");
  m.role_assignments.push(assign("a-prop", "prop", "school-principal", "k1", { status: "proposed" }));
  assert.equal(can(m, "prop", "school.operations.manage", "k1").allowed, false, "proposed never counts");
  m.nodes.find(n => n.id === "k2").effective_to = "2026-06-30";
  assert.equal(can(m, "sup2", "school.operations.manage", "k2").reason, "node_inactive");
  assert.equal(can(m, "sup1", "nonexistent.cap", "k1").reason, "unknown_capability");
  assert.equal(can(m, "sup1", "audit.view", "nowhere").reason, "unknown_node");
});

test("policies inherit down the hierarchy: locks hold, restrict-only can't be loosened, district-reserved stays with the district", () => {
  const m = fixture();
  let n = 0;
  const set = (policy_id, node_id, value, by, extra = {}) => m.policy_settings.push({ id: `ps-${++n}`, policy_id, node_id, value, version: 1, status: "active",
    effective_from: "2026-09-01", set_by_assignment_id: by, reason: "test", ...extra });
  set("security.mfa.required_for_staff", "tx-sea", true, "a-tea", { lock_descendants: true });
  set("security.mfa.required_for_staff", "d1", false, "a-sup1");
  set("history.retention.minimum_years", "tx-sea", 5, "a-tea");
  set("history.retention.minimum_years", "d1", 7, "a-sup1");
  set("history.retention.minimum_years", "d2", 3, "a-sup2");
  set("media.photo_uploads.enabled", "d1", true, "a-sup1");
  set("media.photo_uploads.enabled", "k1", false, "a-pr1");
  set("student.storage_quota_mb_per_pupil", "d1", 500, "a-sup1");
  set("ui.default_locale", "d2", "es-US", "a-sup2");
  assert.deepEqual(validateAuthorityModel(m).errors, []);
  const mfa = resolvePolicy(m, "security.mfa.required_for_staff", "k1", ON);
  assert.equal(mfa.value, true); assert.deepEqual(mfa.conflicts, [{ setting_id: "ps-2", node_id: "d1", reason: "locked_by:ps-1" }]);
  assert.equal(resolvePolicy(m, "security.mfa.required_for_staff", "d3", ON).value, false, "Oklahoma isn't bound by Texas");
  assert.equal(resolvePolicy(m, "history.retention.minimum_years", "k1", ON).value, 7, "a district may keep longer");
  const d2 = resolvePolicy(m, "history.retention.minimum_years", "d2", ON);
  assert.equal(d2.value, 5); assert.equal(d2.conflicts[0].reason, "looser_than_inherited");
  assert.equal(resolvePolicy(m, "media.photo_uploads.enabled", "k1", ON).value, false, "a school may turn it off");
  assert.equal(resolvePolicy(m, "student.storage_quota_mb_per_pupil", "k1", ON).value, 500);
  assert.equal(resolvePolicy(m, "ui.default_locale", "k2", ON).value, "es-US");
  assert.equal(resolvePolicy(m, "ui.default_locale", "k1", ON).source, "default");
  // Versions: the newest active setting wins; superseded ones don't count.
  set("history.retention.minimum_years", "d1", 9, "a-sup1", { version: 2 });
  m.policy_settings.find(s => s.id === "ps-4").status = "superseded";
  assert.deepEqual(resolvePolicy(m, "history.retention.minimum_years", "d1", ON).chain.map(c => [c.setting_id, c.value]), [["ps-3", 5], ["ps-10", 9]]);
  assert.equal(resolvePolicy(m, "history.retention.minimum_years", "d1", "2026-08-31").value, 0, "nothing in force yet");
});

test("nobody above the district sets district-reserved policy, and settings need policy.set at that node", () => {
  const m = fixture();
  const s = (id, policy_id, node_id, value, by, extra = {}) => ({ id, policy_id, node_id, value, version: 1, status: "active", effective_from: "2026-09-01", set_by_assignment_id: by, reason: "x", ...extra });
  m.policy_settings.push(s("ps-quota", "student.storage_quota_mb_per_pupil", "tx-sea", 50, "a-tea"));
  m.policy_settings.push(s("ps-reach", "ui.default_locale", "d1", "es-US", "a-tea"));
  m.policy_settings.push(s("ps-lock", "ui.default_locale", "d2", "es-US", "a-sup2", { lock_descendants: true }));
  m.policy_settings.push(s("ps-type", "history.retention.minimum_years", "d2", "ten", "a-sup2"));
  const e = errorsOf(m);
  assert.match(e, /ps-quota: student\.storage_quota_mb_per_pupil can't be set at a state_education_authority/);
  assert.match(e, /ps-reach: whoever set it couldn't set policy at that node/, "a state can't set policy at a district's node");
  assert.match(e, /ps-lock: ui\.default_locale can't be locked at a district/);
  assert.match(e, /ps-type: value doesn't fit the policy/);
  const q = resolvePolicy(m, "student.storage_quota_mb_per_pupil", "k1", ON);
  assert.equal(q.value, 0); assert.equal(q.conflicts[0].reason, "not_settable_here");
  const bad = structuredClone(seed);
  bad.policy_definitions.find(p => p.id === "student.storage_quota_mb_per_pupil").settable_levels = ["state_education_authority", "district"];
  assert.match(errorsOf(bad), /a district-reserved policy is set only by the district/);
});
