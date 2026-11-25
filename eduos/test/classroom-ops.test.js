import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseBellSchedule, parseSeatingChart } from "../src/classroom-ops.js";
const root = new URL("../", import.meta.url);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("bell schedule parser sorts periods, rejects overlaps and invalid times", () => {
  const ok = parseBellSchedule({
    name: "Regular Day",
    dayType: "regular",
    isDefault: true,
    periods: [
      { label: "Period 2", starts: "09:00", ends: "09:50" },
      { label: "Period 1", starts: "08:00", ends: "08:50", kind: "homeroom" }
    ]
  });
  assert.equal(ok.periods[0].label, "Period 1");
  assert.equal(ok.periods[0].seq, 1);
  assert.equal(ok.periods[1].seq, 2);
  assert.equal(parseBellSchedule({ name: "Overlap", periods: [{ label: "A", starts: "08:00", ends: "09:00" }, { label: "B", starts: "08:45", ends: "09:30" }] }), null);
  assert.equal(parseBellSchedule({ name: "Backwards", periods: [{ label: "A", starts: "09:00", ends: "08:00" }] }), null);
  assert.equal(parseBellSchedule({ name: "Bad kind", periods: [{ label: "A", starts: "08:00", ends: "09:00", kind: "recess" }] }), null);
});

test("seating chart parser rejects duplicate seats, duplicate students and out-of-bounds coords", () => {
  const ok = parseSeatingChart({ roomId: id(1), rowsCount: 4, colsCount: 5, shareWithFamilies: true, assignments: [{ studentId: id(2), row: 1, col: 3, label: "Front" }] });
  assert.equal(ok.assignments.length, 1);
  assert.equal(ok.shareWithFamilies, true);
  assert.equal(parseSeatingChart({ rowsCount: 4, colsCount: 5, shareWithFamilies: "yes", assignments: [] }), null);
  assert.equal(parseSeatingChart({ rowsCount: 4, colsCount: 5, assignments: [{ studentId: id(2), row: 5, col: 1 }] }), null);
  assert.equal(parseSeatingChart({ rowsCount: 4, colsCount: 5, assignments: [{ studentId: id(2), row: 1, col: 1 }, { studentId: id(3), row: 1, col: 1 }] }), null);
  assert.equal(parseSeatingChart({ rowsCount: 4, colsCount: 5, assignments: [{ studentId: id(2), row: 1, col: 1 }, { studentId: id(2), row: 1, col: 2 }] }), null);
});

test("migration 153 forces RLS, restricts seating to course managers and grants via template only", async () => {
  const sql = await readFile(new URL("db/153_classrooms_seating_bell.sql", root), "utf8");
  for (const t of ["school_bell_schedules", "school_bell_periods", "course_seating_charts", "course_seat_assignments"]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${t}`));
  }
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /share_with_families boolean NOT NULL DEFAULT false/);
  assert.match(sql, /eduos_can_manage_bell_schedule/);
  assert.match(sql, /eduos_can_read_seat\(course_id, student_id\)/);
  assert.match(sql, /eduos_can_manage_course\(course_id\)/);
  assert.doesNotMatch(sql, /TO eduos_app/, "grants belong in runtime_grants.template.sql");
  const grants = await readFile(new URL("db/runtime_grants.template.sql", root), "utf8");
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON school_bell_schedules, course_seating_charts TO eduos_app/);
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE, DELETE ON school_bell_periods, course_seat_assignments TO eduos_app/);
  assert.match(grants, /eduos_can_manage_bell_schedule\(uuid\)/);
  assert.match(grants, /eduos_can_read_seat\(uuid, uuid\)/);
});

test("routes and teacher dashboard expose bell schedules and seating charts", async () => {
  const server = await readFile(new URL("src/server.js", root), "utf8");
  assert.match(server, /registerClassroomOpsRoutes\(app\)/);
  const dash = await readFile(new URL("src/teacher-dashboard-routes.js", root), "utf8");
  assert.match(dash, /bellSchedule:/);
  assert.match(dash, /seatedCount:/);
});
