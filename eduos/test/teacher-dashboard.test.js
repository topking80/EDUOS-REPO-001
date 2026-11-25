import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync("src/server.js", "utf8");
const route = readFileSync("src/teacher-dashboard-routes.js", "utf8");
const appJs = readFileSync("public/app/app.js", "utf8");
const flutter = readFileSync("mobile/flutter/lib/ui/screens/teacher_dashboard_screen.dart", "utf8");

test("teacher dashboard API route is registered, authenticated, teacher-only, and tenant-scoped", () => {
  assert.match(server, /registerTeacherDashboardRoutes\(app\)/);
  assert.match(route, /app\.get\("\/api\/teacher\/dashboard",\s*requireSession,\s*roleIn\("teacher"\)/);
  assert.match(route, /withTenantTransaction\(a,/);
  assert.match(route, /school_scope_required/);
  assert.match(route, /Cache-Control",\s*"no-store"/);
});

test("teacher dashboard web tab and view are wired first for teachers", () => {
  assert.match(appJs, /teacher:\s*\[\["dashboard",\s*"Dashboard",\s*"home"\]/);
  assert.match(appJs, /^VIEWS\.dashboard\s*=/m);
  assert.match(appJs, /api\.get\("\/api\/teacher\/dashboard"\)/);
});

test("Flutter TeacherDashboardScreen prefers the unified /api/teacher/dashboard endpoint", () => {
  assert.match(flutter, /get\('\/api\/teacher\/dashboard'\)/);
  assert.match(flutter, /Alerts and safety/);
  assert.match(flutter, /Today\\'s schedule/);
});

test("teacher school-day web view reuses staff-workspace and arrival endpoints", () => {
  assert.match(appJs, /\["schoolday",\s*"School day",\s*"bus"\]/);
  assert.match(appJs, /^VIEWS\.schoolday\s*=/m);
  assert.match(appJs, /api\.get\("\/api\/staff-workspace"\)/);
  assert.match(appJs, /api\.get\("\/api\/arrival\/today"\)/);
  assert.match(appJs, /\/api\/staff-workspace\/checklists\/\$\{item\.item_id\}\/complete/);
  assert.match(appJs, /\/api\/staff-workspace\/handoffs\/\$\{row\.id\}\/acknowledge/);
  assert.match(appJs, /api\.post\("\/api\/staff-workspace\/handoffs"/);
  assert.match(appJs, /\/api\/arrival\/handoffs\/\$\{row\.id\}\/receive/);
  assert.match(appJs, /schoolDayAllDuties/);
  assert.match(appJs, /Library \/ media center duty/);
  assert.match(appJs, /Lunchroom duty/);
  assert.match(appJs, /Transport duty/);
});
