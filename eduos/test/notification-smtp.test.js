import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("SMTP adapter completes a TLS-authenticated SMTP conversation", async () => {
  class FakeSocket extends EventEmitter {
    writes = [];
    setTimeout() {}
    end() {}
    destroy(error) { if (error) this.emit("error", error); }
    write(value) {
      this.writes.push(value);
      let response = null;
      if (value.startsWith("EHLO ")) response = "250-smtp.example.edu\\r\\n250 AUTH PLAIN\\r\\n";
      else if (value.startsWith("AUTH PLAIN ")) response = "235 authenticated\\r\\n";
      else if (value.startsWith("MAIL FROM:")) response = "250 sender ok\\r\\n";
      else if (value.startsWith("RCPT TO:")) response = "250 recipient ok\\r\\n";
      else if (value === "DATA\\r\\n") response = "354 send content\\r\\n";
      else if (value.endsWith("\\r\\n.\\r\\n")) response = "250 queued\\r\\n";
      else if (value === "QUIT\\r\\n") response = "221 bye\\r\\n";
      if (response) queueMicrotask(() => this.emit("data", Buffer.from(response)));
      return true;
    }
  }
  const socket = new FakeSocket();
  let options;
  const adapter = createSmtpAdapter({
    config: { notifySmtpHost: "smtp.example.edu", notifySmtpPort: 465, notifySmtpFrom: "alerts@example.edu",
      notifySmtpEhlo: "eduos.example.edu", notifySmtpUsername: "user", notifySmtpPassword: "secret", notifySmtpTimeoutMs: 5000 },
    connect: value => { options = value; queueMicrotask(() => socket.emit("data", Buffer.from("220 ready\\r\\n"))); return socket; }
  });
  const result = await adapter.send({ id: "12345678-1234-1234-1234-123456789abc", recipient_email: "family@example.net" });
  assert.equal(result.status, "delivered");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.port, 465);
  assert.ok(socket.writes.some(value => value.startsWith("AUTH PLAIN ")));
  assert.ok(socket.writes.some(value => value.includes("You have a new EduOS notification.")));
  assert.ok(!socket.writes.some(value => value.includes("secret") && !value.startsWith("AUTH PLAIN ")));
});
