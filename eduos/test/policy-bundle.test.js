// FED-05: signing and checking Master Control policy bundles.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { BUNDLE_FORMAT, bundleKeys, signBundle, verifyBundle, parsePublicKey } from "../src/federation/policy-bundle.js";

const secret = crypto.randomBytes(24).toString("hex");
const body = { format: BUNDLE_FORMAT, bundle_id: "pb-1", release_id: "rel-1", kind: "release", version: 3, previous_sha256: null, issued_at: "2026-11-26",
  effective_from: "2026-12-01", district: { node_id: "dist-1", name: "Lakeside", tenant_ref: "tenant-1", jurisdiction_id: "US-TX" }, issuer: { node_id: "sea-tx", name: "TEA" },
  catalog_version: "0.4.0", policies: [{ id: "security.mfa.required_for_staff", value: true, source: "ps-1", locked_by: "ps-1", chain: [] }] };

test("a signed bundle checks out against the public key, as base64 or PEM", () => {
  const keys = bundleKeys(secret);
  assert.equal(bundleKeys(secret).fingerprint, keys.fingerprint, "the same secret gives the same key");
  const pkg = signBundle(body, keys);
  const trusted = parsePublicKey(keys.public);
  assert.equal(trusted.fingerprint, keys.fingerprint);
  assert.deepEqual(verifyBundle(pkg, trusted).body, body);
  const pem = crypto.createPublicKey({ key: Buffer.from(keys.public, "base64"), format: "der", type: "spki" }).export({ type: "spki", format: "pem" });
  assert.equal(verifyBundle(pkg, parsePublicKey(pem)).ok, true);
  assert.equal(bundleKeys(""), null);
  assert.throws(() => bundleKeys("short"), /at least 32/);
});

test("altered, re-signed, foreign and malformed bundles are refused", () => {
  const keys = bundleKeys(secret), trusted = parsePublicKey(keys.public);
  const pkg = signBundle(body, keys);
  const changed = structuredClone(pkg); changed.policies[0].value = false;
  assert.equal(verifyBundle(changed, trusted).reason, "altered");
  const other = signBundle(body, bundleKeys(crypto.randomBytes(24).toString("hex")));
  assert.equal(verifyBundle(other, trusted).reason, "wrong_key");
  const forged = { ...pkg, signature: { ...pkg.signature, value: other.signature.value } };
  assert.equal(verifyBundle(forged, trusted).reason, "bad_signature");
  assert.equal(verifyBundle({ hello: 1 }, trusted).reason, "not_a_policy_bundle");
  assert.equal(verifyBundle({ ...pkg, signature: undefined }, trusted).reason, "malformed");
  const noPolicies = signBundle({ ...body, policies: "all" }, keys);
  assert.equal(verifyBundle(noPolicies, trusted).reason, "malformed");
  assert.equal(parsePublicKey("not a key"), null);
  assert.equal(parsePublicKey(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" })), null, "Ed25519 only");
});
