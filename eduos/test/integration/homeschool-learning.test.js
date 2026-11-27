// HSP-02: homeschool learning operations against real PostgreSQL, as the
// non-owner runtime role: plans, attendance and instructional time,
// parent-entered and outside work, progress reports, transcripts and
// portfolio exports, per-learner authority and family isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { USERS, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client, PG_URL } from "./harness.js";
import { ISSUER_STATEMENT } from "../../src/homeschool-reports.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const day = n => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

describe("HSP-02 homeschool learning operations", { skip }, () => {
  let db, idp, server, admin, s = {}, ids = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const switchTo = async (name, membershipId) => {
    const r = await fetch(`${server.base}/api/session/context`, { method: "POST", headers: { "content-type": "application/json", cookie: s[name].cookie, "x-csrf-token": s[name].csrf },
      body: JSON.stringify({ kind: "homeschool_family", membershipId }) });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
    s[name] = { cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => !c.endsWith("=")), csrf: j.csrfToken };
  };
  const familyOf = async name => (await as(name)("GET", "/api/session/contexts")).body.data.contexts.find(c => c.kind === "homeschool_family").membershipId;

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["pa", "pb", "t1", "p1"]) s[n] = await login(server.base, idp, n, { email_verified: true });
    // Family A: pa owns; t1 teaches Mia; pb views Mia. Family B: p1.
    const a = ok(await as("pa")("POST", "/api/homeschool/families", { name: "Ortiz Homeschool" }), 201);
    await switchTo("pa", a.membershipId);
    ids.mia = ok(await as("pa")("POST", "/api/homeschool/learners", { displayName: "Mia", gradeBand: "9" }), 201).id;
    ids.leo = ok(await as("pa")("POST", "/api/homeschool/learners", { displayName: "Leo", gradeBand: "k" }), 201).id;
    const ti = ok(await as("pa")("POST", "/api/homeschool/invitations", { email: USERS.t1[2], role: "co_educator", learnerIds: [ids.mia] }), 201).token;
    const pi = ok(await as("pa")("POST", "/api/homeschool/invitations", { email: USERS.pb[2], role: "guardian_viewer", learnerIds: [ids.mia] }), 201).token;
    ok(await as("t1")("POST", "/api/homeschool/invitations/accept", { token: ti }));
    ok(await as("pb")("POST", "/api/homeschool/invitations/accept", { token: pi }));
    await switchTo("t1", await familyOf("t1")); await switchTo("pb", await familyOf("pb"));
    const b = ok(await as("p1")("POST", "/api/homeschool/families", { name: "Nguyen Learning" }), 201);
    await switchTo("p1", b.membershipId);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a learning plan: courses and goals, written by the owner or the co-educator", async () => {
    ids.alg = ok(await as("t1")("POST", `/api/homeschool/learners/${ids.mia}/courses`, { title: "Algebra I", subject: "Math", schoolYear: "2026-2027" }), 201).id;
    ids.bio = ok(await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/courses`, { title: "Biology", subject: "Science", schoolYear: "2025-2026" }), 201).id;
    assert.equal((await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/courses`, { title: "X", schoolYear: "2026-2028" })).status, 400);
    ok(await as("t1")("POST", `/api/homeschool/learners/${ids.mia}/goals`, { text: "Solve two-step equations", courseId: ids.alg }), 201);
    ids.goal = ok(await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/goals`, { text: "Read 20 books" }), 201).id;
    assert.equal(ok(await as("pa")("PATCH", `/api/homeschool/goals/${ids.goal}`, { status: "met" })).metOn, new Date().toISOString().slice(0, 10));
    const done = ok(await as("pa")("PATCH", `/api/homeschool/courses/${ids.bio}`, { status: "completed", finalGrade: "A", credits: 1, completedOn: "2026-06-01" }));
    assert.deepEqual([done.status, done.finalGrade, done.credits, done.completedOn], ["completed", "A", 1, "2026-06-01"]);
    assert.equal((await as("pb")("POST", `/api/homeschool/learners/${ids.mia}/courses`, { title: "Art", schoolYear: "2026-2027" })).body.error, "not_allowed_for_this_learner");
    assert.equal((await as("t1")("POST", `/api/homeschool/learners/${ids.leo}/courses`, { title: "Phonics", schoolYear: "2026-2027" })).status, 404, "not their learner");
    const plan = ok(await as("pb")("GET", `/api/homeschool/learners/${ids.mia}/plan`));
    assert.equal(plan.canTeach, false); assert.equal(plan.courses.length, 2); assert.equal(plan.goals.length, 2);
  });

  it("attendance and instructional time; corrections are voids with a reason", async () => {
    for (const [d, minutes, kind] of [[1, 240, "instruction"], [1, 60, "co_op"], [2, 300, "instruction"], [3, 0, "absent"], [4, 180, "field_trip"]])
      ok(await as("t1")("POST", `/api/homeschool/learners/${ids.mia}/attendance`, { day: day(d), minutes, kind, courseId: kind === "instruction" ? ids.alg : undefined }), 201);
    const wrong = ok(await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/attendance`, { day: day(2), minutes: 600, kind: "instruction" }), 201);
    assert.equal((await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/attendance`, { day: day(-1), minutes: 60 })).status, 400, "not in the future");
    assert.equal((await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/attendance`, { day: day(1), minutes: 30, kind: "absent" })).status, 400, "absent means no minutes");
    assert.equal((await as("pb")("POST", `/api/homeschool/learners/${ids.mia}/attendance`, { day: day(1), minutes: 30 })).status, 403);
    assert.equal((await as("pa")("POST", `/api/homeschool/attendance/${wrong.id}/void`, {})).status, 400, "a reason is required");
    ok(await as("pa")("POST", `/api/homeschool/attendance/${wrong.id}/void`, { reason: "Entered twice" }));
    const a = ok(await as("pb")("GET", `/api/homeschool/learners/${ids.mia}/attendance?from=${day(10)}&to=${day(0)}`));
    assert.deepEqual([a.totals.instructionalDays, a.totals.absentDays, a.totals.minutes, a.totals.hours], [3, 1, 780, 13]);
    assert.equal(a.totals.minutesByKind.instruction, 540);
    assert.equal(a.sessions.find(x => x.id === wrong.id).voided, true, "kept, marked void");
  });

  it("work and evidence carry their provenance; outside work names its source", async () => {
    ok(await as("t1")("POST", `/api/homeschool/learners/${ids.mia}/work`, { title: "Unit 1 test", kind: "test", doneOn: day(2), courseId: ids.alg, score: 18, maxScore: 20 }), 201);
    ok(await as("t1")("POST", `/api/homeschool/learners/${ids.mia}/work`, { title: "Worksheet 3", doneOn: day(1), courseId: ids.alg, score: 7, maxScore: 10 }), 201);
    const ext = ok(await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/work`, { title: "Pre-algebra certificate", kind: "certificate", doneOn: day(5), source: "Khan Academy" }), 201);
    assert.equal(ext.provenance, "external");
    assert.equal((await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/work`, { title: "x", doneOn: day(1), score: 5 })).status, 400, "a score needs its maximum");
    ids.badWork = ok(await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/work`, { title: "Duplicate", doneOn: day(1), courseId: ids.alg, score: 0, maxScore: 10 }), 201).id;
    ok(await as("pa")("POST", `/api/homeschool/work/${ids.badWork}/void`, { reason: "Duplicate entry" }));
    const list = ok(await as("pb")("GET", `/api/homeschool/learners/${ids.mia}/work`));
    assert.equal(list.length, 4); assert.equal(list.filter(w => w.voided).length, 1);
  });

  it("the progress report counts only live records in the period", async () => {
    const r = ok(await as("pb")("GET", `/api/homeschool/learners/${ids.mia}/progress?from=${day(10)}&to=${day(0)}`));
    assert.equal(r.issuer.statement, ISSUER_STATEMENT);
    assert.equal(r.issuer.name, "Ortiz Homeschool");
    assert.equal(r.attendance.minutes, 780);
    const alg = r.courses.find(c => c.title === "Algebra I");
    assert.deepEqual([alg.work_items, alg.percent], [2, 83.3], "25 of 30, the voided duplicate left out");
    assert.equal(r.goals[0].status, "met");
  });

  it("exports need full authority, are logged with their hash, and say what they aren't", async () => {
    for (const who of ["t1", "pb"]) assert.equal((await as(who)("POST", `/api/homeschool/learners/${ids.mia}/exports`, { kind: "transcript" })).body.error, "export_needs_full_authority", who);
    const t = ok(await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/exports`, { kind: "transcript" }), 201);
    assert.equal(t.kind, "transcript");
    assert.deepEqual(t.years.map(y => [y.school_year, y.courses.map(c => [c.title, c.final_grade, c.credits])]), [["2025-2026", [["Biology", "A", 1]]]], "completed courses only");
    assert.equal(t.total_credits, 1);
    assert.match(t.issuer.statement, /not an official, state-approved or accredited transcript/);
    const p = ok(await as("pa")("POST", `/api/homeschool/learners/${ids.mia}/exports`, { kind: "portfolio", from: day(10), to: day(0) }), 201);
    assert.deepEqual(p.items.map(i => i.provenance).sort(), ["Entered by the family", "Entered by the family", "Entered by the family from Khan Academy"]);
    const log = ok(await as("pa")("GET", `/api/homeschool/learners/${ids.mia}/exports`));
    assert.deepEqual(log.map(x => x.kind), ["portfolio", "transcript"]);
    assert.equal(log[1].sha256, t.sha256);
    await assert.rejects(admin.query("DELETE FROM family_exports"), /append-only/);
    const audit = ok(await as("pa")("GET", "/api/homeschool/audit")).map(a => `${a.action}:${a.resourceType}`);
    for (const x of ["create:family_course", "record:family_attendance", "void:family_attendance", "record:family_work", "export:family_record"]) assert.ok(audit.includes(x), x);
  });

  it("another family reaches none of it, and the database enforces it as the runtime role", async () => {
    for (const path of [`/api/homeschool/learners/${ids.mia}/plan`, `/api/homeschool/learners/${ids.mia}/attendance`, `/api/homeschool/learners/${ids.mia}/work`, `/api/homeschool/learners/${ids.mia}/progress`])
      assert.equal((await as("p1")("GET", path)).status, 404, path);
    assert.equal((await as("p1")("PATCH", `/api/homeschool/courses/${ids.alg}`, { title: "Mine" })).status, 404);
    assert.equal((await as("p1")("POST", `/api/homeschool/work/${ids.badWork}/void`, { reason: "nope nope" })).status, 404);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      const { rows: [f] } = await admin.query("SELECT id FROM homeschool_families WHERE display_name='Nguyen Learning'");
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.family_id',$1,true), set_config('app.user_id',$2,true), set_config('app.district_id','',true)", [f.id, USERS.p1[0]]);
      for (const t of ["family_courses", "family_goals", "family_attendance", "family_work", "family_exports"])
        assert.equal((await app.query(`SELECT * FROM ${t}`)).rowCount, 0, t);
      await app.query("ROLLBACK");
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','superintendent',true), set_config('app.family_id','',true)", [ID.d1, USERS.supt1[0]]);
      for (const t of ["family_courses", "family_attendance", "family_work"]) assert.equal((await app.query(`SELECT * FROM ${t}`)).rowCount, 0, `district sees no ${t}`);
      await app.query("ROLLBACK");
      await assert.rejects(app.query("DELETE FROM family_work"), /permission denied/);
    } finally { await app.end(); }
  });
});
