// SAFE-02: classroom displays and kiosks follow a safety alert, against real
// PostgreSQL as the runtime role. Each device poll says what to show: dark
// and silent in a lockdown, a muted notice otherwise, all clear afterwards;
// another school's devices aren't affected. Check-in and teacher commands
// pause while the alert is live. Leaders see which devices switched.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const IT = "a0000000-0000-4000-8000-0000000000f1", SRO = "a0000000-0000-4000-8000-0000000000f6";

describe("SAFE-02 classroom displays follow safety alerts against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, room, room2, display, kiosk, cart, other, keys = {}, incident;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const agent = async (key, path, body) => {
    const r = await fetch(`${server.base}/api/classroom-agent/${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json() };
  };
  const view = async dev => (await agent(keys[dev.id], "safety")).body.data.safety;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($2,$1,'it1','District IT','it1@d1.test'),($3,$1,'sr1','Officer S1','sr1@d1.test')", [idp.issuer, IT, SRO]);
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($2,$1,NULL,'it_admin',true),($3,$1,$4,'sro',true)", [ID.d1, IT, SRO, ID.s1]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    for (const name of ["it1", "sr1"]) s[name] = await login(server.base, idp, name, { email: `${name}@d1.test`, email_verified: true });
    room = ok(await as("p1")("POST", "/api/rooms", { name: "Room 101" }), 201);
    room2 = ok(await as("p2")("POST", "/api/rooms", { name: "S2 Room" }), 201);
    const add = async (who, r, body) => {
      const d = ok(await as(who)("POST", "/api/devices", body), 201);
      ok(await as("it1")("POST", `/api/devices/${d.id}/decision`, { decision: "approved" }));
      ok(await as(who)("POST", `/api/devices/${d.id}/place`, { roomId: r.id }));
      keys[d.id] = ok(await as("it1")("POST", `/api/devices/${d.id}/key`, {})).key;
      return d;
    };
    display = await add("p1", room, { kind: "display", name: "Front board", capabilities: ["show", "blank", "volume"] });
    kiosk = await add("p1", room, { kind: "kiosk", name: "Door kiosk", capabilities: ["checkin"] });
    cart = await add("p1", room, { kind: "student_device", name: "Cart A", capabilities: ["lock", "unlock"] });
    other = await add("p2", room2, { kind: "display", name: "S2 board", capabilities: ["show"] });
    ok(await as("p1")("POST", `/api/rooms/${room.id}/timetable`, { teacherId: USERS.t1[0], weekdays: [1, 2, 3, 4, 5, 6, 7], starts: "00:00", ends: "23:59" }), 201);
    const code = (await agent(keys[display.id], "code")).body.data.code;
    ok(await as("t1")("POST", `/api/rooms/${room.id}/pair`, { code, controllerName: "My phone" }), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("no alert: devices show normally; a bad key gets nothing", async () => {
    assert.deepEqual(await view(display), { mode: "normal" });
    assert.equal((await agent("cdk1.x", "safety")).status, 401);
    assert.equal((await agent(`cdk1.${display.id}.${"A".repeat(43)}`, "safety")).status, 401);
    assert.ok((await agent(keys[kiosk.id], "checkin-code")).body.data.path, "check-in works");
  });

  it("a lockdown: displays and kiosks go dark and silent, student devices a quiet notice; another school's stay normal", async () => {
    incident = ok(await as("t1")("POST", "/api/safety/incidents", { kind: "lockdown", isDrill: true }), 201);
    assert.deepEqual(await view(display), { mode: "normal" }, "nothing until it's confirmed");
    ok(await as("t1")("POST", `/api/safety/incidents/${incident.id}/confirm`, { kind: "lockdown", isDrill: true }));
    const d = await view(display);
    assert.equal(d.mode, "dark"); assert.equal(d.volume, 0); assert.equal(d.message, null); assert.equal(d.title, "Lockdown (drill)");
    assert.equal((await view(kiosk)).mode, "dark");
    const c = await view(cart);
    assert.equal(c.mode, "quiet"); assert.match(c.message, /Silence/);
    assert.deepEqual(await view(other), { mode: "normal" });
    const polled = (await agent(keys[display.id], "commands")).body.data;
    assert.equal(polled.safety.mode, "dark", "the command poll carries it too");
  });

  it("while it's live: check-in and teacher commands pause", async () => {
    const code = (await agent(keys[kiosk.id], "checkin-code")).body.data;
    assert.equal(code.paused, true); assert.equal(code.path, null);
    assert.equal((await agent(keys[kiosk.id], "kiosk-checkin", { studentNumber: "S1-A" })).body.data.error, "paused_for_safety");
    assert.equal((await as("t1")("POST", `/api/devices/${display.id}/commands`, { capability: "blank", args: { on: false } })).body.error, "paused_for_safety");
  });

  it("leaders and the SRO see which devices switched; others can't", async () => {
    const d = ok(await as("p1")("GET", `/api/safety/incidents/${incident.id}/displays`));
    assert.equal(d.total, 3); assert.equal(d.switched, 3);
    assert.deepEqual(d.devices.map(x => x.room), ["Room 101", "Room 101", "Room 101"]);
    assert.equal(ok(await as("sr1")("GET", `/api/safety/incidents/${incident.id}/displays`)).total, 3);
    assert.equal((await as("t1")("GET", `/api/safety/incidents/${incident.id}/displays`)).status, 403);
    assert.equal((await as("p2")("GET", `/api/safety/incidents/${incident.id}/displays`)).status, 404);
  });

  it("reunification shows a notice; the all clear shows briefly, then normal; check-in resumes", async () => {
    ok(await as("p1")("POST", `/api/safety/incidents/${incident.id}/reunification`, { point: "Gym doors" }));
    const r = await view(display);
    assert.equal(r.mode, "alert"); assert.match(r.title, /Reunification/);
    ok(await as("p1")("POST", `/api/safety/incidents/${incident.id}/all-clear`, { kind: "lockdown" }));
    const done = await view(display);
    assert.equal(done.mode, "all_clear");
    assert.ok((await agent(keys[kiosk.id], "checkin-code")).body.data.path, "check-in resumes");
    await admin.query("UPDATE safety_incidents SET closed_at=now()-interval '11 minutes' WHERE id=$1", [incident.id]);
    assert.deepEqual(await view(display), { mode: "normal" });
  });

  it("a shelter: a muted full-screen notice with the student instructions", async () => {
    const i = ok(await as("p1")("POST", "/api/safety/incidents", { kind: "shelter", isDrill: false }), 201);
    ok(await as("p1")("POST", `/api/safety/incidents/${i.id}/confirm`, { kind: "shelter", isDrill: false }));
    const v = await view(display);
    assert.equal(v.mode, "alert"); assert.equal(v.title, "Shelter in place"); assert.equal(v.volume, 0); assert.match(v.message, /safe area/);
    assert.equal((await view(cart)).mode, "alert");
  });
});
