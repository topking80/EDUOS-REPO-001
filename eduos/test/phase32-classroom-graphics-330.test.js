import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
test('32.0.30 classroom graphics are present and integrated',()=>{const html=(fs.readFileSync(path.join(root,'public/index.html'),'utf8')+fs.readFileSync(path.join(root,'public/legacy-app.js'),'utf8'));for(const name of ['eduos-classroom-zones.svg','eduos-teacher-workstation.svg','eduos-classroom-accessibility.svg']){assert.ok(fs.existsSync(path.join(root,'public/assets',name)),name+' exists');assert.ok(html.includes('/assets/'+name),name+' is integrated')}assert.match(html,/Classroom visual guides/);assert.match(html,/not measured architectural plans/)});
test('classroom graphics are labeled as conceptual rather than official safety plans',()=>{const html=(fs.readFileSync(path.join(root,'public/index.html'),'utf8')+fs.readFileSync(path.join(root,'public/legacy-app.js'),'utf8'));assert.match(html,/approved safety documents/);assert.match(html,/not measured architectural plans/);});
