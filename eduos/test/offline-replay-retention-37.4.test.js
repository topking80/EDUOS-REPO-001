// Audit 37.4.0 item 6: retention for offline replay receipts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("replay receipt retention: default 7 days, never below 2", async () => {
  process.env.DATABASE_URL ||= "postgresql://u@127.0.0.1:1/db";
  process.env.PUBLIC_ORIGIN ||= "http://localhost:8080";
  process.env.OIDC_ISSUER ||= "http://localhost/oidc";
  process.env.OIDC_CLIENT_ID ||= "eduos-test-client";
  process.env.OIDC_CLIENT_SECRET ||= "test-secret";
  process.env.OIDC_REDIRECT_URI ||= "http://localhost:8080/auth/callback";
  const { retentionSettings } = await import("../src/retention.js");
  assert.equal(retentionSettings({}).offlineReplayDays, 7);
  assert.equal(retentionSettings({ RETENTION_OFFLINE_REPLAY_DAYS: "2" }).offlineReplayDays, 2);
  assert.equal(retentionSettings({ RETENTION_OFFLINE_REPLAY_DAYS: "30" }).offlineReplayDays, 30);
  assert.throws(() => retentionSettings({ RETENTION_OFFLINE_REPLAY_DAYS: "1" }), /at least 2/);
  assert.throws(() => retentionSettings({ RETENTION_OFFLINE_REPLAY_DAYS: "0" }), /RETENTION_OFFLINE_REPLAY_DAYS/);
  const sql = readFileSync(new URL("../db/035_offline_replay_retention.sql", import.meta.url), "utf8");
  assert.match(sql, /p_days < 2/, "the database refuses a shorter window too");
  assert.match(sql, /REVOKE ALL ON FUNCTION eduos_retention_purge_offline_replays\(int\) FROM PUBLIC/);
});
