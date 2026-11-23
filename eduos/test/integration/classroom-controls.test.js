// DEV-03: classroom controls against real PostgreSQL, as the runtime role:
// only the paired teacher commands, only approved capabilities of approved,
// keyed devices in that room; the device collects and reports; late or
// no-longer-allowed commands are dropped; commands can't be written around
// the functions; leaders read the room's history.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const IT = "a0000000-0000-4000-8000-0000000000f1";

describe("DEV-03 classroom controls against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, room, display, cart, unkeyed, keys = {}, pairing;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const agent = async (key, path, body) => {
    const r = await fetch(`${server.base}/api/classroom-agent/${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json() };
  };
  const send = (who, dev, capability, args) => as(who)("POST", `/api/devices/${dev.id}/commands`, { capability, args });

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
    for (const name of ["p1", "p2", "t1", "tp"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    s.it1 = await login(server.base, idp, "it1", { email: "it1@d1.test", email_verified: true });
    // A room with a display, a student-device cart and one device without a key; t1 is timetabled all day.
    room = ok(await as("p1")("POST", "/api/rooms", { name: "Room 101" }), 201);
    const add = async (body, key = true) => {
      const d = ok(await as("p1")("POST", "/api/devices", body), 201);
      ok(await as("it1")("POST", `/api/devices/${d.id}/decision`, { decision: "approved" }));
      ok(await as("p1")("POST", `/api/devices/${d.id}/place`, { roomId: room.id }));
      if (key) keys[d.id] = ok(await as("it1")("POST", `/api/devices/${d.id}/key`, {})).key;
      return d;
    };
    display = await add({ kind: "display", name: "Front board", capabilities: ["show", "blank", "volume"] });
    cart = await add({ kind: "student_device", name: "Cart A", capabilities: ["lock", "unlock", "open_link"] });
    unkeyed = await add({ kind: "equipment", name: "Lights", capabilities: ["lights"] }, false);
    for (const t of ["t1", "tp"]) ok(await as("p1")("POST", `/api/rooms/${room.id}/timetable`, { teacherId: USERS[t][0], weekdays: [1, 2, 3, 4, 5, 6, 7], starts: "00:00", ends: "23:59" }), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("no commands before pairing; only teachers send them", async () => {
    assert.equal((await send("t1", display, "blank", { on: true })).body.error, "not_paired");
    assert.equal((await send("p1", display, "blank", { on: true })).status, 403);
    const code = (await agent(keys[display.id], "code")).body.data.code;
    pairing = ok(await as("t1")("POST", `/api/rooms/${room.id}/pair`, { code, controllerName: "My phone" }), 201);
  });

  it("the paired teacher sends only approved capabilities, with checked arguments, to keyed devices in the room", async () => {
    ok(await send("t1", display, "blank", { on: true }), 201);
    ok(await send("t1", display, "volume", { level: 30 }), 201);
    assert.equal((await send("t1", display, "power", { on: false })).body.error, "not_approved_for_device", "power wasn't approved for this display");
    assert.equal((await send("t1", display, "volume", { level: 300 })).body.error, "invalid_command");
    assert.equal((await send("t1", cart, "view_screen", {})).body.error, "invalid_command");
    assert.equal((await send("t1", cart, "open_link", { url: "http://example.org" })).body.error, "invalid_command");
    ok(await send("t1", cart, "lock", { message: "Eyes up front" }), 201);
    ok(await send("t1", cart, "open_link", { url: "https://example.org/lesson" }), 201);
    assert.equal((await send("t1", unkeyed, "lights", { on: true })).body.error, "device_not_ready", "no key: nothing could collect it");
    assert.equal((await send("tp", display, "blank", { on: false })).body.error, "not_paired", "another teacher in the timetable isn't paired");
  });

  it("each device collects only its own commands, in order, and reports how they went", async () => {
    const got = (await agent(keys[display.id], "commands")).body.data.commands;
    assert.deepEqual(got.map(c => [c.capability, c.args]), [["blank", { on: true }], ["volume", { level: 30 }]]);
    assert.deepEqual((await agent(keys[display.id], "commands")).body.data.commands, [], "delivered once");
    const cartGot = (await agent(keys[cart.id], "commands")).body.data.commands;
    assert.deepEqual(cartGot.map(c => c.capability), ["lock", "open_link"]);
    ok(await agent(keys[display.id], `commands/${got[0].id}/result`, { ok: true }).then(r => ({ status: r.status, body: r.body })));
    ok(await agent(keys[display.id], `commands/${got[1].id}/result`, { ok: false, message: "Display asleep" }).then(r => r));
    assert.equal((await agent(keys[display.id], `commands/${cartGot[0].id}/result`, { ok: true })).status, 404, "a device reports only its own commands");
    assert.equal((await agent("cdk1.x", "commands")).status, 401);

    const history = ok(await as("t1")("GET", `/api/rooms/${room.id}/commands`));
    assert.deepEqual(history.filter(h => h.device === "Front board").map(h => [h.capability, h.status, h.result]).reverse(), [["blank", "done", null], ["volume", "failed", "Display asleep"]]);
    assert.equal(ok(await as("p1")("GET", `/api/rooms/${room.id}/commands`)).length, 4, "the school reads the room's history");
    assert.deepEqual(ok(await as("p2")("GET", `/api/rooms/${room.id}/commands`)), [], "another school reads none");
    assert.deepEqual(ok(await as("tp")("GET", `/api/rooms/${room.id}/commands`)), [], "another teacher doesn't see them");
  });

  it("late commands, ended pairings and removed capabilities are dropped, not run", async () => {
    ok(await send("t1", display, "blank", { on: false }), 201);
    await admin.query(`UPDATE classroom_commands SET expires_at=now()-interval '1 second' WHERE status='queued'`);
    assert.deepEqual((await agent(keys[display.id], "commands")).body.data.commands, [], "expired");
    ok(await send("t1", cart, "unlock", {}), 201);
    ok(await as("t1")("POST", `/api/pairings/${pairing.id}/end`, {}));
    assert.deepEqual((await agent(keys[cart.id], "commands")).body.data.commands, [], "the pairing ended before the device collected it");
    assert.equal((await send("t1", cart, "unlock", {})).body.error, "not_paired");
    const reasons = (await admin.query(`SELECT result FROM classroom_commands WHERE status='failed' AND result IS NOT NULL ORDER BY created_at`)).rows.map(r => r.result);
    assert.deepEqual(reasons.slice(-2), ["expired before the device collected it", "no longer allowed"]);
  });

  it("commands can't be written around the functions", async () => {
    await admin.query(`SET ROLE ${db.names.app}`);
    try {
      await assert.rejects(admin.query(`INSERT INTO classroom_commands(district_id,school_id,room_id,device_id,pairing_id,issued_by,capability,expires_at)
        VALUES('${ID.d1}','${ID.s1}','${room.id}','${cart.id}','${pairing.id}','${USERS.t1[0]}','unlock',now()+interval '1 minute')`), /permission denied/);
      await assert.rejects(admin.query(`UPDATE classroom_commands SET status='done'`), /permission denied/);
    } finally { await admin.query("RESET ROLE"); }
    await assert.rejects(admin.query(`INSERT INTO classroom_commands(district_id,school_id,room_id,device_id,pairing_id,issued_by,capability,expires_at)
      VALUES('${ID.d1}','${ID.s1}','${room.id}','${cart.id}','${pairing.id}','${USERS.t1[0]}','view_screen',now())`), /check constraint/);
  });
});
