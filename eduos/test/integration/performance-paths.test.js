// The read paths the role apps hit most, against real PostgreSQL as the
// runtime role: the unread badge (polled by every signed-in phone every 30 s)
// and "attendance today". Correctness and scope first, then size and speed at
// a realistic scale.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("performance paths against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const today = "2026-11-02";

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5)", [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
    // Alice: marked present, then corrected to tardy. Bob: absent. Carol (S2): absent.
    await admin.query(`INSERT INTO attendance_events(district_id,student_id,event_date,status,observed_at) VALUES
      ($1,$2,$5,'present',now()-interval '2 hours'),($1,$2,$5,'tardy',now()-interval '1 hour'),($1,$3,$5,'absent',now()),($1,$4,$5,'absent',now()),
      ($1,$3,'2026-11-01','tardy',now())`, [ID.d1, ID.alice, ID.bob, ID.carol, today]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "p2", "t1", "pa"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop?.(); });

  const day = async (who, date = today) => as(who)("GET", `/api/attendance/day?date=${date}`);

  it("attendance today counts each student once, by their latest mark, within the caller's scope", async () => {
    let r = await day("p1");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.counts, { present: 0, absent: 1, tardy: 1, excused: 0 }, "Alice's correction replaces her first mark");
    assert.deepEqual(r.body.data.exceptions.map(e => [e.display_name, e.status]), [["Bob B", "absent"], ["Alice A", "tardy"]]);
    assert.ok(!JSON.stringify(r.body).includes("Carol"), "another school's student");
    r = await day("p2");
    assert.deepEqual(r.body.data.counts, { present: 0, absent: 1, tardy: 0, excused: 0 });
    r = await day("supt1");
    assert.deepEqual(r.body.data.counts, { present: 0, absent: 2, tardy: 1, excused: 0 });
    r = await day("t1");
    assert.deepEqual(r.body.data.counts, { present: 0, absent: 0, tardy: 1, excused: 0 }, "a teacher sees their roster only");
    r = await day("pa");
    assert.ok(r.status === 403 || (r.status === 200 && r.body.data.exceptions.length === 0), "families get no school-wide list");
    assert.equal((await day("p1", "2026-02-30")).status, 400);
    assert.equal((await as("p1")("GET", "/api/attendance/day")).status, 400);
  });

  it("the unread badge asks for the count only", async () => {
    for (let i = 0; i < 50; i++) await admin.query(`INSERT INTO notification_outbox(district_id,school_id,recipient_user_id,channel,kind,title,body,status,delivered_at)
      VALUES($1,$2,$3,'in_app','announcement',$4,$5,'delivered',now())`, [ID.d1, ID.s1, USERS.p1[0], `Notice ${i}`, "x".repeat(400)]);
    const full = await as("p1")("GET", "/api/notifications");
    const summary = await as("p1")("GET", "/api/notifications?summary=1");
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body, { data: { unread: 50 } });
    assert.equal(full.body.data.unread, 50); assert.equal(full.body.data.items.length, 50);
    const size = r => JSON.stringify(r.body).length;
    assert.ok(size(summary) < 40 && size(full) > 20_000, `${size(summary)} vs ${size(full)} bytes`);
  });

  it("at district scale: the badge uses its index and a 2,000-student school day comes back fast and small", async () => {
    // 3,000 people with 60 notifications each (180,000 rows), most read.
    await admin.query(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email)
      SELECT gen_random_uuid(),'http://scale','scale-'||g,'Scale '||g,'scale'||g||'@d1.test' FROM generate_series(1,3000) g`);
    await admin.query(`INSERT INTO notification_outbox(district_id,recipient_user_id,channel,kind,title,status,delivered_at,read_at)
      SELECT $1,u.id,'in_app','announcement','n','delivered',now(),CASE WHEN g%10=0 THEN NULL ELSE now() END
        FROM users u, generate_series(1,60) g WHERE u.oidc_issuer='http://scale'`, [ID.d1]);
    await admin.query("ANALYZE notification_outbox");
    const plan = (await admin.query(`EXPLAIN SELECT count(*) FROM notification_outbox
        WHERE district_id=$1 AND recipient_user_id=$2 AND channel='in_app' AND read_at IS NULL`, [ID.d1, USERS.p1[0]])).rows.map(r => r["QUERY PLAN"]).join("\n");
    assert.match(plan, /notification_outbox_unread/, plan);
    let t = performance.now();
    for (let i = 0; i < 20; i++) assert.equal((await as("p1")("GET", "/api/notifications?summary=1")).status, 200);
    const badgeMs = (performance.now() - t) / 20;

    await admin.query(`INSERT INTO students(id,district_id,school_id,local_student_number,display_name,grade_level)
      SELECT gen_random_uuid(),$1,$2,'SC-'||g,'Scale Student '||lpad(g::text,4,'0'),'4' FROM generate_series(1,2000) g`, [ID.d1, ID.s1]);
    await admin.query(`INSERT INTO attendance_events(district_id,student_id,event_date,status,observed_at)
      SELECT $1,id,$2::date,CASE WHEN local_student_number LIKE '%7' THEN 'absent' ELSE 'present' END,now()
        FROM students WHERE local_student_number LIKE 'SC-%'`, [ID.d1, today]);
    await admin.query("ANALYZE attendance_events");
    t = performance.now();
    const r = await day("p1");
    const dayMs = performance.now() - t;
    assert.equal(r.status, 200);
    const c = r.body.data.counts;
    assert.equal(c.present + c.absent + c.tardy, 2002);
    assert.equal(r.body.data.exceptions.length, c.absent + c.tardy, "only the students who weren't present are listed");
    const bytes = JSON.stringify(r.body).length;
    console.log(`[perf] unread badge ${badgeMs.toFixed(1)} ms/request; attendance day for 2,002 students ${dayMs.toFixed(0)} ms, ${bytes} bytes`);
    assert.ok(badgeMs < 50, `badge ${badgeMs} ms`);
    assert.ok(dayMs < 500, `day ${dayMs} ms`);
    assert.ok(bytes < 40_000, `${bytes} bytes for 2,002 students`);
  });
});
