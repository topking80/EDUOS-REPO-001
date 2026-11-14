import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Enable the opt-in session cache BEFORE config.js is imported (it reads env once).
process.env.SESSION_CACHE_TTL_MS ||= '60000';
process.env.DATABASE_URL ||= 'postgresql://u@127.0.0.1:1/db';
process.env.PUBLIC_ORIGIN ||= 'http://localhost:8080';
process.env.OIDC_ISSUER ||= 'http://localhost/oidc';
process.env.OIDC_CLIENT_ID ||= 'x';
process.env.OIDC_CLIENT_SECRET ||= 'x';
process.env.OIDC_CLIENT_SECRET ||= 'x';
process.env.OIDC_REDIRECT_URI ||= 'http://localhost:8080/auth/callback';

const authSrc = await readFile(new URL('../src/auth.js', import.meta.url), 'utf8');
const configSrc = await readFile(new URL('../src/config.js', import.meta.url), 'utf8');

// The Pool is lazy (no connection until a query), so we can replace pool.query
// with a counting stub and drive requireSession without a database.
const { pool } = await import('../src/db.js');
const { requireSession, logout, issueCsrfToken, csrfTokenFor } = await import('../src/auth.js');

let selects, updates;
let tokenSeq = 0;
const freshCookie = () => `eduos_session=cachetok-${++tokenSeq}-abcdef0123456789`;
function installStub(csrfHash = 'oldhash') {
  selects = 0; updates = 0;
  pool.query = async (text) => {
    if (/FROM sessions s/.test(text)) {
      selects++;
      return { rowCount: 1, rows: [{
        session_id: 's-1', user_id: 'u-1', district_id: 'd-1', school_id: null,
        role: 'superintendent', csrf_token_hash: csrfHash, display_name: 'Supt A', status: 'active'
      }] };
    }
    updates++; // UPDATE sessions ... (logout / csrf rotation)
    return { rowCount: 1, rows: [] };
  };
}
function mkReqRes(cookie) {
  const req = { headers: { cookie }, get() { return undefined; }, actor: null };
  const res = { statusCode: null, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end() { this.ended = true; return this; } };
  return { req, res };
}
async function callRequire(cookie) {
  const { req, res } = mkReqRes(cookie);
  let errored = null;
  await requireSession(req, res, () => {}); // next; errors surface via res or throw
  if (res.statusCode && res.statusCode >= 400) errored = res.body;
  return { req, res, errored };
}

// ---- source audit ----
test('session cache is OFF by default (SESSION_CACHE_TTL_MS defaults to 0)', () => {
  assert.match(configSrc, /sessionCacheTtlMs:\s*Math\.max\(0,\s*Number\(process\.env\.SESSION_CACHE_TTL_MS\s*\|\|\s*0\)\)/);
  // guard in both accessors so a 0 TTL is a hard no-op
  assert.match(authSrc, /function cacheGetSession[\s\S]*?config\.sessionCacheTtlMs <= 0\) return null/);
  assert.match(authSrc, /function cacheSetSession[\s\S]*?config\.sessionCacheTtlMs <= 0\) return/);
});
test('logout and membership switching evict the cached session', () => {
  assert.match(authSrc, /evictSession\(h\);.*logged-out/);
  assert.match(authSrc, /async function switchMembership[\s\S]*?evictSession\(req\._sessionTokenHash\)/);
});

// ---- behavioral: with the TTL enabled ----
test('second authenticated request is served from cache (no second DB lookup)', async () => {
  installStub();
  const ck = freshCookie();
  const a = await callRequire(ck);
  assert.equal(a.errored, null);
  assert.equal(a.req.actor.userId, 'u-1');
  assert.equal(selects, 1, 'first request hits the database');
  const b = await callRequire(ck);
  assert.equal(b.req.actor.userId, 'u-1');
  assert.equal(selects, 1, 'second request must be served from cache');
  // served actor is a copy, not the cached object (mutation must not leak)
  b.req.actor.role = 'tamper';
  const c = await callRequire(ck);
  assert.equal(c.req.actor.role, 'superintendent', 'cache must hand out an isolated copy');
});

test('logout evicts: the next request re-reads the database', async () => {
  installStub();
  const ck = freshCookie();
  await callRequire(ck);            // fills cache (select 1)
  await callRequire(ck);            // cache hit (still 1)
  assert.equal(selects, 1);
  const { req, res } = mkReqRes(ck);
  await logout(req, res, () => {});
  assert.equal(res.statusCode, 204);
  assert.equal(updates, 1, 'logout issued the revoke UPDATE');
  await callRequire(ck);           // must re-read after eviction
  assert.equal(selects, 2, 'post-logout request must not be served from cache');
});

// 32.0.53: the CSRF token is derived from the session token, so fetching it is
// side-effect free and cannot invalidate tokens held by other open tabs.
test('GET /api/csrf is stable and side-effect free', async () => {
  const ck = freshCookie();
  const raw = ck.split('=')[1];
  installStub(crypto.createHash('sha256').update(csrfTokenFor(raw)).digest('hex'));
  const first = await callRequire(ck);
  const a = mkReqRes(ck).res, b = mkReqRes(ck).res;
  issueCsrfToken(first.req, a);
  issueCsrfToken(first.req, b);
  assert.equal(updates, 0, 'issuing a CSRF token must not write to the database');
  assert.equal(a.body.csrfToken, b.body.csrfToken, 'repeated fetches return the same token');
  assert.equal(a.body.csrfToken, csrfTokenFor(raw));
  await callRequire(ck);
  assert.equal(selects, 1, 'the cached session stays valid');
});

test('expired cache entry falls through to a fresh DB read', async () => {
  installStub();
  const ck = freshCookie();
  await callRequire(ck);               // select 1
  assert.equal(selects, 1);
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60 * 1000; // jump past the 60s TTL
  try {
    await callRequire(ck);
    assert.equal(selects, 2, 'a stale entry past its TTL must be re-read');
  } finally { Date.now = realNow; }
});
