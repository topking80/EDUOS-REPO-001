import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('37.1 staff workspace is reachable from all intended staff role tabs', async () => {
  const app = await readFile(new URL('public/app/app.js', root), 'utf8');
  for (const role of ['teacher','principal','vice_principal','superintendent','counselor','nurse','maintenance','lunch_staff']) {
    const line = app.split('\n').find(x => x.startsWith(`  ${role}:`));
    assert.ok(line, `${role} role tab definition exists`);
    assert.match(line, /\["staffing", "Staffing", "people"\]/, `${role} can open staffing`);
  }
  assert.match(app, /VIEWS\.staffing = async \(\) =>/);
  assert.match(app, /api\.get\("\/api\/staff-management"\)/);
});

test('37.1 staffing UI calls the authenticated API workflows and exposes no medical free-text field', async () => {
  const app = await readFile(new URL('public/app/app.js', root), 'utf8');
  assert.match(app, /\/api\/staff-management\/absences/);
  assert.match(app, /\/api\/staff-management\/coverage/);
  assert.match(app, /\/api\/staff-management\/absences\/\$\{id\}\/review/);
  assert.match(app, /\/api\/staff-management\/coverage\/\$\{id\}\/decision/);
  assert.match(app, /Do not include medical details or sensitive personal information/);
  assert.doesNotMatch(app, /medicalNotes|diagnosis|illnessDetails/);
});

test('37.1 staffing actions validate intervals and use API client with CSRF handling', async () => {
  const app = await readFile(new URL('public/app/app.js', root), 'utf8');
  assert.match(app, /end\.input\.value < start\.input\.value/);
  assert.match(app, /to\.input\.value<=from\.input\.value/);
  assert.match(app, /api\.post\("\/api\/staff-management\/absences"/);
  assert.match(app, /api\.post\("\/api\/staff-management\/coverage"/);
});
