import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ltiConfigFingerprint, validLtiConfig, launchClaims, loadPlatformKey, AGS_SCORE_SCOPE, AGS_LINEITEM_READ_SCOPE } from "../src/lti.js";

const base = { clientId: "tool", deploymentId: "dep", loginUrl: "https://tool.example/login", redirectUris: ["https://tool.example/launch"], targetLinkUri: "https://tool.example/launch" };

test("grade passback needs the tool's keys and is covered by the approval", () => {
  const ags = { ...base, jwksUrl: "https://tool.example/jwks", assignmentGrades: true };
  assert.equal(validLtiConfig(ags), true);
  assert.equal(validLtiConfig({ ...base, assignmentGrades: true }), false);
  assert.equal(validLtiConfig({ ...ags, assignmentGrades: "yes" }), false);
  assert.notEqual(ltiConfigFingerprint(ags, "none"), ltiConfigFingerprint({ ...ags, assignmentGrades: false, deepLinkingUrl: "https://tool.example/dl" }, "none"));
  // Earlier registrations (LTI-02 / LTI-03) keep their fingerprints.
  const nr = { ...base, jwksUrl: "https://tool.example/jwks", namesRoles: true };
  const old = crypto.createHash("sha256").update(JSON.stringify([nr.clientId, nr.deploymentId, nr.loginUrl, [...nr.redirectUris], nr.targetLinkUri, "roster_basic",
    { deepLinkingUrl: undefined, jwksUrl: nr.jwksUrl, namesRoles: true }])).digest("base64url");
  assert.equal(ltiConfigFingerprint(nr, "roster_basic"), old);
});

test("a placed activity with grades on offers only its own line item, read and score", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = loadPlatformKey(privateKey.export({ type: "pkcs8", format: "pem" }));
  const app = { id: "a1", data_sharing_scope: "none", integration_config: { ...base, jwksUrl: "https://tool.example/jwks", assignmentGrades: true } };
  const common = { key, issuer: "https://eduos.example", app, launch: { role: "pupil" }, user: { id: "u1" }, nonce: "n", content: { id: "cl1", title: "Quiz", url: "https://tool.example/q" } };
  const on = launchClaims({ ...common, ags: { lineitem: "https://eduos.example/lti/ags/cl1/lineitem" } });
  assert.deepEqual(on["https://purl.imsglobal.org/spec/lti-ags/claim/endpoint"], { scope: [AGS_LINEITEM_READ_SCOPE, AGS_SCORE_SCOPE], lineitem: "https://eduos.example/lti/ags/cl1/lineitem" });
  assert.equal(on["https://purl.imsglobal.org/spec/lti-ags/claim/endpoint"].lineitems, undefined, "tools can't create line items");
  assert.equal(launchClaims(common)["https://purl.imsglobal.org/spec/lti-ags/claim/endpoint"], undefined);
});
