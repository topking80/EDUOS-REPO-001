// STATE-01: the state index and educators' licenses against real PostgreSQL, as
// the runtime role: everyone reads the index; the superintendent sets the
// district's state and adds sourced entries; an educator records their own
// licenses; the district verifies; a change needs verifying again; a principal
// reads only their school's people; other districts see nothing.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("STATE-01 state index and licenses against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, lic;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "p2", "t1", "pa"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("lists every state and DC; one state's index carries its sources", async () => {
    const all = ok(await as("pa")("GET", "/api/states"));
    assert.equal(all.states.length, 51);
    assert.equal(all.districtState, null);
    const tx = ok(await as("t1")("GET", "/api/states/tx"));
    assert.equal(tx.name, "Texas");
    const agency = tx.sections.find(x => x.key === "agency").entries;
    assert.ok(agency.every(e => e.url.startsWith("https://") && e.source && e.checked), "every curated link has a source and a date");
    assert.ok(tx.sections.find(x => x.key === "athletics").entries.some(e => e.from === "national"));
    assert.equal((await as("t1")("GET", "/api/states/zz")).status, 404);
  });

  it("the superintendent sets the state and adds sourced entries; others cannot", async () => {
    assert.equal((await as("p1")("PUT", "/api/district/state", { stateCode: "TX" })).status, 403);
    assert.equal((await as("supt1")("PUT", "/api/district/state", { stateCode: "XX" })).body.error, "invalid_state");
    ok(await as("supt1")("PUT", "/api/district/state", { stateCode: "TX" }));
    assert.equal(ok(await as("t1")("GET", "/api/states")).districtState, "TX");
    const bad = { category: "licensing", title: "Certificate lookup", url: "http://example.org/x", verifiedOn: today };
    assert.equal((await as("supt1")("POST", "/api/states/TX/entries", bad)).body.error, "invalid_state_entry", "https only");
    assert.equal((await as("supt1")("POST", "/api/states/TX/entries", { ...bad, url: "https://example.org/x", verifiedOn: inDays(3) })).status, 400, "not checked in the future");
    assert.equal((await as("t1")("POST", "/api/states/TX/entries", { ...bad, url: "https://example.org/x" })).status, 403);
    const e = ok(await as("supt1")("POST", "/api/states/TX/entries", { ...bad, url: "https://example.org/lookup", sourceUrl: "https://example.org/", description: "Look up a certificate" }), 201);
    const tx = ok(await as("t1")("GET", "/api/states/TX"));
    const lic = tx.sections.find(x => x.key === "licensing").entries;
    assert.deepEqual(lic.map(x => [x.title, x.from, x.addedBy]), [["Certificate lookup", "district", "Supt One"]]);
    assert.equal(ok(await as("supt2")("GET", "/api/states/TX")).sections.find(x => x.key === "licensing").entries.length, 0, "another district does not see it");
    ok(await as("supt1")("POST", `/api/state-entries/${e.id}/retire`, {}));
    assert.equal(ok(await as("t1")("GET", "/api/states/TX")).sections.find(x => x.key === "licensing").entries.length, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM district_state_entries WHERE retired_at IS NOT NULL`)).rows[0].n, 1, "kept, retired");
  });

  it("an educator records a license; the district verifies; an edit needs verifying again", async () => {
    assert.equal((await as("pa")("GET", "/api/licenses/mine")).status, 403);
    assert.equal((await as("t1")("POST", "/api/licenses", { stateCode: "TX", number: "123", type: "Standard", issuedOn: inDays(10), expiresOn: inDays(5) })).body.error, "invalid_license");
    lic = ok(await as("t1")("POST", "/api/licenses", { stateCode: "TX", number: "TX-445566", type: "Standard Teaching", endorsements: "Math 7-12", issuedOn: "2022-07-01", expiresOn: inDays(40) }), 201);
    assert.deepEqual([lic.status, lic.daysLeft, lic.state], ["self_reported", 40, "Texas"]);
    ok(await as("p2")("POST", "/api/licenses", { stateCode: "OH", number: "OH-1", type: "Principal", expiresOn: inDays(400) }), 201);

    // Nobody but the district verifies, not even the owner.
    assert.equal((await as("t1")("POST", `/api/licenses/${lic.id}/verify`, { decision: "verified" })).status, 403);
    const { district_id } = (await admin.query(`SELECT district_id FROM educator_licenses WHERE id=$1`, [lic.id])).rows[0];
    await assert.rejects(admin.query(`SET ROLE ${db.names.app}; SELECT set_config('app.district_id','${district_id}',false),
      set_config('app.user_id','${USERS.t1[0]}',false), set_config('app.role','teacher',false); UPDATE educator_licenses SET status='verified',verified_by='${USERS.t1[0]}' WHERE id='${lic.id}'`), /only the district verifies/)
      .finally(() => admin.query(`RESET ROLE`));

    const v = ok(await as("supt1")("POST", `/api/licenses/${lic.id}/verify`, { decision: "verified", note: "Checked on the state lookup" }));
    assert.deepEqual([v.status, v.note], ["verified", "Checked on the state lookup"]);
    assert.equal(ok(await as("t1")("GET", "/api/licenses/mine"))[0].verifiedBy, "Supt One");

    const edited = ok(await as("t1")("PUT", `/api/licenses/${lic.id}`, { stateCode: "TX", number: "TX-445566", type: "Standard Teaching", endorsements: "Math 7-12, Physics", issuedOn: "2022-07-01", expiresOn: inDays(40) }));
    assert.deepEqual([edited.status, edited.verifiedBy ?? null], ["self_reported", null], "an edit resets verification");
    assert.equal((await as("p1")("PUT", `/api/licenses/${lic.id}`, { stateCode: "TX", number: "x", type: "y" })).status, 404, "only the owner edits");
  });

  it("leaders see licenses in scope, with expiring soon", async () => {
    const district = ok(await as("supt1")("GET", "/api/licenses"));
    assert.deepEqual(district.map(l => l.name).sort(), ["Principal S2", "Teacher S1"]);
    assert.deepEqual(ok(await as("supt1")("GET", "/api/licenses?expiringWithin=90")).map(l => l.name), ["Teacher S1"]);
    assert.deepEqual(ok(await as("p1")("GET", "/api/licenses")).map(l => l.name), ["Teacher S1"], "a principal: their own school only");
    assert.deepEqual(ok(await as("p2")("GET", "/api/licenses")).map(l => l.name), ["Principal S2"]);
    assert.deepEqual(ok(await as("supt2")("GET", "/api/licenses")), [], "other districts see none");
    assert.equal((await as("t1")("GET", "/api/licenses")).status, 403);
  });

  it("an educator retires their own license; it is kept", async () => {
    ok(await as("t1")("POST", `/api/licenses/${lic.id}/retire`, {}));
    assert.deepEqual(ok(await as("t1")("GET", "/api/licenses/mine")), []);
    assert.equal((await as("supt1")("POST", `/api/licenses/${lic.id}/retire`, {})).status, 404, "only the owner retires");
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM educator_licenses WHERE id=$1`, [lic.id])).rows[0].n, 1);
  });
});
