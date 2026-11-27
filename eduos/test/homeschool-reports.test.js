// HSP-02: homeschool progress reports, transcripts and portfolios.
import test from "node:test";
import assert from "node:assert/strict";
import { attendanceTotals, percentOf, buildProgressReport, buildTranscript, buildPortfolio, sha256Of, ISSUER_STATEMENT } from "../src/homeschool-reports.js";

const base = { id: "x1", family: { display_name: "Ortiz Homeschool" }, learner: { display_name: "Mia", grade_band: "9" }, generatedOn: "2026-11-27", generatedBy: "Ana Ortiz" };
const courses = [{ id: "c1", title: "Algebra I", subject: "Math", school_year: "2026-2027", status: "active" },
  { id: "c2", title: "Biology", subject: "Science", school_year: "2025-2026", status: "completed", final_grade: "A", credits: "1.00", completed_on: "2026-06-01" },
  { id: "c3", title: "Old", school_year: "2024-2025", status: "archived" }];
const work = [{ course_id: "c1", title: "Test", kind: "test", done_on: "2026-11-20", score: "18", max_score: "20", provenance: "parent_entered" },
  { course_id: "c1", title: "Dup", kind: "assignment", done_on: "2026-11-21", score: "0", max_score: "10", provenance: "parent_entered", voided_at: "2026-11-22" },
  { course_id: null, title: "Certificate", kind: "certificate", done_on: "2026-10-01", provenance: "external", source: "Khan Academy" }];

test("attendance counts instructional days and minutes, ignoring voided sessions", () => {
  const t = attendanceTotals([{ day: "2026-11-20", minutes: 240, kind: "instruction" }, { day: "2026-11-20", minutes: 60, kind: "co_op" },
    { day: "2026-11-21", minutes: 0, kind: "absent" }, { day: "2026-11-22", minutes: 600, kind: "instruction", voided_at: "x" }]);
  assert.deepEqual([t.instructionalDays, t.absentDays, t.minutes, t.hours], [1, 1, 300, 5]);
});

test("percent sums scores over maximums and skips voided work", () => {
  assert.equal(percentOf(work), 90);
  assert.equal(percentOf([]), null);
});

test("every document names its issuer and says what it isn't", () => {
  for (const doc of [buildProgressReport({ ...base, courses, goals: [], attendance: [], work, from: "2026-11-01", to: "2026-11-30" }), buildTranscript({ ...base, courses, goals: [], attendance: [], work }),
    buildPortfolio({ ...base, courses, goals: [], attendance: [], work })]) {
    assert.equal(doc.issuer.name, "Ortiz Homeschool"); assert.equal(doc.issuer.statement, ISSUER_STATEMENT);
    assert.match(sha256Of(doc), /^[0-9a-f]{64}$/);
  }
  assert.match(ISSUER_STATEMENT, /not an official, state-approved or accredited transcript/);
});

test("the transcript lists completed courses by year; the report excludes archived ones; the portfolio shows provenance", () => {
  const t = buildTranscript({ ...base, courses, goals: [], attendance: [], work });
  assert.deepEqual(t.years, [{ school_year: "2025-2026", courses: [{ title: "Biology", subject: "Science", final_grade: "A", credits: 1, completed_on: "2026-06-01" }] }]);
  assert.equal(t.total_credits, 1);
  const r = buildProgressReport({ ...base, courses, goals: [], attendance: [], work, from: "2026-11-01", to: "2026-11-30" });
  assert.deepEqual(r.courses.map(c => [c.title, c.work_items, c.percent]), [["Algebra I", 1, 90], ["Biology", 0, null]]);
  const p = buildPortfolio({ ...base, courses, goals: [], attendance: [], work });
  assert.deepEqual(p.items.map(i => [i.title, i.provenance]), [["Certificate", "Entered by the family from Khan Academy"], ["Test", "Entered by the family"]]);
  assert.equal(sha256Of(p), sha256Of(structuredClone(p)), "stable");
});
