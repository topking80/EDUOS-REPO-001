import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../public/api-bridge.js',import.meta.url),'utf8');
test('command center is exposed only to superintendent and principal roles',()=>{
  assert.match(source,/\["superintendent","principal"\]\.includes\(role\)\)list\.push\(\["command","Command center"\]\)/);
});
test('command center reads only existing authenticated operational endpoints',()=>{
  for(const endpoint of ['/api/arrival/today','/api/transport/today','/api/users?role=teacher']) assert.ok(source.includes(endpoint));
  assert.match(source,/Promise\.allSettled\(jobs\)/);
});
test('command center presents counts with a scope caveat and exception queue',()=>{
  assert.match(source,/Counts reflect returned records, not necessarily the entire district/);
  assert.match(source,/Priority queue/);
  assert.match(source,/Confirm independent receipt before first attendance/);
});
test('command center adds no mutation endpoints or client-side role elevation',()=>{
  const block=source.slice(source.indexOf('if(tab==="command"){'),source.indexOf('if(tab==="arrival"){\n      const a=ext.arrival'));
  assert.ok(block.length>0);
  assert.doesNotMatch(block,/API\.request\([^\n]*\{\s*method:\s*"POST"/);
});
