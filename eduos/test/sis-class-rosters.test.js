// SIS-04 class rosters: each connector's normalizer and the shared planner.
import test from "node:test";
import assert from "node:assert/strict";
import * as oneroster from "../src/integrations/oneroster.js";
import * as edfi from "../src/integrations/edfi.js";
import * as powerschool from "../src/integrations/powerschool.js";
import { planRosters, applyRosters } from "../src/integrations/sync.js";

test("OneRoster: active classes, teachers and student/teacher enrollments only", () => {
  const out = oneroster.normalizeClasses({
    classes: [{ sourcedId: "c1", title: "Math 3", school: { sourcedId: "or-s1" } }, { sourcedId: "c2", status: "tobedeleted", school: { sourcedId: "or-s1" } },
      { sourcedId: "c3", title: "No school" }],
    teachers: [{ sourcedId: "t1", givenName: "Tia", familyName: "T", email: " Tia@School.Org " }, { sourcedId: "t2", email: "not-an-email" }],
    enrollments: [{ sourcedId: "e1", role: "teacher", user: { sourcedId: "t1" }, class: { sourcedId: "c1" } },
      { sourcedId: "e2", role: "student", user: { sourcedId: "u-alice" }, class: { sourcedId: "c1" } },
      { sourcedId: "e3", role: "aide", user: { sourcedId: "x" }, class: { sourcedId: "c1" } },
      { sourcedId: "e4", role: "student", status: "tobedeleted", user: { sourcedId: "u-gone" }, class: { sourcedId: "c1" } }]
  });
  assert.deepEqual(out.sections, [{ externalId: "c1", title: "Math 3", schoolExternalId: "or-s1" }]);
  assert.deepEqual(out.staff.map(t => [t.externalId, t.email]), [["t1", "tia@school.org"], ["t2", null]]);
  assert.deepEqual(out.enrollments.map(e => [e.userExternalId, e.role]), [["t1", "teacher"], ["u-alice", "student"]]);
});

test("Ed-Fi: sections keyed by their natural key; ended associations skipped; work email preferred", () => {
  const ref = { schoolId: 255901, localCourseCode: "MATH3", schoolYear: 2027, sessionName: "Fall", sectionIdentifier: "S1" };
  const out = edfi.normalizeClasses({
    sections: [{ sectionIdentifier: "S1", sectionName: "Math 3 (1)", courseOfferingReference: { schoolId: 255901, localCourseCode: "MATH3", schoolYear: 2027, sessionName: "Fall" } }],
    staffs: [{ staffUniqueId: "ST-1", firstName: "Tia", lastSurname: "T", electronicMails: [{ electronicMailAddress: "home@x.org", electronicMailTypeDescriptor: "uri://ed-fi.org/ElectronicMailTypeDescriptor#Home/Personal" },
      { electronicMailAddress: "Tia@School.org", electronicMailTypeDescriptor: "uri://ed-fi.org/ElectronicMailTypeDescriptor#Work" }] }],
    staffSections: [{ staffReference: { staffUniqueId: "ST-1" }, sectionReference: ref }],
    studentSections: [{ studentReference: { studentUniqueId: "E-100" }, sectionReference: ref },
      { studentReference: { studentUniqueId: "E-101" }, sectionReference: ref, endDate: "2026-01-01" }]
  }, "2026-11-21");
  assert.equal(out.sections[0].externalId, "255901|MATH3|2027|Fall|S1");
  assert.equal(out.staff[0].email, "tia@school.org");
  assert.deepEqual(out.enrollments.map(e => [e.userExternalId, e.role]), [["ST-1", "teacher"], ["E-100", "student"]]);
});

test("PowerSchool: lead teacher from the section; dropped and exited students skipped", () => {
  const out = powerschool.normalizeClasses({ schoolExternalId: "12",
    sections: [{ id: 501, course_name: "Math 3", section_number: "2", staff_id: 77 }],
    staffs: [{ id: 77, name: { first_name: "Tia", last_name: "T" }, emails: { work_email: "tia@school.org" } }],
    enrollmentsBySection: new Map([["501", [{ student_id: 9001 }, { student_id: 9002, dropped: true }, { student_id: 9003, exit_date: "2026-01-01" }]]]) }, "2026-11-21");
  assert.deepEqual(out.sections, [{ externalId: "501", schoolExternalId: "12", title: "Math 3 2" }]);
  assert.deepEqual(out.staff, [{ externalId: "77", email: "tia@school.org", displayName: "Tia T" }]);
  assert.deepEqual(out.enrollments.map(e => [e.userExternalId, e.role]), [["77", "teacher"], ["9001", "student"]]);
});

// A planner fixture: school A is mapped, school Z isn't.
const A = "school-a", B = "school-b";
const classes = (extra = {}) => ({
  sections: [{ externalId: "sec1", schoolExternalId: "ext-a", title: "Math" }, { externalId: "sec2", schoolExternalId: "ext-z", title: "Elsewhere" }],
  staff: [{ externalId: "t1", email: "tia@x.org", displayName: "Tia" }, { externalId: "t2", email: "dup@x.org", displayName: "Dup" },
    { externalId: "t3", email: null, displayName: "No Email" }, { externalId: "t4", email: "tom@x.org", displayName: "Tom" }],
  enrollments: [
    { sectionExternalId: "sec1", userExternalId: "t1", role: "teacher" }, { sectionExternalId: "sec1", userExternalId: "t2", role: "teacher" },
    { sectionExternalId: "sec1", userExternalId: "t3", role: "teacher" }, { sectionExternalId: "sec1", userExternalId: "t4", role: "teacher" },
    { sectionExternalId: "sec1", userExternalId: "s-alice", role: "student" }, { sectionExternalId: "sec1", userExternalId: "s-bob", role: "student" },
    { sectionExternalId: "sec1", userExternalId: "s-carol", role: "student" }, { sectionExternalId: "sec1", userExternalId: "s-ghost", role: "student" },
    { sectionExternalId: "sec2", userExternalId: "t1", role: "teacher" }, { sectionExternalId: "sec2", userExternalId: "s-alice", role: "student" }],
  ...extra
});
const roster = { students: [{ externalId: "s-alice", localStudentNumber: "N-A" }, { externalId: "s-bob", localStudentNumber: "N-B" }, { externalId: "s-carol", localStudentNumber: "N-C" }] };
const inputs = (over = {}) => ({
  map: new Map([["ext-a", A]]),
  students: new Map([["N-A", { id: "alice", schoolId: A }], ["N-B", { id: "bob", schoolId: A }], ["N-C", { id: "carol", schoolId: B }]]),
  teachersByEmail: new Map([["tia@x.org", [{ userId: "tia", schoolId: A }]], ["dup@x.org", [{ userId: "d1", schoolId: A }, { userId: "d2", schoolId: A }]],
    ["tom@x.org", [{ userId: "tom", schoolId: B }]]]),
  teachersAtSchool: new Set(["tia|" + A, "d1|" + A, "d2|" + A, "tom|" + B, "manual-t|" + A]),
  staffMap: new Map(), synced: [], manual: new Set(), ...over
});
const pairs = list => list.map(r => `${r.teacherUserId}|${r.studentId}`).sort();

test("planner: a teacher matches one active teacher at that school by email; students must be at the same school", () => {
  const p = planRosters(classes(), roster, inputs());
  assert.deepEqual(pairs(p.add), ["tia|alice", "tia|bob"]);
  assert.deepEqual(Object.fromEntries(p.unmatchedTeachers.map(t => [t.externalId, t.reason])),
    { t2: "ambiguous_email", t3: "no_email", t4: "no_matching_eduos_teacher" }, "Tom teaches at another school");
  assert.deepEqual(Object.fromEntries(p.rejected.map(r => [r.externalId, r.reason])), { "s-carol": "student_at_another_eduos_school", "s-ghost": "student_not_imported" });
  assert.equal(p.counts.sectionsNotMapped, 1, "the unmapped school's section is ignored");
});

test("planner: a manual match wins, but only for a teacher at that school", () => {
  assert.deepEqual(pairs(planRosters(classes(), roster, inputs({ staffMap: new Map([["t3", "manual-t"]]) })).add), ["manual-t|alice", "manual-t|bob", "tia|alice", "tia|bob"]);
  const wrong = planRosters(classes(), roster, inputs({ staffMap: new Map([["t1", "tom"]]) }));
  assert.equal(wrong.unmatchedTeachers.find(t => t.externalId === "t1").reason, "matched_teacher_not_at_school");
});

test("planner: hand-entered rosters are never taken over or removed; only this connector's rows at mapped schools are removed", () => {
  const p = planRosters(classes(), roster, inputs({
    manual: new Set(["tia|alice"]),
    synced: [{ teacherUserId: "tia", studentId: "bob", schoolId: A }, { teacherUserId: "old", studentId: "bob", schoolId: A },
      { teacherUserId: "old", studentId: "zed", schoolId: "school-z-unmapped-now" }]
  }));
  assert.deepEqual(pairs(p.add), [], "tia|alice exists by hand; tia|bob already synced");
  assert.deepEqual(pairs(p.keep), ["tia|bob"]);
  assert.deepEqual(pairs(p.remove), ["old|bob"], "a row at a school that's no longer mapped is left alone");
  assert.equal(p.counts.keptManual, 1);
});

test("applying refuses to remove every synced link when the SIS returns no enrollments", async () => {
  const p = planRosters({ sections: [], staff: [], enrollments: [] }, roster, inputs({ synced: [{ teacherUserId: "tia", studentId: "bob", schoolId: A }] }));
  const client = { query: async () => assert.fail("nothing is written") };
  await assert.rejects(applyRosters(client, "d", "c", p), e => e.code === "SYNC_ROSTER_EMPTY");
});
