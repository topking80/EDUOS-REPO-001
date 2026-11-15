// OneRoster 1.2 and Ed-Fi connectors end to end against real PostgreSQL, with
// fake OneRoster and Ed-Fi servers on loopback: two-person approval, encrypted
// secrets, school mapping, preview then apply through the SIS import rules,
// re-approval after a change, failures recorded, and tenant isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const SECRET = "or-secret-123", EDFI_SECRET = "edfi-secret-456";

function fakeServer() {
  const seen = [];
  const srv = http.createServer((req, res) => {
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
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise(x => srv.close(x)) })));
}

describe("OneRoster and Ed-Fi connectors against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, fake, s = {}, or, ef;
  const as = name => client(server.base, s[name]);
  const sync = (name, id, mode) => as(name)("POST", `/api/integrations/connectors/${id}/sync`, { mode });
  const student = async (num) => (await admin.query("SELECT display_name, grade_level, school_id FROM students WHERE local_student_number=$1", [num])).rows[0];

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    fake = await fakeServer();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, INTEGRATIONS_KEY: "test-integrations-key-0123456789abcdef", INTEGRATIONS_ALLOW_INSECURE_LOOPBACK: "true" });
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
    assert.deepEqual(audit, ["create", "approve", "sync_preview", "update", "sync_preview", "sync_apply"]);
    const hist = (await as("supt1")("GET", `/api/integrations/connectors/${or.id}/runs`)).body.data;
    assert.deepEqual(hist.map(r => r.status), ["completed", "previewed", "previewed"]);
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
    const a = await sync("supt1", ef.id, "apply");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(await student("E-100"), { display_name: "Fay F", grade_level: "2", school_id: ID.s1 });
    assert.equal(await student("E-101"), undefined, "withdrawn student not imported");
    const runs = (await as("supt1")("GET", `/api/integrations/connectors/${ef.id}/runs`)).body.data.map(r => r.status);
    assert.deepEqual(runs, ["completed", "failed"]);
  });

  it("another district sees none of it", async () => {
    const r = await as("supt2")("GET", "/api/integrations/connectors");
    assert.deepEqual(r.body.data.connectors, []);
  });
});
