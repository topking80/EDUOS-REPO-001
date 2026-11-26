// FED-03: Master Control unit checks (the integration suite runs it against
// PostgreSQL in test/integration/master-control.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { canonical, entryHash, GENESIS } from "../src/master-control/audit.js";
import { validateAuthorityModel } from "../src/federation/authority.js";

const shipped = JSON.parse(readFileSync(new URL("../src/federation/authority-catalog.json", import.meta.url), "utf8"));
const seed = JSON.parse(readFileSync(new URL("../../docs/architecture/federation/authority-model.v0.1.json", import.meta.url), "utf8"));

test("the catalog shipped with the app is the FED-02 contract's catalog", () => {
  for (const k of ["model_version", "capabilities", "role_definitions", "policy_definitions"]) assert.deepEqual(shipped[k], seed[k], k);
  assert.deepEqual(validateAuthorityModel({ ...seed, ...shipped }).errors, []);
  const cap = shipped.capabilities.find(c => c.id === "federation.roles.assign");
  assert.deepEqual(cap.assignable_levels, ["platform", "state_education_authority"], "never at a district or school");
  assert.equal(cap.delegable, false);
});

test("Master Control doesn't import EduOS's database, config or sign-in modules", () => {
  const dir = new URL("../src/master-control/", import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    const imports = [...src.matchAll(/from\s+"(\.[^"]+)"/g)].map(m => m[1]);
    for (const i of imports) assert.ok(i.startsWith("./") || i.startsWith("../federation/"), `${f} imports ${i}`);
  }
  const grants = readFileSync(new URL("../db/master-control/runtime_grants.template.sql", import.meta.url), "utf8");
  assert.doesNotMatch(grants.replace(/REVOKE[^;]*;/g, ""), /public\./, "no grants outside master_control");
  const consoleJs = readFileSync(new URL("../src/master-control/console/mc.js", import.meta.url), "utf8");
  assert.doesNotMatch(consoleJs, /innerHTML|insertAdjacentHTML|document\.write/);
});

test("audit hashes are canonical and change when any field changes", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: null, c: "x" }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
  const e = { at: "2026-11-26T15:00:00.000Z", actor: "op-1", action: "set_policy", target_type: "policy_setting", target_id: "ps-1", node_id: "n", capability: "policy.set", decision: "allowed", reason: null, basis: { type: "assignment", id: "ra-1" }, detail: { v: 1 } };
  const h1 = entryHash(GENESIS, e);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(entryHash(GENESIS, { ...e, basis: { id: "ra-1", type: "assignment" } }), h1, "key order doesn't matter");
  for (const [k, v] of [["actor", "op-2"], ["decision", "denied"], ["detail", { v: 2 }], ["at", "2026-11-26T15:00:01.000Z"]]) assert.notEqual(entryHash(GENESIS, { ...e, [k]: v }), h1, k);
  assert.notEqual(entryHash(h1, e), h1, "chained to the previous hash");
});
