import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertReleaseMetadataAligned } from './helpers/release.js';

const routes = await readFile(new URL('../src/safety-routes.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('35.1 reunification manifest is lead-only and incident-scoped', () => {
  assert.match(routes, /reunification-manifest", requireSession, lead/);
  assert.match(routes, /i\.status !== "reunification"/);
});

test('35.1 manifest uses district-scoped enrollment and active guardian relationships', () => {
  assert.match(routes, /WHERE s\.school_id=\$2 AND s\.district_id=\$3/);
  assert.match(routes, /l\.status='active' AND l\.relationship IN \('parent','guardian'\)/);
});

test('35.1 manifest reports rollcall and release status without exposing guardian account details', () => {
  assert.match(routes, /awaitingRollcall/);
  assert.match(routes, /awaitingGuardianRelease/);
  assert.match(routes, /eligibleGuardians/);
  assert.doesNotMatch(routes, /guardianEmail|guardianPhone|guardianUserId/);
});

test('35.1 manifest access is audited and non-cacheable', () => {
  assert.match(routes, /safety_reunification_manifest/);
  assert.match(routes, /Cache-Control", "no-store"/);
});

test('35.1 release metadata is aligned', () => {
  assertReleaseMetadataAligned();
});
