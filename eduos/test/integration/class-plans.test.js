// TEACH-04: daily class plans against real PostgreSQL, as the non-owner runtime
// role: build a plan from the course's lessons and assignments plus warm-up,
// timer, text and link blocks; only this course's lessons; versioned saves;
// start from another day; who can see and edit.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("TEACH-04 daily class plans against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  let course, other, lesson, otherLesson, work;
  const DAY = "2026-11-23", NEXT = "2026-11-24";

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "pu", "pa"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    course = ok(await as("t1")("POST", "/api/learning/courses", { title: "Grade 4 Math", subject: "Math", gradeLevel: "4" }), 201);
    const unit = ok(await as("t1")("POST", `/api/learning/courses/${course.id}/units`, { title: "Fractions" }), 201);
    lesson = ok(await as("t1")("POST", "/api/learning/lessons", { courseId: course.id, unitId: unit.id, title: "Fraction strips", objective: "Show halves", content: "Fold strips." }), 201);
    work = ok(await as("t1")("POST", "/api/learning/assignments", { courseId: course.id, title: "Strips worksheet", kind: "work", pointsPossible: 10 }), 201);
    other = ok(await as("tp")("POST", "/api/learning/courses", { title: "Reading 4", subject: "Reading", gradeLevel: "4" }), 201);
    const u2 = ok(await as("tp")("POST", `/api/learning/courses/${other.id}/units`, { title: "Stories" }), 201);
    otherLesson = ok(await as("tp")("POST", "/api/learning/lessons", { courseId: other.id, unitId: u2.id, title: "Characters", objective: "Name traits", content: "Read." }), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  const blocks = () => [
    { kind: "warmup", prompt: "Which is bigger, 1/2 or 3/8?", minutes: 5, note: "Start with the back row" },
    { kind: "lesson", lessonId: lesson.id, minutes: 20 },
    { kind: "timer", label: "Pair work", minutes: 10 },
    { kind: "assignment", assignmentId: work.id, minutes: 10 },
    { kind: "link", label: "Fraction game", url: "https://example.org/fractions" }];

  it("a teacher sees their classes for the day and builds a plan", async () => {
    const day = ok(await as("t1")("GET", `/api/class-plans?date=${DAY}`));
    assert.deepEqual(day.map(c => [c.title, c.plan_id]), [["Grade 4 Math", null]], "only my own classes, no plan yet");
    const p = ok(await as("t1")("PUT", `/api/class-plans/${course.id}/${DAY}`, { title: "Fractions with strips", blocks: blocks(), status: "ready" }), 201);
    assert.deepEqual([p.version, p.status, p.minutes], [1, "ready", 45]);
    const got = ok(await as("t1")("GET", `/api/class-plans/${course.id}/${DAY}`));
    assert.deepEqual(got.plan.blocks.map(b => b.kind), ["warmup", "lesson", "timer", "assignment", "link"]);
    assert.equal(got.plan.blocks[1].lesson.content, "Fold strips.");
    assert.equal(got.plan.blocks[3].assignment.title, "Strips worksheet");
    assert.equal(got.plan.blocks[0].note, "Start with the back row", "private notes are for the teacher");
    assert.deepEqual(got.choices.lessons.map(l => l.title), ["Fraction strips"]);
    const listed = ok(await as("t1")("GET", `/api/class-plans?date=${DAY}`))[0];
    assert.deepEqual([listed.status, listed.blocks, listed.minutes], ["ready", 5, 45]);
  });

  it("only this course's lessons and assignments; bad blocks and empty ready plans are refused", async () => {
    const r = await as("t1")("PUT", `/api/class-plans/${course.id}/${NEXT}`, { blocks: [{ kind: "lesson", lessonId: otherLesson.id }] });
    assert.equal(r.status, 400); assert.equal(r.body.error, "not_from_this_course");
    assert.equal((await as("t1")("PUT", `/api/class-plans/${course.id}/${NEXT}`, { blocks: [{ kind: "link", label: "x", url: "javascript:alert(1)" }] })).body.error, "invalid_link");
    assert.equal((await as("t1")("PUT", `/api/class-plans/${course.id}/${NEXT}`, { blocks: [], status: "ready" })).body.error, "empty_plan");
    assert.equal((await as("t1")("PUT", `/api/class-plans/${course.id}/2026-02-30`, { blocks: [] })).body.error, "invalid_plan");
  });

  it("saves carry the version they started from", async () => {
    const stale = await as("p1")("PUT", `/api/class-plans/${course.id}/${DAY}`, { blocks: blocks().slice(0, 2) });
    assert.equal(stale.status, 409, "no baseVersion on an existing plan"); assert.equal(stale.body.updatedBy, "Teacher S1");
    const p = ok(await as("p1")("PUT", `/api/class-plans/${course.id}/${DAY}`, { blocks: blocks().slice(0, 2), baseVersion: 1, status: "ready" }));
    assert.equal(p.version, 2, "the school's principal may edit it");
    const late = await as("t1")("PUT", `/api/class-plans/${course.id}/${DAY}`, { blocks: blocks(), baseVersion: 1 });
    assert.equal(late.status, 409); assert.deepEqual([late.body.version, late.body.updatedBy], [2, "Principal S1"]);
  });

  it("start tomorrow from today's plan", async () => {
    const c = ok(await as("t1")("POST", `/api/class-plans/${course.id}/${NEXT}/copy-from`, { fromDate: DAY }), 201);
    assert.equal(c.status, "draft");
    assert.equal(ok(await as("t1")("GET", `/api/class-plans/${course.id}/${NEXT}`)).plan.blocks.length, 2);
    assert.equal((await as("t1")("POST", `/api/class-plans/${course.id}/${NEXT}/copy-from`, { fromDate: DAY })).body.error, "plan_exists");
  });

  it("other teachers, another school's principal, pupils and families can't read or edit it", async () => {
    assert.equal((await as("tp")("GET", `/api/class-plans/${course.id}/${DAY}`)).status, 404);
    assert.equal((await as("tp")("PUT", `/api/class-plans/${course.id}/${DAY}`, { blocks: [], baseVersion: 2 })).status, 404);
    assert.equal((await as("p2")("GET", `/api/class-plans/${course.id}/${DAY}`)).status, 404);
    for (const who of ["pu", "pa"]) assert.equal((await as(who)("GET", `/api/class-plans?date=${DAY}`)).status, 403, who);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','teacher',true),set_config('app.school_id',$3,true)", [ID.d1, USERS.tp[0], ID.s1]);
      assert.equal((await app.query("SELECT id FROM class_day_plans")).rowCount, 0, "RLS: another teacher sees none");
      await app.query("ROLLBACK");
    } finally { await app.end(); }
    const actions = (await admin.query("SELECT DISTINCT action FROM audit_events WHERE resource_type='class_day_plan'")).rows.map(r => r.action).sort();
    assert.deepEqual(actions, ["copy", "create", "update"]);
  });
});
