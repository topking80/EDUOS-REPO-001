import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SignJWT, createLocalJWKSet, jwtVerify } from "jose";
import { launchClaims, loadPlatformKey, signJwt, verifyToolJwt } from "../src/lti.js";

const ISSUER = "https://eduos.example";
const CLIENT_ID = "tool-client";
const DEPLOYMENT_ID = "district-deployment";
const NOW = 2_000_000_000;

function platformKey() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  return loadPlatformKey(privateKey, "", "stable-interoperability-subject-secret-32-bytes");
}

function toolKey() {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...crypto.createPublicKey(pair.publicKey).export({ format: "jwk" }), kid: "independent-tool-key", alg: "RS256", use: "sig" };
  return { privateKey: pair.privateKey, jwks: { keys: [jwk] } };
}

test("EduOS platform ID token verifies with an independent JOSE verifier and published JWKS", async () => {
  const key = platformKey();
  const app = {
    id: "app-1",
    integration_config: {
      clientId: CLIENT_ID,
      deploymentId: DEPLOYMENT_ID,
      targetLinkUri: "https://tool.example/launch"
    },
    data_sharing_scope: "identity"
  };
  const claims = launchClaims({
    key, issuer: ISSUER, app,
    launch: { role: "teacher" },
    user: { id: "teacher-1", display_name: "Test Teacher", email: "teacher@example.test" },
    school: { id: "school-private", name: "Private School" },
    nonce: "tool-created-nonce", now: NOW
  });
  const token = signJwt(key, claims);
  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(key.jwks), {
    issuer: ISSUER, audience: CLIENT_ID, algorithms: ["RS256"], currentDate: new Date(NOW * 1000)
  });

  assert.equal(protectedHeader.alg, "RS256");
  assert.equal(protectedHeader.kid, key.kid);
  assert.equal(payload.nonce, "tool-created-nonce");
  assert.equal(payload.azp, CLIENT_ID);
  assert.equal(payload["https://purl.imsglobal.org/spec/lti/claim/version"], "1.3.0");
  assert.equal(payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"], DEPLOYMENT_ID);
  assert.equal(payload["https://purl.imsglobal.org/spec/lti/claim/message_type"], "LtiResourceLinkRequest");
  assert.equal(payload["https://purl.imsglobal.org/spec/lti/claim/target_link_uri"], "https://tool.example/launch");
  assert.equal(payload["https://purl.imsglobal.org/spec/lti/claim/resource_link"].id, "app-1");
  assert.equal(payload.name, "Test Teacher");
  assert.equal(payload["https://purl.imsglobal.org/spec/lti/claim/context"], undefined);
});

test("EduOS accepts an independently generated RS256 tool JWT using its registered JWKS", async () => {
  const { privateKey, jwks } = toolKey();
  const token = await new SignJWT({
    nonce: "eduos-created-nonce",
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingResponse",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": DEPLOYMENT_ID
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "independent-tool-key" })
    .setIssuer(CLIENT_ID)
    .setAudience(ISSUER)
    .setIssuedAt(NOW)
    .setExpirationTime(NOW + 300)
    .sign(privateKey);

  const verified = verifyToolJwt(token, jwks, {
    clientId: CLIENT_ID, issuer: ISSUER, now: NOW
  });
  assert.equal(verified.iss, CLIENT_ID);
  assert.equal(verified.aud, ISSUER);
  assert.equal(verified.nonce, "eduos-created-nonce");
  assert.equal(verified["https://purl.imsglobal.org/spec/lti/claim/message_type"], "LtiDeepLinkingResponse");
  assert.equal(verified["https://purl.imsglobal.org/spec/lti/claim/deployment_id"], DEPLOYMENT_ID);
});

test("independent JOSE verification rejects an altered EduOS token", async () => {
  const key = platformKey();
  const token = signJwt(key, {
    iss: ISSUER, aud: CLIENT_ID, iat: NOW, exp: NOW + 300, nonce: "nonce"
  });
  const [header, payload, signature] = token.split(".");
  const altered = Buffer.from(JSON.stringify({ iss: ISSUER, aud: "attacker-client", iat: NOW, exp: NOW + 300, nonce: "nonce" })).toString("base64url");
  await assert.rejects(
    jwtVerify(`${header}.${altered}.${signature}`, createLocalJWKSet(key.jwks), {
      issuer: ISSUER, audience: CLIENT_ID, algorithms: ["RS256"], currentDate: new Date(NOW * 1000)
    })
  );
});
