// FED-08: scheduled security check for Master Control. Verifies the
// hash-chained audit log and lists security alerts; exits 1 if any alert is
// critical or high, so a scheduler or monitor can page someone.
//   MC_DATABASE_URL=... MC_POLICY_SIGNING_SECRET=... npm run mc:security-check
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { securityAlerts } from "./security.js";
import { bundleKeys } from "../federation/policy-bundle.js";
import { readProviderSecret } from "./identity.js";

export async function runSecurityCheck(db, env = process.env) {
  let fingerprint = null;
  try { fingerprint = bundleKeys(readProviderSecret("MC_POLICY_SIGNING_SECRET"))?.fingerprint || null; } catch { fingerprint = null; }
  const n = Number(env.MC_ALERT_DENIALS_PER_HOUR || 10);
  const alerts = await securityAlerts(db, { currentFingerprint: fingerprint, threshold: Number.isInteger(n) && n >= 1 ? n : 10 });
  return { at: new Date().toISOString(), alerts, page: alerts.some(a => a.severity === "critical" || a.severity === "high") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!process.env.MC_DATABASE_URL) { console.error("MC_DATABASE_URL is required"); process.exit(2); }
  const db = createDb({ databaseUrl: process.env.MC_DATABASE_URL, schema: "master_control" });
  try {
    const out = await runSecurityCheck(db);
    console.log(JSON.stringify(out));
    process.exitCode = out.page ? 1 : 0;
  } finally { await db.end(); }
}
