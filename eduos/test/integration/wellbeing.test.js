// 37.6.0 well-being check-ins and the crisis hook against real PostgreSQL
// (runtime role): off by default, guardian opt-in under the current notice,
// counselor-only reading, crisis words -> 988 + counselor alert + URGENT item
// in the existing counseling queue with no student identifiers, from a
// check-in and from Christie.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("37.6.0 well-being check-ins and crisis hook against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, counselorId, noticeVersion;
  const as = name => client(server.base, s[name]);
  const counselingQueue = async () => (await admin.query("SELECT kind,priority,status,summary,details,created_by,assigned_to FROM school_service_work WHERE domain='counseling' ORDER BY created_at")).rows;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    counselorId = (await admin.query("INSERT INTO users(oidc_issuer,oidc_subject,display_name,email) VALUES($1,'co1','Counselor S1','co1@d1.test') RETURNING id", [idp.issuer])).rows[0].id;
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,'counselor',true)", [counselorId, ID.d1, ID.s1]);
    const co2 = (await admin.query("INSERT INTO users(oidc_issuer,oidc_subject,display_name,email) VALUES($1,'co2','Counselor S2','co2@d1.test') RETURNING id", [idp.issuer])).rows[0].id;
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,'counselor',true)", [co2, ID.d1, ID.s2]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "t1", "pa", "pb", "pu", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    for (const name of ["co1", "co2"]) s[name] = await login(server.base, idp, name, { email_verified: true, email: `${name}@d1.test` });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("check-ins are off by default; only the superintendent sets them; principals and teachers have no access", async () => {
    const st = (await as("pu")("GET", "/api/wellbeing/status")).body.data;
    assert.equal(st.allowed, false);
    assert.equal((await as("pu")("POST", "/api/wellbeing/checkins", { mood: "low" })).status, 403);
    for (const who of ["p1", "t1", "pa"]) assert.equal((await as(who)("GET", "/api/wellbeing/queue")).status, 403, who);
    for (const who of ["p1", "co1"]) assert.equal((await as(who)("PUT", "/api/wellbeing/settings", { enabled: true, notice: "x".repeat(30) })).status, 403, who);
    const def = (await as("supt1")("GET", "/api/wellbeing/settings")).body.data;
    const put = await as("supt1")("PUT", "/api/wellbeing/settings", { enabled: true, notice: def.defaultNotice, retentionDays: 365 });
    assert.equal(put.status, 200);
    noticeVersion = put.body.data.noticeVersion;
    assert.equal((await as("pu")("GET", "/api/wellbeing/status")).body.data.allowed, false, "still needs a guardian opt-in");
  });

  it("a guardian opts in under the notice they read; other families can't", async () => {
    assert.equal((await as("pb")("POST", "/api/wellbeing/consent", { studentId: ID.alice, decision: "opted_in", noticeVersion })).status, 404);
    assert.equal((await as("pa")("POST", "/api/wellbeing/consent", { studentId: ID.alice, decision: "opted_in", noticeVersion: "stale" })).status, 409);
    assert.equal((await as("pa")("POST", "/api/wellbeing/consent", { studentId: ID.alice, decision: "opted_in", noticeVersion })).status, 201);
    const c = (await as("pa")("GET", "/api/wellbeing/consent")).body.data;
    assert.equal(c.children.find(k => k.id === ID.alice).active, true);
    assert.equal((await as("pu")("GET", "/api/wellbeing/status")).body.data.allowed, true);
  });

  it("a check-in asking to talk reaches the counselor and a HIGH item in the counseling queue, without identifiers", async () => {
    const r = await as("pu")("POST", "/api/wellbeing/checkins", { mood: "low", needs: ["talk_to_someone", "sleep"], note: "Tired all week" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.crisis, false);
    const q = (await as("co1")("GET", "/api/wellbeing/queue")).body.data;
    assert.equal(q.now.length, 1);
    assert.equal(q.now[0].note, "Tired all week");
    assert.equal(q.now[0].student.name, "Alice A");
    assert.equal((await as("co2")("GET", "/api/wellbeing/queue")).body.data.now.length, 0, "another school's counselor");
    const [w] = await counselingQueue();
    assert.equal(w.kind, "wellbeing_talk"); assert.equal(w.priority, "high"); assert.equal(w.created_by, counselorId); assert.equal(w.assigned_to, counselorId);
    assert.doesNotMatch(`${w.summary} ${w.details}`, /Alice|Tired/);
    // The existing counseling console shows it to the counselor.
    const ops = await as("co1")("GET", "/api/school-operations/counseling");
    assert.ok(ops.body.data.some(i => i.kind === "wellbeing_talk"));
    // Closing the check-in completes the queue item.
    assert.equal((await as("co1")("POST", `/api/wellbeing/checkins/${q.now[0].id}/actions`, { action: "closed", note: "Met at lunch" })).status, 200);
    assert.equal((await counselingQueue())[0].status, "completed");
    // RLS: a principal and a teacher read no check-ins even straight from SQL.
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      for (const [role, user] of [["principal", USERS.p1[0]], ["teacher", USERS.t1[0]], ["superintendent", USERS.supt1[0]]]) {
        await app.query("BEGIN");
        for (const [k, v] of [["app.district_id", ID.d1], ["app.user_id", user], ["app.role", role], ["app.school_id", role === "superintendent" ? "" : ID.s1]]) await app.query("SELECT set_config($1,$2,true)", [k, v]);
        assert.equal((await app.query("SELECT count(*)::int AS n FROM wellbeing_checkins")).rows[0].n, 0, role);
        await app.query("ROLLBACK");
      }
    } finally { await app.end(); }
  });

  it("crisis words in a check-in: 988 shown, counselor alerted now, URGENT queue item", async () => {
    const r = await as("pu")("POST", "/api/wellbeing/checkins", { mood: "struggling", note: "I don't want to live anymore" });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.crisis, true);
    assert.equal(r.body.data.response.tel, "tel:988");
    assert.equal(r.body.data.alerted, true);
    const n = await admin.query("SELECT title,body FROM notification_outbox WHERE kind='wellbeing' AND recipient_user_id=$1 ORDER BY created_at DESC LIMIT 1", [counselorId]);
    assert.match(n.rows[0].title, /Urgent/);
    assert.doesNotMatch(n.rows[0].body, /live|Alice/);
    const urgent = (await counselingQueue()).filter(w => w.kind === "wellbeing_crisis");
    assert.equal(urgent.length, 1); assert.equal(urgent[0].priority, "urgent");
    assert.doesNotMatch(urgent[0].summary, /Alice|live/);
    const q = (await as("co1")("GET", "/api/wellbeing/queue")).body.data;
    assert.equal(q.alerts.length, 1);
    assert.equal((await as("co1")("POST", `/api/wellbeing/alerts/${q.alerts[0].id}/ack`)).status, 200);
    assert.equal((await counselingQueue()).find(w => w.kind === "wellbeing_crisis").status, "in_progress");
  });

  it("crisis words still reach a human when the learner is not opted in (text not stored)", async () => {
    assert.equal((await as("pa")("POST", "/api/wellbeing/consent", { studentId: ID.alice, decision: "opted_out" })).status, 201);
    const before = (await admin.query("SELECT count(*)::int AS n FROM wellbeing_checkins")).rows[0].n;
    const r = await as("pu")("POST", "/api/wellbeing/checkins", { mood: "nope", note: "I want to kill myself" });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.stored, false);
    assert.equal(r.body.data.response.tel, "tel:988");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM wellbeing_checkins")).rows[0].n, before);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM wellbeing_alerts WHERE checkin_id IS NULL")).rows[0].n, 1);
  });

  it("Christie: crisis words show 988, alert the counselor and flag the session; no tutoring reply", async () => {
    const draft = await as("t1")("POST", "/api/christie/skills", { subject: "Math", gradeLevel: "3", code: "G3.ADD", title: "Adding", explanation: "Adding puts groups together.",
      items: [{ prompt: "2 + 2 = ?", answer: "4", hints: ["Count on from 2."] }] });
    await as("p1")("POST", `/api/christie/skills/${draft.body.data.id}/approve`);
    const sid = (await as("pu")("POST", "/api/christie/sessions", { skillId: draft.body.data.id })).body.data.session.id;
    const alertsBefore = (await admin.query("SELECT count(*)::int AS n FROM wellbeing_alerts WHERE source='christie'")).rows[0].n;
    const t = await as("pu")("POST", `/api/christie/sessions/${sid}/turns`, { kind: "attempt", text: "i want to die" });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.data.intent, "crisis");
    assert.equal(t.body.data.crisis.tel, "tel:988");
    assert.equal(t.body.data.alerted, true);
    assert.match(t.body.data.replies.map(r => r.text).join(" "), /988/);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM wellbeing_alerts WHERE source='christie'")).rows[0].n, alertsBefore + 1);
    assert.equal((await admin.query("SELECT needs_adult FROM christie_sessions WHERE id=$1", [sid])).rows[0].needs_adult, true);
    // An ordinary answer still tutors as before.
    const ok = await as("pu")("POST", `/api/christie/sessions/${sid}/turns`, { kind: "attempt", text: "4" });
    assert.equal(ok.body.data.correct, true);
  });

  it("retention deletes check-ins past the district window but keeps unacknowledged alerts", async () => {
    await admin.query("UPDATE wellbeing_checkins SET created_at=now()-interval '400 days' WHERE crisis=false");
    const r = await run(["src/retention.js"], { ...baseEnv(), DATABASE_URL: db.ownerUrl });
    assert.equal(r.code, 0, r.out);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM wellbeing_checkins WHERE crisis=false")).rows[0].n, 0);
    assert.ok((await admin.query("SELECT count(*)::int AS n FROM wellbeing_alerts WHERE acknowledged_at IS NULL")).rows[0].n >= 1);
  });

  it("FERPA purge removes the learner's well-being records", async () => {
    await admin.query("BEGIN"); await admin.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
    const out = (await admin.query("SELECT eduos_purge_student($1) AS j", [ID.alice])).rows[0].j;
    await admin.query("COMMIT");
    assert.ok(out.wellbeing_checkins >= 1);
    for (const t of ["wellbeing_checkins", "wellbeing_alerts", "wellbeing_consents"])
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${t} WHERE student_id=$1`, [ID.alice])).rows[0].n, 0, t);
  });
});
