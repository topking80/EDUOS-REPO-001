// The health-report allowlist (src/edge-report.js) keeps the update fields
// devices send for district approvals and drops anything malformed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeReport } from "../src/edge-report.js";

test("keeps a device's approval state, target and rollback version", () => {
  const r = sanitizeReport({ timestamp: new Date().toISOString(), os: {
    booted_version: "45.20261110.3.0", approval: "installing", target_version: "45.20261117.3.0",
    rollback_from_version: "45.20261103.3.0", cohort: "canary" } });
  assert.equal(r.os.approval, "installing");
  assert.equal(r.os.target_version, "45.20261117.3.0");
  assert.equal(r.os.rollback_from_version, "45.20261103.3.0");
});

test("drops malformed update fields", () => {
  const r = sanitizeReport({ timestamp: new Date().toISOString(), os: {
    approval: "yes please", target_version: "$(reboot)", rollback_from_version: "x".repeat(200) } });
  assert.equal(r.os.approval ?? null, null);
  assert.equal(r.os.target_version ?? null, null);
  assert.equal(r.os.rollback_from_version ?? null, null);
});
