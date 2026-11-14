// EduOS 32.6.0 learning core and EDAL ledger: the mastery model, gradebook,
// quiz scoring, the hash chain and its verifier, permissions, the Christie
// approved-content guard and the migration / UI / seed contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeMastery, explainMastery, isNewMilestone, courseMastery, SOURCE_WEIGHT } from "../src/mastery-model.js";
import { courseGrade, letterFor, effectiveAttempt, validRubric, rubricTotals } from "../src/gradebook.js";
import { scoreItem, validKey, deadlineFor } from "../src/quiz-scoring.js";
import { canonicalJson, entryHash, verifyChain, verifyRecord, checkpointHolds, sha256, GENESIS, KINDS } from "../src/edal.js";
import { parseArgs, loadCheckpoint, verifyExport } from "../src/edal-verify.js";
import { localProvider } from "../src/christie/providers.js";
import { canPerform } from "../src/policy.js";
import { PRIMARY_SOURCES, STANDARDS, COURSE_WORK, LESSONS } from "../dev/demo-fixture.js";
import { RELEASE_RE } from "./helpers/release.js";

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const can = (role, res, act) => canPerform({ role, districtId: "d", userId: "u" }, res, act);
const at = n => new Date(Date.UTC(2026, 9, 1 + n)).toISOString();

test("mastery: weighted, recency-discounted average with an explanation", () => {
  assert.deepEqual(computeMastery([]).mastery, 0);
  const r = computeMastery([
    { source: "quiz", score: 0.8, observed_at: at(3), label: "Quiz" },
    { source: "rubric", score: 1, observed_at: at(4), label: "Poster: Accuracy" },
    { source: "christie", score: 0.6, observed_at: at(1), label: "Practice" }]);
  // newest first: rubric 1×1×1, quiz 0.8×1×0.8, christie 0.6×0.5×0.64
  const expected = Math.round(100 * (1 + 0.64 + 0.192) / (1 + 0.8 + 0.32));
  assert.equal(r.mastery, expected);
  assert.equal(r.level, "mastered");
  assert.equal(r.used.reduce((x, u) => x + u.share, 0) >= 99, true);
  assert.match(explainMastery(r), /Rubric "Poster: Accuracy": 100%/);
  assert.match(explainMastery(computeMastery([])), /No evidence yet/);
  assert.equal(SOURCE_WEIGHT.christie, 0.5);
});

test("mastery: practice alone or too little evidence never says mastered", () => {
  const practice = computeMastery([1, 2, 3, 4].map(i => ({ source: "christie", score: 1, observed_at: at(i), label: "p" })));
  assert.equal(practice.mastery, 100);
  assert.equal(practice.level, "developing"); assert.match(practice.reason, /practice alone/);
  const two = computeMastery([{ source: "quiz", score: 1, observed_at: at(1), label: "q" }, { source: "quiz", score: 1, observed_at: at(2), label: "q" }]);
  assert.equal(two.level, "developing"); assert.match(two.reason, /1 more piece/);
  assert.equal(computeMastery([{ source: "quiz", score: 0.3, observed_at: at(1), label: "q" }]).level, "emerging");
  // only the 8 newest count
  const many = computeMastery([...Array(12)].map((_, i) => ({ source: "quiz", score: i < 4 ? 0 : 1, observed_at: at(i), label: "q" })));
  assert.equal(many.used.length, 8); assert.equal(many.mastery, 100);
  assert.equal(isNewMilestone(null, { level: "mastered" }), true);
  assert.equal(isNewMilestone({ mastered_at: new Date() }, { level: "mastered" }), false);
  assert.deepEqual(courseMastery(["a", "b"], new Map([["a", { mastery: 90, level: "mastered" }]])), { average: 45, mastered: 1, total: 2 });
});

test("gradebook: category weights rescale over graded work; ungraded work is not a zero", () => {
  const g = courseGrade([
    { category: "Classwork", points: 10, earned: 9 }, { category: "Classwork", points: 10, earned: null },
    { category: "Quizzes", points: 5, earned: 4 }], { Classwork: 40, Quizzes: 60 });
  assert.equal(g.percent, Math.round((90 * 40 + 80 * 60) / 100 * 10) / 10);
  assert.equal(g.letter, "B");
  const onlyQuiz = courseGrade([{ category: "Quizzes", points: 5, earned: 5 }], { Classwork: 40, Quizzes: 60 });
  assert.equal(onlyQuiz.percent, 100, "Classwork has no graded work yet, so Quizzes carry the grade");
  assert.equal(courseGrade([], { Classwork: 40 }).percent, null);
  assert.deepEqual([95, 85, 75, 65, 10].map(letterFor), ["A", "B", "C", "D", "F"]);
  assert.equal(effectiveAttempt([{ total: 2, possible: 4 }, { total: 4, possible: 4 }], "highest"), 1);
  assert.equal(effectiveAttempt([{ total: 4, possible: 4 }, { total: 2, possible: 4 }], "latest"), 0.5);
  assert.equal(effectiveAttempt([{ total: 4, possible: 4 }, { total: 2, possible: 4 }], "average"), 0.75);
  assert.equal(effectiveAttempt([], "highest"), null);
});

test("rubrics: validated shape; totals need a real level for every criterion", () => {
  const rub = COURSE_WORK.find(w => w.rubric).rubric;
  assert.equal(validRubric(rub), true);
  assert.equal(validRubric([{ id: "a", title: "x", levels: [{ points: 1, label: "one" }] }]), false, "needs two levels");
  assert.equal(validRubric([]), false);
  const t = rubricTotals(rub, rub.map(r => ({ criterionId: r.id, points: 4 })));
  assert.equal(t.percent, 100); assert.equal(t.rows[0].label, "All correct");
  assert.throws(() => rubricTotals(rub, [{ criterionId: rub[0].id, points: 4 }]), /needs one of its level scores/);
  assert.throws(() => rubricTotals(rub, rub.map(r => ({ criterionId: r.id, points: 2.5 }))));
});

test("quiz scoring: mc and numeric (fractions, tolerance) auto-score; short answers credit only known answers", () => {
  assert.deepEqual(scoreItem({ kind: "mc", points: 2 }, { index: 1 }, "1"), { correct: true, points: 2 });
  assert.deepEqual(scoreItem({ kind: "mc", points: 2 }, { index: 1 }, "0"), { correct: false, points: 0 });
  assert.equal(scoreItem({ kind: "numeric", points: 1 }, { value: "0.75" }, "3/4").correct, true);
  assert.equal(scoreItem({ kind: "numeric", points: 1 }, { value: "1.5" }, "1 1/2").correct, true);
  assert.equal(scoreItem({ kind: "numeric", points: 1 }, { value: "3.14", tolerance: 0.01 }, "3.149").correct, true);
  assert.equal(scoreItem({ kind: "numeric", points: 1 }, { value: "6" }, "12/16").correct, false);
  assert.equal(scoreItem({ kind: "short", points: 1 }, { accepted: ["4/10"] }, " 4 / 10 ").correct, true);
  assert.equal(scoreItem({ kind: "short", points: 1 }, { accepted: ["4/10"] }, "four tenths").correct, null, "a teacher decides");
  assert.equal(scoreItem({ kind: "source", points: 1 }, {}, "anything").correct, null);
  assert.equal(scoreItem({ kind: "numeric", points: 1 }, { value: "6" }, "").correct, false, "blank is wrong, not pending");
  assert.equal(validKey("mc", { index: 3 }, ["a", "b"]), false);
  assert.equal(validKey("numeric", { value: "x" }), false);
  assert.equal(validKey("short", { accepted: ["a"] }), true);
  const d = deadlineFor("2026-11-10T14:00:00.000Z", 10, 50);
  assert.equal(d.toISOString(), "2026-11-10T14:15:00.000Z", "50% extra time");
  assert.equal(deadlineFor(new Date(), null, 50), null, "untimed");
});

function chain(n, district = "d1") {
  const rows = []; let prev = GENESIS;
  for (let i = 1; i <= n; i++) {
    const e = { district_id: district, seq: i, kind: KINDS[i % KINDS.length], school_id: "s", subject_student_id: "x", payload_hash: sha256(canonicalJson({ i })), prev_hash: prev, recorded_at: at(i) };
    e.entry_hash = entryHash(e); prev = e.entry_hash; rows.push({ ...e, payload_state: "ok" });
  }
  return rows;
}
test("EDAL: canonical JSON is key-order independent; each entry commits to the previous one", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
  assert.equal(canonicalJson({ a: 1, u: undefined }), '{"a":1}');
  assert.throws(() => canonicalJson({ a: NaN }));
  const rows = chain(5);
  const ok = verifyChain("d1", rows, { seq: 5, head_hash: rows[4].entry_hash });
  assert.equal(ok.ok, true); assert.equal(ok.headSeq, 5);
  assert.equal(verifyChain("d1", [], { seq: 0, head_hash: GENESIS }).ok, true);
  assert.equal(verifyChain("d2", rows).ok, false, "district is part of the hash");
});

test("EDAL: edits, deletions, reordering and head mismatches are all detected", () => {
  const rows = chain(5);
  const edited = structuredClone(rows); edited[2].kind = "credential_revoked";
  assert.match(JSON.stringify(verifyChain("d1", edited).problems), /seq":3,"problem":"entry hash/);
  const removed = rows.filter(r => r.seq !== 3);
  assert.match(JSON.stringify(verifyChain("d1", removed).problems), /sequence gap/);
  const swapped = [rows[0], rows[2], rows[1], rows[3], rows[4]];
  assert.equal(verifyChain("d1", swapped).ok, false);
  assert.equal(verifyChain("d1", rows.slice(0, 4), { seq: 5, head_hash: rows[4].entry_hash }).ok, false, "truncated tail");
  const bad = structuredClone(rows); bad[1].payload_state = "mismatch";
  assert.match(JSON.stringify(verifyChain("d1", bad).problems), /payload does not match/);
  const erased = structuredClone(rows); erased[1].payload_state = "erased";
  const e = verifyChain("d1", erased); assert.equal(e.ok, true); assert.equal(e.erased, 1, "FERPA erasure keeps the chain valid");
  assert.equal(checkpointHolds(rows, { seq: 3, headHash: rows[2].entry_hash }), true);
  const rehashed = structuredClone(edited); rehashed[2].entry_hash = entryHash(rehashed[2]);   // an attacker recomputes the hash...
  assert.match(JSON.stringify(verifyChain("d1", rehashed).problems), /seq":4,"problem":"previous-hash link broken/, "...which breaks the next link");
  assert.equal(checkpointHolds(rehashed, { seq: 3, headHash: rows[2].entry_hash }), false, "...and any saved checkpoint");
  const rec = verifyRecord("d1", rows[2], canonicalJson({ i: 3 }), { prev_entry_hash: rows[1].entry_hash, next_prev_hash: rows[3].prev_hash });
  assert.equal(rec.ok, true);
  assert.equal(verifyRecord("d1", rows[2], canonicalJson({ i: 4 }), { prev_entry_hash: rows[1].entry_hash }).ok, false);
});

test("EDAL CLI: options, checkpoints and offline export verification", () => {
  assert.deepEqual(parseArgs(["--json", "--district", "x"]), { json: true, district: "x" });
  assert.throws(() => parseArgs(["--nope"]));
  const rows = chain(3);
  const cp = loadCheckpoint(JSON.stringify({ data: { seq: 2, headHash: rows[1].entry_hash } }));
  const doc = { data: { format: "EDAL1-chain", districtId: "d1", head: { seq: 3, headHash: rows[2].entry_hash }, entries: rows } };
  assert.equal(verifyExport(doc, cp)[0].ok, true);
  assert.equal(verifyExport(doc, { seq: 2, headHash: "a".repeat(64) })[0].ok, false);
  assert.throws(() => loadCheckpoint('{"seq":1}'));
  assert.throws(() => verifyExport({ format: "other" }));
  const cli = read("src/edal-verify.js");
  assert.doesNotMatch(cli, /fetch\(|https?:\/\/(?!www\.)/, "no network calls besides the database");
});

test("permissions: who teaches, grades, approves, issues credentials and verifies the ledger", () => {
  assert.equal(can("teacher", "learning", "teach"), true); assert.equal(can("teacher", "learning", "approve"), false);
  assert.equal(can("teacher", "learning", "credential"), false); assert.equal(can("principal", "learning", "credential"), true);
  assert.equal(can("pupil", "learning", "learn"), true); assert.equal(can("parent", "learning", "learn"), false);
  assert.equal(can("parent", "learning", "grade"), false); assert.equal(can("driver", "learning", "read"), false);
  assert.equal(can("it_admin", "learning", "read"), false, "IT has no student-record access");
  assert.equal(can("it_admin", "edal", "verify"), true); assert.equal(can("teacher", "edal", "verify"), false);
  for (const r of ["parent", "pupil", "teacher"]) assert.equal(can(r, "edal", "proof"), true, r);
});

test("Christie local hints come from approved text but never quote a passage that gives the answer", async () => {
  const explanation = "Fold the strip again. 1/2 = 2/4 because both halves match. Folding makes more pieces of the same size.";
  const r = await localProvider.help({ question: "why is 1/2 = 2/4", explanation, unlockedHints: [], firstHint: "Count the pieces.", answer: "2" });
  assert.doesNotMatch(r.text, /= ?2\/4/);
  const s = await localProvider.help({ question: "why same size pieces when folding", explanation, unlockedHints: [], firstHint: "x", answer: "2" });
  assert.match(s.text, /same size/);
});

test("migration 014: RLS on every new table, append-only records, no location/score/profiling columns", () => {
  const sql = read("db/014_learning_core_edal.sql");
  const tables = [...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map(m => m[1]);
  assert.ok(tables.length >= 22);
  for (const t of tables) assert.match(sql, new RegExp(`'${t}'`), `${t} is in the RLS loop`);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  for (const t of ["mastery_evidence", "course_final_grades"]) assert.match(sql, new RegExp(`BEFORE UPDATE OR DELETE ON ${t}[\\s\\S]{0,80}reject_append_only_mutation`), t);
  assert.match(sql, /ON edal_entries[\s\S]{0,120}reject_edal_mutation/);
  assert.match(sql, /archive_url ~ '\^https:\/\/\(www\\\.\)\?\(loc\\\.gov\|archives\\\.gov\)\//);
  assert.match(sql, /anchor_kind IN \('none'\)/, "no external anchoring is active");
  const code = sql.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /latitude|longitude|geolocation|face_|biometric|risk_score|threat|predict/i);
  assert.match(sql, /ALTER FUNCTION eduos_purge_student\(uuid\) RENAME TO eduos_purge_student_325/);
  assert.match(sql, /DELETE FROM edal_payloads/);
  assert.doesNotMatch(sql, /DELETE FROM edal_entries/, "FERPA purge keeps the hash chain");
  // Inside SECURITY DEFINER helpers the owner bypass must use the session user.
  const helpers = sql.slice(sql.indexOf("-- Visibility helpers"), sql.indexOf("-- Row-level security."));
  assert.doesNotMatch(helpers, /eduos_is_table_owner\(\)/);
  const grants = read("db/runtime_grants.template.sql");
  assert.match(grants, /REVOKE UPDATE, DELETE, TRUNCATE ON mastery_evidence, course_final_grades, edal_entries, edal_payloads, edal_checkpoints/);
  assert.match(grants, /REVOKE ALL ON edal_heads/);
});

test("demo content: real public-domain sources at LoC / National Archives only, standards are labelled summaries", () => {
  assert.equal(PRIMARY_SOURCES.length, 3);
  for (const s of PRIMARY_SOURCES) {
    assert.match(s.url, /^https:\/\/www\.(loc\.gov|archives\.gov)\//);
    assert.ok(["Library of Congress", "National Archives"].includes(s.archive));
    assert.match(s.rights, /public domain|no known restrictions/i);
  }
  assert.ok(PRIMARY_SOURCES.some(s => s.url === "https://www.loc.gov/item/00652085/"));
  for (const st of STANDARDS) { assert.match(st.description, /^Summary: /); assert.match(st.url, /^https:\/\/www\.thecorestandards\.org\//); }
  assert.ok(LESSONS.every(l => l.content.length > 80 && l.standards.length));
});

test("phone UI: learning screens exist, read-aloud uses on-device voices only, no external calls", () => {
  const app = read("public/app/app.js");
  for (const v of ["courses", "course", "lesson", "quiz", "attempt", "progress", "gradebook", "edal", "mastery"]) assert.match(app, new RegExp(`VIEWS\\.${v}\\s*=|${v}: *(async )?\\(`), v);
  assert.match(app, /speechSynthesis/); assert.match(app, /localService/);
  assert.doesNotMatch(app, /\bprompt\(|\bconfirm\(|getUserMedia|geolocation/);
  assert.match(read("public/app/sw.js"), new RegExp(`eduos-app-shell-${RELEASE_RE}"`));
});
