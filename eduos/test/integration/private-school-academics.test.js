// HSP-04: private school admissions and academics against real PostgreSQL, as
// the non-owner runtime role: the admissions lifecycle into enrollment, classes,
// schedules and rosters, attendance, report cards, roles and isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const TABLES = ["ps_applications", "ps_application_events", "ps_classes", "ps_class_meetings", "ps_class_rosters", "ps_attendance", "ps_report_cards", "ps_report_card_lines"];
const day = n => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

describe("HSP-04 private school admissions and academics", { skip }, () => {
  let db, idp, server, admin, env, s = {}, ids = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const switchTo = async (name, membershipId) => {
    const r = await fetch(`${server.base}/api/session/context`, { method: "POST", headers: { "content-type": "application/json", cookie: s[name].cookie, "x-csrf-token": s[name].csrf },
      body: JSON.stringify({ kind: "private_school", membershipId }) });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
    s[name] = { cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => !c.endsWith("=")), csrf: j.csrfToken };
  };
  const join = async (by, body, who) => {
    const t = ok(await as(by)("POST", "/api/private-school/invitations", body), 201).token;
    const r = ok(await as(who)("POST", "/api/private-school/invitations/accept", { token: t }));
    await switchTo(who, r.membershipId);
    return r.membershipId;
  };

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["pa", "pb", "t1", "p1", "p2", "supt1b"]) s[n] = await login(server.base, idp, n, { email_verified: true });
    const r = ok(await as("pa")("POST", "/api/private-school/schools", { legalName: "Hillside Academy, Inc.", displayName: "Hillside Academy", campusName: "Main Campus" }), 201);
    ids.school = r.schoolId; ids.main = r.campusId;
    await switchTo("pa", r.membershipId);
    const v = await run(["src/private-school-verify.js", "--school", ids.school, "--ref", "Registry 4471", "--by", "Trust Team"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(v.code, 0, v.out);
    ids.north = ok(await as("pa")("POST", "/api/private-school/campuses", { name: "North Campus" }), 201).id;
    ids.teacher = await join("pa", { email: USERS.t1[2], role: "teacher", campusId: ids.main }, "t1");
    await join("pa", { email: USERS.p1[2], role: "registrar" }, "p1");
    await join("pa", { email: USERS.p2[2], role: "teacher", campusId: ids.north }, "p2");
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("every academics table has forced RLS", async () => {
    const { rows } = await admin.query("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind='r'", [TABLES]);
    assert.equal(rows.length, TABLES.length);
    for (const r of rows) assert.ok(r.relforcerowsecurity, r.relname);
  });

  it("admissions: inquiry through offer, waitlist and decline, into enrollment; only valid steps", async () => {
    const a = ok(await as("p1")("POST", "/api/private-school/admissions", { campusId: ids.main, applicantName: "Ava Lin", gradeLevel: "4", schoolYear: "2027-2028",
      guardianName: "Mei Lin", guardianEmail: USERS.pb[2], documents: ["Birth certificate", "Prior school records"] }), 201);
    assert.equal(a.status, "inquiry"); assert.deepEqual(a.next, ["applied", "withdrawn"]);
    assert.equal((await as("p1")("POST", `/api/private-school/admissions/${a.id}/status`, { status: "offered" })).body.error, "not_a_next_step");
    for (const st of ["applied", "under_review", "offered", "accepted"]) ok(await as("p1")("POST", `/api/private-school/admissions/${a.id}/status`, { status: st, note: `to ${st}` }));
    ok(await as("p1")("PATCH", `/api/private-school/admissions/${a.id}`, { documents: [{ label: "Birth certificate", received: true }, { label: "Prior school records", received: true }] }));
    const e = ok(await as("p1")("POST", `/api/private-school/admissions/${a.id}/enroll`, { localNumber: "H-001" }));
    assert.equal(e.status, "enrolled"); ids.ava = e.learnerId;
    assert.match(e.note, /Invite the guardian/);
    assert.equal((await as("p1")("POST", `/api/private-school/admissions/${a.id}/enroll`, {})).body.error, "not_accepted");
    const hist = ok(await as("p1")("GET", `/api/private-school/admissions/${a.id}`)).history.map(h => h.to);
    assert.deepEqual(hist, ["inquiry", "applied", "under_review", "offered", "accepted", "enrolled"]);
    // A waitlist and a decline.
    const b = ok(await as("p1")("POST", "/api/private-school/admissions", { campusId: ids.main, applicantName: "Ben Ortiz", gradeLevel: "4", schoolYear: "2027-2028" }), 201);
    for (const st of ["applied", "under_review", "waitlisted"]) ok(await as("p1")("POST", `/api/private-school/admissions/${b.id}/status`, { status: st }));
    const c2 = ok(await as("p1")("POST", "/api/private-school/admissions", { campusId: ids.main, applicantName: "Cy Park", schoolYear: "2027-2028" }), 201);
    for (const st of ["applied", "under_review", "waitlisted"]) ok(await as("p1")("POST", `/api/private-school/admissions/${c2.id}/status`, { status: st }));
    const list = ok(await as("p1")("GET", "/api/private-school/admissions?schoolYear=2027-2028&status=waitlisted"));
    assert.deepEqual(list.map(x => [x.applicantName, x.waitlistPosition]), [["Ben Ortiz", 1], ["Cy Park", 2]]);
    for (const st of ["offered", "declined"]) ok(await as("p1")("POST", `/api/private-school/admissions/${b.id}/status`, { status: st }));
    assert.equal((await as("p1")("POST", `/api/private-school/admissions/${b.id}/status`, { status: "accepted" })).body.error, "not_a_next_step", "declined is final");
    // Re-enrollment of a current learner.
    const re = ok(await as("p1")("POST", "/api/private-school/admissions", { learnerId: ids.ava, schoolYear: "2028-2029" }), 201);
    assert.deepEqual([re.kind, re.status, re.applicantName], ["re_enrollment", "applied", "Ava Lin"]);
    assert.equal((await as("p1")("POST", "/api/private-school/admissions", { learnerId: ids.ava, schoolYear: "2028-2029" })).body.error, "already_applied_for_that_year");
    // Teachers and guardians don't see admissions.
    assert.deepEqual(ok(await as("t1")("GET", "/api/private-school/admissions")), []);
    assert.equal((await as("t1")("POST", "/api/private-school/admissions", { campusId: ids.main, applicantName: "X", schoolYear: "2027-2028" })).status, 403);
    ids.bo = ok(await as("p1")("POST", "/api/private-school/learners", { displayName: "Bo Kim", campusId: ids.main, gradeLevel: "4" }), 201).id;
    ids.nia = ok(await as("p1")("POST", "/api/private-school/learners", { displayName: "Nia North", campusId: ids.north, gradeLevel: "4" }), 201).id;
  });

  it("classes, a weekly schedule and rosters; a teacher sees their own week", async () => {
    ids.math = ok(await as("p1")("POST", "/api/private-school/classes", { campusId: ids.main, name: "Math 4", subject: "Math", gradeLevel: "4", schoolYear: "2027-2028", term: "Fall", teacherMembershipId: ids.teacher }), 201).id;
    ids.art = ok(await as("p1")("POST", "/api/private-school/classes", { campusId: ids.main, name: "Art 4", schoolYear: "2027-2028", term: "Fall" }), 201).id;
    assert.equal((await as("p1")("POST", "/api/private-school/classes", { campusId: ids.north, name: "X", schoolYear: "2027-2028", teacherMembershipId: ids.teacher })).body.error, "teacher_not_on_campus");
    ok(await as("p1")("PUT", `/api/private-school/classes/${ids.math}/meetings`, [{ weekday: 1, starts: "09:00", ends: "09:50", room: "12" }, { weekday: 3, starts: "09:00", ends: "09:50", room: "12" }]));
    assert.equal((await as("p1")("PUT", `/api/private-school/classes/${ids.math}/meetings`, [{ weekday: 8, starts: "09:00", ends: "08:00" }])).status, 400);
    for (const l of [ids.ava, ids.bo]) ok(await as("p1")("POST", `/api/private-school/classes/${ids.math}/roster`, { learnerId: l }), 201);
    assert.equal((await as("p1")("POST", `/api/private-school/classes/${ids.math}/roster`, { learnerId: ids.nia })).body.error, "learner_on_another_campus");
    assert.equal((await as("p1")("POST", `/api/private-school/classes/${ids.math}/roster`, { learnerId: ids.ava })).body.error, "already_on_roster");
    assert.equal((await as("t1")("POST", `/api/private-school/classes/${ids.math}/roster`, { learnerId: ids.bo })).status, 403, "teachers don't change rosters");
    const k = ok(await as("t1")("GET", `/api/private-school/classes/${ids.math}`));
    assert.deepEqual([k.youTeach, k.canRun, k.teacher, k.roster.map(l => l.displayName)], [true, false, "Teacher S1", ["Ava Lin", "Bo Kim"]]);
    assert.deepEqual(ok(await as("t1")("GET", "/api/private-school/schedule")).map(m => [m.name, m.weekday, m.starts]), [["Math 4", 1, "09:00"], ["Math 4", 3, "09:00"]]);
    assert.deepEqual(ok(await as("p2")("GET", "/api/private-school/classes")), [], "a teacher on another campus doesn't see Main's classes");
  });

  it("attendance: the teacher marks their class; changes keep history; the registrar marks the day", async () => {
    assert.equal(ok(await as("t1")("POST", "/api/private-school/attendance", { day: day(1), classId: ids.math, marks: [{ learnerId: ids.ava, status: "present" }, { learnerId: ids.bo, status: "absent" }] })).recorded, 2);
    const ch = ok(await as("t1")("POST", "/api/private-school/attendance", { day: day(1), classId: ids.math, marks: [{ learnerId: ids.bo, status: "tardy", note: "Bus late" }, { learnerId: ids.ava, status: "present" }] }));
    assert.deepEqual([ch.recorded, ch.changed], [1, 1], "unchanged marks are left alone");
    assert.equal((await as("t1")("POST", "/api/private-school/attendance", { day: day(1), classId: ids.art, marks: [{ learnerId: ids.ava, status: "present" }] })).body.error, "not_your_class");
    assert.equal((await as("t1")("POST", "/api/private-school/attendance", { day: day(1), classId: ids.math, marks: [{ learnerId: ids.nia, status: "present" }] })).status, 400, "not on the roster");
    assert.equal((await as("t1")("POST", "/api/private-school/attendance", { day: day(1), marks: [{ learnerId: ids.ava, status: "present" }] })).status, 403, "the daily mark isn't the teacher's");
    assert.equal((await as("t1")("POST", "/api/private-school/attendance", { day: day(-1), classId: ids.math, marks: [{ learnerId: ids.ava, status: "present" }] })).status, 400, "not in the future");
    ok(await as("p1")("POST", "/api/private-school/attendance", { day: day(1), marks: [{ learnerId: ids.ava, status: "present" }, { learnerId: ids.bo, status: "excused" }] }));
    const sheet = ok(await as("t1")("GET", `/api/private-school/attendance?day=${day(1)}&classId=${ids.math}`));
    assert.deepEqual(sheet.learners.map(l => [l.displayName, l.status]), [["Ava Lin", "present"], ["Bo Kim", "tardy"]]);
    const { rows } = await admin.query("SELECT count(*) FILTER (WHERE voided_at IS NOT NULL)::int AS v, count(*)::int AS n FROM ps_attendance WHERE learner_id=$1", [ids.bo]);
    assert.deepEqual([rows[0].v, rows[0].n], [1, 3], "the changed mark is kept, voided");
    const t = ok(await as("p1")("GET", `/api/private-school/learners/${ids.bo}/attendance`));
    assert.equal(t.totals.excused, 1);
  });

  it("report cards: teachers write their class's line on a draft; guardians see it only once published", async () => {
    const card = ok(await as("p1")("POST", "/api/private-school/report-cards", { learnerId: ids.ava, schoolYear: "2027-2028", term: "Fall" }), 201);
    assert.equal((await as("p1")("POST", "/api/private-school/report-cards", { learnerId: ids.ava, schoolYear: "2027-2028", term: "Fall" })).body.error, "report_card_exists");
    assert.deepEqual(ok(await as("p1")("GET", `/api/private-school/report-cards/${card.id}`)).missing.map(m => m.class), ["Math 4"]);
    ok(await as("t1")("PUT", `/api/private-school/report-cards/${card.id}/lines/${ids.math}`, { grade: "A-", comment: "Strong problem solver." }));
    assert.equal((await as("t1")("PUT", `/api/private-school/report-cards/${card.id}/lines/${ids.art}`, { grade: "B" })).body.error, "not_your_class");
    assert.equal((await as("t1")("POST", `/api/private-school/report-cards/${card.id}/publish`, {})).status, 403, "teachers don't publish");
    // The guardian joins, linked to Ava.
    await join("p1", { email: USERS.pb[2], role: "guardian", learnerIds: [ids.ava] }, "pb");
    assert.deepEqual(ok(await as("pb")("GET", "/api/private-school/report-cards")), [], "a draft isn't visible to the family");
    ok(await as("p1")("POST", `/api/private-school/report-cards/${card.id}/publish`, { comment: "A great start." }));
    const seen = ok(await as("pb")("GET", `/api/private-school/report-cards/${card.id}`));
    assert.deepEqual([seen.status, seen.lines.map(l => [l.class, l.grade])], ["published", [["Math 4", "A-"]]]);
    assert.equal((await as("t1")("PUT", `/api/private-school/report-cards/${card.id}/lines/${ids.math}`, { grade: "A" })).body.error, "report_card_published");
    // The guardian sees their child's classes and marks, nothing about anyone else.
    assert.deepEqual(ok(await as("pb")("GET", "/api/private-school/classes")).map(k => k.name), ["Math 4"]);
    assert.equal(ok(await as("pb")("GET", `/api/private-school/learners/${ids.ava}/attendance`)).marks.length, 2);
    assert.equal((await as("pb")("GET", `/api/private-school/learners/${ids.bo}/attendance`)).status, 404);
    assert.deepEqual(ok(await as("pb")("GET", `/api/private-school/classes/${ids.math}`)).roster.map(l => l.displayName), ["Ava Lin"], "only their own child on the roster");
  });

  it("another school and a district reach none of it, as the runtime role too", async () => {
    const r = ok(await as("supt1b")("POST", "/api/private-school/schools", { legalName: "Other Prep LLC", displayName: "Other Prep", campusName: "Campus" }), 201);
    await switchTo("supt1b", r.membershipId);
    assert.equal((await run(["src/private-school-verify.js", "--school", r.schoolId, "--ref", "Registry", "--by", "Trust"], { ...env, DATABASE_URL: db.ownerUrl })).code, 0);
    assert.deepEqual(ok(await as("supt1b")("GET", "/api/private-school/admissions")), []);
    for (const path of [`/api/private-school/classes/${ids.math}`, `/api/private-school/report-cards/${ids.ava}`, `/api/private-school/learners/${ids.ava}/attendance`])
      assert.equal((await as("supt1b")("GET", path)).status, 404, path);
    assert.equal((await as("supt1b")("POST", `/api/private-school/classes/${ids.math}/roster`, { learnerId: ids.ava })).status, 404);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','superintendent',true)", [ID.d1, USERS.supt1[0]]);
      for (const t of TABLES) assert.equal((await app.query(`SELECT * FROM ${t}`)).rowCount, 0, `a district sees no ${t}`);
      await app.query("ROLLBACK");
      await assert.rejects(app.query("DELETE FROM ps_attendance"), /permission denied/);
      await assert.rejects(app.query("UPDATE ps_application_events SET note='x'"), /permission denied/);
    } finally { await app.end(); }
  });
});
