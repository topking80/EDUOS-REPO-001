import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../edge-platform/eduos/", import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), "utf8");

test("container build, saved archives, push targets and Quadlets use independent image versions", () => {
  const make = read("Makefile");
  const enrollment = read("quadlet/eduos-enrollment.container");
  const health = read("quadlet/eduos-health.container");

  assert.match(make, /^ENROLLMENT_VERSION\s*\?=\s*0\.2\.1$/m);
  assert.match(make, /^HEALTH_VERSION\s*\?=\s*2\.0\.0$/m);
  assert.match(make, /eduos-enrollment:\$\(ENROLLMENT_VERSION\)/);
  assert.match(make, /eduos-health:\$\(HEALTH_VERSION\)/);
  assert.match(make, /eduos-enrollment-\$\(ENROLLMENT_VERSION\)\.tar/);
  assert.match(make, /eduos-health-\$\(HEALTH_VERSION\)\.tar/);
  assert.match(make, /podman push quay\.io\/eduos\/eduos-enrollment:\$\(ENROLLMENT_VERSION\)/);
  assert.match(make, /podman push quay\.io\/eduos\/eduos-health:\$\(HEALTH_VERSION\)/);
  assert.match(enrollment, /^Image=quay\.io\/eduos\/eduos-enrollment:0\.2\.1$/m);
  assert.match(health, /^Image=quay\.io\/eduos\/eduos-health:2\.0\.0$/m);
});

test("container CI uses the same independent defaults and records both versions in its artifact", () => {
  const workflow = read(".github/workflows/build-eduos.yml");
  assert.match(workflow, /ENROLLMENT_VERSION:.*enrollment_version.*0\.2\.1/);
  assert.match(workflow, /HEALTH_VERSION:.*health_version.*2\.0\.0/);
  assert.match(workflow, /make containers ENROLLMENT_VERSION=\$\{\{ env\.ENROLLMENT_VERSION \}\} HEALTH_VERSION=\$\{\{ env\.HEALTH_VERSION \}\}/);
  assert.match(workflow, /eduos-containers-enrollment-\$\{\{ env\.ENROLLMENT_VERSION \}\}-health-\$\{\{ env\.HEALTH_VERSION \}\}/);
});
