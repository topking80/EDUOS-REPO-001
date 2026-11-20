// PowerSchool roster normalization and paging contract tests; no live SIS.
import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import * as powerschool from "../src/integrations/powerschool.js";

test("PowerSchool school IDs are stable numeric DCIDs and names are bounded", () => {
  assert.deepEqual(powerschool.normalizeSchool({ id: 12, name: "North High" }), {
    school: { externalId: "12", name: "North High" },
  });
  assert.equal(powerschool.normalizeSchool({ id: "not-a-dcid" }).rejected.reason, "invalid_school_id");
  assert.equal(powerschool.normalizeSchool({ id: 2, name: "N".repeat(200) }).school.name.length, 160);
});

test("PowerSchool fetches student data only for district-mapped schools", () => {
  assert.equal(powerschool.isMappedSchool("12", ["12", "14"]), true);
  assert.equal(powerschool.isMappedSchool("13", ["12", "14"]), false);
  assert.equal(powerschool.isMappedSchool("12", []), false);
});

test("PowerSchool student requests server-filter active enrollments and expand status", () => {
  const url = new URL(powerschool.studentRosterUrl("https://district.example.org/", "12"));
  assert.equal(url.pathname, "/ws/v1/school/12/student");
  assert.equal(url.searchParams.get("q"), "school_enrollment.enroll_status==(A)");
  assert.equal(url.searchParams.get("expansions"), "school_enrollment");
});

test("PowerSchool student normalization maps active roster fields only", () => {
  assert.deepEqual(powerschool.normalizeStudent({
    id: 987, student_number: "00421", first_name: "Ada", last_name: "Lovelace",
    grade_level: 11, enroll_status: 0,
  }, "12").student, {
    externalId: "987", localStudentNumber: "00421", displayName: "Ada Lovelace",
    gradeLevel: "11", schoolExternalId: "12",
  });
  assert.equal(powerschool.normalizeStudent({ id: 1, student_number: "1", first_name: "A", enroll_status: -1 }, "12").skipped, true);
  assert.equal(powerschool.normalizeStudent({ id: 5, student_number: "5", first_name: "A", school_enrollment: { enroll_status: "W" } }, "12").skipped, true);
  assert.ok(powerschool.normalizeStudent({ id: 6, student_number: "6", first_name: "A", school_enrollment: { enroll_status: "A" } }, "12").student);
  assert.ok(powerschool.normalizeStudent({ id: 8, student_number: "8", first_name: "A", school_enrollment: { enroll_status_code: 0 } }, "12").student);
  assert.equal(powerschool.normalizeStudent({ id: 2, student_number: "2", enroll_status: "A" }, "12").rejected.reason, "missing_name");
  assert.equal(powerschool.normalizeStudent({ id: 3, first_name: "A", enroll_status: "A" }, "12").rejected.reason, "missing_student_number");
  assert.equal(powerschool.normalizeStudent({ id: 7, student_number: "7", first_name: "A" }, "12").rejected.reason, "missing_enrollment_status");
  assert.equal(powerschool.normalizeStudent({ student_number: "4", first_name: "A" }, "12").rejected.reason, "missing_student_id");
});

test("PowerSchool aggregate record ceiling includes records from every mapped school", async () => {
  const studentRequests = [];
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/oauth/access_token")) {
      res.end(JSON.stringify({ access_token: "test-token" }));
    } else if (req.url.startsWith("/ws/v1/district/school")) {
      res.end(JSON.stringify({ schools: { school: [{ id: 12, name: "North" }, { id: 13, name: "South" }] } }));
    } else if (req.url.includes("/student?")) {
      studentRequests.push(req.url);
      res.end(JSON.stringify({ students: { student: [{
        id: studentRequests.length, student_number: String(studentRequests.length),
        first_name: "Student", enroll_status: "A",
      }] } }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(powerschool.fetchRoster({
      baseUrl, tokenUrl: `${baseUrl}/oauth/access_token`, clientId: "client",
      clientSecret: "secret", mappedSchoolIds: ["12", "13"], maxStudentRecords: 1,
      options: { allowInsecureLoopback: true },
    }), error => error.code === "connector_too_many_records");
    assert.equal(studentRequests.length, 1, "the second school's student endpoint is not fetched after the aggregate ceiling");
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("PowerSchool nested name fields and missing grade normalize safely", () => {
  assert.deepEqual(powerschool.normalizeStudent({
    id: "44", student_number: 44, name: { first_name: "Grace", last_name: "Hopper" }, enroll_status: "A",
  }, "9").student, {
    externalId: "44", localStudentNumber: "44", displayName: "Grace Hopper",
    gradeLevel: null, schoolExternalId: "9",
  });
});
