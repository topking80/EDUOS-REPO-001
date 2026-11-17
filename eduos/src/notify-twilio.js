// Twilio Verify and Messaging adapters. Credentials are never logged.
import { config } from "./config.js";

const E164 = /^\+[1-9]\d{7,14}$/;
const base = "https://api.twilio.com/2010-04-01/Accounts/";

function classify(status) {
  if (status === 429 || status >= 500) return "pending";
  if (status >= 400) return "failed";
  return "pending";
}

export function isE164(value) { return typeof value === "string" && E164.test(value); }

export function createTwilioClient(cfg = config, request = fetch) {
  const ready = Boolean(cfg.twilioAccountSid && cfg.twilioAuthToken);
  async function post(path, fields) {
    if (!ready) throw new Error("Twilio is not configured");
    const form = new URLSearchParams(fields);
    const response = await request(base + cfg.twilioAccountSid + path, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(cfg.twilioAccountSid + ":" + cfg.twilioAuthToken).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: form,
      signal: AbortSignal.timeout(cfg.twilioTimeoutMs)
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
  }
  return Object.freeze({
    async startVerification(phone) {
      if (!isE164(phone)) throw new TypeError("phone must be E.164");
      return post("/Services/" + cfg.twilioVerifyServiceSid + "/Verifications.json", { To: phone, Channel: "sms" });
    },
    async checkVerification(phone, code) {
      if (!isE164(phone) || typeof code !== "string" || !/^\d{4,10}$/.test(code)) throw new TypeError("invalid verification input");
      return post("/Services/" + cfg.twilioVerifyServiceSid + "/VerificationCheck.json", { To: phone, Code: code });
    },
    async sendSms(phone, body, id) {
      if (!isE164(phone)) throw new TypeError("phone must be E.164");
      if (typeof id !== "string" || !/^[0-9a-f-]{16,64}$/i.test(id)) throw new TypeError("notification id is invalid");
      const fields = { To: phone, Body: body };
      if (cfg.twilioMessagingServiceSid) fields.MessagingServiceSid = cfg.twilioMessagingServiceSid;
      else fields.From = cfg.twilioFromNumber;
      return post("/Messages.json", fields);
    }
  });
}

export function createTwilioSmsAdapter(client = createTwilioClient()) {
  return Object.freeze({
    name: "twilio",
    async send(row) {
      if (!isE164(row.recipient_phone)) return { status: "failed", note: "verified recipient phone is missing or invalid" };
      try {
        await client.sendSms(row.recipient_phone,
          "You have a new EduOS notification. Open the EduOS app to read it.", row.id);
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
