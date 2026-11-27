// HSP-03: the platform's private-school lifecycle actions, run as the
// migration owner after checking the school's identity out of band:
//   DATABASE_URL=<owner URL> npm run ps:verify -- --school <id> --ref "<evidence reference>" --by "<reviewer>" [--domain-verified]
//   ... -- --school <id> --suspend --ref "<reason>" --by "<reviewer>"
//   ... -- --school <id> --reactivate --ref "<reason>" --by "<reviewer>"
//   ... -- --school <id> --close --ref "<reason>" --by "<reviewer>"   (after the school asked and exported its records)
// Every action is written to the school's audit trail.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";

export async function privateSchoolAction(client, { school, ref, by, action = "verify", domainVerified = false }) {
  if (!/^[0-9a-f-]{36}$/i.test(school || "")) throw new Error("--school <id> is required");
  if (!ref || ref.trim().length < 3 || !by || by.trim().length < 2) throw new Error("--ref and --by are required");
  await client.query("BEGIN");
  try {
    const { rows: [s] } = await client.query("SELECT status, closure_requested_at FROM private_schools WHERE id=$1 FOR UPDATE", [school]);
    if (!s) throw new Error("school not found");
    const next = { verify: "active", suspend: "suspended", reactivate: "active", close: "closed" }[action];
    const allowed = { verify: ["pending_verification"], suspend: ["active", "pending_verification"], reactivate: ["suspended"], close: ["active", "suspended", "pending_verification", "closing"] }[action];
    if (!next || !allowed.includes(s.status)) throw new Error(`can't ${action} a school that is ${s.status}`);
    if (action === "close" && !s.closure_requested_at && s.status !== "suspended") throw new Error("the school hasn't asked to close (or suspend it first)");
    if (action === "verify") await client.query("UPDATE private_schools SET status='active', verification_ref=$2, verified_by=$3, verified_at=now(), domain_verified_at=CASE WHEN $4 THEN now() ELSE domain_verified_at END WHERE id=$1",
      [school, ref.trim(), by.trim(), domainVerified]);
    else await client.query("UPDATE private_schools SET status=$2 WHERE id=$1", [school, next]);
    if (action === "close") await client.query("UPDATE tenants SET status='closed', closed_at=now() WHERE id=$1", [school]);
    if (["suspend", "close"].includes(action)) await client.query("UPDATE sessions SET revoked_at=now() WHERE private_school_id=$1 AND revoked_at IS NULL", [school]);
    await client.query("INSERT INTO private_school_audit_events(school_id, actor_user_id, actor_role, action, resource_type, resource_id, detail) VALUES ($1, NULL, 'platform', $2, 'private_school', $4, $3)",
      [school, action, `${ref.trim()} (by ${by.trim()})${domainVerified ? ";domain_verified" : ""}`, String(school)]);
    await client.query("COMMIT");
    return { school, status: next };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values: v } = parseArgs({ options: { school: { type: "string" }, ref: { type: "string" }, by: { type: "string" }, "domain-verified": { type: "boolean" },
    suspend: { type: "boolean" }, reactivate: { type: "boolean" }, close: { type: "boolean" } } });
  const action = v.suspend ? "suspend" : v.reactivate ? "reactivate" : v.close ? "close" : "verify";
  const client = new pg.Client(process.env.DATABASE_URL); await client.connect();
  try { console.log(JSON.stringify(await privateSchoolAction(client, { school: v.school, ref: v.ref, by: v.by, action, domainVerified: !!v["domain-verified"] }))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { await client.end(); }
}
