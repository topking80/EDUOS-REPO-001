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

test("registry JSON Schema declares the 2020-12 contract and required arrays", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(schema.required.includes("jurisdictions"));
  assert.ok(schema.required.includes("organizations"));
  assert.ok(schema.required.includes("organization_relationships"));
  assert.equal(schema.properties.coverage.properties.states.const, 50);
  assert.equal(schema.properties.coverage.properties.total_jurisdictions.const, 54);
});
