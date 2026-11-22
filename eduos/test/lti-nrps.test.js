import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ltiConfigFingerprint, validLtiConfig, verifyClientAssertion, launchClaims, loadPlatformKey, pairwiseContext, LTI_SCOPES } from "../src/lti.js";

const base = { clientId: "tool", deploymentId: "dep", loginUrl: "https://tool.example/login", redirectUris: ["https://tool.example/launch"], targetLinkUri: "https://tool.example/launch" };
const keys = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sign = c => { const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k" })).toString("base64url"), p = Buffer.from(JSON.stringify(c)).toString("base64url");
    return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`; };
  return { jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k" }] }, sign };
};

test("class lists need NRPS registered with the tool's keys, and roster_basic only then", () => {
  assert.deepEqual([...LTI_SCOPES], ["none", "identity", "roster_basic"]);
  assert.equal(validLtiConfig({ ...base, namesRoles: true, jwksUrl: "https://tool.example/jwks" }), true);
  assert.equal(validLtiConfig({ ...base, namesRoles: true }), false, "NRPS needs the tool's keys");
  assert.equal(validLtiConfig({ ...base, jwksUrl: "https://tool.example/jwks" }), false, "keys alone serve nothing");
  assert.equal(validLtiConfig({ ...base, namesRoles: "yes", jwksUrl: "https://tool.example/jwks" }), false);
  assert.throws(() => ltiConfigFingerprint(base, "roster_basic"), TypeError);
  assert.throws(() => ltiConfigFingerprint({ ...base, namesRoles: true, jwksUrl: "https://tool.example/jwks" }, "roster_full"), TypeError);
  const nrps = { ...base, namesRoles: true, jwksUrl: "https://tool.example/jwks" };
  assert.notEqual(ltiConfigFingerprint(nrps, "roster_basic"), ltiConfigFingerprint({ ...nrps, namesRoles: false }, "identity"));
  // LTI-02 registrations keep their fingerprint (and approval).
  const dl = { ...base, deepLinkingUrl: "https://tool.example/dl", jwksUrl: "https://tool.example/jwks" };
  const old = crypto.createHash("sha256").update(JSON.stringify([dl.clientId, dl.deploymentId, dl.loginUrl, [...dl.redirectUris], dl.targetLinkUri, "none",
    { deepLinkingUrl: dl.deepLinkingUrl, jwksUrl: dl.jwksUrl }])).digest("base64url");
  assert.equal(ltiConfigFingerprint(dl, "none"), old);
});

test("client assertions: signed by the tool, for this token URL, short-lived, with a jti", () => {
  const { jwks, sign } = keys(), now = 2_000_000_000, tokenUrl = "https://eduos.example/lti/token/d/a";
  const good = { iss: "tool", sub: "tool", aud: tokenUrl, iat: now, exp: now + 300, jti: "abcdefgh-1" };
  assert.equal(verifyClientAssertion(sign(good), jwks, { clientId: "tool", tokenUrl, now }).jti, "abcdefgh-1");
  const code = c => { try { verifyClientAssertion(sign(c), jwks, { clientId: "tool", tokenUrl, now }); return "ok"; } catch (e) { return e.code; } };
  assert.equal(code({ ...good, sub: "someone" }), "assertion_subject_mismatch");
  assert.equal(code({ ...good, aud: "https://eduos.example/lti/token/d/other" }), "jwt_audience_mismatch");
  assert.equal(code({ ...good, aud: "https://eduos.example" }), "jwt_audience_mismatch", "the platform issuer alone isn't this token URL");
  assert.equal(code({ ...good, exp: now + 3600 }), "assertion_lifetime_too_long");
  assert.equal(code({ ...good, iat: now - 600, exp: now + 300 }), "assertion_lifetime_too_long", "lifetime is bounded from iat, not just from now");
  assert.equal(code({ ...good, iat: now + 30, exp: now + 20 }), "assertion_lifetime_too_long", "expiration must follow issuance");
  assert.equal(code({ ...good, jti: undefined }), "assertion_jti_missing");
  assert.equal(code({ ...good, iss: "other" }), "jwt_issuer_mismatch");
});

test("roster_basic counts for claims only with NRPS registered; context ids differ per tool", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = loadPlatformKey(privateKey.export({ type: "pkcs8", format: "pem" }));
  const common = { key, issuer: "https://eduos.example", launch: { role: "pupil" }, user: { id: "u1", display_name: "Ana", email: "ana@x" }, nonce: "n",
    content: { id: "cl", title: "Quiz", url: "https://tool.example/q" }, context: { id: "course-1", title: "Reading 3" } };
  const off = launchClaims({ ...common, app: { id: "a1", data_sharing_scope: "roster_basic", integration_config: base } });
  assert.equal(off.name, undefined, "fails closed without NRPS");
  const on = launchClaims({ ...common, app: { id: "a1", data_sharing_scope: "roster_basic", integration_config: { ...base, namesRoles: true, jwksUrl: "https://tool.example/jwks" } },
    nrps: { url: "https://eduos.example/lti/nrps/s1/memberships" } });
  assert.equal(on.name, "Ana");
  assert.equal(on["https://purl.imsglobal.org/spec/lti/claim/context"].id, pairwiseContext(key, "a1", "course-1"));
  assert.notEqual(pairwiseContext(key, "a1", "course-1"), pairwiseContext(key, "a2", "course-1"));
  assert.equal(on["https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice"].context_memberships_url, "https://eduos.example/lti/nrps/s1/memberships");
});
