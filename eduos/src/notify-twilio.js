// Twilio Verify and Messaging adapters. Credentials are never logged.
import { config } from "./config.js";

const E164 = /^\+[1-9]\d{7,14}$/;
const messagingBase = "https://api.twilio.com/2010-04-01/Accounts/";
const verifyBase = "https://verify.twilio.com/v2/Services/";

function classify(status) {
  if (status === 429 || status >= 500) return "pending";
  if (status >= 400) return "failed";
  return "pending";
}

export function isE164(value) { return typeof value === "string" && E164.test(value); }

export function createTwilioClient(cfg = config, request = fetch) {
  const ready = Boolean(cfg.twilioAccountSid && cfg.twilioAuthToken);
  async function post(url, fields, externalSignal = null) {
    if (!ready) throw new Error("Twilio is not configured");
    const form = new URLSearchParams(fields);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error("Twilio request deadline exceeded")), cfg.twilioTimeoutMs);
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await request(url, {
        method: "POST",
        headers: {
          authorization: "Basic " + Buffer.from(cfg.twilioAccountSid + ":" + cfg.twilioAuthToken).toString("base64"),
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json"
        },
        body: form,
        signal: controller.signal
      });
      let body = {};
      try { body = await response.json(); } catch {}
      if (!response.ok) {
        const error = new Error("Twilio request rejected");
        error.status = response.status;
        error.providerCode = Number(body.code) || null;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(deadline);
      externalSignal?.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    async startVerification(phone) {
      if (!isE164(phone)) throw new TypeError("phone must be E.164");
      return post(verifyBase + cfg.twilioVerifyServiceSid + "/Verifications", { To: phone, Channel: "sms" });
    },
    async checkVerification(phone, code) {
      if (!isE164(phone) || typeof code !== "string" || !/^\d{4,10}$/.test(code)) throw new TypeError("invalid verification input");
      return post(verifyBase + cfg.twilioVerifyServiceSid + "/VerificationCheck", { To: phone, Code: code });
    },
    async sendSms(phone, body, id, signal = null) {
      if (!isE164(phone)) throw new TypeError("phone must be E.164");
      if (typeof id !== "string" || !/^[0-9a-f-]{16,64}$/i.test(id)) throw new TypeError("notification id is invalid");
      const fields = { To: phone, Body: body };
      if (cfg.twilioMessagingServiceSid) fields.MessagingServiceSid = cfg.twilioMessagingServiceSid;
      else fields.From = cfg.twilioFromNumber;
      return post(messagingBase + cfg.twilioAccountSid + "/Messages.json", fields, signal);
    }
  });
}

export function createTwilioSmsAdapter(client = createTwilioClient()) {
  return Object.freeze({
    name: "twilio",
    async send(row, _log, { signal } = {}) {
      if (!isE164(row.recipient_phone)) return { status: "failed", note: "verified recipient phone is missing or invalid" };
      try {
        await client.sendSms(row.recipient_phone,
          "You have a new EduOS notification. Open the EduOS app to read it.", row.id, signal);
        // Twilio accepted the message for processing. This is not a carrier
        // delivery receipt; the outbox note deliberately preserves that nuance.
        return { status: "accepted", note: "accepted by Twilio; carrier delivery is not confirmed" };
      } catch (error) {
        const status = Number(error.status) || 0;
        return { status: classify(status), note: status ? "Twilio rejected the request (" + status + ")" : "Twilio temporarily unavailable" };
      }
    }
  });
}
