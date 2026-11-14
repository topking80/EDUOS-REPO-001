import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../public/api-bridge.js', import.meta.url), 'utf8');
const profileRoute = server.slice(server.indexOf('app.get("/api/student-360/:studentId"'), server.indexOf('app.get("/api/cases"'));

test('Student 360 history includes distinct attendance, acknowledgment, assignment, submission, grade and case events', () => {
  for (const kind of ['attendance_acknowledged', 'submission', 'grade', 'case_note']) assert.ok(profileRoute.includes(`'${kind}'`), `missing ${kind}`);
  assert.match(profileRoute, /'attendance'::text AS kind/);
  assert.match(profileRoute, /'assignment',a\.id,a\.created_at/);
  assert.match(profileRoute, /ORDER BY occurred_at DESC LIMIT 200/);
});

test('timeline resolves responsible users where the source record supports attribution', () => {
  assert.match(profileRoute, /recorder\.display_name AS actor_name/);
  assert.match(profileRoute, /creator\.display_name/);
  assert.match(profileRoute, /pupil\.display_name/);
  assert.match(profileRoute, /grader\.display_name/);
  assert.match(profileRoute, /author\.display_name/);
});

test('family timeline requires both case-level and note-level visibility', () => {
  assert.match(profileRoute, /\$3='parent' AND c\.family_visible=true AND n\.family_visible=true/);
  assert.match(profileRoute, /studentScopeSql/);
});

test('attendance date history is normalized to UTC rather than server-local timezone', () => {
  assert.match(profileRoute, /e\.event_date::timestamp AT TIME ZONE 'UTC'/);
});

test('record history UI escapes event content and identifies event actor', () => {
  assert.match(bridge, /Student record history/);
  assert.match(bridge, /esc\(t\.actor_name\)/);
  assert.match(bridge, /esc\(t\.detail\)/);
  assert.match(bridge, /aria-label="Chronological student record history"/);
});

test('case updates append readable change summaries without exposing raw owner identifiers', () => {
  assert.match(server, /Case updated: \$\{changed\.join\('; '\)/);
  assert.match(server, /case owner changed/);
  assert.doesNotMatch(server, /Case updated: \$\{JSON\.stringify\(/);
});
