import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

const auth = await readFile(new URL('../src/auth.js', import.meta.url), 'utf8');

// ---- source audit: constant-time comparison is in place everywhere secrets are compared ----
test('auth.js defines a constant-time comparison helper using timingSafeEqual', () => {
  assert.match(auth, /function safeEqual\(a, b\)/);
  assert.match(auth, /Buffer\.from\(a, \"utf8\"\)/);
  assert.match(auth, /Buffer\.from\(b, \"utf8\"\)/);
  assert.match(auth, /left\.length !== right\.length/);
  assert.match(auth, /crypto\.timingSafeEqual\(left, right\)/);
});

test('CSRF validation uses the constant-time helper, not string !==', () => {
  assert.match(auth, /!safeEqual\(sha256\(supplied\), req\.actor\.csrfTokenHash\)/);
  assert.ok(!auth.includes('sha256(supplied) !== req.actor.csrfTokenHash'), 'old timing-unsafe CSRF compare must be gone');
});

test('OIDC state (browser binding) uses the constant-time helper, not string !==', () => {
  assert.match(auth, /!safeEqual\(stateCookie, state\)/);
  assert.ok(!auth.includes('stateCookie !== state'), 'old timing-unsafe state compare must be gone');
});

// ---- functional audit: requireCsrf accepts the right token and rejects wrong/missing tokens ----
// auth.js imports config at load, so provide dummy (presence-only) env then dynamic-import.
function withDummyEnv() {
  const e = process.env;
  e.DATABASE_URL ||= 'postgresql://u@127.0.0.1:1/db';
  e.PUBLIC_ORIGIN ||= 'http://localhost:8080';
  e.OIDC_ISSUER ||= 'http://localhost/oidc';
  e.OIDC_CLIENT_ID ||= 'x';
  e.OIDC_CLIENT_SECRET ||= 'x';
  e.OIDC_REDIRECT_URI ||= 'http://localhost:8080/auth/callback';
}
const sha256hex = v => crypto.createHash('sha256').update(v).digest('hex');
function fakeReqRes(token, csrfTokenHash) {
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { get: name => (name === 'X-CSRF-Token' ? token : undefined), actor: { csrfTokenHash } };
  return { req, res };
}

test('safeEqual compares UTF-8 byte lengths and never throws for Unicode inputs', async () => {
  withDummyEnv();
  const { safeEqual } = await import('../src/auth.js');
  assert.equal(safeEqual('token', 'token'), true);
  assert.equal(safeEqual('token', 'Token'), false);
  assert.equal(safeEqual('é', 'a'), false); // same JS length, different UTF-8 byte lengths
  assert.equal(safeEqual('é', 'ö'), false); // equal UTF-8 byte lengths, different bytes
  assert.equal(safeEqual(undefined, 'token'), false);
});

test('requireCsrf: correct token -> next() (authorized)', async () => {
  withDummyEnv();
  const { requireCsrf } = await import('../src/auth.js');
  const token = 'a-valid-csrf-token';
  const { req, res } = fakeReqRes(token, sha256hex(token));
  let nexted = false;
  requireCsrf(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, null);
});

test('requireCsrf: wrong token -> 403, no next()', async () => {
  withDummyEnv();
  const { requireCsrf } = await import('../src/auth.js');
  const { req, res } = fakeReqRes('wrong-token', sha256hex('the-real-token'));
  let nexted = false;
  requireCsrf(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'csrf_validation_failed');
});

test('requireCsrf: missing token -> 403', async () => {
  withDummyEnv();
  const { requireCsrf } = await import('../src/auth.js');
  const { req, res } = fakeReqRes(undefined, sha256hex('the-real-token'));
  let nexted = false;
  requireCsrf(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

test('requireCsrf: null stored hash -> 403 (no crash)', async () => {
  withDummyEnv();
  const { requireCsrf } = await import('../src/auth.js');
  const { req, res } = fakeReqRes('any', null);
  let nexted = false;
  requireCsrf(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});
