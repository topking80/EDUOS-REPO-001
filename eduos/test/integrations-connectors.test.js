// OneRoster/Ed-Fi normalization, import planning and secret encryption
// (src/integrations/). No network or database.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as oneroster from "../src/integrations/oneroster.js";
import * as edfi from "../src/integrations/edfi.js";
import { planImport } from "../src/integrations/sync.js";
import { encryptSecret, decryptSecret } from "../src/integrations/secrets.js";

const KEY = "k".repeat(40);

test("OneRoster 1.2 and 1.1 students normalize to EduOS records", () => {
  const v12 = oneroster.normalizeStudent({ sourcedId: "u1", status: "active", identifier: "1001", givenName: "Ada", preferredFirstName: "Addie", familyName: "Lovelace",
    grades: ["03"], roles: [{ roleType: "secondary", role: "student", org: { sourcedId: "s9" } }, { roleType: "primary", role: "student", org: { sourcedId: "s1" } }] });
  assert.deepEqual(v12.student, { externalId: "u1", localStudentNumber: "1001", displayName: "Addie Lovelace", gradeLevel: "3", schoolExternalId: "s1" });
  const v11 = oneroster.normalizeStudent({ sourcedId: "u2", givenName: "Bo", familyName: "B", grades: ["KG"], orgs: [{ sourcedId: "s2" }] });
  assert.deepEqual(v11.student, { externalId: "u2", localStudentNumber: "u2", displayName: "Bo B", gradeLevel: "KG", schoolExternalId: "s2" });
  assert.equal(oneroster.normalizeStudent({ sourcedId: "u3", status: "tobedeleted", givenName: "X" }).skipped, true);
  assert.equal(oneroster.normalizeStudent({ sourcedId: "u4", givenName: "X" }).rejected.reason, "no_school");
  assert.equal(oneroster.normalizeStudent({ sourcedId: "u5", orgs: [{ sourcedId: "s1" }] }).rejected.reason, "missing_name");
});

test("Ed-Fi grades, current school and students", () => {
  assert.equal(edfi.gradeOf("uri://ed-fi.org/GradeLevelDescriptor#Third grade"), "3");
  assert.equal(edfi.gradeOf("uri://ed-fi.org/GradeLevelDescriptor#Kindergarten"), "K");
  assert.equal(edfi.gradeOf("uri://ed-fi.org/GradeLevelDescriptor#Twelfth grade"), "12");
  const cur = edfi.currentSchools([
    { studentReference: { studentUniqueId: "A" }, schoolReference: { schoolId: 1 }, entryDate: "2025-08-20", exitWithdrawDate: "2026-06-01" },
    { studentReference: { studentUniqueId: "A" }, schoolReference: { schoolId: 2 }, entryDate: "2026-08-20" },
    { studentReference: { studentUniqueId: "B" }, schoolReference: { schoolId: 1 }, entryDate: "2026-08-20", exitWithdrawDate: "2026-09-01" }]);
  assert.equal(cur.get("A").schoolReference.schoolId, 2);
  assert.equal(cur.has("B"), false, "withdrawn students have no current school");
  assert.equal(edfi.normalizeStudent({ studentUniqueId: "B", firstName: "B" }, undefined).skipped, true);
  assert.equal(edfi.normalizeStudent({ studentUniqueId: "A", firstName: "Al", lastSurname: "A" }, cur.get("A")).student.schoolExternalId, "2");
});

test("the plan imports mapped schools only and never moves a student between EduOS schools", () => {
  const roster = { schools: [{ externalId: "o1", name: "Maple" }, { externalId: "o2", name: "Oak" }], rejected: [{ externalId: "bad", reason: "no_school" }],
    students: [
      { externalId: "a", localStudentNumber: "1", displayName: "A", gradeLevel: "3", schoolExternalId: "o1" },
      { externalId: "b", localStudentNumber: "1", displayName: "B", gradeLevel: "3", schoolExternalId: "o1" },
      { externalId: "c", localStudentNumber: "2", displayName: "C", gradeLevel: "4", schoolExternalId: "o1" },
      { externalId: "d", localStudentNumber: "3", displayName: "D", gradeLevel: "5", schoolExternalId: "o2" }] };
  const p = planImport(roster, new Map([["o1", "S-MAPLE"]]), new Map([["2", "S-ELSEWHERE"]]), [{ id: "S-OAK", name: "oak" }]);
  assert.deepEqual([...p.bySchool.get("S-MAPLE")].map(s => s.localStudentNumber), ["1"]);
  assert.deepEqual(p.rejected.map(r => r.reason).sort(), ["duplicate_student_number", "enrolled_at_another_eduos_school", "no_school"]);
  assert.equal(p.counts.notMapped, 1);
  assert.equal(p.externalSchools.find(s => s.externalId === "o2").suggestedSchoolId, "S-OAK", "suggested by name");
});

test("client secrets are encrypted and bound to their connector", () => {
  const enc = encryptSecret(KEY, "d1", "c1", "s3cret");
  assert.ok(!enc.includes("s3cret"));
  assert.equal(decryptSecret(KEY, "d1", "c1", enc), "s3cret");
  assert.throws(() => decryptSecret(KEY, "d1", "c2", enc), "copied to another connector");
  assert.throws(() => decryptSecret("x".repeat(40), "d1", "c1", enc), "another key");
});
