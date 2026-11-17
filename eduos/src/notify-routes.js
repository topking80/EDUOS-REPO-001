// Self-service notification preferences and verified phone enrollment.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { createTwilioClient, isE164 } from "./notify-twilio.js";

const twilio = createTwilioClient();
const startLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 3, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => req.actor.userId });
const checkLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => req.actor.userId });

const twilioReady = () => Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioVerifyServiceSid);

export function registerNotificationRoutes(app) {
  app.get("/api/me/notification-preferences", requireSession, async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const result = await client.query(
          "SELECT email_notifications_enabled,email_notifications_consented_at,phone_e164,phone_verified_at,sms_notifications_enabled,sms_notifications_consented_at FROM user_preferences WHERE user_id=$1 AND district_id=$2",
          [req.actor.userId, req.actor.districtId]
        );
        const row = result.rows[0] || {};
        return { emailEnabled: Boolean(row.email_notifications_enabled), emailConsentedAt: row.email_notifications_consented_at || null,
          phoneE164: row.phone_e164 || null, phoneVerifiedAt: row.phone_verified_at || null,
          smsEnabled: Boolean(row.sms_notifications_enabled), smsConsentedAt: row.sms_notifications_consented_at || null };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (error) { next(error); }
  });

  app.put("/api/me/notification-preferences", requireSession, requireCsrf, async (req, res, next) => {
    const body = req.body || {};
    if (Object.keys(body).some(key => !["emailEnabled", "smsEnabled"].includes(key)) ||
        (!Object.hasOwn(body, "emailEnabled") && !Object.hasOwn(body, "smsEnabled")) ||
        (body.emailEnabled !== undefined && typeof body.emailEnabled !== "boolean") ||
        (body.smsEnabled !== undefined && typeof body.smsEnabled !== "boolean"))
      return res.status(400).json({ error: "invalid_notification_preferences" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        if (body.smsEnabled === true) {
          const phone = await client.query("SELECT phone_verified_at FROM user_preferences WHERE user_id=$1 AND district_id=$2", [req.actor.userId, req.actor.districtId]);
          if (!phone.rows[0]?.phone_verified_at) return null;
        }
        const result = await client.query(
          "INSERT INTO user_preferences(user_id,district_id,email_notifications_enabled,email_notifications_consented_at,sms_notifications_enabled,sms_notifications_consented_at) " +
          "VALUES($1,$2,coalesce($3,false),CASE WHEN $3 THEN now() END,coalesce($4,false),CASE WHEN $4 THEN now() END) " +
          "ON CONFLICT(user_id,district_id) DO UPDATE SET " +
          "email_notifications_enabled=coalesce($3,user_preferences.email_notifications_enabled), " +
          "email_notifications_consented_at=CASE WHEN $3 IS TRUE THEN now() ELSE user_preferences.email_notifications_consented_at END, " +
          "sms_notifications_enabled=coalesce($4,user_preferences.sms_notifications_enabled), " +
          "sms_notifications_consented_at=CASE WHEN $4 IS TRUE THEN now() ELSE user_preferences.sms_notifications_consented_at END, updated_at=now() " +
          "RETURNING email_notifications_enabled,email_notifications_consented_at,sms_notifications_enabled,sms_notifications_consented_at,phone_e164,phone_verified_at",
          [req.actor.userId, req.actor.districtId, body.emailEnabled ?? null, body.smsEnabled ?? null]
        );
        const row = result.rows[0];
        await client.query(
          "INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) " +
          "VALUES($1,$2,$3,'notification.preference.update','notification_preference',$2,'success',$4,$5)",
          [req.actor.districtId, req.actor.userId, req.actor.role,
            JSON.stringify({ emailEnabled: row.email_notifications_enabled, smsEnabled: row.sms_notifications_enabled }), req.requestId]
        );
        return { emailEnabled: row.email_notifications_enabled, emailConsentedAt: row.email_notifications_consented_at,
          smsEnabled: row.sms_notifications_enabled, smsConsentedAt: row.sms_notifications_consented_at,
          phoneE164: row.phone_e164, phoneVerifiedAt: row.phone_verified_at };
      });
      if (!data) return res.status(409).json({ error: "verified_phone_required" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (error) { next(error); }
  });

  app.post("/api/me/phone-verification/start", requireSession, requireCsrf, startLimiter, async (req, res) => {
    const phone = req.body?.phoneE164;
    if (!isE164(phone)) return res.status(400).json({ error: "phone_must_be_e164" });
    if (!twilioReady()) return res.status(503).json({ error: "phone_verification_unavailable" });
    try {
      const result = await twilio.startVerification(phone);
      if (result.status !== "pending") return res.status(502).json({ error: "verification_not_started" });
      res.setHeader("Cache-Control", "no-store");
      res.status(202).json({ data: { status: "pending" } });
    } catch (error) {
      const status = Number(error.status) === 429 ? 429 : Number(error.status) >= 400 && Number(error.status) < 500 ? 400 : 503;
      res.status(status).json({ error: status === 429 ? "verification_rate_limited" : "verification_unavailable" });
    }
  });

  app.post("/api/me/phone-verification/check", requireSession, requireCsrf, checkLimiter, async (req, res) => {
    const phone = req.body?.phoneE164, code = req.body?.code;
    if (!isE164(phone) || typeof code !== "string" || !/^\\d{4,10}$/.test(code))
      return res.status(400).json({ error: "invalid_verification_input" });
    if (!twilioReady()) return res.status(503).json({ error: "phone_verification_unavailable" });
    try {
      const result = await twilio.checkVerification(phone, code);
      if (result.status !== "approved") return res.status(400).json({ error: "verification_not_approved" });
      const data = await withTenantTransaction(req.actor, async client => {
        const saved = await client.query(
          "INSERT INTO user_preferences(user_id,district_id,phone_e164,phone_verified_at) VALUES($1,$2,$3,now()) " +
          "ON CONFLICT(user_id,district_id) DO UPDATE SET " +
          "sms_notifications_enabled=CASE WHEN user_preferences.phone_e164=EXCLUDED.phone_e164 THEN user_preferences.sms_notifications_enabled ELSE false END, " +
          "sms_notifications_consented_at=CASE WHEN user_preferences.phone_e164=EXCLUDED.phone_e164 THEN user_preferences.sms_notifications_consented_at ELSE NULL END, " +
          "phone_e164=EXCLUDED.phone_e164,phone_verified_at=now(),updated_at=now() " +
          "RETURNING phone_e164,phone_verified_at,sms_notifications_enabled",
          [req.actor.userId, req.actor.districtId, phone]
        );
        const row = saved.rows[0];
        await client.query(
          "INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) " +
          "VALUES($1,$2,$3,'notification.phone.verify','notification_preference',$2,'success',$4,$5)",
          [req.actor.districtId, req.actor.userId, req.actor.role,
            JSON.stringify({ phoneLast4: phone.slice(-4), smsEnabled: row.sms_notifications_enabled }), req.requestId]
        );
        return { phoneE164: row.phone_e164, phoneVerifiedAt: row.phone_verified_at, smsEnabled: row.sms_notifications_enabled };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (error) {
      const status = Number(error.status) === 429 ? 429 : Number(error.status) >= 400 && Number(error.status) < 500 ? 400 : 503;
      res.status(status).json({ error: status === 429 ? "verification_rate_limited" : "verification_unavailable" });
    }
  });
}
