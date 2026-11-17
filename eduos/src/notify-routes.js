// Self-service notification channel preferences.
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";

export function registerNotificationRoutes(app) {
  app.get("/api/me/notification-preferences", requireSession, async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const result = await client.query(
          "SELECT email_notifications_enabled,email_notifications_consented_at FROM user_preferences WHERE user_id=$1 AND district_id=$2",
          [req.actor.userId, req.actor.districtId]
        );
        const row = result.rows[0];
        return { emailEnabled: Boolean(row?.email_notifications_enabled), emailConsentedAt: row?.email_notifications_consented_at || null };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (error) { next(error); }
  });

  app.put("/api/me/notification-preferences", requireSession, requireCsrf, async (req, res, next) => {
    const body = req.body || {};
    if (Object.keys(body).some(key => key !== "emailEnabled") || typeof body.emailEnabled !== "boolean")
      return res.status(400).json({ error: "invalid_notification_preferences" });
    try {
      const data = await withTenantTransaction(req.actor, async client => {
        const result = await client.query(
          "INSERT INTO user_preferences(user_id,district_id,email_notifications_enabled,email_notifications_consented_at) " +
          "VALUES($1,$2,$3,CASE WHEN $3 THEN now() END) " +
          "ON CONFLICT(user_id,district_id) DO UPDATE SET " +
          "email_notifications_enabled=EXCLUDED.email_notifications_enabled, " +
          "email_notifications_consented_at=CASE WHEN EXCLUDED.email_notifications_enabled " +
          "THEN now() ELSE user_preferences.email_notifications_consented_at END, updated_at=now() " +
          "RETURNING email_notifications_enabled,email_notifications_consented_at",
          [req.actor.userId, req.actor.districtId, body.emailEnabled]
        );
        const row = result.rows[0];
        await client.query(
          "INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id) " +
          "VALUES($1,$2,$3,'notification.email_consent.update','notification_preference',$2,'success',$4,$5)",
          [req.actor.districtId, req.actor.userId, req.actor.role, JSON.stringify({ emailEnabled: row.email_notifications_enabled }), req.requestId]
        );
        return { emailEnabled: row.email_notifications_enabled, emailConsentedAt: row.email_notifications_consented_at };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (error) { next(error); }
  });
}
