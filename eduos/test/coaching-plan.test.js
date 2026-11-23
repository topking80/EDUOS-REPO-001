// COACH-02: practice plans and playbooks (src/coaching-plan.js) and merging co-written ones (src/draft-merge.js).
import test from "node:test";
import assert from "node:assert/strict";
import { cleanPlanBody, missingForPlan, planMinutes } from "../src/coaching-plan.js";
import { mergeDraft, cleanDraftBody, missingForCourse } from "../src/draft-merge.js";

const D = (o = {}) => ({ kind: "drill", title: "Rondo", minutes: 10, description: "5 v 2 keep-away", equipment: "8 cones", ...o });

test("plans are checked and normalised", () => {
  const p = cleanPlanBody({ summary: "Possession day", items: [D(), { kind: "note", title: "Water break", minutes: "2" }] });
  assert.deepEqual(p.items[1], { kind: "note", title: "Water break", minutes: 2, description: "", equipment: "" });
  assert.equal(planMinutes(p), 12);
  assert.equal(cleanPlanBody({ items: [D({ kind: "scrimmage" })] }), null);
  assert.equal(cleanPlanBody({ items: [D({ minutes: 500 })] }), null);
  assert.equal(cleanPlanBody({ items: Array.from({ length: 41 }, () => D()) }), null);
  assert.deepEqual(missingForPlan("", { items: [D({ title: "" })] }), ["title", "items[0].title"]);
});

test("co-written plans merge drill by drill", () => {
  const base = cleanDraftBody("practice", { title: "Tue", sport: "Soccer", summary: null, items: [D(), D({ title: "Shooting" })] });
  const mine = { ...base, items: [D({ minutes: 15 }), base.items[1]] };
  const theirs = { ...base, summary: "Finish with shots", items: [base.items[0], D({ title: "Shooting", equipment: "10 balls" })] };
  const m = mergeDraft("practice", base, mine, theirs);
  assert.deepEqual(m.conflicts, []);
  assert.deepEqual([m.body.summary, m.body.items[0].minutes, m.body.items[1].equipment], ["Finish with shots", 15, "10 balls"]);
  assert.deepEqual(mergeDraft("practice", base, { ...base, items: [D({ minutes: 1 }), base.items[1]] }, { ...base, items: [D({ minutes: 2 }), base.items[1]] }).conflicts, ["items[0].minutes"]);
  assert.deepEqual(missingForCourse("practice", { ...base, sport: "" }), ["sport"]);
});
