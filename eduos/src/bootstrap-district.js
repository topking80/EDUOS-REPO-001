// Create a district and its first superintendent (32.1.0).
//
// EduOS only lets *provisioned* identities sign in, and from then on people are
// managed in the UI (Administration). Something has to create the first
// account: this command, run once by the operator as the migration OWNER role.
//
//   DATABASE_URL=<owner url> OIDC_ISSUER=<issuer> npm run db:bootstrap -- \
//     --district "Riverside Unified" --sub <superintendent's OIDC sub> \
//     --name "Dr. Maya Chen" --email maya.chen@district.org
//
// Compose: docker compose run --rm migrate node src/bootstrap-district.js --district ... (same flags)
//
// The `sub` is the subject claim your identity provider puts in the ID token
// (Entra ID: the user's object id is NOT the sub; use the `sub` from a test
// sign-in or the provider's documentation). Idempotent: re-running with the
// same values changes nothing. It never deletes or demotes anyone.
import pg from "pg";
import { parseArgs } from "node:util";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBJECT_RE = /^[A-Za-z0-9._:@|-]{1,255}$/;

export async function bootstrapDistrict({ databaseUrl, issuer, district, sub, name, email }) {
  if (!databaseUrl) throw new Error("DATABASE_URL (migration owner role) is required");
  if (!issuer || !/^https?:\/\//.test(issuer)) throw new Error("OIDC_ISSUER is required");
  if (!district || district.trim().length < 2 || district.length > 160) throw new Error("--district is required");
  if (!sub || !SUBJECT_RE.test(sub)) throw new Error("--sub must be the identity provider's subject claim");
  if (!name || !name.trim() || name.length > 160) throw new Error("--name is required");
  if (!email || !EMAIL_RE.test(email)) throw new Error("--email must be an email address");
  const iss = issuer.replace(/\/$/, "");
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "eduos-bootstrap" });
  await client.connect();
  const q = (sql, params) => client.query(sql, params);
  try {
    await q("BEGIN");
    // districts has no RLS of its own; look the district up by name first.
    let districtId = (await q("SELECT id FROM districts WHERE lower(name)=lower($1)", [district.trim()])).rows[0]?.id;
    const createdDistrict = !districtId;
    if (!districtId) districtId = (await q("SELECT gen_random_uuid() AS id")).rows[0].id;
    // FORCE ROW LEVEL SECURITY applies to the owner too: act inside the district.
    await q("SELECT set_config('app.district_id',$1,true)", [districtId]);
    if (createdDistrict) await q("INSERT INTO districts(id,name) VALUES($1,$2)", [districtId, district.trim()]);
    let user = (await q("SELECT id FROM users WHERE oidc_issuer=$1 AND oidc_subject=$2", [iss, sub])).rows[0];
    if (user) {
      const elsewhere = await q("SELECT 1 FROM memberships WHERE user_id=$1 AND district_id<>$2 LIMIT 1", [user.id, districtId]);
      if (elsewhere.rowCount) throw new Error("This identity already belongs to another district");
    } else {
      user = (await q("INSERT INTO users(oidc_issuer,oidc_subject,display_name,email) VALUES($1,$2,$3,$4) RETURNING id",
        [iss, sub, name.trim(), email.trim().toLowerCase()])).rows[0];
    }
    const m = await q(`INSERT INTO memberships(user_id,district_id,school_id,role,is_default)
                       VALUES($1,$2,NULL,'superintendent',true) ON CONFLICT DO NOTHING RETURNING id`, [user.id, districtId]);
    await q(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail)
             VALUES($1::uuid,$3,'operator','bootstrap','district',$1::text,'success',$2)`,
      [districtId, JSON.stringify({ createdDistrict, superintendent: user.id, membershipCreated: m.rowCount === 1 }), user.id]);
    await q("COMMIT");
    return { districtId, userId: user.id, createdDistrict, membershipCreated: m.rowCount === 1 };
  } catch (e) { await q("ROLLBACK").catch(() => {}); throw e; }
  finally { await client.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { values } = parseArgs({ options: { district: { type: "string" }, sub: { type: "string" }, name: { type: "string" }, email: { type: "string" } } });
    const r = await bootstrapDistrict({ databaseUrl: process.env.DATABASE_URL, issuer: process.env.OIDC_ISSUER, ...values });
    console.log(`${r.createdDistrict ? "Created" : "Using existing"} district ${r.districtId}; superintendent ${values.name} ` +
      `(${values.sub}) ${r.membershipCreated ? "provisioned" : "was already provisioned"}. They can now sign in and add schools and people under Administration.`);
  } catch (e) { console.error(`bootstrap failed: ${e.message}`); process.exit(1); }
}
