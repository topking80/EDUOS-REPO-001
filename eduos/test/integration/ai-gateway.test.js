// Staff AI gateway against real PostgreSQL: off until the superintendent
// enables each use case; only the right roles; the operations brief uses only
// counts within the caller's own scope; budgets; usage kept without prompts;
// districts don't share policy or usage.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("staff AI gateway against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const runAi = (name, usecase, text) => as(name)("POST", "/api/ai/run", { usecase, ...(text ? { text } : {}) });

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // Today's attendance: two marks at S1 (Alice present, Bob absent), one at S2 (Carol tardy).
    // "Today" in each school's time zone, as the app computes it: that needs the
    // district context (without it eduos_school_today() falls back to UTC, and
    // in a US evening that's already tomorrow).
    await admin.query("SELECT set_config('app.district_id', $1, false)", [ID.d1]);
    await admin.query(`INSERT INTO attendance_events(district_id, student_id, event_date, status) VALUES
      ($1,$2,eduos_school_today($5),'present'),($1,$3,eduos_school_today($5),'absent'),($1,$4,eduos_school_today($6),'tardy')`,
      [ID.d1, ID.alice, ID.bob, ID.carol, ID.s1, ID.s2]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "t1", "pa", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("everything is off until the superintendent turns it on", async () => {
    const st = (await as("t1")("GET", "/api/ai/status")).body.data;
    assert.ok(st.usecases.every(u => !u.enabled));
    assert.equal(st.provider, "local");
    assert.equal((await runAi("t1", "lesson_draft", "Fractions")).body.error, "ai_usecase_not_enabled");
  });

  it("only the superintendent sets the policy; principals can read it", async () => {
    assert.equal((await as("p1")("GET", "/api/ai/policy")).body.data.canEdit, false);
    assert.equal((await as("p1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft"], dailyTokenCap: 1000, userDailyTokenCap: 100 })).status, 403);
    assert.equal((await as("t1")("GET", "/api/ai/policy")).status, 403);
    assert.equal((await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["read_all_students"], dailyTokenCap: 1000, userDailyTokenCap: 100 })).status, 400);
    const r = await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "writing_feedback", "ops_brief"], dailyTokenCap: 100000, userDailyTokenCap: 20000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it("each role gets only its use cases; families get none", async () => {
    const lesson = await runAi("t1", "lesson_draft", "Fractions on a number line");
    assert.equal(lesson.status, 200, JSON.stringify(lesson.body));
    assert.match(lesson.body.data.text, /Lesson plan: Fractions on a number line/);
    assert.equal((await runAi("t1", "ops_brief")).body.error, "ai_usecase_not_for_your_role");
    assert.equal((await runAi("pa", "lesson_draft", "Fractions")).body.error, "ai_usecase_not_for_your_role");
    assert.equal((await runAi("t1", "resource_summary", "x".repeat(40))).body.error, "ai_usecase_not_enabled", "not enabled by the district");
    assert.equal((await runAi("t1", "writing_feedback", "short")).status, 400, "input length enforced");
  });

  it("the operations brief sees only counts in the caller's own scope", async () => {
    const p = await runAi("p1", "ops_brief");
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.data.basis.scope, "school");
    assert.deepEqual(p.body.data.basis.attendance, { marked: 2, present: 1, tardy: 0, absent: 1, excused: 0 }, "S1 only");
    const d = await runAi("supt1", "ops_brief");
    assert.equal(d.body.data.basis.scope, "district");
    assert.equal(d.body.data.basis.attendance.marked, 3, "the whole district");
    assert.ok(!JSON.stringify(d.body.data.basis).match(/Alice|Bob|Carol|S1-A/), "no names or student numbers");
  });

  it("usage is kept without the prompt or answer, audited, and counts toward budgets", async () => {
    const cols = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name='ai_usage'")).rows.map(r => r.column_name);
    for (const c of cols) assert.doesNotMatch(c, /prompt|text|answer|response|content/, c);
    const rows = (await admin.query("SELECT usecase, role, provider FROM ai_usage ORDER BY id")).rows;
    assert.deepEqual(rows.map(r => r.usecase), ["lesson_draft", "ops_brief", "ops_brief"]);
    const audited = (await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'ai\\_%'")).rows[0].n;
    assert.equal(audited, 3);
    await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft", "writing_feedback", "ops_brief"], dailyTokenCap: 100000, userDailyTokenCap: 700 });
    let r; for (let i = 0; i < 5 && (!r || r.status === 200); i++) r = await runAi("t1", "lesson_draft", "Volcanoes and plate tectonics");
    assert.equal(r.status, 429); assert.equal(r.body.error, "ai_your_budget_reached");
    await as("supt1")("PUT", "/api/ai/policy", { enabledUsecases: ["lesson_draft"], dailyTokenCap: 10, userDailyTokenCap: 20000 });
    assert.equal((await runAi("p1", "lesson_draft", "Volcanoes")).body.error, "ai_district_budget_reached");
  });

  it("another district has its own policy and sees none of this usage", async () => {
    const other = (await as("supt2")("GET", "/api/ai/policy")).body.data;
    assert.deepEqual(other.policy.enabled_usecases, []);
    assert.deepEqual(other.usage30d, []);
  });
});
