// 37.6.0 Leo and Edison against real PostgreSQL, through the staff AI gateway:
// both are off until the superintendent turns them on; Leo saves DRAFT lessons
// with provenance that the database refuses to publish before a school leader
// approves them; Edison returns only aggregation-gate output, in the caller's
// own scope; an external model sees only redacted curriculum (Leo) or school
// labels and released counts (Edison).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const STD = "c1000000-0000-4000-8000-000000000001", STD2 = "c1000000-0000-4000-8000-000000000002";

function fakeProvider() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => { received.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "OK from the model" } }], usage: { prompt_tokens: 50, completion_tokens: 100 } })); });
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}/v1`, received, close: () => new Promise(x => srv.close(x)) })));
}

describe("Leo and Edison against real PostgreSQL", { skip }, () => {
  let db, idp, local, ext, provider, admin, appDb, s = {}, course, unit, approvedLesson, source, draft;
  const as = (name, srv = local) => client(srv.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const asRole = async (role, user, school, sql, params = []) => {
    await appDb.query("BEGIN");
    try {
      await appDb.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id',$4,true)", [ID.d1, user, role, school ?? ""]);
      return (await appDb.query(sql, params)).rows;
    } finally { await appDb.query("ROLLBACK"); }
  };
  const extraNames = Array.from({ length: 10 }, (_, i) => `Quinn Testpupil${String.fromCharCode(65 + i)}`);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    provider = await fakeProvider();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("SELECT set_config('app.district_id', $1, false)", [ID.d1]);
    await admin.query(`INSERT INTO learning_standards(id,district_id,framework,code,subject,grade_level,description) VALUES
      ($1,$3,'CCSS','3.NF.A.1','Math','3','Understand a fraction 1/b as one part of a whole partitioned into b equal parts.'),
      ($2,$3,'CCSS','3.NF.A.3','Math','3','Explain equivalence of fractions in special cases.')`, [STD, STD2, ID.d1]);
    // 12 grade-3 pupils at S1 (Alice, Bob and ten more): today 7 present, 5 absent.
    for (const [i, n] of extraNames.entries())
      await admin.query(`INSERT INTO students(district_id,school_id,local_student_number,display_name,grade_level) VALUES($1,$2,$3,$4,'3')`, [ID.d1, ID.s1, `S1-X${i}`, n]);
    const kids = (await admin.query(`SELECT id FROM students WHERE school_id=$1 ORDER BY local_student_number`, [ID.s1])).rows.map(r => r.id);
    for (const [i, id] of kids.entries())
      await admin.query(`INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,eduos_school_today($3),$4)`, [ID.d1, id, ID.s1, i < 7 ? "present" : "absent"]);
    appDb = new pg.Client(db.appUrl); await appDb.connect();
    local = await startServer({ ...env, DATABASE_URL: db.appUrl });
    ext = await startServer({ ...env, DATABASE_URL: db.appUrl, AI_PROVIDER: "openai_compatible", AI_ALLOW_EXTERNAL_PROVIDER: "true",
      AI_PROVIDER_URL: provider.url, AI_PROVIDER_MODEL: "fake-model", AI_ALLOW_INSECURE_LOOPBACK: "true", AI_PROVIDER_TIMEOUT_MS: "2000" });
    for (const name of ["supt1", "p1", "p2", "t1", "pu", "pa", "vp1", "supt2"]) s[name] = await login(local.base, idp, name, { email_verified: true });
    // Curriculum: course, unit, an approved lesson, an approved primary source.
    course = ok(await as("t1")("POST", "/api/learning/courses", { title: "Grade 3 Fractions", subject: "Math", gradeLevel: "3" }), 201);
    unit = ok(await as("t1")("POST", `/api/learning/courses/${course.id}/units`, { title: "Unit fractions" }), 201);
    approvedLesson = ok(await as("t1")("POST", "/api/learning/lessons", { courseId: course.id, unitId: unit.id, title: "Fraction strips",
      objective: "I can show unit fractions.", content: "Fold a strip into equal parts.", standardIds: [STD] }), 201);
    ok(await as("p1")("POST", `/api/learning/lessons/${approvedLesson.id}/approve`));
    source = ok(await as("t1")("POST", "/api/learning/sources", { title: "[First flight, Kitty Hawk]", archive: "Library of Congress", url: "https://www.loc.gov/item/00652085/",
      kind: "photograph", rights: "No known restrictions on publication.", creator: "John T. Daniels", date: "1903-12-17", description: "The first powered flight." }), 201);
    ok(await as("p1")("POST", `/api/learning/sources/${source.id}/approve`));
  });
  after(async () => {
    if (process.env.EDUOS_IT_DEBUG) console.log(local?.log().split("\n").filter(l => /fail|error|message/i.test(l)).join("\n"));
    await local?.stop(); await ext?.stop(); await provider?.close(); await appDb?.end(); await admin?.end(); await idp?.close(); await db?.drop?.();
  });

  const draftBody = () => ({ courseId: course.id, unitId: unit.id, standardIds: [STD, STD2], lessonIds: [approvedLesson.id], sourceIds: [source.id], minutes: 45, focus: "Unit fractions on a number line" });

  it("both are off until the superintendent turns them on, and run only through their own endpoints", async () => {
    assert.equal(ok(await as("t1")("GET", `/api/leo/options?courseId=${course.id}`)).enabled, false);
    assert.equal((await as("t1")("POST", "/api/leo/drafts", draftBody())).body.error, "ai_usecase_not_enabled");
    assert.equal(ok(await as("p1")("GET", "/api/edison/trends")).briefEnabled, false);
    assert.equal((await as("p1")("POST", "/api/edison/brief", {})).body.error, "ai_usecase_not_enabled");
    ok(await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "leo_lesson", "ops_trends"], dailyTokenCap: 1000000, userDailyTokenCap: 100000 }));
    const st = ok(await as("t1")("GET", "/api/ai/status"));
    assert.ok(!st.usecases.some(u => u.id === "leo_lesson"), "not offered as free text");
    const r = await as("t1")("POST", "/api/ai/run", { usecase: "leo_lesson", text: "anything at all" });
    assert.equal(r.status, 400); assert.equal(r.body.error, "ai_usecase_has_own_endpoint");
    assert.ok(ok(await as("supt1")("GET", "/api/ai/policy")).usecases.some(u => u.id === "ops_trends"), "the superintendent sees both switches");
  });

  it("Leo: only course managers; curriculum only; saved as an unapproved draft with provenance", async () => {
    for (const who of ["pu", "pa", "vp1"]) assert.equal((await as(who)("POST", "/api/leo/drafts", draftBody())).status, 403, who);
    assert.equal((await as("p2")("POST", "/api/leo/drafts", draftBody())).status, 404, "other school's principal");
    assert.equal((await as("t1")("POST", "/api/leo/drafts", { ...draftBody(), standardIds: [] })).status, 400);
    assert.equal((await as("t1")("POST", "/api/leo/drafts", { ...draftBody(), standardIds: [STD, STD2, STD, STD2, STD] })).status, 400);
    // An unapproved lesson or a draft source can't be built on.
    const unapproved = ok(await as("t1")("POST", "/api/learning/lessons", { courseId: course.id, unitId: unit.id, title: "Rough notes", objective: "x", content: "y" }), 201);
    assert.equal((await as("t1")("POST", "/api/leo/drafts", { ...draftBody(), lessonIds: [unapproved.id] })).body.error, "lesson_not_approved");
    const r = ok(await as("t1")("POST", "/api/leo/drafts", draftBody()), 201);
    draft = r.lesson;
    assert.equal(draft.status, "draft"); assert.equal(draft.approved, false); assert.equal(draft.generatedBy, "leo-local");
    assert.match(draft.content, /^LEO DRAFT/); assert.match(draft.content, /3\.NF\.A\.1/); assert.match(draft.content, /Fraction strips/);
    const row = (await admin.query(`SELECT generated_by, generated_from, status, approved_at FROM lessons WHERE id=$1`, [draft.id])).rows[0];
    assert.equal(row.generated_by, "leo-local");
    assert.deepEqual(row.generated_from.standards.sort(), [STD, STD2].sort());
    assert.deepEqual(row.generated_from.lessons, [approvedLesson.id]);
    assert.deepEqual(row.generated_from.sources, [source.id]);
    assert.equal(row.approved_at, null);
    const usage = (await admin.query(`SELECT usecase, outcome FROM ai_usage WHERE id=$1`, [Number(row.generated_from.usageId)])).rows[0];
    assert.deepEqual(usage, { usecase: "leo_lesson", outcome: "ok" });
    const audit = (await admin.query(`SELECT action FROM audit_events WHERE resource_id=$1`, [draft.id])).rows.map(x => x.action);
    assert.ok(audit.includes("leo_draft"));
    const seen = ok(await as("t1")("GET", `/api/learning/courses/${course.id}`));
    assert.equal(seen.units[0].lessons.find(l => l.id === draft.id).generatedBy, "leo-local");
    assert.equal((await as("pu")("GET", `/api/learning/lessons/${draft.id}`)).status, 404, "pupils never see a draft");
  });

  it("Leo: the draft is published only after a school leader approves it (API and database)", async () => {
    assert.equal((await as("t1")("PATCH", `/api/learning/lessons/${draft.id}`, { status: "published" })).body.error, "leo_draft_needs_approval");
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, `UPDATE lessons SET status='published' WHERE id=$1`, [draft.id]), /approves it/);
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, `UPDATE lessons SET generated_by=NULL, generated_from=NULL WHERE id=$1`, [draft.id]), /permission denied|immutable/);
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, `INSERT INTO lessons(district_id,course_id,unit_id,seq,title,objective,content,status,created_by,generated_by,generated_from)
      VALUES($1,$2,$3,99,'x','y','z','published',$4,'leo-local','{}')`, [ID.d1, course.id, unit.id, USERS.t1[0]]), /unapproved draft/);
    assert.equal((await as("t1")("POST", `/api/learning/lessons/${draft.id}/approve`)).status, 403);
    ok(await as("p1")("POST", `/api/learning/lessons/${draft.id}/approve`));
    ok(await as("t1")("PATCH", `/api/learning/lessons/${draft.id}`, { status: "published" }));
    // A teacher edit clears the approval (014) and Leo's guard takes it back to draft.
    const edited = ok(await as("t1")("PATCH", `/api/learning/lessons/${draft.id}`, { content: "LEO DRAFT: edited by the teacher. Warm-up, mini-lesson, exit ticket." }));
    assert.equal(edited.approved, false); assert.equal(edited.status, "draft");
    // Ordinary lessons are unchanged: a teacher may still publish without approval.
    ok(await as("t1")("PATCH", `/api/learning/lessons/${approvedLesson.id}`, { status: "published" }));
  });

  it("Edison: gate-released counts only, in the caller's own scope", async () => {
    for (const who of ["t1", "pu", "pa"]) assert.equal((await as(who)("GET", "/api/edison/trends")).status, 403, who);
    assert.equal((await as("p1")("GET", "/api/edison/trends?days=99")).status, 400);
    const p = ok(await as("p1")("GET", "/api/edison/trends?days=3"));
    assert.equal(p.scope, "school"); assert.equal(p.k, 5);
    assert.deepEqual(p.schools.map(x => x.schoolId), [ID.s1]);
    const today = p.schools[0].attendance.at(-1);
    assert.equal(today.total, 12); assert.equal(today.counts.present, 7); assert.equal(today.counts.absent, 5);
    assert.equal(p.schools[0].enrolled, 12);
    const vp = ok(await as("vp1")("GET", "/api/edison/trends?days=2"));
    assert.deepEqual(vp.schools.map(x => x.schoolId), [ID.s1]);
    const d = ok(await as("supt1")("GET", "/api/edison/trends?days=2"));
    assert.equal(d.scope, "district"); assert.equal(d.schools.length, 2);
    const s2 = d.schools.find(x => x.schoolId === ID.s2);
    assert.equal(s2.enrolled, null, "one pupil at S2: withheld by the gate");
    assert.ok(s2.attendance.every(a => a.total === null));
    const raw = JSON.stringify([p, d]);
    for (const n of ["Alice A", "Bob B", "Carol C", ...extraNames]) assert.ok(!raw.includes(n), n);
    for (const id of [ID.alice, ID.bob, ID.carol]) assert.ok(!raw.includes(id), id);
    assert.ok(!JSON.stringify(ok(await as("supt2")("GET", "/api/edison/trends?days=1"))).includes(ID.s1), "other district");
    // Only leaders may call the database functions, and only for their scope.
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, `SELECT eduos_edison_source('attendance_daily',$1,current_date)`, [ID.s1]), /leader scope/);
    await assert.rejects(asRole("principal", USERS.p1[0], ID.s1, `SELECT eduos_edison_source('attendance_daily',$1,current_date)`, [ID.s2]), /leader scope/);
    await assert.rejects(asRole("principal", USERS.p1[0], ID.s1, `SELECT eduos_edison_source('student_list',$1,current_date)`, [ID.s1]), /unknown Edison source/);
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, `SELECT eduos_edison_identifiers()`), /leader scope/);
  });

  it("Edison brief (local): written from the released numbers", async () => {
    const r = ok(await as("p1")("POST", "/api/edison/brief", { days: 3 }));
    assert.match(r.text, /Edison trends/); assert.equal(r.source, "local");
    assert.equal(r.basis.schools[0].label, "School 1");
    assert.deepEqual(r.schools, [{ label: "School 1", schoolId: ID.s1, name: "S1" }]);
  });

  it("external model: Leo gets redacted curriculum text; Edison gets labels and released counts only", async () => {
    // A teacher wrote a pupil's name into an approved lesson: Leo's brief is redacted before it leaves.
    await admin.query(`UPDATE lessons SET objective='Quinn TestpupilA shows unit fractions.' WHERE id=$1`, [approvedLesson.id]);
    ok(await as("p1")("POST", `/api/learning/lessons/${approvedLesson.id}/approve`), 200); // the edit cleared the approval
    for (const name of ["t1", "p1"]) s[`${name}x`] = await login(ext.base, idp, name, { email_verified: true });
    const r = ok(await client(ext.base, s.t1x)("POST", "/api/leo/drafts", draftBody()), 201);
    assert.equal(r.source, "external"); assert.equal(r.lesson.generatedBy, "leo-external");
    assert.match(r.lesson.content, /^LEO DRAFT[^\n]*\n\nOK from the model$/);
    const sent = provider.received.at(-1);
    assert.match(sent.messages[0].content, /You are Leo/);
    assert.match(sent.messages[1].content, /3\.NF\.A\.1/);
    assert.ok(!sent.messages[1].content.includes("Quinn TestpupilA"), "student name redacted");
    assert.ok(!sent.messages[1].content.includes(approvedLesson.id) && !sent.messages[1].content.includes(course.id), "no ids");
    const b = ok(await client(ext.base, s.p1x)("POST", "/api/edison/brief", { days: 3 }));
    assert.equal(b.source, "external");
    const ctx = provider.received.at(-1).messages[1].content;
    assert.match(provider.received.at(-1).messages[0].content, /You are Edison/);
    for (const n of ["S1", ID.s1, "Alice A", "Bob B", ...extraNames]) assert.ok(!ctx.includes(n), n);
    assert.equal(JSON.parse(ctx).schools[0].label, "School 1");
  });
});
