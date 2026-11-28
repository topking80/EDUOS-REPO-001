// COS-01 (db/186, docs/CHIEF-OF-STAFF.md): the district Chief of Staff,
// against real PostgreSQL as the runtime role. Coordination only: counts and
// status for the district, a follow-up tracker, and what waits for a decision.
// No student, staff or family record opens to the role, and it decides nothing.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("COS-01 Chief of Staff against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, appDb, s = {}, cosId;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const asRole = async (role, user, school, sql, params = []) => {
    await appDb.query("BEGIN");
    try {
      await appDb.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id',$4,true)", [ID.d1, user, role, school ?? ""]);
      return (await appDb.query(sql, params)).rows;
    } finally { await appDb.query("ROLLBACK"); }
  };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("SELECT set_config('app.district_id',$1,false)", [ID.d1]);
    // Six learners at S2 marked present today (enough to show), one absence at S1 (too few to show).
    for (let i = 1; i <= 6; i++) {
      const st = (await admin.query("INSERT INTO students(district_id,school_id,local_student_number,display_name,grade_level) VALUES($1,$2,$3,$4,'5') RETURNING id",
        [ID.d1, ID.s2, `COS-${i}`, `Learner Number${i}`])).rows[0].id;
      await admin.query("INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,eduos_school_today($3),'present')", [ID.d1, st, ID.s2]);
    }
    await admin.query("INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,eduos_school_today($3),'absent')", [ID.d1, ID.alice, ID.s1]);
    appDb = new pg.Client(db.appUrl); await appDb.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "t1", "pa", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await appDb?.end(); await admin?.end(); await idp?.close(); await db?.drop?.(); });

  it("only the superintendent appoints a chief of staff, and the role has no school", async () => {
    assert.equal((await as("p1")("POST", "/api/users", { displayName: "Cass Office", email: "cos@d1.test", oidcSubject: "cos1", role: "chief_of_staff" })).status, 403);
    assert.equal((await as("supt1")("POST", "/api/users", { displayName: "Cass Office", email: "cos@d1.test", oidcSubject: "cos1", role: "chief_of_staff", schoolId: ID.s1 })).body.error, "district_role_has_no_school");
    const made = await as("supt1")("POST", "/api/users", { displayName: "Cass Office", email: "cos@d1.test", oidcSubject: "cos1", role: "chief_of_staff" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    cosId = (await admin.query("SELECT id FROM users WHERE oidc_subject='cos1'")).rows[0].id;
    await assert.rejects(admin.query("UPDATE memberships SET school_id=$2 WHERE user_id=$1", [cosId, ID.s1]), /memberships_chief_of_staff_no_school/);
    s.cos = await login(server.base, idp, "cos1", { email: "cos@d1.test", email_verified: true });
    const me = await as("cos")("GET", "/api/me");
    assert.deepEqual([me.status, me.body.role, me.body.schoolId], [200, "chief_of_staff", null]);
  });

  it("no student, staff or family record opens to the role", async () => {
    for (const path of ["/api/students", `/api/students/${ID.alice}`, "/api/attendance?date=today", `/api/family/children/${ID.alice}/summary`, "/api/learning/review", "/api/users", "/api/audit"]) {
      const r = await as("cos")("GET", path);
      assert.ok([403, 404].includes(r.status) || (r.status === 200 && JSON.stringify(r.body).match(/Alice|Learner Number/) === null), `${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
    // The app still starts: its own account, branding, notifications and profiles.
    for (const path of ["/api/branding/current", "/api/notifications?summary=1", "/api/session/contexts", "/api/csrf"]) {
      const r = await as("cos")("GET", path);
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    // Accounts: staff only, never a family's or a learner's.
    const people = (await asRole("chief_of_staff", cosId, null, "SELECT id FROM users")).map(r => r.id);
    assert.ok(people.includes(USERS.t1[0]) && people.includes(cosId));
    assert.ok(!people.includes(USERS.pa[0]) && !people.includes(USERS.pu[0]), "no family or learner accounts");
    assert.ok((await asRole("chief_of_staff", cosId, null, "SELECT role FROM memberships")).every(m => !["parent", "pupil"].includes(m.role)));
    assert.equal((await asRole("chief_of_staff", cosId, null, "SELECT count(*)::int AS n FROM audit_events"))[0].n, 0, "it can't read the audit log");
    // And underneath the routes, row security returns nothing to the role.
    for (const table of ["students", "attendance_events", "student_user_links", "teacher_student_rosters", "quiz_attempts", "student_intervention_cases", "family_messages", "mastery_evidence"])
      assert.equal((await asRole("chief_of_staff", cosId, null, `SELECT count(*)::int AS n FROM ${table}`))[0].n, 0, table);
  });

  it("the overview is counts only, with small attendance totals withheld", async () => {
    await admin.query("INSERT INTO access_requests(district_id,school_id,requester_user_id,requester_role,resource,action,reason,requested_expires_at) VALUES($1,$2,$3,'principal','schools','update','Update the S1 profile for the open house',now()+interval '7 days')", [ID.d1, ID.s1, USERS.p1[0]])
      .catch(e => { if (!/column|violates/.test(e.message)) throw e; });
    const o = ok(await as("cos")("GET", "/api/cos/overview"));
    const s1 = o.schools.find(x => x.schoolId === ID.s1), s2 = o.schools.find(x => x.schoolId === ID.s2);
    assert.deepEqual(s2.attendance, { marked: 6, present: 6, absent: null, tardy: null });
    assert.deepEqual(s1.attendance, { marked: null, present: null, absent: null, tardy: null }, "one absence is too few to show");
    for (const k of ["activeSafetyIncidents", "openServiceWork", "coverageNeeded"]) assert.equal(typeof s1[k], "number", k);
    assert.deepEqual(Object.keys(o.followups).sort(), ["doneThisWeek", "dueThisWeek", "open", "overdue"]);
    assert.ok(!/Alice|Bob|Carol|Learner|Number|COS-/.test(JSON.stringify(o)), "no names or numbers of people");
    assert.ok(!o.schools.some(x => x.schoolId === ID.sd2), "own district only");
    assert.equal((await as("supt1")("GET", "/api/cos/overview")).status, 200, "the superintendent sees it too");
    for (const name of ["p1", "t1", "pa", "pu"]) assert.equal((await as(name)("GET", "/api/cos/overview")).status, 403, name);
    assert.equal((await asRole("teacher", USERS.t1[0], ID.s1, "SELECT eduos_cos_overview() AS o"))[0].o, null, "the definer answers only the office");
  });

  let item;
  it("the office assigns a follow-up to a staff member; never to a family, and never naming a student", async () => {
    const staff = ok(await as("cos")("GET", "/api/cos/staff"));
    assert.ok(staff.some(x => x.userId === USERS.t1[0]) && !staff.some(x => [USERS.pa[0], USERS.pu[0]].includes(x.userId)), "staff only");
    assert.ok(!staff.some(x => x.userId === USERS.supt2[0]), "own district only");
    assert.equal((await as("cos")("POST", "/api/cos/followups", { title: "Bus contract renewal", ownerUserId: USERS.pa[0] })).body.error, "owner_must_be_district_staff");
    assert.equal((await as("cos")("POST", "/api/cos/followups", { title: "Check on Learner Number3 after the move", ownerUserId: USERS.t1[0] })).body.error, "follow_up_names_a_student");
    assert.equal((await as("cos")("POST", "/api/cos/followups", { title: "Records request", detail: "Student COS-4 needs a transcript", ownerUserId: USERS.t1[0] })).body.error, "follow_up_names_a_student");
    assert.equal((await as("t1")("POST", "/api/cos/followups", { title: "Self-assigned", ownerUserId: USERS.t1[0] })).status, 403);
    item = ok(await as("cos")("POST", "/api/cos/followups", { title: "Send the science fair volunteer schedule", detail: "Board asked for it by Friday.",
      ownerUserId: USERS.t1[0], schoolId: ID.s1, dueOn: "2026-12-04" }), 201);
    assert.deepEqual([item.status, item.ownerName, item.schoolName, item.dueOn], ["open", "Teacher S1", "S1", "2026-12-04"]);
    const audit = (await admin.query("SELECT actor_role, detail FROM audit_events WHERE resource_type='cos_followup' AND resource_id=$1", [item.id])).rows;
    assert.deepEqual(audit.map(a => a.actor_role), ["chief_of_staff"]);
  });

  it("the owner sees their own and moves only its status; others don't see it", async () => {
    const mine = ok(await as("t1")("GET", "/api/cos/followups"));
    assert.deepEqual(mine.map(f => f.id), [item.id]);
    assert.equal(ok(await as("p1")("GET", "/api/cos/followups")).length, 0, "not assigned to the principal");
    assert.equal((await as("pa")("GET", "/api/cos/followups")).status, 403);
    assert.equal((await as("t1")("PATCH", `/api/cos/followups/${item.id}`, { title: "Changed" })).body.error, "owner_may_only_update_status");
    assert.equal((await as("t1")("PATCH", `/api/cos/followups/${item.id}`, { status: "cancelled" })).body.error, "owner_cannot_cancel");
    assert.equal((await as("p1")("PATCH", `/api/cos/followups/${item.id}`, { status: "done" })).status, 404);
    const done = ok(await as("t1")("PATCH", `/api/cos/followups/${item.id}`, { status: "done", closeNote: "Sent to the board clerk." }));
    assert.equal(done.status, "done"); assert.ok(done.closedAt);
    // Row security and the guard hold even below the route.
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, "UPDATE cos_followups SET title='x' WHERE id=$1", [item.id]), /owner_may_only_update_status/);
    assert.equal((await asRole("teacher", USERS.p1[0], ID.s1, "SELECT count(*)::int AS n FROM cos_followups"))[0].n, 0);
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, "INSERT INTO cos_followups(district_id,title,owner_user_id,created_by) VALUES($1,'x y z',$2,$2)", [ID.d1, USERS.t1[0]]), /row-level security/);
  });

  it("the office edits, reopens and reassigns; other districts never see the item", async () => {
    const back = ok(await as("cos")("PATCH", `/api/cos/followups/${item.id}`, { status: "in_progress", ownerUserId: USERS.p1[0], dueOn: "2026-12-11" }));
    assert.deepEqual([back.status, back.ownerUserId, back.dueOn, back.closedAt], ["in_progress", USERS.p1[0], "2026-12-11", null]);
    assert.equal(ok(await as("t1")("GET", "/api/cos/followups")).length, 0, "the previous owner no longer sees it");
    assert.equal(ok(await as("p1")("GET", "/api/cos/followups")).length, 1);
    assert.equal(ok(await as("cos")("GET", "/api/cos/followups?status=active")).length, 1);
    assert.equal((await as("supt2")("GET", "/api/cos/followups")).body.data.length, 0, "another district");
    assert.equal((await as("cos")("PATCH", `/api/cos/followups/${item.id}`, { delete: true })).body.error, "unknown_field");
  });
});
