import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(new URL("../db/051_notification_email_consent.sql", import.meta.url), "utf8");
const smsMigration = fs.readFileSync(new URL("../db/052_notification_sms_verification.sql", import.meta.url), "utf8");
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
  assert.match(routes, /notification\.email_consent\.update/);
});

test("dispatcher skips email until recipient consent is enabled", () => {
  assert.match(dispatcher, /coalesce\(p\.email_notifications_enabled,false\) AS email_opted_in/);
  assert.match(dispatcher, /row.channel === "email" && adapter.name === "smtp" && !row.email_opted_in/);
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
