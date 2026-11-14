import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const routes = await readFile(new URL('../src/pickup-routes.js', import.meta.url), 'utf8');
const policy = await readFile(new URL('../src/policy.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('35.0 accountability endpoint requires authenticated pickup management permission', () => {
  assert.match(routes, /app\.get\("\/api\/pickup\/accountability", requireSession, requirePermission\("pickup", "manage"\)/);
});

test('35.0 accountability endpoint requires and validates a school scope', () => {
  assert.match(routes, /if \(!schoolId\) return res\.status\(400\)\.json\(\{ error: "school_id_required" \}\)/);
  assert.match(routes, /WHERE id=\$1 AND district_id=\$2/);
  assert.match(routes, /a\.role === "principal" && a\.schoolId !== school\.id/);
});

test('35.0 release ledger is limited to the school-local service date and district', () => {
  assert.match(routes, /service_date=eduos_school_today\(\$2\)/);
  assert.match(routes, /WHERE e\.district_id=\$1 AND e\.school_id=\$2/);
  assert.match(routes, /count\(\*\) FILTER \(WHERE event='blocked'\)/);
});

test('35.0 does not grant additional pickup permissions to staff roles', () => {
  assert.match(policy, /principal: \{[\s\S]*?pickup: \["read", "verify", "manage"\]/);
  assert.match(policy, /teacher: \{[\s\S]*?pickup: \["read", "verify"\]/);
});

test('35.0 release metadata is aligned', () => {
  assert.equal(pkg.version, '35.6.0');
});
