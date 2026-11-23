// TEACH-03: merging co-writers' edits (src/draft-merge.js).
import test from "node:test";
import assert from "node:assert/strict";
import { mergeDraft, cleanDraftBody, missingForCourse } from "../src/draft-merge.js";

const L = (o = {}) => ({ title: "Strips", objective: "Show halves", content: "Fold.", standards: [], sources: [], ...o });

test("lesson: different fields merge; the same field changed twice is a conflict", () => {
  const base = L();
  assert.deepEqual(mergeDraft("lesson", base, L({ title: "Fraction strips" }), L({ content: "Fold twice." })),
    { body: L({ title: "Fraction strips", content: "Fold twice." }), conflicts: [] });
  assert.deepEqual(mergeDraft("lesson", base, L({ content: "A" }), L({ content: "A" })).conflicts, [], "same change on both sides");
  const c = mergeDraft("lesson", base, L({ content: "Mine" }), L({ content: "Theirs" }));
  assert.deepEqual(c.conflicts, ["content"]);
});

test("unit: lessons merge one by one; adding lessons on one side only is fine; on both is a conflict", () => {
  const base = { title: "Fractions", summary: null, lessons: [L(), L({ title: "Lines" })] };
  const mine = { ...base, lessons: [L({ content: "Mine" }), base.lessons[1]] };
  const theirs = { ...base, summary: "Models first", lessons: [base.lessons[0], L({ title: "Number lines" })] };
  const m = mergeDraft("unit", base, mine, theirs);
  assert.deepEqual(m.conflicts, []);
  assert.deepEqual([m.body.summary, m.body.lessons[0].content, m.body.lessons[1].title], ["Models first", "Mine", "Number lines"]);
  const added = { ...base, lessons: [...base.lessons, L({ title: "Decimals" })] };
  assert.equal(mergeDraft("unit", base, added, theirs).conflicts.length, 1, "the list changed on one side, a lesson on the other");
  assert.deepEqual(mergeDraft("unit", base, added, base).body.lessons.length, 3, "only my side touched the list");
  assert.deepEqual(mergeDraft("unit", base, base, added).body.lessons.length, 3, "only their side touched the list");
  assert.deepEqual(mergeDraft("unit", base, mine, { ...base, lessons: [L({ content: "Theirs" }), base.lessons[1]] }).conflicts, ["lessons[0].content"]);
});

test("draft bodies are validated and normalised; empty text is allowed while writing", () => {
  assert.deepEqual(cleanDraftBody("lesson", { title: "", objective: "", content: "", extra: 1 }), { title: "", objective: "", content: "", standards: [], sources: [] });
  assert.equal(cleanDraftBody("lesson", { title: "x".repeat(121) }), null);
  assert.equal(cleanDraftBody("lesson", { title: "t", standards: [{ id: "nope" }] }), null);
  assert.equal(cleanDraftBody("unit", { title: "U", lessons: [] }), null, "a unit has at least one lesson");
  assert.ok(cleanDraftBody("unit", { title: "U", lessons: [{ title: "a" }] }));
  assert.deepEqual(missingForCourse("unit", cleanDraftBody("unit", { title: "U", lessons: [{ title: "a", objective: "b" }] })), ["lessons[0].content"]);
});
