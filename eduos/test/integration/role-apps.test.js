// EduOS 32.4.0 mobile role-app back end against real PostgreSQL, as the
// non-owner runtime role: transport (no location data, guardian isolation,
// driver scope), Christie (hint-first, answers never sent to pupils, staff
// review scope) and the Comms Hub (policy-checked threads, receipts,
// moderation, notifications). RLS is also checked directly as eduos_app.
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const DRIVER = "a0000000-0000-4000-8000-0000000000d1", DRIVER2 = "a0000000-0000-4000-8000-0000000000d2";

describe("EduOS 32.4.0 role apps against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, appDb, s = {};
  const as = name => client(server.base, s[name]);
  const asRole = async (role, user, school, sql, params = []) => {
    await appDb.query("BEGIN");
    try {
      await appDb.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id',$4,true)", [ID.d1, user, role, school ?? ""]);
      return (await appDb.query(sql, params)).rows;
    } finally { await appDb.query("ROLLBACK"); }
  };
  // True if any key is "answer" or any text value states the answer as a word.
  const leaks = (v, ans) => {
    if (Array.isArray(v)) return v.some(x => leaks(x, ans));
    if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => k === "answer" || leaks(x, ans));
    return typeof v === "string" && !/^\d{4}-\d\d-\d\dT/.test(v) && !/^[0-9a-f-]{36}$/.test(v) && new RegExp(`(^|[^0-9a-f-])${ans}([^0-9a-f-]|$)`).test(v);
  };
  const audits = async (type) => (await admin.query("SELECT action,actor_role,resource_id,detail FROM audit_events WHERE resource_type=$1 ORDER BY occurred_at", [type])).rows;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, WEBHOOK_SIGNING_KEY: "w".repeat(40) });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    // 32.4.0 additions to the shared fixture: two drivers (S1, S2) and a roster.
    for (const [id, sub, school] of [[DRIVER, "drv1", ID.s1], [DRIVER2, "drv2", ID.s2]]) {
      await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES($1,$2,$3,$4,$5)", [id, idp.issuer, sub, `Driver ${sub}`, `${sub}@d1.test`]);
      await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,'driver',true)", [id, ID.d1, school]);
    }
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5)", [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
    appDb = new pg.Client(db.appUrl); await appDb.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "p2", "t1", "pu", "pa", "pb", "drv1", "drv2", "supt2"]) {
      s[name] = await login(server.base, idp, name, { email_verified: true, ...(name.startsWith("drv") ? { email: `${name}@d1.test` } : {}) });
      assert.ok(s[name].cookie, `${name} signed in: ${JSON.stringify(s[name])}`);
    }
  });
  after(async () => {
    if (process.env.EDUOS_IT_DEBUG) console.log(server?.log().split("\n").filter(l => /fail|error/i.test(l)).join("\n"));
    await server?.stop(); await appDb?.end(); await admin?.end(); await idp?.close(); await db?.drop?.();
  });

  let route, run1;
  it("transport: principal builds a route; only the assigned driver runs it", async () => {
    const created = await as("p1")("POST", "/api/transport/routes", { name: "Route 1", busLabel: "Bus 1", direction: "am", driverUserId: DRIVER,
      stops: [{ name: "Oak & 1st", time: "07:30" }, { name: "School", time: "07:55", isSchool: true }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    route = created.body.data;
    assert.equal((await as("p1")("POST", "/api/transport/routes", { name: "Bad", busLabel: "B", direction: "am", driverUserId: DRIVER2, stops: [{ name: "x" }] })).status, 400, "driver from another school");
    for (const who of ["t1", "pa", "pu", "drv1"]) assert.equal((await as(who)("POST", "/api/transport/routes", { name: "X", busLabel: "X", direction: "pm", stops: [{ name: "x" }] })).status, 403, who);
    const list = await as("p1")("GET", "/api/transport/routes");
    const stops = list.body.data[0].stops;
    for (const st of [ID.alice, ID.bob]) assert.equal((await as("p1")("POST", `/api/transport/routes/${route.id}/riders`, { studentId: st, stopId: stops[0].id })).status, 201);
    assert.equal((await as("p1")("POST", `/api/transport/routes/${route.id}/riders`, { studentId: ID.carol, stopId: stops[0].id })).status, 404, "student from S2");
    route.stops = stops;

    const manifest = await as("drv1")("GET", "/api/transport/today");
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.data.routes.length, 1);
    assert.equal(manifest.body.data.routes[0].counts.riders, 2);
    assert.equal((await as("drv2")("GET", "/api/transport/today")).body.data.routes.length, 0, "other school's driver sees nothing");
    assert.equal((await as("drv2")("POST", "/api/transport/runs", { routeId: route.id })).status, 404);
    const r = await as("drv1")("POST", "/api/transport/runs", { routeId: route.id });
    assert.equal(r.status, 201); run1 = r.body.data;
    assert.equal((await as("drv1")("POST", "/api/transport/runs", { routeId: route.id })).status, 200, "idempotent");
  });

  it("transport: check-ins accept no location data and notify only that child's guardian", async () => {
    const path = `/api/transport/runs/${run1.id}/checkins`;
    for (const k of ["lat", "gps", "location", "longitude"])
      assert.deepEqual((await as("drv1")("POST", path, { studentId: ID.alice, stopId: route.stops[0].id, event: "boarded", [k]: 1 })).body, { error: "location_not_accepted" });
    assert.equal((await as("drv2")("POST", path, { studentId: ID.alice, stopId: route.stops[0].id, event: "boarded" })).status, 404, "RLS hides other school's run");
    assert.equal((await as("pa")("POST", path, { studentId: ID.alice, stopId: route.stops[0].id, event: "boarded" })).status, 403);
    assert.equal((await as("drv1")("POST", path, { studentId: ID.carol, stopId: route.stops[0].id, event: "boarded" })).status, 404, "not on route");
    assert.equal((await as("drv1")("POST", path, { studentId: ID.alice, stopId: route.stops[0].id, event: "boarded" })).status, 201);
    assert.equal((await as("drv1")("POST", path, { studentId: ID.bob, stopId: route.stops[0].id, event: "not_riding" })).status, 201);
    // No column anywhere in the transport schema can hold a position.
    const cols = (await admin.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_name LIKE 'transport_%' AND column_name ~* '(lat|lng|lon|geo|gps|coord|position|location)'`)).rows;
    assert.deepEqual(cols, []);

    const pa = (await as("pa")("GET", "/api/transport/today")).body.data;
    assert.deepEqual(pa.riders.map(k => k.id), [ID.alice], "guardian sees only their child");
    assert.equal(pa.riders[0].status, "boarded");
    const pb = (await as("pb")("GET", "/api/transport/today")).body.data;
    assert.deepEqual(pb.riders.map(k => [k.id, k.status]), [[ID.bob, "not_riding"]]);
    const t1 = (await as("t1")("GET", "/api/transport/today")).body.data;
    assert.deepEqual(t1.riders.map(k => k.id), [ID.alice], "teacher sees roster riders only");
    assert.equal((await as("p2")("GET", "/api/transport/today")).body.data.routes.length, 0);
    assert.equal((await as("supt2")("GET", "/api/transport/today")).body.data.routes.length, 0);

    const notes = (await as("pa")("GET", "/api/notifications")).body.data.items;
    assert.ok(notes.some(n => n.kind === "transport" && /Alice boarded Bus 1/.test(n.title)), JSON.stringify(notes));
    assert.ok(!(await as("pa")("GET", "/api/notifications")).body.data.items.some(n => /Bob/.test(n.title)));

    // RLS directly: a parent cannot read another family's check-ins; nobody can edit history.
    assert.equal((await asRole("parent", USERS.pa[0], ID.s1, "SELECT student_id FROM transport_checkins")).length, 1);
    await assert.rejects(asRole("driver", DRIVER, ID.s1, "UPDATE transport_checkins SET event='alighted'"));
    await assert.rejects(asRole("driver", DRIVER2, ID.s2, `INSERT INTO transport_checkins(district_id,school_id,run_id,student_id,stop_id,event,recorded_by) VALUES($1,$2,$3,$4,$5,'boarded',$6)`,
      [ID.d1, ID.s2, run1.id, ID.alice, route.stops[0].id, DRIVER2]));

    const done = await as("drv1")("POST", `/api/transport/runs/${run1.id}/complete`, {});
    assert.equal(done.status, 409, "Alice still on board");
    assert.equal((await as("drv1")("POST", path, { studentId: ID.alice, stopId: route.stops[1].id, event: "alighted" })).status, 201);
    assert.equal((await as("drv1")("POST", `/api/transport/runs/${run1.id}/complete`, {})).status, 200);
    assert.ok((await audits("transport_checkin")).length >= 3);
  });

  it("transport: direct runtime-role check-ins must match the run's route, stops and timing (audit 37.4.0 item 4)", async () => {
    // Bypasses the API and inserts as the runtime role with the driver's context,
    // so only the database policies stand between the statement and the table.
    const insert = (runId, student, stop, observed = null) => asRole("driver", DRIVER, ID.s1,
      `INSERT INTO transport_checkins(district_id,school_id,run_id,student_id,stop_id,event,recorded_by,observed_at,queued)
       VALUES($1,$2,$3,$4,$5,'boarded',$6,$7,$8) RETURNING id`,
      [ID.d1, ID.s1, runId, student, stop, DRIVER, observed, observed !== null]);
    const rls = { message: /row-level security/ };

    // run1 is completed: only an offline check-in observed during the run is accepted.
    const t = (await admin.query("SELECT started_at, completed_at, started_at + (completed_at - started_at) / 2 AS mid FROM transport_runs WHERE id=$1", [run1.id])).rows[0];
    assert.ok(t.completed_at, "run1 completed in the previous test");
    await assert.rejects(insert(run1.id, ID.alice, route.stops[0].id), rls, "completed run, not queued");
    assert.equal((await insert(run1.id, ID.alice, route.stops[0].id, t.mid)).length, 1, "queued during the run");
    assert.equal((await insert(run1.id, ID.alice, route.stops[0].id, t.completed_at)).length, 1, "queued exactly at completion");
    await assert.rejects(insert(run1.id, ID.alice, route.stops[0].id, new Date(t.started_at.getTime() - 1000)), rls, "queued before the run started");
    await assert.rejects(insert(run1.id, ID.alice, route.stops[0].id, new Date(t.completed_at.getTime() + 1000)), rls, "queued after the run completed");

    // A second route for the same driver, with its own stop and only Alice riding.
    const created = await as("p1")("POST", "/api/transport/routes", { name: "Route 2", busLabel: "Bus 2", direction: "pm", driverUserId: DRIVER,
      stops: [{ name: "Elm & 9th", time: "15:30" }, { name: "School", time: "15:05", isSchool: true }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const route2 = created.body.data;
    const stops2 = (await as("p1")("GET", "/api/transport/routes")).body.data.find(r => r.id === route2.id).stops;
    assert.equal((await as("p1")("POST", `/api/transport/routes/${route2.id}/riders`, { studentId: ID.alice, stopId: stops2[0].id })).status, 201);
    const run2 = await as("drv1")("POST", "/api/transport/runs", { routeId: route2.id });
    assert.equal(run2.status, 201, JSON.stringify(run2.body));

    assert.equal((await insert(run2.body.data.id, ID.alice, stops2[0].id)).length, 1, "rider on route, stop on route, run in progress");
    await assert.rejects(insert(run2.body.data.id, ID.bob, stops2[0].id), rls, "student not riding this route");
    await assert.rejects(insert(run2.body.data.id, ID.alice, route.stops[0].id), rls, "stop belongs to another route");
    await assert.rejects(insert(run2.body.data.id, ID.carol, stops2[0].id), "student from another school");

    // The API path is unchanged: a normal driver check-in still succeeds.
    assert.equal((await as("drv1")("POST", `/api/transport/runs/${run2.body.data.id}/checkins`, { studentId: ID.alice, stopId: stops2[0].id, event: "boarded" })).status, 201);
    assert.equal((await as("drv1")("POST", `/api/transport/runs/${run2.body.data.id}/checkins`, { studentId: ID.alice, stopId: stops2[1].id, event: "alighted" })).status, 201);
    assert.equal((await as("drv1")("POST", `/api/transport/runs/${run2.body.data.id}/complete`, {})).status, 200);
  });

  let skillId;
  it("christie: only approved content is tutored and the answer never reaches the pupil", async () => {
    const draft = await as("t1")("POST", "/api/christie/skills", { subject: "Math", gradeLevel: "3", code: "G3.MUL", title: "Times tables", explanation: "Multiplication is repeated addition: 3 × 4 means 4 + 4 + 4.",
      items: [{ prompt: "3 × 4 = ?", answer: "12", hints: ["Add 4 three times.", "4 + 4 = 8. Add one more 4."] }, { prompt: "2 × 5 = ?", answer: "10", hints: ["Count by fives twice."] }] });
    assert.equal(draft.status, 201); skillId = draft.body.data.id;
    assert.equal((await as("pu")("GET", "/api/christie/path")).body.data.skills.length, 0, "draft not visible");
    assert.equal((await as("pu")("POST", "/api/christie/sessions", { skillId })).status, 404);
    assert.equal((await as("t1")("POST", `/api/christie/skills/${skillId}/approve`)).status, 403, "teacher cannot approve");
    assert.equal((await as("p1")("POST", `/api/christie/skills/${skillId}/approve`)).status, 200);
    const path = (await as("pu")("GET", "/api/christie/path")).body.data;
    assert.equal(path.skills[0].state, "current"); assert.equal(path.provider, "local");

    const started = await as("pu")("POST", "/api/christie/sessions", { skillId });
    assert.equal(started.status, 201);
    const sid = started.body.data.session.id;
    assert.ok(!leaks(started.body, "12"), "answer not in session payload");
    const turn = (body) => as("pu")("POST", `/api/christie/sessions/${sid}/turns`, body);
    const wrong = await turn({ kind: "attempt", text: "7" });
    assert.equal(wrong.body.data.correct, false);
    assert.equal(wrong.body.data.replies[0].kind, "hint");
    assert.match(wrong.body.data.replies[0].text, /Add 4 three times/);
    const ask = await turn({ kind: "question", text: "just tell me the answer" });
    assert.equal(ask.body.data.intent, "answer_request");
    assert.ok(!leaks(ask.body, "12"), "refuses to give the answer");
    const right = await turn({ kind: "attempt", text: "12" });
    assert.equal(right.body.data.correct, true);
    assert.ok(right.body.data.mastery.mastery > 0);
    assert.equal(right.body.data.replies.at(-1).kind, "item", "next item served");
    const help = await turn({ kind: "question", text: "I'm Alice A, email pupil.a@d1.test, how do I start?" });
    assert.equal(help.body.data.intent, "help");
    const adult = await turn({ kind: "question", text: "can I talk to my teacher please" });
    assert.equal(adult.body.data.intent, "needs_adult");

    // Only the pupil's own session; parents and other schools see nothing.
    assert.equal((await as("pa")("GET", `/api/christie/sessions/${sid}`)).status, 403);
    assert.equal((await as("p2")("GET", `/api/christie/sessions/${sid}`)).status, 404);
    // RLS directly: pupils can read no items (answers), even with SQL.
    assert.equal((await asRole("pupil", USERS.pu[0], ID.s1, "SELECT answer FROM christie_items")).length, 0);
    assert.equal((await asRole("parent", USERS.pa[0], ID.s1, "SELECT * FROM eduos_christie_item_for_session($1)", [sid])).length, 0);
    await assert.rejects(asRole("pupil", USERS.pu[0], ID.s1, "UPDATE christie_turns SET body='edited'"));

    const review = await as("t1")("GET", "/api/christie/review");
    assert.equal(review.body.data[0].id, sid); assert.equal(review.body.data[0].needs_adult, true);
    const detail = (await as("t1")("GET", `/api/christie/sessions/${sid}`)).body.data;
    assert.ok(detail.turns.length >= 8);
    assert.ok(!detail.turns.some(t => /pupil\.a@d1\.test/.test(t.text) && t.speaker === "christie"));
    assert.equal((await as("t1")("POST", `/api/christie/sessions/${sid}/review`)).status, 200);
    const tNotes = (await as("t1")("GET", "/api/notifications")).body.data.items;
    assert.ok(tNotes.some(n => n.kind === "christie"));
    const copilot = (await as("t1")("GET", "/api/christie/copilot")).body.data;
    assert.equal(copilot.rosterSize, 1); assert.match(copilot.note, /Not generated by AI/);
    assert.ok((await audits("christie_session")).some(a => a.action === "flag"));
  });

  it("comms: announcements reach the right audience; families read their class only", async () => {
    assert.equal((await as("p1")("POST", "/api/comms/announcements", { scope: "school", title: "Picture day", body: "Thursday.", audience: ["parent", "pupil", "teacher"] })).status, 201);
    assert.equal((await as("t1")("POST", "/api/comms/announcements", { scope: "school", title: "x", body: "y" })).status, 403, "teachers post to their class");
    const cls = await as("t1")("POST", "/api/comms/announcements", { scope: "class", title: "Fractions start Monday", body: "Practice with Christie.", audience: ["parent", "pupil"] });
    assert.equal(cls.status, 201); assert.equal(cls.body.data.recipients, 3, "Alice, and her two linked guardians (pa, tp)");
    for (const who of ["pa", "pb", "pu", "pa"]) assert.equal((await as(who)("POST", "/api/comms/announcements", { scope: "school", title: "x", body: "y" })).status, 403);
    const titles = async who => (await as(who)("GET", "/api/comms/announcements")).body.data.map(a => a.title).sort();
    assert.deepEqual(await titles("pa"), ["Fractions start Monday", "Picture day"]);
    assert.deepEqual(await titles("pb"), ["Picture day"], "Bob is not on the class roster");
    assert.deepEqual(await titles("p2"), [], "other school");
    assert.deepEqual(await titles("drv1"), [], "driver not in audience");
    const id = (await as("pa")("GET", "/api/comms/announcements")).body.data[0].id;
    assert.equal((await as("pa")("POST", `/api/comms/announcements/${id}/read`)).status, 200);
  });

  let thread;
  it("comms: threads follow policy (no pupil DMs), carry read receipts and are moderated", async () => {
    assert.equal((await as("pu")("GET", "/api/comms/threads")).body.policy, "students_read_announcements_only");
    assert.equal((await as("pu")("POST", "/api/comms/threads", { kind: "family", subject: "hi", studentId: ID.alice, participantIds: [USERS.t1[0]], body: "hello" })).status, 403);
    assert.equal((await as("pu")("GET", "/api/comms/contacts")).status, 403);
    const contacts = (await as("pa")("GET", "/api/comms/contacts")).body.data;
    assert.ok(contacts.every(c => c.student_id === ID.alice));
    assert.ok(contacts.some(c => c.user_id === USERS.t1[0]));
    assert.equal((await as("pa")("POST", "/api/comms/threads", { kind: "family", subject: "x", studentId: ID.bob, participantIds: [USERS.t1[0]], body: "x" })).status, 403, "not my child");
    assert.equal((await as("pa")("POST", "/api/comms/threads", { kind: "family", subject: "x", studentId: ID.alice, participantIds: [USERS.pb[0]], body: "x" })).status, 403, "no parent-to-parent");
    assert.equal((await as("pa")("POST", "/api/comms/threads", { kind: "family", subject: "x", studentId: ID.alice, participantIds: [USERS.pu[0]], body: "x" })).status, 403, "no pupils in threads");
    assert.equal((await as("pa")("POST", "/api/comms/threads", { kind: "staff", subject: "x", participantIds: [USERS.t1[0]], body: "x" })).status, 403);
    const made = await as("pa")("POST", "/api/comms/threads", { kind: "family", subject: "Alice's reading", studentId: ID.alice, participantIds: [USERS.t1[0]], body: "How is Alice doing?" });
    assert.equal(made.status, 201); thread = made.body.data.id;
    assert.equal((await as("t1")("GET", "/api/comms/threads")).body.data[0].unread, 1);
    const opened = (await as("t1")("GET", `/api/comms/threads/${thread}`)).body.data;
    assert.equal(opened.messages.length, 1);
    assert.equal((await as("t1")("POST", `/api/comms/threads/${thread}/messages`, { body: "Great! She reads every day." })).status, 201);
    const seen = (await as("pa")("GET", `/api/comms/threads/${thread}`)).body.data;
    assert.equal(seen.messages[0].read_by[0].userId, USERS.t1[0], "read receipt for the guardian's message");
    for (const who of ["pb", "p2", "drv1"]) assert.equal((await as(who)("GET", `/api/comms/threads/${thread}`)).status, 404, who);
    // RLS directly: a non-participant parent sees no messages.
    assert.equal((await asRole("parent", USERS.pb[0], ID.s1, "SELECT body FROM comms_messages")).length, 0);
    await assert.rejects(asRole("parent", USERS.pa[0], ID.s1, "UPDATE comms_messages SET body='edited'"));

    // Driver ↔ principal staff thread.
    assert.equal((await as("drv1")("POST", "/api/comms/threads", { kind: "staff", subject: "Bus late", participantIds: [USERS.p1[0]], body: "Ten minutes late." })).status, 201);
    assert.equal((await as("drv1")("POST", "/api/comms/threads", { kind: "family", subject: "x", studentId: ID.alice, participantIds: [USERS.pa[0]], body: "x" })).status, 403);

    // Moderation: report → principal hides → lock.
    const msgId = seen.messages[1].id;
    assert.equal((await as("pa")("POST", `/api/comms/messages/${msgId}/report`, { reason: "Testing moderation" })).status, 201);
    assert.equal((await as("t1")("GET", "/api/comms/reports")).status, 403);
    const reports = (await as("p1")("GET", "/api/comms/reports")).body.data;
    assert.equal(reports.length, 1);
    assert.equal((await as("p2")("GET", "/api/comms/reports")).body.data.length, 0);
    assert.equal((await as("p1")("POST", `/api/comms/reports/${reports[0].id}/resolve`, { action: "hide", reason: "Demo hide" })).status, 200);
    const after = (await as("pa")("GET", `/api/comms/threads/${thread}`)).body.data;
    assert.equal(after.messages[1].body, null); assert.equal(after.messages[1].hidden, true);
    assert.equal((await as("p1")("POST", `/api/comms/threads/${thread}/lock`, { reason: "Demo lock" })).status, 200);
    assert.equal((await as("pa")("POST", `/api/comms/threads/${thread}/messages`, { body: "more" })).status, 409);
    assert.ok((await audits("comms_message")).some(a => a.action === "moderate"));
  });

  it("notifications: in-app delivered, external channels off, marking read is per-user; FERPA export includes the new data", async () => {
    const n = (await as("pa")("GET", "/api/notifications")).body.data;
    assert.ok(n.unread > 0);
    assert.equal((await as("pa")("POST", "/api/notifications/read", {})).status, 200);
    assert.equal((await as("pa")("GET", "/api/notifications")).body.data.unread, 0);
    const ext = (await admin.query("SELECT count(*)::int AS n FROM notification_outbox WHERE channel<>'in_app'")).rows[0].n;
    assert.equal(ext, 0, "no external rows when adapters are off");
    await assert.rejects(asRole("parent", USERS.pa[0], ID.s1, "UPDATE notification_outbox SET title='x'"));
    // The dispatcher (owner role) processes pending external rows with the dry-run adapter: nothing is sent.
    await admin.query(`INSERT INTO notification_outbox(district_id,recipient_user_id,channel,kind,title,status) VALUES($1,$2,'email','message',$3,'pending')`, [ID.d1, USERS.pa[0], "generic"]);
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, WEBHOOK_SIGNING_KEY: "w".repeat(40), NOTIFY_EMAIL_ADAPTER: "log" });
    const dispatched = await run(["src/notify-dispatch.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(dispatched.code, 0, dispatched.out);
    assert.match(dispatched.out, /dry run, nothing sent/);
    assert.match(dispatched.out, /1 handled/);
    assert.equal((await admin.query("SELECT status FROM notification_outbox WHERE channel='email'")).rows[0].status, "skipped");
    const exp = await as("p1")("POST", `/api/students/${ID.alice}/records-export`);
    assert.equal(exp.status, 200);
    for (const k of ["transportCheckins", "christieSessions", "christieTurns", "skillMastery", "commsThreads"]) assert.ok(exp.body[k]?.length > 0, k);
  });

  it("FERPA deletion purges the learner's transport, Christie, mastery and family-thread data", async () => {
    const del = await as("supt1")("POST", `/api/students/${ID.alice}/records-delete`, { confirmLocalStudentNumber: "S1-A", reason: "Integration test of the 32.4.0 purge coverage" });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    for (const t of ["transport_checkins", "transport_rider_assignments", "christie_sessions", "christie_turns", "student_skill_mastery"])
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${t} WHERE student_id=$1`, [ID.alice])).rows[0].n, 0, t);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM comms_threads WHERE student_id=$1", [ID.alice])).rows[0].n, 0);
  });
});
