import test from "node:test";
import assert from "node:assert/strict";
import { createTwilioClient, createTwilioSmsAdapter, isE164 } from "../src/notify-twilio.js";

const config = {
  twilioAccountSid: "AC" + "a".repeat(32), twilioAuthToken: "test-secret",
  twilioVerifyServiceSid: "VA" + "b".repeat(32), twilioMessagingServiceSid: "MG" + "c".repeat(32),
  twilioFromNumber: "", twilioTimeoutMs: 1000
};

test("E.164 phone validation rejects local and malformed values", () => {
  assert.equal(isE164("+14155552671"), true);
  for (const value of ["4155552671", "+0123456789", "+1 4155552671", "+123", null]) assert.equal(isE164(value), false);
});

test("Twilio Verify start and check use authenticated form requests", async () => {
  const calls = [];
  const client = createTwilioClient(config, async (url, options) => {
    calls.push({ url, options, fields: Object.fromEntries(options.body.entries()) });
    return { ok: true, async json() { return { status: calls.length === 1 ? "pending" : "approved" }; } };
  });
  assert.equal((await client.startVerification("+14155552671")).status, "pending");
  assert.equal((await client.checkVerification("+14155552671", "123456")).status, "approved");
  assert.match(calls[0].url, /Services\/VA[a-f0-9]{32}\/Verifications\.json$/);
  assert.equal(calls[0].fields.To, "+14155552671");
  assert.equal(calls[0].fields.Channel, "sms");
  assert.equal(calls[1].fields.Code, "123456");
  assert.match(calls[0].options.headers.authorization, /^Basic /);
  assert.equal(calls[0].options.headers["content-type"], "application/x-www-form-urlencoded");
});

test("Twilio Verify rejects malformed phone numbers and codes before network access", async () => {
  let called = false;
  const client = createTwilioClient(config, async () => { called = true; throw new Error("unexpected"); });
  await assert.rejects(client.startVerification("555-0100"), /E.164/);
  await assert.rejects(client.checkVerification("+14155552671", "abc"), /verification input/);
  assert.equal(called, false);
});

test("Twilio SMS sends generic content through the configured Messaging Service", async () => {
  let sent;
  const client = createTwilioClient(config, async (url, options) => {
    sent = { url, fields: Object.fromEntries(options.body.entries()) };
    return { ok: true, async json() { return { sid: "SM" + "d".repeat(32), status: "queued" }; } };
  });
  const adapter = createTwilioSmsAdapter(client);
  const result = await adapter.send({ id: "12345678-1234-1234-1234-123456789abc", recipient_phone: "+14155552671" });
  assert.equal(result.status, "accepted");
  assert.match(result.note, /accepted by Twilio/);
  assert.match(sent.url, /\/Messages\.json$/);
  assert.equal(sent.fields.To, "+14155552671");
  assert.equal(sent.fields.MessagingServiceSid, config.twilioMessagingServiceSid);
  assert.match(sent.fields.Body, /new EduOS notification/);
  assert.doesNotMatch(sent.fields.Body, /student|incident|guardian/i);
});

test("Twilio transient failures retry and permanent rejections stop", async () => {
  const transient = createTwilioSmsAdapter({ async sendSms() { const e = new Error("private"); e.status = 503; throw e; } });
  const permanent = createTwilioSmsAdapter({ async sendSms() { const e = new Error("private"); e.status = 400; throw e; } });
  assert.equal((await transient.send({ id: "12345678-1234-1234-1234-123456789abc", recipient_phone: "+14155552671" })).status, "pending");
  assert.equal((await permanent.send({ id: "12345678-1234-1234-1234-123456789abc", recipient_phone: "+14155552671" })).status, "failed");
});
