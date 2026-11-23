// DEV-02: the room timetable and pairing a teacher's own device, against real
// PostgreSQL as the runtime role: IT issues a device key; the room display
// gets a short code; only a teacher timetabled in the room now pairs with it;
// codes work once and only the newest; pairings end with the slot; keys go
// with approval; codes are never readable by the app role.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const IT = "a0000000-0000-4000-8000-0000000000f1";

describe("DEV-02 classroom pairing against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, room, display, key, slot, pairing, today;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const agent = async (k = key) => {
    const r = await fetch(`${server.base}/api/classroom-agent/code`, { method: "POST", headers: { authorization: `Bearer ${k}` } });
    return { status: r.status, body: await r.json() };
  };

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
    today = (await admin.query(`SELECT extract(isodow FROM now() AT TIME ZONE timezone)::int AS d FROM schools WHERE id=$1`, [ID.s1])).rows[0].d;
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "pa"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    s.it1 = await login(server.base, idp, "it1", { email: "it1@d1.test", email_verified: true });
    room = ok(await as("p1")("POST", "/api/rooms", { name: "Room 101" }), 201);
    display = ok(await as("p1")("POST", "/api/devices", { kind: "display", name: "Front board", capabilities: ["show", "blank", "volume"] }), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only IT issues a key, only for an approved device; the display shows a code once it's in a room", async () => {
    assert.equal((await as("it1")("POST", `/api/devices/${display.id}/key`, {})).body.error, "device_not_approved");
    ok(await as("it1")("POST", `/api/devices/${display.id}/decision`, { decision: "approved" }));
    assert.equal((await as("p1")("POST", `/api/devices/${display.id}/key`, {})).status, 403);
    key = ok(await as("it1")("POST", `/api/devices/${display.id}/key`, {})).key;
    assert.match(key, /^cdk1\./);
    const first = await agent(); assert.deepEqual(first.body.data, { code: null, reason: "not_in_a_room" }, JSON.stringify(first));
    ok(await as("p1")("POST", `/api/devices/${display.id}/place`, { roomId: room.id }));
    const a = (await agent()).body.data;
    assert.match(a.code, /^\d{6}$/); assert.equal(a.room, "Room 101"); assert.equal(a.pairedWith, null);
    assert.equal((await agent("cdk1.00000000-0000-4000-8000-000000000000.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).status, 401);
    assert.equal((await agent("nope")).status, 401);
  });

  it("the school sets the timetable for its own teachers", async () => {
    const body = { teacherId: USERS.t1[0], weekdays: [1, 2, 3, 4, 5, 6, 7], starts: "00:00", ends: "23:59", label: "Math 3" };
    assert.equal((await as("t1")("POST", `/api/rooms/${room.id}/timetable`, body)).status, 403);
    assert.equal((await as("p2")("POST", `/api/rooms/${room.id}/timetable`, body)).status, 404, "not another school's room");
    assert.equal((await as("p1")("POST", `/api/rooms/${room.id}/timetable`, { ...body, teacherId: USERS.p2[0] })).body.error, "teacher_at_this_school_required");
    assert.equal((await as("p1")("POST", `/api/rooms/${room.id}/timetable`, { ...body, starts: "10:00", ends: "09:00" })).body.error, "invalid_slot");
    assert.deepEqual(ok(await as("p1")("GET", `/api/rooms/${room.id}/teachers`)).map(t => t.name), ["Teacher Parent", "Teacher S1"]);
    assert.equal((await as("p2")("GET", `/api/rooms/${room.id}/teachers`)).status, 404);
    assert.equal((await as("t1")("GET", `/api/rooms/${room.id}/teachers`)).status, 403);
    slot = ok(await as("p1")("POST", `/api/rooms/${room.id}/timetable`, body), 201);
    ok(await as("p1")("POST", `/api/rooms/${room.id}/timetable`, { ...body, teacherId: USERS.tp[0], weekdays: [today === 7 ? 1 : today + 1], label: "Not today" }), 201);
    const tt = ok(await as("t1")("GET", `/api/rooms/${room.id}/timetable`));
    assert.deepEqual(tt.map(x => [x.teacher, x.starts, x.ends]).sort(), [["Teacher Parent", "00:00", "23:59"], ["Teacher S1", "00:00", "23:59"]]);
  });

  it("a teacher timetabled now pairs with the code on the display; codes work once and only the newest", async () => {
    const old = (await agent()).body.data.code;
    const code = (await agent()).body.data.code;
    if (old !== code) assert.equal((await as("t1")("POST", `/api/rooms/${room.id}/pair`, { code: old, controllerName: "My phone" })).body.error, "wrong_code", "an older code no longer works");
    assert.equal((await as("p1")("POST", `/api/rooms/${room.id}/pair`, { code, controllerName: "x" })).status, 403, "teachers only");
    assert.equal((await as("tp")("POST", `/api/rooms/${room.id}/pair`, { code, controllerName: "x" })).body.error, "not_timetabled_now");
    pairing = ok(await as("t1")("POST", `/api/rooms/${room.id}/pair`, { code, controllerName: "My phone" }), 201);
    assert.equal(pairing.room, "Room 101");
    assert.ok(Date.parse(pairing.until) > Date.now(), "until the slot ends");
    assert.equal((await as("t1")("POST", `/api/rooms/${room.id}/pair`, { code, controllerName: "My phone" })).body.error, "wrong_code", "a code works once");
    assert.equal((await agent()).body.data.pairedWith.teacher, "Teacher S1", "the display shows who is paired");

    const mine = ok(await as("t1")("GET", "/api/my/rooms"));
    assert.deepEqual(mine.map(r => [r.name, r.now, r.pairing?.controller, r.devices.map(d => d.name).join()]), [["Room 101", true, "My phone", "Front board"]]);
    assert.deepEqual(ok(await as("tp")("GET", "/api/my/rooms")).map(r => [r.name, r.now, r.pairing]), [["Room 101", false, null]]);
    assert.deepEqual(ok(await as("p1")("GET", "/api/pairings")).map(p => [p.teacher, p.room, p.via]), [["Teacher S1", "Room 101", "Front board"]]);
    assert.deepEqual(ok(await as("p2")("GET", "/api/pairings")), [], "another school sees none");
    assert.deepEqual(ok(await as("tp")("GET", "/api/my/rooms"))[0].pairing, null, "teachers don't see each other's pairings");
  });

  it("codes and pairings can't be reached around the functions", async () => {
    await admin.query(`SET ROLE ${db.names.app}`);
    try {
      await assert.rejects(admin.query(`SELECT * FROM classroom_pair_codes`), /permission denied/);
      await assert.rejects(admin.query(`INSERT INTO classroom_pairings(district_id,school_id,room_id,teacher_user_id,schedule_id,via_device_id,controller_name,expires_at)
        VALUES('${ID.d1}','${ID.s1}','${room.id}','${USERS.tp[0]}','${slot.id}','${display.id}','x',now()+interval '1 hour')`), /permission denied/);
    } finally { await admin.query("RESET ROLE"); }
  });

  it("ending the slot ends its pairing; a pairing can be ended by the teacher or the school", async () => {
    ok(await as("p1")("POST", `/api/room-timetable/${slot.id}/end`, {}));
    assert.equal(ok(await as("t1")("GET", "/api/my/rooms")).length, 0);
    assert.deepEqual(ok(await as("p1")("GET", "/api/pairings")), []);
    slot = ok(await as("p1")("POST", `/api/rooms/${room.id}/timetable`, { teacherId: USERS.t1[0], weekdays: [1, 2, 3, 4, 5, 6, 7], starts: "00:00", ends: "23:59" }), 201);
    pairing = ok(await as("t1")("POST", `/api/rooms/${room.id}/pair`, { code: (await agent()).body.data.code, controllerName: "Laptop" }), 201);
    assert.equal((await as("tp")("POST", `/api/pairings/${pairing.id}/end`, {})).status, 404, "not another teacher's");
    ok(await as("p1")("POST", `/api/pairings/${pairing.id}/end`, {}));
    assert.equal(ok(await as("t1")("GET", "/api/my/rooms"))[0].pairing, null);
  });

  it("the key goes with approval: a change to the device or a revoke stops the display", async () => {
    ok(await as("p1")("PUT", `/api/devices/${display.id}`, { kind: "display", name: "Front board", capabilities: ["show", "blank", "volume", "input"] }));
    assert.equal((await agent()).status, 401, "back to pending: the key no longer works");
    ok(await as("it1")("POST", `/api/devices/${display.id}/decision`, { decision: "approved" }));
    assert.equal((await agent()).status, 401, "re-approval doesn't bring the old key back");
    key = ok(await as("it1")("POST", `/api/devices/${display.id}/key`, {})).key;
    assert.equal((await agent()).status, 200);
    ok(await as("it1")("POST", `/api/devices/${display.id}/key/revoke`, {}));
    assert.equal((await agent()).status, 401);
  });
});
