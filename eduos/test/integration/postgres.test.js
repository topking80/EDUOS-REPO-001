// End-to-end regression tests against a real PostgreSQL server (32.0.53).
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readdir } from "node:fs/promises";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const today = new Date().toISOString().slice(0, 10);

describe("EduOS against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, env, s = {};
  const as = name => client(server.base, s[name]);
  const sql = (text, params) => admin.query(text, params);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "p1", "p2", "t1", "pa", "pu", "pb", "tp"])
      s[name] = await login(server.base, idp, name, { email_verified: true });
    for (const name of Object.keys(s)) assert.ok(s[name].cookie, `${name} login failed: ${JSON.stringify(s[name])}`);
  });
  after(async () => {
    await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop();
  });

  // ---- Finding 1: runtime role and RLS ----
  it("H1: migrate applied the grants to a non-superuser, non-BYPASSRLS runtime role", async () => {
    const role = (await sql("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1", [db.names.app])).rows[0];
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    const owner = (await sql("SELECT tableowner FROM pg_tables WHERE tablename='students'")).rows[0].tableowner;
    assert.equal(owner, db.names.owner);
  });
  it("H1: the API refuses to start as a superuser or as the table owner", async () => {
    const asSuper = await run(["src/server.js"], { ...env, PORT: "1", DATABASE_URL: db.adminUrl });
    assert.notEqual(asSuper.code, 0); assert.match(asSuper.out, /superuser|BYPASSRLS/i);
    const asOwner = await run(["src/server.js"], { ...env, PORT: "1", DATABASE_URL: db.ownerUrl });
    assert.notEqual(asOwner.code, 0); assert.match(asOwner.out, /owns/i);
  });
  it("32.0.54: the API refuses to start when a migration is missing", async () => {
    const last = (await sql("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1")).rows[0].name;
    await sql("DELETE FROM schema_migrations WHERE name=$1", [last]);
    try {
      const r = await run(["src/server.js"], { ...env, PORT: "1", DATABASE_URL: db.appUrl });
      assert.notEqual(r.code, 0); assert.match(r.out, new RegExp(`1 migration\\(s\\) not applied \\(${last.replace(".", "\\.")}\\).*db:migrate`));
    } finally { await sql("INSERT INTO schema_migrations(name) VALUES ($1)", [last]); }
    const ok = await run(["-e", `import("./src/db.js").then(m=>m.assertSchemaReady()).then(n=>{console.log("ready",n);process.exit(0)},e=>{console.error(e.message);process.exit(1)})`],
      { ...env, DATABASE_URL: db.appUrl });
    const migrationCount = (await readdir(new URL("../../db/", import.meta.url))).filter(f => /^\d{3}_.*\.sql$/.test(f)).length;
    assert.equal(ok.code, 0, ok.out); assert.match(ok.out, new RegExp(`ready ${migrationCount}\\b`));
  });
  it("H1: migrate refuses to grant to a superuser runtime role", async () => {
    const r = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl, EDUOS_APP_ROLE: new URL(PG_URL).username || "postgres" });
    assert.notEqual(r.code, 0); assert.match(r.out, /superuser|BYPASSRLS/i);
  });
  it("H1: RLS isolates districts for the runtime role", async () => {
    const r = await as("supt1")("GET", "/api/students");
    assert.equal(r.status, 200);
    assert.ok(!r.body.data.some(st => st.id === ID.xavier), "district 2 student leaked");
  });

  // ---- Finding 2: complete runtime grants ----
  it("H2: family messaging, classroom preferences, SIS runs and guardian links work as the runtime role", async () => {
    const msg = await as("pa")("POST", "/api/family/messages", { studentId: ID.alice, recipientUserId: USERS.p1[0], body: "Hello from Parent A" });
    assert.equal(msg.status, 201, JSON.stringify(msg.body));
    assert.equal((await as("pa")("GET", "/api/family/messages")).status, 200);
    const pref = await as("t1")("PUT", "/api/teacher/classroom-preferences",
      { schoolId: ID.s1, roomLabel: "Room 12", floorNumber: 1, layout: "rows", seatPosition: "front-left" });
    assert.ok([200, 201].includes(pref.status), JSON.stringify(pref.body));
    assert.equal((await as("supt1")("GET", "/api/integrations/sis/runs")).status, 200);
  });
  it("H2: every tenant table used by the API is granted to the runtime role", async () => {
    const r = await sql(`SELECT t.tablename FROM pg_tables t WHERE t.schemaname='public'
      AND NOT has_table_privilege($1, format('%I.%I', t.schemaname, t.tablename), 'SELECT')`, [db.names.app]);
    // 32.6.0: edal_heads (the ledger's chain head) is deliberately reachable only through definer functions;
    // so is webhook_delivery_slots (2026-11-17 audit, the deployment-wide delivery ceiling; migration 067),
    // classroom_pair_codes (DEV-02, migration 109) and classroom_checkin_codes (ROOM-01, migration 111): codes
    // are made and used only by definer functions.
    const definerOnly = ["edal_heads", "webhook_delivery_slots", "lti_launch_replays", "classroom_pair_codes", "classroom_checkin_codes"];
    assert.deepEqual(r.rows.map(x => x.tablename).filter(t => !definerOnly.includes(t)), []);
    for (const fn of ["eduos_webhook_slot_acquire(integer,integer)", "eduos_webhook_slot_release(uuid)", "eduos_webhook_slots_free(integer)"])
      assert.ok((await sql("SELECT has_function_privilege($1,$2,'EXECUTE') AS ok", [db.names.app, fn])).rows[0].ok, fn);
    for (const [table, priv] of [["students", "INSERT"], ["students", "UPDATE"], ["student_user_links", "INSERT"], ["student_user_links", "UPDATE"],
      ["family_messages", "INSERT"], ["teacher_classroom_preferences", "UPDATE"], ["sis_sync_runs", "INSERT"], ["sis_attendance_imports", "INSERT"],
      // Missing through 37.4.0 (audit addendum 2): library policy upsert, overdue notices, ops schedules.
      ["library_borrowing_policies", "INSERT"], ["library_borrowing_policies", "UPDATE"], ["library_notice_ledger", "INSERT"],
      ["school_operation_schedules", "INSERT"], ["school_operation_schedules", "UPDATE"]])
      assert.ok((await sql("SELECT has_table_privilege($1,$2,$3) AS ok", [db.names.app, table, priv])).rows[0].ok, `${table} ${priv}`);
    assert.equal((await sql("SELECT has_table_privilege($1,'audit_events','DELETE') AS ok", [db.names.app])).rows[0].ok, false);
  });

  it("H2b: every RLS policy helper is explicitly executable by the runtime role (not only via PUBLIC)", async () => {
    // Audit 37.4.0 item 3. A function referenced by a policy must carry an explicit
    // EXECUTE grant to the runtime role, so revoking PUBLIC EXECUTE later can't
    // silently break row-level security.
    const r = await sql(`SELECT DISTINCT p.oid::regprocedure::text AS fn
      FROM pg_depend d
      JOIN pg_policy pol ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid
      JOIN pg_proc p ON d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE a.grantee = $1::regrole AND a.privilege_type = 'EXECUTE')
      ORDER BY 1`, [db.names.app]);
    assert.deepEqual(r.rows.map(x => x.fn), []);
    const helpers = (await sql(`SELECT count(DISTINCT d.refobjid)::int AS n FROM pg_depend d
      WHERE d.classid = 'pg_policy'::regclass AND d.refclassid = 'pg_proc'::regclass`)).rows[0].n;
    assert.ok(helpers >= 37, `expected the 37.4.0 policy helpers to be found, got ${helpers}`);
  });

  // ---- Finding 3: SIS import school scope ----
  it("H3: a school-scoped schools:update grant cannot import into another school", async () => {
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    const req = await as("t1")("POST", "/api/access-requests", { resource: "schools", action: "update", reason: "Need to run the nightly SIS import for S1", expiresAt });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    const decision = await as("supt1")("POST", `/api/access-requests/${req.body.data.id}/decision`, { decision: "approved" });
    assert.equal(decision.status, 200, JSON.stringify(decision.body));
    const batch = (schoolId, n) => ({ schoolId, sourceSystem: "it-sis", sourceBatchId: `batch-${n}`,
      students: [{ localStudentNumber: `IMP-${n}`, displayName: "Imported Learner", gradeLevel: "2" }] });
    const cross = await as("t1")("POST", "/api/integrations/sis/import", batch(ID.s2, 1));
    assert.equal(cross.status, 403); assert.equal(cross.body.error, "school_scope_denied");
    assert.equal((await sql("SELECT count(*)::int AS n FROM students WHERE local_student_number='IMP-1'")).rows[0].n, 0);
    const own = await as("t1")("POST", "/api/integrations/sis/import", batch(ID.s1, 2));
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal((await sql("SELECT school_id FROM students WHERE local_student_number='IMP-2'")).rows[0].school_id, ID.s1);
  });

  // ---- Finding 4 + 9: guardian invitations ----
  it("H4/M9: ordinary guardian emails are accepted and the invitation needs an IdP-verified email", async () => {
    const bad = await as("p1")("POST", "/api/guardian-invitations", { studentId: ID.bob, email: "not an email" });
    assert.equal(bad.status, 400);
    const inv = await as("p1")("POST", "/api/guardian-invitations", { studentId: ID.alice, email: "Parent.Bob@D1.test" });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const token = decodeURIComponent(inv.body.invitationUrl.split("guardianInvite=")[1]);
    // Same account, but the IdP did not assert a verified email this time.
    const unverified = await login(server.base, idp, "pb", { email_verified: false });
    assert.ok(unverified.cookie, "login must not be blocked by email_verified=false (Entra ID)");
    const denied = await client(server.base, unverified)("POST", "/api/guardian-invitations/accept", { token });
    assert.equal(denied.status, 403); assert.equal(denied.body.error, "idp_verified_email_required");
    const ok = await as("pb")("POST", "/api/guardian-invitations/accept", { token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    s.pb = await login(server.base, idp, "pb", { email_verified: true }); // unverified login revoked nothing of s.pb, refresh anyway
  });

  // ---- Finding 5: audit scope ----
  it("M5: a principal only sees audit events from their own school", async () => {
    await as("p2")("GET", `/api/student-360/${ID.carol}`); // creates an S2 read audit row
    const s2rows = (await sql("SELECT count(*)::int AS n FROM audit_events WHERE school_id=$1", [ID.s2])).rows[0].n;
    assert.ok(s2rows > 0);
    const r = await as("p1")("GET", "/api/audit");
    assert.equal(r.status, 200);
    const ids = r.body.data.map(e => e.id);
    const s2ids = (await sql("SELECT id FROM audit_events WHERE school_id=$1 OR school_id IS NULL", [ID.s2])).rows.map(x => x.id);
    assert.ok(r.body.data.length > 0);
    assert.ok(!ids.some(id => s2ids.includes(id)), "principal saw another school's or district-wide audit rows");
  });

  // ---- Finding 6: draft assignments ----
  it("M6: parents and pupils never see draft assignments", async () => {
    for (const who of ["pa", "pu"]) {
      const r = await as(who)("GET", "/api/assignments");
      assert.equal(r.status, 200);
      const titles = r.body.data.map(a => a.title);
      assert.ok(titles.includes("Published reading"), `${who}: ${titles}`);
      assert.ok(!titles.includes("DRAFT secret quiz"), `${who} saw a draft`);
    }
    const sum = await as("pa")("GET", `/api/family/children/${ID.alice}/summary`);
    assert.ok(!JSON.stringify(sum.body).includes("DRAFT secret quiz"));
  });

  // ---- Finding 7: teacher roster ----
  it("M7: teachers only see rostered students; principals manage rosters", async () => {
    const before = await as("t1")("GET", "/api/students");
    assert.deepEqual(before.body.data, []);
    assert.equal((await as("t1")("GET", `/api/students/${ID.bob}`)).status, 404);
    assert.equal((await as("t1")("POST", "/api/rosters", { teacherUserId: USERS.t1[0], studentId: ID.alice })).status, 403);
    assert.equal((await as("p1")("POST", "/api/rosters", { teacherUserId: USERS.t1[0], studentId: ID.carol })).status, 404);
    assert.equal((await as("p1")("POST", "/api/rosters", { teacherUserId: USERS.t1[0], studentId: ID.alice })).status, 201);
    const after = await as("t1")("GET", "/api/students");
    assert.deepEqual(after.body.data.map(x => x.id), [ID.alice]);
    assert.equal((await as("t1")("GET", `/api/students/${ID.alice}`)).status, 200);
    assert.equal((await as("t1")("POST", "/api/attendance", { studentId: ID.bob, eventDate: today, status: "present" })).status, 404);
    const caseBob = await as("p1")("POST", "/api/cases", { studentId: ID.bob, category: "academic", title: "Bob reading", summary: "Reading support" });
    assert.equal(caseBob.status, 201);
    const cases = await as("t1")("GET", "/api/cases");
    assert.ok(!cases.body.data.some(c => c.id === caseBob.body.data.id), "teacher saw an unrostered learner's case");
  });

  // ---- Finding 12: FERPA reads, export, delete, retention ----
  it("M12: student record reads are audited", async () => {
    await as("p1")("GET", `/api/students/${ID.bob}`);
    const r = await sql("SELECT actor_role,school_id FROM audit_events WHERE action='read' AND resource_id=$1 ORDER BY occurred_at DESC LIMIT 1", [ID.bob]);
    assert.deepEqual(r.rows[0], { actor_role: "principal", school_id: ID.s1 });
  });
  it("M12: record export, superintendent-only delete and audit retention", async () => {
    const exp = await as("p1")("POST", `/api/students/${ID.bob}/records-export`, {});
    assert.equal(exp.status, 200); assert.equal(exp.body.student.local_student_number, "S1-B");
    assert.equal((await as("p1")("POST", `/api/students/${ID.bob}/records-delete`, { confirmLocalStudentNumber: "S1-B", reason: "Parent requested deletion under FERPA policy" })).status, 403);
    assert.equal((await as("supt1")("POST", `/api/students/${ID.bob}/records-delete`, { confirmLocalStudentNumber: "WRONG", reason: "Parent requested deletion under FERPA policy" })).status, 409);
    const del = await as("supt1")("POST", `/api/students/${ID.bob}/records-delete`, { confirmLocalStudentNumber: "S1-B", reason: "Parent requested deletion under FERPA policy" });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal((await sql("SELECT count(*)::int AS n FROM students WHERE id=$1", [ID.bob])).rows[0].n, 0);
    assert.equal((await sql("SELECT count(*)::int AS n FROM student_intervention_cases WHERE student_id=$1", [ID.bob])).rows[0].n, 0);
    assert.equal((await sql("SELECT count(*)::int AS n FROM student_case_notes WHERE student_id=$1", [ID.bob])).rows[0].n, 0);
    // The runtime role still cannot delete append-only rows directly.
    const app = new pg.Client(db.appUrl); await app.connect();
    await assert.rejects(app.query("DELETE FROM audit_events"), /permission denied/);
    await assert.rejects(app.query("SELECT eduos_retention_purge(1,1,1,1)"), /permission denied/);
    await app.end();
    // Retention CLI (owner role) prunes rows older than the configured windows.
    await sql(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,outcome,occurred_at) VALUES($1,$2,'superintendent','old','test','success',now()-interval '400 days')`, [ID.d1, USERS.supt1[0]]);
    await sql("UPDATE sessions SET expires_at=now()-interval '60 days' WHERE user_id=$1", [USERS.pu[0]]);
    const ret = await run(["src/retention.js"], { ...env, DATABASE_URL: db.ownerUrl, RETENTION_AUDIT_DAYS: "365" });
    assert.equal(ret.code, 0, ret.out);
    assert.equal((await sql("SELECT count(*)::int AS n FROM audit_events WHERE action='old'")).rows[0].n, 0);
    assert.ok((await sql("SELECT count(*)::int AS n FROM audit_events")).rows[0].n > 0, "recent audit rows kept");
    assert.equal((await sql("SELECT count(*)::int AS n FROM sessions WHERE user_id=$1", [USERS.pu[0]])).rows[0].n, 0);
    s.pu = await login(server.base, idp, "pu", { email_verified: true });
  });

  // ---- Findings 15 + 19: flow feed scope and dates ----
  it("L15/L19: attendance events are scoped to the learner's family and dates stay YYYY-MM-DD", async () => {
    const rec = await as("supt1")("POST", "/api/attendance", { studentId: ID.alice, eventDate: today, status: "tardy" });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    assert.equal(rec.body.data.event_date, today);
    // Flow events are recorded asynchronously after the response.
    let ev;
    for (let i = 0; i < 40 && !ev; i++) {
      ev = (await sql("SELECT school_id, subject_student_id FROM flow_events WHERE event_type='attendance.recorded' ORDER BY occurred_at DESC LIMIT 1")).rows[0];
      if (!ev) await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(ev, `no flow event recorded: ${server.log()}`);
    assert.deepEqual(ev, { school_id: ID.s1, subject_student_id: ID.alice });
    const fa = await as("pa")("GET", "/api/flow-events");
    assert.ok(fa.body.data.some(e => e.type === "attendance.recorded"), "the learner's own parent sees the event");
    const fb = await as("pb")("GET", "/api/flow-events");
    assert.ok(!fb.body.data.some(e => e.type === "attendance.recorded" && e.refs?.attendanceId === rec.body.data.id), "another family saw the event");
    const list = await as("pa")("GET", "/api/attendance");
    assert.ok(list.body.data.every(a => /^\d{4}-\d{2}-\d{2}$/.test(a.event_date)));
  });

  // ---- Finding 16 + 17 ----
  it("L16: GET /api/csrf is stable and does not invalidate earlier tokens", async () => {
    const a = await (await fetch(`${server.base}/api/csrf`, { headers: { cookie: s.p1.cookie } })).json();
    const b = await (await fetch(`${server.base}/api/csrf`, { headers: { cookie: s.p1.cookie } })).json();
    assert.equal(a.csrfToken, b.csrfToken);
    assert.equal((await as("p1")("POST", "/api/rosters", { teacherUserId: USERS.t1[0], studentId: ID.alice })).status, 201);
  });
  it("L17: malformed JSON is 400 and oversized bodies are 413", async () => {
    const bad = await as("p1")("POST", "/api/cases", "{not json");
    assert.equal(bad.status, 400); assert.equal(bad.body.error, "invalid_json");
    const big = await as("p1")("POST", "/api/cases", JSON.stringify({ summary: "x".repeat(2_000_000) }));
    assert.equal(big.status, 413);
  });

  // ---- Finding 18 ----
  it("L18: principals keep classroom preferences to their school; case owners must be staff", async () => {
    const pref = await as("p1")("PUT", "/api/teacher/classroom-preferences", { schoolId: ID.s2, roomLabel: "X", floorNumber: 1, layout: "rows", seatPosition: "front-left" });
    assert.equal(pref.status, 403);
    const c = await as("p1")("POST", "/api/cases", { studentId: ID.alice, category: "academic", title: "Owner check", summary: "x", ownerUserId: USERS.pa[0] });
    assert.equal(c.status, 400); assert.equal(c.body.error, "invalid_case_owner");
    const ok = await as("p1")("POST", "/api/cases", { studentId: ID.alice, category: "academic", title: "Owner check", summary: "x", ownerUserId: USERS.t1[0] });
    assert.equal(ok.status, 201);
  });

  // ---- Finding 23 ----
  it("L23: permissions without an enforcing route cannot be requested", async () => {
    const r = await as("p1")("POST", "/api/access-requests", { resource: "cases", action: "export", reason: "Need to export every case for a report", expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    assert.equal(r.status, 400);
  });

  // ---- Finding 24 ----
  it("L24: an account can hold several roles and switch between them", async () => {
    const m = await as("tp")("GET", "/api/memberships");
    assert.equal(m.status, 200);
    assert.deepEqual(m.body.data.map(x => x.role).sort(), ["parent", "teacher"]);
    const parent = m.body.data.find(x => x.role === "parent");
    const sw = await as("tp")("POST", "/api/session/membership", { membershipId: parent.id });
    assert.equal(sw.status, 200, JSON.stringify(sw.body));
    const cookie = sw.headers.getSetCookie().map(c => c.split(";")[0]).find(c => c.startsWith("eduos_session=") && !c.endsWith("="));
    const me = await (await fetch(`${server.base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.role ?? me.data?.role ?? me.actor?.role, "parent");
    assert.equal((await as("tp")("GET", "/api/me")).status, 401, "the previous session is revoked after switching");
    const kids = await (await fetch(`${server.base}/api/family/children`, { headers: { cookie } })).json();
    assert.deepEqual(kids.data.map(k => k.id), [ID.alice]);
  });
  it("UI-05: profiles in two districts are listed with their school and district, and switching moves the session there", async () => {
    const tpId = USERS.tp[0];
    await admin.query("INSERT INTO district_users(district_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [ID.d2, tpId]);
    const ins = await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,'parent',false) RETURNING id", [tpId, ID.d2, ID.sd2]);
    try {
      const s = await login(server.base, idp, "tp", { email_verified: true });
      const list = (await client(server.base, s)("GET", "/api/memberships")).body.data;
      const d2 = list.find(m => m.district_id === ID.d2);
      assert.equal(d2.school_name, "D2-S"); assert.equal(d2.district_name, "D2");
      assert.ok(list.filter(m => m.district_id === ID.d1).every(m => m.school_name === "S1"), JSON.stringify(list));
      assert.equal(list.filter(m => m.current).length, 1, "exactly one current profile");
      const sw = await client(server.base, s)("POST", "/api/session/membership", { membershipId: d2.id });
      assert.equal(sw.status, 200, JSON.stringify(sw.body));
      const cookie = sw.headers.getSetCookie().map(c => c.split(";")[0]).find(c => c.startsWith("eduos_session=") && !c.endsWith("="));
      const me = await (await fetch(`${server.base}/api/me`, { headers: { cookie } })).json();
      assert.equal(me.districtId, ID.d2); assert.equal(me.schoolId, ID.sd2); assert.equal(me.role, "parent");
      const after = (await (await fetch(`${server.base}/api/memberships`, { headers: { cookie } })).json()).data;
      assert.equal(after.find(m => m.current)?.id, d2.id);
      assert.ok(after.filter(m => m.district_id === ID.d1).every(m => m.school_name === "S1"), "names resolve from the other district too");
    } finally { await admin.query("DELETE FROM memberships WHERE id=$1", [ins.rows[0].id]); }
  });
  it("L24: a parent with children at two schools can accept an invitation at the second school", async () => {
    const inv = await as("p2")("POST", "/api/guardian-invitations", { studentId: ID.carol, email: "two.school@d1.test" });
    assert.equal(inv.status, 201);
    const token = decodeURIComponent(inv.body.invitationUrl.split("guardianInvite=")[1]);
    const p2s = await login(server.base, idp, "p2s", { email_verified: true });
    const ok = await client(server.base, p2s)("POST", "/api/guardian-invitations/accept", { token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // UI-04: the family switcher names each school and district, and sees every child with their school.
    const mems = (await client(server.base, p2s)("GET", "/api/memberships")).body.data.filter(m => m.role === "parent");
    assert.ok(mems.length >= 2, JSON.stringify(mems));
    for (const m of mems) { assert.ok(m.school_name, `school name for ${m.school_id}`); assert.ok(m.district_name); }
    const kids = (await client(server.base, p2s)("GET", "/api/family/children")).body.data;
    assert.ok(kids.some(k => k.id === ID.carol) && kids.every(k => k.school_id && k.school_name), JSON.stringify(kids));
  });
});

describe("EduOS session hardening against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, env;
  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, SESSION_MAX_PER_USER: "2", SESSION_IDLE_MINUTES: "5" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });
  const me = sess => fetch(`${server.base}/api/me`, { headers: { cookie: sess.cookie } }).then(r => r.status);

  it("L21: pending OIDC logins live in the database and are single use", async () => {
    const start = await fetch(`${server.base}/auth/login`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM oidc_pending_logins")).rows[0].n, 1);
    const sess = await login(server.base, idp, "t1");
    assert.ok(sess.cookie);
    const replay = await fetch(`${server.base}/auth/callback?code=x&state=${encodeURIComponent(sess.state)}`, { redirect: "manual" });
    assert.notEqual(replay.status, 303);
    assert.ok(state);
  });
  it("L21: logging in again from the same browser revokes the previous session", async () => {
    const first = await login(server.base, idp, "p1");
    const second = await login(server.base, idp, "p1", {}, first.cookie);
    assert.equal(await me(first), 401); assert.equal(await me(second), 200);
  });
  it("L21: concurrent sessions per user are capped", async () => {
    const a = await login(server.base, idp, "p2"), b = await login(server.base, idp, "p2"), c = await login(server.base, idp, "p2");
    assert.equal(await me(a), 401); assert.equal(await me(b), 200); assert.equal(await me(c), 200);
  });
  it("L21: idle sessions expire", async () => {
    const sess = await login(server.base, idp, "pa");
    assert.equal(await me(sess), 200);
    await admin.query("UPDATE sessions SET last_seen_at=now()-interval '10 minutes' WHERE user_id=$1", [USERS.pa[0]]);
    // The optional session cache (SESSION_CACHE_TTL_MS) is off here.
    assert.equal(await me(sess), 401);
  });
});


describe("TC-01 student history and Time Capsule schema against real PostgreSQL", { skip }, () => {
  let db, admin, app;
  before(async () => {
    db = await createDatabase();
    const env = baseEnv({ EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, "https://tc01.integration.test");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => {
    await app?.end();
    await admin?.end();
    await db?.drop();
  });

  const expectDenied = async work => {
    await app.query("SAVEPOINT expected_denial");
    try {
      await assert.rejects(work(), error => error.code === "42501");
    } finally {
      await app.query("ROLLBACK TO SAVEPOINT expected_denial");
      await app.query("RELEASE SAVEPOINT expected_denial");
    }
  };

  const scoped = async (districtId, schoolId, role, userId, work) => {
    await app.query("BEGIN");
    try {
      await app.query(
        "SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true), set_config('app.role',$3,true), set_config('app.user_id',$4,true)",
        [districtId, schoolId || "", role, userId || ""]
      );
      const value = await work();
      await app.query("COMMIT");
      return value;
    } catch (error) {
      await app.query("ROLLBACK");
      throw error;
    }
  };

  it("TC-01: runtime grants exclude history approval and capsule lifecycle columns", async () => {
    const denied = [
      ["student_history_entries", "status"],
      ["student_time_capsules", "status"],
      ["student_time_capsules", "release_kind"],
      ["student_time_capsules", "release_at"],
      ["student_time_capsules", "milestone_key"],
      ["student_time_capsules", "sealed_at"],
      ["student_time_capsules", "released_at"],
      ["student_time_capsules", "cancelled_at"]
    ];
    for (const [table, column] of denied) {
      const result = await admin.query(
        "SELECT has_column_privilege($1,$2,$3,'UPDATE') AS allowed",
        [db.names.app, table, column]
      );
      assert.equal(result.rows[0].allowed, false, `${table}.${column} must be workflow-controlled`);
    }
    for (const [table, column] of [["student_history_entries", "title"], ["student_time_capsules", "title"]]) {
      const result = await admin.query(
        "SELECT has_column_privilege($1,$2,$3,'UPDATE') AS allowed",
        [db.names.app, table, column]
      );
      assert.equal(result.rows[0].allowed, true, `${table}.${column} remains editable`);
    }
  });

  it("isolates history by district and originating school and captures immutable revisions", async () => {
    // Who may write and see which entries is covered in
    // student-history-privacy.test.js (088); these are school-wide official
    // records, written by each school's or district's leadership.
    const alice = await scoped(ID.d1, ID.s1, "principal", USERS.p1[0], async () =>
      (await app.query(`
        INSERT INTO student_history_entries
          (district_id, school_id, student_id, entry_type, classification, title, occurred_at, source_type, author_user_id, audience, status)
        VALUES ($1,$2,$3,'achievement','official_record','Alice milestone',now(),'school',$4,'school','published')
        RETURNING id, revision_no
      `, [ID.d1, ID.s1, ID.alice, USERS.p1[0]])).rows[0]);
    await scoped(ID.d1, ID.s2, "principal", USERS.p2[0], async () =>
      app.query(`
        INSERT INTO student_history_entries
          (district_id, school_id, student_id, entry_type, classification, title, occurred_at, source_type, author_user_id, audience, status)
        VALUES ($1,$2,$3,'event','official_record','Carol school event',now(),'school',$4,'school','published')
      `, [ID.d1, ID.s2, ID.carol, USERS.p2[0]]));
    await scoped(ID.d2, "", "superintendent", USERS.supt2[0], async () =>
      app.query(`
        INSERT INTO student_history_entries
          (district_id, school_id, student_id, entry_type, classification, title, occurred_at, source_type, author_user_id, audience, status)
        VALUES ($1,$2,$3,'achievement','official_record','Xavier milestone',now(),'district',$4,'school','published')
      `, [ID.d2, ID.sd2, ID.xavier, USERS.supt2[0]]));
    // Alice's teacher.
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$3) ON CONFLICT DO NOTHING",
      [ID.d1, ID.s1, USERS.t1[0], ID.alice]);
    assert.equal(alice.revision_no, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM student_history_entry_revisions WHERE entry_id=$1", [alice.id])).rows[0].n, 1);

    const schoolOne = await scoped(ID.d1, ID.s1, "teacher", USERS.t1[0], async () => {
      const visible = await app.query("SELECT id FROM student_history_entries ORDER BY id");
      assert.deepEqual(visible.rows.map(row => row.id), [alice.id]);
      const teacherEdit = await app.query("UPDATE student_history_entries SET title='teacher edit' WHERE id=$1", [alice.id]);
      assert.equal(teacherEdit.rowCount, 0, "a teacher reads the official record but can't edit it");
      await expectDenied(() => app.query("INSERT INTO student_history_entries (district_id,school_id,student_id,entry_type,classification,title,occurred_at,source_type) VALUES ($1,$2,$3,'event','family_memory','cross-school attempt',now(),'guardian')", [ID.d1, ID.s2, ID.carol]));
      return visible.rows.length;
    });
    assert.equal(schoolOne, 1);
    await scoped(ID.d1, ID.s1, "principal", USERS.p1[0], async () => {
      const changed = await app.query("UPDATE student_history_entries SET title='Alice milestone revised' WHERE id=$1 RETURNING revision_no", [alice.id]);
      assert.equal(changed.rows[0].revision_no, 2);
      await expectDenied(() => app.query("UPDATE student_history_entries SET student_id=$1 WHERE id=$2", [ID.carol, alice.id]));
    });

    const districtWide = await scoped(ID.d1, "", "superintendent", USERS.supt1[0], async () =>
      (await app.query("SELECT count(*)::int AS n FROM student_history_entries")).rows[0].n);
    assert.equal(districtWide, 2);
    // A superintendent's session has no school (their membership is district-wide).
    const otherDistrict = await scoped(ID.d2, "", "superintendent", USERS.supt2[0], async () =>
      (await app.query("SELECT count(*)::int AS n FROM student_history_entries")).rows[0].n);
    assert.equal(otherDistrict, 1);

    const revisions = await admin.query(
      "SELECT revision_no, snapshot->>'title' AS title, actor_user_id FROM student_history_entry_revisions WHERE entry_id=$1 ORDER BY revision_no",
      [alice.id]
    );
    assert.deepEqual(revisions.rows.map(row => [row.revision_no, row.title]), [
      [1, "Alice milestone"], [2, "Alice milestone revised"]
    ]);
    assert.equal(revisions.rows[1].actor_user_id, USERS.p1[0]);

    const capsuleRefs = {};
    await scoped(ID.d1, ID.s1, "parent", USERS.pa[0], async () => {
      const capsule = (await app.query(`
        INSERT INTO student_time_capsules
          (district_id, school_id, student_id, owner_user_id, title, release_kind, release_at)
        VALUES ($1,$2,$3,$4,'Graduation capsule','scheduled',now()+interval '1 day')
        RETURNING id
      `, [ID.d1, ID.s1, ID.alice, USERS.pa[0]])).rows[0];
      capsuleRefs.id = capsule.id;
      await app.query(`
        INSERT INTO student_time_capsule_items
          (district_id, school_id, student_id, capsule_id, entry_id, entry_revision_no, position)
        VALUES ($1,$2,$3,$4,$5,2,0)
      `, [ID.d1, ID.s1, ID.alice, capsule.id, alice.id]);
      await app.query(`
        INSERT INTO student_time_capsule_recipients
          (district_id, school_id, student_id, capsule_id, recipient_user_id, recipient_type)
        VALUES ($1,$2,$3,$4,$5,'student')
      `, [ID.d1, ID.s1, ID.alice, capsule.id, USERS.pu[0]]);
      await app.query(`
        INSERT INTO student_time_capsule_events
          (district_id, school_id, student_id, capsule_id, actor_user_id, event_type)
        VALUES ($1,$2,$3,$4,$5,'created')
      `, [ID.d1, ID.s1, ID.alice, capsule.id, USERS.pa[0]]);
      await expectDenied(() => app.query("INSERT INTO student_history_entry_revisions (district_id,school_id,student_id,entry_id,revision_no,snapshot) VALUES ($1,$2,$3,$4,99,'{}'::jsonb)", [ID.d1, ID.s1, ID.alice, alice.id]));
      await expectDenied(() => app.query("UPDATE student_history_entry_revisions SET revision_no=9 WHERE entry_id=$1", [alice.id]));
      await expectDenied(() => app.query("DELETE FROM student_history_entries WHERE id=$1", [alice.id]));
    });
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM student_time_capsule_items WHERE entry_id=$1", [alice.id])).rows[0].n, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM student_time_capsule_events")).rows[0].n, 1);

    // Seed a private registry object as the database owner, then create its
    // metadata attachment as the scoped runtime role.
    const activity = (await admin.query(`
      INSERT INTO school_activities (district_id,school_id,kind,title,created_by)
      VALUES ($1,$2,'club','TC-01 media fixture',$3)
      RETURNING id
    `, [ID.d1, ID.s1, USERS.t1[0]])).rows[0].id;
    const asset = (await admin.query(`
      INSERT INTO activity_media_assets
        (district_id,school_id,activity_id,media_kind,storage_key,mime_type,byte_size,uploaded_by)
      VALUES ($1,$2,$3,'image','tc01/alice/history-image','image/jpeg',1024,$4)
      RETURNING id
    `, [ID.d1, ID.s1, activity, USERS.t1[0]])).rows[0].id;
    await admin.query(`
      INSERT INTO private_media_objects
        (asset_id,district_id,school_id,storage_key,media_kind,mime_type,byte_size,scan_status,processing_status)
      VALUES ($1,$2,$3,'tc01/alice/history-image','image','image/jpeg',1024,'clean','processed')
    `, [asset, ID.d1, ID.s1]);
    await scoped(ID.d1, ID.s1, "principal", USERS.p1[0], async () => {
      await app.query(`
        INSERT INTO student_history_entry_attachments
          (district_id,school_id,student_id,entry_id,asset_id,caption)
        VALUES ($1,$2,$3,$4,$5,'Alice history image')
      `, [ID.d1, ID.s1, ID.alice, alice.id, asset]);
    });

    // Child rows must inherit the same school and district isolation as their
    // parent records; valid foreign keys must not make them visible cross-scope.
    const hiddenAtOtherSchool = await scoped(ID.d1, ID.s2, "principal", USERS.p2s[0], async () => {
      const counts = {};
      for (const table of ["student_history_entry_attachments", "student_time_capsule_items",
        "student_time_capsule_recipients", "student_time_capsule_events"]) {
        counts[table] = (await app.query(`SELECT count(*)::int AS n FROM ${table} WHERE student_id=$1`, [ID.alice])).rows[0].n;
      }
      await expectDenied(() => app.query(`
        INSERT INTO student_time_capsule_items
          (district_id,school_id,student_id,capsule_id,entry_id,entry_revision_no,position)
        VALUES ($1,$2,$3,$4,$5,2,9)
      `, [ID.d1, ID.s1, ID.alice, capsuleRefs.id, alice.id]));
      return counts;
    });
    assert.deepEqual(hiddenAtOtherSchool, {
      student_history_entry_attachments: 0,
      student_time_capsule_items: 0,
      student_time_capsule_recipients: 0,
      student_time_capsule_events: 0
    });
    const hiddenAtOtherDistrict = await scoped(ID.d2, ID.sd2, "superintendent", USERS.supt2[0], async () => {
      const counts = {};
      for (const table of ["student_history_entry_attachments", "student_time_capsule_items",
        "student_time_capsule_recipients", "student_time_capsule_events"]) {
        counts[table] = (await app.query(`SELECT count(*)::int AS n FROM ${table} WHERE student_id=$1`, [ID.alice])).rows[0].n;
      }
      return counts;
    });
    assert.deepEqual(hiddenAtOtherDistrict, {
      student_history_entry_attachments: 0,
      student_time_capsule_items: 0,
      student_time_capsule_recipients: 0,
      student_time_capsule_events: 0
    });
  });
});

describe("EduOS API against an unmigrated database (32.0.54)", { skip }, () => {
  it("refuses to start instead of failing on the first request", async () => {
    const db = await createDatabase();
    try {
      const r = await run(["src/server.js"], { ...baseEnv(), PORT: "1", DATABASE_URL: db.appUrl });
      assert.notEqual(r.code, 0);
      assert.match(r.out, /Refusing to start: the database schema is not migrated.*npm run db:migrate/);
    } finally { await db.drop(); }
  });
});
