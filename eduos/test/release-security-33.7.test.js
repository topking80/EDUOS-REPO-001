import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("CI includes source secret, IaC, dependency and production-image scans", () => {
  const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /gitleaks\/gitleaks-action/);
  assert.match(workflow, /aquasecurity\/trivy-action/);
  assert.match(workflow, /scan-type: fs/);
  assert.match(workflow, /scan-type: image/);
  assert.match(workflow, /severity: HIGH,CRITICAL/);
  assert.match(workflow, /docker build --target app/);
});

test("release security policy documents limits and non-root production target", () => {
  const policy = fs.readFileSync("SECURITY.md", "utf8");
  assert.match(policy, /non-root/);
  assert.match(policy, /FERPA\/COPPA/);
  assert.match(policy, /private security reporting channel/);
});
