// TEACH-03: co-writing drafts against real PostgreSQL, as the non-owner runtime
// role: start from a lesson you manage, invite a colleague at another school,
// saves that merge, a save that conflicts (nothing lost), revisions, copy into
// your own course, publish to the library, leave, and the limits.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("TEACH-03 co-writing drafts against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  let course, unit, lesson, mine, theirs, draft, unitDraft;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "pa", "supt1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    course = ok(await as("t1")("POST", "/api/learning/courses", { title: "Grade 4 Math", subject: "Math", gradeLevel: "4" }), 201);
    unit = ok(await as("t1")("POST", `/api/learning/courses/${course.id}/units`, { title: "Fractions" }), 201);
    lesson = ok(await as("t1")("POST", "/api/learning/lessons", { courseId: course.id, unitId: unit.id, title: "Fraction strips", objective: "Show halves", content: "Fold strips." }), 201);
    mine = ok(await as("p2")("POST", "/api/learning/courses", { title: "Math 4 (S2)", subject: "Math", gradeLevel: "4" }), 201);
    theirs = ok(await as("p2")("POST", `/api/learning/courses/${mine.id}/units`, { title: "From the co-writing" }), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a teacher starts a draft from their lesson and invites a principal at another school", async () => {
    assert.equal((await as("tp")("POST", "/api/drafts", { from: "lesson", sourceId: lesson.id })).status, 404, "not their lesson");
    assert.equal((await as("pa")("POST", "/api/drafts", { from: "blank", kind: "lesson", subject: "Math", gradeLevel: "4" })).status, 403);
    draft = ok(await as("t1")("POST", "/api/drafts", { from: "lesson", sourceId: lesson.id }), 201);
    assert.equal((await as("p2")("GET", `/api/drafts/${draft.id}`)).status, 404, "not invited yet");
    assert.equal((await as("t1")("POST", `/api/drafts/${draft.id}/editors`, { userIds: [USERS.pa[0]] })).body.error, "editor_not_in_network");
    assert.equal(ok(await as("t1")("POST", `/api/drafts/${draft.id}/editors`, { userIds: [USERS.p2[0]] })).added, 1);
    const d = ok(await as("p2")("GET", `/api/drafts/${draft.id}`));
    assert.deepEqual([d.title, d.body.content, d.version, d.editors.map(e => [e.name, e.school])], ["Fraction strips", "Fold strips.", 1, [["Teacher S1", "S1"], ["Principal S2", "S2"]]]);
    assert.deepEqual(ok(await as("p2")("GET", "/api/drafts")).map(x => [x.title, x.with_names]), [["Fraction strips", "Teacher S1"]]);
    const n = await admin.query("SELECT count(*)::int AS n FROM notification_outbox WHERE recipient_user_id=$1 AND ref_id=$2", [USERS.p2[0], draft.id]);
    assert.equal(n.rows[0].n, 1);
  });

  it("two editors save from the same version: different fields merge, the same field conflicts", async () => {
    const base = ok(await as("t1")("GET", `/api/drafts/${draft.id}`));
    const a = ok(await as("t1")("PUT", `/api/drafts/${draft.id}`, { baseVersion: 1, body: { ...base.body, objective: "Show halves and quarters" } }));
    assert.deepEqual([a.version, a.merged], [2, false]);
    const b = ok(await as("p2")("PUT", `/api/drafts/${draft.id}`, { baseVersion: 1, body: { ...base.body, content: "Fold strips into halves, then quarters." } }));
    assert.deepEqual([b.version, b.merged, b.body.objective, b.body.content], [3, true, "Show halves and quarters", "Fold strips into halves, then quarters."]);
    const c = await as("t1")("PUT", `/api/drafts/${draft.id}`, { baseVersion: 2, body: { ...base.body, objective: "Show halves and quarters", content: "Fold twice." } });
    assert.equal(c.status, 409); assert.equal(c.body.error, "edit_conflict"); assert.deepEqual(c.body.conflicts, ["content"]);
    assert.equal(c.body.current.body.content, "Fold strips into halves, then quarters."); assert.equal(c.body.current.updatedBy, "Principal S2");
    const d = ok(await as("t1")("GET", `/api/drafts/${draft.id}`));
    assert.deepEqual(d.revisions.map(r => [r.version, r.edited_by, r.merged]), [[3, "Principal S2", true], [2, "Teacher S1", false], [1, "Teacher S1", false]]);
    assert.equal(ok(await as("t1")("GET", `/api/drafts/${draft.id}/revisions/1`)).body.content, "Fold strips.");
    assert.equal((await as("t1")("PUT", `/api/drafts/${draft.id}`, { baseVersion: 9, body: base.body })).status, 400);
  });

  it("units: two editors change different lessons at once, and both changes stay", async () => {
    unitDraft = ok(await as("p2")("POST", "/api/drafts", { from: "blank", kind: "unit", title: "Decimals", subject: "Math", gradeLevel: "4" }), 201);
    ok(await as("p2")("POST", `/api/drafts/${unitDraft.id}/editors`, { userIds: [USERS.t1[0]] }));
    const v1 = ok(await as("p2")("GET", `/api/drafts/${unitDraft.id}`));
    const two = { ...v1.body, lessons: [{ ...v1.body.lessons[0], title: "Tenths" }, { title: "Hundredths", objective: "", content: "", standards: [], sources: [] }] };
    ok(await as("p2")("PUT", `/api/drafts/${unitDraft.id}`, { baseVersion: 1, body: two }));
    ok(await as("t1")("PUT", `/api/drafts/${unitDraft.id}`, { baseVersion: 2, body: { ...two, lessons: [{ ...two.lessons[0], content: "Shade 3 of 10." }, two.lessons[1]] } }));
    const m = ok(await as("p2")("PUT", `/api/drafts/${unitDraft.id}`, { baseVersion: 2, body: { ...two, lessons: [two.lessons[0], { ...two.lessons[1], content: "Shade 30 of 100." }] } }));
    assert.equal(m.merged, true);
    assert.deepEqual(m.body.lessons.map(l => l.content), ["Shade 3 of 10.", "Shade 30 of 100."]);
  });

  it("a save naming a student warns; publishing waits for confirmation", async () => {
    const d = ok(await as("t1")("GET", `/api/drafts/${draft.id}`));
    const w = ok(await as("t1")("PUT", `/api/drafts/${draft.id}`, { baseVersion: d.version, body: { ...d.body, content: `${d.body.content} Bob B showed this well.` } }));
    assert.ok(w.warnings.includes("Bob B") || w.warnings.includes("Bob"), JSON.stringify(w.warnings));
    const p = await as("t1")("POST", `/api/drafts/${draft.id}/publish`, {});
    assert.equal(p.status, 409); assert.equal(p.body.error, "may_mention_students");
    ok(await as("t1")("PUT", `/api/drafts/${draft.id}`, { baseVersion: w.version, body: { ...w.body, content: "Fold strips into halves, then quarters." } }));
    const pub = ok(await as("t1")("POST", `/api/drafts/${draft.id}/publish`, { summary: "Co-written with S2" }), 201);
    const lib = ok(await as("tp")("GET", `/api/materials/${pub.id}`));
    assert.deepEqual([lib.title, lib.body.content, lib.author], ["Fraction strips", "Fold strips into halves, then quarters.", "Teacher S1"]);
  });

  it("each editor copies the draft into their own course; an unfinished one can't be", async () => {
    const c = ok(await as("p2")("POST", `/api/drafts/${draft.id}/copy`, { courseId: mine.id, unitId: theirs.id }), 201);
    const l = (await admin.query("SELECT title,objective,content,status,course_id FROM lessons WHERE id=$1", [c.id])).rows[0];
    assert.deepEqual([l.title, l.content, l.status, l.course_id], ["Fraction strips", "Fold strips into halves, then quarters.", "draft", mine.id]);
    assert.equal((await as("p2")("POST", `/api/drafts/${draft.id}/copy`, { courseId: course.id, unitId: unit.id })).status, 404, "not into someone else's course");
    const gap = await as("p2")("POST", `/api/drafts/${unitDraft.id}/copy`, { courseId: mine.id });
    assert.equal(gap.status, 409); assert.deepEqual(gap.body.missing, ["lessons[0].objective", "lessons[1].objective"]);
  });

  it("leaving ends access; nobody can remove someone else; other roles and RLS hold", async () => {
    ok(await as("p2")("POST", `/api/drafts/${draft.id}/leave`));
    assert.equal((await as("p2")("GET", `/api/drafts/${draft.id}`)).status, 404);
    assert.equal((await as("p2")("PUT", `/api/drafts/${draft.id}`, { baseVersion: 1, body: { title: "x" } })).status, 404);
    ok(await as("t1")("POST", `/api/drafts/${draft.id}/editors`, { userIds: [USERS.p2[0]] }));
    assert.equal(ok(await as("p2")("GET", `/api/drafts/${draft.id}`)).editors.length, 2, "re-added");
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','teacher',true),set_config('app.school_id',$3,true)", [ID.d1, USERS.t1[0], ID.s1]);
      await assert.rejects(app.query("UPDATE collab_draft_editors SET left_at=now() WHERE draft_id=$1 AND user_id=$2", [draft.id, USERS.p2[0]]), /row-level security/);
      await app.query("ROLLBACK");
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','teacher',true),set_config('app.school_id',$3,true)", [ID.d1, USERS.tp[0], ID.s1]);
      assert.equal((await app.query("SELECT id FROM collab_drafts")).rowCount, 0, "a teacher who isn't an editor sees no drafts");
      await assert.rejects(app.query("INSERT INTO collab_draft_editors(draft_id,district_id,user_id,added_by) VALUES($1,$2,$3,$3)", [draft.id, ID.d1, USERS.tp[0]]), /row-level security/);
      await app.query("ROLLBACK");
    } finally { await app.end(); }
    const actions = (await admin.query("SELECT DISTINCT action FROM audit_events WHERE resource_type='collab_draft'")).rows.map(r => r.action).sort();
    assert.deepEqual(actions, ["add_editors", "copy", "create", "leave", "update"]);
  });
});
