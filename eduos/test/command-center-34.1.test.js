import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const arrival=fs.readFileSync(new URL('../src/arrival-routes.js',import.meta.url),'utf8');
const bridge=fs.readFileSync(new URL('../public/api-bridge.js',import.meta.url),'utf8');
test('arrival today uses each school timezone and a half-open local-day interval',()=>{
  assert.match(arrival,/JOIN schools sc ON sc\.id=h\.school_id AND sc\.district_id=h\.district_id/);
  assert.match(arrival,/eduos_school_today\(h\.school_id\)::timestamp AT TIME ZONE sc\.timezone/);
  assert.match(arrival,/eduos_school_today\(h\.school_id\)\+1\)::timestamp AT TIME ZONE sc\.timezone/);
  assert.doesNotMatch(arrival,/date_trunc\('day',now\(\) AT TIME ZONE 'UTC'\)/);
});
test('command center validates feed shapes before counting records',()=>{
  assert.match(bridge,/Array\.isArray\(arrival\)/);
  assert.match(bridge,/Array\.isArray\(transport\.routes\)/);
  assert.match(bridge,/Array\.isArray\(teachers\)/);
  assert.match(bridge,/\[\.\.\.new Set\(feedErrors\)\]/);
});
test('unavailable command-center feeds are displayed as unknown, not zero',()=>{
  assert.match(bridge,/data\.errors\.command\.includes\("arrival"\)\?"—":pending/);
  assert.match(bridge,/data\.errors\.command\.includes\("transport"\)\?"—":activeRuns/);
  assert.match(bridge,/data\.errors\.command\.includes\("staffing"\)\?"—":c\.teachers\?\.length/);
});
