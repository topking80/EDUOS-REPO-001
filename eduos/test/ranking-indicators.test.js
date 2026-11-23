// RANK-01: the six indicators' own fields, checked; weights as published.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INDICATORS, cleanValues, display, validYear } from "../src/ranking-indicators.js";

test("the six weights add up to 100", () => {
  assert.equal(Object.keys(INDICATORS).length, 6);
  assert.equal(Object.values(INDICATORS).reduce((a, d) => a + d.weight, 0), 100);
  assert.deepEqual(Object.fromEntries(Object.entries(INDICATORS).map(([k, d]) => [k, d.weight])),
    { college_readiness: 30, curriculum_breadth: 10, assessment_proficiency: 20, assessment_performance: 20, underserved_performance: 10, graduation_rate: 10 });
});

test("values are checked and only the indicator's fields are kept", () => {
  assert.deepEqual(cleanValues("college_readiness", { seniors: 200, tookExam: 120, qualified: 90, extra: "x" }), { seniors: 200, tookExam: 120, qualified: 90 });
  assert.deepEqual(display("college_readiness", { seniors: 200, tookExam: 120, qualified: 90 }), { "Took an exam": 60, "Qualifying score": 45 });
  assert.equal(cleanValues("college_readiness", { seniors: 200, tookExam: 120, qualified: 130 }), null, "can't qualify more than took");
  assert.equal(cleanValues("college_readiness", { seniors: 0, tookExam: 0, qualified: 0 }), null);
  assert.deepEqual(cleanValues("assessment_proficiency", { math: 61.5, reading: 70 }), { math: 61.5, reading: 70, science: null });
  assert.equal(cleanValues("assessment_proficiency", { math: 101, reading: 70 }), null);
  assert.deepEqual(display("underserved_performance", { underserved: 48.2, stateOthers: 63 }), { "Underserved here": 48.2, "Others statewide": 63, Gap: -14.8 });
  assert.equal(cleanValues("published_rank", {}), null);
  assert.equal(cleanValues("nope", {}), null);
});

test("data years look like 2025-26", () => {
  assert.ok(validYear("2025-26")); assert.ok(validYear("1999-00"));
  for (const y of ["2025-27", "2025", "25-26", "2025-2026"]) assert.equal(validYear(y), false, y);
});
