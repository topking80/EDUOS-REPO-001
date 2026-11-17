import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(new URL("../db/051_notification_email_consent.sql", import.meta.url), "utf8");
const smsMigration = fs.readFileSync(new URL("../db/052_notification_sms_verification.sql", import.meta.url), "utf8");
const acceptanceMigration = fs.readFileSync(new URL("../db/053_notification_provider_acceptance.sql", import.meta.url), "utf8");
const pushMigration = fs.readFileSync(new URL("../db/054_notification_fcm_devices.sql", import.meta.url), "utf8");
const grants = fs.readFileSync(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");
const migrate = fs.readFileSync(new URL("../src/migrate.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/notify-routes.js", import.meta.url), "utf8");
const dispatcher = fs.readFileSync(new URL("../src/notify-dispatch.js", import.meta.url), "utf8");

test("email channel migration opts every existing user out by default", () => {
  assert.match(migration, /email_notifications_enabled boolean NOT NULL DEFAULT false/);
  assert.match(migration, /email_notifications_consented_at timestamptz/);
  assert.match(migrate, /051_notification_email_consent\.sql/);
});

test("notification preferences are self-service, district-scoped and CSRF protected", () => {
  assert.match(routes, /app\.get\("\/api\/me\/notification-preferences", requireSession/);
  assert.match(routes, /app\.put\("\/api\/me\/notification-preferences", requireSession, requireCsrf/);
  assert.match(routes, /WHERE user_id=\$1 AND district_id=\$2/);
  assert.match(routes, /notification\.preference\.update/);
});

test("dispatcher skips email until recipient consent is enabled", () => {
  assert.match(dispatcher, /coalesce\(p\.email_notifications_enabled,false\) AS email_opted_in/);
  assert.match(dispatcher, /row.channel === "email" && adapter.name === "smtp" && !renewed.emailOptedIn/);
  assert.match(dispatcher, /recipient has not opted in to email notifications/);
});

test("SMS migration defaults users to unverified and opted out", () => {
  assert.match(smsMigration, /sms_notifications_enabled boolean NOT NULL DEFAULT false/);
  assert.match(smsMigration, /phone_verified_at timestamptz/);
  assert.match(smsMigration, /NOT sms_notifications_enabled OR/);
  assert.ok(smsMigration.includes("phone_e164 IS NULL OR phone_e164 ~"));
});

test("phone verification requires session and CSRF; consent requires verified phone", () => {
  assert.ok(routes.includes('app.post("/api/me/phone-verification/start", requireSession, requireCsrf, startLimiter'));
  assert.ok(routes.includes('app.post("/api/me/phone-verification/check", requireSession, requireCsrf, checkLimiter'));
  assert.ok(routes.includes("if (body.smsEnabled === true)"));
  assert.ok(routes.includes("verified_phone_required"));
  assert.match(dispatcher, /row.channel === "sms" && adapter.name === "twilio" && !renewed.smsOptedIn/);
  assert.match(dispatcher, /p.phone_verified_at/);
});

test("provider acceptance is terminal but is not counted as confirmed delivery", () => {
  assert.match(acceptanceMigration, /'accepted'/);
  assert.match(dispatcher, /delivered_at=CASE WHEN \$2='delivered' THEN now\(\) END/);
});

test("FCM migration defaults push off and creates district-scoped, encrypted device registry", () => {
  assert.match(pushMigration, /push_notifications_enabled boolean NOT NULL DEFAULT false/);
  assert.match(pushMigration, /token_ciphertext text NOT NULL/);
  assert.match(pushMigration, /token_hash text NOT NULL/);
  assert.match(pushMigration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(pushMigration, /CREATE POLICY own_user ON user_push_devices AS RESTRICTIVE/);
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON user_push_devices TO eduos_app/);
  assert.match(migrate, /054_notification_fcm_devices\.sql/);
});

test("push enrollment requires session, CSRF, explicit consent and supports revocation", () => {
  assert.ok(routes.includes('app.get("/api/me/push-devices", requireSession'));
  assert.ok(routes.includes('app.post("/api/me/push-devices", requireSession, requireCsrf, pushDeviceLimiter'));
  assert.ok(routes.includes('app.delete("/api/me/push-devices/:deviceId", requireSession, requireCsrf'));
  assert.ok(routes.includes("if (body.pushEnabled === false)"));
  assert.ok(routes.includes("push_consent_required"));
  assert.ok(routes.includes("push_notifications_enabled"));
  assert.match(dispatcher, /row.channel === "push" && adapter.name === "fcm" && !renewed.pushOptedIn/);
  assert.match(dispatcher, /recipientPushTokens/);
  assert.match(dispatcher, /invalidHashes/);
});
