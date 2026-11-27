// Retention job for append-only and short-lived records (32.0.53).
// Run as the migration OWNER role (not the runtime role), e.g. nightly:
//   DATABASE_URL=postgres://eduos_owner:...@db/eduos npm run db:retention
// Each district is processed in its own transaction with app.district_id set,
// so row-level security still scopes every delete.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { rulesInForce, applyRetentionMinimums } from "./jurisdiction-rules.js";

const days = (env, name, fallback) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 36500) throw new Error(`${name} must be an integer number of days (1-36500)`);
  return value;
};

function replayDays(env) {
  const value = days(env, "RETENTION_OFFLINE_REPLAY_DAYS", 7);
  if (value < 2) throw new Error("RETENTION_OFFLINE_REPLAY_DAYS must be at least 2 (offline writes can be replayed for 24 hours)");
  return value;
}

export function retentionSettings(env = process.env) {
  return {
    auditDays: days(env, "RETENTION_AUDIT_DAYS", 2555),               // ~7 years
    closedCaseDays: days(env, "RETENTION_CLOSED_CASE_DAYS", 2555),    // closed intervention cases + notes
    flowEventDays: days(env, "RETENTION_FLOW_EVENT_DAYS", 90),
    webhookDeliveryDays: days(env, "RETENTION_WEBHOOK_DELIVERY_DAYS", 90),
    sessionDays: days(env, "RETENTION_SESSION_DAYS", 30),             // expired/revoked sessions
    // 37.4.0 audit item 6: offline replay receipts (Idempotency-Key). The replay
    // window is 24 hours, so at least 2 days are kept; see db/035.
    offlineReplayDays: replayDays(env),
    // Edge Phase 2: device health report history (the latest report stays on the device).
    edgeReportDays: days(env, "RETENTION_EDGE_REPORT_DAYS", 30),
    // 32.5.0: role-app records (32.4.0 / 32.5.0 tables).
    roleApps: {
      notificationDays: days(env, "RETENTION_NOTIFICATION_DAYS", 180),  // read in-app + external outbox rows (unread: twice this)
      christieDays: days(env, "RETENTION_CHRISTIE_DAYS", 365),          // tutoring sessions and turns, by last activity
      transportDays: days(env, "RETENTION_TRANSPORT_DAYS", 400),        // bus runs and check-ins
      commsDays: days(env, "RETENTION_COMMS_DAYS", 730),                // threads (by last message) and announcements
      safetyDays: days(env, "RETENTION_SAFETY_DAYS", 2555),             // closed incidents, roll calls, pick-up log (~7 years)
      pickupTagDays: days(env, "RETENTION_PICKUP_TAG_DAYS", 30)         // expired/revoked passes never used
    }
  };
}

/** 37.6.0: RETENTION_* numbers passed to the feature retention functions. */
export function featureRetentionSettings(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => /^RETENTION_[A-Z_]+_DAYS$/.test(k) && /^[0-9]{1,5}$/.test(String(v))).map(([k, v]) => [k, Number(v)]));
}

export async function runRetention(settings = retentionSettings()) {
  const summary = { districts: {}, sessions: null };
  const districts = await pool.query("SELECT id FROM districts ORDER BY id");
  for (const { id } of districts.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.district_id', $1, true)", [id]);
      // FED-07: the district's jurisdiction rules. A legal hold stops every
      // purge of district records; retention minimums raise the configured days.
      const rules = await rulesInForce(client);
      if (rules.legalHold) {
        const or = await client.query("SELECT eduos_retention_purge_offline_replays($1) AS counts", [settings.offlineReplayDays ?? retentionSettings({}).offlineReplayDays]);
        const er = await client.query("SELECT eduos_retention_purge_edge_reports($1) AS counts", [settings.edgeReportDays ?? retentionSettings({}).edgeReportDays]);
        await client.query("COMMIT");
        summary.districts[id] = { legal_hold: true, ...or.rows[0].counts, ...er.rows[0].counts };
        continue;
      }
      const { settings: ds, raised } = applyRetentionMinimums({ ...settings, roleApps: settings.roleApps || retentionSettings({}).roleApps }, rules);
      const r = await client.query("SELECT eduos_retention_purge($1,$2,$3,$4) AS counts",
        [ds.auditDays, ds.closedCaseDays, settings.flowEventDays, settings.webhookDeliveryDays]);
      const ra = await client.query("SELECT eduos_retention_purge_role_apps($1::jsonb) AS counts", [JSON.stringify(ds.roleApps)]);
      const or = await client.query("SELECT eduos_retention_purge_offline_replays($1) AS counts",
        [settings.offlineReplayDays ?? retentionSettings({}).offlineReplayDays]);
      const er = await client.query("SELECT eduos_retention_purge_edge_reports($1) AS counts",
        [settings.edgeReportDays ?? retentionSettings({}).edgeReportDays]);
      // 37.6.0: each feature migration may add eduos_retention_feature_<name>(jsonb);
      // all of them run here with the RETENTION_* settings from the environment.
      const fr = {};
      const feats = await client.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname LIKE 'eduos\\_retention\\_feature\\_%' ORDER BY p.proname`);
      for (const { proname } of feats.rows) {
        if (!/^eduos_retention_feature_[a-z0-9_]+$/.test(proname)) continue;
        Object.assign(fr, (await client.query(`SELECT ${proname}($1::jsonb) AS counts`, [JSON.stringify(settings.features || featureRetentionSettings())])).rows[0].counts);
      }
      await client.query("COMMIT");
      summary.districts[id] = { ...r.rows[0].counts, ...ra.rows[0].counts, ...or.rows[0].counts, ...er.rows[0].counts, ...fr, ...(raised.length && { minimums_applied: raised }) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  summary.sessions = (await pool.query("SELECT eduos_purge_sessions($1) AS counts", [settings.sessionDays])).rows[0].counts;
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { console.log(JSON.stringify(await runRetention())); }
  finally { await pool.end(); }
}
