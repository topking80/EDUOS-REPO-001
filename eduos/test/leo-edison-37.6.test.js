// 37.6.0 Leo (lesson drafts) and Edison (gate-released trends): pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { USECASES, denial } from "../src/ai/gateway.js";
import { localProvider, externalRequestBody, SYSTEM_PROMPTS } from "../src/ai/providers.js";
import { leoLocalPlan, leoBrief, leoTitleObjective, normalizeLeoInputs, LEO_HEADER } from "../src/ai/leo-template.js";
import { attendanceDay, transportDay, enrollmentTotal, inSchoolShare, schoolDays } from "../src/ai/edison-trends.js";
import { release, buildIdentifierIndex } from "../src/eden/aggregation-gate.js";

const inputs = {
  course: { title: "Grade 3 Fractions", subject: "Math", grade: "3" }, minutes: 45,
  standards: [{ id: "s2", code: "3.NF.A.3", description: "Explain equivalence of fractions." }, { id: "s1", code: "3.NF.A.1", description: "Understand a fraction 1/b." }],
  lessons: [{ id: "l1", title: "Fraction strips", objective: "I can show equivalent fractions." }],
  sources: [{ id: "p1", title: "Kitty Hawk photo", creator: "Orville Wright", createdDate: "1903", archive: "Library of Congress", archiveUrl: "https://www.loc.gov/item/00652085/", description: "The first powered flight." }],
};

test("Leo and Edison are gateway use cases with their own endpoints and roles", () => {
  assert.ok(SYSTEM_PROMPTS.leo_lesson && SYSTEM_PROMPTS.ops_trends);
  assert.equal(USECASES.leo_lesson.endpoint, "/api/leo/drafts");
  assert.equal(USECASES.ops_trends.endpoint, "/api/edison/brief");
  const all = Object.keys(USECASES);
  assert.equal(denial({ usecase: "leo_lesson", role: "teacher", enabled: all }), null);
  assert.equal(denial({ usecase: "leo_lesson", role: "teacher", enabled: ["lesson_draft"] }), "ai_usecase_not_enabled");
  for (const r of ["pupil", "parent", "counselor", "vice_principal"]) assert.equal(denial({ usecase: "leo_lesson", role: r, enabled: all }), "ai_usecase_not_for_your_role", r);
  for (const r of ["teacher", "pupil", "parent", "counselor"]) assert.equal(denial({ usecase: "ops_trends", role: r, enabled: all }), "ai_usecase_not_for_your_role", r);
  assert.equal(denial({ usecase: "ops_trends", role: "vice_principal", enabled: all }), null);
});

test("Leo drafts are deterministic, built from curriculum only, and labelled as drafts", async () => {
  const a = leoLocalPlan(inputs), b = leoLocalPlan({ ...inputs, standards: [...inputs.standards].reverse() });
  assert.equal(a, b, "same inputs, same draft");
  assert.match(a, /3\.NF\.A\.1/); assert.match(a, /Kitty Hawk photo/); assert.match(a, /Fraction strips/);
  assert.match(a, /does not grade, place or predict/);
  const t = leoTitleObjective(inputs);
  assert.ok(t.title.length <= 120 && t.objective.length <= 300);
  assert.match(t.objective, /3\.NF\.A\.1, 3\.NF\.A\.3/);
  assert.throws(() => normalizeLeoInputs({ ...inputs, standards: [] }), /leo_standard_required/);
  assert.equal(normalizeLeoInputs({ ...inputs, minutes: 999 }).minutes, 45);
  assert.equal(await localProvider.generate("leo_lesson", { text: leoBrief(inputs), leo: inputs }), a);
  assert.ok(LEO_HEADER.startsWith("LEO DRAFT"));
  for (const m of [30, 60]) assert.match(leoLocalPlan({ ...inputs, minutes: m }), new RegExp(`${m} minutes`));
});

test("an external model sees Leo's curriculum brief, redacted, never the structured inputs", () => {
  const leo = { ...inputs, lessons: [{ id: "l1", title: "Notes on Alice Example", objective: "Ask Alice Example to read." }] };
  const body = externalRequestBody({ model: "m", usecase: "leo_lesson", input: { text: leoBrief(leo), leo }, identifiers: { names: ["Alice Example"], numbers: [] } });
  assert.equal(body.messages[0].content, SYSTEM_PROMPTS.leo_lesson);
  assert.doesNotMatch(body.messages[1].content, /Alice Example/);
  assert.doesNotMatch(body.messages[1].content, /"id"/);
  assert.match(body.messages[1].content, /3\.NF\.A\.1/);
});

const school = "0b000000-0000-4000-8000-000000000001";
const att = (date, counts) => Object.entries(counts).flatMap(([grade, by]) => Object.entries(by).map(([status, count]) => ({ date, grade, status, count })));

test("Edison reads only gate-released margins and never a withheld count", () => {
  const ids = buildIdentifierIndex({ names: ["Alice Example"], ids: [], numbers: ["S1-A"] });
  const r = release({ kind: "attendance_daily", schoolId: school, period: "2026-11-16",
    cells: att("2026-11-16", { "3": { present: 20, absent: 2, tardy: 3 }, "4": { present: 18, absent: 6 } }) }, { identifiers: ids });
  const d = attendanceDay(r);
  assert.equal(d.total, 49);
  assert.equal(d.counts.present, 38);
  assert.ok(d.suppressed.includes("tardy"), "3 tardy is under K=5: withheld");
  assert.ok(d.suppressed.includes("absent"), "complementary: 8 absent would give away tardy = 49 - 38 - 8");
  assert.equal(d.counts.tardy, undefined); assert.equal(d.counts.absent, undefined);
  // A whole small table is withheld: nothing to compute from.
  const small = attendanceDay(release({ kind: "attendance_daily", schoolId: school, period: "2026-11-16", cells: att("2026-11-16", { "3": { present: 2, absent: 1 } }) }, { identifiers: ids }));
  assert.equal(small.total, null);
  assert.equal(inSchoolShare(small), null);
  // Tardy withheld: a share can't be computed.
  assert.equal(inSchoolShare(d), null);
  const noUnrecorded = attendanceDay(release({ kind: "attendance_daily", schoolId: school, period: "2026-11-17", cells: att("2026-11-17", { "3": { present: 7, absent: 5 } }) }, {}));
  assert.equal(inSchoolShare(noUnrecorded), 7 / 12, "no not_recorded cell is a published zero");
  const full = attendanceDay(release({ kind: "attendance_daily", schoolId: school, period: "2026-11-17",
    cells: att("2026-11-17", { "3": { present: 20, absent: 5, not_recorded: 5 } }) }, { identifiers: ids }));
  assert.equal(inSchoolShare(full), 20 / 25);
});

test("Edison transport and enrollment totals come from released tables", () => {
  const t = transportDay(release({ kind: "transport_checkins_daily", schoolId: school, period: "2026-11-17",
    cells: [{ date: "2026-11-17", route: "Bus 1 AM", event: "boarded", count: 12 }, { date: "2026-11-17", route: "Bus 1 AM", event: "no_checkin", count: 6 }] }, {}));
  assert.equal(t.riders, 18); assert.equal(t.counts.no_checkin, 6);
  assert.equal(enrollmentTotal(release({ kind: "enrollment_by_grade", schoolId: school, period: "current", cells: [{ grade: "3", count: 30 }, { grade: "4", count: 2 }] }, {})), 32);
  assert.equal(enrollmentTotal(release({ kind: "enrollment_by_grade", schoolId: school, period: "current", cells: [{ grade: "3", count: 3 }] }, {})), null);
});

test("Edison's brief uses labels and published numbers only", async () => {
  const day = (date, present, absent) => attendanceDay(release({ kind: "attendance_daily", schoolId: school, period: date,
    cells: att(date, { "3": { present, absent, not_recorded: 5 } }) }, {}));
  const ctx = { scope: "school", days: 4, k: 5, withheld: 0, schools: [{ label: "School 1", today: "2026-11-17",
    attendance: [day("2026-11-12", 40, 5), day("2026-11-13", 40, 5), day("2026-11-16", 30, 15), day("2026-11-17", 30, 15)], transport: null, enrolled: 50 }] };
  const text = await localProvider.generate("ops_trends", { context: ctx });
  assert.match(text, /School 1/); assert.match(text, /declining/); assert.match(text, /never estimates/);
  const body = externalRequestBody({ model: "m", usecase: "ops_trends", input: { context: ctx } });
  assert.deepEqual(JSON.parse(body.messages[1].content), ctx);
});

test("school days skip weekends and end today", () => {
  assert.deepEqual(schoolDays("2026-11-17", 3), ["2026-11-13", "2026-11-16", "2026-11-17"]);
  assert.deepEqual(schoolDays("2026-11-15", 1), ["2026-11-13"]);
});
