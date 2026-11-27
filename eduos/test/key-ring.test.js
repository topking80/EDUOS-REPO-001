// FED-08: trusting several Master Control keys during a rotation, and
// refusing revoked ones.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { BUNDLE_FORMAT, bundleKeys, signBundle, verifyBundle } from "../src/federation/policy-bundle.js";
import { parseKeyRing, verifyWithRing } from "../src/federation/key-ring.js";

const key = () => bundleKeys(crypto.randomBytes(24).toString("hex"));
const bundle = k => signBundle({ format: BUNDLE_FORMAT, bundle_id: "pb-1", release_id: "rel-1", kind: "release", version: 1, previous_sha256: null, issued_at: "2026-11-26",
  effective_from: "2026-11-26", district: { node_id: "d", name: "D", tenant_ref: "t", jurisdiction_id: "US-TX" }, issuer: { node_id: "s", name: "S" }, catalog_version: "0.6.0", policies: [] }, k);

test("a ring holds every listed key once, and never a revoked one", () => {
  const a = key(), b = key(), c = key();
  const ring = parseKeyRing(`${a.public}, ${b.public}\n${a.public} ${c.public} not-a-key`, `${c.fingerprint} zz`);
  assert.deepEqual(ring.fingerprints, [a.fingerprint, b.fingerprint]);
  assert.ok(ring.revoked.has(c.fingerprint)); assert.equal(ring.revoked.size, 1);
  assert.equal(parseKeyRing("").configured, false);
});

test("PEM blocks work too", () => {
  const a = key(), b = key();
  const pem = k => `-----BEGIN PUBLIC KEY-----\n${k.public.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;
  assert.deepEqual(parseKeyRing(`${pem(a)}\n${pem(b)}`).fingerprints, [a.fingerprint, b.fingerprint]);
});

test("during a rotation either key verifies; a revoked or unknown one doesn't", () => {
  const a = key(), b = key(), c = key(), d = key();
  const ring = parseKeyRing(`${a.public},${b.public},${c.public}`, c.fingerprint);
  assert.equal(verifyWithRing(verifyBundle, bundle(a), ring).ok, true);
  assert.equal(verifyWithRing(verifyBundle, bundle(b), ring).ok, true);
  assert.equal(verifyWithRing(verifyBundle, bundle(c), ring).reason, "key_revoked");
  assert.equal(verifyWithRing(verifyBundle, bundle(d), ring).reason, "wrong_key");
  const changed = bundle(c); changed.version = 2;
  assert.equal(verifyWithRing(verifyBundle, changed, ring).reason, "altered", "tampering is reported first");
});
