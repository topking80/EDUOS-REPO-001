import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertReleaseMetadataAligned } from './helpers/release.js';

const policy = await readFile(new URL('../src/policy.js', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/safety-routes.js', import.meta.url), 'utf8');
const admin = await readFile(new URL('../src/admin-routes.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../db/020_sro_role.sql', import.meta.url), 'utf8');
const runner = await readFile(new URL('../src/migrate.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app/app.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('35.3 SRO role is limited to school and safety permissions', () => {
  assert.match(policy, /sro: \{\s*schools: \["read"\], branding: \["read"\], safety: \["read", "sro_update"\]/);
  assert.doesNotMatch(policy.slice(policy.indexOf('sro: {'), policy.indexOf('sro: {')+180), /students:|attendance:|pickup:|transport:/);
});

test('35.3 SRO status endpoints use the dedicated permission and school assignment', () => {
  assert.match(routes, /sro-status", requireSession, requirePermission\("safety", "sro_update"\)/);
  assert.match(routes, /i\.school_id !== req\.actor\.schoolId/);
});

test('35.4 SRO provisioning and revocation are district-controlled, not principal-controlled', () => {
  assert.match(admin, /ROLES = \[[^\]]*"sro"/);
  assert.doesNotMatch(admin.match(/PRINCIPAL_MANAGED = \[[^\]]*\]/)?.[0] || "", /sro/);
  assert.match(admin, /IT_MANAGED = \[[^\]]*"sro"/);
  assert.match(admin, /actor\.role === "superintendent"\) return true/);
  assert.match(admin, /actor\.role === "it_admin"\) return IT_MANAGED\.includes\(role\)/);
  assert.match(admin, /SRO membership is district-controlled/);
});

test('35.3 database migration constrains SRO to school scope and limited staff notifications', () => {
  assert.match(migration, /role IN \([^;]*'sro'\)/);
  assert.match(migration, /m\.role IN \('principal','teacher','driver','sro'\)/);
  assert.match(migration, /p_audience='families'/);
});

test('35.3 migration is registered and UI exposes dedicated SRO workspace', () => {
  assert.match(runner, /020_sro_role\.sql/);
  assert.match(app, /sro: \[\["safety", "Safety", "shield"\]/);
  assert.match(app, /School Resource Officer \(SRO\) incident workspace/);
});

test('35.3 release metadata is aligned', () => {
  assertReleaseMetadataAligned();
});
