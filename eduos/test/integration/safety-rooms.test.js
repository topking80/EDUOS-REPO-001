// SAFE-01: room status during an emergency, against real PostgreSQL as the
// runtime role. Adults at the school report their room; "needs help" and
// "not secured" alert the principal, vice principals and resource officers;
// the board is for those roles and the superintendent only; nothing is
// reported once the incident ends; other schools see nothing.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const NURSE = "a0000000-0000-4000-8000-0000000000f5", SRO = "a0000000-0000-4000-8000-0000000000f6", SRO2 = "a0000000-0000-4000-8000-0000000000f7";
const ROOM_A = "c1000000-0000-4000-8000-0000000000a1", ROOM_B = "c1000000-0000-4000-8000-0000000000a2", ROOM_S2 = "c1000000-0000-4000-8000-0000000000a3";

describe("SAFE-01 room status against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, incident;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const notes = async user => (await admin.query("SELECT title FROM notification_outbox WHERE recipient_user_id=$1 AND kind='safety' AND channel='in_app' ORDER BY created_at", [user])).rows.map(r => r.title);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    for (const [id, sub, name, role, school] of [[NURSE, "ns1", "Nurse S1", "nurse", ID.s1], [SRO, "sr1", "Officer S1", "sro", ID.s1], [SRO2, "sr2", "Officer S2", "sro", ID.s2]]) {
      await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($1,$2,$3,$4,$5)", [id, idp.issuer, sub, name, `${sub}@d1.test`]);
      await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($1,$2,$3,$4,true)", [id, ID.d1, school, role]);
    }
    await admin.query(`INSERT INTO classroom_rooms(id,district_id,school_id,name,building,created_by) VALUES
      ($1,$4,$5,'Room 12','North',$7),($2,$4,$5,'Room 14','North',$7),($3,$4,$6,'S2 Gym',NULL,$8)`, [ROOM_A, ROOM_B, ROOM_S2, ID.d1, ID.s1, ID.s2, USERS.p1[0], USERS.p2[0]]);
    await admin.query(`INSERT INTO classroom_room_teachers(district_id,school_id,room_id,teacher_user_id,weekdays,starts,ends,created_by)
      VALUES ($1,$2,$3,$4,ARRAY[1,2,3,4,5,6,7]::smallint[],'00:00','23:59:59',$5)`, [ID.d1, ID.s1, ROOM_A, USERS.t1[0], USERS.p1[0]]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "p2", "t1", "pu", "pa"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    for (const name of ["ns1", "sr1", "sr2"]) s[name] = await login(server.base, idp, name, { email: `${name}@d1.test`, email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a lockdown: the nurse and the SRO now see it too", async () => {
    incident = ok(await as("t1")("POST", "/api/safety/incidents", { kind: "lockdown", isDrill: true }), 201);
    ok(await as("t1")("POST", `/api/safety/incidents/${incident.id}/confirm`, { kind: "lockdown", isDrill: true }));
    for (const who of ["ns1", "sr1"]) assert.equal(ok(await as(who)("GET", "/api/safety/status")).incidents.length, 1, who);
    assert.equal(ok(await as("sr2")("GET", "/api/safety/status")).incidents.length, 0, "another school's SRO");
  });

  it("my room: rooms at my school, my timetabled room suggested; families, students and other schools can't", async () => {
    const mine = ok(await as("t1")("GET", `/api/safety/incidents/${incident.id}/my-room`));
    assert.deepEqual(mine.rooms.map(r => r.name), ["Room 12", "Room 14"]);
    assert.equal(mine.suggestedRoomId, ROOM_A);
    assert.equal(ok(await as("ns1")("GET", `/api/safety/incidents/${incident.id}/my-room`)).rooms.length, 2, "the nurse can pick a room");
    for (const who of ["pa", "pu"]) assert.equal((await as(who)("GET", `/api/safety/incidents/${incident.id}/my-room`)).status, 403, who);
    assert.equal((await as("sr2")("GET", `/api/safety/incidents/${incident.id}/my-room`)).status, 404, "another school");
  });

  it("reports: validated; rooms must be at the school; needs help alerts the principal and the SRO", async () => {
    const post = (who, body) => as(who)("POST", `/api/safety/incidents/${incident.id}/room-status`, body);
    assert.equal((await post("t1", { roomId: ROOM_A, status: "needs_help" })).status, 400, "needs help needs a kind");
    assert.equal((await post("t1", { roomId: ROOM_A, status: "secured", need: "medical" })).status, 400);
    assert.equal((await post("t1", { status: "secured" })).status, 400, "a room or a place");
    assert.equal((await post("t1", { roomId: ROOM_A, status: "secured", students: 900 })).status, 400);
    assert.equal((await post("t1", { roomId: ROOM_S2, status: "secured" })).status, 404, "another school's room");
    assert.equal((await post("pa", { roomId: ROOM_A, status: "secured" })).status, 403);
    assert.equal((await post("sr2", { roomId: ROOM_A, status: "secured" })).status, 404);
    const first = ok(await post("t1", { roomId: ROOM_A, status: "secured", students: 24, adults: 1 }), 201);
    assert.equal(first.alerted, 0, "secured alerts nobody");
    const help = ok(await post("ns1", { place: "Nurse's office", status: "needs_help", need: "medical", students: 2, adults: 1, note: "Asthma; inhaler is in the office" }), 201);
    assert.equal(help.room, "Nurse's office");
    assert.ok(help.alerted >= 2);
    for (const who of [USERS.p1[0], SRO]) assert.ok((await notes(who)).includes("Nurse's office needs medical help"), who);
    assert.equal((await notes(SRO2)).length, 0, "not another school's SRO");
    assert.equal((await notes(USERS.t1[0])).filter(t => /needs/.test(t)).length, 0, "not teachers");
  });

  it("the board: principal, SRO and superintendent; latest report per room, needs help first, rooms not heard from", async () => {
    ok(await as("t1")("POST", `/api/safety/incidents/${incident.id}/room-status`, { roomId: ROOM_A, status: "not_secured", note: "Door won't lock" }), 201);
    for (const who of ["p1", "sr1", "supt1"]) {
      const b = ok(await as(who)("GET", `/api/safety/incidents/${incident.id}/rooms`));
      assert.deepEqual(b.rooms.map(r => [r.name, r.report?.status || null]), [["Nurse's office", "needs_help"], ["Room 12", "not_secured"], ["Room 14", null]], who);
      assert.equal(b.totals.waiting, 1); assert.equal(b.totals.reported, 1); assert.equal(b.totals.students, 2);
      assert.equal(b.rooms[1].report.by, "Teacher S1");
    }
    for (const who of ["t1", "ns1", "pa", "pu"]) assert.equal((await as(who)("GET", `/api/safety/incidents/${incident.id}/rooms`)).status, 403, who);
    assert.equal((await as("p2")("GET", `/api/safety/incidents/${incident.id}/rooms`)).status, 404, "another school's principal");
    assert.equal((await as("sr2")("GET", `/api/safety/incidents/${incident.id}/rooms`)).status, 404, "another school's SRO");
    assert.equal(ok(await as("t1")("GET", `/api/safety/incidents/${incident.id}/my-room`)).last.status, "not_secured", "a teacher sees their own last report");
  });

  it("the database holds the same lines: append-only, own reports only, nothing after the all clear", async () => {
    const appDb = new pg.Client(db.appUrl); await appDb.connect();
    try {
      await appDb.query("BEGIN");
      await appDb.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','teacher',true),set_config('app.school_id',$3,true)", [ID.d1, USERS.t1[0], ID.s1]);
      assert.equal((await appDb.query("SELECT count(*)::int AS n FROM safety_room_reports")).rows[0].n, 2, "a teacher reads only their own");
      await assert.rejects(appDb.query("UPDATE safety_room_reports SET status='secured'"), /permission denied|append-only/);
      await appDb.query("ROLLBACK");
      await appDb.query("BEGIN");
      await appDb.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','teacher',true),set_config('app.school_id',$3,true)", [ID.d1, USERS.t1[0], ID.s1]);
      await assert.rejects(appDb.query(`INSERT INTO safety_room_reports(district_id,school_id,incident_id,room_id,status,reported_by,reporter_role) VALUES ($1,$2,$3,$4,'secured',$5,'teacher')`,
        [ID.d1, ID.s1, incident.id, ROOM_A, USERS.supt1[0]]), /row-level security/, "not as someone else");
      await appDb.query("ROLLBACK");
    } finally { await appDb.end(); }
    ok(await as("p1")("POST", `/api/safety/incidents/${incident.id}/all-clear`, { kind: "lockdown" }));
    assert.equal((await as("t1")("POST", `/api/safety/incidents/${incident.id}/room-status`, { roomId: ROOM_A, status: "secured" })).status, 409, "the incident is over");
    assert.equal(ok(await as("p1")("GET", `/api/safety/incidents/${incident.id}/rooms`)).rooms.length, 3, "the board stays for the debrief");
  });
});
