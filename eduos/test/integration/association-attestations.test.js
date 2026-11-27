// SPORT-05: signed athlete eligibility attestations for a state athletic
// association, against real PostgreSQL: agreement, parent consent, the
// athletic director's certification, and the association's audited reads.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { parsePublicKey } from "../../src/federation/policy-bundle.js";
import { verifyAttestation } from "../../src/federation/eligibility.js";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const TODAY = new Date().toISOString().slice(0, 10);

describe("SPORT-05 eligibility attestations for an athletic association", { skip }, () => {
  let db, idp, server, admin, team, s = {}, ag, token, attestation;
  const as = name => client(server.base, s[name]);
  const assoc = (path, tok = token) => fetch(`${server.base}/api/association/attestations${path}`, { headers: { authorization: `Bearer ${tok}` } });
  const certify = (who, body) => fetch(`${server.base}/api/activities/${team.id}/attestations`, { method: "POST",
    headers: { "content-type": "application/json", cookie: s[who].cookie, "x-csrf-token": s[who].csrf }, body: JSON.stringify(body) });

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, EXCHANGE_SIGNING_SECRET: crypto.randomBytes(24).toString("hex") });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["supt1", "p1", "t1", "vp1", "pa", "pb"]) s[n] = await login(server.base, idp, n, { email_verified: true });
    team = (await as("p1")("POST", "/api/activities", { kind: "sport", title: "Falcons Basketball", status: "published" })).body.data;
    assert.equal((await as("p1")("POST", `/api/activities/${team.id}/staff`, { userId: USERS.t1[0], staffRole: "coach" })).status, 201);
    assert.equal((await as("p1")("POST", `/api/schools/${ID.s1}/athletic-directors`, { userId: USERS.vp1[0] })).status, 201);
    for (const [st, j] of [[ID.alice, 7], [ID.bob, 12]])
      await admin.query("INSERT INTO activity_roster_entries(district_id,school_id,activity_id,student_id,jersey_number,added_by) VALUES($1,$2,$3,$4,$5,$6)", [ID.d1, ID.s1, team.id, st, j, USERS.p1[0]]);
    // Alice: present and passing. Bob: half absent (not eligible).
    for (let i = 1; i <= 10; i++) {
      await admin.query("INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,current_date-$3::int,'present')", [ID.d1, ID.alice, i]);
      await admin.query("INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,current_date-$3::int,$4)", [ID.d1, ID.bob, i, i <= 5 ? "absent" : "present"]);
    }
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only the superintendent makes an agreement; the token is shown once", async () => {
    const body = { associationRef: "uil-tx", associationName: "University Interscholastic League", legalBasis: "UIL Constitution, eligibility verification", effectiveTo: "2099-06-30" };
    assert.equal((await as("p1")("POST", "/api/district/athletic-associations", body)).status, 403);
    assert.equal((await as("supt1")("POST", "/api/district/athletic-associations", { ...body, associationRef: "UIL TX" })).status, 400);
    const r = await as("supt1")("POST", "/api/district/athletic-associations", body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ag = r.body.data; token = ag.accessToken;
    assert.match(token, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/);
    const list = (await as("supt1")("GET", "/api/district/athletic-associations")).body.data;
    assert.ok(!JSON.stringify(list).includes(token.split(".")[1]), "never shown again");
    const { rows } = await admin.query("SELECT token_hash FROM athletic_association_agreements");
    assert.notEqual(rows[0].token_hash, token.split(".")[1]);
  });

  it("an athlete is listed only after a parent agrees, with name, grade and status only", async () => {
    const fam = (await as("pa")("GET", "/api/family/association-consents")).body.data;
    assert.deepEqual(fam.agreements.map(a => a.associationName), ["University Interscholastic League"]);
    assert.deepEqual(fam.students.map(k => [k.name, k.teams]), [["Alice A", ["Falcons Basketball"]]]);
    assert.equal((await as("pa")("PUT", `/api/family/association-consents/${ID.bob}`, { agreementId: ag.id, share: true })).status, 404, "not Bob's parent");
    assert.equal((await as("pa")("PUT", `/api/family/association-consents/${ID.alice}`, { agreementId: ag.id, share: true })).status, 200);

    assert.equal((await certify("t1", { agreementId: ag.id })).status, 403, "the coach can't certify; only the athletic director");
    const r = await certify("vp1", { agreementId: ag.id, validDays: 7 });
    assert.equal(r.status, 201, await r.clone().text());
    attestation = await r.json();
    assert.deepEqual(attestation.athletes.map(a => [a.name, a.grade, a.status]), [["Alice A", "3", "eligible"]]);
    assert.equal(attestation.withheld, 1, "Bob's family hasn't agreed");
    assert.deepEqual(Object.keys(attestation.athletes[0]).sort(), ["athlete_ref", "grade", "name", "status"]);
    const text = JSON.stringify(attestation);
    for (const x of ["Bob", ID.alice, "percent", "absent", "present", "reasons", "jersey", "Guard"]) assert.ok(!text.includes(x), `${x} isn't in the attestation`);
    assert.equal(attestation.as_of, TODAY); assert.equal(attestation.agreement.association_ref, "uil-tx");
    assert.equal((await certify("vp1", { agreementId: ag.id, validDays: 60 })).status, 400);
  });

  it("the association reads with its token while the agreement is in force; every read is logged", async () => {
    assert.equal((await assoc("", `${ag.id}.${"x".repeat(43)}`)).status, 401);
    assert.equal((await fetch(`${server.base}/api/association/attestations`)).status, 401);
    const list = await assoc("");
    assert.equal(list.status, 200);
    const d = (await list.json()).data;
    assert.deepEqual(d.attestations.map(x => [x.id, x.athletes, x.activity]), [[attestation.attestation_id, 1, "Falcons Basketball"]]);
    const file = await (await assoc(`/${attestation.attestation_id}`)).json();
    const v = verifyAttestation(file, parsePublicKey(d.signingKey.publicKey), TODAY);
    assert.equal(v.ok, true, v.reason);
    const altered = structuredClone(file); altered.athletes[0].status = "not_eligible";
    assert.equal(verifyAttestation(altered, parsePublicKey(d.signingKey.publicKey), TODAY).reason, "altered");
    const { rows } = await admin.query("SELECT action, outcome, reason FROM association_reads ORDER BY id");
    assert.deepEqual(rows.map(r => [r.action, r.outcome, r.reason]), [["list", "denied", "bad_token"], ["list", "allowed", null], ["read", "allowed", null]]);
    await assert.rejects(admin.query("DELETE FROM association_reads"), /append-only/);
    const app = new pg.Client(db.appUrl); await app.connect();
    try { await assert.rejects(app.query("INSERT INTO association_reads(district_id, agreement_id, action, outcome) VALUES ($1,$2,'read','allowed')", [ID.d1, ag.id]), /permission denied/, "only the access function logs reads"); }
    finally { await app.end(); }
    const seen = (await as("supt1")("GET", "/api/district/athletic-associations")).body.data.agreements[0];
    assert.equal(seen.reads.length, 3); assert.equal(seen.consents, 1);
  });

  it("withdrawing consent withdraws what was certified; revoking the agreement stops all reads", async () => {
    const r = await as("pa")("PUT", `/api/family/association-consents/${ID.alice}`, { agreementId: ag.id, share: false });
    assert.equal(r.body.data.attestationsWithdrawn, 1);
    assert.equal((await assoc(`/${attestation.attestation_id}`)).status, 410);
    assert.deepEqual((await (await assoc("")).json()).data.attestations, []);
    // Re-certify after a new yes, then revoke the agreement.
    await as("pa")("PUT", `/api/family/association-consents/${ID.alice}`, { agreementId: ag.id, share: true });
    const again = await (await certify("vp1", { agreementId: ag.id })).json();
    assert.equal((await as("vp1")("POST", `/api/attestations/${again.attestation_id}/withdraw`, { reason: "Roster changed" })).status, 200);
    assert.equal((await assoc(`/${again.attestation_id}`)).status, 410);
    const rotated = (await as("supt1")("POST", `/api/district/athletic-associations/${ag.id}/token`, {})).body.data.accessToken;
    assert.equal((await assoc("")).status, 401, "the old token stops working");
    assert.equal((await assoc("", rotated)).status, 200);
    assert.equal((await as("supt1")("POST", `/api/district/athletic-associations/${ag.id}/revoke`, { reason: "Agreement ended by the board" })).status, 200);
    assert.equal((await assoc("", rotated)).status, 403);
    assert.equal((await certify("vp1", { agreementId: ag.id })).status, 409);
    const { rows } = await admin.query("SELECT reason FROM association_reads WHERE outcome='denied' ORDER BY id DESC LIMIT 1");
    assert.equal(rows[0].reason, "agreement_revoked");
  });
});
