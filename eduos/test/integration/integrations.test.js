// OneRoster 1.2 and Ed-Fi connectors end to end against real PostgreSQL, with
// fake OneRoster and Ed-Fi servers on loopback: two-person approval, encrypted
// secrets, school mapping, preview then apply through the SIS import rules,
// re-approval after a change, failures recorded, and tenant isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const SECRET = "or-secret-123", EDFI_SECRET = "edfi-secret-456";

function fakeServer() {
  const seen = [];
  const ctl = { hold: null }; // a promise: /students waits for it (to change things mid-sync)
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x"); seen.push(`${req.method} ${url.pathname}`);
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const offset = Number(url.searchParams.get("offset") || 0);
    const page = (list) => list.slice(offset, offset + Number(url.searchParams.get("limit") || 100));
    if (req.method === "POST" && url.pathname.endsWith("/token")) {
      let body = ""; req.on("data", c => body += c); req.on("end", () => {
        const [id, secret] = Buffer.from(String(req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString().split(":");
        const ok = new URLSearchParams(body).get("grant_type") === "client_credentials" && ((id === "or-client" && secret === SECRET) || (id === "edfi-client" && secret === EDFI_SECRET));
        ok ? send(200, { access_token: `tok-${id}`, token_type: "Bearer", expires_in: 1800 }) : send(401, { error: "invalid_client" });
      }); return;
    }
    const auth = req.headers.authorization;
    if (url.pathname.startsWith("/ims/")) {
      if (auth !== "Bearer tok-or-client") return send(401, {});
      if (url.pathname.endsWith("/schools")) return send(200, { orgs: page([{ sourcedId: "or-s1", name: "S1", type: "school", status: "active" },
        { sourcedId: "or-s2", name: "S2", type: "school", status: "active" }, { sourcedId: "or-x", name: "Somewhere Else", type: "school" }]) });
      if (url.pathname.endsWith("/students") && ctl.hold) { ctl.arrived?.(); await ctl.hold; }
      // SIS-06: honour OneRoster's dateLastModified filter (or refuse it, when told to).
      const filter = url.searchParams.get("filter");
      if (url.pathname.endsWith("/students") && filter) {
        if (ctl.rejectFilter) return send(400, { error: "filter not supported" });
        ctl.filters = [...(ctl.filters || []), filter];
        const since = Date.parse(/dateLastModified>'([^']+)'/.exec(filter)?.[1]);
        return send(200, { users: page((ctl.newStudents || []).filter(u => Date.parse(u.dateLastModified) > since)) });
      }
      if (url.pathname.endsWith("/students")) return send(200, { users: page([...(ctl.newStudents || []),
        { sourcedId: "u-alice", identifier: "S1-A", givenName: "Alice", familyName: "Anders", grades: ["04"], roles: [{ roleType: "primary", role: "student", org: { sourcedId: "or-s1" } }] },
        { sourcedId: "u-dan", identifier: "S1-D", givenName: "Dan", familyName: "D", grades: ["03"], roles: [{ roleType: "primary", role: "student", org: { sourcedId: "or-s1" } }] },
        { sourcedId: "u-dup", identifier: "S1-D", givenName: "Dup", familyName: "D", roles: [{ roleType: "primary", role: "student", org: { sourcedId: "or-s1" } }] },
        { sourcedId: "u-carol", identifier: "S2-C", givenName: "Carol", familyName: "C", roles: [{ roleType: "primary", role: "student", org: { sourcedId: "or-s1" } }] },
        { sourcedId: "u-eve", identifier: "S2-E", givenName: "Eve", familyName: "E", grades: ["05"], orgs: [{ sourcedId: "or-s2" }] },
        { sourcedId: "u-far", identifier: "X-1", givenName: "Far", familyName: "F", orgs: [{ sourcedId: "or-x" }] },
        { sourcedId: "u-none", givenName: "No", familyName: "School" },
        { sourcedId: "u-gone", status: "tobedeleted", givenName: "Gone", orgs: [{ sourcedId: "or-s1" }] }]) });
    }
    // SIS-04 class rosters (OneRoster): one class at S1 with two teachers and two students.
    if (url.pathname.endsWith("/classes")) return send(200, { classes: page([{ sourcedId: "cls-1", title: "Grade 4 Math", school: { sourcedId: "or-s1" } }]) });
    if (url.pathname.endsWith("/teachers")) return send(200, { users: page([
      { sourcedId: "tch-1", givenName: "Teacher", familyName: "S1", email: "T1@D1.test" },
      { sourcedId: "tch-2", givenName: "New", familyName: "Hire", email: "new.hire@d1.test" }]) });
    if (url.pathname.endsWith("/enrollments")) return send(200, { enrollments: page(ctl.noEnrollments ? [] : [
      { sourcedId: "en-1", role: "teacher", user: { sourcedId: "tch-1" }, class: { sourcedId: "cls-1" } },
      { sourcedId: "en-2", role: "teacher", user: { sourcedId: "tch-2" }, class: { sourcedId: "cls-1" } },
      { sourcedId: "en-3", role: "student", user: { sourcedId: "u-alice" }, class: { sourcedId: "cls-1" } },
      ...(ctl.dropDan ? [] : [{ sourcedId: "en-4", role: "student", user: { sourcedId: "u-dan" }, class: { sourcedId: "cls-1" } }])]) });
    // SIS-06: Ed-Fi Change Queries.
    if (url.pathname === "/api/changeQueries/v1/availableChangeVersions") {
      if (auth !== "Bearer tok-edfi-client") return send(401, {});
      if (ctl.edfiNoChangeQueries) return send(404, {});
      return send(200, { oldestChangeVersion: 0, newestChangeVersion: ctl.edfiVersion ?? 10 });
    }
    if (url.pathname.startsWith("/api/data/ed-fi/") && (url.searchParams.has("minChangeVersion") || url.searchParams.has("studentUniqueId"))) {
      if (auth !== "Bearer tok-edfi-client") return send(401, {});
      const r = url.pathname.split("/").pop(), min = Number(url.searchParams.get("minChangeVersion")), max = Number(url.searchParams.get("maxChangeVersion"));
      const id = url.searchParams.get("studentUniqueId");
      const all = { students: [{ studentUniqueId: "E-100", firstName: "Fay", lastSurname: "F", changeVersion: 1 }, ...(ctl.edfiStudents || [])],
        studentSchoolAssociations: [{ studentReference: { studentUniqueId: "E-100" }, schoolReference: { schoolId: 255901 }, entryDate: "2026-08-20", changeVersion: 1,
          entryGradeLevelDescriptor: "uri://ed-fi.org/GradeLevelDescriptor#Second grade" }, ...(ctl.edfiAssoc || [])] }[r] || [];
      const key = x => x.studentUniqueId || x.studentReference?.studentUniqueId;
      if (id) return send(200, page(all.filter(x => key(x) === id)));
      ctl.edfiWindows = [...(ctl.edfiWindows || []), `${r}:${min}-${max}`];
      return send(200, page(all.filter(x => x.changeVersion >= min && x.changeVersion <= max)));
    }
    if (url.pathname.startsWith("/api/data/ed-fi/")) {
      if (auth !== "Bearer tok-edfi-client") return send(401, {});
      const r = url.pathname.split("/").pop();
      if (r === "schools") return send(200, page([{ schoolId: 255901, nameOfInstitution: "S1" }]));
      if (r === "students") return send(200, page([{ studentUniqueId: "E-100", firstName: "Fay", lastSurname: "F" }, { studentUniqueId: "E-101", firstName: "Gus", lastSurname: "G" }]));
      if (r === "studentSchoolAssociations") return send(200, page([
        { studentReference: { studentUniqueId: "E-100" }, schoolReference: { schoolId: 255901 }, entryDate: "2026-08-20", entryGradeLevelDescriptor: "uri://ed-fi.org/GradeLevelDescriptor#Second grade" },
        { studentReference: { studentUniqueId: "E-101" }, schoolReference: { schoolId: 255901 }, entryDate: "2025-08-20", exitWithdrawDate: "2026-05-30" }]));
    }
    send(404, {});
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ base: `http://127.0.0.1:${srv.address().port}`, seen, ctl, close: () => new Promise(x => srv.close(x)) })));
}

describe("OneRoster and Ed-Fi connectors against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, fake, s = {}, or, ef, workerEnv;
  const as = name => client(server.base, s[name]);
  const sync = (name, id, mode) => as(name)("POST", `/api/integrations/connectors/${id}/sync`, { mode });
  const student = async (num) => (await admin.query("SELECT display_name, grade_level, school_id FROM students WHERE local_student_number=$1", [num])).rows[0];

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    fake = await fakeServer();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, INTEGRATIONS_KEY: crypto.randomBytes(32).toString("hex"), INTEGRATIONS_ALLOW_INSECURE_LOOPBACK: "true", SIS_SYNC_DISPATCH_ENABLED: "false" });
    workerEnv = { ...env, SIS_SYNC_DISPATCH_ENABLED: "true" };
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt1b", "p1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await fake?.close(); await idp?.close(); await db?.drop(); });

  it("a district lead adds a connector; the secret is encrypted and never returned", async () => {
    assert.equal((await as("p1")("GET", "/api/integrations/connectors")).status, 403, "principals can't");
    assert.equal((await as("supt1")("POST", "/api/integrations/connectors", { kind: "oneroster", name: "x", baseUrl: "https://10.1.2.3/ims", tokenUrl: `${fake.base}/token`, clientId: "a", clientSecret: "b" })).body.field, "baseUrl", "private addresses are refused");
    const r = await as("supt1")("POST", "/api/integrations/connectors", { kind: "oneroster", name: "District SIS", baseUrl: `${fake.base}/ims/oneroster/rostering/v1p2`,
      tokenUrl: `${fake.base}/token`, clientId: "or-client", clientSecret: SECRET });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    or = r.body.data;
    assert.equal(or.status, "pending_approval");
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
    const stored = (await admin.query("SELECT client_secret_enc FROM integration_connectors WHERE id=$1", [or.id])).rows[0].client_secret_enc;
    assert.ok(!stored.includes(SECRET), "encrypted at rest");
    assert.equal((await sync("supt1", or.id, "preview")).body.error, "connector_not_approved");
  });

  it("a different district lead must approve it", async () => {
    const self = await as("supt1")("POST", `/api/integrations/connectors/${or.id}/approve`);
    assert.equal(self.status, 409); assert.equal(self.body.error, "approver_must_differ");
    assert.equal((await as("supt2")("POST", `/api/integrations/connectors/${or.id}/approve`)).status, 404, "another district can't see it");
    const ok = await as("supt1b")("POST", `/api/integrations/connectors/${or.id}/approve`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.data.status, "active");
  });

  it("preview changes nothing and suggests school mappings", async () => {
    const p = await sync("supt1", or.id, "preview");
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.data.counts.toImport, 0);
    assert.equal(p.body.data.externalSchools.find(x => x.externalId === "or-s1").suggestedSchoolId, ID.s1);
    assert.equal(await student("S1-D"), undefined);
  });

  it("apply imports mapped schools through the SIS rules and reports what it skipped", async () => {
    const m = await as("supt1")("PUT", `/api/integrations/connectors/${or.id}/school-map`, { mappings: [{ externalId: "or-s1", schoolId: ID.s1 }, { externalId: "or-s2", schoolId: ID.s2 }] });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal((await sync("supt1", or.id, "preview")).body.error, "connector_not_approved", "new school links need approval");
    assert.equal((await as("supt1")("POST", `/api/integrations/connectors/${or.id}/approve`)).body.error, "approver_must_differ");
    assert.equal((await as("supt1b")("POST", `/api/integrations/connectors/${or.id}/approve`)).status, 200);
    const p = await sync("supt1", or.id, "preview");
    assert.equal(p.body.data.counts.toImport, 3, JSON.stringify(p.body.data));
    const a = await sync("supt1", or.id, "apply");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.data.rejected.map(r => r.reason).sort(), ["duplicate_student_number", "enrolled_at_another_eduos_school", "no_school"]);
    assert.equal(a.body.data.counts.notMapped, 1);
    assert.deepEqual(await student("S1-D"), { display_name: "Dan D", grade_level: "3", school_id: ID.s1 });
    assert.equal((await student("S1-A")).display_name, "Alice Anders", "existing student updated");
    assert.equal((await student("S2-C")).school_id, ID.s2, "not moved between schools");
    assert.equal((await student("S2-E")).school_id, ID.s2);
    assert.equal(await student("X-1"), undefined, "unmapped school not imported");
    const runs = await admin.query("SELECT source_system FROM sis_sync_runs WHERE source_system=$1", [`oneroster:${or.id}`]);
    assert.equal(runs.rows.length, 2, "one SIS run per school");
    const audit = (await admin.query("SELECT action FROM audit_events WHERE resource_type IN ('integration_connector','integration_school_map') ORDER BY occurred_at")).rows.map(r => r.action);
    assert.deepEqual(audit, ["create", "approve", "sync_preview", "update", "approve", "sync_preview", "sync_apply"]);
    const hist = (await as("supt1")("GET", `/api/integrations/connectors/${or.id}/runs`)).body.data;
    assert.deepEqual(hist.map(r => r.status), ["completed", "previewed", "previewed"]);
  });

  it("a change made while a sync is reading their roster stops that sync importing", async () => {
    let release; fake.ctl.hold = new Promise(r => { release = r; });
    const arrived = new Promise(r => { fake.ctl.arrived = r; });
    const pending = sync("supt1", or.id, "apply");
    await arrived; // the sync is now waiting on /students
    assert.equal((await as("supt1b")("PUT", `/api/integrations/connectors/${or.id}/school-map`, { mappings: [{ externalId: "or-s2", schoolId: ID.s1 }] })).status, 200);
    fake.ctl.hold = null; fake.ctl.arrived = null; release();
    const r = await pending;
    assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.error, "connector_changed_during_sync");
    assert.equal((await student("S2-E")).school_id, ID.s2, "nothing imported under the new, unapproved links");
    assert.equal((await as("supt1")("GET", `/api/integrations/connectors/${or.id}/runs`)).body.data[0].status, "failed");
    // Put the link back and re-approve.
    await as("supt1b")("PUT", `/api/integrations/connectors/${or.id}/school-map`, { mappings: [{ externalId: "or-s2", schoolId: ID.s2 }] });
    assert.equal((await as("supt1")("POST", `/api/integrations/connectors/${or.id}/approve`)).status, 200);
  });

  it("changing where it connects needs approval again", async () => {
    const u = await as("supt1b")("PATCH", `/api/integrations/connectors/${or.id}`, { baseUrl: `${fake.base}/ims/oneroster/rostering/v1p2/` });
    assert.equal(u.body.data.status, "pending_approval");
    assert.equal((await sync("supt1", or.id, "apply")).body.error, "connector_not_approved");
    assert.equal((await as("supt1b")("POST", `/api/integrations/connectors/${or.id}/approve`)).body.error, "approver_must_differ");
    assert.equal((await as("supt1")("POST", `/api/integrations/connectors/${or.id}/approve`)).status, 200);
  });

  it("Ed-Fi imports currently enrolled students; bad credentials are recorded as a failed run", async () => {
    const c = await as("supt1")("POST", "/api/integrations/connectors", { kind: "edfi", name: "State Ed-Fi", baseUrl: `${fake.base}/api/data`,
      tokenUrl: `${fake.base}/oauth/token`, clientId: "edfi-client", clientSecret: "wrong" });
    ef = c.body.data;
    await as("supt1b")("POST", `/api/integrations/connectors/${ef.id}/approve`);
    const bad = await sync("supt1", ef.id, "preview");
    assert.equal(bad.status, 502); assert.equal(bad.body.error, "connector_auth_failed");
    await as("supt1")("PATCH", `/api/integrations/connectors/${ef.id}`, { clientSecret: EDFI_SECRET });
    await as("supt1b")("POST", `/api/integrations/connectors/${ef.id}/approve`);
    await as("supt1")("PUT", `/api/integrations/connectors/${ef.id}/school-map`, { mappings: [{ externalId: "255901", schoolId: ID.s1 }] });
    await as("supt1b")("POST", `/api/integrations/connectors/${ef.id}/approve`);
    const a = await sync("supt1", ef.id, "apply");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(await student("E-100"), { display_name: "Fay F", grade_level: "2", school_id: ID.s1 });
    assert.equal(await student("E-101"), undefined, "withdrawn student not imported");
    const runs = (await as("supt1")("GET", `/api/integrations/connectors/${ef.id}/runs`)).body.data.map(r => r.status);
    assert.deepEqual(runs, ["completed", "failed"]);
  });

  it("scheduled sync requires independent approval, executes as a service actor, and honors district pause", async () => {
    const currentPreview = await sync("supt1", or.id, "preview");
    assert.equal(currentPreview.status, 200, JSON.stringify(currentPreview.body));
    const configured = await as("supt1")("PUT", `/api/integrations/connectors/${or.id}/schedule`, { intervalMinutes: 15 });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal((await as("supt1")("POST", `/api/integrations/connectors/${or.id}/schedule/approve`)).body.error, "approver_must_differ");
    const approved = await as("supt1b")("POST", `/api/integrations/connectors/${or.id}/schedule/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const dispatched = await run(["src/integrations/scheduler-cli.js"], { ...workerEnv, DATABASE_URL: db.appUrl });
    assert.equal(dispatched.code, 0, dispatched.out);
    const serviceRun = (await admin.query(
      "SELECT started_by,started_by_service,status,schedule_id,scheduled_job_id,schedule_approved_by,schedule_approved_at FROM integration_sync_runs WHERE connector_id=$1 AND started_by_service IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      [or.id])).rows[0];
    assert.ok(serviceRun, "scheduled connector run is visible in history");
    assert.equal(serviceRun.started_by, null, "scheduler is not impersonating a user");
    assert.ok(serviceRun.started_by_service);
    assert.equal(serviceRun.status, "completed");
    assert.ok(serviceRun.schedule_id);
    assert.ok(serviceRun.scheduled_job_id);
    assert.ok(serviceRun.schedule_approved_by, "human schedule approver is retained on the run");
    assert.ok(serviceRun.schedule_approved_at);
    const scheduledHistory = (await as("supt1")("GET", `/api/integrations/connectors/${or.id}/runs`)).body.data;
    assert.ok(scheduledHistory[0].schedule_approved_by);
    assert.ok(scheduledHistory[0].schedule_approved_at);
    const sisRun = (await admin.query(
      "SELECT initiated_by,initiated_by_service FROM sis_sync_runs WHERE source_system=$1 AND initiated_by_service IS NOT NULL LIMIT 1",
      [`oneroster:${or.id}`])).rows[0];
    assert.ok(sisRun);
    assert.equal(sisRun.initiated_by, null);
    assert.ok(sisRun.initiated_by_service);
    assert.ok((await admin.query("SELECT 1 FROM audit_events WHERE actor_service_id=$1 AND action='scheduled_sync'", [serviceRun.started_by_service])).rowCount);

    const paused = await as("supt1")("POST", "/api/integrations/schedules/pause-all", { reason: "district_test_pause" });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const before = Number((await admin.query("SELECT count(*)::int AS n FROM integration_sync_runs WHERE connector_id=$1 AND started_by_service IS NOT NULL", [or.id])).rows[0].n);
    const skipped = await run(["src/integrations/scheduler-cli.js"], { ...workerEnv, DATABASE_URL: db.appUrl });
    assert.equal(skipped.code, 0, skipped.out);
    const afterPause = Number((await admin.query("SELECT count(*)::int AS n FROM integration_sync_runs WHERE connector_id=$1 AND started_by_service IS NOT NULL", [or.id])).rows[0].n);
    assert.equal(afterPause, before, "paused schedule does not execute");

    const resumed = await as("supt1")("POST", `/api/integrations/connectors/${or.id}/schedule/resume`);
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));

    // Pause while the worker is fetching. The final import transaction must
    // re-check the lease and schedule state and must not apply this roster.
    let release; fake.ctl.hold = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { fake.ctl.arrived = resolve; });
    const inFlight = run(["src/integrations/scheduler-cli.js"], { ...workerEnv, DATABASE_URL: db.appUrl });
    await arrived;
    const pausedInFlight = await as("supt1")("POST", "/api/integrations/schedules/pause-all", { reason: "pause_during_fetch" });
    assert.equal(pausedInFlight.status, 200, JSON.stringify(pausedInFlight.body));
    fake.ctl.hold = null; fake.ctl.arrived = null; release();
    const stopped = await inFlight;
    assert.equal(stopped.code, 0, stopped.out);
    const afterCancelled = Number((await admin.query("SELECT count(*)::int AS n FROM integration_sync_runs WHERE connector_id=$1 AND started_by_service IS NOT NULL", [or.id])).rows[0].n);
    assert.equal(afterCancelled, before, "pause during fetch prevents the scheduled import");

    const resumedAgain = await as("supt1")("POST", `/api/integrations/connectors/${or.id}/schedule/resume`);
    assert.equal(resumedAgain.status, 200, JSON.stringify(resumedAgain.body));
    const resumedRun = await run(["src/integrations/scheduler-cli.js"], { ...workerEnv, DATABASE_URL: db.appUrl });
    assert.equal(resumedRun.code, 0, resumedRun.out);
    const afterResume = Number((await admin.query("SELECT count(*)::int AS n FROM integration_sync_runs WHERE connector_id=$1 AND started_by_service IS NOT NULL", [or.id])).rows[0].n);
    assert.equal(afterResume, before + 1, "resume queues a fresh scheduled run");

    const changed = await as("supt1")("PATCH", `/api/integrations/connectors/${or.id}`, { scope: "changed-scope" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.data.status, "pending_approval");
    const invalidated = await as("supt1")("GET", `/api/integrations/connectors/${or.id}/schedule`);
    assert.equal(invalidated.body.data.enabled, false, "connector edits disable the previous schedule approval");
    assert.ok(invalidated.body.data.paused_at);
    assert.equal(invalidated.body.data.pause_reason, "connector_configuration_changed");
    assert.equal(invalidated.body.data.approved_at, null, "old schedule approval is invalidated");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM integration_sync_jobs WHERE connector_id=$1 AND status IN ('pending','processing')", [or.id])).rows[0].n, 0);
  });

  it("SIS-04: class rosters are opt-in, approved, matched to existing teachers, and never touch hand-entered rosters", async () => {
    const rosterOf = async () => (await admin.query(`SELECT u.email, s.local_student_number AS num, (r.source_connector_id IS NOT NULL) AS synced
        FROM teacher_student_rosters r JOIN users u ON u.id=r.teacher_user_id JOIN students s ON s.id=r.student_id
       WHERE r.district_id=$1 ORDER BY 1,2`, [ID.d1])).rows.map(r => `${r.email}:${r.num}:${r.synced ? "sis" : "hand"}`);
    // A roster row a person entered by hand.
    await admin.query(`INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by)
      SELECT $1,$2,$3,s.id,$4 FROM students s WHERE s.district_id=$1 AND s.local_student_number='S1-A'`, [ID.d1, ID.s1, USERS.t1[0], USERS.p1[0]]);
    const c = (await as("supt1")("POST", "/api/integrations/connectors", { kind: "oneroster", name: "Rosters OneRoster", baseUrl: `${fake.base}/ims/oneroster/rostering/v1p2`,
      tokenUrl: `${fake.base}/oauth/token`, clientId: "or-client", clientSecret: SECRET, classRosters: true })).body.data;
    assert.deepEqual(c.dataScope, ["students", "class_rosters"]);
    assert.equal(c.status, "pending_approval");
    await as("supt1")("PUT", `/api/integrations/connectors/${c.id}/school-map`, { mappings: [{ externalId: "or-s1", schoolId: ID.s1 }] });
    assert.equal((await as("supt1b")("POST", `/api/integrations/connectors/${c.id}/approve`)).status, 200);

    const before = await rosterOf();
    const p = await sync("supt1", c.id, "preview");
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(await rosterOf(), before, "a preview changes nothing");
    assert.equal(p.body.data.counts.rosters.toAdd, 1, "Teacher S1 + Dan (Alice is already on their roster by hand)");
    assert.equal(p.body.data.counts.rosters.keptManual, 1);
    assert.deepEqual(p.body.data.unmatchedTeachers, [{ externalId: "tch-2", reason: "no_matching_eduos_teacher", name: "New Hire", email: "new.hire@d1.test" }]);

    const a = await sync("supt1", c.id, "apply");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(await rosterOf(), ["t1@d1.test:S1-A:hand", "t1@d1.test:S1-D:sis"], "matched by email, case-insensitive; no account created for New Hire");

    // Dan leaves the class: only the synced link goes; the hand-entered one stays.
    fake.ctl.dropDan = true;
    assert.equal((await sync("supt1", c.id, "apply")).body.data.counts.rosters.toRemove, 1);
    assert.deepEqual(await rosterOf(), ["t1@d1.test:S1-A:hand"]);

    // Matching New Hire by hand to an existing teacher needs approval again.
    const m = await as("supt1")("PUT", `/api/integrations/connectors/${c.id}/staff-map`, { mappings: [{ externalId: "tch-2", userId: USERS.tp[0] }] });
    assert.equal(m.body.data.status, "pending_approval");
    assert.equal((await sync("supt1", c.id, "apply")).body.error, "connector_not_approved");
    assert.equal((await as("supt1")("PUT", `/api/integrations/connectors/${c.id}/staff-map`, { mappings: [{ externalId: "tch-2", userId: USERS.pa[0] }] })).body.error,
      "teacher_not_found", "only an EduOS teacher can be matched");
    await as("supt1b")("POST", `/api/integrations/connectors/${c.id}/approve`);
    await sync("supt1", c.id, "apply");
    assert.deepEqual(await rosterOf(), ["t1@d1.test:S1-A:hand", "tp@d1.test:S1-A:sis"]);

    // The SIS returns no enrollments at all: nothing is removed, and the run says why.
    fake.ctl.noEnrollments = true;
    const empty = await sync("supt1", c.id, "apply");
    assert.equal(empty.status, 409); assert.equal(empty.body.error, "sync_not_applied");
    assert.match(empty.body.detail, /no class enrollments/);
    assert.deepEqual(await rosterOf(), ["t1@d1.test:S1-A:hand", "tp@d1.test:S1-A:sis"]);
    fake.ctl.noEnrollments = false; fake.ctl.dropDan = false;

    // A scheduled sync (the service actor, no user) applies class rosters the same way.
    // (A schedule needs a preview of the current configuration first.)
    assert.equal((await sync("supt1", c.id, "preview")).status, 200);
    assert.equal((await as("supt1")("PUT", `/api/integrations/connectors/${c.id}/schedule`, { intervalMinutes: 15 })).status, 200);
    const approvedSchedule = await as("supt1b")("POST", `/api/integrations/connectors/${c.id}/schedule/approve`);
    assert.equal(approvedSchedule.status, 200, JSON.stringify(approvedSchedule.body));
    const scheduled = await run(["src/integrations/scheduler-cli.js"], { ...workerEnv, DATABASE_URL: db.appUrl });
    assert.equal(scheduled.code, 0, scheduled.out);
    assert.deepEqual(await rosterOf(), ["t1@d1.test:S1-A:hand", "t1@d1.test:S1-D:sis", "tp@d1.test:S1-A:sis", "tp@d1.test:S1-D:sis"], "Dan is back, added by the scheduled run");
    const lastRun = (await admin.query("SELECT started_by, counts FROM integration_sync_runs WHERE connector_id=$1 AND started_by_service IS NOT NULL ORDER BY started_at DESC LIMIT 1", [c.id])).rows[0];
    assert.equal(lastRun.started_by, null);
    assert.equal(lastRun.counts.rosters.toAdd, 2);

    const audit = (await admin.query("SELECT action, detail FROM audit_events WHERE resource_type='integration_staff_map' AND resource_id=$1", [c.id])).rows;
    assert.match(audit[0].detail, /tch-2=>.*needs approval/);
  });

  it("SIS-06: scheduled syncs read only changes between full syncs, and fall back to full when the source can't answer", async () => {
    const runSchedule = async () => {
      await admin.query("UPDATE integration_sync_schedules SET next_run_at=now()-interval '1 second' WHERE enabled AND paused_at IS NULL");
      const r = await run(["src/integrations/scheduler-cli.js"], { ...workerEnv, DATABASE_URL: db.appUrl });
      assert.equal(r.code, 0, r.out);
    };
    const lastRun = async id => (await admin.query("SELECT counts FROM integration_sync_runs WHERE connector_id=$1 AND started_by_service IS NOT NULL ORDER BY started_at DESC LIMIT 1", [id])).rows[0]?.counts;
    const setUp = async (body, mapping) => {
      const c = (await as("supt1")("POST", "/api/integrations/connectors", body)).body.data;
      await as("supt1")("PUT", `/api/integrations/connectors/${c.id}/school-map`, { mappings: [mapping] });
      assert.equal((await as("supt1b")("POST", `/api/integrations/connectors/${c.id}/approve`)).status, 200);
      assert.equal((await sync("supt1", c.id, "preview")).status, 200);
      const sched = await as("supt1")("PUT", `/api/integrations/connectors/${c.id}/schedule`, { intervalMinutes: 60, incremental: true, fullSyncHours: 24 });
      assert.equal(sched.status, 200, JSON.stringify(sched.body));
      assert.deepEqual([sched.body.data.incremental, sched.body.data.full_sync_hours], [true, 24]);
      assert.equal((await as("supt1b")("POST", `/api/integrations/connectors/${c.id}/schedule/approve`)).status, 200);
      return c;
    };

    // OneRoster.
    const c = await setUp({ kind: "oneroster", name: "Incremental OneRoster", baseUrl: `${fake.base}/ims/oneroster/rostering/v1p2`,
      tokenUrl: `${fake.base}/oauth/token`, clientId: "or-client", clientSecret: SECRET }, { externalId: "or-s1", schoolId: ID.s1 });
    await runSchedule();
    assert.deepEqual((await lastRun(c.id)).sync, { mode: "full", reason: "no_previous_full_sync" }, "the first run is full");
    const wm = (await admin.query("SELECT sync_watermark, last_full_sync_at FROM integration_connectors WHERE id=$1", [c.id])).rows[0];
    assert.ok(wm.sync_watermark.since && wm.last_full_sync_at);

    fake.ctl.newStudents = [{ sourcedId: "u-new", identifier: "S1-NEW", givenName: "Nia", familyName: "New", dateLastModified: new Date().toISOString(),
      roles: [{ roleType: "primary", role: "student", org: { sourcedId: "or-s1" } }] }];
    await runSchedule();
    const inc = await lastRun(c.id);
    assert.equal(inc.sync.mode, "incremental", JSON.stringify(inc));
    assert.equal(inc.studentsFetched, 1, "only the changed student was read");
    assert.match(fake.ctl.filters.at(-1), /^dateLastModified>'\d{4}-/);
    assert.equal((await student("S1-NEW")).display_name, "Nia New");

    fake.ctl.rejectFilter = true;
    await runSchedule();
    const fb = await lastRun(c.id);
    assert.deepEqual(fb.sync, { mode: "full", reason: "incremental_failed:connector_http_error" }, "their server refused the filter: full sync instead");
    assert.ok(fb.studentsFetched > 1);
    fake.ctl.rejectFilter = false; fake.ctl.newStudents = [];

    // Ed-Fi Change Queries.
    fake.ctl.edfiVersion = 10;
    const e = await setUp({ kind: "edfi", name: "Incremental Ed-Fi", baseUrl: `${fake.base}/api/data`, tokenUrl: `${fake.base}/oauth/token`,
      clientId: "edfi-client", clientSecret: EDFI_SECRET }, { externalId: "255901", schoolId: ID.s1 });
    await runSchedule();
    assert.equal((await lastRun(e.id)).sync.mode, "full");
    assert.equal((await admin.query("SELECT sync_watermark FROM integration_connectors WHERE id=$1", [e.id])).rows[0].sync_watermark.changeVersion, 10);
    // A new student enrolls (version 11); only versions 11-12 are read.
    fake.ctl.edfiVersion = 12;
    fake.ctl.edfiStudents = [{ studentUniqueId: "E-102", firstName: "Hal", lastSurname: "H", changeVersion: 11 }];
    fake.ctl.edfiAssoc = [{ studentReference: { studentUniqueId: "E-102" }, schoolReference: { schoolId: 255901 }, entryDate: "2026-11-01", changeVersion: 12,
      entryGradeLevelDescriptor: "uri://ed-fi.org/GradeLevelDescriptor#Third grade" }];
    await runSchedule();
    const einc = await lastRun(e.id);
    assert.equal(einc.sync.mode, "incremental", JSON.stringify(einc));
    assert.deepEqual(fake.ctl.edfiWindows.slice(-2), ["students:11-12", "studentSchoolAssociations:11-12"]);
    assert.deepEqual(await student("E-102"), { display_name: "Hal H", grade_level: "3", school_id: ID.s1 });
    assert.equal((await admin.query("SELECT sync_watermark FROM integration_connectors WHERE id=$1", [e.id])).rows[0].sync_watermark.changeVersion, 12);
    // Nothing changed: an incremental run that imports nothing, and succeeds.
    await runSchedule();
    const none = await lastRun(e.id);
    assert.deepEqual([none.sync.mode, none.studentsFetched], ["incremental", 0], JSON.stringify(none));
    fake.ctl.edfiStudents = []; fake.ctl.edfiAssoc = [];
  });

  it("another district sees none of it", async () => {
    const r = await as("supt2")("GET", "/api/integrations/connectors");
    assert.deepEqual(r.body.data.connectors, []);
  });
});
