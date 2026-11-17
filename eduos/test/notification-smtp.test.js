import test from "node:test";
import assert from "node:assert/strict";
import { buildNotificationMessage, createSmtpAdapter } from "../src/notify-smtp.js";

test("SMTP notification contains only generic content and stable message id", () => {
  const message = buildNotificationMessage({ id: "12345678-1234-1234-1234-123456789abc", from: "alerts@example.edu", to: "family@example.net" });
  assert.match(message, /Message-ID: <12345678-1234-1234-1234-123456789abc@example\.edu>/);
  assert.match(message, /You have a new EduOS notification/);
  assert.doesNotMatch(message, /student|incident|guardian|diagnosis/i);
});

test("SMTP message rejects header injection and malformed recipients", () => {
  assert.throws(() => buildNotificationMessage({ id: "12345678-1234-1234-1234-123456789abc", from: "alerts@example.edu\r\nBcc:bad@example.net", to: "family@example.net" }));
  assert.throws(() => buildNotificationMessage({ id: "12345678-1234-1234-1234-123456789abc", from: "alerts@example.edu", to: "bad\r\n@example.net" }));
});

test("SMTP adapter refuses a missing recipient without opening a socket", async () => {
  let connected = false;
  const adapter = createSmtpAdapter({ config: { notifySmtpHost: "smtp.example.edu", notifySmtpPort: 465, notifySmtpFrom: "alerts@example.edu", notifySmtpTimeoutMs: 1000 }, connect: () => { connected = true; throw new Error("unexpected"); } });
  const result = await adapter.send({ id: "12345678-1234-1234-1234-123456789abc", recipient_email: null });
  assert.equal(result.status, "failed");
  assert.equal(connected, false);
});
