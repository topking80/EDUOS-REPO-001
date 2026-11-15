import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL ||= 'postgresql://u@127.0.0.1:1/db';
process.env.PUBLIC_ORIGIN ||= 'http://localhost:8080';
process.env.OIDC_ISSUER ||= 'http://localhost/oidc';
process.env.OIDC_CLIENT_ID ||= 'eduos-test-client';
process.env.OIDC_CLIENT_SECRET ||= 'test-secret';
process.env.OIDC_REDIRECT_URI ||= 'http://localhost:8080/auth/callback';

const auth = await readFile(new URL('../src/auth.js', import.meta.url), 'utf8');
const oidc = await readFile(new URL('../src/oidc.js', import.meta.url), 'utf8');

test('OIDC state cookies are unique per authorization attempt', () => {
  assert.match(auth, /oidcStateCookieName\(state\)/);
  assert.match(auth, /serialize\(oidcStateCookieName\(state\), state/);
  assert.match(auth, /browserCookies\[stateCookieName\]/);
  assert.match(auth, /serialize\(stateCookieName, ""/);
});

// 32.0.53: pending logins are stored in the database (multi-instance safe);
// behaviour is exercised end-to-end in test/integration/postgres.test.js.
test('OIDC pending logins are durable, expire and are pruned', () => {
  assert.match(auth, /DELETE FROM oidc_pending_logins WHERE expires_at <= now\(\)/);
  // 037 added the native app's PKCE challenge and redirect to the same row.
  assert.match(auth, /INSERT INTO oidc_pending_logins\(state_hash,nonce,code_verifier,expires_at,return_path,app_challenge,app_redirect\)/);
});

test('OIDC callback consumes state once and rejects oversized state values', () => {
  assert.match(auth, /state\.length > 128/);
  assert.match(auth, /DELETE FROM oidc_pending_logins WHERE state_hash=\$1 RETURNING/);
});

test('OIDC token validation enforces authorized-party claim rules', () => {
  assert.match(oidc, /audiences\.length > 1 && payload\.azp !== clientId/);
  assert.match(oidc, /payload\.azp !== undefined && payload\.azp !== clientId/);
  assert.match(oidc, /OIDC authorized-party mismatch/);
});


test('per-attempt OIDC state cookie names are deterministic, distinct, and do not expose state', async () => {
  const { oidcStateCookieName } = await import('../src/auth.js');
  const first = oidcStateCookieName('state-one');
  const second = oidcStateCookieName('state-two');
  assert.match(first, /^eduos_oidc_state_[a-f0-9]{24}$/);
  assert.notEqual(first, second);
  assert.ok(!first.includes('state-one'));
});

test('authorized-party validation accepts a single audience without azp', async () => {
  const { validateAuthorizedParty } = await import('../src/oidc.js');
  assert.equal(validateAuthorizedParty({ aud: 'eduos-test-client' }), true);
});

test('authorized-party validation requires matching azp for multiple audiences', async () => {
  const { validateAuthorizedParty } = await import('../src/oidc.js');
  assert.equal(validateAuthorizedParty({ aud: ['eduos-test-client', 'other'], azp: 'eduos-test-client' }), true);
  assert.throws(() => validateAuthorizedParty({ aud: ['eduos-test-client', 'other'] }), /authorized-party mismatch/);
  assert.throws(() => validateAuthorizedParty({ aud: 'eduos-test-client', azp: 'other' }), /authorized-party mismatch/);
});
