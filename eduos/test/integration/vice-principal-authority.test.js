// db/121: a vice principal acts with the principal's authority at their
// school, except assigning roles. Against real PostgreSQL as the runtime role:
// the session acts as the principal; accounts and roles, coach assignments,
// room timetables and SRO assignment are refused in the routes and in the
// database; the audit log keeps "vice_principal"; another school stays closed.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const ROOM = "c1000000-0000-4000-8000-0000000000b1";

describe("vice principals act with the principal's authority against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, activity;
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
    await admin.query(`INSERT INTO classroom_rooms(id,district_id,school_id,name,created_by) VALUES ($1,$2,$3,'Room 9',$4)`, [ROOM, ID.d1, ID.s1, USERS.p1[0]]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "vp1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("the session acts as the principal and says it is a vice principal", async () => {
    const me = (await as("vp1")("GET", "/api/me")).body;
    assert.equal(me.role, "principal"); assert.equal(me.membershipRole, "vice_principal");
    assert.equal((await as("vp1")("GET", "/api/memberships")).body.data.find(m => m.current).role, "vice_principal");
  });

  it("does what the principal does at their school, and the audit log says who", async () => {
    activity = ok(await as("vp1")("POST", "/api/activities", { kind: "club", title: "Chess club", status: "draft" }), 201);
    assert.equal((await as("vp1")("GET", "/api/cases")).status, 200);
    assert.equal((await as("vp1")("GET", "/api/pickup/queue")).status, 200);
    const roles = (await admin.query("SELECT DISTINCT actor_role FROM audit_events WHERE actor_user_id=$1", [USERS.vp1[0]])).rows.map(r => r.actor_role);
    assert.deepEqual(roles, ["vice_principal"]);
    assert.equal((await as("vp1")("GET", `/api/rankings/schools/${ID.s2}`)).status, 404, "not another school");
  });

  it("can't assign roles: accounts and roles, coaches, room timetables", async () => {
    const refused = async (method, path, body) => assert.equal((await as("vp1")(method, path, body)).body.error, "principal_only", path);
    await refused("POST", "/api/users", { displayName: "New Teacher", email: "nt@d1.test", oidcSubject: "nt", role: "teacher", schoolId: ID.s1 });
    await refused("POST", `/api/users/${USERS.t1[0]}/memberships`, { role: "librarian", schoolId: ID.s1 });
    const mid = (await admin.query("SELECT id FROM memberships WHERE user_id=$1 LIMIT 1", [USERS.t1[0]])).rows[0].id;
    await refused("PATCH", `/api/memberships/${mid}`, { status: "disabled" });
    await refused("PATCH", `/api/users/${USERS.t1[0]}`, { displayName: "Renamed" });
    await refused("POST", `/api/activities/${activity.id}/staff`, { userId: USERS.t1[0], staffRole: "advisor" });
    await refused("POST", `/api/activities/${activity.id}/staff/${USERS.t1[0]}/end`, {});
    await refused("POST", `/api/rooms/${ROOM}/timetable`, { teacherId: USERS.t1[0], weekdays: [1], starts: "08:00", ends: "09:00" });
    // The principal still can.
    ok(await as("p1")("POST", `/api/activities/${activity.id}/staff`, { userId: USERS.t1[0], staffRole: "advisor" }), 201);
    ok(await as("p1")("POST", `/api/rooms/${ROOM}/timetable`, { teacherId: USERS.t1[0], weekdays: [1], starts: "08:00", ends: "09:00" }), 201);
  });

  it("the database refuses the same, whatever path reaches it", async () => {
    const appDb = new pg.Client(db.appUrl); await appDb.connect();
    const asVp = async sql => {
      await appDb.query("BEGIN");
      try {
        await appDb.query(`SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','principal',true),
          set_config('app.school_id',$3,true),set_config('app.membership_role','vice_principal',true)`, [ID.d1, USERS.vp1[0], ID.s1]);
        return await appDb.query(sql);
      } finally { await appDb.query("ROLLBACK"); }
    };
    try {
      await assert.rejects(asVp(`UPDATE memberships SET status='disabled' WHERE user_id='${USERS.t1[0]}'`), /only the principal assigns/);
      await assert.rejects(asVp(`UPDATE activity_staff SET ended_at=now() WHERE activity_id='${activity.id}'`), /only the principal assigns/);
      await assert.rejects(asVp(`UPDATE classroom_room_teachers SET ended_at=now() WHERE room_id='${ROOM}'`), /only the principal assigns/);
      assert.equal((await asVp("SELECT eduos_ctx_role() AS r, eduos_ctx_membership_role() AS m")).rows[0].m, "vice_principal");
    } finally { await appDb.end(); }
  });
});
