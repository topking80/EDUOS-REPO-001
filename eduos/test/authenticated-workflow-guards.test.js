import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canPerform, requireSchoolScope } from "../src/policy.js";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/eduos_test";
process.env.PUBLIC_ORIGIN ||= "http://localhost:8080";
process.env.OIDC_ISSUER ||= "https://identity.example.test";
process.env.OIDC_CLIENT_ID ||= "eduos-test";
process.env.OIDC_CLIENT_SECRET ||= "test-secret";
process.env.OIDC_REDIRECT_URI ||= "http://localhost:8080/auth/callback";
const { requireSession, requireCsrf } = await import("../src/auth.js");

const server = readFileSync("src/server.js", "utf8");
const base = { userId: "user-1", districtId: "district-1", schoolId: "school-1" };

function responseProbe() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("unauthenticated requests are rejected before workflow handlers", async () => {
  const req = { headers: {} };
  const res = responseProbe();
  let advanced = false;
  await requireSession(req, res, () => { advanced = true; });
  assert.equal(advanced, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "authentication_required");
});

test("CSRF guard rejects absent, malformed, oversized, and incorrect tokens", () => {
  const cases = [undefined, 42, "x".repeat(257), "wrong-token"];
  for (const token of cases) {
    const req = { actor: { csrfTokenHash: createHash("sha256").update("expected").digest("hex") }, get: () => token };
    const res = responseProbe();
    let advanced = false;
    requireCsrf(req, res, () => { advanced = true; });
    assert.equal(advanced, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "csrf_validation_failed");
  }
});

test("CSRF guard accepts only the matching session-bound token", () => {
  const token = "session-bound-csrf-token";
  const req = { actor: { csrfTokenHash: createHash("sha256").update(token).digest("hex") }, get: () => token };
  let advanced = false;
  requireCsrf(req, responseProbe(), () => { advanced = true; });
  assert.equal(advanced, true);
});

test("school scope permits district oversight and same-school staff only", () => {
  for (const role of ["teacher", "principal"]) {
    let result = null;
    requireSchoolScope({ actor: { ...base, role }, query: { schoolId: "school-1" }, params: {} }, responseProbe(), () => { result = "next"; });
    assert.equal(result, "next");
    const res = responseProbe();
    requireSchoolScope({ actor: { ...base, role }, query: { schoolId: "school-2" }, params: {} }, res, () => { result = "wrong"; });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "school_scope_denied");
  }
  let districtAdvanced = false;
  requireSchoolScope({ actor: { ...base, role: "superintendent", schoolId: null }, query: { schoolId: "school-2" }, params: {} }, responseProbe(), () => { districtAdvanced = true; });
  assert.equal(districtAdvanced, true);
});

test("role workflow matrix preserves least-privilege boundaries", () => {
  const expectations = [
    ["superintendent", "audit", "export", true],
    ["principal", "audit", "export", false],
    ["teacher", "assignments", "grade", true],
    ["teacher", "cases", "approve", false],
    ["parent", "attendance", "acknowledge", true],
    ["parent", "attendance", "create", false],
    ["pupil", "assignments", "submit", true],
    ["pupil", "audit", "read", false],
    ["parent", "webhooks", "manage", false],
    ["teacher", "webhooks", "manage", false]
  ];
  for (const [role, resource, action, expected] of expectations) {
    assert.equal(canPerform({ ...base, role }, resource, action), expected, `${role} ${resource}:${action}`);
  }
});

test("sensitive workflow routes keep session and CSRF checks ahead of writes", () => {
  const routes = [
    /app\.post\(["']\/api\/family\/messages["'],requireSession,requireCsrf/,
    /app\.put\(["']\/api\/teacher\/classroom-preferences["'],requireSession,requireCsrf/,
    /app\.post\(["']\/api\/integrations\/sis\/import["'],requireSession,requireCsrf/,
    /app\.post\(["']\/api\/guardian-invitations["'],guardianInviteLimiter,requireSession,requireCsrf/,
    /app\.post\(["']\/api\/access-requests["'],requireSession,requireCsrf/,
    /app\.post\(["']\/api\/attendance\/:eventId\/acknowledge["'],requireSession,requireCsrf/
  ];
  for (const route of routes) assert.match(server, route);
});
