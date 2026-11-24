// SAFE-01b: vice principals start and lead safety alerts, against real
// PostgreSQL as the runtime role: start and confirm, everyone at the school
// (vice principals included) is alerted, the board and delivery report,
// SRO assignment, reunification and the all clear; another school's vice
// principal can do none of it; the pick-up desk stays with principals and teachers.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const VP2 = "a0000000-0000-4000-8000-0000000000f8", SRO = "a0000000-0000-4000-8000-0000000000f9";

describe("SAFE-01b vice principals lead safety alerts against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, incident;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const titles = async user => (await admin.query("SELECT title FROM notification_outbox WHERE recipient_user_id=$1 AND kind='safety' AND channel='in_app'", [user])).rows.map(r => r.title);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    for (const [id, sub, name, role, school] of [[VP2, "vp2", "Vice Principal S2", "vice_principal", ID.s2], [SRO, "sr1", "Officer S1", "sro", ID.s1]]) {
      await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($1,$2,$3,$4,$5)", [id, idp.issuer, sub, name, `${sub}@d1.test`]);
      await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($1,$2,$3,$4,true)", [id, ID.d1, school, role]);
    }
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "t1", "vp1", "pa"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    for (const name of ["vp2", "sr1"]) s[name] = await login(server.base, idp, name, { email: `${name}@d1.test`, email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a vice principal starts and confirms a lockdown; the whole school is alerted, other vice principals too", async () => {
    const caps = ok(await as("vp1")("GET", "/api/safety/status"));
    assert.equal(caps.canInitiate, true); assert.equal(caps.canLead, true);
    incident = ok(await as("vp1")("POST", "/api/safety/incidents", { kind: "lockdown", isDrill: false }), 201);
    const live = ok(await as("vp1")("POST", `/api/safety/incidents/${incident.id}/confirm`, { kind: "lockdown", isDrill: false }));
    assert.equal(live.status, "active");
    for (const u of [USERS.p1[0], USERS.t1[0], SRO]) assert.ok((await titles(u)).some(t => /^Lockdown at /.test(t)), u);
    assert.equal(ok(await as("t1")("GET", "/api/safety/status")).incidents.length, 1);
    assert.equal(ok(await as("vp2")("GET", "/api/safety/status")).incidents.length, 0, "another school");
    assert.equal((await as("vp2")("POST", `/api/safety/incidents/${incident.id}/confirm`, { kind: "lockdown", isDrill: false })).status, 404);
  });

  it("roll-call alerts reach the vice principal; the vice principal runs the board and the delivery report", async () => {
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5)", [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
    ok(await as("t1")("POST", `/api/safety/incidents/${incident.id}/rollcall`, { entries: [{ studentId: ID.alice, status: "missing" }] }), 201);
    assert.ok((await titles(USERS.vp1[0])).some(t => /Roll call: 1 missing/.test(t)));
    const b = ok(await as("vp1")("GET", `/api/safety/incidents/${incident.id}/board`));
    assert.equal(b.totals.missing, 1);
    assert.deepEqual(b.events.map(e => e.event), ["initiated", "confirmed", "rollcall"]);
    assert.ok(b.notifications.inApp.available >= 3, JSON.stringify(b.notifications));
    assert.equal((await as("vp2")("GET", `/api/safety/incidents/${incident.id}/board`)).status, 404);
    assert.equal((await as("vp1")("GET", `/api/safety/incidents/${incident.id}/sro-assignment`)).status, 200);
    ok(await as("vp1")("POST", `/api/safety/incidents/${incident.id}/sro-assignment`, { sroUserId: SRO }), 201);
    ok(await as("vp1")("POST", `/api/safety/incidents/${incident.id}/events`, { event: "responders", detail: "Police on scene" }));
  });

  it("reunification and the all clear; the pick-up desk stays with principals and teachers", async () => {
    ok(await as("vp1")("POST", `/api/safety/incidents/${incident.id}/reunification`, { point: "Gym doors" }));
    assert.equal((await as("vp1")("GET", "/api/pickup/queue")).status, 403);
    assert.equal((await as("vp1")("POST", "/api/pickup/verify", { code: "ABCDE-FGHJK" })).status, 403);
    assert.equal((await as("vp2")("POST", `/api/safety/incidents/${incident.id}/all-clear`, { kind: "lockdown" })).status, 404);
    ok(await as("vp1")("POST", `/api/safety/incidents/${incident.id}/all-clear`, { kind: "lockdown" }));
    assert.equal(ok(await as("pa")("GET", "/api/safety/status")).incidents.length, 0);
    const past = ok(await as("vp1")("GET", "/api/safety/incidents"));
    assert.equal(past[0].status, "closed");
    ok(await as("vp1")("POST", `/api/safety/incidents/${incident.id}/debrief`, { text: "Drill-free real lockdown; doors held; review hallway B." }));
  });
});
