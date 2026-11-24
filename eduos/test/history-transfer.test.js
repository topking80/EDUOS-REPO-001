// TC-06: transfer packages are signed; any change is caught (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { transferKeys, signTransfer, verifyTransfer, TRANSFER_FORMAT } from "../src/history-transfer.js";

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
