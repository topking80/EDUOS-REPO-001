// One student's school morning, end to end, against real PostgreSQL as the
// runtime role (2026-11-16 audit, gate 3): bus check-in, the driver's
// handoff, the teacher's receipt, first attendance, a later correction, an
// offline replay delivered twice and a late offline mark that predates the
// correction. The route tests pass on their own; this proves they agree with
// each other and that the whole morning stays traceable with exactly one
// first attendance.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const DRIVER = "a0000000-0000-4000-8000-0000000000f1";
const DRIVER2 = "a0000000-0000-4000-8000-0000000000f2";

describe("a school morning end to end against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, route, runId, handoff, today;
  const as = name => client(server.base, s[name]);
  const raw = async (who, method, path, body, headers = {}) => {
    const res = await fetch(server.base + path, { method, body: body && JSON.stringify(body),
      headers: { cookie: s[who].cookie, "x-csrf-token": s[who].csrf, "content-type": "application/json", ...headers } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    for (const [id, sub, school] of [[DRIVER, "drv1", ID.s1], [DRIVER2, "drv2", ID.s2]]) {
      await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES($1,$2,$3,$4,$5)", [id, idp.issuer, sub, `Driver ${sub}`, `${sub}@d1.test`]);
      await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,'driver',true)", [id, ID.d1, school]);
    }
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5)", [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
    today = (await admin.query("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM schools WHERE id=$1", [ID.s1])).rows[0].d;
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "t1", "tp", "drv1", "drv2"])
      s[name] = await login(server.base, idp, name, { email_verified: true, ...(name.startsWith("drv") ? { email: `${name}@d1.test` } : {}) });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop?.(); });

  it("1. the bus: only the assigned driver runs the route and checks in its riders", async () => {
    const created = await as("p1")("POST", "/api/transport/routes", { name: "Route 7", busLabel: "Bus 7", direction: "am", driverUserId: DRIVER,
      stops: [{ name: "Elm & 3rd", time: "07:20" }, { name: "School", time: "07:50", isSchool: true }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    route = created.body.data;
    route.stops = (await as("p1")("GET", "/api/transport/routes")).body.data[0].stops;
    assert.equal((await as("p1")("POST", `/api/transport/routes/${route.id}/riders`, { studentId: ID.alice, stopId: route.stops[0].id })).status, 201);
    assert.equal((await as("drv2")("POST", "/api/transport/runs", { routeId: route.id })).status, 404, "a driver can't run a route that isn't theirs");
    const r = await as("drv1")("POST", "/api/transport/runs", { routeId: route.id });
    assert.equal(r.status, 201); runId = r.body.data.id;
    const path = `/api/transport/runs/${runId}/checkins`;
    assert.equal((await as("drv1")("POST", path, { studentId: ID.bob, stopId: route.stops[0].id, event: "boarded" })).status, 404, "an unassigned rider");
    assert.equal((await as("drv2")("POST", path, { studentId: ID.alice, stopId: route.stops[0].id, event: "boarded" })).status, 404, "another driver");
    // Boarded, sent from the bus while offline and delivered twice: one check-in.
    const observed = new Date(Date.now() - 20 * 60_000).toISOString();
    const key = { "idempotency-key": "morning-board-000000000000001", "x-eduos-queued-at": observed };
    const a = await raw("drv1", "POST", path, { studentId: ID.alice, stopId: route.stops[0].id, event: "boarded" }, key);
    const b = await raw("drv1", "POST", path, { studentId: ID.alice, stopId: route.stops[0].id, event: "boarded" }, key);
    assert.equal(a.status, 201, JSON.stringify(a.body)); assert.deepEqual(b.body.data, { duplicate: true });
    assert.equal((await as("drv1")("POST", path, { studentId: ID.alice, stopId: route.stops[1].id, event: "alighted" })).status, 201);
    const checkins = (await admin.query("SELECT event FROM transport_checkins WHERE run_id=$1 AND student_id=$2 ORDER BY observed_at NULLS LAST,recorded_at", [runId, ID.alice])).rows.map(r => r.event);
    assert.deepEqual(checkins, ["boarded", "alighted"]);
  });

  it("2. the handoff: the driver starts it for a rider of their run; no one confirms their own; first attendance waits for receipt", async () => {
    assert.equal((await as("drv1")("POST", "/api/arrival/handoffs", { studentId: ID.bob, method: "bus", routeRunId: runId })).status, 403, "not a rider of this run");
    assert.equal((await as("drv2")("POST", "/api/arrival/handoffs", { studentId: ID.alice, method: "bus", routeRunId: runId })).status, 403, "not their run");
    const h = await as("drv1")("POST", "/api/arrival/handoffs", { studentId: ID.alice, method: "bus", routeRunId: runId, assignedTeacherUserId: USERS.t1[0] });
    assert.equal(h.status, 201, JSON.stringify(h.body)); handoff = h.body.data.id;
    assert.equal((await as("drv1")("POST", `/api/arrival/handoffs/${handoff}/receive`)).status, 403, "the driver can't confirm their own handoff");
    const early = await as("t1")("POST", `/api/arrival/handoffs/${handoff}/first-attendance`, { status: "present" });
    assert.equal(early.status, 409); assert.equal(early.body.error, "attendance_requires_received_handoff");
    assert.equal((await as("p1")("POST", "/api/attendance", { studentId: ID.alice, eventDate: today, status: "present" })).body.error, "attendance_via_arrival_handoff");
    assert.ok([403, 404].includes((await as("tp")("POST", `/api/arrival/handoffs/${handoff}/receive`)).status), "a teacher outside the roster");
  });

  it("3. receipt and first attendance: one record even when submitted twice at once; an override needs a reason", async () => {
    assert.equal((await as("t1")("POST", `/api/arrival/handoffs/${handoff}/receive`)).status, 200);
    assert.equal((await as("p1")("POST", `/api/arrival/handoffs/${handoff}/first-attendance`, { status: "present" })).status, 400, "a principal override without a reason");
    const [a, b] = await Promise.all([1, 2].map(() => as("t1")("POST", `/api/arrival/handoffs/${handoff}/first-attendance`, { status: "present" })));
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  });

  it("4. a correction later in the morning wins; a late offline mark from before it is kept but doesn't", async () => {
    assert.equal((await as("p1")("POST", "/api/attendance", { studentId: ID.alice, eventDate: today, status: "tardy" })).status, 201);
    const late = await raw("t1", "POST", "/api/attendance", { studentId: ID.alice, eventDate: today, status: "absent" },
      { "idempotency-key": "morning-late-000000000000001", "x-eduos-queued-at": new Date(Date.now() - 15 * 60_000).toISOString() });
    assert.equal(late.status, 201, JSON.stringify(late.body));
    const day = (await as("p1")("GET", `/api/attendance/day?date=${today}`)).body.data;
    assert.deepEqual(day.counts, { present: 0, absent: 0, tardy: 1, excused: 0 }, "the correction is the day's status");
    // The first-attendance route still reports the original record, never a second one.
    const again = await as("t1")("POST", `/api/arrival/handoffs/${handoff}/first-attendance`, { status: "present" });
    assert.equal(again.status, 200);
  });

  it("5. the whole morning is traceable", async () => {
    const log = (await admin.query("SELECT event FROM arrival_handoff_events WHERE handoff_id=$1 ORDER BY occurred_at,id", [handoff])).rows.map(r => r.event);
    assert.deepEqual(log, ["initiated", "received", "attendance_recorded"], "one first attendance");
    const marks = (await admin.query("SELECT status FROM attendance_events WHERE student_id=$1 AND event_date=$2::date ORDER BY observed_at,id", [ID.alice, today])).rows.map(r => r.status);
    assert.equal(marks.filter(m => m === "present").length, 1, `one present mark: ${marks}`);
    assert.equal(marks.at(-1), "tardy", `the latest observation is the correction: ${marks}`);
    const audit = (await admin.query(`SELECT resource_type||':'||action AS a FROM audit_events
        WHERE resource_type IN ('arrival_handoff','attendance_event','attendance') ORDER BY occurred_at,id`)).rows.map(r => r.a);
    for (const step of ["arrival_handoff:create", "arrival_handoff:update", "attendance_event:create"]) assert.ok(audit.includes(step), `${step} in ${audit}`);
    assert.equal(audit.filter(a => a === "attendance_event:create").length, 1);
  });
});
