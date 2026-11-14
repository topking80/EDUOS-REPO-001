import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const sw = await readFile(new URL('../public/app/sw.js', import.meta.url), 'utf8');

test('arrival workflow is prominently marked as a browser-local demo', () => {
  assert.match(html, /DEMO ONLY — NOT AN AUTHORITATIVE STUDENT RECORD/);
  assert.match(html, /not connected to the district roster, transportation manifest, staff identity, attendance database/);
  assert.match(html, /persona selection is a presentation control, not authentication or authorization/i);
});

test('arrival demo storage is isolated from the previous demo namespace', () => {
  assert.match(html, /eduos_arrival_handoff_demo_v2/);
  assert.doesNotMatch(html, /const ARRIVAL_KEY="eduos_arrival_handoff_v1"/);
});

test('application and service worker cache versions agree', () => {
  assert.equal(pkg.version, '35.6.0');
  assert.match(html, /District Edition · 34\.7\.0/);
  assert.match(sw, /eduos-app-shell-34\.7\.0/);
});
