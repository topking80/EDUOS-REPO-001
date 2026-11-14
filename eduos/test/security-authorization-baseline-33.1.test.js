import test from "node:test";
import assert from "node:assert/strict";
import { ROLE_PERMISSIONS, canPerform, isGrantable, requireSchoolScope } from "../src/policy.js";

const actor = (role, extra = {}) => ({
  role, districtId: "district-a", userId: "user-a",
  schoolId: role === "superintendent" || role === "it_admin" ? null : "school-a",
  ...extra
});

test("authorization denies missing, malformed, and unknown identities by default", () => {
  for (const invalid of [null, {}, { role: "teacher" }, { role: "teacher", districtId: "d" }]) {
    assert.equal(canPerform(invalid, "students", "read"), false);
  }
  assert.equal(canPerform(actor("unknown_role"), "students", "read"), false);
  assert.equal(canPerform(actor("teacher"), "unknown_resource", "read"), false);
  assert.equal(canPerform(actor("teacher"), "students", "unknown_action"), false);
});

test("every declared role has a permission map and no wildcard grants", () => {
  assert.ok(Object.keys(ROLE_PERMISSIONS).length > 0);
  for (const [role, resources] of Object.entries(ROLE_PERMISSIONS)) {
    assert.ok(role.length > 0);
    assert.ok(resources && typeof resources === "object");
    for (const [resource, actions] of Object.entries(resources)) {
      assert.ok(resource.length > 0);
      assert.ok(Array.isArray(actions));
      // Empty action lists are valid explicit deny entries.
      assert.equal(actions.includes("*"), false);
      assert.equal(actions.includes("admin"), false);
    }
  }
});

test("IT administrator cannot read student or attendance records by role", () => {
  const it = actor("it_admin");
  for (const [resource, action] of [
    ["students", "read"], ["attendance", "read"], ["assignments", "read"], ["cases", "read"]
  ]) assert.equal(canPerform(it, resource, action), false, `${resource}:${action}`);
});

test("teachers and parents cannot manage district integrations or audit exports", () => {
  for (const role of ["teacher", "parent", "pupil"]) {
    const a = actor(role);
    assert.equal(canPerform(a, "webhooks", "manage"), false);
    assert.equal(canPerform(a, "audit", "export"), false);
    assert.equal(canPerform(a, "district", "manage"), false);
  }
});

test("grantable permissions are explicitly allowlisted", () => {
  assert.equal(isGrantable("schools", "update"), true);
  for (const item of [
    ["students", "read"], ["attendance", "export"], ["audit", "export"],
    ["district", "manage"], ["webhooks", "manage"], ["unknown", "anything"]
  ]) assert.equal(isGrantable(...item), false);
});

test("school scope rejects cross-school identifiers for school-bound users", async () => {
  const middleware = requireSchoolScope;
  const req = { actor: actor("teacher"), params: { schoolId: "school-b" }, query: {} };
  let status, payload, continued = false;
  const res = { status(code) { status = code; return this; }, json(body) { payload = body; return this; } };
  await middleware(req, res, () => { continued = true; });
  assert.equal(continued, false);
  assert.equal(status, 403);
  assert.deepEqual(payload, { error: "school_scope_denied" });
});

test("district roles can access an explicitly selected school scope", async () => {
  const req = { actor: actor("superintendent"), params: { schoolId: "school-b" }, query: {} };
  let continued = false;
  await requireSchoolScope(req, { status() { throw new Error("unexpected denial"); } }, () => { continued = true; });
  assert.equal(continued, true);
});
