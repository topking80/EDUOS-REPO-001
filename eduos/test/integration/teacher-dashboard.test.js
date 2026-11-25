// Unified Teacher Dashboard against real PostgreSQL (non-owner eduos_app role + RLS).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("teacher dashboard against real PostgreSQL", { skip }, () => {
  let db, idp, server, s = {};
  const as = name => client(server.base, s[name]);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);

    const { Client } = await import("pg");
    const admin = new Client({ connectionString: db.adminUrl });
    await admin.connect();
    try {
      const t1 = "a0000000-0000-4000-8000-000000000005";
      const t2 = "a0000000-0000-4000-8000-000000000099";
      const p2 = "a0000000-0000-4000-8000-000000000004";
      const course1 = "c0000000-0000-4000-8000-000000000011";
      const course2 = "c0000000-0000-4000-8000-000000000012";
      const room1 = "d0000000-0000-4000-8000-000000000011";
      const checklist1 = "e0000000-0000-4000-8000-000000000011";
      const item1 = "e0000000-0000-4000-8000-000000000012";
      const checklist2 = "e0000000-0000-4000-8000-000000000021";
      const item2 = "e0000000-0000-4000-8000-000000000022";
      await admin.query(`INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email)
        VALUES($1,$2,'t2','Teacher S2','t2@d1.test')`, [t2, idp.issuer]);
      await admin.query(`INSERT INTO memberships(user_id,district_id,school_id,role,is_default)
        VALUES($1,$2,$3,'teacher',true)`, [t2, ID.d1, ID.s2]);
      await admin.query(`INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [ID.d1, ID.s1, t1, ID.alice, "a0000000-0000-4000-8000-000000000002"]);
      await admin.query(`INSERT INTO courses(id,district_id,school_id,teacher_user_id,title,subject,grade_level,term,status)
        VALUES($1,$2,$3,$4,'Grade 4 Math','Math','4','Year','active'),
              ($5,$2,$6,$7,'Other School Science','Science','5','Year','active')`,
        [course1, ID.d1, ID.s1, t1, course2, ID.s2, t2]);
      await admin.query(`INSERT INTO course_enrollments(district_id,course_id,student_id,status)
        VALUES($1,$2,$3,'active')`, [ID.d1, course1, ID.alice]);
      await admin.query(`INSERT INTO classroom_rooms(id,district_id,school_id,name,kind,created_by)
        VALUES($1,$2,$3,'Room 101','classroom',$4)`, [room1, ID.d1, ID.s1, "a0000000-0000-4000-8000-000000000002"]);
      await admin.query(`INSERT INTO classroom_room_teachers(district_id,school_id,room_id,teacher_user_id,weekdays,starts,ends,label,course_id,created_by)
        VALUES($1,$2,$3,$4,ARRAY[1,2,3,4,5,6,7]::smallint[],'08:00','09:30','Math Block',$5,$4)`, [ID.d1, ID.s1, room1, t1, course1]);
      await admin.query(`INSERT INTO school_staff_checklists(id,district_id,school_id,title,domain,cadence,created_by)
        VALUES($1,$2,$3,'Morning Library Check','library','daily',$4),
              ($5,$2,$6,'S2 Library Check','library','daily',$7)`, [checklist1, ID.d1, ID.s1, t1, checklist2, ID.s2, p2]);
      await admin.query(`INSERT INTO school_staff_checklist_items(id,checklist_id,label,position)
        VALUES($1,$2,'Unlock media cart',0),($3,$4,'Other school item',0)`, [item1, checklist1, item2, checklist2]);
      await admin.query(`INSERT INTO school_staff_handoffs(district_id,school_id,domain,summary,next_action,from_user_id,to_user_id)
        VALUES($1,$2,'library','Returns shelved','Check reserve holds',$3,$4),
              ($1,$5,'library','S2 handoff','Ignore',$6,$7)`, [ID.d1, ID.s1, "a0000000-0000-4000-8000-000000000003", t1, ID.s2, p2, t2]);
      await admin.query(`INSERT INTO notification_outbox(district_id,recipient_user_id,channel,kind,title,body)
        VALUES($1,$2,'in_app','announcement','Staff briefing','8:00 AM in the library'),
              ($1,$3,'in_app','announcement','Other teacher alert','Should stay hidden')`, [ID.d1, t1, t2]);
    } finally {
      await admin.end();
    }

    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "t1", "pa", "pu"]) {
      s[name] = await login(server.base, idp, name, { email_verified: true });
    }
  });

  after(async () => { await server?.stop(); await idp?.close(); await db?.drop(); });

  it("rejects unauthenticated and non-teacher callers", async () => {
    const anon = await fetch(`${server.base}/api/teacher/dashboard`);
    assert.equal(anon.status, 401);
    for (const who of ["pa", "pu", "p1", "supt1"]) {
      const res = await as(who)("GET", "/api/teacher/dashboard");
      assert.equal(res.status, 403, `${who} must be rejected`);
    }
  });

  it("returns the aggregated teacher command-center payload scoped to the teacher and school", async () => {
    const res = await as("t1")("GET", "/api/teacher/dashboard");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.equal(d.school.id, ID.s1);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d.date));
    assert.ok(d.overview.students >= 1);
    assert.equal(d.overview.coursesCount, 1);
    assert.equal(d.overview.courses[0].title, "Grade 4 Math");
    assert.equal(d.overview.scheduleToday.length, 1);
    assert.equal(d.overview.scheduleToday[0].room, "Room 101");
    assert.equal(d.classroom.assignedRooms, 1);
    assert.equal(d.classroom.connectedRooms, 0);
    assert.equal(d.workQueue.incompleteChecklists, 1);
    assert.equal(d.workQueue.pendingHandoffs, 1);
    assert.equal(d.duties.find(x => x.domain === "library")?.checklistsTotal, 1);
    assert.equal(d.alerts.unreadNotifications, 1);
    assert.equal(d.alerts.notifications[0].title, "Staff briefing");
    assert.ok(!d.connections.recentHandoffs.some(h => h.summary === "S2 handoff"));
    assert.ok(d.workQueue.items.some(i => i.kind === "checklist"));
    assert.ok(d.workQueue.items.some(i => i.kind === "handoffs"));
  });
});
