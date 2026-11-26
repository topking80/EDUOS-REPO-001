// FED-03: create the platform node and its first operator, once
// (`npm run mc:bootstrap -- --subject <oidc-sub> --name "<name>" --approval "<ref>"`).
// Everything after this happens in Master Control itself, under the rules.
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { appendAudit } from "./audit.js";

export async function bootstrap({ subject, name, approval, platformName = "EduOS platform", cfg = loadConfig() }) {
  if (!subject || !name || !approval) throw new Error("--subject, --name and --approval are required");
  const db = createDb(cfg);
  try {
    return await db.tx(async c => {
      if ((await c.query("SELECT 1 FROM nodes WHERE kind='platform'")).rowCount) throw new Error("Master Control is already bootstrapped");
      const principal = `op-${crypto.randomUUID()}`, today = new Date().toISOString().slice(0, 10), aid = `ra-${crypto.randomBytes(8).toString("hex")}`;
      await c.query("INSERT INTO nodes(id, kind, name, status, effective_from, approval_reference, created_by) VALUES ('platform','platform',$1,'active',$2,$3,'bootstrap')", [platformName, today, approval]);
      await c.query("INSERT INTO operators(principal_id, oidc_issuer, oidc_subject, display_name, created_by) VALUES ($1,$2,$3,$4,'bootstrap')", [principal, cfg.oidcIssuer, subject, name]);
      await c.query(`INSERT INTO role_assignments(id, principal_id, role_id, node_id, status, effective_from, approval_reference, created_by)
        VALUES ($1,$2,'platform-operator','platform','active',$3,$4,'bootstrap')`, [aid, principal, today, approval]);
      await appendAudit(c, { actor: "bootstrap", action: "bootstrap", target_type: "platform", target_id: "platform", node_id: "platform", decision: "allowed",
        basis: { type: "bootstrap" }, detail: { operator: principal, assignment: aid, approvalReference: approval } });
      return { principal, assignment: aid };
    });
  } finally { await db.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  bootstrap({ subject: arg("subject"), name: arg("name"), approval: arg("approval"), platformName: arg("platform-name") })
    .then(r => console.log(`bootstrapped: operator ${r.principal}, assignment ${r.assignment}`))
    .catch(e => { console.error(e.message); process.exit(1); });
}
