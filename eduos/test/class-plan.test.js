// TEACH-04: daily class plan blocks (src/class-plan.js).
import test from "node:test";
import assert from "node:assert/strict";
import { cleanBlocks, totalMinutes } from "../src/class-plan.js";

const ID = "11111111-1111-4111-8111-111111111111";

test("each kind of block is checked and normalised", () => {
  const { blocks } = cleanBlocks([
    { kind: "warmup", prompt: " Which is bigger, 1/2 or 3/8? ", minutes: 5, note: "Ask the back row first" },
    { kind: "lesson", lessonId: ID, minutes: "20" },
    { kind: "timer", label: "Pair work", minutes: 10 },
    { kind: "assignment", assignmentId: ID },
    { kind: "text", title: "", body: "Tidy up and hand in." },
    { kind: "link", label: "Fraction game", url: "https://example.org/fractions?x=1" }]);
  assert.deepEqual(blocks.map(b => b.kind), ["warmup", "lesson", "timer", "assignment", "text", "link"]);
  assert.equal(blocks[0].prompt, "Which is bigger, 1/2 or 3/8?");
  assert.equal(blocks[1].minutes, 20);
  assert.equal(totalMinutes(blocks), 35);
});

test("bad blocks are refused with their position", () => {
  assert.deepEqual(cleanBlocks([{ kind: "warmup", prompt: "ok" }, { kind: "video" }]), { error: "invalid_block", index: 1 });
  assert.deepEqual(cleanBlocks([{ kind: "link", label: "x", url: "http://example.org" }]), { error: "invalid_link", index: 0 }, "https only");
  assert.deepEqual(cleanBlocks([{ kind: "link", label: "x", url: "https://user:pw@example.org" }]), { error: "invalid_link", index: 0 });
  assert.deepEqual(cleanBlocks([{ kind: "link", label: "x", url: "javascript:alert(1)" }]), { error: "invalid_link", index: 0 });
  assert.deepEqual(cleanBlocks([{ kind: "timer", label: "x" }]), { error: "timer_needs_minutes", index: 0 });
  assert.deepEqual(cleanBlocks([{ kind: "text", body: "x", minutes: 999 }]), { error: "invalid_minutes", index: 0 });
  assert.deepEqual(cleanBlocks([{ kind: "lesson", lessonId: "nope" }]), { error: "invalid_block", index: 0 });
  assert.equal(cleanBlocks(Array.from({ length: 31 }, () => ({ kind: "warmup", prompt: "q" }))).error, "invalid_blocks");
});
