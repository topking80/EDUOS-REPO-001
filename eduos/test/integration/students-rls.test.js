// SEC-01 part 4 (db/179): the student directory and AI-redaction lookups, as the runtime role.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, run, baseEnv, createDatabase, seed } from "./harness.js";
import { findStudentIdentifiers } from "../../src/student-identifiers.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("student directory row security (179)", { skip }, () => {
  let db, admin, app;
  const as = async (who, role, school, fn) => {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role',$3,true), set_config('app.school_id',$4,true)",
        [who === "supt2" ? ID.d2 : ID.d1, USERS[who][0], role, school || ""]);
      return await fn();
    } finally { await app.query("ROLLBACK"); }
  };
  const names = (who, role, school) => as(who, role, school, async () => (await app.query("SELECT display_name FROM students ORDER BY 1")).rows.map(r => r.display_name));

  before(async () => {
    db = await createDatabase();
    const m = await run(["src/migrate.js"], { ...baseEnv({ EDUOS_APP_ROLE: db.names.app }), DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, "https://idp.test");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // Bob rides a route that t1 drives (as a driver profile).
    const R = "70000000-0000-4000-8000-000000000001", ST = "70000000-0000-4000-8000-000000000002";
    await admin.query("INSERT INTO transport_routes(id,district_id,school_id,name,bus_label,direction,driver_user_id,created_by) VALUES($1,$2,$3,'North','12','am',$4,$5)", [R, ID.d1, ID.s1, USERS.t1[0], USERS.p1[0]]);
    await admin.query("INSERT INTO transport_stops(id,district_id,school_id,route_id,seq,name) VALUES($1,$2,$3,$4,1,'Oak St')", [ST, ID.d1, ID.s1, R]);
    await admin.query("INSERT INTO transport_rider_assignments(district_id,school_id,route_id,stop_id,student_id,created_by) VALUES($1,$2,$3,$4,$5,$6)", [ID.d1, ID.s1, R, ST, ID.bob, USERS.p1[0]]);
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => { await app?.end(); await admin?.end(); await db?.drop(); });

  it("pupils and families see only their own; staff see their school; district roles the district (SEC-08)", async () => {
    assert.deepEqual(await names("pu", "pupil", ID.s1), ["Alice A"]);
    assert.deepEqual(await names("pa", "parent", ID.s1), ["Alice A"]);
    assert.deepEqual(await names("pb", "parent", ID.s1), ["Bob B"]);
    assert.deepEqual(await names("t1", "teacher", ID.s1), ["Alice A", "Bob B"]);
    assert.deepEqual(await names("t1", "librarian", ID.s1), ["Alice A", "Bob B"]);
    assert.deepEqual(await names("p2", "principal", ID.s2), ["Carol C"]);
    assert.deepEqual(await names("t1", "teacher", null), [], "staff with no school see nobody");
    assert.deepEqual(await names("t1", "driver", ID.s1), ["Bob B"], "a driver sees students on their routes");
    assert.deepEqual(await names("supt1", "superintendent", null), ["Alice A", "Bob B", "Carol C"]);
    assert.deepEqual(await names("supt2", "superintendent", null), ["Xavier X"]);
  });


  it("AI redaction still finds students at other schools, without the runtime role reading the token index", async () => {
    const found = await as("t1", "teacher", ID.s1, () => findStudentIdentifiers(app, ID.d1, "Carol C and Alice A were late; S2-C too"));
    assert.deepEqual(found.names.sort(), ["Alice A", "Carol C"]);
    assert.ok(found.numbers.includes("S2-C"));
    const pupil = await as("pu", "pupil", ID.s1, () => findStudentIdentifiers(app, ID.d1, "I sat with Bob B"));
    assert.deepEqual(pupil.names, ["Bob B"], "matches come back for redaction even when the reader can't list the student");
    await assert.rejects(as("t1", "teacher", ID.s1, () => app.query("SELECT 1 FROM student_redact_tokens LIMIT 1")), /permission denied/);
    assert.deepEqual((await as("supt2", "superintendent", null, () => findStudentIdentifiers(app, ID.d2, "Carol C"))).names, [], "another district's students never match");
  });
});
