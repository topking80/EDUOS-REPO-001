import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const bridge=fs.readFileSync("public/api-bridge.js","utf8");
test("authenticated API bridge exposes an authoritative arrival register",()=>{
  assert.match(bridge,/\"arrival\"/);
  assert.match(bridge,/\/api\/arrival\/today/);
  assert.match(bridge,/Arrival register/);
  assert.match(bridge,/These records come from the authenticated district API/);
});
test("principal and driver can create only their server-validated arrival types",()=>{
  assert.match(bridge,/data-form=\"arrival-create\"/);
  assert.match(bridge,/routeRunId/);
  assert.match(bridge,/assignedTeacherUserId/);
  assert.match(bridge,/\/api\/arrival\/handoffs/);
});
test("staff receipt and first attendance call separate authoritative endpoints",()=>{
  assert.match(bridge,/arrival-receive/);
  assert.match(bridge,/\/receive/);
  assert.match(bridge,/arrival-attendance/);
  assert.match(bridge,/first-attendance/);
  assert.match(bridge,/Independent staff receipt recorded/);
});
