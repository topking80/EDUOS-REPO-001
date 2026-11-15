import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RELEASE_RE } from "./helpers/release.js";

const root = new URL("../", import.meta.url);
const html = (await readFile(new URL("public/index.html", root), "utf8")+await readFile(new URL("public/legacy-app.js", root), "utf8"));
const bridge = await readFile(new URL("public/api-bridge.js", root), "utf8");
const standalone = await readFile(new URL("demo/eduos-district-edition-phase31.1-standalone.html", root), "utf8");
const migrate = await readFile(new URL("src/migrate.js", root), "utf8");
const policy = await readFile(new URL("src/policy.js", root), "utf8");

test("Phase 31.1 interface is retained and improved in the integrated primary UI", () => {
  assert.match(html, new RegExp(`EduOS District Edition ${RELEASE_RE} \\| Transportation-to-Arrival Reconciliation`));
  assert.match(html, /const districtTotal=/);
  assert.match(html, /const districtAvg=/);
  assert.match(html, /function buildWorkItems/);
  assert.match(html, /function attendance/);
});

test("Phase 31.1 cache and lookup optimizations are preserved", () => {
  assert.match(html, /invalidateDistrict\(\)/);
  assert.match(html, /const maxStu=Math\.max/);
  assert.match(html, /const _stuById=new Map/);
  assert.match(html, /const _stuIdx=new Map/);
});

test("authenticated API bridge is included once after the app script", () => {
  assert.equal((html.match(/api-bridge\.js/g) || []).length, 1);
  assert.ok(html.lastIndexOf('<script src="/api-bridge.js"></script>') < html.toLowerCase().lastIndexOf("</body>"));
  assert.match(bridge, /\/api\/access-requests/);
  assert.match(bridge, /\/api\/students/);
});

test("Phase 28 server authorization and migration remain connected", () => {
  assert.match(migrate, /003_access_control\.sql/);
  assert.match(policy, /permission_grants/);
  assert.match(policy, /expires_at>now\(\)/);
});

test("standalone Phase 31.1 snapshot remains available separately", () => {
  assert.match(standalone, /EduOS District Edition 31\.1 \| Performance & Efficiency/);
  assert.match(html, /Find a workspace/);
});
