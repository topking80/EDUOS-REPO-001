// OneRoster 1.2 and Ed-Fi connectors end to end against real PostgreSQL, with
// fake OneRoster and Ed-Fi servers on loopback: two-person approval, encrypted
// secrets, school mapping, preview then apply through the SIS import rules,
// re-approval after a change, failures recorded, and tenant isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

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
      if (url.pathname.endsWith("/students")) return send(200, { users: page([
        { sourcedId: "u-alice", identifier: "S1-A", givenName: "Alice", familyName: "Anders", grades: ["04"], roles: [{ roleType: "primary", role: "student", org: { sourcedId: "or-s1" } }] },
        { sourcedId: "u-dan", identifier: "S1-D", givenName: "Dan", familyName: "D", grades: ["03"], roles: [{ roleType: "primary", role: "student", org: { sourcedId: "or-s1" } }] },
        { sourcedId: "u-dup", identifier: "S1-D", givenName: "Dup", familyName: "D", roles: [{ roleType: "primary", role: "student", org: { sourcedId: "or-s1" } }] },
        { sourcedId: "u-carol", identifier: "S2-C", givenName: "Carol", familyName: "C", roles: [{ roleType: "primary", role: "student", org: { sourcedId: "or-s1" } }] },
        { sourcedId: "u-eve", identifier: "S2-E", givenName: "Eve", familyName: "E", grades: ["05"], orgs: [{ sourcedId: "or-s2" }] },
        { sourcedId: "u-far", identifier: "X-1", givenName: "Far", familyName: "F", orgs: [{ sourcedId: "or-x" }] },
        { sourcedId: "u-none", givenName: "No", familyName: "School" },
        { sourcedId: "u-gone", status: "tobedeleted", givenName: "Gone", orgs: [{ sourcedId: "or-s1" }] }]) });
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


function fakeCanvasOAuth() {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url !== "/login/oauth2/token") return send(404, {});
    if (req.method === "DELETE") { seen.push({ grant_type: "revoke", authorization: req.headers.authorization }); return send(200, {}); }
    if (req.method !== "POST") return send(405, {});
    let body = ""; for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body); seen.push(Object.fromEntries(form));
    if (form.get("client_id") !== "canvas-client" || form.get("client_secret") !== "canvas-secret")
      return send(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code" &&
        form.get("redirect_uri") === "http://localhost/api/integrations/canvas/callback")
      return send(200, { access_token: "canvas-access-secret", refresh_token: "canvas-refresh-secret",
        token_type: "Bearer", expires_in: 3600, user: { id: 9876, name: "District Canvas Admin" } });
    if (form.get("grant_type") === "refresh_token" &&
        ["canvas-refresh-secret","canvas-refresh-rotated"].includes(form.get("refresh_token")))
      return send(200, { access_token: "canvas-access-refreshed", token_type: "Bearer", expires_in: 3600 });
    return send(400, { error: "invalid_grant" });
  });
  return new Promise(resolve => srv.listen(0, "127.0.0.1", () =>
    resolve({ base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise(done => srv.close(done)) })));
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


  it("Canvas OAuth is two-person approved, browser-bound, single-use, tenant-scoped and encrypted", async () => {
    const canvasFake = await fakeCanvasOAuth();
    try {
      const added = await as("supt1")("POST", "/api/integrations/connectors", {
        kind: "canvas", name: "District Canvas", baseUrl: canvasFake.base,
        tokenUrl: `${canvasFake.base}/login/oauth2/token`, clientId: "canvas-client", clientSecret: "canvas-secret", scope: "url:GET|/api/v1/courses"
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      const id = added.body.data.id;
      assert.equal((await as("supt1")("POST", `/api/integrations/connectors/${id}/approve`)).body.error, "approver_must_differ");
      assert.equal((await as("supt1b")("POST", `/api/integrations/connectors/${id}/approve`)).status, 200);

      const started = await as("supt1")("POST", `/api/integrations/connectors/${id}/canvas/authorize`, {});
      assert.equal(started.status, 200, JSON.stringify(started.body));
      const authorization = new URL(started.body.data.authorizationUrl);
      assert.equal(authorization.pathname, "/login/oauth2/auth");
      assert.equal(authorization.searchParams.get("client_id"), "canvas-client");
      assert.equal(authorization.searchParams.get("scope"), "url:GET|/api/v1/courses");
      assert.equal(authorization.searchParams.get("redirect_uri"), "http://localhost/api/integrations/canvas/callback");
      const state = authorization.searchParams.get("state");
      assert.ok(state && state.length >= 32);
      const setCookie = started.headers.get("set-cookie") || "";
      const stateCookie = setCookie.match(/(eduos_canvas_state_[^=]+=[^;,]+)/)?.[1];
      assert.ok(stateCookie, "authorization state is browser-bound in an HttpOnly cookie");

      const callback = await fetch(`${server.base}/api/integrations/canvas/callback?code=one-time-code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: `${s.supt1.cookie}; ${stateCookie}` }, redirect: "manual"
      });
      assert.equal(callback.status, 303, await callback.text());
      assert.equal(callback.headers.get("location"), "/app/?canvas=connected");
      assert.equal(canvasFake.seen.length, 1);
      assert.equal(canvasFake.seen[0].grant_type, "authorization_code");
      assert.equal(canvasFake.seen[0].client_secret, "canvas-secret");

      const grant = (await admin.query("SELECT access_token_enc,refresh_token_enc,canvas_user_id FROM integration_canvas_oauth_grants WHERE connector_id=$1", [id])).rows[0];
      assert.ok(grant);
      assert.equal(grant.canvas_user_id, "9876");
      assert.ok(!grant.access_token_enc.includes("canvas-access-secret"));
      assert.ok(!grant.refresh_token_enc.includes("canvas-refresh-secret"));

      await admin.query("UPDATE integration_canvas_oauth_grants SET expires_at=now()-interval '1 second' WHERE connector_id=$1",[id]);
      const refreshPath = `/api/integrations/connectors/${id}/canvas/refresh`;
      const refreshed = await Promise.all([as("supt1")("POST",refreshPath,{}),as("supt1")("POST",refreshPath,{})]);
      assert.deepEqual(refreshed.map(x=>x.status),[200,200]);
      assert.deepEqual(refreshed.map(x=>x.body.data.connected),[true,true]);
      assert.equal(canvasFake.seen.filter(x => x.grant_type === "refresh_token").length,1,
        "concurrent callers share one database-serialized refresh");
      const rotated = (await admin.query("SELECT access_token_enc,refresh_token_enc FROM integration_canvas_oauth_grants WHERE connector_id=$1",[id])).rows[0];
      assert.ok(!rotated.access_token_enc.includes("canvas-access-refreshed"));
      assert.ok(!rotated.refresh_token_enc.includes("canvas-refresh-secret"));
      assert.equal(canvasFake.seen.find(x => x.grant_type === "refresh_token").refresh_token, "canvas-refresh-secret",
        "Canvas refresh responses retain the original refresh token");

      const status = await as("supt1")("GET", `/api/integrations/connectors/${id}/canvas/status`);
      assert.equal(status.status, 200);
      assert.equal(status.body.data.connected, true);
      assert.equal(JSON.stringify(status.body).includes("canvas-access-secret"), false);
      assert.equal(JSON.stringify(status.body).includes("canvas-refresh-secret"), false);
 
      const secondStart = await as("supt1")("POST", `/api/integrations/connectors/${id}/canvas/authorize`, {});
      const secondState = new URL(secondStart.body.data.authorizationUrl).searchParams.get("state");
      const secondCookie = (secondStart.headers.get("set-cookie") || "").match(/(eduos_canvas_state_[^=]+=[^;,]+)/)?.[1];
      assert.ok(secondCookie);
      const wrongBrowser = await fetch(`${server.base}/api/integrations/canvas/callback?code=wrong-user&state=${encodeURIComponent(secondState)}`, {
        headers: { cookie: `${s.supt1b.cookie}; ${secondCookie}` }, redirect: "manual"
      });
      assert.equal(wrongBrowser.status,400,"another district administrator cannot complete this user authorization");
      const wrongUserReplay = await fetch(`${server.base}/api/integrations/canvas/callback?code=retry&state=${encodeURIComponent(secondState)}`, {
        headers: { cookie: `${s.supt1.cookie}; ${secondCookie}` }, redirect: "manual"
      });
      assert.equal(wrongUserReplay.status,400,"failed browser/user binding still consumes OAuth state");
      const cancelStart = await as("supt1")("POST", `/api/integrations/connectors/${id}/canvas/authorize`, {});
      const cancelState = new URL(cancelStart.body.data.authorizationUrl).searchParams.get("state");
      const cancelCookie = (cancelStart.headers.get("set-cookie") || "").match(/(eduos_canvas_state_[^=]+=[^;,]+)/)?.[1];
      assert.ok(cancelCookie);

      const disconnected = await as("supt1")("POST", `/api/integrations/connectors/${id}/canvas/disconnect`, {});
      assert.equal(disconnected.status, 200, JSON.stringify(disconnected.body));
      assert.equal(disconnected.body.data.connected, false);
      assert.equal(disconnected.body.data.canvasTokenRevoked, true);
      assert.equal(disconnected.body.data.reapprovalRequired, true);
      assert.equal(disconnected.body.data.canvasDeveloperKeyRevocationRequired, true);
      const cancelledCallback = await fetch(`${server.base}/api/integrations/canvas/callback?code=cancelled&state=${encodeURIComponent(cancelState)}`, {
        headers: { cookie: `${s.supt1.cookie}; ${cancelCookie}` }, redirect: "manual"
      });
      assert.equal(cancelledCallback.status,400,"disconnect cancels an OAuth callback already in progress");
      assert.ok(canvasFake.seen.some(x => x.grant_type === "revoke" && x.authorization === "Bearer canvas-access-refreshed"));
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM integration_canvas_oauth_grants WHERE connector_id=$1", [id])).rows[0].n, 0);

      assert.equal((await as("supt1b")("POST", `/api/integrations/connectors/${id}/approve`)).status, 200, "a different district lead must reapprove after disconnect");
      const reauth = await as("supt1")("POST", `/api/integrations/connectors/${id}/canvas/authorize`, {});
      const reauthState = new URL(reauth.body.data.authorizationUrl).searchParams.get("state");
      const reauthCookie = (reauth.headers.get("set-cookie") || "").match(/(eduos_canvas_state_[^=]+=[^;,]+)/)?.[1];
      const reauthCallback = await fetch(`${server.base}/api/integrations/canvas/callback?code=reauthorize&state=${encodeURIComponent(reauthState)}`, {
        headers: { cookie: `${s.supt1.cookie}; ${reauthCookie}` }, redirect: "manual"
      });
      assert.equal(reauthCallback.status,303,await reauthCallback.text());
      const changed = await as("supt1")("PATCH", `/api/integrations/connectors/${id}`, { clientSecret: "rotated-canvas-secret" });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      assert.equal(changed.body.data.status, "pending_approval");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM integration_canvas_oauth_grants WHERE connector_id=$1", [id])).rows[0].n, 0,
        "credential changes invalidate the previously authorized token grant");
      const replay = await fetch(`${server.base}/api/integrations/canvas/callback?code=replay&state=${encodeURIComponent(state)}`, {
        headers: { cookie: `${s.supt1.cookie}; ${stateCookie}` }, redirect: "manual"
      });
      assert.equal(replay.status, 400, "consumed OAuth state cannot be replayed");

          } finally { await canvasFake.close(); }
  });

  it("another district sees none of it", async () => {
    const r = await as("supt2")("GET", "/api/integrations/connectors");
    assert.deepEqual(r.body.data.connectors, []);
  });
});
