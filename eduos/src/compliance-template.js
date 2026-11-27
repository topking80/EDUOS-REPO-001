// HSP-06 part 2: the platform publishes and retires compliance templates,
// run as the migration owner after someone has reviewed the requirements
// against their official sources:
//   DATABASE_URL=<owner URL> npm run compliance:template -- publish --file <template.json>
//   ... -- retire --id <template id>
//   ... -- list
// A template must name its sources, the authority, its effective date, when
// it was last reviewed (within the last 18 months) and who reviewed it. A
// published template never changes: publish a new version instead.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { validateRequirements } from "./compliance-requirements.js";

const DAY = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const https = v => { try { return new URL(v).protocol === "https:"; } catch { return false; } };

export function checkTemplate(t, today = new Date().toISOString().slice(0, 10)) {
  const errs = [];
  if (!/^US-[A-Z]{2}$/.test(t?.jurisdiction ?? "")) errs.push("jurisdiction like US-TX");
  if (!["homeschool_family", "private_school"].includes(t?.appliesTo)) errs.push("appliesTo: homeschool_family or private_school");
  if (typeof t?.title !== "string" || t.title.trim().length < 3 || t.title.length > 160) errs.push("title");
  if (!/^[0-9]{4}\.[0-9]+$/.test(t?.version ?? "")) errs.push("version like 2026.1");
  if (!Array.isArray(t?.sources) || !t.sources.length || t.sources.length > 10 || t.sources.some(s => !s || typeof s.title !== "string" || !https(s.url))) errs.push("sources: [{title, url (https)}]");
  if (typeof t?.authority?.name !== "string" || t.authority.name.trim().length < 3 || !https(t?.authority?.url)) errs.push("authority: {name, url (https)}");
  if (!DAY(t?.effectiveFrom)) errs.push("effectiveFrom");
  if (!DAY(t?.lastReviewedOn) || t.lastReviewedOn > today) errs.push("lastReviewedOn (not in the future)");
  else if ((Date.parse(today) - Date.parse(t.lastReviewedOn)) / 86400000 > 548) errs.push("lastReviewedOn is more than 18 months ago; review it again");
  if (typeof t?.reviewedBy !== "string" || t.reviewedBy.trim().length < 3) errs.push("reviewedBy");
  const r = validateRequirements(t?.requirements);
  if (!r.ok) errs.push(`requirements: ${r.error}`);
  return errs;
}

export async function publishTemplate(client, t) {
  const errs = checkTemplate(t);
  if (errs.length) throw new Error(`template not published: ${errs.join("; ")}`);
  const { rows: [r] } = await client.query(`INSERT INTO compliance_templates(jurisdiction, applies_to, title, version, requirements, sources, authority_name, authority_url,
      effective_from, last_reviewed_on, reviewed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [t.jurisdiction, t.appliesTo, t.title.trim(), t.version, JSON.stringify(t.requirements), JSON.stringify(t.sources), t.authority.name.trim(), t.authority.url,
      t.effectiveFrom, t.lastReviewedOn, t.reviewedBy.trim()]);
  return { id: r.id, status: "published" };
}
export async function retireTemplate(client, id) {
  const r = await client.query("UPDATE compliance_templates SET status='retired', retired_at=now() WHERE id=$1 AND status='published'", [id]);
  if (!r.rowCount) throw new Error("no published template with that id");
  return { id, status: "retired" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values: v, positionals: [cmd] } = parseArgs({ allowPositionals: true, options: { file: { type: "string" }, id: { type: "string" } } });
  const client = new pg.Client(process.env.DATABASE_URL); await client.connect();
  try {
    if (cmd === "publish") console.log(JSON.stringify(await publishTemplate(client, JSON.parse(fs.readFileSync(v.file, "utf8")))));
    else if (cmd === "retire") console.log(JSON.stringify(await retireTemplate(client, v.id)));
    else if (cmd === "list") console.log(JSON.stringify((await client.query("SELECT id, jurisdiction, applies_to, version, title, status, last_reviewed_on FROM compliance_templates ORDER BY jurisdiction, applies_to, version")).rows, null, 2));
    else throw new Error("usage: publish --file <template.json> | retire --id <id> | list");
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { await client.end(); }
}
