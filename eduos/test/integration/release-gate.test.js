// Release-candidate regression gate, against real PostgreSQL as the non-owner
// runtime role. The items a release must keep that other suites don't already
// pin down end to end:
//   - arrival: only an independent, assigned school staff member receives a
//     student (not the initiator, a driver, an unassigned teacher or another
//     school), every step is in the handoff log and the audit log;
//   - one authoritative attendance event per student per school day, even under
//     concurrent submissions, and a day that began with an arrival handoff is
//     recorded only through it;
//   - emergency notifications reach only active people at the incident's
//     school; queued email/SMS/push is never reported as delivered; failures
//     back off, then show as failed on the leads' board; nothing claims that
//     emergency services were contacted;
//   - the operations event stream ends when its session is signed out,
//     expires or loses its membership, and never carries another district's
//     events;
//   - webhooks: another district can't read, test or disable a subscription.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const DRIVER = "a0000000-0000-4000-8000-0000000000e2";
const OFF_TEACHER = "a0000000-0000-4000-8000-0000000000e3";
const sleep = ms => new Promise(r => setTimeout(r, ms));

describe("release gate against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, env, s = {};
  const as = name => client(server.base, s[name]);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, NOTIFY_EMAIL_ADAPTER: "log", STREAM_SESSION_RECHECK_MS: "1000" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES($1,$2,'drv-gate','Driver Gate','drv-gate@d1.test')", [DRIVER, idp.issuer]);
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,'driver',true)", [DRIVER, ID.d1, ID.s1]);
    // A disabled account that still has an active membership at S1.
    await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email,status) VALUES($1,$2,'off-teacher','Off Teacher','off@d1.test','disabled')", [OFF_TEACHER, idp.issuer]);
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,'teacher',true)", [OFF_TEACHER, ID.d1, ID.s1]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt1b", "supt2", "p1", "p2", "t1", "tp", "drv-gate"]) {
      s[name] = await login(server.base, idp, name, { email_verified: true, ...(name === "drv-gate" ? { email: "drv-gate@d1.test" } : {}) });
      assert.ok(s[name].cookie, `${name} signed in`);
    }
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop?.(); });

  // ---------------- arrival and first attendance ----------------
  describe("arrival handoff and first attendance", () => {
    let handoff;
    it("only an independent, assigned staff member at the school receives the student", async () => {
      const c = await as("p1")("POST", "/api/arrival/handoffs", { studentId: ID.bob, method: "walk_in", assignedTeacherUserId: USERS.t1[0] });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      handoff = c.body.data.id;
      const receive = name => as(name)("POST", `/api/arrival/handoffs/${handoff}/receive`);
      let r = await receive("p1");
      assert.equal(r.status, 409); assert.equal(r.body.error, "independent_receipt_required", "the initiator can't confirm their own handoff");
      r = await receive("drv-gate");
      assert.equal(r.status, 403, "a driver can't confirm a school handoff");
      r = await receive("tp");
      assert.ok([403, 404].includes(r.status), `a teacher who is neither assigned nor rostered can't receive the student (got ${r.status})`);
      r = await receive("p2");
      assert.ok([403, 404].includes(r.status), `another school's principal can't receive (got ${r.status})`);
      r = await receive("supt2");
      assert.ok([403, 404].includes(r.status), `another district can't receive (got ${r.status})`);
      r = await receive("t1");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.received_by, USERS.t1[0]);
    });

    it("first attendance is recorded once, through the handoff, and every step is logged", async () => {
      const today = (await admin.query("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM schools WHERE id=$1", [ID.s1])).rows[0].d;
      const direct = await as("p1")("POST", "/api/attendance", { studentId: ID.bob, eventDate: today, status: "present" });
      assert.equal(direct.status, 409, JSON.stringify(direct.body)); assert.equal(direct.body.error, "attendance_via_arrival_handoff", "the generic route can't bypass the receiver");
      assert.equal(direct.body.handoffId, handoff);
      const [a, b] = await Promise.all([1, 2].map(() => as("t1")("POST", `/api/arrival/handoffs/${handoff}/first-attendance`, { status: "present" })));
      assert.deepEqual([a.status, b.status].sort(), [200, 201], "two concurrent submissions make one record");
      const n = await admin.query("SELECT count(*)::int AS n FROM attendance_events WHERE student_id=$1 AND event_date=$2::date", [ID.bob, today]);
      assert.equal(n.rows[0].n, 1);
      const log = (await admin.query("SELECT event FROM arrival_handoff_events WHERE handoff_id=$1 ORDER BY occurred_at,id", [handoff])).rows.map(r => r.event);
      assert.deepEqual(log, ["initiated", "received", "attendance_recorded"]);
      const audit = (await admin.query(`SELECT action,resource_type FROM audit_events
          WHERE (resource_type='arrival_handoff' AND resource_id=$1) OR resource_type='attendance_event' ORDER BY occurred_at,id`, [handoff])).rows.map(r => `${r.resource_type}:${r.action}`);
      assert.deepEqual(audit, ["arrival_handoff:create", "arrival_handoff:update", "attendance_event:create"]);
    });

    it("concurrent and repeated submissions of the same mark make one record; a correction is kept and wins", async () => {
      const day = "2026-10-05";
      const count = async () => (await admin.query("SELECT count(*)::int AS n FROM attendance_events WHERE student_id=$1 AND event_date=$2::date", [ID.carol, day])).rows[0].n;
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => as("p2")("POST", "/api/attendance", { studentId: ID.carol, eventDate: day, status: "present" })));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 201], JSON.stringify(results.map(r => r.body)));
      assert.ok(results.filter(r => r.status === 200).every(r => r.body.data.duplicate === true && r.body.data.status === "present"));
      assert.equal(await count(), 1);
      assert.equal((await as("p2")("POST", "/api/attendance", { studentId: ID.carol, eventDate: day, status: "tardy" })).status, 201, "a correction");
      assert.equal((await as("p2")("POST", "/api/attendance", { studentId: ID.carol, eventDate: day, status: "tardy" })).status, 200, "repeating it adds nothing");
      assert.equal(await count(), 2);
      const latest = await admin.query("SELECT status FROM attendance_events WHERE student_id=$1 AND event_date=$2::date ORDER BY observed_at DESC NULLS LAST,id DESC LIMIT 1", [ID.carol, day]);
      assert.equal(latest.rows[0].status, "tardy");
      assert.equal((await as("p1")("POST", "/api/attendance", { studentId: ID.carol, eventDate: "2026-10-06", status: "present" })).status, 404, "another school's student");
      assert.equal((await as("supt2")("POST", "/api/attendance", { studentId: ID.carol, eventDate: "2026-10-06", status: "present" })).status, 404, "another district's student");
    });

    it("after the handoff's first attendance, staff can correct the day through the usual route", async () => {
      const today = (await admin.query("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM schools WHERE id=$1", [ID.s1])).rows[0].d;
      const r = await as("p1")("POST", "/api/attendance", { studentId: ID.bob, eventDate: today, status: "tardy" });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });
  });

  // ---------------- emergency notifications ----------------
  describe("emergency notifications", () => {
    let incident, ownerPool, dispatchPending;
    const outbox = async id => (await admin.query(`SELECT o.recipient_user_id,o.channel,o.status,o.delivered_at,o.last_attempt_at,o.attempts,o.next_attempt_at,o.school_id,o.district_id
        FROM notification_outbox o WHERE o.ref_type='safety_incident' AND o.ref_id=$1`, [id])).rows;
    const board = async id => (await as("p1")("GET", `/api/safety/incidents/${id}/board`));
    const start = async () => {
      const st = await as("p1")("POST", "/api/safety/incidents", { kind: "lockdown", isDrill: true });
      assert.equal(st.status, 201, JSON.stringify(st.body));
      const ok = await as("p1")("POST", `/api/safety/incidents/${st.body.data.id}/confirm`, { kind: "lockdown", isDrill: true });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      return ok.body.data;
    };
    const allClear = id => as("p1")("POST", `/api/safety/incidents/${id}/all-clear`, { kind: "lockdown" });
    after(async () => { await ownerPool?.end(); });

    it("an alert reaches only active people at the incident's school, and says what was queued rather than delivered", async () => {
      const data = await start();
      incident = data.id;
      const n = data.notifications;
      assert.equal(n.emergencyServicesContacted, false);
      assert.equal(n.externalDelivered, 0, "nothing is confirmed at the moment of the alert");
      assert.ok(n.inAppAvailable >= 4 && n.externalQueued === n.inAppAvailable, JSON.stringify(n), "email is on (log adapter): one queued row per recipient");
      assert.equal(data.notified, undefined, "no 'notified' claim");
      const rows = await outbox(incident);
      const recipients = new Set(rows.map(r => r.recipient_user_id));
      for (const r of rows) { assert.equal(r.district_id, ID.d1); assert.equal(r.school_id, ID.s1); }
      for (const who of ["p1", "t1", "tp", "pa", "pb"]) assert.ok(recipients.has(USERS[who][0]), `${who} is told`);
      assert.ok(recipients.has(DRIVER), "the school's driver is told");
      for (const who of ["p2", "supt2"]) assert.ok(!recipients.has(USERS[who][0]), `${who} (another school or district) is not`);
      assert.ok(!recipients.has(OFF_TEACHER), "a disabled account is not");
      for (const r of rows.filter(r => r.channel === "email")) { assert.equal(r.status, "pending"); assert.equal(r.delivered_at, null); }
      // Another school's principal can't read this incident's board or delivery.
      assert.ok([403, 404].includes((await as("p2")("GET", `/api/safety/incidents/${incident}/board`)).status));
      const own = await admin.query("SELECT count(*)::int AS n FROM eduos_safety_delivery($1)", [incident]);
      assert.equal(own.rows[0].n, 0, "without a lead's context the report function returns nothing");
    });

    it("the leads' board reports in-app availability and queued email separately; a dry run is never a delivery", async () => {
      let b = (await board(incident)).body.data.notifications;
      assert.equal(b.emergencyServicesContacted, false);
      assert.ok(b.inApp.available >= 4);
      assert.equal(b.external.delivered, 0);
      assert.equal(b.external.pending, b.inApp.available);
      const dispatched = await run(["src/notify-dispatch.js"], { ...env, DATABASE_URL: db.ownerUrl });
      assert.equal(dispatched.code, 0, dispatched.out);
      assert.match(dispatched.out, /0 delivered, \d+ skipped/);
      for (const r of (await outbox(incident)).filter(r => r.channel === "email")) {
        assert.equal(r.status, "skipped"); assert.equal(r.delivered_at, null, "skipped is not delivered"); assert.ok(r.last_attempt_at);
      }
      b = (await board(incident)).body.data.notifications;
      assert.equal(b.external.delivered, 0); assert.equal(b.external.skipped, b.inApp.available);
      const events = await as("p1")("POST", `/api/safety/incidents/${incident}/events`, { event: "responders" });
      assert.equal(events.status, 200);
      const logged = (await admin.query("SELECT detail FROM safety_events WHERE incident_id=$1 AND event='responders'", [incident])).rows[0].detail;
      assert.doesNotMatch(logged, /notified/i, "a staff log entry doesn't claim responders were notified");
      assert.equal((await allClear(incident)).status, 200);
    });

    it("a failing channel backs off, then gives up, and the failure shows on the board", async () => {
      // Clear what the all clear queued, then start a fresh incident.
      await admin.query("UPDATE notification_outbox SET status='skipped' WHERE status='pending'");
      const data = await start();
      Object.assign(process.env, { ...env, DATABASE_URL: db.ownerUrl });
      ({ dispatchPending } = await import("../../src/notify-dispatch.js"));
      ownerPool = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
      const failing = () => ({ send: async () => { throw new Error("smtp unavailable"); } });
      let t = await dispatchPending({ db: ownerPool, adapters: failing, log: () => {} });
      assert.equal(t.retrying, data.notifications.externalQueued); assert.equal(t.delivered, 0);
      let rows = (await outbox(data.id)).filter(r => r.channel === "email");
      assert.ok(rows.every(r => r.status === "pending" && r.attempts === 1 && new Date(r.next_attempt_at) > new Date()), "waits before the next try");
      t = await dispatchPending({ db: ownerPool, adapters: failing, log: () => {} });
      assert.equal(t.handled, 0, "a backed-off row isn't retried on the next run");
      await admin.query("UPDATE notification_outbox SET attempts=4,next_attempt_at=now() WHERE ref_id=$1 AND channel='email'", [data.id]);
      t = await dispatchPending({ db: ownerPool, adapters: failing, log: () => {} });
      assert.equal(t.failed, data.notifications.externalQueued);
      rows = (await outbox(data.id)).filter(r => r.channel === "email");
      assert.ok(rows.every(r => r.status === "failed" && r.delivered_at === null));
      const b = (await board(data.id)).body.data.notifications;
      assert.equal(b.external.failed, data.notifications.externalQueued); assert.equal(b.external.delivered, 0);
      assert.equal(b.byChannel.email.failed, data.notifications.externalQueued);
      // An adapter that confirms delivers; one that answers nonsense fails.
      await admin.query("UPDATE notification_outbox SET status='pending',attempts=0,next_attempt_at=NULL WHERE ref_id=$1 AND channel='email'", [data.id]);
      let k = 0;
      t = await dispatchPending({ db: ownerPool, log: () => {}, adapters: () => ({ send: async () => (k++ % 2 ? { status: "sent!" } : { status: "delivered" }) }) });
      assert.equal(t.delivered + t.failed, data.notifications.externalQueued); assert.ok(t.failed >= 1 && t.delivered >= 1);
      rows = (await outbox(data.id)).filter(r => r.channel === "email");
      assert.ok(rows.every(r => (r.status === "delivered") === (r.delivered_at !== null)));
      assert.equal((await allClear(data.id)).status, 200);
    });
  });

  describe("notification dispatch leases", () => {
    let ownerPool, dispatchPending, incident;
    const start = async () => {
      const st = await as("p1")("POST", "/api/safety/incidents", { kind: "lockdown", isDrill: true });
      const ok = await as("p1")("POST", `/api/safety/incidents/${st.body.data.id}/confirm`, { kind: "lockdown", isDrill: true });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      return ok.body.data;
    };
    before(async () => {
      await admin.query("UPDATE notification_outbox SET status='skipped' WHERE status='pending'");
      Object.assign(process.env, { ...env, DATABASE_URL: db.ownerUrl });
      ({ dispatchPending } = await import("../../src/notify-dispatch.js"));
      ownerPool = new pg.Pool({ connectionString: db.ownerUrl, max: 3 });
      incident = (await start()).id;
    });
    after(async () => { await as("p1")("POST", `/api/safety/incidents/${incident}/all-clear`, { kind: "lockdown" }); await ownerPool?.end(); });

    it("a slow sender holds no transaction or row lock while it waits", async () => {
      const seen = [];
      const slow = () => ({ send: async w => {
        // While the adapter "waits on the network": nothing of the dispatcher's is
        // idle in a transaction, and the row can be locked by someone else at once.
        const idle = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()");
        await admin.query("BEGIN");
        await admin.query("SET LOCAL lock_timeout='200ms'");
        const lock = await admin.query("SELECT id FROM notification_outbox WHERE id=$1 FOR UPDATE", [w.id]).catch(e => e);
        await admin.query("ROLLBACK");
        seen.push({ idle: idle.rows[0].n, locked: lock instanceof Error });
        return { status: "delivered" };
      } });
      const t = await dispatchPending({ db: ownerPool, adapters: slow, limit: 3, log: () => {} });
      assert.equal(t.delivered, 3);
      assert.deepEqual(seen, [{ idle: 0, locked: false }, { idle: 0, locked: false }, { idle: 0, locked: false }]);
    });

    it("a dispatcher that dies mid-batch: its leases run out and the rows are sent by the next run, once", async () => {
      // Claim like a dispatcher that then crashes before sending.
      await admin.query(`UPDATE notification_outbox SET lease_token=gen_random_uuid(), lease_expires_at=now()+interval '5 minutes'
        WHERE ref_id=$1 AND channel='email' AND status='pending'`, [incident]);
      let t = await dispatchPending({ db: ownerPool, adapters: () => ({ send: async () => ({ status: "delivered" }) }), log: () => {} });
      assert.equal(t.handled, 0, "rows under a live lease are left alone");
      await admin.query("UPDATE notification_outbox SET lease_expires_at=now()-interval '1 second' WHERE ref_id=$1 AND lease_token IS NOT NULL", [incident]);
      const sent = [];
      t = await dispatchPending({ db: ownerPool, adapters: () => ({ send: async w => { sent.push(w.id); return { status: "delivered" }; } }), log: () => {} });
      assert.ok(t.delivered > 0 && t.delivered === sent.length && new Set(sent).size === sent.length);
      const left = await admin.query("SELECT count(*)::int AS n FROM notification_outbox WHERE ref_id=$1 AND channel='email' AND (status='pending' OR lease_token IS NOT NULL)", [incident]);
      assert.equal(left.rows[0].n, 0);
    });

    it("two dispatchers and a sender slower than the lease: every row is sent exactly once", async () => {
      await admin.query("UPDATE notification_outbox SET status='pending',attempts=0,delivered_at=NULL,next_attempt_at=NULL,lease_token=NULL,lease_expires_at=NULL WHERE ref_id=$1 AND channel='email'", [incident]);
      const rows = (await admin.query("SELECT count(*)::int AS n FROM notification_outbox WHERE ref_id=$1 AND channel='email'", [incident])).rows[0].n;
      assert.ok(rows >= 4, `${rows} rows`);
      const sent = [];
      const slow = () => ({ send: async w => { sent.push(w.id); await sleep(400); return { status: "delivered" }; } });
      // A claims every row with a 1 s lease, then needs 400 ms per row; B starts
      // after A's original claims have run out.
      const a = dispatchPending({ db: ownerPool, adapters: slow, leaseSeconds: 1, sendTimeoutSeconds: 0.8, batch: 50, log: () => {} });
      await sleep(1100);
      const b = dispatchPending({ db: ownerPool, adapters: slow, leaseSeconds: 1, sendTimeoutSeconds: 0.8, batch: 50, log: () => {} });
      const [ta, tb] = await Promise.all([a, b]);
      assert.equal(sent.length, new Set(sent).size, `a row was sent twice: ${sent.length} sends for ${new Set(sent).size} rows`);
      assert.equal(new Set(sent).size, rows, "and every row was sent");
      assert.ok(ta.lostLease > 0 && tb.delivered > 0, JSON.stringify({ ta, tb }));
      const left = await admin.query("SELECT count(*)::int AS n FROM notification_outbox WHERE ref_id=$1 AND channel='email' AND status<>'delivered'", [incident]);
      assert.equal(left.rows[0].n, 0);
    });

    it("a send with no answer is cut off inside the lease and retried later, not marked delivered", async () => {
      const row = (await admin.query("SELECT id FROM notification_outbox WHERE ref_id=$1 AND channel='email' LIMIT 1", [incident])).rows[0].id;
      await admin.query("UPDATE notification_outbox SET status='pending',attempts=0,delivered_at=NULL,next_attempt_at=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [row]);
      let providerAborted = false;
      const t = await dispatchPending({ db: ownerPool, leaseSeconds: 2, sendTimeoutSeconds: 0.3, log: () => {}, adapters: () => ({ send: (_row, _log, { signal } = {}) => new Promise(() => {
        signal?.addEventListener("abort", () => { providerAborted = true; }, { once: true });
      }) }) });
      assert.equal(t.retrying, 1);
      assert.equal(providerAborted, true, "the provider request receives cancellation before its lease is released");
      const r = (await admin.query("SELECT status,delivered_at,last_error,lease_token FROM notification_outbox WHERE id=$1", [row])).rows[0];
      assert.deepEqual([r.status, r.delivered_at, r.lease_token], ["pending", null, null]);
      assert.match(r.last_error, /no answer within 0.3 s/);
      await assert.rejects(dispatchPending({ db: ownerPool, leaseSeconds: 1, sendTimeoutSeconds: 1 }), /sendTimeoutSeconds/);
    });

    it("a late result from a lost lease doesn't overwrite the row", async () => {
      const row = (await admin.query("SELECT id FROM notification_outbox WHERE ref_id=$1 AND channel='email' LIMIT 1", [incident])).rows[0].id;
      await admin.query("UPDATE notification_outbox SET status='pending',attempts=0,delivered_at=NULL,next_attempt_at=NULL,last_error=NULL,lease_token=NULL,lease_expires_at=NULL WHERE ref_id=$1 AND channel='email'", [incident]);
      const t = await dispatchPending({ db: ownerPool, log: () => {}, adapters: () => ({ send: async w => {
        // Another dispatcher took the row over (its lease) while this one was sending.
        if (w.id === row) await admin.query("UPDATE notification_outbox SET lease_token=gen_random_uuid() WHERE id=$1", [row]);
        return { status: "failed", note: "late" };
      } }) });
      assert.equal(t.lostLease, 1);
      const r = (await admin.query("SELECT status,last_error FROM notification_outbox WHERE id=$1", [row])).rows[0];
      assert.deepEqual(r, { status: "pending", last_error: null }, "the stale result was not recorded");
    });
  });

  // ---------------- operations event stream ----------------
  describe("operations event stream", () => {
    function open(name) {
      const ctrl = new AbortController();
      const st = { text: "", ended: false, status: 0 };
      st.ready = fetch(`${server.base}/api/operations/stream`, { headers: { cookie: s[name].cookie }, signal: ctrl.signal }).then(async res => {
        st.status = res.status;
        if (res.status !== 200) { st.ended = true; return; }
        const reader = res.body.getReader(), dec = new TextDecoder();
        (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; st.text += dec.decode(value); } } catch {} st.ended = true; })();
      });
      st.close = () => ctrl.abort();
      return st;
    }
    const until = async (cond, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(50); } return cond(); };
    const action = name => as(name)("GET", `/api/students/${name === "supt2" ? ID.xavier : ID.alice}`);

    it("carries only the subscriber's district and ends when the session is signed out", async () => {
      const st = open("supt1"); await st.ready;
      assert.equal(st.status, 200);
      await until(() => st.text.includes(": connected"));
      const before = st.text.length;
      assert.equal((await action("supt2")).status, 200);
      await sleep(600);
      assert.doesNotMatch(st.text.slice(before), /event: operational/, "another district's event is not streamed");
      assert.equal((await action("p1")).status, 200);
      assert.ok(await until(() => /event: operational/.test(st.text.slice(before))), "own district's event arrives");
      const out = await client(server.base, s.supt1)("POST", "/auth/logout");
      assert.ok([200, 204, 303].includes(out.status), `logout ${out.status}`);
      assert.ok(await until(() => st.ended), "the stream ends after sign-out");
      assert.match(st.text, /event: session_ended/);
      const again = open("supt1"); await again.ready;
      assert.equal(again.status, 401, "the signed-out session can't reconnect");
    });

    it("an expired session's stream ends, and its events stop", async () => {
      const st = open("supt1b"); await st.ready;
      assert.equal(st.status, 200);
      await admin.query("UPDATE sessions SET expires_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [USERS.supt1b[0]]);
      assert.equal((await action("p1")).status, 200);
      assert.ok(await until(() => st.ended), "the stream ends");
      assert.doesNotMatch(st.text, /event: operational/, "no event is sent to an expired session");
      const again = open("supt1b"); await again.ready;
      assert.equal(again.status, 401, "and it can't reconnect");
    });

    it("a revoked membership ends the stream even with no events", async () => {
      s.supt1x = await login(server.base, idp, "supt1", { email_verified: true });
      const st = open("supt1x"); await st.ready;
      assert.equal(st.status, 200);
      await admin.query("UPDATE memberships SET status='disabled' WHERE user_id=$1", [USERS.supt1[0]]);
      try { assert.ok(await until(() => st.ended, 5000), "the idle stream notices within the re-check interval"); }
      finally { await admin.query("UPDATE memberships SET status='active' WHERE user_id=$1", [USERS.supt1[0]]); st.close(); }
    });
  });

  // ---------------- webhooks ----------------
  describe("webhook subscriptions", () => {
    it("another district can't read, test or disable a subscription", async () => {
      const sub = (await admin.query(`INSERT INTO webhook_subscriptions(district_id,created_by,url,event_types)
        VALUES($1,$2,'https://hooks.example.test/d1',ARRAY['*']) RETURNING id`, [ID.d1, USERS.supt1[0]])).rows[0].id;
      const list = await as("supt2")("GET", "/api/webhooks");
      assert.equal(list.status, 200);
      assert.ok(!JSON.stringify(list.body).includes(sub), "not listed for another district");
      const deliveries = await as("supt2")("GET", `/api/webhooks/${sub}/deliveries`);
      assert.ok(deliveries.status === 404 || (deliveries.status === 200 && deliveries.body.data.length === 0));
      assert.equal((await as("supt2")("DELETE", `/api/webhooks/${sub}`)).status, 404);
      assert.ok([404, 503].includes((await as("supt2")("POST", `/api/webhooks/${sub}/test`)).status));
      assert.equal((await admin.query("SELECT status FROM webhook_subscriptions WHERE id=$1", [sub])).rows[0].status, "active");
    });
  });
});
