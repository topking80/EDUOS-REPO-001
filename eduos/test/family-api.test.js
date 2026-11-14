import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
test("family children API requires an authenticated parent role", () => {
  assert.match(server, /app\.get\("\/api\/family\/children",requireSession,requireGuardian,requirePermission\("students","read"\)/);
});
test("family children query requires active parent or guardian link", () => {
  const start = server.indexOf('app.get("/api/family/children"');
  const end = server.indexOf('app.get("/api/family/children/:studentId/summary"', start);
  const route = server.slice(start, end);
  assert.match(route, /l\.user_id=\$2/);
  assert.match(route, /l\.status='active'/);
  assert.match(route, /l\.relationship IN \('parent','guardian'\)/);
  assert.match(route, /l\.district_id=\$1/);
});
test("family child summary verifies relationship before reading records", () => {
  const start = server.indexOf('app.get("/api/family/children/:studentId/summary"');
  const end = server.indexOf("// Phase 32.0.34: authenticated family messaging.", start);
  const route = server.slice(start, end);
  assert.ok(route.indexOf("if(!linked.rowCount)return null") < route.indexOf("FROM attendance_events"));
  assert.match(route, /l\.user_id=\$2 AND l\.student_id=\$3/);
  assert.match(route, /l\.status='active' AND l\.relationship IN \('parent','guardian'\)/);
  assert.match(route, /validId\(req\.params\.studentId\)/);
});
test("family endpoints return only summary fields and do not expose response text", () => {
  const start = server.indexOf('app.get("/api/family/children/:studentId/summary"');
  const end = server.indexOf("// Phase 32.0.34: authenticated family messaging.", start);
  const route = server.slice(start, end);
  assert.match(route, /sub\.score,sub\.feedback,sub\.graded_at/);
  assert.doesNotMatch(route, /sub\.response_text|local_student_number/);
});
