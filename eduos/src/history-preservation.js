// TC-08: the preservation job for student history photos (db/132).
//
//   npm run history:preserve            (cron, e.g. nightly; runs as the runtime role)
//   HISTORY_PRESERVE_INTERVAL_SECONDS   (or let the API run it on a timer; 0 = off)
//
// For each photo that is due (never checked, or older than the district's
// "check every" days, or flagged earlier) it reads the object back from the
// private bucket and compares its SHA-256 with the one recorded when the
// photo was stored. The first check of a photo stored before checksums
// existed records its checksum. A mismatch or a missing object is flagged to
// the superintendents (in-app) and shown under Preservation.
//
// Photos the district's policy says are old enough move to the archive
// storage class (HISTORY_ARCHIVE_STORAGE_CLASS: STANDARD_IA, GLACIER_IR or
// ONEZONE_IA, all of which read instantly). The move is an in-place copy, so
// the key, permissions and photo links are unchanged; the copy is read back
// and must match the checksum before it is recorded. Nothing is ever deleted
// or re-compressed by this job.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, assertSafeRuntimeRole, assertSchemaReady } from "./db.js";
import { config } from "./config.js";

const MAX_BYTES = 52428800;
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");

export async function runHistoryPreservation({ db = pool, storage, archiveClass = config.historyArchiveStorageClass, limit = 200 } = {}) {
  const out = { checked: 0, ok: 0, mismatch: 0, missing: 0, archived: 0, archiveFailed: 0, errors: 0, skipped: 0 };
  if (!storage) return { ...out, storageReady: false };
  const due = (await db.query("SELECT * FROM eduos_history_preservation_due($1)", [limit])).rows;
  const record = (asset, outcome, sum, detail) => db.query("SELECT eduos_history_preservation_record($1,$2,$3,$4) AS r", [asset, outcome, sum, detail]).then(r => r.rows[0].r);
  for (const o of due) {
    try {
      if (o.action === "archive" && !archiveClass) { out.skipped++; continue; }
      const head = await storage.head(o.storage_key);
      if (!head) { out.checked++; await record(o.asset_id, "missing", null, "object not found"); out.missing++; continue; }
      const body = await storage.get(o.storage_key, MAX_BYTES);
      const sum = sha256(body);
      out.checked++;
      if (o.action === "archive") {
        if (sum !== o.sha256) { const r = await record(o.asset_id, "ok", sum, null); out[r === "ok" ? "ok" : "mismatch"]++; continue; }
        try {
          await storage.setStorageClass(o.storage_key, archiveClass);
          const after = sha256(await storage.get(o.storage_key, MAX_BYTES));
          const r = await record(o.asset_id, "archived", after, archiveClass);
          out[r === "archived" ? "archived" : "archiveFailed"]++;
        } catch (e) { await record(o.asset_id, "archive_failed", null, e.message.slice(0, 200)); out.archiveFailed++; }
        continue;
      }
      const r = await record(o.asset_id, "ok", sum, null);
      out[r === "ok" ? "ok" : "mismatch"]++;
    } catch (e) {
      // A storage outage is not evidence of a lost photo: leave it for the next run.
      out.errors++;
      console.error("history preservation: check failed", { asset: o.asset_id, message: e.message });
    }
  }
  return { ...out, storageReady: true, due: due.length };
}

let running = false;
export function startHistoryPreservationSweep(storage) {
  if (!config.historyPreserveIntervalSeconds || !storage) return null;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runHistoryPreservation({ storage }).catch(e => console.error("history preservation sweep failed", { message: e.message })).finally(() => { running = false; });
  }, config.historyPreserveIntervalSeconds * 1000);
  timer.unref?.();
  return timer;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    await assertSafeRuntimeRole();
    await assertSchemaReady();
    const { historyMedia } = await import("./history-media-routes.js");
    const result = await runHistoryPreservation({ storage: historyMedia().storage, limit: Number(process.env.HISTORY_PRESERVE_LIMIT || 500) });
    console.log(JSON.stringify(result));
    if (result.storageReady === false) process.exitCode = 2;
  })().catch(error => { console.error(`History preservation failed: ${error.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
}
