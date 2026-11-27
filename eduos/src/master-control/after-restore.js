// FED-10: record that Master Control was restored from a backup. Run once,
// after restoring and before Master Control serves anyone:
//   MC_DATABASE_URL=... npm run mc:after-restore -- --note "Restored from 02:00 backup after disk failure" [--backup-taken-at 2026-11-26T02:00:00Z] [--skip 1000]
// Every district's next policy bundle version then jumps by --skip, past any
// version issued after the backup that its EduOS may already hold. The event
// is written to the audit log.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createDb } from "./db.js";
import { appendAudit } from "./audit.js";

export async function recordRestore(db, { note, backupTakenAt = null, skip = 1000, by = "system:restore" }) {
  const n = Number(skip);
  if (!note || note.trim().length < 5) throw new Error("--note (at least 5 characters) is required");
  if (!Number.isInteger(n) || n < 1 || n > 1000000) throw new Error("--skip must be an integer from 1 to 1000000");
  if (backupTakenAt && Number.isNaN(Date.parse(backupTakenAt))) throw new Error("--backup-taken-at must be an ISO time");
  const id = `rs-${crypto.randomBytes(8).toString("hex")}`;
  return db.tx(async c => {
    await c.query("INSERT INTO restore_events(id, recorded_by, backup_taken_at, version_skip, note) VALUES ($1,$2,$3,$4,$5)", [id, by, backupTakenAt, n, note.trim()]);
    const { seq } = await appendAudit(c, { actor: by, action: "record_restore", target_type: "restore_event", target_id: id, node_id: null, capability: null,
      decision: "allowed", detail: { note: note.trim(), backupTakenAt, versionSkip: n } });
    return { id, versionSkip: n, auditSeq: seq };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { note: { type: "string" }, "backup-taken-at": { type: "string" }, skip: { type: "string" } } });
  if (!process.env.MC_DATABASE_URL) { console.error("MC_DATABASE_URL is required"); process.exit(2); }
  const db = createDb({ databaseUrl: process.env.MC_DATABASE_URL, schema: "master_control" });
  try { console.log(JSON.stringify(await recordRestore(db, { note: values.note, backupTakenAt: values["backup-taken-at"] || null, skip: values.skip ?? 1000 }))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { await db.end(); }
}
