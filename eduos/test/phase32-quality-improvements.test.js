import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../public/api-bridge.js', import.meta.url), 'utf8');

test('Student 360 does not return internal support plans in family-visible case records', () => {
  const route = server.slice(server.indexOf('app.get("/api/student-360/:studentId"'), server.indexOf('app.get("/api/cases"'));
  assert.match(route, /c\.family_visible=true/);
  assert.doesNotMatch(route, /c\.support_plan/);
});

test('opening Student 360 from any workspace preserves the tab navigation', () => {
  assert.match(bridge, /if\(!target\)\{target=document\.createElement\("div"\);target\.id="api-profile"/);
  assert.match(bridge, /nav\.insertAdjacentElement\("afterend",target\)/);
  assert.doesNotMatch(bridge, /el\("api-profile"\)\|\|el\("eduos-api-content"\)/);
  assert.match(bridge, /data-action="close-profile"/);
});
