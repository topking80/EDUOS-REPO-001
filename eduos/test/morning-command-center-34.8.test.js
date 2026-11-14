import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ui = await readFile(new URL('../public/api-bridge.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('34.8 command center loads the authoritative AM reconciliation feed', () => {
  assert.match(ui, /API\.request\("\/api\/arrival\/reconciliation"\)/);
  assert.match(ui, /c\.reconciliation=reconciliation/);
});

test('34.8 command center exposes readiness coverage and actionable review navigation', () => {
  assert.match(ui, /AM arrival reconciliation/);
  assert.match(ui, /Morning readiness/);
  assert.match(ui, /Review route-by-route details/);
  assert.match(ui, /data-tab="arrival-reconciliation"/);
});

test('34.8 package metadata is aligned', () => {
  assert.equal(pkg.version, '35.6.0');
  assert.equal(pkg.scripts['arrival:escalations'], 'node src/arrival-escalation-dispatch.js');
});
