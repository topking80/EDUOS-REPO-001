import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../db/007_guardian_invitations.sql", import.meta.url), "utf8");
const auth = await readFile(new URL("../src/oidc.js", import.meta.url), "utf8");
const grants = await readFile(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");
const bridge = await readFile(new URL("../public/api-bridge.js", import.meta.url), "utf8");

test("guardian invitation tokens are random, hashed at rest, and single-use",()=>{
  assert.match(server,/randomBytes\(32\)/);
  assert.match(server,/token_hash/);
  assert.match(server,/status!==\"pending\"/);
  assert.match(migration,/token_hash text NOT NULL UNIQUE/);
});
test("guardian acceptance requires an authenticated parent and matching account email and school",()=>{
  assert.match(server,/req\.actor\.role!==\"parent\"/);
  // 32.0.53: matching uses the IdP-verified email captured at sign-in and any
  // active parent membership at the invitation's school.
  assert.match(server,/req\.actor\.verifiedEmail\.trim\(\)\.toLowerCase\(\)!==row\.invited_email/);
  assert.match(server,/m\.role='parent' AND m\.school_id=\$3/);
  assert.match(auth,/export function verifiedEmailFromClaims/);
});
test("guardian invitation creation is staff-scoped, rate-limited, and audited",()=>{
  assert.match(server,/guardianInviteLimiter/);
  assert.match(server,/\[\"principal\",\"superintendent\"\]/);
  assert.match(server,/school_scope_denied/);
  assert.match(server,/guardian_invitation/);
});
test("guardian invitations are tenant isolated and have runtime grants",()=>{
  assert.match(migration,/ENABLE ROW LEVEL SECURITY/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(grants,/GRANT SELECT, INSERT, UPDATE ON guardian_invitations/);
  assert.match(grants,/REVOKE DELETE, TRUNCATE ON guardian_invitations/);
});
test("frontend API bridge exposes invitation lifecycle without claiming email delivery",()=>{
  assert.match(bridge,/createGuardianInvitation/);
  assert.match(bridge,/acceptGuardianInvitation/);
  assert.match(bridge,/revokeGuardianInvitation/);
  assert.match(server,/delivery:\"not_configured\"/);
});
