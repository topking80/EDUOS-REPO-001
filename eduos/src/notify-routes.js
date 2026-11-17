// Self-service notification preferences and verified phone enrollment.
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { createTwilioClient, isE164 } from "./notify-twilio.js";
import { encryptPushToken, hashPushToken } from "./notify-push-token.js";

const twilio = createTwilioClient();
const startLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 3, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => req.actor.userId });
const checkLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => req.actor.userId });
const pushDeviceLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => req.actor.userId });

const twilioReady = () => Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioVerifyServiceSid);

export function registerNotificationRoutes(app) {
  app.get("/api/me/notification-preferences", requireSession, async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const result = await client.query(
          "SELECT email_notifications_enabled,email_notifications_consented_at,phone_e164,phone_verified_at,sms_notifications_enabled,sms_notifications_consented_at,push_notifications_enabled,push_notifications_consented_at FROM user_preferences WHERE user_id=$1 AND district_id=$2",
          [req.actor.userId, req.actor.districtId]
        );
        const row = result.rows[0] || {};
        return { emailEnabled: Boolean(row.email_notifications_enabled), emailConsentedAt: row.email_notifications_consented_at || null,
          phoneE164: row.phone_e164 || null, phoneVerifiedAt: row.phone_verified_at || null,
          smsEnabled: Boolean(row.sms_notifications_enabled), smsConsentedAt: row.sms_notifications_consented_at || null,
          pushEnabled: Boolean(row.push_notifications_enabled), pushConsentedAt: row.push_notifications_consented_at || null };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (error) { next(error); }
  });

  app.put("/api/me/notification-preferences", requireSession, requireCsrf, async (req, res, next) => {
    const body = req.body || {};
    if (Object.keys(body).some(key => !["emailEnabled", "smsEnabled", "pushEnabled"].includes(key)) ||
        (!Object.hasOwn(body, "emailEnabled") && !Object.hasOwn(body, "smsEnabled") && !Object.hasOwn(body, "pushEnabled")) ||
        (body.emailEnabled !== undefined && typeof body.emailEnabled !== "boolean") ||
        (body.smsEnabled !== undefined && typeof body.smsEnabled !== "boolean") ||
        (body.pushEnabled !== undefined && typeof body.pushEnabled !== "boolean"))
      return res.status(400).json({ error: "invalid_notification_preferences" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        if (body.smsEnabled === true) {
          const phone = await client.query("SELECT phone_verified_at FROM user_preferences WHERE user_id=$1 AND district_id=$2", [req.actor.userId, req.actor.districtId]);
          if (!phone.rows[0]?.phone_verified_at) return null;
        }
        const result = await client.query(
          "INSERT INTO user_preferences(user_id,district_id,email_notifications_enabled,email_notifications_consented_at,sms_notifications_enabled,sms_notifications_consented_at,push_notifications_enabled,push_notifications_consented_at) " +
          "VALUES($1,$2,coalesce($3,false),CASE WHEN $3 THEN now() END,coalesce($4,false),CASE WHEN $4 THEN now() END,coalesce($5,false),CASE WHEN $5 THEN now() END) " +
          "ON CONFLICT(user_id,district_id) DO UPDATE SET " +
          "email_notifications_enabled=coalesce($3,user_preferences.email_notifications_enabled), " +
          "email_notifications_consented_at=CASE WHEN $3 IS TRUE THEN now() ELSE user_preferences.email_notifications_consented_at END, " +
          "sms_notifications_enabled=coalesce($4,user_preferences.sms_notifications_enabled), " +
          "sms_notifications_consented_at=CASE WHEN $4 IS TRUE THEN now() ELSE user_preferences.sms_notifications_consented_at END, " +
          "push_notifications_enabled=coalesce($5,user_preferences.push_notifications_enabled), " +
          "push_notifications_consented_at=CASE WHEN $5 IS TRUE THEN now() ELSE user_preferences.push_notifications_consented_at END, updated_at=now() " +
          "RETURNING email_notifications_enabled,email_notifications_consented_at,sms_notifications_enabled,sms_notifications_consented_at,push_notifications_enabled,push_notifications_consented_at,phone_e164,phone_verified_at",
          [req.actor.userId, req.actor.districtId, body.emailEnabled ?? null, body.smsEnabled ?? null, body.pushEnabled ?? null]
        );
        const row = result.rows[0];
        if (body.pushEnabled === false) {
          await client.query("UPDATE user_push_devices SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1 AND district_id=$2 AND revoked_at IS NULL",
            [req.actor.userId, req.actor.districtId]);
        }
        await client.query(
          "INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) " +
          "VALUES($1,$2,$3,'notification.preference.update','notification_preference',$2,'success',$4,$5)",
          [req.actor.districtId, req.actor.userId, req.actor.role,
            JSON.stringify({ emailEnabled: row.email_notifications_enabled, smsEnabled: row.sms_notifications_enabled, pushEnabled: row.push_notifications_enabled }), req.requestId]
        );
        return { emailEnabled: row.email_notifications_enabled, emailConsentedAt: row.email_notifications_consented_at,
          smsEnabled: row.sms_notifications_enabled, smsConsentedAt: row.sms_notifications_consented_at,
          pushEnabled: row.push_notifications_enabled, pushConsentedAt: row.push_notifications_consented_at,
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
    if (!isE164(phone) || typeof code !== "string" || !/^\d{4,10}$/.test(code))
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

  app.get("/api/me/push-devices", requireSession, async (req, res, next) => {
    try {
      const devices = await withTenantTransaction(req.actor, async client => {
        const result = await client.query(
          "SELECT id,platform,created_at,last_seen_at FROM user_push_devices WHERE user_id=$1 AND district_id=$2 AND revoked_at IS NULL ORDER BY last_seen_at DESC",
          [req.actor.userId, req.actor.districtId]);
        return result.rows;
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: devices });
    } catch (error) { next(error); }
  });

  app.post("/api/me/push-devices", requireSession, requireCsrf, pushDeviceLimiter, async (req, res, next) => {
    if (config.notifyPushAdapter !== "fcm") return res.status(503).json({ error: "push_registration_unavailable" });
    const token = req.body?.token, platform = req.body?.platform;
    if (typeof token !== "string" || token.length < 20 || token.length > 4096 || /\s/.test(token) ||
        !["ios", "android", "web"].includes(platform))
      return res.status(400).json({ error: "invalid_push_device" });
    try {
      const tokenHash = hashPushToken(token), tokenCiphertext = encryptPushToken(token);
      const data = await withTenantTransaction(req.actor, async client => {
        const pref = await client.query("SELECT push_notifications_enabled FROM user_preferences WHERE user_id=$1 AND district_id=$2",
          [req.actor.userId, req.actor.districtId]);
        if (!pref.rows[0]?.push_notifications_enabled) return { error: "push_consent_required" };
        const count = await client.query("SELECT count(*)::int AS n FROM user_push_devices WHERE user_id=$1 AND district_id=$2 AND revoked_at IS NULL",
          [req.actor.userId, req.actor.districtId]);
        const existing = await client.query("SELECT id FROM user_push_devices WHERE district_id=$1 AND token_hash=$2 AND user_id=$3",
          [req.actor.districtId, tokenHash, req.actor.userId]);
        if (!existing.rowCount && count.rows[0].n >= 20) return { error: "push_device_limit_reached" };
        const saved = await client.query(
          "INSERT INTO user_push_devices(district_id,user_id,platform,token_hash,token_ciphertext) VALUES($1,$2,$3,$4,$5) " +
          "ON CONFLICT(district_id,token_hash) DO UPDATE SET platform=EXCLUDED.platform,token_ciphertext=EXCLUDED.token_ciphertext,last_seen_at=now(),revoked_at=NULL " +
          "WHERE user_push_devices.user_id=EXCLUDED.user_id RETURNING id,platform,last_seen_at",
          [req.actor.districtId, req.actor.userId, platform, tokenHash, tokenCiphertext]);
        if (!saved.rowCount) return { error: "push_token_already_registered" };
        await client.query(
          "INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) " +
          "VALUES($1,$2,$3,'notification.push_device.register','push_device',$4,'success',$5,$6)",
          [req.actor.districtId, req.actor.userId, req.actor.role, saved.rows[0].id,
            JSON.stringify({ platform }), req.requestId]);
        return { device: saved.rows[0] };
      });
      if (data.error) return res.status(data.error === "push_consent_required" ? 409 : data.error === "push_device_limit_reached" ? 429 : 409).json({ error: data.error });
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({ data: data.device });
    } catch (error) { next(error); }
  });

  app.delete("/api/me/push-devices/:deviceId", requireSession, requireCsrf, async (req, res, next) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.deviceId))
      return res.status(400).json({ error: "invalid_push_device_id" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const revoked = await client.query(
          "UPDATE user_push_devices SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND user_id=$2 AND district_id=$3 AND revoked_at IS NULL RETURNING id",
          [req.params.deviceId, req.actor.userId, req.actor.districtId]);
        if (revoked.rowCount) await client.query(
          "INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) " +
          "VALUES($1,$2,$3,'notification.push_device.revoke','push_device',$4,'success','{}',$5)",
          [req.actor.districtId, req.actor.userId, req.actor.role, req.params.deviceId, req.requestId]);
        return Boolean(revoked.rowCount);
      });
      res.status(data ? 204 : 404).end();
    } catch (error) { next(error); }
  });

}
