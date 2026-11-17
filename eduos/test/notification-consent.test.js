import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(new URL("../db/051_notification_email_consent.sql", import.meta.url), "utf8");
const migrate = fs.readFileSync(new URL("../src/migrate.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/notify-routes.js", import.meta.url), "utf8");
const dispatcher = fs.readFileSync(new URL("../src/notify-dispatch.js", import.meta.url), "utf8");

test("email channel migration opts every existing user out by default", () => {
  assert.match(migration, /email_notifications_enabled boolean NOT NULL DEFAULT false/);
  assert.match(migration, /email_notifications_consented_at timestamptz/);
  assert.match(migrate, /051_notification_email_consent\.sql/);
});

test("notification preferences are self-service, district-scoped and CSRF protected", () => {
  assert.match(routes, /GET_NOT_PRESENT/);
  assert.match(routes, /app\.get\("\/api\/me\/notification-preferences", requireSession/);
  assert.match(routes, /app\.put\("\/api\/me\/notification-preferences", requireSession, requireCsrf/);
  assert.match(routes, /WHERE user_id=\$1 AND district_id=\$2/);
  assert.match(routes, /notification\.email_consent\.update/);
});

test("dispatcher skips email until recipient consent is enabled", () => {
  assert.match(dispatcher, /coalesce\(p\.email_notifications_enabled,false\) AS email_opted_in/);
  assert.match(dispatcher, /row\.channel === "email" && !row\.email_opted_in/);
  assert.match(dispatcher, /recipient has not opted in to email notifications/);
});
