// TEACH-05: a teacher's package is hashed and signed; any change is caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FORMAT, signingKeys, seal, check, itemText } from "../src/portfolio-package.js";

const manifest = () => ({ format: FORMAT, owner: { name: "Teacher S1" }, issuedBy: { district: "D1" }, issuedAt: "2026-11-23T15:00:00.000Z",
  items: [{ kind: "lesson", title: "Halves", body: { objective: "Show halves", content: "Fold." }, approval: null, rights: null, schoolKeepsCopy: true }], licenses: [], excluded: [] });

test("sealed and checked, signed with a key derived from the secret", () => {
  const keys = signingKeys("s".repeat(40));
  assert.deepEqual(signingKeys("s".repeat(40)), keys, "the same secret gives the same key");
  const s = seal(manifest(), keys);
  assert.deepEqual(check(manifest(), s), { ok: true, signed: true });
  const changed = manifest(); changed.items[0].body.content = "Fold twice.";
  assert.equal(check(changed, s).ok, false, "a changed lesson fails");
  assert.equal(check(manifest(), { ...s, publicKey: signingKeys("t".repeat(40)).public }).ok, false, "another key fails");
  assert.equal(check({ ...manifest(), format: "X" }, s).ok, false);
});

test("unsigned when the deployment has no key; short secrets are refused", () => {
  const s = seal(manifest(), null);
  assert.equal(s.signature, null);
  assert.deepEqual(check(manifest(), s), { ok: true, signed: false });
  assert.throws(() => signingKeys("short"), /32 characters/);
  assert.throws(() => seal({ format: "nope" }, null));
});

test("item text covers what a student's name could be in", () => {
  assert.match(itemText({ kind: "unit", title: "U", body: { summary: "S", lessons: [{ title: "L", objective: "O", content: "Alice's turn" }] } }), /Alice/);
  assert.match(itemText({ kind: "coaching_plan", title: "P", body: { items: [{ title: "Drill", description: "Bob in goal" }] } }), /Bob/);
});
