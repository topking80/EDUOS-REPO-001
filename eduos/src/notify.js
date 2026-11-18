// 32.4.0 notification outbox.
//
// enqueueNotifications() runs inside the caller's tenant transaction:
//  - one in-app row per recipient, delivered immediately (the role app reads
//    them from GET /api/notifications);
//  - one PENDING row per recipient for each external channel whose adapter is
//    enabled (NOTIFY_EMAIL_ADAPTER / NOTIFY_SMS_ADAPTER / NOTIFY_PUSH_ADAPTER).
//    External rows never carry the in-app title/body: they hold a generic
//    "You have a new EduOS notification" line, so no student-identifying text
//    can leave EduOS through email, SMS or push. They keep the reference ids
//    (ref_type/ref_id) so a delivery report can count them per incident. The
//    SMTP adapter receives a recipient address only after the user opts in.
// src/notify-dispatch.js (owner role, like the retention job) hands pending
// rows to the adapter. Email may use implicit-TLS SMTP after recipient opt-in;
// Twilio SMS requires a verified phone and explicit consent; push remains off/log.
import { config } from "./config.js";
import { createSmtpAdapter } from "./notify-smtp.js";
import { createTwilioSmsAdapter } from "./notify-twilio.js";

export const KINDS = ["announcement", "message", "transport", "christie", "moderation", "safety", "pickup"];
/** Feature modules register kinds whose migrations widen notification_outbox_kind_check. */
export function registerNotificationKind(kind) { if (!KINDS.includes(kind)) KINDS.push(kind); }
export const EXTERNAL_TEXT = "You have a new EduOS notification. Open the EduOS app to read it.";

export function enabledExternalChannels(cfg = config) {
  const out = [];
  if (cfg.notifyEmailAdapter !== "off") out.push("email");
  if (cfg.notifySmsAdapter !== "off") out.push("sms");
  if (cfg.notifyPushAdapter !== "off") out.push("push");
  return out;
}

const clip = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : null);

/** Rows to insert for one notification (pure, for unit tests). */
export function outboxRows({ districtId, schoolId = null, recipients, kind, title, body = null, refType = null, refId = null }, cfg = config) {
  if (!KINDS.includes(kind)) throw new TypeError(`unknown notification kind ${kind}`);
  const unique = [...new Set(recipients.filter(Boolean))];
  const rows = [];
  for (const recipient of unique) {
    rows.push({ districtId, schoolId, recipient, channel: "in_app", kind, title: clip(title, 160) || "Notification", body: clip(body, 500),
      refType, refId, status: "delivered" });
    for (const channel of enabledExternalChannels(cfg))
      rows.push({ districtId, schoolId, recipient, channel, kind, title: EXTERNAL_TEXT.slice(0, 160), body: null, refType, refId, status: "pending" });
  }
  return rows;
}

export async function enqueueNotifications(client, input, cfg = config) {
  const rows = outboxRows(input, cfg);
  // One statement per 500 rows (a school-wide SafetyOS notice can reach every family).
  for (let i = 0; i < rows.length; i += 500) {
    const b = rows.slice(i, i + 500), col = k => b.map(r => r[k] ?? null);
    await client.query(
      `INSERT INTO notification_outbox(district_id,school_id,recipient_user_id,channel,kind,title,body,ref_type,ref_id,status,delivered_at)
       SELECT d,s,u,c,k,t,bd,rt,ri,st,CASE WHEN st='delivered' THEN now() END
         FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::uuid[],$10::text[])
           AS x(d,s,u,c,k,t,bd,rt,ri,st)`,
      [col("districtId"), col("schoolId"), col("recipient"), col("channel"), col("kind"), col("title"), col("body"), col("refType"), col("refId"), col("status")]);
  }
  return rows.length;
}

// ---- adapters (used by src/notify-dispatch.js) ----
// An adapter's send() returns { status, note }:
//   delivered  delivery confirmed by the provider (sets delivered_at)
//   accepted   provider accepted the message; final device delivery is unknown
//   skipped    nothing was sent on purpose (channel off, dry run)
//   pending    a temporary failure: try again later (with back-off)
//   failed     a permanent failure: stop
// Anything else is treated as failed, so an adapter bug can't look like a delivery.
const smtpAdapter = createSmtpAdapter({ config });
const twilioSmsAdapter = createTwilioSmsAdapter();

export const ADAPTERS = Object.freeze({
  off: Object.freeze({ name: "off", async send() { return { status: "skipped", note: "adapter off" }; } }),
  smtp: smtpAdapter,
  twilio: twilioSmsAdapter,
  log: Object.freeze({ name: "log", async send(row, log = console.log) {
    // Dry run: record that a send would happen. Nothing leaves the server, and
    // only opaque ids are logged.
    log(`[notify:${row.channel}] dry run, nothing sent: notification ${row.id} for user ${row.recipient_user_id}`);
    return { status: "skipped", note: "dry run (log adapter): nothing was sent" };
  } })
});
export function adapterFor(channel, cfg = config) {
  const name = channel === "email" ? cfg.notifyEmailAdapter : channel === "sms" ? cfg.notifySmsAdapter : channel === "push" ? cfg.notifyPushAdapter : "off";
  return ADAPTERS[name] || ADAPTERS.off;
}

export const SEND_STATUSES = Object.freeze(["delivered", "accepted", "skipped", "pending", "failed"]);
export const MAX_ATTEMPTS = 5;
/** Seconds to wait before attempt n+1 after n failed attempts: 30 s, 1, 2, 4 min ... at most an hour. */
export const retryDelaySeconds = attempts => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));

/** What to record after one adapter attempt (pure, for unit tests). */
export function attemptOutcome(result, attemptsBefore) {
  const attempts = attemptsBefore + 1;
  let status = SEND_STATUSES.includes(result?.status) ? result.status : "failed";
  let note = typeof result?.note === "string" ? result.note.slice(0, 300) : null;
  if (!SEND_STATUSES.includes(result?.status)) note = `adapter returned an unknown status: ${String(result?.status).slice(0, 40)}`;
  if (status === "pending" && attempts >= MAX_ATTEMPTS) { status = "failed"; note = `gave up after ${attempts} attempts${note ? `: ${note}` : ""}`.slice(0, 300); }
  return { status, note, attempts, retryInSeconds: status === "pending" ? retryDelaySeconds(attempts) : null };
}
