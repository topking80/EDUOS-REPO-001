// EduOS 32.21.0: what a phone keeps offline, school-node deploy files, provisioning guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { parseArgs, provision } from "../src/eden/node-provision.js";
import { RELEASE_RE } from "./helpers/release.js";

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const app = read("public/app/app.js"), sw = read("public/app/sw.js");

test("offline queue: allowlist is roll call, bus check-ins and attendance only; pick-up stays online", () => {
  const m = /PATHS: \[(.*?)\],\n/s.exec(app);
  assert.ok(m, "allowlist present");
  assert.match(m[1], /rollcall/); assert.match(m[1], /checkins/); assert.match(m[1], /attendance/);
  assert.doesNotMatch(m[1], /pickup|messages|comms|grade|christie|learning/);
});
test("offline queue: encrypted with a non-extractable AES-GCM key, capped, expiring, cleared on sign-out", () => {
  assert.match(app, /generateKey\(\{ name: "AES-GCM", length: 256 \}, false, \["encrypt", "decrypt"\]\)/);
  assert.match(app, /MAX: 200, TTL: 24 \* 3600 \* 1000/);
  assert.match(app, /crypto\.subtle\.encrypt\(\{ name: "AES-GCM", iv \}/);
  assert.match(app, /await safe\(api\.post\("\/auth\/logout"\)\); await OQ\.clear\(\)/);
  assert.match(app, /owner !== state\.me\?\.userId\) await this\.clear\(\)/, "another account never inherits a queue");
  assert.doesNotMatch(app, /localStorage/, "nothing in localStorage");
  assert.match(app, /"idempotency-key"/); assert.match(app, /"x-eduos-queued-at"/);
});
test("service worker: shell only, current-release cache name, never /api or /auth", () => {
  assert.match(sw, new RegExp(`eduos-app-shell-${RELEASE_RE}"`));
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\) \|\| url\.pathname\.startsWith\("\/auth\/"\)\) return;/);
  const assets = JSON.parse(/const ASSETS = (\[.*?\]);/.exec(sw)[1]);
  assert.ok(assets.every(a => a.startsWith("/app/")));
});
test("admin/IT screens: Nodes tab for superintendent and IT, node status for principals", () => {
  assert.match(app, /superintendent: \[.*\["nodes", "Nodes", "server"\]\]/);
  assert.match(app, /it_admin: \[[^\n]*\["nodes", "Nodes", "server"\]/, "IT admins keep the Nodes tab");
  for (const t of ["Authorize failover", "Partner schools", "Add a school node", "What schools sent", "What left this school", "Sync now"]) assert.ok(app.includes(t), t);
});
test("school-node deploy: compose, Quadlet and Butane files exist with memory caps", () => {
  const c = read("deploy/school-node/compose.yml");
  assert.match(c, /mem_limit: 384m/); assert.match(c, /mem_limit: 192m/); assert.match(c, /EDUOS_NODE_TIER: school/);
  for (const f of ["eduos-school-db.container", "eduos-school-node.container", "eduos-school-edge.container", "eduos-school.network"]) assert.ok(existsSync(new URL(`../edge-platform/eduos/quadlet/${f}`, import.meta.url)), f);
  assert.match(read("edge-platform/eduos/butane/school-node.bu"), /eduos-school-node\.container/);
  assert.match(read("deploy/school-node/README.md"), /Not tested on real hardware/);
});
test("node-provision: argument checks; demo data refused in production", async () => {
  assert.throws(() => parseArgs([]), /--school/);
  assert.throws(() => parseArgs(["--school", "00000000-0000-4000-8000-000000000101", "--synthetic-students", "999"]), /0\.\.24/);
  await assert.rejects(provision({ databaseUrl: "postgres://x@127.0.0.1:1/x", districtId: "00000000-0000-4000-8000-000000000001", school: "00000000-0000-4000-8000-000000000101", demoSeed: true, env: { NODE_ENV: "production", EDUOS_ALLOW_DEMO_SEED: "true" } }), /production/);
});
