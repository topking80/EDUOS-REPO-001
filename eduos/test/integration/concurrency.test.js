// SEC-07 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §6, docs/CONCURRENCY.md):
// the same request sent many times at once does its work exactly once.
// Every burst goes out together (Promise.all over the same keep-alive-free
// fetches), so the requests reach the server in parallel and race inside
// PostgreSQL, as a double-click, a retrying client or a scripted attack would.
// No burst may produce a 500: the losers get a clear 4xx or the same result.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const STD = "e1000000-0000-4000-8000-0000000000a7";
const N = 8;
const key = label => `${label}-${crypto.randomUUID()}`;
const future = h => new Date(Date.now() + h * 3600_000).toISOString();
const burst = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const statuses = rs => rs.map(r => r.status).sort((a, b) => a - b);
const noServerErrors = (rs, what) => assert.ok(rs.every(r => r.status < 500), `${what}: ${JSON.stringify(rs.filter(r => r.status >= 500).map(r => r.body))}`);

describe("SEC-07: concurrent requests do their work once", { skip }, () => {
  let db, idp, server, admin, s = {};
  const as = name => client(server.base, s[name]);
  const post = (path, body) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const count = async (sql, params) => Number((await admin.query(sql, params)).rows[0].n);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, DEVICE_SIGN_IN_ENABLED: "true" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("SELECT set_config('app.district_id',$1,false)", [ID.d1]);
    await admin.query(`INSERT INTO learning_standards(id,district_id,framework,code,subject,grade_level,description) VALUES ($1,$2,'CCSS','3.NF.A.1','Math','3','Summary: unit fractions')`, [STD, ID.d1]);
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5)", [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "t1", "pu", "pa", "pb"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => {
    if (process.env.EDUOS_IT_DEBUG) console.log(server?.log().split("\n").filter(l => /error|fail/i.test(l)).join("\n"));
    await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop?.();
  });

  describe("quiz attempts", () => {
    let quiz, attemptId;
    before(async () => {
      const course = (await as("t1")("POST", "/api/learning/courses", { title: "Fractions", subject: "Math", gradeLevel: "3" })).body.data;
      assert.equal((await as("t1")("POST", `/api/learning/courses/${course.id}/enrollments`, { studentIds: [ID.alice] })).status, 200);
      const made = await as("t1")("POST", "/api/learning/assignments", { courseId: course.id, kind: "quiz", title: "Quick check", maxAttempts: 2, retakePolicy: "highest",
        items: [{ kind: "mc", prompt: "Which is one half?", choices: ["1/3", "1/2"], key: { index: 1 }, standardId: STD }] });
      assert.equal(made.status, 201, JSON.stringify(made.body)); quiz = made.body.data;
    });

    it(`${N} starts at once open one attempt; the rest resume it`, async () => {
      const rs = await burst(N, () => as("pu")("POST", `/api/learning/quizzes/${quiz.id}/attempts`));
      noServerErrors(rs, "start");
      assert.equal(rs.filter(r => r.status === 201).length, 1, JSON.stringify(statuses(rs)));
      assert.ok(rs.every(r => [200, 201].includes(r.status)), JSON.stringify(rs.map(r => r.body)));
      const ids = new Set(rs.map(r => r.body.data.attempt.id));
      assert.equal(ids.size, 1, "every caller got the same attempt");
      attemptId = [...ids][0];
      assert.equal(await count("SELECT count(*) AS n FROM quiz_attempts WHERE assignment_id=$1", [quiz.id]), 1);
    });

    it(`${N} submits at once score it once and record mastery evidence once`, async () => {
      const item = (await as("pu")("GET", `/api/learning/attempts/${attemptId}`)).body.data.items[0];
      assert.equal((await as("pu")("PUT", `/api/learning/attempts/${attemptId}/responses/${item.id}`, { response: "1" })).status, 200);
      const rs = await burst(N, () => as("pu")("POST", `/api/learning/attempts/${attemptId}/submit`));
      noServerErrors(rs, "submit");
      assert.deepEqual(statuses(rs), [200, ...Array(N - 1).fill(409)], JSON.stringify(rs.map(r => r.body)));
      assert.ok(rs.filter(r => r.status === 409).every(r => r.body.error === "attempt_not_open"));
      const row = (await admin.query("SELECT status, submitted_at, auto_points FROM quiz_attempts WHERE id=$1", [attemptId])).rows[0];
      assert.equal(row.status, "scored"); assert.equal(Number(row.auto_points), 1);
      assert.equal(await count("SELECT count(*) AS n FROM mastery_evidence WHERE source='quiz' AND source_ref=$1", [attemptId]), 1, "one piece of evidence");
      assert.equal(await count("SELECT count(*) AS n FROM audit_events WHERE action='submit' AND resource_type='quiz_attempt' AND resource_id=$1", [attemptId]), 1);
    });

    it(`the last attempt can't be taken twice by ${N} starts at once`, async () => {
      const rs = await burst(N, () => as("pu")("POST", `/api/learning/quizzes/${quiz.id}/attempts`));
      noServerErrors(rs, "second start");
      assert.equal(rs.filter(r => r.status === 201).length, 1);
      const second = rs.find(r => r.status === 201).body.data.attempt.id;
      const subs = await burst(N, () => as("pu")("POST", `/api/learning/attempts/${second}/submit`));
      noServerErrors(subs, "second submit");
      assert.equal(subs.filter(r => r.status === 200).length, 1);
      const third = await burst(N, () => as("pu")("POST", `/api/learning/quizzes/${quiz.id}/attempts`));
      noServerErrors(third, "no attempts left");
      assert.ok(third.every(r => r.status === 409 && r.body.error === "no_attempts_left"), JSON.stringify(third.map(r => r.body)));
      assert.equal(await count("SELECT count(*) AS n FROM quiz_attempts WHERE assignment_id=$1", [quiz.id]), 2, "max attempts holds");
    });
  });

  describe("tickets and payments", () => {
    let eventId, freeType, paidType;
    const sold = async id => Number((await admin.query("SELECT sold_count FROM event_ticket_types WHERE id=$1", [id])).rows[0].sold_count);
    before(async () => {
      assert.equal((await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["sandbox"], defaultMethod: "sandbox" })).status, 200);
      assert.equal((await as("supt1")("PUT", "/api/commerce/settings", { enabled: true })).status, 200);
      const act = (await as("p1")("POST", "/api/activities", { kind: "sport", title: "Falcons", status: "published" })).body.data;
      eventId = (await as("p1")("POST", `/api/activities/${act.id}/events`, { title: "Home game", startsAt: future(48), endsAt: future(51), venue: "Field", publish: true })).body.data.id;
      freeType = (await as("p1")("POST", `/api/events/${eventId}/ticket-types`, { name: "Student", priceCents: 0, capacity: 3, salesOpen: true })).body.data.id;
      paidType = (await as("p1")("POST", `/api/events/${eventId}/ticket-types`, { name: "Adult", priceCents: 500, capacity: 10, salesOpen: true })).body.data.id;
    });

    it(`${N} buyers at once never oversell: capacity 3 sells exactly 3`, async () => {
      const rs = await burst(N, i => as(i % 2 ? "pa" : "pb")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: freeType, quantity: 1, idempotencyKey: key(`free${i}`) }));
      noServerErrors(rs, "buy");
      assert.equal(rs.filter(r => r.status === 201).length, 3, JSON.stringify(statuses(rs)));
      assert.ok(rs.filter(r => r.status !== 201).every(r => r.status === 409 && r.body.error === "ticket_capacity_exceeded"));
      assert.equal(await sold(freeType), 3);
      assert.equal(await count("SELECT count(*) AS n FROM event_tickets t JOIN event_ticket_orders o ON o.id=t.order_id WHERE o.ticket_type_id=$1", [freeType]), 3);
    });

    it(`one order sent ${N} times at once with the same key is one order and one hold`, async () => {
      const k = key("same");
      const rs = await burst(N, () => as("pa")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: paidType, quantity: 2, idempotencyKey: k }));
      noServerErrors(rs, "same key");
      assert.ok(rs.every(r => r.status === 201), JSON.stringify(rs.map(r => r.body)));
      assert.equal(new Set(rs.map(r => r.body.data.payment.id)).size, 1, "one payment");
      assert.equal(rs.filter(r => !r.body.data.replayed).length, 1, "the rest are replays");
      assert.equal(await count("SELECT count(*) AS n FROM event_ticket_orders WHERE idempotency_key=$1", [k]), 1);
      assert.equal(await sold(paidType), 2, "seats held once");
    });

    it(`a payment confirmed ${N} times at once settles once and issues its tickets once`, async () => {
      const r = await as("pa")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: paidType, quantity: 1, idempotencyKey: key("pay") });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const pid = r.body.data.payment.id;
      const edal = () => count("SELECT count(*) AS n FROM edal_entries WHERE district_id=$1 AND kind='commerce_settlement'", [ID.d1]);
      const edalBefore = await edal();
      const rs = await burst(N, () => as("pa")("POST", `/api/commerce/payments/${pid}/confirm`, { testOutcome: "sandbox_success" }));
      noServerErrors(rs, "confirm");
      assert.deepEqual(statuses(rs), [200, ...Array(N - 1).fill(409)], JSON.stringify(rs.map(r => r.body)));
      assert.equal(await count("SELECT count(*) AS n FROM commerce_ledger_entries WHERE payment_id=$1 AND entry_kind='settlement' AND line='gross'", [pid]), 1, "one settlement");
      assert.equal(await count("SELECT count(*) AS n FROM event_tickets t JOIN event_ticket_orders o ON o.id=t.order_id JOIN commerce_payments p ON p.ticket_order_id=o.id WHERE p.id=$1", [pid]), 1, "one ticket");
      assert.equal(await edal() - edalBefore, 1, "one EDAL settlement entry");
    });

    it(`a ticket scanned ${N} times at once admits once`, async () => {
      const r = await as("pb")("POST", `/api/events/${eventId}/tickets`, { ticketTypeId: paidType, quantity: 1, idempotencyKey: key("scan") });
      const confirmed = await as("pb")("POST", `/api/commerce/payments/${r.body.data.payment.id}/confirm`, { testOutcome: "sandbox_success" });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      const code = confirmed.body.data.tickets[0].code;
      const rs = await burst(N, () => as("p1")("POST", `/api/events/${eventId}/check-in`, { ticketCode: code }));
      noServerErrors(rs, "check-in");
      assert.deepEqual(statuses(rs), [200, ...Array(N - 1).fill(409)], JSON.stringify(rs.map(r => r.body)));
    });
  });

  describe("one-time codes", () => {
    it(`a guardian invitation accepted ${N} times at once links once`, async () => {
      const inv = await as("p1")("POST", "/api/guardian-invitations", { studentId: ID.alice, email: "Parent.Bob@D1.test" });
      assert.equal(inv.status, 201, JSON.stringify(inv.body));
      const token = decodeURIComponent(inv.body.invitationUrl.split("guardianInvite=")[1]);
      const rs = await burst(N, () => as("pb")("POST", "/api/guardian-invitations/accept", { token }));
      noServerErrors(rs, "accept");
      assert.deepEqual(statuses(rs), [200, ...Array(N - 1).fill(409)], JSON.stringify(rs.map(r => r.body)));
      assert.equal(await count("SELECT count(*) AS n FROM student_user_links WHERE student_id=$1 AND user_id=$2", [ID.alice, USERS.pb[0]]), 1);
    });

    it(`a device code approved and redeemed ${N} times at once gives one session`, async () => {
      const start = await post("/auth/device/code", { clientKind: "android_tv", deviceLabel: "Gym screen" });
      assert.equal(start.status, 200, JSON.stringify(start.body));
      const approvals = await burst(N, () => as("pa")("POST", "/api/device-sign-in/approve", { userCode: start.body.userCode }));
      noServerErrors(approvals, "approve");
      assert.equal(approvals.filter(r => r.status === 200).length, 1, JSON.stringify(statuses(approvals)));
      await admin.query("UPDATE device_sign_in_requests SET last_polled_at = NULL");
      const before = await count("SELECT count(*) AS n FROM sessions WHERE user_id=$1", [USERS.pa[0]]);
      const rs = await burst(N, () => post("/auth/device/token", { deviceCode: start.body.deviceCode }));
      noServerErrors(rs, "redeem");
      assert.equal(rs.filter(r => r.status === 200).length, 1, JSON.stringify(rs.map(r => r.body)));
      assert.ok(rs.filter(r => r.status !== 200).every(r => r.body.error === "invalid_grant"));
      assert.equal(await count("SELECT count(*) AS n FROM sessions WHERE user_id=$1", [USERS.pa[0]]) - before, 1, "one session");
    });
  });
});
