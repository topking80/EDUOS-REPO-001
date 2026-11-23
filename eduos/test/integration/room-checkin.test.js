// ROOM-01: scanning into a classroom or the media center, against real
// PostgreSQL as the runtime role: the display QR (90 s), the printed door QR,
// a kiosk reading student ID numbers; students and staff check in, families
// don't; the roll shows who checked in against the class list and the teacher
// confirms attendance through the normal route; who can read a room's roll.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const IT = "a0000000-0000-4000-8000-0000000000f1", LIB = "a0000000-0000-4000-8000-0000000000f2", COURSE = "c0000000-0000-4000-8000-0000000000c1";

describe("ROOM-01 room check-in against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, room, library, display, kiosk, keys = {}, displayPath, today;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const agent = async (key, path, body) => {
    const r = await fetch(`${server.base}/api/classroom-agent/${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json() };
  };
  const param = (path, k) => new URLSearchParams(path.split("?")[1]).get(k);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    for (const [id, sub, name, school, role] of [[IT, "it1", "District IT", null, "it_admin"], [LIB, "lib1", "Librarian S1", ID.s1, "librarian"]]) {
      await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($2,$1,$3,$4,$5)", [idp.issuer, id, sub, name, `${sub}@d1.test`]);
      await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($1,$2,$3,$4,true)", [id, ID.d1, school, role]);
    }
    await admin.query(`INSERT INTO courses(id,district_id,school_id,teacher_user_id,title,subject,grade_level) VALUES ($1,$2,$3,$4,'Math 3','Math','3')`, [COURSE, ID.d1, ID.s1, USERS.t1[0]]);
    await admin.query(`INSERT INTO course_enrollments(course_id,district_id,student_id) VALUES ($1,$2,$3),($1,$2,$4)`, [COURSE, ID.d1, ID.alice, ID.bob]);
    await admin.query(`INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES ($1,$2,$3,$4,$5),($1,$2,$3,$6,$5) ON CONFLICT DO NOTHING`,
      [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0], ID.bob]);
    today = (await admin.query(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM schools WHERE id=$1`, [ID.s1])).rows[0].d;
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "pa", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    s.it1 = await login(server.base, idp, "it1", { email: "it1@d1.test", email_verified: true });
    s.lib1 = await login(server.base, idp, "lib1", { email: "lib1@d1.test", email_verified: true });

    room = ok(await as("p1")("POST", "/api/rooms", { name: "Room 101" }), 201);
    library = ok(await as("p1")("POST", "/api/rooms", { name: "Library", kind: "media_center" }), 201);
    const add = async (body, roomId) => {
      const d = ok(await as("p1")("POST", "/api/devices", body), 201);
      ok(await as("it1")("POST", `/api/devices/${d.id}/decision`, { decision: "approved" }));
      ok(await as("p1")("POST", `/api/devices/${d.id}/place`, { roomId }));
      keys[d.id] = ok(await as("it1")("POST", `/api/devices/${d.id}/key`, {})).key;
      return d;
    };
    display = await add({ kind: "display", name: "Front board", capabilities: ["show"] }, room.id);
    kiosk = await add({ kind: "kiosk", name: "Library door", capabilities: ["checkin"] }, library.id);
    assert.equal((await as("p1")("POST", "/api/devices", { kind: "kiosk", name: "x", capabilities: ["lock"] })).body.error, "invalid_device");
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("the timetable names the course; it must be that teacher's course at this school", async () => {
    const slot = { teacherId: USERS.t1[0], weekdays: [1, 2, 3, 4, 5, 6, 7], starts: "00:00", ends: "23:59" };
    assert.equal((await as("p1")("POST", `/api/rooms/${room.id}/timetable`, { ...slot, teacherId: USERS.tp[0], courseId: COURSE })).body.error, "course_of_this_teacher_required");
    ok(await as("p1")("POST", `/api/rooms/${room.id}/timetable`, { ...slot, courseId: COURSE }), 201);
    assert.deepEqual(ok(await as("p1")("GET", `/api/rooms/${room.id}/teachers`)).find(t => t.name === "Teacher S1").courses.map(c => c.title), ["Math 3"]);
    assert.equal(ok(await as("t1")("GET", `/api/rooms/${room.id}/timetable`))[0].course, "Math 3");
  });

  it("students and staff scan the display QR; families can't; an old code doesn't work", async () => {
    const qr = (await agent(keys[display.id], "checkin-code")).body.data;
    assert.equal(qr.room, "Room 101"); assert.ok(Array.isArray(qr.qr) && qr.qr.length > 20, "QR modules to draw");
    displayPath = qr.path;
    assert.equal(param(displayPath, "r"), room.id);
    const first = ok(await as("pu")("POST", `/api/rooms/${room.id}/checkin`, { code: param(displayPath, "c") }), 201);
    assert.deepEqual([first.room, first.class, first.method, first.already], ["Room 101", "Math 3", "display_qr", false]);
    assert.equal(ok(await as("pu")("POST", `/api/rooms/${room.id}/checkin`, { code: param(displayPath, "c") }), 201).already, true, "a second scan adds nothing");
    ok(await as("t1")("POST", `/api/rooms/${room.id}/checkin`, { code: param(displayPath, "c") }), 201);
    assert.equal((await as("pa")("POST", `/api/rooms/${room.id}/checkin`, { code: param(displayPath, "c") })).body.error, "not_allowed", "families don't check in");
    assert.equal((await as("pu")("POST", `/api/rooms/${room.id}/checkin`, { code: "A".repeat(22) })).status, 410);
    await admin.query(`UPDATE classroom_checkin_codes SET expires_at=now()-interval '1 second'`);
    assert.equal((await as("t1")("POST", `/api/rooms/${room.id}/checkin`, { code: param(displayPath, "c") })).body.error, "code_expired");
  });

  it("a printed door QR and a kiosk check students into the media center", async () => {
    assert.equal((await as("t1")("POST", `/api/rooms/${library.id}/door-qr`, {})).status, 403);
    const door = ok(await as("p1")("POST", `/api/rooms/${library.id}/door-qr`, {}));
    assert.ok(door.qr.length > 20 && door.path.includes("&d="));
    const lib = ok(await as("pu")("POST", `/api/rooms/${library.id}/checkin`, { door: param(door.path, "d") }), 201);
    assert.deepEqual([lib.kind, lib.method, lib.class], ["media_center", "door_qr", null]);
    const again = ok(await as("p1")("POST", `/api/rooms/${library.id}/door-qr`, {}));
    assert.equal((await as("pu")("POST", `/api/rooms/${library.id}/checkin`, { door: param(door.path, "d") })).status, 410, "a new poster replaces the old one");
    assert.ok(again.path !== door.path);

    assert.deepEqual((await agent(keys[kiosk.id], "kiosk-checkin", { studentNumber: "S1-B" })).body.data, { name: "Bob", already: false });
    assert.deepEqual((await agent(keys[kiosk.id], "kiosk-checkin", { studentNumber: "S1-B" })).body.data, { name: "Bob", already: true });
    assert.deepEqual((await agent(keys[kiosk.id], "kiosk-checkin", { studentNumber: "S2-C" })).body.data, { error: "not_found" }, "only this school's students");
    assert.deepEqual((await agent(keys[display.id], "kiosk-checkin", { studentNumber: "S1-A" })).body.data, { error: "not_a_checkin_kiosk" });
    assert.equal((await agent("cdk1.bad", "kiosk-checkin", { studentNumber: "S1-A" })).status, 401);
  });

  it("the roll shows the class list with who checked in; the teacher confirms attendance through the normal route", async () => {
    let roll = ok(await as("t1")("GET", `/api/rooms/${room.id}/roll`));
    assert.equal(roll.date, today);
    const p = roll.periods[0];
    assert.equal(p.now, true);
    assert.deepEqual(p.roster.map(r => [r.name, r.method, r.attendance]), [["Alice A", "display_qr", null], ["Bob B", null, null]]);
    assert.deepEqual(p.others.map(o => [o.name, o.kind]), [["Teacher S1", "staff"]]);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM attendance_events`)).rows[0].n, 0, "checking in wrote no attendance");
    ok(await as("t1")("POST", "/api/attendance", { studentId: ID.alice, eventDate: today, status: "present" }), 201);
    roll = ok(await as("t1")("GET", `/api/rooms/${room.id}/roll`));
    assert.equal(roll.periods[0].roster[0].attendance, "present");

    const media = ok(await as("lib1")("GET", `/api/rooms/${library.id}/roll`));
    assert.deepEqual(media.unscheduled.map(u => [u.name, u.method]), [["Alice A", "door_qr"], ["Bob B", "kiosk_id"]]);
    assert.equal((await as("lib1")("GET", `/api/rooms/${room.id}/roll`)).status, 404, "the librarian reads the media center only");
    assert.equal((await as("tp")("GET", `/api/rooms/${room.id}/roll`)).status, 404, "a teacher not timetabled there");
    assert.equal((await as("p2")("GET", `/api/rooms/${room.id}/roll`)).status, 404);
    assert.equal((await as("pu")("GET", `/api/rooms/${room.id}/roll`)).status, 403);
    assert.equal(ok(await as("p1")("GET", `/api/rooms/${library.id}/roll`)).unscheduled.length, 2);
  });

  it("people see their own check-ins; check-ins and codes can't be written around the functions", async () => {
    assert.deepEqual(ok(await as("pu")("GET", "/api/my/checkins")).map(k => [k.room, k.method]).sort(), [["Library", "door_qr"], ["Room 101", "display_qr"]]);
    await admin.query(`SET ROLE ${db.names.app}`);
    try {
      await assert.rejects(admin.query(`INSERT INTO room_checkins(district_id,school_id,room_id,person_kind,student_id,method,local_date) VALUES('${ID.d1}','${ID.s1}','${room.id}','student','${ID.bob}','door_qr',current_date)`), /permission denied/);
      await assert.rejects(admin.query(`SELECT * FROM classroom_checkin_codes`), /permission denied/);
    } finally { await admin.query("RESET ROLE"); }
  });
});
