import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('../public/api-bridge.js', import.meta.url), 'utf8');

test('server workspace loads independent sections without all-or-nothing failure', () => {
  assert.match(bridge, /Promise\.allSettled\(entries\.map/);
  assert.match(bridge, /data\.errors\[key\]/);
  assert.match(bridge, /Some sections could not be refreshed/);
});

test('refresh preserves the current workspace tab', () => {
  // 32.2.0: every role lands on its Home dashboard first.
  assert.match(bridge, /let activeTab="home"/);
  assert.match(bridge, /activeTab=tab/);
  assert.match(bridge, /render\(activeTab\)/);
});

test('partial-load failures expose an actionable retry control', () => {
  assert.match(bridge, /data-action="retry-load"/);
  assert.match(bridge, /b\.dataset\.action==="retry-load"/);
});
