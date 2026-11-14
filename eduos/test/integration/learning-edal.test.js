// EduOS 32.6.0 learning core + EDAL ledger against real PostgreSQL, as the
// non-owner runtime role: courses/lessons/standards, curated primary sources
// (LoC / National Archives only), lesson approval for Christie, quizzes with
// hidden keys, auto-scoring, accommodations, attempts and teacher review,
// rubric grading, gradebook, family view and privacy, per-standard mastery,
// final grades and credentials on the hash chain, verify endpoint, record
// proofs, tamper detection, checkpoint, CLI, and FERPA erasure that keeps
// the chain verifiable.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const STD = "e1000000-0000-4000-8000-000000000001", STD2 = "e1000000-0000-4000-8000-000000000002";
const SKILL = "e2000000-0000-4000-8000-000000000001";

describe("EduOS 32.6.0 learning core and EDAL against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, appDb, env, s = {};
  const as = name => client(server.base, s[name]);
  const asRole = async (role, user, school, sql, params = []) => {
    await appDb.query("BEGIN");
    try {
      await appDb.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id',$4,true)", [ID.d1, user, role, school ?? ""]);
      return (await appDb.query(sql, params)).rows;
    } finally { await appDb.query("ROLLBACK"); }
  };
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, WEBHOOK_SIGNING_KEY: "w".repeat(40) });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("SELECT set_config('app.district_id',$1,false)", [ID.d1]);
    await admin.query(`INSERT INTO learning_standards(id,district_id,framework,code,subject,grade_level,description,source_url) VALUES
      ($1,$3,'CCSS','4.NF.A.1','Math','3','Summary: equivalent fractions','https://www.thecorestandards.org/Math/Content/4/NF/A/1/'),
      ($2,$3,'CCSS','RI.4.6','Reading','3','Summary: firsthand and secondhand accounts',NULL)`, [STD, STD2, ID.d1]);
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5)", [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
    appDb = new pg.Client(db.appUrl); await appDb.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "p2", "t1", "pu", "pa", "pb", "supt2"]) {
      s[name] = await login(server.base, idp, name, { email_verified: true });
      assert.ok(s[name].cookie, `${name} signed in`);
    }
  });
  after(async () => {
    if (process.env.EDUOS_IT_DEBUG) console.log(server?.log().split("\n").filter(l => /fail|error|message/i.test(l)).join("\n"));
    await server?.stop(); await appDb?.end(); await admin?.end(); await idp?.close(); await db?.drop?.();
  });

  let source, course, unit, lesson, quiz, work, attempt1;
  it("primary sources: only Library of Congress / National Archives links; drafts hidden until a leader approves", async () => {
    const bad = await as("t1")("POST", "/api/learning/sources", { title: "Invented letter", archive: "Library of Congress", url: "https://example.com/letter", kind: "letter", rights: "?", description: "x" });
    assert.equal(bad.status, 400);
    source = ok(await as("t1")("POST", "/api/learning/sources", { title: "[First flight, 120 feet in 12 seconds, 10:35 a.m.; Kitty Hawk, North Carolina]",
      archive: "Library of Congress", url: "https://www.loc.gov/item/00652085/", kind: "photograph", rights: "No known restrictions on publication.",
      creator: "Orville Wright and John T. Daniels", date: "1903-12-17", description: "The first powered flight." }), 201);
    assert.equal(source.status, "draft");
    await assert.rejects(admin.query(`INSERT INTO primary_sources(district_id,title,media_kind,archive,archive_url,rights,description,curated_by) VALUES($1,'x','other','Library of Congress','https://fake.example/x','r','d',$2)`, [ID.d1, USERS.t1[0]]), /check/i);
    assert.equal(ok(await as("pu")("GET", "/api/learning/sources")).length, 0, "pupils do not see drafts");
    assert.equal((await as("t1")("POST", `/api/learning/sources/${source.id}/approve`)).status, 403);
    ok(await as("p1")("POST", `/api/learning/sources/${source.id}/approve`));
    assert.equal(ok(await as("pu")("GET", "/api/learning/sources")).length, 1);
  });

  it("courses, units and lessons with standards; scope by role and school", async () => {
    assert.equal((await as("pu")("POST", "/api/learning/courses", { title: "x", subject: "Math", gradeLevel: "3" })).status, 403);
    course = ok(await as("t1")("POST", "/api/learning/courses", { title: "Grade 3 Fractions", subject: "Math", gradeLevel: "3" }), 201);
    ok(await as("t1")("POST", `/api/learning/courses/${course.id}/enrollments`, { studentIds: [ID.alice, ID.bob] }));
    assert.equal((await as("t1")("POST", `/api/learning/courses/${course.id}/enrollments`, { studentIds: [ID.carol] })).status, 400, "other school");
    unit = ok(await as("t1")("POST", `/api/learning/courses/${course.id}/units`, { title: "Equivalent fractions" }), 201);
    lesson = ok(await as("t1")("POST", "/api/learning/lessons", { courseId: course.id, unitId: unit.id, title: "Fraction strips", objective: "I can show equivalent fractions.",
      content: "Fold a strip in half and then again: one half is two fourths.", standardIds: [STD, STD2], sources: [{ sourceId: source.id, prompts: ["What do you see?"] }] }), 201);
    assert.equal((await as("pu")("GET", `/api/learning/lessons/${lesson.id}`)).status, 404, "draft lesson hidden from pupils");
    ok(await as("t1")("PATCH", `/api/learning/lessons/${lesson.id}`, { status: "published" }));
    const seen = ok(await as("pu")("GET", `/api/learning/lessons/${lesson.id}`));
    assert.equal(seen.standards.length, 2); assert.equal(seen.sources[0].url, "https://www.loc.gov/item/00652085/");
    assert.equal((await as("p2")("GET", `/api/learning/courses/${course.id}`)).status, 404, "other school's principal");
    assert.equal(ok(await as("pa")("GET", `/api/learning/courses?studentId=${ID.alice}`)).courses.length, 1);
    assert.equal((await as("pa")("GET", `/api/learning/courses?studentId=${ID.bob}`)).status, 403, "not their child");
  });

  it("lesson approval: only a leader approves; editing the text clears approval", async () => {
    assert.equal((await as("t1")("POST", `/api/learning/lessons/${lesson.id}/approve`)).status, 403);
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, `UPDATE lessons SET approved_at=now(),approved_by=$2 WHERE id=$1`, [lesson.id, USERS.t1[0]]), /leader/);
    ok(await as("p1")("POST", `/api/learning/lessons/${lesson.id}/approve`));
    assert.equal(ok(await as("t1")("GET", `/api/learning/lessons/${lesson.id}`)).approved, true);
    assert.equal(ok(await as("t1")("PATCH", `/api/learning/lessons/${lesson.id}`, { content: "Fold a strip in half, then in half again: one half is two fourths, 1/2 = 2/4. Folding the strip again makes more pieces that are all the same size." })).approved, false);
    ok(await as("p1")("POST", `/api/learning/lessons/${lesson.id}/approve`));
  });

  it("quizzes: keys never reach learners or families; accommodations extend the timer", async () => {
    ok(await as("t1")("PUT", `/api/learning/accommodations/${ID.alice}`, { extraTimePct: 50, readAloud: true }));
    assert.equal((await as("pu")("PUT", `/api/learning/accommodations/${ID.alice}`, { extraTimePct: 200, readAloud: true })).status, 403);
    quiz = ok(await as("t1")("POST", "/api/learning/assignments", { courseId: course.id, lessonId: lesson.id, kind: "quiz", title: "Quiz 1", maxAttempts: 2, retakePolicy: "highest", timeLimitMinutes: 10,
      items: [
        { kind: "mc", prompt: "Equivalent to 1/2?", choices: ["2/3", "3/6"], key: { index: 1 }, standardId: STD },
        { kind: "numeric", prompt: "3/4 = ?/8", key: { value: "6" }, standardId: STD },
        { kind: "short", prompt: "A fraction equal to 2/5 with denominator 10", key: { accepted: ["4/10"] }, standardId: STD },
        { kind: "source", prompt: "What does the photo show?", sourceId: source.id, standardId: STD2 }] }), 201);
    assert.equal(quiz.points, 4);
    const view = await as("pu")("GET", `/api/learning/assignments/${quiz.id}`);
    assert.equal(view.status, 200);
    assert.ok(!JSON.stringify(view.body).includes("4/10") && !JSON.stringify(view.body).includes("answerKey"), "no keys in the learner view");
    assert.equal(view.body.data.effectiveMinutes, 15);
    assert.equal((await asRole("pupil", USERS.pu[0], ID.s1, "SELECT * FROM quiz_item_keys")).length, 0);
    assert.equal((await asRole("parent", USERS.pa[0], ID.s1, "SELECT * FROM quiz_item_keys")).length, 0);
    assert.equal((await asRole("teacher", USERS.t1[0], ID.s1, "SELECT * FROM quiz_item_keys")).length, 4);
    assert.equal((await as("pu")("POST", `/api/assignments/${quiz.id}/submit`, { studentId: ID.alice, responseText: "x" })).status, 404, "quizzes are not plain submissions");
  });

  it("attempt: save, submit, auto-score; keys are released only after submit; teacher review returns it", async () => {
    const started = ok(await as("pu")("POST", `/api/learning/quizzes/${quiz.id}/attempts`), 201);
    attempt1 = started.attempt;
    const mins = (new Date(attempt1.deadlineAt) - new Date(attempt1.startedAt)) / 60000;
    assert.ok(Math.abs(mins - 15) < 0.1, `deadline ${mins}`);
    assert.equal(attempt1.readAloud, true);
    assert.equal((await asRole("pupil", USERS.pu[0], ID.s1, "SELECT * FROM eduos_quiz_keys($1)", [attempt1.id])).length, 0, "no keys while in progress");
    const [mc, num, short, src] = attempt1.items;
    for (const [it, r] of [[mc, "1"], [num, "6"], [short, "4 / 10"], [src, "The plane flying and a man running."]])
      ok(await as("pu")("PUT", `/api/learning/attempts/${attempt1.id}/responses/${it.id}`, { response: r }));
    assert.equal((await as("pa")("PUT", `/api/learning/attempts/${attempt1.id}/responses/${mc.id}`, { response: "0" })).status, 403);
    const done = ok(await as("pu")("POST", `/api/learning/attempts/${attempt1.id}/submit`));
    assert.equal(done.attempt.status, "needs_review", "the source item waits for the teacher");
    assert.equal(done.attempt.autoPoints, 3);
    assert.equal(done.attempt.answersShown, false, "a retake remains, so no answers yet");
    assert.equal((await as("pu")("PUT", `/api/learning/attempts/${attempt1.id}/responses/${mc.id}`, { response: "0" })).status, 409, "locked after submit");
    assert.equal((await asRole("pupil", USERS.pu[0], ID.s1, "UPDATE quiz_attempts SET total_points=99 WHERE id=$1 RETURNING id", [attempt1.id])).length, 0, "learners cannot set scores");
    assert.equal((await asRole("pupil", USERS.pu[0], ID.s1, "SELECT eduos_quiz_record_auto($1,'[]'::jsonb,1) AS r", [attempt1.id]))[0].r, null, "auto scores are recorded once");
    assert.equal(ok(await as("t1")("GET", "/api/learning/review")).attempts.length, 1);
    assert.equal((await as("t1")("POST", `/api/learning/attempts/${attempt1.id}/review`, { scores: [] })).status, 409, "the source item needs points");
    const rv = ok(await as("t1")("POST", `/api/learning/attempts/${attempt1.id}/review`, { scores: [{ itemId: src.id, points: 1, comment: "Good observation." }] }));
    assert.equal(rv.status, "returned"); assert.equal(rv.total, 4);
    const back = ok(await as("pu")("GET", `/api/learning/attempts/${attempt1.id}`));
    assert.equal(back.items[3].teacherComment, "Good observation.");
    assert.equal(back.canRetake, true);
  });

  it("retakes: limited by max attempts; answers shown once none remain; the policy picks the score", async () => {
    const a2 = ok(await as("pu")("POST", `/api/learning/quizzes/${quiz.id}/attempts`), 201).attempt;
    assert.equal(a2.attemptNo, 2);
    for (const [i, r] of [[0, "1"], [1, "12/16"], [2, "4/10"]]) ok(await as("pu")("PUT", `/api/learning/attempts/${a2.id}/responses/${a2.items[i].id}`, { response: r }));
    const d2 = ok(await as("pu")("POST", `/api/learning/attempts/${a2.id}/submit`)).attempt;
    assert.equal(d2.autoPoints, 2, "numeric expects 6 exactly (12/16 is not ?/8)");
    assert.equal((await as("pu")("POST", `/api/learning/quizzes/${quiz.id}/attempts`)).status, 409, "no attempts left");
    ok(await as("t1")("POST", `/api/learning/attempts/${a2.id}/review`, { scores: [{ itemId: a2.items[3].id, points: 1 }] }));
    const v2 = ok(await as("pu")("GET", `/api/learning/attempts/${a2.id}`));
    assert.equal(v2.answersShown, true);
    assert.deepEqual(v2.items[0].answerKey, { index: 1 });
    const gb = ok(await as("t1")("GET", `/api/learning/courses/${course.id}/gradebook`));
    const alice = gb.students.find(x => x.id === ID.alice);
    assert.equal(alice.cells[0].earned, 4, "highest attempt counts");
  });

  it("rubric grading with feedback; family sees it once returned; mastery is explained and milestones hit the ledger", async () => {
    work = ok(await as("t1")("POST", "/api/learning/assignments", { courseId: course.id, title: "Poster", kind: "work",
      rubric: [{ id: "acc", title: "Accuracy", standardId: STD, levels: [{ points: 1, label: "Not yet" }, { points: 2, label: "Some" }, { points: 3, label: "All" }] },
               { id: "neat", title: "Neatness", levels: [{ points: 0, label: "Messy" }, { points: 1, label: "Neat" }] }] }), 201);
    assert.equal(work.points, 4);
    assert.equal((await as("t1")("POST", `/api/learning/assignments/${work.id}/grade`, { studentId: ID.alice, scores: [{ criterionId: "acc", points: 7 }] })).status, 400);
    const g = ok(await as("t1")("POST", `/api/learning/assignments/${work.id}/grade`, { studentId: ID.alice, scores: [{ criterionId: "acc", points: 3 }, { criterionId: "neat", points: 1 }], feedback: "Lovely poster." }));
    assert.equal(g.percent, 100);
    const sub = ok(await as("pa")("GET", `/api/learning/assignments/${work.id}?studentId=${ID.alice}`)).submission;
    assert.equal(sub.feedback, "Lovely poster.");
    const m = ok(await as("pa")("GET", `/api/learning/mastery/${STD}?studentId=${ID.alice}`));
    assert.equal(m.evidenceCount, 3);
    assert.equal(m.level, "mastered", JSON.stringify(m));
    assert.match(m.explanation, /most recent/);
    assert.equal((await as("pb")("GET", `/api/learning/mastery/${STD}?studentId=${ID.alice}`)).status, 403, "another family");
    const kinds = (await admin.query("SELECT kind FROM edal_entries WHERE district_id=$1 ORDER BY seq", [ID.d1])).rows.map(r => r.kind);
    assert.deepEqual(kinds, ["mastery_milestone"]);
    const prog = ok(await as("pa")("GET", `/api/learning/progress?studentId=${ID.alice}`));
    assert.equal(prog.courses[0].grade.letter, "A");
    assert.equal(prog.courses[0].standards.find(x => x.id === STD).level, "mastered");
    assert.equal((await as("pb")("GET", `/api/learning/progress?studentId=${ID.alice}`)).status, 403);
    assert.equal(ok(await as("pa")("GET", "/api/learning/progress")).children.length, 1);
  });

  it("Christie: hints from approved lesson text, standard in the greeting, practice counts as half-weight evidence", async () => {
    await admin.query(`INSERT INTO christie_skills(id,district_id,school_id,subject,grade_level,code,title,sequence,explanation,source,status,created_by,approved_by,approved_at,standard_id,lesson_id)
        VALUES($1,$2,$3,'Math','3','G3.FR','Equivalent fractions',1,'Multiply top and bottom by the same number.','test','approved',$4,$5,now(),$6,$7)`,
      [SKILL, ID.d1, ID.s1, USERS.t1[0], USERS.p1[0], STD, lesson.id]);
    await admin.query(`INSERT INTO christie_items(district_id,skill_id,seq,prompt,answer,hints) VALUES($1,$2,1,'1/3 = ?/6','2',ARRAY['What times 3 is 6?'])`, [ID.d1, SKILL]);
    const ses = ok(await as("pu")("POST", "/api/christie/sessions", { skillId: SKILL }), 201).session;
    assert.match(ses.turns[0].text, /standard 4\.NF\.A\.1/);
    const q = ok(await as("pu")("POST", `/api/christie/sessions/${ses.id}/turns`, { kind: "question", text: "why does folding make pieces the same size?" }));
    assert.match(q.replies[0].text, /same size/i, "retrieval reaches the approved lesson text");
    assert.doesNotMatch(q.replies[0].text, /2\/4/, "never quotes a worked example that gives the answer");
    const a = ok(await as("pu")("POST", `/api/christie/sessions/${ses.id}/turns`, { kind: "attempt", text: "2" }));
    assert.equal(a.mastery.standard.code, "4.NF.A.1");
    const ev = (await admin.query("SELECT weight::float8 AS w FROM mastery_evidence WHERE source='christie' AND student_id=$1", [ID.alice])).rows;
    assert.deepEqual(ev.map(r => r.w), [0.5]);
    const path = ok(await as("pu")("GET", "/api/christie/path"));
    assert.equal(path.skills.find(k => k.id === SKILL).mastery_basis, "standard");
  });

  let finalEntry;
  it("final grades and credentials are recorded on the ledger; corrections need a reason and supersede", async () => {
    assert.equal((await as("pu")("POST", `/api/learning/courses/${course.id}/final-grades`, { studentId: ID.alice })).status, 403);
    const fg = ok(await as("t1")("POST", `/api/learning/courses/${course.id}/final-grades`, { studentId: ID.alice }), 201);
    assert.equal(fg.letter, "A");
    finalEntry = fg.edal.id;
    assert.equal((await as("t1")("POST", `/api/learning/courses/${course.id}/final-grades`, { studentId: ID.alice })).status, 409);
    const fix = ok(await as("t1")("POST", `/api/learning/courses/${course.id}/final-grades`, { studentId: ID.alice, percent: 88, reason: "Late work policy applied after review." }), 201);
    assert.equal(fix.supersedes, fg.id); assert.equal(fix.letter, "B");
    await assert.rejects(asRole("teacher", USERS.t1[0], ID.s1, "UPDATE course_final_grades SET percent=100"), /permission denied/);
    assert.equal((await as("t1")("POST", "/api/learning/credentials", { studentId: ID.alice, kind: "award", title: "Star" })).status, 403);
    const cr = ok(await as("p1")("POST", "/api/learning/credentials", { studentId: ID.alice, kind: "standard_mastery", title: "Equivalent fractions", standardId: STD }), 201);
    assert.equal((await as("p1")("POST", "/api/learning/credentials", { studentId: ID.alice, kind: "standard_mastery", title: "x", standardId: STD2 })).status, 409, "not mastered");
    assert.equal((await as("p1")("POST", `/api/learning/credentials/${cr.id}/revoke`, { reason: "short" })).status, 400);
    ok(await as("p1")("POST", `/api/learning/credentials/${cr.id}/revoke`, { reason: "Issued to the wrong learner in error." }));
    const prog = ok(await as("pu")("GET", "/api/learning/progress"));
    assert.equal(prog.finalGrades.length, 1); assert.equal(prog.finalGrades[0].letter, "B"); assert.equal(prog.corrections, 1);
  });

  it("EDAL verify: leaders only, district-scoped, checkpoints, per-record proofs for families", async () => {
    for (const who of ["t1", "pa", "pu"]) assert.equal((await as(who)("GET", "/api/edal/verify")).status, 403, who);
    const v = ok(await as("supt1")("GET", "/api/edal/verify"));
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    assert.equal(v.entries, 5);
    assert.deepEqual(v.byKind, { mastery_milestone: 1, final_grade: 2, credential: 1, credential_revoked: 1 });
    assert.match(v.statement, /not a blockchain/);
    assert.equal(ok(await as("supt2")("GET", "/api/edal/verify")).entries, 0, "other district sees nothing");
    const cp = ok(await as("supt1")("POST", "/api/edal/checkpoints", { note: "term close" }), 201);
    assert.equal(cp.seq, 5);
    const proof = ok(await as("pa")("GET", `/api/edal/records/${finalEntry}`));
    assert.equal(proof.ok, true); assert.equal(proof.payload.letter, "A");
    assert.equal((await as("pb")("GET", `/api/edal/records/${finalEntry}`)).status, 404, "another family");
    await assert.rejects(asRole("principal", USERS.p1[0], ID.s1, "SELECT * FROM edal_heads"), /permission denied/, "heads only via definer functions");
    assert.equal((await as("p1")("GET", "/api/edal/export")).status, 403, "district-wide export: district roles only");
    await assert.rejects(asRole("superintendent", USERS.supt1[0], null, "UPDATE edal_entries SET kind='credential'"), /permission denied/);
    await assert.rejects(asRole("superintendent", USERS.supt1[0], null, "DELETE FROM edal_payloads"), /permission denied/);
    await assert.rejects(admin.query("UPDATE edal_entries SET kind='credential' WHERE seq=1"), /append-only|EDAL/i);
  });

  it("tamper detection: a changed payload or entry breaks verification; CLI and offline export agree", async () => {
    const cli = (args) => run(["src/edal-verify.js", ...args], { ...env, DATABASE_URL: db.ownerUrl });
    const good = await cli(["--district", ID.d1]);
    assert.equal(good.code, 0, good.out); assert.match(good.out, /OK +district/);
    const exp = ok(await as("supt1")("GET", "/api/edal/export"));
    assert.ok(exp.entries.every(e => !("payload" in e)), "export carries hashes, not payloads");
    const dir = mkdtempSync(path.join(tmpdir(), "edal-"));
    writeFileSync(path.join(dir, "chain.json"), JSON.stringify(exp));
    writeFileSync(path.join(dir, "cp.json"), JSON.stringify({ districtId: ID.d1, seq: 5, headHash: exp.head.headHash }));
    assert.equal((await run(["src/edal-verify.js", "--file", path.join(dir, "chain.json"), "--checkpoint", path.join(dir, "cp.json")], env)).code, 0);
    const wrongCp = await cli(["--district", ID.d1, "--checkpoint", JSON.stringify({ seq: 5, headHash: "a".repeat(64) })]);
    assert.equal(wrongCp.code, 1, wrongCp.out); assert.match(wrongCp.out, /checkpoint BROKEN/);
    const bad = structuredClone(exp); bad.entries[1].payload_hash = "f".repeat(64);
    writeFileSync(path.join(dir, "bad.json"), JSON.stringify(bad));
    const offline = await run(["src/edal-verify.js", "--file", path.join(dir, "bad.json")], env);
    assert.equal(offline.code, 1, offline.out); assert.match(offline.out, /#2: entry hash/);

    // Simulate someone with database superuser rights editing records behind EduOS's back.
    const p2 = (await admin.query("SELECT p.entry_id,p.payload FROM edal_payloads p JOIN edal_entries e ON e.id=p.entry_id WHERE e.seq=2 AND e.district_id=$1", [ID.d1])).rows[0];
    const e3 = (await admin.query("SELECT id,recorded_at FROM edal_entries WHERE seq=3 AND district_id=$1", [ID.d1])).rows[0];
    await admin.query("SET session_replication_role = replica");
    await admin.query(`UPDATE edal_payloads SET payload=replace(payload,'"letter":"A"','"letter":"A+"') WHERE entry_id=$1`, [p2.entry_id]);
    await admin.query("RESET session_replication_role");
    let v = ok(await as("supt1")("GET", "/api/edal/verify"));
    assert.equal(v.ok, false); assert.match(JSON.stringify(v.problems), /payload does not match/);
    const proof = ok(await as("pa")("GET", `/api/edal/records/${p2.entry_id}`));
    assert.equal(proof.ok, false, "the family's proof shows the change too");
    assert.equal((await cli([])).code, 1);
    await admin.query("SET session_replication_role = replica");
    await admin.query("UPDATE edal_payloads SET payload=$2 WHERE entry_id=$1", [p2.entry_id, p2.payload]);
    await admin.query("UPDATE edal_entries SET recorded_at='2020-01-01T00:00:00.000Z' WHERE id=$1", [e3.id]);
    await admin.query("RESET session_replication_role");
    v = ok(await as("supt1")("GET", "/api/edal/verify"));
    assert.equal(v.ok, false); assert.match(JSON.stringify(v.problems), /entry hash does not match/);
    await admin.query("SET session_replication_role = replica");
    await admin.query("UPDATE edal_entries SET recorded_at=$2 WHERE id=$1", [e3.id, e3.recorded_at]);
    await admin.query("RESET session_replication_role");
    assert.equal(ok(await as("supt1")("GET", "/api/edal/verify")).ok, true, "restored");
  });

  it("FERPA: export includes learning and ledger records; deletion erases payloads and the chain still verifies", async () => {
    const exp = await as("supt1")("POST", `/api/students/${ID.alice}/records-export`);
    assert.equal(exp.status, 200);
    for (const k of ["courseEnrollments", "quizAttempts", "accommodations", "masteryEvidence", "standardMastery", "finalGrades", "credentials", "edalRecords"])
      assert.ok(Array.isArray(exp.body[k]) && exp.body[k].length > 0, k);
    const del = await as("supt1")("POST", `/api/students/${ID.alice}/records-delete`, { confirmLocalStudentNumber: "S1-A", reason: "Verified FERPA deletion request from the family (test)." });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok(del.body.counts.edal_payloads_erased >= 5, JSON.stringify(del.body.counts));
    for (const t of ["quiz_attempts", "mastery_evidence", "standard_mastery", "course_final_grades", "credentials", "student_accommodations", "course_enrollments"])
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${t} WHERE student_id=$1`, [ID.alice])).rows[0].n, 0, t);
    const v = ok(await as("supt1")("GET", "/api/edal/verify"));
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    assert.equal(v.erased, 5);
    assert.equal(v.checkpoints[0].holds, true);
    const cli = await run(["src/edal-verify.js", "--district", ID.d1], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(cli.code, 0, cli.out); assert.match(cli.out, /5 payload\(s\) erased/);
  });
});
