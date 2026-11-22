import test from "node:test";
import assert from "node:assert/strict";
import { nextLink, normalizeCanvas, fetchRoster, REQUIRED_SCOPES } from "../src/integrations/canvas.js";

const O = "https://district.instructure.com";

test("pagination follows Canvas Link headers only on the same origin and API", () => {
  const h = `<${O}/api/v1/courses/1/enrollments?page=1>; rel="current", <${O}/api/v1/courses/1/enrollments?page=2&per_page=100>; rel="next", <${O}/x>; rel="last"`;
  assert.equal(nextLink(h, O), `${O}/api/v1/courses/1/enrollments?page=2&per_page=100`);
  assert.equal(nextLink(`<https://evil.example/api/v1/x?page=2>; rel="next"`, O), null, "another host");
  assert.equal(nextLink(`<${O}/login/oauth2/token>; rel="next"`, O), null, "outside the API");
  assert.equal(nextLink(`<https://u:p@district.instructure.com/api/v1/x>; rel="next"`, O), null);
  assert.equal(nextLink(`<${O}/api/v1/x?page=9>; rel="last"`, O), null, "no next page");
  assert.equal(nextLink(undefined, O), null);
});

test("courses and enrollments become roster shapes; students only by SIS ID", () => {
  const courses = new Map([["10", [
    { id: "100", name: "Algebra I", workflow_state: "available" },
    { id: "101", name: "Old course", workflow_state: "completed" },
    { id: "javascript:1", name: "bad id" }
  ]], ["11", [{ id: "100", name: "Algebra I (also under a mapped sub-account)" }]]]);
  const enrollments = new Map([["100", [
    { type: "TeacherEnrollment", user_id: "7", enrollment_state: "active", user: { name: "Ms Rivera", login_id: "Rivera@District.org" } },
    { type: "TeacherEnrollment", user_id: "8", user: { name: "No email", login_id: "rivera2" } },
    { type: "StudentEnrollment", user_id: "20", user: { name: "Ana", sis_user_id: "S-1001" } },
    { type: "StudentEnrollment", user_id: "21", user: { name: "No SIS id" } },
    { type: "StudentEnrollment", user_id: "22", enrollment_state: "inactive", user: { sis_user_id: "S-1002" } },
    { type: "ObserverEnrollment", user_id: "30", user: { sis_user_id: "P-1" } },
    { type: "TaEnrollment", user_id: "31", user: { login_id: "ta@district.org" } }
  ]], ["101", [{ type: "StudentEnrollment", user_id: "23", user: { sis_user_id: "S-9" } }]]]);
  const { roster, classes } = normalizeCanvas(courses, enrollments);
  assert.deepEqual(classes.sections, [{ externalId: "100", title: "Algebra I", schoolExternalId: "10" }], "available courses only, once, under the first mapped account");
  assert.deepEqual(classes.staff, [
    { externalId: "7", email: "rivera@district.org", displayName: "Ms Rivera" },
    { externalId: "8", email: null, displayName: "No email" }]);
  assert.deepEqual(roster.students, [{ externalId: "20", localStudentNumber: "S-1001" }]);
  assert.deepEqual(roster.rejected, [{ externalId: "21", reason: "no_sis_user_id" }]);
  assert.deepEqual(classes.enrollments.map(e => `${e.sectionExternalId}:${e.userExternalId}:${e.role}`), ["100:7:teacher", "100:8:teacher", "100:20:student"],
    "observers (parents), TAs, inactive enrollments and closed courses are ignored");
  assert.deepEqual(roster.schools, [], "Canvas never supplies schools or students to import");
});

test("Canvas is never a student source, and only read scopes are documented", async () => {
  await assert.rejects(() => fetchRoster(), { code: "canvas_is_not_a_student_source" });
  assert.ok(REQUIRED_SCOPES.every(s => s.startsWith("url:GET|/api/v1/")));
});
