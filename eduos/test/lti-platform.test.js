import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  loadPlatformKey, assertPlatformRsaKey, makeHint, readHint, consumeHint, pairwiseSub,
  launchClaims, validLtiConfig
} from "../src/lti.js";

const privatePem = () => crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
}).privateKey;

test("LTI signing-key policy rejects non-RSA and sub-2048-bit key metadata", () => {
  assert.throws(() => assertPlatformRsaKey({ asymmetricKeyType: "ec", asymmetricKeyDetails: {} }), /must be RSA/);
  assert.throws(() => assertPlatformRsaKey({ asymmetricKeyType: "rsa", asymmetricKeyDetails: { modulusLength: 1024 } }), /at least 2048 bits/);
  assert.doesNotThrow(() => assertPlatformRsaKey({ asymmetricKeyType: "rsa", asymmetricKeyDetails: { modulusLength: 2048 } }));
});

test("LTI platform key accepts RSA and publishes a matching RS256 JWKS key", () => {
  const key = loadPlatformKey(privatePem());
  assert.equal(key.jwks.keys.length, 1);
  assert.equal(key.jwks.keys[0].alg, "RS256");
  assert.equal(key.jwks.keys[0].kid, key.kid);
  assert.equal(loadPlatformKey(""), null);
  assert.throws(() => loadPlatformKey("not a PEM key"));
});


test("LTI signing-key rotation publishes the prior public key and preserves pairwise subjects", () => {
  const oldPem = privatePem();
  const newPem = privatePem();
  const subjectSecret = "stable-district-controlled-subject-secret-32+";
  const oldKey = loadPlatformKey(oldPem, "", subjectSecret);
  const rotated = loadPlatformKey(newPem, oldPem, subjectSecret);
  assert.equal(rotated.jwks.keys.length, 2);
  assert.equal(rotated.jwks.keys[0].kid, rotated.kid);
  assert.equal(rotated.jwks.keys[1].kid, oldKey.kid);
  assert.notEqual(rotated.kid, oldKey.kid);
  assert.equal(pairwiseSub(oldKey, "tool-a", "user-1"), pairwiseSub(rotated, "tool-a", "user-1"));
  assert.throws(() => loadPlatformKey(newPem, newPem, subjectSecret), /must differ/);
  assert.throws(() => loadPlatformKey(newPem, oldPem), /SUBJECT_KEY is required/);
  assert.throws(() => loadPlatformKey(newPem, "", "short"), /at least 32 bytes/);
});

test("launch hints are signed, expiring, bounded and tamper evident", () => {
  const key = loadPlatformKey(privatePem());
  const hint = makeHint(key, { launchId: "launch-1", districtId: "district-1" }, 1000);
  assert.deepEqual(readHint(key, hint, 1001), {
    launchId: "launch-1", districtId: "district-1", exp: 301000
  });
  assert.equal(readHint(key, hint, 301001), null);
  assert.equal(hint.includes("district-1"), false);
  assert.equal(hint.includes("launch-1"), false);
  const parts = hint.split(".");
  const ciphertext = parts[2];
  parts[2] = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
  assert.equal(readHint(key, parts.join("."), 1001), null);
  assert.equal(readHint(key, "x".repeat(2049), 1001), null);
});

test("launch identifiers can be consumed only once within the process", () => {
  const id = crypto.randomUUID();
  assert.equal(consumeHint(id, 1000), true);
  assert.equal(consumeHint(id, 1001), false);
  assert.equal(consumeHint("expired-" + id, 1000), true);
  assert.equal(consumeHint("expired-" + id, 301001), true);
});

test("pairwise subjects differ across tools and remain stable within a tool", () => {
  const key = loadPlatformKey(privatePem());
  const a = pairwiseSub(key, "tool-a", "user-1");
  assert.equal(a, pairwiseSub(key, "tool-a", "user-1"));
  assert.notEqual(a, pairwiseSub(key, "tool-b", "user-1"));
  assert.notEqual(a, pairwiseSub(key, "tool-a", "user-2"));
});

test("launch claims limit identity and context to the approved data scope", () => {
  const key = loadPlatformKey(privatePem());
  const base = {
    key, issuer: "https://eduos.example", app: { id: "app-1", integration_config: {
      clientId: "canvas-client", deploymentId: "deployment-1", targetLinkUri: "https://tool.example/launch"
    }, data_sharing_scope: "none" },
    launch: { role: "teacher", districtId: "district-1" },
    user: { id: "user-1", display_name: "Teacher", email: "teacher@example.test" },
    school: { id: "school-1", name: "School" }, nonce: "nonce-1", now: 1000
  };
  const minimal = launchClaims(base);
  assert.equal(minimal.aud, "canvas-client");
  assert.equal(minimal.nonce, "nonce-1");
  assert.equal(minimal.name, undefined);
  assert.equal(minimal.email, undefined);
  assert.equal(minimal["https://purl.imsglobal.org/spec/lti/claim/context"], undefined);
  const platformClaim = "https://purl.imsglobal.org/spec/lti/claim/tool_platform";
  assert.equal(minimal[platformClaim].guid, launchClaims({ ...base, launch: { ...base.launch, districtId: "district-2" } })[platformClaim].guid);
  assert.notEqual(minimal[platformClaim].guid, "district-1");

  const identity = launchClaims({ ...base, app: { ...base.app, data_sharing_scope: "identity" } });
  assert.equal(identity.name, "Teacher");
  assert.equal(identity.email, "teacher@example.test");
  assert.equal(identity["https://purl.imsglobal.org/spec/lti/claim/context"], undefined);
});

test("LTI tool configuration requires HTTPS endpoints and bounded redirect lists", () => {
  const valid = {
    clientId: "canvas-client", deploymentId: "deployment-1",
    loginUrl: "https://canvas.example/login",
    redirectUris: ["https://eduos.example/lti/authorize"],
    targetLinkUri: "https://eduos.example/lti/launch"
  };
  assert.equal(validLtiConfig(valid), true);
  assert.equal(validLtiConfig({ ...valid, redirectUris: ["http://evil.example/callback"] }), false);
  assert.equal(validLtiConfig({ ...valid, redirectUris: [] }), false);
  assert.equal(validLtiConfig({ ...valid, loginUrl: "javascript:alert(1)" }), false);
  assert.equal(validLtiConfig({ ...valid, targetLinkUri: undefined }), false);
  assert.equal(validLtiConfig({ ...valid, targetLinkUri: "http://tool.example/launch" }), false);
  assert.equal(validLtiConfig({ ...valid, loginUrl: "http://localhost:3000/login" }), true);
  assert.equal(validLtiConfig({ ...valid, loginUrl: "http://localhost:3000/login" }, { allowInsecureLoopback: false }), false);
  assert.equal(validLtiConfig({ ...valid, targetLinkUri: "https://user:pass@tool.example/launch" }), false);
  assert.equal(validLtiConfig({ ...valid, targetLinkUri: "https://tool.example/launch#fragment" }), false);
  assert.equal(validLtiConfig({ ...valid, redirectUris: ["https://tool.example/callback#fragment"] }), false);
});


test("LTI Core fails closed for roster, grade, attendance and unknown scopes", () => {
  const key = loadPlatformKey(privatePem());
  const base = {
    key, issuer: "https://eduos.example",
    app: { id: "app-1", integration_config: { clientId: "canvas-client", deploymentId: "deployment-1", targetLinkUri: "https://tool.example/launch" }, data_sharing_scope: "none" },
    launch: { role: "teacher", districtId: "district-1" },
    user: { id: "user-1", display_name: "Teacher", email: "teacher@example.test" },
    school: { id: "school-private", name: "Private School Name" }, nonce: "nonce-1", now: 1000
  };
  for (const scope of ["roster_basic", "roster_full", "grades", "attendance", "unexpected"]) {
    const claims = launchClaims({ ...base, app: { ...base.app, data_sharing_scope: scope } });
    assert.equal(claims.name, undefined, scope);
    assert.equal(claims.email, undefined, scope);
    assert.equal(claims["https://purl.imsglobal.org/spec/lti/claim/context"], undefined, scope);
  }
  const identity = launchClaims({ ...base, app: { ...base.app, data_sharing_scope: "identity" } });
  assert.equal(identity.name, "Teacher");
  assert.equal(identity.email, "teacher@example.test");
  assert.equal(identity["https://purl.imsglobal.org/spec/lti/claim/context"], undefined);
});
