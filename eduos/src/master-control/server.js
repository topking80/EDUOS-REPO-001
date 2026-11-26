// FED-03: start Master Control (`npm run mc:start`). Separate process, port,
// database login and OIDC client from EduOS.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createDb, assertSeparated } from "./db.js";
import { createOidc } from "./oidc.js";
import { createApp } from "./app.js";

export async function start(cfg = loadConfig()) {
  const db = createDb(cfg);
  await assertSeparated(db);
  const app = createApp({ cfg, db, oidc: createOidc(cfg) });
  const server = await new Promise(resolve => { const s = app.listen(cfg.port, () => resolve(s)); });
  console.log(`master control listening on ${server.address().port}`);
  const stop = async () => { server.close(); await db.end(); };
  process.once("SIGTERM", () => stop().then(() => process.exit(0)));
  return { server, db, stop };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start().catch(e => { console.error(e.message); process.exit(1); });
}
