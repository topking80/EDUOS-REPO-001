import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ltiConfigFingerprint, validLtiConfig, verifyToolJwt, acceptContentItems, launchClaims, loadPlatformKey, decodeJwt } from "../src/lti.js";

const base = { clientId: "tool", deploymentId: "dep", loginUrl: "https://tool.example/login", redirectUris: ["https://tool.example/launch"], targetLinkUri: "https://tool.example/launch" };
const DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";

function toolKey(bits = 2048, kid = "k1") {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: bits });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const sign = (claims, header = { alg: "RS256", typ: "JWT", kid }) => {
    const h = Buffer.from(JSON.stringify(header)).toString("base64url"), p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
  };
  return { jwks: { keys: [jwk] }, sign };
}

test("registrations without Deep Linking keep their existing fingerprint (and approval)", () => {
  const old = crypto.createHash("sha256").update(JSON.stringify([base.clientId, base.deploymentId, base.loginUrl, [...base.redirectUris], base.targetLinkUri, "none"])).digest("base64url");
  assert.equal(ltiConfigFingerprint(base, "none"), old);
  const dl = { ...base, deepLinkingUrl: "https://tool.example/dl", jwksUrl: "https://tool.example/jwks" };
  assert.notEqual(ltiConfigFingerprint(dl, "none"), old, "adding Deep Linking needs approval again");
  assert.notEqual(ltiConfigFingerprint({ ...dl, jwksUrl: "https://tool.example/other" }, "none"), ltiConfigFingerprint(dl, "none"), "the key URL is covered");
});

test("Deep Linking needs both its URL and the tool's key set URL", () => {
  assert.equal(validLtiConfig(base), true);
  assert.equal(validLtiConfig({ ...base, deepLinkingUrl: "https://tool.example/dl", jwksUrl: "https://tool.example/jwks" }), true);
  assert.equal(validLtiConfig({ ...base, deepLinkingUrl: "https://tool.example/dl" }), false);
  assert.equal(validLtiConfig({ ...base, jwksUrl: "https://tool.example/jwks" }), false);
  assert.equal(validLtiConfig({ ...base, deepLinkingUrl: "javascript:alert(1)", jwksUrl: "https://tool.example/jwks" }), false);
});

test("tool responses are verified: RS256 with a registered key, issuer, audience, time", () => {
  const { jwks, sign } = toolKey(), now = 2_000_000_000;
  const good = { iss: "tool", aud: "https://eduos.example", iat: now, exp: now + 300, nonce: "n" };
  const opts = { clientId: "tool", issuer: "https://eduos.example", now };
  assert.equal(verifyToolJwt(sign(good), jwks, opts).iss, "tool");
  assert.equal(verifyToolJwt(sign({ ...good, aud: ["https://eduos.example"] }), jwks, opts).iss, "tool");
  const code = (jwt, k = jwks, o = opts) => { try { verifyToolJwt(jwt, k, o); return "ok"; } catch (e) { return e.code; } };
  assert.equal(code(sign({ ...good, iss: "someone-else" })), "jwt_issuer_mismatch");
  assert.equal(code(sign({ ...good, aud: "https://other.example" })), "jwt_audience_mismatch");
  assert.equal(code(sign({ ...good, exp: now - 120 })), "jwt_expired");
  assert.equal(code(sign({ ...good, iat: now + 600 })), "jwt_iat_invalid");
  assert.equal(code(sign({ ...good, nonce: undefined })), "jwt_nonce_missing");
  assert.equal(code(sign(good, { alg: "HS256", kid: "k1" })), "jwt_algorithm_not_allowed");
  assert.equal(code(sign(good, { alg: "none", kid: "k1" })), "jwt_algorithm_not_allowed");
  assert.equal(code(sign(good, { alg: "RS256", kid: "unknown" })), "jwt_key_not_found");
  assert.equal(code(toolKey().sign(good)), "jwt_signature_invalid", "signed by another key with the same kid");
  const tampered = sign(good).split("."); tampered[1] = Buffer.from(JSON.stringify({ ...good, iss: "tool", aud: "https://eduos.example", sub: "x" })).toString("base64url");
  assert.equal(code(tampered.join(".")), "jwt_signature_invalid");
  const weak = toolKey(1024);
  assert.equal(code(weak.sign(good), weak.jwks), "jwt_signature_invalid", "keys under 2048 bits are refused");
  assert.equal(decodeJwt("not.a.jwt!"), null);
});

test("only resource links to the tool's own site are accepted", () => {
  const cfg = { ...base, deepLinkingUrl: "https://tool.example/dl", jwksUrl: "https://tool.example/jwks" };
  const { accepted, skipped } = acceptContentItems([
    { type: "ltiResourceLink", title: "Fractions practice", url: "https://tool.example/activity/7", custom: { level: "3" }, lineItem: { scoreMaximum: 10 } },
    { type: "ltiResourceLink" },
    { type: "link", url: "https://tool.example/x" },
    { type: "ltiResourceLink", url: "https://evil.example/phish" },
    { type: "ltiResourceLink", url: "http://tool.example/insecure" },
    { type: "ltiResourceLink", url: "https://tool.example/x", custom: { "bad key": "v" } },
    { type: "html", html: "<script>" }
  ], cfg);
  assert.deepEqual(accepted.map(x => [x.title, x.url, x.custom, x.lineItemIgnored]), [
    ["Fractions practice", "https://tool.example/activity/7", { level: "3" }, true],
    ["Activity", "https://tool.example/launch", {}, false]]);
  assert.deepEqual(skipped, ["type_not_accepted", "url_not_allowed", "url_not_allowed", "custom_invalid", "type_not_accepted"]);
  assert.throws(() => acceptContentItems(Array(21).fill({ type: "ltiResourceLink" }), cfg), { code: "too_many_content_items" });
  assert.deepEqual(acceptContentItems(undefined, cfg).accepted, []);
});

test("Deep Linking requests carry settings and no resource link; placed links carry their own", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = loadPlatformKey(privateKey.export({ type: "pkcs8", format: "pem" }));
  const app = { id: "app-1", data_sharing_scope: "none", integration_config: { ...base, deepLinkingUrl: "https://tool.example/dl", jwksUrl: "https://tool.example/jwks" } };
  const common = { key, issuer: "https://eduos.example", app, launch: { role: "teacher" }, user: { id: "u1" }, nonce: "n" };
  const dl = launchClaims({ ...common, deepLinking: { returnUrl: "https://eduos.example/lti/deep-link/return", data: "opaque", title: "Add to: Week 3" } });
  assert.equal(dl["https://purl.imsglobal.org/spec/lti/claim/message_type"], "LtiDeepLinkingRequest");
  assert.equal(dl["https://purl.imsglobal.org/spec/lti/claim/target_link_uri"], "https://tool.example/dl");
  assert.deepEqual(dl[`${DL}deep_linking_settings`].accept_types, ["ltiResourceLink"]);
  assert.equal(dl[`${DL}deep_linking_settings`].data, "opaque");
  assert.equal(dl["https://purl.imsglobal.org/spec/lti/claim/resource_link"], undefined);
  const link = launchClaims({ ...common, launch: { role: "pupil" }, content: { id: "cl-1", title: "Fractions", url: "https://tool.example/activity/7", custom: { level: "3" } } });
  assert.equal(link["https://purl.imsglobal.org/spec/lti/claim/message_type"], "LtiResourceLinkRequest");
  assert.deepEqual(link["https://purl.imsglobal.org/spec/lti/claim/resource_link"], { id: "cl-1", title: "Fractions" });
  assert.equal(link["https://purl.imsglobal.org/spec/lti/claim/target_link_uri"], "https://tool.example/activity/7");
  assert.deepEqual(link["https://purl.imsglobal.org/spec/lti/claim/custom"], { level: "3" });
});
