// TEACH-06: a package file opens only with its approved device's unlock code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newDeviceKeys, encryptForDevice, decryptWithCode, formatCode, normalizeCode, keyFingerprint } from "../src/portfolio-file.js";

const payload = { manifest: { format: "EDUOS-PORTFOLIO-1", items: [{ title: "Halves" }] }, sha256: "a".repeat(64), signature: null, publicKey: null };

test("round trip with the device's code, written in groups or not", () => {
  const k = newDeviceKeys();
  assert.match(k.code, /^[A-Z2-7]{52}$/);
  const f = encryptForDevice({ deviceId: "d1", deviceName: "Blue drive", publicKey: k.publicKey }, payload);
  assert.doesNotMatch(JSON.stringify(f), /Halves/, "the content is encrypted");
  assert.deepEqual(decryptWithCode(f, k.code), payload);
  assert.deepEqual(decryptWithCode(f, formatCode(k.code)), payload);
  assert.deepEqual(decryptWithCode(f, formatCode(k.code).toLowerCase()), payload, "any case");
  assert.equal(normalizeCode("ab-cd ef"), "ABCDEF");
  assert.equal(keyFingerprint(k.publicKey).length, 16);
});

test("every code round-trips (no character of the code is a separator)", () => {
  for (let i = 0; i < 200; i++) {
    const k = newDeviceKeys();
    const f = encryptForDevice({ deviceId: "d", deviceName: "D", publicKey: k.publicKey }, payload);
    assert.deepEqual(decryptWithCode(f, formatCode(k.code)), payload);
  }
});

test("another device's code, a changed file or a changed header fail", () => {
  const k = newDeviceKeys(), other = newDeviceKeys();
  const f = encryptForDevice({ deviceId: "d1", deviceName: "Blue drive", publicKey: k.publicKey }, payload);
  assert.throws(() => decryptWithCode(f, other.code), /wrong_code_or_damaged_file/);
  const ct = Buffer.from(f.ct, "base64"); ct[3] ^= 1;
  assert.throws(() => decryptWithCode({ ...f, ct: ct.toString("base64") }, k.code), /wrong_code_or_damaged_file/);
  assert.throws(() => decryptWithCode({ ...f, deviceName: "Red drive" }, k.code), /wrong_code_or_damaged_file/, "the header is bound to the content");
  assert.throws(() => decryptWithCode({ ...f, format: "X" }, k.code), /wrong_code_or_damaged_file/);
  assert.throws(() => decryptWithCode(f, "short"), /wrong_code_or_damaged_file/);
});
