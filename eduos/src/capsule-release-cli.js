// Release Time Capsules whose date has come, for cron. Runs as the runtime
// role (DATABASE_URL), like the API. Safe to run alongside the API's own sweep.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, assertSafeRuntimeRole, assertSchemaReady } from "./db.js";
import { releaseDueCapsules } from "./student-history-capsule-routes.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    await assertSafeRuntimeRole();
    await assertSchemaReady();
    console.log(JSON.stringify(await releaseDueCapsules({ db: pool })));
  })().catch(error => { console.error(`Time Capsule release failed: ${error.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
}
