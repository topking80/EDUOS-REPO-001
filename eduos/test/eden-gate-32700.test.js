// 32.7.0 aggregation gate: tests that TRY to leak student-level data upward.
import test from "node:test";
import assert from "node:assert/strict";
import { release, verifyReleased, releaseConsented, buildIdentifierIndex, recoverableCells, K_MIN, GateError } from "../src/eden/aggregation-gate.js";

const SCHOOL = "00000000-0000-4000-8000-000000000101";
const STUDENT = "00000000-0000-4000-8000-000000000301";
const ids = buildIdentifierIndex({ ids: [STUDENT], numbers: ["RES-1001"], names: ["Ava Morgan", "Alex Morgan"] });
const att = (grade, status, count, date = "2026-11-10") => ({ date, grade, status, count });
const rel = (kind, cells, extra = {}) => release({ kind, schoolId: SCHOOL, period: "2026-11-10", cells, ...extra }, { identifiers: ids });
const code = fn => { try { fn(); return "no error"; } catch (e) { assert.ok(e instanceof GateError, e.message); return e.code; } };
const published = p => p.cells.filter(c => c.count !== null);
const find = (p, q) => p.cells.find(c => Object.entries(q).every(([k, v]) => c[k] === v));

test("minimum cell size is 5 and cannot be lowered", () => {
  assert.equal(K_MIN, 5);
  assert.equal(code(() => release({ kind: "enrollment_by_grade", schoolId: SCHOOL, period: "p", cells: [] }, { k: 3 })), "k_below_minimum");
});

test("counts 1-4 are never published; 0 and >=5 are", () => {
  const p = rel("enrollment_by_grade", [{ grade: "3", count: 12 }, { grade: "4", count: 3 }, { grade: "5", count: 9 }, { grade: "K", count: 0 }]);
  for (const c of published(p)) assert.ok(c.count === 0 || c.count >= 5, JSON.stringify(c));
  assert.equal(find(p, { grade: "4" }).count, null);
  assert.equal(find(p, { grade: "4" }).suppressed, "small_cell");
});

test("complementary suppression: a single small cell cannot be recovered from the total", () => {
  const p = rel("enrollment_by_grade", [{ grade: "3", count: 12 }, { grade: "4", count: 3 }, { grade: "5", count: 9 }]);
  const total = find(p, { grade: "ALL" });
  const g3 = find(p, { grade: "3" }), g5 = find(p, { grade: "5" });
  // Subtraction attack: total - published grades.
  const hidden = [g3, g5, total].filter(c => c.count === null);
  assert.ok(hidden.length >= 1, "a second cell (or the total) must be suppressed");
  if (total.count !== null) assert.ok(g3.count === null || g5.count === null);
});

test("2-D table: no suppressed cell is solvable from rows, columns and margins", () => {
  const cells = [
    att("3", "present", 18), att("3", "absent", 2), att("3", "tardy", 6),
    att("4", "present", 21), att("4", "absent", 7), att("4", "tardy", 1),
    att("5", "present", 15), att("5", "absent", 5), att("5", "tardy", 5)
  ];
  const p = rel("attendance_daily", cells);
  for (const c of published(p)) assert.ok(c.count === 0 || c.count >= 5);
  // Brute-force subtraction attacker: try every row/column equation.
  const val = q => find(p, q)?.count;
  for (const g of ["3", "4", "5", "ALL"]) {
    const parts = ["present", "absent", "tardy"].map(s => val({ grade: g, status: s }));
    const total = val({ grade: g, status: "ALL" });
    assert.ok(!(total !== null && parts.filter(x => x === null).length === 1), `row ${g} leaks by subtraction`);
  }
  for (const s of ["present", "absent", "tardy", "ALL"]) {
    const parts = ["3", "4", "5"].map(g => val({ grade: g, status: s }));
    const total = val({ grade: "ALL", status: s });
    assert.ok(!(total !== null && parts.filter(x => x === null).length === 1), `column ${s} leaks by subtraction`);
  }
  assert.doesNotThrow(() => verifyReleased(p, { identifiers: ids }));
});

test("a group smaller than 5 is suppressed whole, zeros included", () => {
  // Grade 1 has 3 learners, all present: "0 absent" would reveal each one.
  const p = rel("attendance_daily", [att("1", "present", 3), att("1", "absent", 0), att("4", "present", 20), att("4", "absent", 6)]);
  for (const s of ["present", "absent", "ALL"]) assert.equal(find(p, { grade: "1", status: s }).count, null, s);
});

test("a whole table below 5 releases nothing but suppression markers", () => {
  const p = rel("enrollment_by_grade", [{ grade: "7", count: 1 }, { grade: "8", count: 1 }]);
  assert.equal(published(p).length, 0);
});

test("leak attempt: an unknown field (student name) is refused", () => {
  assert.equal(code(() => rel("enrollment_by_grade", [{ grade: "4", count: 9, name: "Ava Morgan" }])), "unknown_field");
});
test("leak attempt: student id smuggled in a dimension value", () => {
  assert.equal(code(() => rel("mastery_by_standard", [{ standard: STUDENT, level: "mastered", count: 9 }])), "identifier_detected");
});
test("leak attempt: local student number as a standard code", () => {
  assert.equal(code(() => rel("mastery_by_standard", [{ standard: "RES-1001", level: "mastered", count: 9 }])), "identifier_detected");
});
test("leak attempt: family name hidden in a route label", () => {
  assert.equal(code(() => rel("transport_checkins_daily", [{ date: "2026-11-10", route: "Morgan pickup", event: "boarded", count: 9 }])), "identifier_detected");
});
test("leak attempt: free text outside the allow-list", () => {
  assert.equal(code(() => rel("attendance_daily", [att("4", "absent; Ava was sick", 9)])), "value_not_allowed");
});
test("leak attempt: unknown kind (student roster)", () => {
  assert.equal(code(() => rel("student_roster", [{ name: "x", count: 1 }])), "kind_not_allowed");
});
test("leak attempt: one cell per student (count 1) is suppressed, not sent", () => {
  const cells = ["3", "4", "5", "6"].map(g => ({ grade: g, count: 1 }));
  assert.equal(published(rel("enrollment_by_grade", cells)).length, 0);
});
test("leak attempt: fractional count to encode an id", () => {
  assert.equal(code(() => rel("enrollment_by_grade", [{ grade: "4", count: 5.301 }])), "count_not_integer");
});
test("leak attempt: health metrics carrying a name", () => {
  assert.equal(code(() => release({ kind: "node_health", schoolId: SCHOOL, period: "p", metrics: { note: "Ava Morgan" } })), "unknown_field");
  assert.equal(code(() => release({ kind: "node_health", schoolId: SCHOOL, period: "p", metrics: { version: "Ava Morgan" } })), "value_not_allowed");
});

test("egress re-check: hand-built payloads that bypass release() are refused", () => {
  const good = rel("enrollment_by_grade", [{ grade: "3", count: 12 }, { grade: "4", count: 3 }, { grade: "5", count: 9 }]);
  const tamper = f => { const c = structuredClone(good); f(c); return code(() => verifyReleased(c, { identifiers: ids })); };
  assert.equal(code(() => verifyReleased({ kind: "enrollment_by_grade", cells: [] })), "not_gate_output");
  assert.equal(tamper(c => { c.k = 2; }), "k_below_minimum");
  assert.equal(tamper(c => { const x = c.cells.find(z => z.count === null); x.count = 3; delete x.suppressed; }), "small_cell_published");
  assert.equal(tamper(c => { c.cells.push({ grade: "9", count: 7, name: "Ava" }); }), "unknown_field");
  assert.equal(tamper(c => { c.students = [STUDENT]; }), "unknown_field");
  // Un-suppress the complement: the small cell becomes recoverable.
  assert.equal(tamper(c => { for (const x of c.cells) if (x.suppressed === "complementary") { x.count = { "3": 12, "5": 9, "ALL": 24 }[x.grade]; delete x.suppressed; } }), "suppressed_cell_recoverable");
});

test("recoverableCells detects a cycle-free exposure and accepts a 2x2 swap", () => {
  const k = (r, c) => `${r}|${c}`;
  const eqs = [{ total: k("a", "T"), parts: [k("a", 1), k("a", 2)] }, { total: k("b", "T"), parts: [k("b", 1), k("b", 2)] },
    { total: k("T", 1), parts: [k("a", 1), k("b", 1)] }, { total: k("T", 2), parts: [k("a", 2), k("b", 2)] }];
  const cells = supp => new Map([k("a", 1), k("a", 2), k("b", 1), k("b", 2), k("a", "T"), k("b", "T"), k("T", 1), k("T", 2)].map(x => [x, { supp: supp.includes(x) ? "x" : null }]));
  assert.deepEqual(recoverableCells(cells([k("a", 1)]), eqs), [k("a", 1)]);
  assert.deepEqual(recoverableCells(cells([k("a", 1), k("a", 2), k("b", 1), k("b", 2)]), eqs), []);
});

test("safety summary: counts suppressed, allAccounted computed by the gate (not trusted)", () => {
  const inc = "00000000-0000-4000-8000-00000000a001";
  const p = release({ kind: "safety_summary", schoolId: SCHOOL, period: "2026-11-10",
    cells: [{ incident: inc, status: "present", count: 40 }, { incident: inc, status: "missing", count: 1 }, { incident: inc, status: "injured", count: 0 }, { incident: inc, status: "not_reported", count: 0 }],
    meta: { [inc]: { kind: "evacuate", drill: true, status: "active", startedAt: "2026-11-10T14:00:00.000Z", endedAt: null, allAccounted: true } } }, { identifiers: ids });
  assert.equal(p.meta[inc].allAccounted, false);
  assert.equal(find(p, { incident: inc, status: "missing" }).count, null);
  assert.ok(published(p).every(c => c.count === 0 || c.count >= 5));
});

test("consent exceptions are off by default and need an approved, unused, matching record", () => {
  const exception = { id: "00000000-0000-4000-8000-00000000c001", status: "approved", purpose: "records_transfer", studentId: STUDENT,
    schoolId: SCHOOL, consentReference: "Signed release #12", expiresAt: new Date(Date.now() + 86400000).toISOString(), usedAt: null };
  const record = { studentId: STUDENT, displayName: "Ava Morgan", gradeLevel: "4", finalGrades: [] };
  assert.equal(code(() => releaseConsented({ exception, record })), "consent_exceptions_disabled");
  assert.equal(code(() => releaseConsented({ exception: { ...exception, status: "requested" }, record }, { enabled: true })), "consent_exception_not_approved");
  assert.equal(code(() => releaseConsented({ exception: { ...exception, usedAt: "x" }, record }, { enabled: true })), "consent_exception_used");
  assert.equal(code(() => releaseConsented({ exception, record: { ...record, studentId: "00000000-0000-4000-8000-000000000302" } }, { enabled: true })), "consent_subject_mismatch");
  const ok = releaseConsented({ exception, record }, { enabled: true });
  assert.equal(ok.kind, "consented_record_transfer");
  assert.equal(code(() => verifyReleased({ ...ok, exceptionId: undefined })), "consent_exception_required");
});

test("randomised: no published table ever exposes a small cell (500 tables)", () => {
  let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let t = 0; t < 500; t++) {
    const grades = ["1", "2", "3", "4", "5"].slice(0, 1 + rnd(5)), sts = ["present", "absent", "tardy", "excused"].slice(0, 1 + rnd(4));
    const cells = []; for (const g of grades) for (const s of sts) cells.push(att(g, s, rnd(3) === 0 ? rnd(5) : rnd(30)));
    const p = rel("attendance_daily", cells);
    for (const c of p.cells) if (c.count !== null) assert.ok(c.count === 0 || c.count >= 5);
    verifyReleased(p, { identifiers: ids });
  }
});

test("an empty table is released as no cells (nothing recoverable, not blocked)", () => {
  const ids = buildIdentifierIndex({});
  for (const kind of ["enrollment_by_grade", "mastery_by_standard", "gradebook_distribution"]) {
    const out = release({ kind, schoolId: "00000000-0000-4000-8000-000000000102", period: "current", cells: [] }, { identifiers: ids });
    assert.deepEqual(out.cells, []);
    verifyReleased(out, { identifiers: ids });
  }
});
