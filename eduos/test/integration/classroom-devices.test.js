// DEV-01: classroom rooms and the device registry against real PostgreSQL, as
// the runtime role: a school lists rooms and asks for devices; only district
// IT approves; only approved devices go in a room of their own school; a
// change sends a device back for approval; student devices can't be given
// screen viewing; other schools and districts see nothing.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const IT = "a0000000-0000-4000-8000-0000000000f1";

describe("DEV-01 classroom devices against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, room1, room2, otherRoom, display, tablet;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };

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
    for (const name of ["p1", "p2", "t1", "pa", "supt1", "supt2", "vp1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    s.it1 = await login(server.base, idp, "it1", { email: "it1@d1.test", email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a school lists its rooms; others can't add to it", async () => {
    room1 = ok(await as("p1")("POST", "/api/rooms", { name: "Room 101", building: "Main", capacity: 28 }), 201);
    room2 = ok(await as("vp1")("POST", "/api/rooms", { name: "Science lab" }), 201);
    assert.equal((await as("p1")("POST", "/api/rooms", { name: "room 101" })).status, 409, "names are unique per school");
    assert.equal((await as("t1")("POST", "/api/rooms", { name: "Mine" })).status, 403);
    assert.equal((await as("it1")("POST", "/api/rooms", { name: "Gym" })).body.error, "school_required");
    otherRoom = ok(await as("it1")("POST", "/api/rooms", { name: "Gym", schoolId: ID.s2 }), 201);
    assert.deepEqual(ok(await as("t1")("GET", "/api/rooms")).map(r => r.name), ["Room 101", "Science lab"], "a teacher sees their school's rooms");
    assert.deepEqual(ok(await as("p2")("GET", "/api/rooms")).map(r => r.name), ["Gym"]);
    assert.equal(ok(await as("it1")("GET", "/api/rooms")).length, 3, "IT sees the district");
    assert.deepEqual(ok(await as("supt2")("GET", "/api/rooms")), []);
    assert.equal((await as("pa")("GET", "/api/rooms")).status, 403);
  });

  it("a school asks for devices; capabilities are fixed per kind, with no screen viewing", async () => {
    assert.equal((await as("p1")("POST", "/api/devices", { kind: "student_device", name: "Cart A", capabilities: ["lock", "view_screen"] })).body.error, "invalid_device");
    assert.equal((await as("p1")("POST", "/api/devices", { kind: "display", name: "Board", capabilities: ["lock"] })).body.error, "invalid_device");
    display = ok(await as("p1")("POST", "/api/devices", { kind: "display", name: "Front board", maker: "Acme", model: "B75", serial: "SN-1", capabilities: ["show", "blank", "volume"] }), 201);
    tablet = ok(await as("p1")("POST", "/api/devices", { kind: "student_device", name: "Cart A", capabilities: ["lock", "unlock", "open_link", "focus"] }), 201);
    assert.deepEqual([display.status, display.requestedBy, display.school], ["pending", "Principal S1", "S1"]);
    assert.equal((await as("p1")("POST", "/api/devices", { kind: "display", name: "Dup", serial: "sn-1", capabilities: ["show"] })).status, 409, "a serial is registered once");
    assert.equal((await as("t1")("POST", "/api/devices", { kind: "display", name: "x", capabilities: ["show"] })).status, 403);
    // The database refuses screen viewing even if the API were bypassed.
    await assert.rejects(admin.query(`INSERT INTO classroom_devices(district_id,school_id,kind,name,capabilities,requested_by) VALUES($1,$2,'student_device','x',ARRAY['view_screen'],$3)`, [ID.d1, ID.s1, USERS.p1[0]]), /check constraint/);
    await assert.rejects(admin.query(`INSERT INTO classroom_devices(district_id,school_id,kind,name,capabilities,requested_by) VALUES($1,$2,'student_device','x',ARRAY['show'],$3)`, [ID.d1, ID.s1, USERS.p1[0]]), /check constraint/);
  });

  it("only district IT approves; only approved devices go in a room of their school", async () => {
    assert.equal((await as("p1")("POST", `/api/devices/${display.id}/place`, { roomId: room1.id })).body.error, "device_not_approved");
    assert.equal((await as("p1")("POST", `/api/devices/${display.id}/decision`, { decision: "approved" })).status, 403);
    assert.equal((await as("supt1")("POST", `/api/devices/${display.id}/decision`, { decision: "approved" })).status, 403);
    const pending = ok(await as("it1")("GET", "/api/devices?status=pending"));
    assert.deepEqual(pending.map(d => d.name).sort(), ["Cart A", "Front board"]);
    const a = ok(await as("it1")("POST", `/api/devices/${display.id}/decision`, { decision: "approved", note: "On the approved list" }));
    assert.deepEqual([a.status, a.decidedBy, a.note], ["approved", "District IT", "On the approved list"]);
    ok(await as("it1")("POST", `/api/devices/${tablet.id}/decision`, { decision: "rejected", note: "Use the district carts" }));

    assert.equal((await as("p1")("POST", `/api/devices/${display.id}/place`, { roomId: otherRoom.id })).status, 404, "not another school's room");
    assert.equal((await as("p1")("POST", `/api/devices/${tablet.id}/place`, { roomId: room1.id })).body.error, "device_not_approved");
    const placed = ok(await as("p1")("POST", `/api/devices/${display.id}/place`, { roomId: room1.id }));
    assert.equal(placed.room, "Room 101");
    assert.deepEqual(ok(await as("t1")("GET", "/api/rooms")).find(r => r.id === room1.id).devices.map(d => d.name), ["Front board"]);

    // The database also keeps approval with IT, whatever the route.
    await assert.rejects(admin.query(`SET ROLE ${db.names.app}; SELECT set_config('app.district_id','${ID.d1}',false), set_config('app.user_id','${USERS.p1[0]}',false),
      set_config('app.role','principal',false), set_config('app.school_id','${ID.s1}',false);
      UPDATE classroom_devices SET status='approved',decided_by='${USERS.p1[0]}',decided_at=now() WHERE id='${tablet.id}'`), /only district IT approves/)
      .finally(() => admin.query("RESET ROLE"));
  });

  it("changing what a device can do sends it back for approval; a rename doesn't", async () => {
    const renamed = ok(await as("p1")("PUT", `/api/devices/${display.id}`, { kind: "display", name: "Smart board", maker: "Acme", model: "B75", serial: "SN-1", capabilities: ["show", "blank", "volume"] }));
    assert.deepEqual([renamed.status, renamed.room], ["approved", "Room 101"]);
    const changed = ok(await as("p1")("PUT", `/api/devices/${display.id}`, { kind: "display", name: "Smart board", maker: "Acme", model: "B75", serial: "SN-1", capabilities: ["show", "blank", "volume", "input"] }));
    assert.deepEqual([changed.status, changed.room ?? null, changed.decidedBy ?? null], ["pending", null, null], "back to IT, out of the room");
    ok(await as("it1")("POST", `/api/devices/${display.id}/decision`, { decision: "approved" }));
    ok(await as("p1")("POST", `/api/devices/${display.id}/place`, { roomId: room2.id }));
    const events = ok(await as("t1")("GET", `/api/devices/${display.id}/events`)).map(e => e.event);
    assert.deepEqual(events, ["requested", "approved", "placed", "changed", "changed", "approved", "placed"]);
  });

  it("other schools see nothing; archiving a room empties it; devices retire, not delete", async () => {
    assert.equal((await as("p2")("GET", `/api/devices/${display.id}/events`)).status, 404);
    assert.deepEqual(ok(await as("p2")("GET", "/api/devices")), []);
    assert.equal((await as("p2")("POST", `/api/devices/${display.id}/retire`, {})).status, 404);
    assert.deepEqual(ok(await as("supt2")("GET", "/api/devices")), []);
    const arch = ok(await as("p1")("POST", `/api/rooms/${room2.id}/archive`, {}));
    assert.equal(arch.devicesRemoved, 1);
    assert.equal(ok(await as("it1")("GET", "/api/devices")).find(d => d.id === display.id).roomId, null);
    ok(await as("p1")("POST", `/api/devices/${display.id}/retire`, {}));
    assert.equal(ok(await as("p1")("GET", "/api/devices")).some(d => d.id === display.id), false);
    assert.deepEqual(ok(await as("p1")("GET", "/api/devices?status=retired")).map(d => d.id), [display.id]);
    assert.equal((await as("p1")("PUT", `/api/devices/${display.id}`, { kind: "display", name: "x", capabilities: ["show"] })).body.error, "device_retired");
  });
});
