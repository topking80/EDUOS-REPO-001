import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertReleaseMetadataAligned } from './helpers/release.js';

const ui = await readFile(new URL('../public/api-bridge.js', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/arrival-routes.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('34.9 reconciliation feed includes tenant-scoped school identity for aggregation', () => {
  assert.match(routes, /sc\.name AS school_name,sc\.id AS school_id/);
  assert.match(routes, /JOIN schools sc ON sc\.id=r\.school_id AND sc\.district_id=r\.district_id/);
});

test('34.9 command center groups AM rider accountability by school', () => {
  assert.match(ui, /School attendance accountability/);
  assert.match(ui, /schoolReadiness/);
  assert.match(ui, /Missing first attendance/);
  assert.match(ui, /car riders and walk-ins are not included in this denominator/);
});

test('34.9 release metadata is aligned', () => {
  assertReleaseMetadataAligned();
});
