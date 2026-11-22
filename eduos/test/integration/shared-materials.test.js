// TEACH-02: the shared materials library against real PostgreSQL, as the
// non-owner runtime role: share a lesson or a unit you manage, the student-name
// check before sharing, browse across schools, copy into your own course as
// drafts with attribution, re-share (version + 1), withdraw, and the limits.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const STD = "e1000000-0000-4000-8000-0000000000aa";

describe("TEACH-02 shared materials against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  let course, unit, lesson, lesson2, mine, theirs, shared, sharedUnit;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query(`INSERT INTO learning_standards(id,district_id,framework,code,subject,grade_level,description) VALUES($1,$2,'CCSS','4.NF.A.1','Math','4','Equivalent fractions')`, [STD, ID.d1]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "p2", "t1", "tp", "pa", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    // Teacher S1's course, unit and two lessons; Principal S2's own course to copy into.
    course = ok(await as("t1")("POST", "/api/learning/courses", { title: "Grade 4 Math", subject: "Math", gradeLevel: "4" }), 201);
    unit = ok(await as("t1")("POST", `/api/learning/courses/${course.id}/units`, { title: "Fractions", summary: "Equivalent fractions with models" }), 201);
    lesson = ok(await as("t1")("POST", "/api/learning/lessons", { courseId: course.id, unitId: unit.id, title: "Fraction strips", objective: "Show equivalent fractions with strips",
      content: "Fold paper strips into halves, quarters and eighths. Compare lengths.", standardIds: [STD] }), 201);
    lesson2 = ok(await as("t1")("POST", "/api/learning/lessons", { courseId: course.id, unitId: unit.id, title: "Number lines", objective: "Place fractions on a number line",
      content: "Mark 0 and 1, then halves and quarters. Alice helped last year." }), 201);
    mine = ok(await as("p2")("POST", "/api/learning/courses", { title: "Math 4 (S2)", subject: "Math", gradeLevel: "4" }), 201);
    theirs = ok(await as("p2")("POST", `/api/learning/courses/${mine.id}/units`, { title: "Borrowed ideas" }), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a teacher shares a lesson they manage; others can't share it", async () => {
    assert.equal((await as("tp")("POST", "/api/materials", { kind: "lesson", sourceId: lesson.id })).status, 404, "not their course");
    assert.equal((await as("pa")("POST", "/api/materials", { kind: "lesson", sourceId: lesson.id })).status, 403);
    shared = ok(await as("t1")("POST", "/api/materials", { kind: "lesson", sourceId: lesson.id, summary: "Hands-on start to fractions" }), 201);
    assert.equal(shared.version, 1);
  });

  it("text naming a student pauses the share and shows the words; confirming shares it", async () => {
    const r = await as("t1")("POST", "/api/materials", { kind: "unit", sourceId: unit.id });
    assert.equal(r.status, 409); assert.equal(r.body.error, "may_mention_students");
    assert.deepEqual(r.body.words, ["Alice"], "only the words from the teacher's own text");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM shared_materials WHERE kind='unit'")).rows[0].n, 0, "nothing was shared");
    sharedUnit = ok(await as("t1")("POST", "/api/materials", { kind: "unit", sourceId: unit.id, confirmNotStudents: true }), 201);
    const a = await admin.query("SELECT detail FROM audit_events WHERE resource_type='shared_material' AND resource_id=$1", [sharedUnit.id]);
    assert.match(a.rows[0].detail, /confirmed_not_students/); assert.doesNotMatch(a.rows[0].detail, /Alice/);
  });

  it("colleagues at other schools browse and preview; families, pupils and other districts can't", async () => {
    const list = ok(await as("p2")("GET", "/api/materials"));
    assert.deepEqual(list.map(m => [m.kind, m.title, m.school, m.author, m.lessons, m.mine]).sort(),
      [["lesson", "Fraction strips", "S1", "Teacher S1", 1, false], ["unit", "Fractions", "S1", "Teacher S1", 2, false]]);
    assert.deepEqual(ok(await as("p2")("GET", "/api/materials?kind=unit")).map(m => m.title), ["Fractions"]);
    assert.deepEqual(ok(await as("p2")("GET", "/api/materials?q=hands-on")).map(m => m.title), ["Fraction strips"]);
    const one = ok(await as("p2")("GET", `/api/materials/${shared.id}`));
    assert.equal(one.body.content, "Fold paper strips into halves, quarters and eighths. Compare lengths.");
    assert.deepEqual(one.body.standards.map(x => x.code), ["4.NF.A.1"]);
    for (const who of ["pa", "pu"]) assert.equal((await as(who)("GET", "/api/materials")).status, 403, who);
    assert.deepEqual(ok(await as("supt2")("GET", "/api/materials")), []);
  });

  it("copying makes unapproved drafts in your own course, with attribution", async () => {
    assert.equal((await as("p2")("POST", `/api/materials/${shared.id}/copy`, { courseId: course.id, unitId: unit.id })).status, 404, "not your course");
    assert.equal((await as("p2")("POST", `/api/materials/${shared.id}/copy`, { courseId: mine.id })).body.error, "unit_required");
    const c = ok(await as("p2")("POST", `/api/materials/${shared.id}/copy`, { courseId: mine.id, unitId: theirs.id }), 201);
    const l = (await admin.query("SELECT title,status,approved_at,adapted_from,created_by,course_id FROM lessons WHERE id=$1", [c.id])).rows[0];
    assert.deepEqual([l.title, l.status, l.approved_at, l.adapted_from, l.created_by, l.course_id], ["Fraction strips", "draft", null, shared.id, USERS.p2[0], mine.id]);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM lesson_standards WHERE lesson_id=$1", [c.id])).rows[0].n, 1, "standards come along");
    const u = ok(await as("p2")("POST", `/api/materials/${sharedUnit.id}/copy`, { courseId: mine.id }), 201);
    assert.equal(u.lessonIds.length, 2);
    assert.equal((await admin.query("SELECT adapted_from FROM course_units WHERE id=$1", [u.id])).rows[0].adapted_from, sharedUnit.id);
    assert.equal(ok(await as("t1")("GET", `/api/materials/${shared.id}`)).copies, 1, "the author sees the count");
  });

  it("sharing again updates the snapshot; copies already made don't change", async () => {
    ok(await as("t1")("PATCH", `/api/learning/lessons/${lesson.id}`, { content: "Fold strips; then use fraction tiles." }));
    const again = ok(await as("t1")("POST", "/api/materials", { kind: "lesson", sourceId: lesson.id }));
    assert.deepEqual([again.id, again.version], [shared.id, 2]);
    assert.equal(ok(await as("p2")("GET", `/api/materials/${shared.id}`)).body.content, "Fold strips; then use fraction tiles.");
    assert.equal((await admin.query("SELECT content FROM lessons WHERE adapted_from=$1 AND course_id=$2", [shared.id, mine.id])).rows[0].content,
      "Fold paper strips into halves, quarters and eighths. Compare lengths.");
  });

  it("withdraw: the author, or the author's school leader; not another school's", async () => {
    assert.equal((await as("p2")("POST", `/api/materials/${shared.id}/withdraw`, {})).status, 404, "another school's principal can't");
    ok(await as("p1")("POST", `/api/materials/${shared.id}/withdraw`, { reason: "Needs a review" }));
    assert.deepEqual(ok(await as("p2")("GET", "/api/materials")).map(m => m.title), ["Fractions"]);
    assert.equal((await as("p2")("POST", `/api/materials/${shared.id}/copy`, { courseId: mine.id, unitId: theirs.id })).status, 404, "withdrawn can't be copied");
    ok(await as("t1")("POST", `/api/materials/${sharedUnit.id}/withdraw`, {}));
    const actions = (await admin.query("SELECT action FROM audit_events WHERE resource_type='shared_material'")).rows.map(r => r.action);
    for (const a of ["share", "update", "copy", "withdraw"]) assert.ok(actions.includes(a), a);
  });
});
