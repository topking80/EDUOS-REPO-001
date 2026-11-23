// School operations work queues: the server enforces who may read, write,
// change and escalate, whatever the app shows (Phase 6 review, finding 4).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const STAFF = { nurse1: "nurse", counselor1: "counselor", maint1: "maintenance", lunch1: "lunch_staff", maint2: ["maintenance", "s2"] };

describe("school operations authorization against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, item = {};
  const as = name => client(server.base, s[name]);
  const add = (name, domain, body) => as(name)("POST", `/api/school-operations/${domain}`, { kind: "other", priority: "normal", summary: `${domain} task`, ...body });

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    for (const [sub, v] of Object.entries(STAFF)) {
      const [role, school] = Array.isArray(v) ? v : [v, "s1"];
      const id = crypto.randomUUID();
      await admin.query("INSERT INTO users(id, oidc_issuer, oidc_subject, display_name, email) VALUES ($1,$2,$3,$3,$4)", [id, idp.issuer, sub, `${sub}@d1.test`]);
      await admin.query("INSERT INTO memberships(user_id, district_id, school_id, role, is_default) VALUES ($1,$2,$3,$4,true)", [id, ID.d1, ID[school], role]);
    }
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of [...Object.keys(STAFF), "p1", "p2", "vp1", "t1", "pa", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    item.health = (await add("nurse1", "health_office", { kind: "supply" })).body.data.id;
    item.counseling = (await add("counselor1", "counseling", { kind: "schedule_change" })).body.data.id;
    item.facilities = (await add("maint1", "facilities", { kind: "repair", details: "Hinge on the gym door" })).body.data.id;
    for (const id of Object.values(item)) assert.ok(id);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("restricted queues can't be read by other teams, teachers or families", async () => {
    for (const [who, domain] of [["maint1", "health_office"], ["maint1", "counseling"], ["nurse1", "counseling"], ["counselor1", "health_office"],
      ["lunch1", "health_office"], ["t1", "health_office"], ["pa", "counseling"], ["t1", "facilities"]]) {
      const r = await as(who)("GET", `/api/school-operations/${domain}`);
      assert.equal(r.status, 403, `${who} read ${domain}`);
    }
    assert.equal((await as("nurse1")("GET", "/api/school-operations/health_office")).body.data.length, 1);
    for (const who of ["t1", "pa"]) assert.equal((await as(who)("GET", "/api/school-operations/command-center")).status, 403, who);
  });

  it("health and counseling items never accept free-text details, and only their team adds them", async () => {
    assert.equal((await add("nurse1", "health_office", { details: "Student X has asthma" })).status, 400);
    assert.equal((await add("counselor1", "counseling", { details: "Session notes" })).status, 400);
    assert.equal((await add("maint1", "health_office", {})).status, 403);
    assert.equal((await add("p1", "counseling", {})).status, 403, "leads route; they don't file counseling items");
    assert.equal((await add("t1", "facilities", {})).status, 403);
  });

  it("a team changes only its own domain's items", async () => {
    const set = (who, domain, id, status) => as(who)("POST", `/api/school-operations/${domain}/${id}/status`, { status });
    assert.equal((await set("maint1", "health_office", item.health, "cancelled")).status, 403, "maintenance closing a health-office item");
    assert.equal((await set("nurse1", "facilities", item.facilities, "completed")).status, 403, "nurse closing a work order");
    assert.equal((await set("lunch1", "counseling", item.counseling, "cancelled")).status, 403);
    assert.equal((await set("t1", "facilities", item.facilities, "completed")).status, 403);
    assert.equal((await set("maint1", "facilities", item.facilities, "in_progress")).status, 200);
    assert.equal((await set("vp1", "health_office", item.health, "in_progress")).status, 200, "leads can move any domain at their school");
  });

  it("only leads escalate, and only at their own school or district", async () => {
    const esc = (who, domain, id) => as(who)("POST", `/api/school-operations/${domain}/${id}/escalate`, {});
    for (const who of ["maint1", "nurse1", "t1", "pa"]) assert.equal((await esc(who, "facilities", item.facilities)).status, 403, who);
    assert.equal((await esc("p2", "facilities", item.facilities)).status, 404, "another school's principal");
    assert.equal((await esc("supt2", "facilities", item.facilities)).status, 404, "another district");
    assert.equal((await esc("p1", "facilities", item.facilities)).status, 200);
  });

  it("nobody changes another school's or district's work", async () => {
    assert.equal((await as("maint2")("POST", `/api/school-operations/facilities/${item.facilities}/status`, { status: "cancelled" })).status, 404, "same role, other school");
    assert.equal((await as("p2")("POST", `/api/school-operations/health_office/${item.health}/status`, { status: "cancelled" })).status, 404);
    assert.equal((await as("supt2")("POST", `/api/school-operations/counseling/${item.counseling}/status`, { status: "cancelled" })).status, 404);
    assert.equal((await as("maint2")("GET", "/api/school-operations/facilities")).body.data.length, 0, "other school's queue is empty");
    const st = (await admin.query("SELECT status FROM school_service_work WHERE id=$1", [item.counseling])).rows[0].status;
    assert.equal(st, "open");
  });

  // 37.7.3 broken connections: GET/POST /api/school-operations/:domain was
  // registered first and answered "command-center", "schedules" and
  // "notification-preferences" as if they were work-queue domains (403).
  it("the command center, schedules and reminder settings are reachable, not swallowed by /:domain", async () => {
    for (const who of ["p1", "vp1", "supt1", "nurse1", "maint1"]) {
      const r = await as(who)("GET", "/api/school-operations/command-center");
      assert.equal(r.status, 200, `${who} command center: ${JSON.stringify(r.body)}`);
      assert.ok(Array.isArray(r.body.data.summary) && Array.isArray(r.body.data.work), who);
    }
    const sched = await as("p1")("GET", "/api/school-operations/schedules");
    assert.equal(sched.status, 200, JSON.stringify(sched.body));
    const made = await as("p1")("POST", "/api/school-operations/schedules", { domain: "facilities", kind: "inspection", summary: "Check fire doors", cadence: "weekly", nextRunAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await as("t1")("GET", "/api/school-operations/schedules")).status, 403);
    const prefs = await as("p1")("GET", "/api/school-operations/notification-preferences");
    assert.equal(prefs.status, 200, JSON.stringify(prefs.body));
    assert.equal(typeof prefs.body.data.in_app_enabled, "boolean");
  });
});
