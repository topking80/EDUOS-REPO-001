import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const root=process.cwd();
const server=readFileSync(join(root,"src/server.js"),"utf8");
const bridge=readFileSync(join(root,"public/api-bridge.js"),"utf8");
const migration=readFileSync(join(root,"db/006_connected_workflows.sql"),"utf8");
const html=readFileSync(join(root,"public/index.html"),"utf8");
test("family messages require authenticated supported roles and CSRF on send",()=>{
 assert.match(server,/app\.get\("\/api\/family\/messages",requireSession/);
 assert.match(server,/app\.post\("\/api\/family\/messages",requireSession,requireCsrf/);
 assert.match(server,/recipient_not_authorized/);
 assert.match(server,/familyConversationScope/);
});
test("guardian messages are scoped to an active guardian relationship",()=>{
 assert.match(server,/l\.relationship IN \('parent','guardian'\)/);
 assert.match(server,/m\.sender_user_id=\$2 OR m\.recipient_user_id=\$2/);
});
test("teacher preferences are stored by authenticated teacher and school",()=>{
 assert.match(server,/app\.put\("\/api\/teacher\/classroom-preferences",requireSession,requireCsrf/);
 assert.match(server,/teacher_user_id=\$2/);
 // 32.0.53: teachers AND principals may only save preferences for their own school.
 assert.match(server,/if\(schoolId!==req\.actor\.schoolId\)return res\.status\(403\)\.json\(\{error:"school_scope_denied"\}\)/);
 assert.match(migration,/CREATE TABLE teacher_classroom_preferences/);
});
test("SIS import is authenticated, idempotent and audited",()=>{
 assert.match(server,/app\.post\("\/api\/integrations\/sis\/import",requireSession,requireCsrf,requirePermission\("schools","update"\)/);
 assert.match(migration,/UNIQUE\(district_id,source_system,source_batch_id\)/);
 assert.match(server,/sis_attendance_imports/);
 assert.match(server,/payload_sha256/);
 assert.match(server,/sis_import/);
});
test("front end connects family messages and classroom preferences to server API",()=>{
 assert.match(bridge,/familyMessages\(studentId\)/);
 assert.match(bridge,/sendFamilyMessage\(payload\)/);
 assert.match(bridge,/saveClassroomPreference\(payload\)/);
 assert.match(html,/parentPortalLoadMessages/);
 assert.match(html,/saveClassroomPreference/);
});
test("connected workflows migration is registered",()=>{
 const m=readFileSync(join(root,"src/migrate.js"),"utf8");
 assert.match(m,/006_connected_workflows\.sql/);
});

test("teacher and principal navigation expose a connected family message center",()=>{
 const start=html.indexOf("const roleMenus="),end=html.indexOf("const personaConfig",start),nav=html.slice(start,end);
 const teacher=nav.slice(nav.indexOf("teacher:{"),nav.indexOf("parent:{"));
 const principal=nav.slice(nav.indexOf("principal:{"),nav.indexOf("teacher:{"));
 assert.match(teacher,/familymessages/);
 assert.match(principal,/familymessages/);
 assert.match(html,/function familyMessagesPage/);
 assert.match(html,/familyMessagesLoadThread/);
});

test("authenticated login switches the visible workspace to the server role",()=>{
 assert.match(bridge,/window\.setPersona\(a\.role\)/);
 assert.match(bridge,/parentportal/);
});
test("family summary excludes unpublished assignment drafts",()=>{
 const start=server.indexOf('app.get("/api/family/children/:studentId/summary"');
 const end=server.indexOf("// Phase 32.0.36: authenticated family messaging.",start);
 const route=server.slice(start,end);
 assert.match(route,/a\.status='published'/);
});
test("family contacts endpoint is available to authenticated parents and school staff",()=>{
 assert.match(server,/app\.get\("\/api\/family\/contacts",requireSession/);
 assert.match(server,/m\.role='parent'/);
 assert.match(server,/l\.relationship IN \('parent','guardian'\)/);
});
