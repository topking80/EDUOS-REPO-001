// 37.6.0 Credentials Wallet against real PostgreSQL (runtime role): a principal
// issues a credential on EDAL; the learner and their guardian export it as a
// signed Verifiable Credential, share it, see views and turn links off; the
// public verify endpoints show the minimum and catch revocation and tampering.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";
import { verifyDataIntegrity, deriveIssuerSeed, keyPairFromSeed } from "../../src/wallet/vc.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const SECRET = "wallet-test-secret-0123456789-abcdefghij";

describe("37.6.0 Credentials Wallet against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, credId, shareUrl, shareId, exported;
  const as = name => client(server.base, s[name]);
  const pub = (path, init) => fetch(`${server.base}${path}`, init).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const shareToken = url => new URL(url).hash.slice(1).split(".");

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, WALLET_ISSUER_SECRET: SECRET });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "t1", "pa", "pu", "pb", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    const r = await as("p1")("POST", "/api/learning/credentials", { studentId: ID.alice, kind: "award", title: "Reading Champion", description: "Read 40 books this year" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    credId = r.body.data.id;
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only the learner and their guardians hold the credential; staff and other families get nothing", async () => {
    for (const who of ["pu", "pa"]) {
      const w = await as(who)("GET", "/api/wallet");
      assert.equal(w.status, 200, JSON.stringify(w.body));
      assert.equal(w.body.data.issuerReady, true);
      assert.deepEqual(w.body.data.credentials.map(c => c.id), [credId]);
      assert.equal(w.body.data.credentials[0].onLedger, true);
    }
    assert.deepEqual((await as("pb")("GET", "/api/wallet")).body.data.credentials, []);
    for (const who of ["t1", "p1", "supt1", "supt2"]) assert.equal((await as(who)("GET", "/api/wallet")).status, 403, who);
    assert.equal((await as("pb")("GET", `/api/wallet/credentials/${credId}/vc`)).status, 404);
    assert.equal((await as("pb")("POST", `/api/wallet/credentials/${credId}/shares`, { days: 5 })).status, 404);
  });

  it("export is a signed Open Badges 3.0 credential from the school's own key, and it is audited", async () => {
    const r = await as("pu")("GET", `/api/wallet/credentials/${credId}/vc?name=initials`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /application\/vc\+ld\+json/);
    exported = r.body;
    assert.equal(verifyDataIntegrity(exported).verified, true);
    assert.equal(exported.issuer.id, keyPairFromSeed(deriveIssuerSeed(SECRET, ID.d1, ID.s1)).did);
    assert.equal(exported.credentialSubject.name, "Alice A.");
    assert.match(JSON.stringify(exported.evidence), /EDAL entry hash [0-9a-f]{64}/);
    const a = await admin.query("SELECT actor_role, detail FROM audit_events WHERE action='export' AND resource_type='credential' AND resource_id=$1", [credId]);
    assert.deepEqual(a.rows, [{ actor_role: "pupil", detail: "ob3;name=initials" }]);
  });

  it("a share link needs CSRF, shows the minimum publicly, and counts views", async () => {
    const noCsrf = await fetch(`${server.base}/api/wallet/credentials/${credId}/shares`, { method: "POST", headers: { cookie: s.pu.cookie, "content-type": "application/json" }, body: "{}" });
    assert.equal(noCsrf.status, 403);
    assert.equal((await as("pu")("POST", `/api/wallet/credentials/${credId}/shares`, { days: 400 })).status, 400);
    assert.equal((await as("pu")("POST", `/api/wallet/credentials/${credId}/shares`, { nameDisplay: "nickname" })).status, 400);
    const r = await as("pu")("POST", `/api/wallet/credentials/${credId}/shares`, { nameDisplay: "none", days: 7 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ({ url: shareUrl, id: shareId } = r.body.data);
    const [d, token] = shareToken(shareUrl);
    assert.equal(d, ID.d1);
    const stored = await admin.query("SELECT token_hash FROM wallet_shares WHERE id=$1", [shareId]);
    assert.notEqual(stored.rows[0].token_hash, token, "only the hash is stored");
    const v = await pub(`/api/public/wallet/${d}/${token}`);
    assert.equal(v.status, 200);
    assert.equal(v.body.data.result, "valid");
    assert.equal(v.body.data.view.holder, null, "the holder chose no name");
    assert.equal(v.body.data.view.achievement, "Reading Champion");
    assert.equal(v.body.data.school, "S1");
    assert.equal(JSON.stringify(v.body).includes("Alice"), false);
    assert.equal((await pub(`/api/public/wallet/${ID.d2}/${token}`)).status, 404, "a token only works in its own district");
    assert.equal((await pub(`/api/public/wallet/${d}/${"A".repeat(32)}`)).status, 404);
    const w = await as("pa")("GET", "/api/wallet");
    const share = w.body.data.credentials[0].shares.find(x => x.id === shareId);
    assert.equal(share.views, 1);
    assert.equal(share.state, "active");
  });

  it("the guardian can turn a link off; other families and staff cannot", async () => {
    assert.equal((await as("pb")("POST", `/api/wallet/shares/${shareId}/revoke`)).status, 404);
    assert.equal((await as("t1")("POST", `/api/wallet/shares/${shareId}/revoke`)).status, 403);
    assert.equal((await as("pa")("POST", `/api/wallet/shares/${shareId}/revoke`)).status, 200);
    const [d, token] = shareToken(shareUrl);
    assert.equal((await pub(`/api/public/wallet/${d}/${token}`)).body.data.result, "share_revoked");
    assert.equal((await as("pa")("POST", `/api/wallet/shares/${shareId}/revoke`)).status, 404, "already off");
  });

  it("pasted credentials: valid, tampered, and revoked by the school", async () => {
    const check = credential => pub("/api/public/wallet/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential }) });
    assert.equal((await check(exported)).body.data.result, "valid");
    const tampered = structuredClone(exported); tampered.credentialSubject.achievement.name = "Valedictorian";
    assert.equal((await check(tampered)).body.data.result, "invalid");
    assert.equal((await check("nope")).status, 400);
    const rv = await as("p1")("POST", `/api/learning/credentials/${credId}/revoke`, { reason: "Issued to the wrong learner by mistake" });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.equal((await check(exported)).body.data.result, "revoked");
    assert.equal((await as("pu")("POST", `/api/wallet/credentials/${credId}/shares`, { days: 3 })).status, 409);
  });

  it("the public verify page is served with the app's CSP and no inline script", async () => {
    const r = await fetch(`${server.base}/verify/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<script src="verify\.js" type="module"><\/script>/);
    assert.doesNotMatch(html, /<script>(?!<\/script>)/);
    assert.match(r.headers.get("content-security-policy") || "", /script-src 'self'/);
  });

  it("the runtime role can't delete shares, and a FERPA purge removes them", async () => {
    const n = (await admin.query("SELECT count(*)::int AS n FROM wallet_shares WHERE student_id=$1", [ID.alice])).rows[0].n;
    assert.ok(n >= 1);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN"); await app.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
      await assert.rejects(app.query("DELETE FROM wallet_shares"), /permission denied/);
      await app.query("ROLLBACK");
    } finally { await app.end(); }
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
    const out = (await admin.query("SELECT eduos_purge_student($1) AS j", [ID.alice])).rows[0].j;
    await admin.query("COMMIT");
    assert.equal(out.wallet_shares, n);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM wallet_shares WHERE student_id=$1", [ID.alice])).rows[0].n, 0);
  });
});
