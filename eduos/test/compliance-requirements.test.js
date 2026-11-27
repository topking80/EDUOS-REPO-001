// HSP-06 part 2: compliance requirement and template checks (no database).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateRequirements, schoolYearRange, deadlineDate, currentSchoolYear, DISCLAIMER } from "../src/compliance-requirements.js";
import { checkTemplate } from "../src/compliance-template.js";

const example = () => JSON.parse(fs.readFileSync(new URL("../docs/compliance-templates/EXAMPLE-not-a-real-requirement.json", import.meta.url)));

test("requirements: the documented shape passes; bad shapes say what's wrong", () => {
  assert.deepEqual(validateRequirements(example().requirements), { ok: true });
  assert.deepEqual(validateRequirements({}), { ok: true });
  for (const [r, msg] of [[[], /object/], [{ extra: 1 }, /unknown field/], [{ instruction: { days: 0 } }, /days/], [{ instruction: { hours: 5000 } }, /hours/],
    [{ deadlines: [{ key: "a b", label: "x", month: 1, day: 1 }] }, /key/], [{ deadlines: [{ key: "x1", label: "x", month: 2, day: 31 }] }, /month and day/],
    [{ documents: [{ key: "dup", label: "x" }], assessments: [{ key: "dup", label: "y" }] }, /duplicate/], [{ assessments: [{ key: "t1", label: "x", grades: ["13"] }] }, /grades/],
    [{ retentionYears: 0 }, /retentionYears/]]) assert.match(validateRequirements(r).error, msg);
});

test("school years and deadlines", () => {
  assert.deepEqual(schoolYearRange("2026-2027"), { from: "2026-07-01", to: "2027-06-30" });
  assert.equal(deadlineDate("2026-2027", 8, 15), "2026-08-15");
  assert.equal(deadlineDate("2026-2027", 3, 1), "2027-03-01");
  assert.equal(currentSchoolYear(new Date("2026-11-27T12:00:00Z")), "2026-2027");
  assert.equal(currentSchoolYear(new Date("2027-03-01T12:00:00Z")), "2026-2027");
  assert.match(DISCLAIMER, /not legal advice/);
});

test("templates need sources, an authority, a recent review and a reviewer", () => {
  assert.deepEqual(checkTemplate(example(), "2026-11-27"), []);
  const t = example();
  delete t.sources; t.reviewedBy = ""; t.lastReviewedOn = "2024-01-01"; t.authority.url = "http://example.org";
  const errs = checkTemplate(t, "2026-11-27").join(" | ");
  for (const m of [/sources/, /authority/, /more than 18 months/, /reviewedBy/]) assert.match(errs, m);
  assert.match(checkTemplate({ ...example(), lastReviewedOn: "2027-01-01" }, "2026-11-27").join(), /not in the future/);
});
