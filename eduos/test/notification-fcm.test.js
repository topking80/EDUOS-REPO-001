import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createFcmClient, createFcmPushAdapter } from "../src/notify-fcm.js";
import { decryptPushToken, encryptPushToken, hashPushToken } from "../src/notify-push-token.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" } });
const cfg = {
  fcmProjectId: "eduos-test-project", fcmClientEmail: "eduos-fcm@eduos-test-project.iam.gserviceaccount.com",
  fcmPrivateKey: privateKey, fcmTokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"), fcmTimeoutMs: 2000
};
const deviceToken = "fcm-registration-token-for-unit-test-1234567890";

test("FCM device tokens are authenticated-encrypted at rest and hash deterministically", () => {
  const encrypted = encryptPushToken(deviceToken, cfg);
  assert.notEqual(encrypted, deviceToken);
  assert.equal(decryptPushToken(encrypted, cfg), deviceToken);
  assert.equal(hashPushToken(deviceToken), hashPushToken(deviceToken));
  assert.notEqual(encryptPushToken(deviceToken, cfg), encrypted, "fresh random IV per encryption");
  assert.throws(() => decryptPushToken(encrypted, { ...cfg, fcmTokenEncryptionKey: Buffer.alloc(32, 8).toString("base64") }));
  assert.throws(() => hashPushToken("bad token with spaces"));
});

test("FCM HTTP v1 exchanges a signed service-account assertion and sends generic content", async () => {
  const calls = [];
  const client = createFcmClient(cfg, async (url, options) => {
    calls.push({ url, options });
    if (url === "https://oauth2.googleapis.com/token")
      return { ok: true, async json() { return { access_token: "unit-test-access-token", expires_in: 3600 }; } };
    return { ok: true, async json() { return { name: "projects/eduos-test-project/messages/123" }; } };
  });
  await client.send(deviceToken, "12345678-1234-1234-1234-123456789abc");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.match(calls[0].options.body.get("assertion"), /^eyJ/);
  assert.match(calls[1].url, /projects\/eduos-test-project\/messages:send$/);
  assert.equal(calls[1].options.headers.authorization, "Bearer unit-test-access-token");
  const payload = JSON.parse(calls[1].options.body);
  assert.equal(payload.message.token, deviceToken);
  assert.match(payload.message.notification.body, /new notification/);
  assert.doesNotMatch(JSON.stringify(payload), /student|incident|guardian/i);
});

test("FCM adapter reports provider acceptance without claiming device display", async () => {
  const encrypted = encryptPushToken(deviceToken, cfg);
  const adapter = createFcmPushAdapter({ async send(token, id) {
    assert.equal(token, deviceToken);
    assert.equal(id, "12345678-1234-1234-1234-123456789abc");
    return { name: "projects/eduos-test-project/messages/123" };
  } }, cfg);
  const result = await adapter.send({ id: "12345678-1234-1234-1234-123456789abc", recipient_push_tokens: [encrypted] });
  assert.equal(result.status, "accepted");
  assert.match(result.note, /display is not confirmed/);
});

test("FCM adapter identifies unregistered tokens for revocation", async () => {
  const encrypted = encryptPushToken(deviceToken, cfg);
  const adapter = createFcmPushAdapter({ async send() {
    const error = new Error("provider error"); error.status = 404; error.providerCode = "UNREGISTERED"; throw error;
  } }, cfg);
  const result = await adapter.send({ id: "12345678-1234-1234-1234-123456789abc", recipient_push_tokens: [encrypted] });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.invalidTokenHashes, [hashPushToken(deviceToken)]);
});

test("FCM adapter skips recipients with no active device tokens", async () => {
  const adapter = createFcmPushAdapter({ async send() { throw new Error("should not send"); } }, cfg);
  assert.equal((await adapter.send({ id: "12345678-1234-1234-1234-123456789abc", recipient_push_tokens: [] })).status, "skipped");
});
