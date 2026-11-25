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

test("teacher dashboard exposes inline notification, handoff, checklist, and arrival actions", () => {
  assert.match(route, /pendingArrivals:\s*pendingArrivals/);
  assert.match(route, /checklistItems:\s*incompleteChecklists/);
  assert.match(appJs, /api\.post\("\/api\/notifications\/read"/);
  assert.match(appJs, /\/api\/arrival\/handoffs\/\$\{row\.id\}\/receive/);
  assert.match(appJs, /\/api\/staff-workspace\/checklists\/\$\{item\.itemId\}\/complete/);
  assert.match(appJs, /\/api\/staff-workspace\/handoffs\/\$\{row\.id\}\/acknowledge/);
  assert.match(appJs, /"Mark read"/);
  assert.match(appJs, /"Confirm handoff"/);
  assert.match(flutter, /\/api\/notifications\/read/);
  assert.match(flutter, /\/api\/arrival\/handoffs\//);
  assert.match(flutter, /\/api\/staff-workspace\/checklists\//);
  assert.match(flutter, /\/api\/staff-workspace\/handoffs\//);
  assert.match(flutter, /Mark read/);
  assert.match(flutter, /Confirm handoff/);
  assert.match(flutter, /Mark all read/);
});

test("teacher dashboard and classes show a classroom roll and capability-filtered live device controls", () => {
  assert.match(appJs, /classroomLiveExtras/);
  assert.match(appJs, /api\.get\(`\/api\/rooms\/\$\{r\.id\}\/roll`\)/);
  assert.match(appJs, /api\.post\(`\/api\/devices\/\$\{d\.id\}\/commands`/);
  assert.match(appJs, /teacherDeviceControls/);
  assert.match(appJs, /has\("show"\)/);
  assert.match(appJs, /has\("blank"\)/);
  assert.match(appJs, /has\("lock"\)/);
  assert.match(appJs, /"Live device controls"/);
  assert.match(appJs, /classroom roll/);
  assert.match(appJs, /paused_for_safety/);
  assert.match(appJs, /myClassroomCard\(\)/);
});

test("teacher dashboard includes opted-in NWS weather advisories and a principal-controlled pass-on setting", () => {
  const weather = readFileSync("src/weather-routes.js", "utf8");
  const migration = readFileSync("db/151_school_weather_teacher_advisories.sql", "utf8");
  assert.match(migration, /CREATE TABLE school_weather_share_settings/);
  assert.match(migration, /pass_on boolean NOT NULL DEFAULT false/);
  assert.match(migration, /eduos_teacher_weather_advisories/);
  assert.match(weather, /\/api\/safety\/weather\/share/);
  assert.match(weather, /weather_pass_on/);
  assert.match(route, /eduos_teacher_weather_advisories/);
  assert.match(route, /weatherPassOn/);
  assert.match(route, /weatherAdvisories/);
  assert.match(appJs, /Pass active weather advisories on to teachers/);
  assert.match(appJs, /\/api\/safety\/weather\/share/);
  assert.match(appJs, /"Weather advisories"/);
  assert.match(flutter, /Weather advisories/);
  assert.match(flutter, /weatherAdvisories/);
});
