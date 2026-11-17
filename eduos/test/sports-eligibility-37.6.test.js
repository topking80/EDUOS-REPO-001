// 37.6.0 sports eligibility rules (pure) and the db/060 shape: rule-level
// outcome only, coach / athletic director gate, slip hash binding, roster RLS.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateStudent, evaluateTeam } from "../src/sports-eligibility.js";

const root = new URL("../", import.meta.url);
const policy = { minCoursePercent: 60, minAttendancePercent: 90, windowDays: 30, minRecords: 5 };
const now = new Date("2026-11-17T12:00:00Z");
const course = (title, pct) => ({ title, weights: { Classwork: 100 }, work: [{ id: "w", kind: "work", category: "Classwork", points: 100, dueAt: "2026-11-01", submission: { pointsEarned: pct, gradedAt: "2026-11-02" } }] });
const att = (present, absent) => ({ present, absent, tardy: 0, excused: 0, records: present + absent });

test("eligible, not eligible by named rule, or not enough records; never a number", () => {
  assert.deepEqual(evaluateStudent({ attendance: att(10, 0), courses: [course("Math", 95)] }, policy, now), { status: "eligible", reasons: [] });
  const bad = evaluateStudent({ attendance: att(5, 5), courses: [course("Math", 40), course("Art", 90)] }, policy, now);
  assert.equal(bad.status, "not_eligible");
  assert.deepEqual(bad.reasons.map(r => r.rule), ["grades", "attendance"]);
  assert.match(bad.reasons[0].text, /Math/);
  assert.doesNotMatch(JSON.stringify(bad), /\b(40|50|90)\b/);
  assert.equal(evaluateStudent({ attendance: att(1, 0), courses: [] }, policy, now).status, "not_enough_records");
  const team = evaluateTeam({ policy, students: [{ studentId: "s", name: "A", grade: "9", jersey: 7, attendance: att(10, 0), courses: [] }] }, now);
  assert.deepEqual(Object.keys(team.students[0]).sort(), ["grade", "jersey", "name", "reasons", "status", "studentId"]);
});

test("db/060 gates eligibility, binds slips by hash and scopes rosters in the database", async () => {
  const sql = await readFile(new URL("db/060_sports_eligibility_permission_slips.sql", root), "utf8");
  assert.match(sql, /RAISE EXCEPTION 'eligibility is visible to the coach and athletic director only'/);
  assert.match(sql, /encode\(sha256\(convert_to\(NEW\.body, 'UTF8'\)\), 'hex'\)/);
  assert.match(sql, /activity_permission_slip_signatures_append_only BEFORE UPDATE OR DELETE/);
  assert.match(sql, /CREATE POLICY scope_read ON activity_roster_entries AS RESTRICTIVE FOR SELECT/);
  assert.match(sql, /CREATE POLICY scope_insert ON activity_roster_entries AS RESTRICTIVE FOR INSERT/);
  assert.match(sql, /ALTER FUNCTION eduos_purge_student\(uuid\) RENAME TO eduos_purge_student_pre_sports/);
  assert.match(sql, /CREATE FUNCTION eduos_retention_feature_activities\(p jsonb\)/);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*(eligibility_result|eligibility_score|risk)/i, "eligibility is computed on read, never stored");
  const grants = await readFile(new URL("db/runtime_grants.template.sql", root), "utf8");
  assert.match(grants, /GRANT SELECT, INSERT ON activity_permission_slips, activity_permission_slip_signatures TO eduos_app;/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION eduos_sports_eligibility_inputs\(uuid\) TO eduos_app;/);
});
