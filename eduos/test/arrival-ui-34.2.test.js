import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ui = await readFile(new URL('../public/api-bridge.js', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/arrival-routes.js', import.meta.url), 'utf8');

test('driver arrival roster is partitioned by the selected assigned route run', () => {
  assert.match(ui, /routeRunId:r\.run\.id/);
  assert.match(ui, /data-route-run=/);
  assert.match(ui, /data-arrival-run-select/);
  assert.match(ui, /data-arrival-rider-select/);
  assert.match(ui, /option\.dataset\.routeRun===runId/);
  assert.match(ui, /riders\.disabled=visible===0/);
});

test('arrival UI tolerates absent or malformed feed collections', () => {
  assert.match(ui, /Array\.isArray\(a\.students\)/);
  assert.match(ui, /Array\.isArray\(a\.teachers\)/);
  assert.match(ui, /Array\.isArray\(a\.transport\?\.routes\)/);
  assert.match(ui, /Array\.isArray\(a\.handoffs\)/);
  assert.match(ui, /Array\.isArray\(r\.stops\)/);
  assert.match(ui, /Array\.isArray\(st\.riders\)/);
});

test('arrival endpoints retain school-local day and district/school boundaries', () => {
  assert.match(routes, /eduos_school_today\(h\.school_id\)::timestamp AT TIME ZONE sc\.timezone/);
  assert.match(routes, /h\.district_id=\$1/);
  assert.match(routes, /actorSchoolId:a\.schoolId,handoffSchoolId:h\.school_id/);
  assert.match(routes, /arrivalReceiptDenial/);
  assert.match(routes, /firstAttendanceDenial/);
});
