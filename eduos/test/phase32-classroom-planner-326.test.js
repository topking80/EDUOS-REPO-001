import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
test('teacher classroom planner is integrated into the home workspace',()=>{
  assert.match(html,/classroomPlanningSuite\(\)/);
  assert.match(html,/Teacher preference/);
  assert.match(html,/Save my preference/);
  assert.match(html,/localStorage\.setItem\(ECP_STORAGE_KEY/);
});
test('teacher arrangement options and desk preferences are available',()=>{
  for(const value of ['rows','pods','u','groups','front-left','front-center','front-right','side-left','side-right','back-center']) assert.ok(html.includes(value),`missing ${value}`);
});
test('floor and room navigation is interactive and emergency routes are not fabricated',()=>{
  assert.match(html,/ecpFloorChanged/);
  assert.match(html,/ecpChooseRoom/);
  assert.match(html,/not configured \/ not verified/);
  assert.match(html,/does not calculate or certify a safe route/);
});
test('saved teacher preferences are restored when the workspace opens',()=>{
  assert.match(html,/function ecpRestore\(\)/);
  assert.match(html,/go\(\"home\"\);\s*ecpRestore\(\)/);
});

test('classroom layouts support validated JSON export and import',()=>{
  assert.match(html,/function ecpExport\(\)/);
  assert.match(html,/function ecpImport\(event\)/);
  assert.match(html,/function ecpValidate\(data\)/);
  assert.match(html,/file\.size>32768/);
  assert.match(html,/ECP_LAYOUTS\.has\(data\.layout\)/);
  assert.match(html,/ECP_DESKS\.has\(data\.desk\)/);
  assert.match(html,/accept="application\/json,\.json"/);
});
test('classroom preferences migrate from the previous browser storage key',()=>{
  assert.match(html,/localStorage\.getItem\('eduos-classroom-preference-v326'\)/);
  assert.match(html,/eduos-classroom-preference-v329/);
});
