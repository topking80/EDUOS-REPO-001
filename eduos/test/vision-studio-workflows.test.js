import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const app=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const vision=fs.readFileSync(path.join(root,'public/eduos-vision.js'),'utf8');
test('Vision Studio maps concepts to existing EduOS workflows',()=>{
 assert.match(vision,/const workflowRoutes =/);
 assert.match(vision,/Open related EduOS workspace/);
 for(const route of ['overview','schools','services','parentportal','learning','permissions','accessrequests','records','audit','infrastructure','agents','command','operations','reports','costs','planner','departments','academics','attendance','campus','familymessages']) assert.ok(vision.includes('"'+route+'"'),`missing route ${route}`);
});
test('Vision Studio bridge validates origin, iframe source, message type and route allowlist',()=>{
 assert.match(app,/event\.origin!==window\.location\.origin/);
 assert.match(app,/event\.source!==frame\.contentWindow/);
 assert.match(app,/EDUOS_OPEN_WORKFLOW/);
 assert.match(app,/visionWorkflowAllowlist\.has\(msg\.page\)/);
 assert.match(app,/personaConfig\[activePersona\].*pages\.includes\(msg\.page\)/s);
});
