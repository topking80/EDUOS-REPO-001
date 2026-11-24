// SAFE-03: severe weather and other hazards, with each room's shelter area,
// against real PostgreSQL as the runtime role.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const IT = "a0000000-0000-4000-8000-0000000000f1";

describe("SAFE-03 severe weather and shelter areas against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, room, room2, display, key, incident;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const titles = async (user) => (await admin.query("SELECT title,body FROM notification_outbox WHERE recipient_user_id=$1 AND kind='safety' AND channel='in_app' ORDER BY created_at", [user])).rows;
  const screen = async () => (await (await fetch(`${server.base}/api/classroom-agent/safety`, { method: "POST", headers: { authorization: `Bearer ${key}` } })).json()).data.safety;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($2,$1,'it1','District IT','it1@d1.test')", [idp.issuer, IT]);
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($2,$1,NULL,'it_admin',true)", [ID.d1, IT]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "vp1", "pa", "pu", "supt1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    s.it1 = await login(server.base, idp, "it1", { email: "it1@d1.test", email_verified: true });
    room = ok(await as("p1")("POST", "/api/rooms", { name: "Room 101" }), 201);
    room2 = ok(await as("p1")("POST", "/api/rooms", { name: "Room 102" }), 201);
    display = ok(await as("p1")("POST", "/api/devices", { kind: "display", name: "Front board", capabilities: ["show"] }), 201);
    ok(await as("it1")("POST", `/api/devices/${display.id}/decision`, { decision: "approved" }));
    ok(await as("p1")("POST", `/api/devices/${display.id}/place`, { roomId: room.id }));
    key = ok(await as("it1")("POST", `/api/devices/${display.id}/key`, {})).key;
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("the principal (or a vice principal) sets shelter areas per room and hazard, with a school default", async () => {
    const put = (who, body) => as(who)("PUT", "/api/safety/shelter-areas", body);
    ok(await put("p1", { roomId: null, hazard: "tornado", area: "Gym hallway (ground floor)" }));
    ok(await put("vp1", { roomId: room.id, hazard: "tornado", area: "Interior hallway B", route: "Turn left out of the door" }));
    ok(await put("p1", { roomId: room.id, hazard: "tornado", area: "Interior hallway C" }), 200);
    assert.equal((await put("t1", { roomId: room.id, hazard: "tornado", area: "x room" })).status, 403);
    assert.equal((await put("p2", { roomId: room.id, hazard: "tornado", area: "Elsewhere" })).status, 404, "another school's room");
    assert.equal((await put("p1", { roomId: room.id, hazard: "meteor", area: "Basement" })).status, 400);
    const d = ok(await as("t1")("GET", "/api/safety/shelter-areas"));
    assert.equal(d.canEdit, false);
    assert.equal(d.defaults.tornado.area, "Gym hallway (ground floor)");
    assert.equal(d.rooms.find(r => r.id === room.id).areas.tornado.area, "Interior hallway C");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM school_shelter_areas WHERE room_id=$1", [room.id])).rows[0].n, 2, "the old area is kept, ended");
  });

  it("a hazard only goes with a shelter or hold, and the confirm repeats it", async () => {
    assert.equal((await as("t1")("POST", "/api/safety/incidents", { kind: "lockdown", isDrill: true, hazard: "tornado" })).body.error, "invalid_hazard");
    incident = ok(await as("t1")("POST", "/api/safety/incidents", { kind: "shelter", isDrill: false, hazard: "tornado" }), 201);
    assert.equal((await as("t1")("POST", `/api/safety/incidents/${incident.id}/confirm`, { kind: "shelter", isDrill: false })).body.error, "confirmation_mismatch");
    ok(await as("t1")("POST", `/api/safety/incidents/${incident.id}/confirm`, { kind: "shelter", isDrill: false, hazard: "tornado" }));
  });

  it("staff, students and families get the hazard; staff see their room's shelter area; the room's screen shows it", async () => {
    const staff = ok(await as("t1")("GET", "/api/safety/status")).incidents[0];
    assert.equal(staff.label, "Shelter in place: Tornado warning"); assert.equal(staff.hazard, "tornado"); assert.match(staff.message, /lowest floor/);
    assert.match(ok(await as("pu")("GET", "/api/safety/status")).incidents[0].message, /Crouch low/);
    const fam = ok(await as("pa")("GET", "/api/safety/status")).incidents[0];
    assert.equal(fam.label, "Shelter in place: Tornado warning"); assert.match(fam.message, /tornado warning/);
    assert.ok((await titles(USERS.pa[0])).some(n => n.title === "S1: Shelter in place: Tornado warning in effect"));
    assert.ok((await titles(USERS.p1[0])).some(n => /^Shelter in place: Tornado warning at S1/.test(n.title)));
    const mine = ok(await as("t1")("GET", `/api/safety/incidents/${incident.id}/my-room`));
    assert.equal(mine.hazardLabel, "Tornado warning");
    assert.equal(mine.rooms.find(r => r.id === room.id).shelter.area, "Interior hallway C");
    assert.equal(mine.rooms.find(r => r.id === room2.id).shelter.area, "Gym hallway (ground floor)", "the school default");
    const v = await screen();
    assert.equal(v.mode, "alert"); assert.equal(v.title, "Shelter in place: Tornado warning"); assert.match(v.message, /Shelter area: Interior hallway C\./);
    ok(await as("p1")("POST", `/api/safety/incidents/${incident.id}/all-clear`, { kind: "shelter" }));
  });

  it("a hazardous-materials shelter: families get the generic notice", async () => {
    const i = ok(await as("p1")("POST", "/api/safety/incidents", { kind: "shelter", isDrill: true, hazard: "hazmat" }), 201);
    ok(await as("p1")("POST", `/api/safety/incidents/${i.id}/confirm`, { kind: "shelter", isDrill: true, hazard: "hazmat" }));
    const fam = ok(await as("pa")("GET", "/api/safety/status")).incidents[0];
    assert.equal(fam.label, "Shelter in place"); assert.equal(fam.hazard, null); assert.doesNotMatch(fam.message, /hazard/i);
    assert.match(ok(await as("t1")("GET", "/api/safety/status")).incidents[0].message, /ventilation/);
  });
});
