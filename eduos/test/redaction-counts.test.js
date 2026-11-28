// SEC-06: what redaction removed, as kinds and counts only. Counting never
// changes what is sent; the kinds match the database's allowlist; no value
// can carry text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REDACTION_KINDS, countsOf, countsDetail } from "../src/redaction-counts.js";
import { redact, redactContent, outboundHelpFields } from "../src/christie/providers.js";
import { redactionTally, externalRequestBody } from "../src/ai/providers.js";

const ids = { names: ["Ava Morgan"], numbers: ["RES-1001"] };
const pw = "DB_PASSWORD=" + "winter" + "42";
const SAMPLE = `I'm Ava Morgan (RES-1001), office@school.example, 555-123-4567, id 12345678, AB-99, see https://x.example/a, ask Mrs Hargreaves, born on 3 March 2015, 12 Oak Street. ${pw}`;

test("each kind is counted once per removal", () => {
  const tally = {};
  redact(SAMPLE, { ...ids, max: 2000 }, tally);
  assert.deepEqual(countsOf(tally), { student_name: 1, student_number: 1, email: 1, phone: 1, long_number: 1, id_number: 1, url: 1, titled_name: 1, birth_date: 1, address: 1, secret: 1 });
});

test("counting never changes the redacted text", () => {
  for (const text of [SAMPLE, "Nothing to remove here: 3/4 + 1/8.", "", "Ava, Ava and Morgan again; www.example.org; 555 123 4567"]) {
    assert.equal(redact(text, { ...ids, max: 2000 }, {}), redact(text, { ...ids, max: 2000 }), text);
    assert.equal(redactContent(text, ids, {}), redactContent(text, ids), text);
    for (const usecase of ["resource_summary", "writing_feedback", "lesson_draft"])
      assert.deepEqual(externalRequestBody({ model: "m", usecase, input: { text }, identifiers: ids }, {}), externalRequestBody({ model: "m", usecase, input: { text }, identifiers: ids }));
  }
});

test("a phone-shaped run too short to be a phone is neither removed nor counted", () => {
  const tally = {};
  assert.equal(redact("Score 12-34-56 today", {}, tally), "Score 12-34-56 today");
  assert.deepEqual(countsOf(tally), {});
});

test("Christie's request totals every field; the staff request counts what it sends", () => {
  const tally = {};
  outboundHelpFields({ question: "Ava Morgan asked", skillTitle: "Halves", explanation: "Email office@school.example", prompt: "Mr Lee has 10", unlockedHints: ["RES-1001 split it"] }, ids, [], tally);
  assert.deepEqual(countsOf(tally), { student_name: 1, email: 1, titled_name: 1, student_number: 1 });
  assert.deepEqual(countsOf(redactionTally({ usecase: "writing_feedback", input: { text: SAMPLE }, identifiers: ids })).student_name, 1);
  assert.deepEqual(redactionTally({ usecase: "ops_brief", input: { context: { day: "x" } } }), {}, "counts EduOS computed aren't redacted");
});

test("only known kinds and whole counts are kept; the audit form is sorted and value-free", () => {
  assert.deepEqual(countsOf({ email: 2, note: 5, phone: "3", url: 1.5, secret: 0, address: -1 }), { email: 2 });
  assert.equal(countsDetail({ student_name: 2, email: 1 }), "email:1,student_name:2");
  assert.equal(countsDetail({}), "none");
  assert.equal(countsDetail(null), "none");
});

test("the database allowlist is exactly the kinds the code counts", () => {
  const sql = readFileSync("db/184_ai_redaction_counts.sql", "utf8");
  const list = /e\.key NOT IN \(([^)]*)\)/.exec(sql)[1].match(/'([a-z_]+)'/g).map(s => s.slice(1, -1));
  assert.deepEqual([...list].sort(), [...REDACTION_KINDS].sort());
});
