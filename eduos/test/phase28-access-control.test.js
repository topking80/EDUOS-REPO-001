import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canPerform, isGrantable } from "../src/policy.js";

const root = new URL("../", import.meta.url);
const migration = await readFile(new URL("db/003_access_control.sql", root), "utf8");
const server = await readFile(new URL("src/server.js", root), "utf8");
const bridge = await readFile(new URL("public/api-bridge.js", root), "utf8");
const runner = await readFile(new URL("src/migrate.js", root), "utf8");

test("base role policy includes access request self-service and leadership review", () => {
  const actor = { userId:"u1", districtId:"d1", role:"teacher" };
  assert.equal(canPerform(actor,"access_requests","create"), true);
  assert.equal(canPerform(actor,"access_requests","review"), false);
  assert.equal(canPerform({ ...actor, role:"superintendent" },"access_requests","review"), true);
});

test("grantable permission catalog excludes arbitrary permission strings", () => {
  assert.equal(isGrantable("schools","update"), true);
  // 32.0.53: permissions with no enforcing route are no longer grantable.
  for (const [r,a] of [["cases","approve"],["cases","export"],["attendance","export"],["assignments","approve"],["schools","create"]])
    assert.equal(isGrantable(r,a), false, `${r}:${a}`);
  assert.equal(isGrantable("users","delete"), false);
  assert.equal(isGrantable("audit","impersonate"), false);
});

test("access request and grant tables are district isolated and expiring", () => {
  assert.match(migration,/CREATE TABLE access_requests/);
  assert.match(migration,/CREATE TABLE permission_grants/);
  assert.match(migration,/ENABLE ROW LEVEL SECURITY/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/expires_at timestamptz NOT NULL/);
  assert.match(migration,/revoked_at timestamptz/);
});

test("access workflow enforces CSRF, leadership review and no self approval", () => {
  assert.match(server,/app\.post\("\/api\/access-requests/);
  assert.match(server,/requireCsrf/);
  assert.match(server,/requirePermission\("access_requests","review"\)/);
  assert.match(server,/self_approval_prohibited/);
  assert.match(server,/duplicate_pending_request/);
  assert.match(server,/permission_already_granted/);
  assert.match(server,/90\*24\*60\*60\*1000/);
});

test("server permission middleware checks active, unexpired, non-revoked grants", async () => {
  const policy = await readFile(new URL("src/policy.js", root), "utf8");
  assert.match(policy,/permission_grants/);
  assert.match(policy,/expires_at>now\(\)/);
  assert.match(policy,/revoked_at IS NULL/);
  assert.match(policy,/school_id IS NULL OR school_id=\$5/);
});

test("migration runner applies Phase 28 access-control migration", () => {
  assert.match(runner,/003_access_control\.sql/);
});

test("Connected Services UI exposes server-backed access requests", () => {
  assert.match(bridge,/\/api\/access-requests/);
  assert.match(bridge,/approve-access/);
  assert.match(bridge,/revoke-access/);
  assert.match(bridge,/data-form="access-request"/);
});
