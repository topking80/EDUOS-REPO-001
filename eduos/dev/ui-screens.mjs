// Local UI review: boots EduOS with the synthetic demo district against a local
// PostgreSQL (EDUOS_TEST_PG_URL), signs each demo role in, and saves
// screenshots of both front ends (the full site "/" and the app "/app/") at
// desktop and phone widths. For design review only; writes PNGs to OUT_DIR.
//   EDUOS_TEST_PG_URL=postgres://... node dev/ui-screens.mjs [outDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, startIdp, startServer, baseEnv, run, login } from "../test/integration/harness.js";
import { seedDemo } from "./seed-demo.js";
import { USERS } from "./demo-fixture.js";
import { startChrome, Page } from "../test/browser/cdp.js";

// Default: a new private folder (mkdtemp, mode 0700), never a fixed, guessable /tmp path.
const OUT = process.argv[2] ? (fs.mkdirSync(process.argv[2], { recursive: true }), process.argv[2])
  : fs.mkdtempSync(path.join(os.tmpdir(), "eduos-screens-"));
const db = await createDatabase(), idp = await startIdp();
const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, EDUOS_ALLOW_DEMO_SEED: "true",
  INTEGRATIONS_KEY: "0".repeat(64), INTEGRATIONS_ALLOW_INSECURE_LOOPBACK: "true", SIS_SYNC_DISPATCH_ENABLED: "false" });
const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
if (m.code) throw new Error(m.out);
await seedDemo({ databaseUrl: db.ownerUrl, issuer: idp.issuer, env });
const server = await startServer({ ...env, DATABASE_URL: db.appUrl });
const chrome = await startChrome({ after() {} });

const roles = (process.env.ROLES || "superintendent,principal,teacher,parent,pupil,itAdmin").split(",");
const shots = JSON.parse(process.env.SHOTS || "null") || {
  site: ["/"], app: ["/app/"]
};
for (const key of roles) {
  const u = USERS[key];
  const s = await login(server.base, idp, u.sub, { email: u.email, email_verified: true });
  const [name, value] = s.cookie.split(";")[0].split("=");
  for (const [w, h, tag] of [[1280, 900, "desktop"], [390, 844, "phone"]]) {
    for (const path of [...shots.site, ...shots.app]) {
      const page = await Page.open(chrome.port);
      try {
        await page.send("Network.enable");
        await page.send("Network.setCookie", { name, value, url: server.base });
        await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: tag === "phone" });
        await page.send("Page.navigate", { url: `${server.base}${path}` });
        await new Promise(r => setTimeout(r, 2500));
        const { data } = (await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: tag === "desktop" })).result;
        const file = `${OUT}/${key}-${tag}-${path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root"}.png`;
        fs.writeFileSync(file, Buffer.from(data, "base64"));
        console.log(file);
      } finally { page.close(); }
    }
  }
}
await server.stop(); process.exit(0);