// EduOS 32.5.0 SafetyOS and car pick-up against real PostgreSQL, as the
// non-owner runtime role: two-step start, drill flag, school-scoped state for
// every role, generic family notices, roster roll call, accountability board,
// reunification and all-clear, append-only logs; pick-up passes (hash only),
// guardian-managed adults with school approval, do-not-release blocks with an
// office alert, custody acknowledgement, release log and family notices;
// school time zone; retention and FERPA coverage.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const DRIVER = "a0000000-0000-4000-8000-0000000000e1";

describe("EduOS 32.5.0 SafetyOS and pick-up against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, appDb, s = {};
  const as = name => client(server.base, s[name]);
  const asRole = async (role, user, school, sql, params = []) => {
    await appDb.query("BEGIN");
    try {
      await appDb.query("SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id',$4,true)", [ID.d1, user, role, school ?? ""]);
      return (await appDb.query(sql, params)).rows;
    } finally { await appDb.query("ROLLBACK"); }
  };
  const notes = async (user, kind) => (await admin.query("SELECT title,body FROM notification_outbox WHERE recipient_user_id=$1 AND kind=$2 ORDER BY created_at", [user, kind])).rows;

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, WEBHOOK_SIGNING_KEY: "w".repeat(40) });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES($1,$2,'drvs','Driver S','drvs@d1.test')", [DRIVER, idp.issuer]);
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,'driver',true)", [DRIVER, ID.d1, ID.s1]);
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5)", [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
    appDb = new pg.Client(db.appUrl); await appDb.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "p2", "t1", "pu", "pa", "pb", "drvs", "supt2"]) {
      s[name] = await login(server.base, idp, name, { email_verified: true, ...(name === "drvs" ? { email: "drvs@d1.test" } : {}) });
      assert.ok(s[name].cookie, `${name} signed in`);
    }
  });
  after(async () => {
    if (process.env.EDUOS_IT_DEBUG) console.log(server?.log().split("\n").filter(l => /fail|error/i.test(l)).join("\n"));
    await server?.stop(); await appDb?.end(); await admin?.end(); await idp?.close(); await db?.drop?.();
  });

  let incident;
  it("SafetyOS: two-step start with a drill flag; only staff can start; nothing is broadcast until confirmed", async () => {
    for (const who of ["pa", "pu", "drvs"]) assert.equal((await as(who)("POST", "/api/safety/incidents", { kind: "lockdown", isDrill: true })).status, 403, who);
    assert.equal((await as("t1")("POST", "/api/safety/incidents", { kind: "panic", isDrill: true })).status, 400);
    assert.equal((await as("t1")("POST", "/api/safety/incidents", { kind: "lockdown" })).status, 400, "drill flag is required");
    const started = await as("t1")("POST", "/api/safety/incidents", { kind: "lockdown", isDrill: true, instructions: "Room 12 door sticks; push hard." });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    incident = started.body.data;
    assert.equal(incident.status, "pending");
    assert.equal((await as("pa")("GET", "/api/safety/status")).body.data.incidents.length, 0, "pending is not shown to families");
    assert.equal((await as("pu")("GET", "/api/safety/status")).body.data.incidents.length, 0, "or students");
    assert.equal((await as("t1")("POST", `/api/safety/incidents/${incident.id}/confirm`, { kind: "lockdown", isDrill: false })).status, 400, "drill flag must match");
    assert.equal((await as("t1")("POST", `/api/safety/incidents/${incident.id}/confirm`, { kind: "hold", isDrill: true })).status, 400, "kind must match");
    const ok = await as("t1")("POST", `/api/safety/incidents/${incident.id}/confirm`, { kind: "lockdown", isDrill: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, "active");
    const n = ok.body.data.notifications;
    assert.ok(n.recipients.families >= 2 && n.recipients.staff >= 3, JSON.stringify(n));
    assert.equal(n.emergencyServicesContacted, false);
    assert.equal((await as("p1")("POST", "/api/safety/incidents", { kind: "evacuate", isDrill: false })).status, 409, "one live incident per school");
  });

  it("SafetyOS: every role at the school sees the state; families get generic text only; other schools see nothing", async () => {
    for (const who of ["pu", "drvs", "t1", "p1", "supt1"]) {
      const st = (await as(who)("GET", "/api/safety/status")).body.data.incidents;
      assert.equal(st.length, 1, who); assert.equal(st[0].kind, "lockdown"); assert.equal(st[0].isDrill, true);
    }
    assert.equal((await as("t1")("GET", "/api/safety/status")).body.data.incidents[0].instructions, "Room 12 door sticks; push hard.");
    const fam = (await as("pa")("GET", "/api/safety/status")).body.data.incidents;
    assert.equal(fam.length, 1); assert.equal(fam[0].audience, "family");
    assert.equal(fam[0].instructions, undefined, "staff instructions are never sent to families");
    assert.doesNotMatch(JSON.stringify(fam), /Room 12|Alice|Bob|Teacher/);
    for (const who of ["p2", "supt2"]) assert.equal((await as(who)("GET", "/api/safety/status")).body.data.incidents.length, 0, who);
    const n = await notes(USERS.pa[0], "safety");
    assert.equal(n.length, 1); assert.match(n[0].title, /S1: Lockdown in effect \(drill\)/); assert.doesNotMatch(`${n[0].title} ${n[0].body}`, /Alice|Room/);
  });

  it("SafetyOS: roster roll call, extras from the school only, live accountability board", async () => {
    assert.equal((await as("t1")("POST", `/api/safety/incidents/${incident.id}/rollcall`, { entries: [{ studentId: ID.bob, status: "missing" }] })).status, 400, "Bob is not on t1's roster");
    assert.equal((await as("t1")("POST", `/api/safety/incidents/${incident.id}/rollcall`, { entries: [{ studentId: ID.carol, status: "extra" }] })).status, 404, "Carol is at S2");
    const found = await as("t1")("GET", `/api/safety/incidents/${incident.id}/students?q=Bob`);
    assert.deepEqual(found.body.data.map(x => x.name), ["Bob B"]);
    assert.equal((await as("t1")("GET", `/api/safety/incidents/${incident.id}/students?q=Carol`)).body.data.length, 0);
    const rc = await as("t1")("POST", `/api/safety/incidents/${incident.id}/rollcall`, { entries: [{ studentId: ID.alice, status: "injured", note: "scraped knee" }, { studentId: ID.bob, status: "extra" }] });
    assert.equal(rc.status, 201, JSON.stringify(rc.body));
    assert.equal((await notes(USERS.p1[0], "safety")).filter(x => /Roll call: 0 missing, 1 injured/.test(x.title)).length, 1, "office alerted");
    await as("t1")("POST", `/api/safety/incidents/${incident.id}/rollcall`, { entries: [{ studentId: ID.alice, status: "present" }] });
    const mine = (await as("t1")("GET", `/api/safety/incidents/${incident.id}/rollcall`)).body.data;
    assert.equal(mine.learners[0].status, "present"); assert.equal(mine.extras[0].name, "Bob B");
    assert.equal((await as("t1")("GET", `/api/safety/incidents/${incident.id}/board`)).status, 403);
    const board = (await as("p1")("GET", `/api/safety/incidents/${incident.id}/board`)).body.data;
    assert.equal(board.totals.enrolled, 2); assert.equal(board.totals.present, 1); assert.equal(board.totals.extra, 1); assert.equal(board.totals.unaccounted, 0);
    assert.deepEqual(board.events.map(e => e.event), ["initiated", "confirmed", "rollcall", "rollcall"]);
    assert.equal((await as("p2")("GET", `/api/safety/incidents/${incident.id}/board`)).status, 404, "other school's principal");
    // Append-only and RLS, directly as the runtime role.
    await assert.rejects(asRole("principal", USERS.p1[0], ID.s1, "UPDATE safety_events SET detail='x' WHERE incident_id=$1", [incident.id]), /permission denied|append-only/);
    await assert.rejects(asRole("principal", USERS.p1[0], ID.s1, "DELETE FROM safety_rollcall_entries WHERE incident_id=$1", [incident.id]), /permission denied|append-only/);
    assert.equal((await asRole("parent", USERS.pa[0], ID.s1, "SELECT * FROM safety_rollcall_entries")).length, 0, "families never read roll call");
    assert.equal((await asRole("principal", USERS.p2[0], ID.s2, "SELECT * FROM safety_incidents")).length, 0);
    const cols = (await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name LIKE 'safety_%' OR table_name LIKE 'pickup_%'")).rows;
    const banned = /(^|_)(lat|lng|latitude|longitude|gps|location|coords|photo|image|face|biometric|score|threat|risk)(_|$)/;
    assert.ok(!cols.some(c => banned.test(c.column_name)), JSON.stringify(cols.filter(c => banned.test(c.column_name))));
  });

  let guardianPass, grandma;
  it("pick-up: guardian adds an adult, the school approves, passes are hash-only; releases pause during a lockdown", async () => {
    const fam = (await as("pa")("GET", "/api/pickup/family")).body.data.children;
    assert.deepEqual(fam.map(k => k.display_name), ["Alice A"]);
    const me = fam[0].adults.find(x => x.is_me);
    assert.equal(me.kind, "guardian"); assert.equal(me.status, "approved");
    assert.deepEqual((await as("pb")("GET", "/api/pickup/family")).body.data.children.map(k => k.display_name), ["Bob B"]);
    const add = await as("pa")("POST", "/api/pickup/adults", { studentId: ID.alice, fullName: "Ruth Grandma", relationship: "Grandparent" });
    assert.equal(add.status, 201); assert.equal(add.body.data.status, "pending");
    grandma = add.body.data.id;
    assert.equal((await as("pb")("POST", "/api/pickup/adults", { studentId: ID.alice, fullName: "Mallory", relationship: "Friend" })).status, 403, "not their child");
    assert.equal((await as("pa")("POST", "/api/pickup/tags", { adultId: grandma })).status, 409, "pending adult gets no pass");
    assert.equal((await as("pa")("POST", `/api/pickup/adults/${grandma}/decision`, { decision: "approve" })).status, 403, "families cannot approve");
    const admin1 = (await as("p1")("GET", "/api/pickup/admin")).body.data;
    assert.equal(admin1.pendingAdults.length, 1);
    assert.equal((await as("p1")("POST", `/api/pickup/adults/${grandma}/decision`, { decision: "approve" })).status, 200);
    const pass = await as("pa")("POST", "/api/pickup/tags", { adultId: grandma });
    assert.equal(pass.status, 201);
    assert.match(pass.body.data.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    assert.ok(pass.body.data.qr.length >= 21 && pass.body.data.qr.every(r => /^[01]+$/.test(r)));
    const stored = (await admin.query("SELECT code_hash,code_hint FROM pickup_tags WHERE id=$1", [pass.body.data.id])).rows[0];
    assert.notEqual(stored.code_hash, pass.body.data.code); assert.equal(stored.code_hint, pass.body.data.code.slice(-2));
    guardianPass = pass.body.data.code;
    // Lockdown still live: verify works but nobody is released.
    const v = await as("t1")("POST", "/api/pickup/verify", { code: guardianPass.toLowerCase() });
    assert.equal(v.status, 200); assert.equal(v.body.data.students[0].eligible, false); assert.equal(v.body.data.students[0].reason, "safety_incident_live");
    assert.equal((await as("t1")("POST", "/api/pickup/release", { code: guardianPass, studentIds: [ID.alice], idChecked: true })).status, 409);
  });

  it("SafetyOS: reunification releases through pick-up; all-clear needs the kind repeated; debrief after close", async () => {
    assert.equal((await as("t1")("POST", `/api/safety/incidents/${incident.id}/reunification`, { point: "Gym" })).status, 403);
    const r = await as("p1")("POST", `/api/safety/incidents/${incident.id}/reunification`, { point: "North gym doors" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const fam = (await as("pa")("GET", "/api/safety/status")).body.data.incidents[0];
    assert.equal(fam.status, "reunification"); assert.equal(fam.reunificationPoint, "North gym doors");
    assert.deepEqual(fam.children.map(c => [c.name, c.released]), [["Alice A", null]]);
    assert.equal((await as("t1")("POST", "/api/pickup/release", { code: guardianPass, studentIds: [ID.alice], idChecked: false })).status, 400, "photo ID check required");
    const rel = await as("t1")("POST", "/api/pickup/release", { code: guardianPass, studentIds: [ID.alice], idChecked: true });
    assert.equal(rel.status, 201, JSON.stringify(rel.body));
    assert.equal((await as("pa")("GET", "/api/safety/status")).body.data.incidents[0].children[0].released.adult, "Ruth Grandma");
    assert.match((await notes(USERS.pa[0], "pickup")).at(-1).title, /^Alice was picked up by Ruth Grandma \(Grandparent\) at /);
    assert.equal((await as("p1")("GET", `/api/safety/incidents/${incident.id}/board`)).body.data.totals.released, 1);
    assert.equal((await as("p1")("POST", `/api/safety/incidents/${incident.id}/events`, { event: "responders", detail: "Police on scene (drill role-play)" })).status, 200);
    assert.equal((await as("p1")("POST", `/api/safety/incidents/${incident.id}/debrief`, { text: "too early" })).status, 409);
    assert.equal((await as("p1")("POST", `/api/safety/incidents/${incident.id}/all-clear`, { kind: "hold" })).status, 400);
    const done = await as("p1")("POST", `/api/safety/incidents/${incident.id}/all-clear`, { kind: "lockdown" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    for (const who of ["pa", "pu", "t1"]) assert.equal((await as(who)("GET", "/api/safety/status")).body.data.incidents.length, 0, who);
    assert.match((await notes(USERS.pa[0], "safety")).at(-1).title, /all clear \(drill\)/);
    assert.equal((await as("p1")("POST", `/api/safety/incidents/${incident.id}/debrief`, { text: "Drill went well. Fix Room 12 door." })).status, 200);
    const evs = (await as("p1")("GET", `/api/safety/incidents/${incident.id}/board`)).body.data.events.map(e => e.event);
    assert.deepEqual(evs.slice(-5), ["reunification", "released", "responders", "all_clear", "debrief"]);
    const aud = (await admin.query("SELECT action FROM audit_events WHERE resource_type='safety_incident' ORDER BY occurred_at")).rows.map(r => r.action);
    for (const a of ["initiate", "confirm", "rollcall", "reunification", "all_clear", "debrief"]) assert.ok(aud.includes(a), a);
  });

  it("pick-up: do-not-release blocks and alerts the office; custody orders need acknowledgement; unknown passes are refused", async () => {
    const uncle = (await as("p1")("POST", "/api/pickup/adults", { studentId: ID.alice, fullName: "Victor Uncle", relationship: "Uncle" })).body.data;
    assert.equal(uncle.status, "approved", "school-added adults are approved");
    const up = (await as("p1")("POST", "/api/pickup/tags", { adultId: uncle.id })).body.data.code;
    assert.equal((await as("p1")("POST", "/api/pickup/restrictions", { studentId: ID.alice, kind: "do_not_release", personName: "victor uncle", detail: "Court order 2026-114: no contact." })).status, 201);
    const before = (await notes(USERS.p1[0], "pickup")).length;
    const v = await as("t1")("POST", "/api/pickup/verify", { code: up });
    assert.equal(v.status, 200); assert.equal(v.body.data.blocked, true); assert.equal(v.body.data.students[0].reason, "do_not_release");
    assert.equal((await notes(USERS.p1[0], "pickup")).length, before + 1, "office alerted");
    assert.equal((await as("t1")("POST", "/api/pickup/release", { code: up, studentIds: [ID.alice], idChecked: true })).status, 409);
    assert.equal((await asRole("parent", USERS.pa[0], ID.s1, "SELECT * FROM pickup_restrictions")).length, 0, "families never see restrictions");
    assert.equal((await asRole("teacher", USERS.t1[0], ID.s1, "SELECT * FROM pickup_restrictions")).length, 0, "nor do teachers (the lookup shows flags only)");
    // Custody order: release needs explicit acknowledgement.
    await as("p1")("POST", "/api/pickup/restrictions", { studentId: ID.alice, kind: "custody_order", detail: "Joint custody; check the schedule.", documentOnFile: true });
    const g = await as("pa")("POST", "/api/pickup/tags", { adultId: grandma });
    const cv = await as("t1")("POST", "/api/pickup/verify", { code: g.body.data.code });
    assert.equal(cv.body.data.students[0].custodyOrder, true); assert.match(cv.body.data.students[0].flagDetail, /Joint custody/);
    assert.equal((await as("t1")("POST", "/api/pickup/release", { code: g.body.data.code, studentIds: [ID.alice], idChecked: true })).body.error, "custody_order_acknowledgement_required");
    assert.equal((await as("t1")("POST", "/api/pickup/release", { code: g.body.data.code, studentIds: [ID.alice], idChecked: true, custodyAcknowledged: true })).status, 201);
    const old = await as("t1")("POST", "/api/pickup/verify", { code: guardianPass });
    assert.equal(old.body.data.pass, "revoked", "issuing a new pass for Ruth revoked the old one");
    assert.equal(old.body.data.students[0].eligible, false);
    assert.equal((await as("t1")("POST", "/api/pickup/verify", { code: "ZZZZZ-ZZZZZ" })).status, 404);
    assert.equal((await as("p2")("POST", "/api/pickup/verify", { code: g.body.data.code })).status, 404, "other school's staff");
    for (const who of ["pa", "pu", "drvs"]) assert.equal((await as(who)("POST", "/api/pickup/verify", { code: g.body.data.code })).status, 403, who);
    const q = (await as("t1")("GET", "/api/pickup/queue")).body.data;
    assert.equal(q.released.length, 1); assert.equal(q.released[0].name, "Alice A"); assert.ok(q.blocked + q.denied >= 0);
    await assert.rejects(asRole("principal", USERS.p1[0], ID.s1, "UPDATE pickup_events SET reason='x'"), /permission denied|append-only/);
  });

  it("early dismissal, school time zone, retention and FERPA coverage", async () => {
    const today = (await admin.query("SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS d")).rows[0].d;
    const ed = await as("pa")("POST", "/api/pickup/early-dismissals", { studentId: ID.alice, adultId: grandma, date: today, time: "13:30", reason: "Dentist" });
    assert.equal(ed.status, 201, JSON.stringify(ed.body));
    assert.equal((await as("p1")("POST", `/api/pickup/early-dismissals/${ed.body.data.id}/decision`, { decision: "approve" })).status, 200);
    assert.equal((await as("t1")("GET", "/api/pickup/queue")).body.data.earlyDismissals[0].student_name, "Alice A");
    // Time zone: invalid names are refused; "today" follows the school's zone.
    assert.equal((await as("supt1")("PATCH", `/api/schools/${ID.s1}`, { timezone: "Mars/Olympus" })).status, 400);
    assert.equal((await as("supt1")("PATCH", `/api/schools/${ID.s1}`, { timezone: "Etc/GMT-14" })).status, 200);
    const tz = await asRole("principal", USERS.p1[0], ID.s1, "SELECT eduos_school_today($1)::text AS school, (now() AT TIME ZONE 'Etc/GMT-14')::date::text AS want", [ID.s1]);
    assert.equal(tz[0].school, tz[0].want);
    await as("supt1")("PATCH", `/api/schools/${ID.s1}`, { timezone: "America/New_York" });
    // Retention runs as the owner and covers the 32.4/32.5 tables.
    const owner = new pg.Client(db.ownerUrl); await owner.connect();
    await owner.query("BEGIN"); await owner.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
    const counts = (await owner.query(`SELECT eduos_retention_purge_role_apps('{"notificationDays":180,"christieDays":365,"transportDays":400,"commsDays":730,"safetyDays":2555,"pickupTagDays":30}'::jsonb) AS c`)).rows[0].c;
    await owner.query("ROLLBACK"); await owner.end();
    for (const k of ["notifications", "christie_sessions", "transport_runs", "comms_threads", "pickup_tags", "pickup_events", "safety_incidents"]) assert.ok(k in counts, k);
    await assert.rejects(asRole("principal", USERS.p1[0], ID.s1, `SELECT eduos_retention_purge_role_apps('{}'::jsonb)`), /permission denied/);
    // FERPA export and delete include the new records.
    const exp = await as("supt1")("POST", `/api/students/${ID.alice}/records-export`, {});
    assert.equal(exp.status, 200, JSON.stringify(exp.body).slice(0, 300));
    const rec = exp.body.data || exp.body;
    assert.ok(rec.pickupEvents.length >= 3 && rec.safetyRollcall.length >= 2 && rec.pickupAdults.length >= 3, Object.keys(rec).join(","));
    const del = await as("supt1")("POST", `/api/students/${ID.alice}/records-delete`, { confirmLocalStudentNumber: "S1-A", reason: "Integration test: FERPA deletion request." });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    for (const k of ["pickup_events", "pickup_adults", "rollcall_entries", "transport_checkins"]) assert.ok(k in del.body.counts || k in (del.body.data?.counts || {}), k);
    for (const t of ["pickup_events", "pickup_adults", "pickup_restrictions", "safety_rollcall_entries", "pickup_early_dismissals"])
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${t} WHERE student_id=$1`, [ID.alice])).rows[0].n, 0, t);
  });
});
