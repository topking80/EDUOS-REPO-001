// TC-06: transfer packages are signed; any change is caught (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { transferKeys, signTransfer, verifyTransfer, readTransfer, TRANSFER_FORMAT } from "../src/history-transfer.js";

const keys = transferKeys("a-test-only-transfer-secret-of-at-least-32-chars");
const body = () => ({ format: TRANSFER_FORMAT, packageId: "p1", createdAt: "2026-11-24T12:00:00.000Z", student: { name: "Alice A" },
  items: [{ sourceEntryId: "e1", kind: "official_record", title: "Report card", body: "Reading: strong" }] });
test("a signed package verifies, and names its signer's fingerprint", () => {
  const pkg = signTransfer(body(), keys);
  const v = verifyTransfer(JSON.parse(JSON.stringify(pkg)));
  assert.equal(v.ok, true); assert.equal(v.fingerprint, keys.fingerprint); assert.equal(v.body.items[0].title, "Report card");
  assert.equal(transferKeys("a-test-only-transfer-secret-of-at-least-32-chars").fingerprint, keys.fingerprint, "the same secret, the same key");
});
test("changing anything, swapping the key, or dropping the signature is caught", () => {
  const pkg = signTransfer(body(), keys);
  const changed = structuredClone(pkg); changed.items[0].body = "Reading: needs work";
  assert.equal(verifyTransfer(changed).reason, "altered");
  const other = transferKeys("another-test-only-secret-that-is-32-chars-long!");
  const swapped = structuredClone(pkg); swapped.signature.publicKey = other.public; swapped.signature.keyFingerprint = other.fingerprint;
  assert.equal(verifyTransfer(swapped).reason, "bad_signature");
  const resigned = signTransfer({ ...body(), items: [] }, other);
  assert.equal(verifyTransfer(resigned).ok, true, "a different signer is valid but has a different fingerprint");
  assert.notEqual(verifyTransfer(resigned).fingerprint, keys.fingerprint);
  const { signature, ...unsigned } = pkg;
  assert.equal(verifyTransfer(unsigned).reason, "not_a_transfer_package");
  assert.throws(() => signTransfer(body(), null), /transfer_signing_not_configured/);
  assert.throws(() => transferKeys("short"), /at least 32/);
});
test("the receiving side reads a package into items ready to add; anything off-format is refused whole", () => {
  const good = { format: TRANSFER_FORMAT, packageId: "p1", createdAt: "2026-11-24T12:00:00.000Z",
    source: { districtId: "d-1", districtName: "Old District", schoolName: "Elm School" }, receiving: { name: "New District" },
    basis: { kind: "enrollment_request", note: "Request dated Nov 20" }, includes: { records: true, familyItems: false },
    student: { name: "Alice A", localStudentNumber: "S1-A", gradeLevel: "3" },
    items: [{ sourceEntryId: "e1", revision: 2, type: "event", kind: "official_record", title: " Report card ", body: "Reading: strong",
      occurredAt: "2026-05-01T00:00:00Z", schoolYear: "2025-26", source: "school", audience: "school", author: "Ms. Ray",
      photos: [{ description: "Alice holding the certificate", caption: "Spring" }] }] };
  const r = readTransfer(good);
  assert.equal(r.ok, true);
  assert.deepEqual(r.meta, { packageId: "p1", packagedAt: "2026-11-24T12:00:00.000Z", sourceDistrictId: "d-1", sourceDistrictName: "Old District",
    sourceSchoolName: "Elm School", addressedTo: "New District", basis: "enrollment_request", basisNote: "Request dated Nov 20", includesFamily: false,
    studentName: "Alice A", studentNumber: "S1-A", studentGrade: "3" });
  assert.equal(r.items[0].title, "Report card");
  assert.equal(r.items[0].body, "Reading: strong\n\nPhotos (not transferred): Alice holding the certificate: Spring", "what the photos showed stays with the item");
  assert.equal(r.items[0].audience, "school"); assert.equal(r.items[0].author, "Ms. Ray");
  const bad = f => { const b = structuredClone(good); f(b); return readTransfer(b).reason; };
  assert.equal(bad(b => { b.items[0].kind = "grade_change"; }), "malformed");
  assert.equal(bad(b => { b.items[0].type = "transcript"; }), "malformed");
  assert.equal(bad(b => { b.items[0].title = "x".repeat(181); }), "malformed");
  assert.equal(bad(b => { b.items[0].occurredAt = "soon"; }), "malformed");
  assert.equal(bad(b => { b.items[0].kind = "family_memory"; }), "malformed", "family items only when the family agreed");
  assert.equal(bad(b => { delete b.student; }), "malformed");
  assert.equal(bad(b => { b.items = {}; }), "malformed");
  const odd = structuredClone(good); odd.items[0].source = "hacker"; odd.items[0].audience = "everyone";
  assert.deepEqual([readTransfer(odd).items[0].source, readTransfer(odd).items[0].audience], ["other", null]);
});
