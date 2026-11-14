import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const routes = await readFile(new URL('../src/safety-routes.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app/app.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('35.2 SRO status read requires authenticated safety lead and live incident', () => {
  assert.match(routes, /sro-status", requireSession, requirePermission\("safety", "sro_update"\)/);
  assert.match(routes, /if \(!LIVE\.includes\(i\.status\)\) throw new HttpError\(409, "incident_not_live"\)/);
});

test('35.2 SRO status writes are CSRF-protected, role-protected, and status constrained', () => {
  assert.match(routes, /sro-status", limiter, requireSession, requireCsrf, requirePermission\("safety", "sro_update"\)/);
  assert.match(routes, /\["requested", "notified", "responding", "on_scene", "cleared", "unavailable"\]/);
  assert.match(routes, /type: "sro_status"/);
});

test('35.2 SRO status is audited and no-cache', () => {
  assert.match(routes, /safety_sro_status/);
  assert.match(routes, /Cache-Control", "no-store"/);
});

test('35.2 principal and superintendent safety UI includes SRO coordination', () => {
  assert.match(app, /School Resource Officer \(SRO\) coordination/);
  assert.match(app, /sro-status/);
  assert.match(app, /Agency \/ unit/);
});

test('35.2 release metadata is aligned', () => {
  assert.equal(pkg.version, '35.8.0');
});
