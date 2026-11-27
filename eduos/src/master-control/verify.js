// FED-10: check Master Control's stored state (after a restore, or on a
// schedule). Prints the report as JSON; exits 1 if anything is wrong.
//   MC_DATABASE_URL=... [MC_POLICY_SIGNING_SECRET=...] npm run mc:verify
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { verifyIntegrity } from "./integrity.js";
import { bundleKeys } from "../federation/policy-bundle.js";
import { readProviderSecret } from "./identity.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!process.env.MC_DATABASE_URL) { console.error("MC_DATABASE_URL is required"); process.exit(2); }
  const db = createDb({ databaseUrl: process.env.MC_DATABASE_URL, schema: "master_control" });
  try {
    let configuredKey = null;
    try { configuredKey = bundleKeys(readProviderSecret("MC_POLICY_SIGNING_SECRET")); } catch { configuredKey = null; }
    const report = await verifyIntegrity(db, { configuredKey });
    console.log(JSON.stringify(report));
    process.exitCode = report.ok ? 0 : 1;
  } finally { await db.end(); }
}
