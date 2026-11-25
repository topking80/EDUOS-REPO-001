import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { physicalStatus, validMarks, ATTENDANCE_STATUSES } from "../src/activity-operations.js";
const root = new URL("../", import.meta.url);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("physical status comes only from dates on file", () => {
  const today = new Date("2026-11-25T12:00:00Z");
  assert.equal(physicalStatus(null, today).status, "missing");
  assert.equal(physicalStatus({ cleared_on: "2026-01-10", expires_on: "2026-11-24" }, today).status, "expired");
  assert.equal(physicalStatus({ cleared_on: "2026-01-10", expires_on: "2026-12-10" }, today).status, "expiring");
  const ok = physicalStatus({ cleared_on: "2026-08-01", expires_on: "2027-07-31" }, today);
  assert.deepEqual(ok, { status: "cleared", clearedOn: "2026-08-01", expiresOn: "2027-07-31" });
});

test("attendance marks are validated: known statuses, unique learners, bounded batch", () => {
  assert.deepEqual([...ATTENDANCE_STATUSES], ["present", "late", "excused", "absent"]);
  assert.equal(validMarks([{ studentId: id(1), status: "present" }, { studentId: id(2), status: "excused" }]), true);
  assert.equal(validMarks([]), false);
  assert.equal(validMarks([{ studentId: id(1), status: "here" }]), false);
  assert.equal(validMarks([{ studentId: "nope", status: "present" }]), false);
  assert.equal(validMarks([{ studentId: id(1), status: "present" }, { studentId: id(1), status: "absent" }]), false);
  assert.equal(validMarks(Array.from({ length: 301 }, (_, i) => ({ studentId: id(i + 1), status: "present" }))), false);
});

test("migration 152 forces RLS, keeps clearances append-only and grants only through the template", async () => {
  const sql = await readFile(new URL("db/152_activity_attendance_physicals.sql", root), "utf8");
  for (const t of ["activity_event_attendance", "student_physical_clearances"]) assert.match(sql, new RegExp(`CREATE TABLE ${t}`));
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /student_physical_clearances_append_only/);
  assert.match(sql, /eduos_can_manage_roster\(activity_id, school_id\)/);
  assert.doesNotMatch(sql, /TO eduos_app/, "grants belong in runtime_grants.template.sql");
  assert.doesNotMatch(sql, /diagnos|condition|medical_notes|allerg/i, "no medical details are stored");
  const grants = await readFile(new URL("db/runtime_grants.template.sql", root), "utf8");
  assert.match(grants, /GRANT SELECT, INSERT ON activity_event_attendance, student_physical_clearances TO eduos_app/);
  assert.match(grants, /REVOKE DELETE, TRUNCATE ON activity_event_attendance, student_physical_clearances FROM eduos_app/);
});

test("routes are registered and the teacher dashboard carries my clubs and teams", async () => {
  const server = await readFile(new URL("src/server.js", root), "utf8");
  assert.match(server, /registerActivityOperationsRoutes\(app\)/);
  const dash = await readFile(new URL("src/teacher-dashboard-routes.js", root), "utf8");
  assert.match(dash, /activities: \{/);
  assert.match(dash, /attendanceDue/);
});
