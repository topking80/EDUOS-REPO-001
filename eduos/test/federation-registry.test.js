import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const registryUrl = new URL("../../docs/architecture/federation/registry-seed.v0.1.json", import.meta.url);
const schemaUrl = new URL("../../docs/architecture/federation/registry-seed.schema.json", import.meta.url);
const registry = JSON.parse(readFileSync(registryUrl, "utf8"));
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));

test("federation registry contains all 54 US jurisdictions exactly once", () => {
  const expected = [
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
    "VA","WA","WV","WI","WY","DC","PR","VI","AS"
  ].map(code => `US-${code}`);
  const ids = registry.jurisdictions.map(item => item.id);
  assert.equal(ids.length, 54);
  assert.equal(new Set(ids).size, ids.length, "jurisdiction IDs must be unique");
  assert.deepEqual([...ids].sort(), [...expected].sort());
});

test("jurisdiction kinds distinguish states, DC, Puerto Rico, and territories", () => {
  const byId = new Map(registry.jurisdictions.map(item => [item.id, item]));
  assert.equal(registry.jurisdictions.filter(item => item.kind === "state").length, 50);
  assert.equal(byId.get("US-DC").kind, "federal_district");
  assert.equal(byId.get("US-PR").kind, "commonwealth");
  assert.equal(byId.get("US-VI").kind, "territory");
  assert.equal(byId.get("US-AS").kind, "territory");
});

test("organization canonical IDs are unique while acronym aliases may collide", () => {
  const ids = registry.organizations.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, "organization IDs must be unique");
  const mhsaa = registry.organizations.filter(item => item.aliases.includes("MHSAA"));
  assert.deepEqual(mhsaa.map(item => item.jurisdiction_ids[0]).sort(), ["US-MI", "US-MS"]);
  const wiaa = registry.organizations.filter(item => item.aliases.includes("WIAA"));
  assert.deepEqual(wiaa.map(item => item.jurisdiction_ids[0]).sort(), ["US-WA", "US-WI"]);
});

test("special jurisdiction organization boundaries are preserved", () => {
  const byId = new Map(registry.organizations.map(item => [item.id, item]));
  assert.equal(byId.get("us-dc-dcsaa").organization_type, "independent_association");
  assert.equal(byId.get("us-dc-dciaa").organization_type, "school_system_league");
  assert.equal(byId.get("us-as-ashssa-historical").active, false);
  assert.equal(byId.get("us-as-asdoe-athletics").organization_type, "government_office");
  assert.equal(byId.get("us-vi-iaa-stthomas-stjohn").verification_status, "unverified_governance");
  assert.equal(byId.get("us-vi-sciaa-stcroix").verification_status, "unverified_governance");
});

test("organization relationships resolve to known canonical IDs", () => {
  const ids = new Set(registry.organizations.map(item => item.id));
  for (const relationship of registry.organization_relationships) {
    assert.ok(ids.has(relationship.from_organization_id), relationship.id + " source organization exists");
    assert.ok(ids.has(relationship.to_organization_id), relationship.id + " target organization exists");
    assert.notEqual(relationship.from_organization_id, relationship.to_organization_id);
  }
});



function validateSchemaSubset(value, definition, path = "$") {
  const errors = [];
  if (definition.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    for (const key of definition.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    if (definition.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(definition.properties ?? {}, key)) errors.push(`${path}.${key} is not declared`);
      }
    }
    for (const [key, child] of Object.entries(definition.properties ?? {})) {
      if (Object.hasOwn(value, key)) errors.push(...validateSchemaSubset(value[key], child, `${path}.${key}`));
    }
  } else if (definition.type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (definition.minItems !== undefined && value.length < definition.minItems) errors.push(`${path} has too few items`);
    if (definition.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${path} items must be unique`);
    if (definition.items) value.forEach((item, index) => errors.push(...validateSchemaSubset(item, definition.items, `${path}[${index}]`)));
  } else {
    const validTypes = {
      string: item => typeof item === "string",
      integer: item => Number.isInteger(item),
      boolean: item => typeof item === "boolean"
    };
    if (definition.type && validTypes[definition.type] && !validTypes[definition.type](value)) {
      return [`${path} must be ${definition.type}`];
    }
    if (definition.const !== undefined && value !== definition.const) errors.push(`${path} must equal ${definition.const}`);
    if (definition.enum && !definition.enum.includes(value)) errors.push(`${path} has an unsupported value`);
    if (definition.minLength !== undefined && value.length < definition.minLength) errors.push(`${path} is too short`);
    if (definition.pattern && typeof value === "string" && !new RegExp(definition.pattern).test(value)) errors.push(`${path} has an invalid format`);
    if (definition.format === "date" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))) errors.push(`${path} must be an ISO date`);
    if (definition.format === "uri") {
      try { new URL(value); } catch { errors.push(`${path} must be a URI`); }
    }
  }
  return errors;
}


test("organization relationship IDs are unique and effective date ranges are valid", () => {
  const relationships = registry.organization_relationships;
  const ids = relationships.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, "relationship IDs must be unique");
  for (const relationship of relationships) {
    if (relationship.effective_from && relationship.effective_to) {
      assert.ok(Date.parse(relationship.effective_from) <= Date.parse(relationship.effective_to),
        relationship.id + " effective_from must not be after effective_to");
    }
  }
});

test("predecessor-successor relationships cannot contain directed cycles", () => {
  const edges = registry.organization_relationships
    .filter(item => item.relationship_type === "predecessor_successor")
    .map(item => [item.from_organization_id, item.to_organization_id]);
  const graph = new Map();
  for (const [from, to] of edges) {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push(to);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(node) {
    if (visiting.has(node)) return false;
    if (visited.has(node)) return true;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) if (!visit(next)) return false;
    visiting.delete(node);
    visited.add(node);
    return true;
  }
  for (const node of graph.keys()) assert.ok(visit(node), "predecessor-successor graph must be acyclic");
});


test("membership records use unique IDs and reference canonical organizations", () => {
  const organizationIds = new Set(registry.organizations.map(item => item.id));
  const membershipIds = registry.memberships.map(item => item.id);
  assert.equal(new Set(membershipIds).size, membershipIds.length, "membership IDs must be unique");
  for (const membership of registry.memberships) {
    assert.ok(organizationIds.has(membership.organization_id), membership.id + " organization exists");
    assert.ok(membership.school_id.trim().length > 0, membership.id + " school reference is present");
    assert.ok(membership.activity_scope.length > 0, membership.id + " activity scope is explicit");
    if (membership.effective_to) {
      assert.ok(Date.parse(membership.effective_from) <= Date.parse(membership.effective_to),
        membership.id + " membership effective_from must not be after effective_to");
    }
  }
});

test("membership seed does not fabricate unverified school affiliations", () => {
  assert.deepEqual(registry.memberships, [],
    "populate memberships only from source-backed, approved school affiliation records");
});


test("membership schema accepts a scoped, effective-dated school affiliation", () => {
  const membership = {
    id: "membership-example-001",
    organization_id: registry.organizations[0].id,
    school_id: "school-system-record-opaque-001",
    education_tenant_id: "district-tenant-opaque-001",
    membership_class: "full_member",
    activity_scope: ["athletics"],
    level_scope: ["high_school"],
    season_id: "2026-2027",
    status: "active",
    effective_from: "2026-07-01",
    effective_to: "2027-06-30",
    entitlements: ["association_calendar.read", "membership_directory.read"],
    approval_reference: "approval-record-opaque-001",
    verification_status: "verified",
    source_url: "https://example.org/official-membership-record"
  };
  const definition = schema.properties.memberships.items;
  assert.deepEqual(validateSchemaSubset(membership, definition), []);
  assert.ok(validateSchemaSubset({ ...membership, status: "unrestricted_student_records" }, definition).length > 0);
});

test("registry seed conforms to the declared schema's structural constraints", () => {
  const errors = validateSchemaSubset(registry, schema);
  assert.deepEqual(errors, [], errors.join("\n"));
});

test("registry JSON Schema declares the 2020-12 contract and required arrays", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(schema.required.includes("jurisdictions"));
  assert.ok(schema.required.includes("organizations"));
  assert.ok(schema.required.includes("organization_relationships"));
  assert.equal(schema.properties.coverage.properties.states.const, 50);
  assert.equal(schema.properties.coverage.properties.total_jurisdictions.const, 54);
});


test("governance lifecycle collections are present and empty until verified records exist", () => {
  for (const key of ["governance_bodies", "delegations", "governance_decisions", "appeals"]) {
    assert.ok(Array.isArray(registry[key]), key + " must be an array");
    assert.deepEqual(registry[key], [], key + " must not contain fabricated governance records");
  }
});

test("governance records resolve organization and decision references", () => {
  const organizationIds = new Set(registry.organizations.map(item => item.id));
  for (const body of registry.governance_bodies) {
    assert.ok(organizationIds.has(body.organization_id), body.id + " organization exists");
    if (body.effective_to) assert.ok(Date.parse(body.effective_from) <= Date.parse(body.effective_to));
  }
  const bodyIds = new Set(registry.governance_bodies.map(item => item.id));
  for (const decision of registry.governance_decisions) {
    assert.ok(organizationIds.has(decision.organization_id), decision.id + " organization exists");
    assert.ok(bodyIds.has(decision.decision_body_id), decision.id + " decision body exists");
  }
  const decisionIds = new Set(registry.governance_decisions.map(item => item.id));
  for (const appeal of registry.appeals) {
    assert.ok(organizationIds.has(appeal.organization_id), appeal.id + " organization exists");
    assert.ok(decisionIds.has(appeal.decision_id), appeal.id + " decision exists");
  }
});

test("delegation schema requires bounded, effective-dated authority", () => {
  const delegation = {
    id: "delegation-example-001",
    organization_id: registry.organizations[0].id,
    delegator: "governing-board",
    delegate: "executive-director",
    authority_scope: ["publish_calendar"],
    decision_types: ["routine_administration"],
    constraints: ["no_transfer_of_rulemaking_authority"],
    status: "active",
    effective_from: "2026-07-01",
    effective_to: "2027-06-30",
    approval_reference: "resolution-opaque-001",
    verification_status: "verified",
    source_url: "https://example.org/official-delegation"
  };
  assert.deepEqual(validateSchemaSubset(delegation, schema.properties.delegations.items), []);
  assert.ok(validateSchemaSubset({...delegation, authority_scope: []}, schema.properties.delegations.items).length > 0);
  assert.ok(validateSchemaSubset({...delegation, status: "unrestricted"}, schema.properties.delegations.items).length > 0);
});


test("SPORT-03 rule, eligibility, classification, official, and sanction collections are present but unseeded", () => {
  for (const key of ["rule_sources","rule_versions","eligibility_policies","classification_cycles","classifications","official_credentials","sanctioning_records"]) {
    assert.ok(Array.isArray(registry[key]), key + " must be an array");
    assert.deepEqual(registry[key], [], key + " must remain empty until primary-source verification");
  }
});

test("SPORT-03 records enforce source and organization references", () => {
  const organizations = new Set(registry.organizations.map(item => item.id));
  for (const key of ["rule_sources", "eligibility_policies", "classification_cycles", "classifications", "official_credentials", "sanctioning_records"]) {
    for (const record of registry[key]) assert.ok(organizations.has(record.organization_id), record.id + " organization exists");
  }
  const ruleSources = new Set(registry.rule_sources.map(item => item.id));
  for (const version of registry.rule_versions) assert.ok(ruleSources.has(version.rule_source_id), version.id + " rule source exists");
  const ruleVersions = new Set(registry.rule_versions.map(item => item.id));
  for (const policy of registry.eligibility_policies) assert.ok(ruleVersions.has(policy.rule_version_id), policy.id + " rule version exists");
  const cycles = new Set(registry.classification_cycles.map(item => item.id));
  for (const assignment of registry.classifications) assert.ok(cycles.has(assignment.cycle_id), assignment.id + " classification cycle exists");
});

test("SPORT-03 eligibility policy requires explicit scope and versioned authority", () => {
  const policy = {
    id: "eligibility-example-001",
    organization_id: registry.organizations[0].id,
    rule_version_id: "rule-version-example-001",
    policy_type: "transfer",
    scope: ["high_school", "basketball"],
    status: "active",
    effective_from: "2026-07-01",
    decision_authority: "association-eligibility-committee",
    appeal_route: "association-appeals-process",
    source_url: "https://example.org/official-transfer-rule",
    verification_status: "verified"
  };
  assert.deepEqual(validateSchemaSubset(policy, schema.properties.eligibility_policies.items), []);
  assert.ok(validateSchemaSubset({...policy, scope: []}, schema.properties.eligibility_policies.items).length > 0);
  assert.ok(validateSchemaSubset({...policy, status: "nationally_overridden"}, schema.properties.eligibility_policies.items).length > 0);
});

function sport03ReferenceErrors(data) {
  const errors = [];
  const organizations = new Set(data.organizations.map(item => item.id));
  const sourceById = new Map(data.rule_sources.map(item => [item.id, item]));
  const versionById = new Map(data.rule_versions.map(item => [item.id, item]));
  const cycleById = new Map(data.classification_cycles.map(item => [item.id, item]));

  for (const [key, records] of Object.entries({
    rule_sources: data.rule_sources,
    eligibility_policies: data.eligibility_policies,
    classification_cycles: data.classification_cycles,
    classifications: data.classifications,
    official_credentials: data.official_credentials,
    sanctioning_records: data.sanctioning_records
  })) {
    const ids = records.map(item => item.id);
    if (new Set(ids).size !== ids.length) errors.push(key + " IDs must be unique");
    for (const record of records) {
      if (!organizations.has(record.organization_id)) errors.push(record.id + " references an unknown organization");
      const from = record.effective_from ?? record.cycle_start ?? record.issued_at ?? record.decision_date;
      const to = record.effective_to ?? record.cycle_end ?? record.expires_at;
      if (from && to && Date.parse(from) > Date.parse(to)) errors.push(record.id + " has an inverted effective date range");
    }
  }

  const versionIds = data.rule_versions.map(item => item.id);
  if (new Set(versionIds).size !== versionIds.length) errors.push("rule_versions IDs must be unique");
  for (const version of data.rule_versions) {
    const source = sourceById.get(version.rule_source_id);
    if (!source) errors.push(version.id + " references an unknown rule source");
    const superseded = version.supersedes_version_id ? versionById.get(version.supersedes_version_id) : null;
    if (version.supersedes_version_id && !superseded) errors.push(version.id + " references an unknown superseded version");
    if (source && superseded) {
      const supersededSource = sourceById.get(superseded.rule_source_id);
      if (!supersededSource || supersededSource.organization_id !== source.organization_id || superseded.rule_source_id !== version.rule_source_id) {
        errors.push(version.id + " cannot supersede a version from another rule source");
      }
    }
  }

  for (const policy of data.eligibility_policies) {
    const version = versionById.get(policy.rule_version_id);
    if (!version) errors.push(policy.id + " references an unknown rule version");
    else {
      const source = sourceById.get(version.rule_source_id);
      if (!source || source.organization_id !== policy.organization_id) errors.push(policy.id + " rule version belongs to another association");
    }
  }
  for (const assignment of data.classifications) {
    const cycle = cycleById.get(assignment.cycle_id);
    if (!cycle) errors.push(assignment.id + " references an unknown classification cycle");
    else if (cycle.organization_id !== assignment.organization_id) errors.push(assignment.id + " classification cycle belongs to another association");
  }
  return errors;
}

test("SPORT-03 rejects cross-association rule, eligibility, and classification references", () => {
  const organizations = [{ id: "association-a" }, { id: "association-b" }];
  const valid = {
    organizations,
    rule_sources: [{ id: "source-a", organization_id: "association-a" }],
    rule_versions: [{ id: "version-a", rule_source_id: "source-a" }],
    eligibility_policies: [{ id: "policy-a", organization_id: "association-a", rule_version_id: "version-a" }],
    classification_cycles: [{ id: "cycle-a", organization_id: "association-a", cycle_start: "2026-07-01", cycle_end: "2027-06-30" }],
    classifications: [{ id: "assignment-a", organization_id: "association-a", cycle_id: "cycle-a", effective_from: "2026-07-01" }],
    official_credentials: [],
    sanctioning_records: []
  };
  assert.deepEqual(sport03ReferenceErrors(valid), []);
  assert.ok(sport03ReferenceErrors({
    ...valid,
    eligibility_policies: [{ ...valid.eligibility_policies[0], organization_id: "association-b" }]
  }).some(error => error.includes("belongs to another association")));
  assert.ok(sport03ReferenceErrors({
    ...valid,
    classifications: [{ ...valid.classifications[0], organization_id: "association-b" }]
  }).some(error => error.includes("belongs to another association")));
});

test("SPORT-03 rejects cross-source supersession and inverted effective dates", () => {
  const data = {
    organizations: [{ id: "association-a" }],
    rule_sources: [
      { id: "source-a", organization_id: "association-a" },
      { id: "source-b", organization_id: "association-a" }
    ],
    rule_versions: [
      { id: "version-a", rule_source_id: "source-a" },
      { id: "version-b", rule_source_id: "source-b", supersedes_version_id: "version-a" }
    ],
    eligibility_policies: [],
    classification_cycles: [],
    classifications: [],
    official_credentials: [],
    sanctioning_records: []
  };
  assert.ok(sport03ReferenceErrors(data).some(error => error.includes("another rule source")));
  assert.ok(sport03ReferenceErrors({
    ...data,
    rule_versions: [{ id: "version-a", rule_source_id: "source-a" }],
    classification_cycles: [{ id: "cycle-a", organization_id: "association-a", cycle_start: "2027-07-01", cycle_end: "2026-06-30" }]
  }).some(error => error.includes("inverted effective date range")));
});
