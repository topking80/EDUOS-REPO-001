// Guardian relationship revocation (db/182): a school leader ends a guardian's
// link and every family view of that child stops at once; the guardian can't
// switch it back on themselves; restoring it brings access back.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const FAMILY_VIEWS = () => [
  `/api/family/children/${ID.alice}/summary`,
  `/api/student-360/${ID.alice}`,
  `/api/learning/progress?studentId=${ID.alice}`,
  `/api/learning/schedule?studentId=${ID.alice}&days=1`,
  `/api/learning/courses?studentId=${ID.alice}`,
];

describe("guardian relationship revocation", { skip }, () => {
  let db, idp, server, admin, app, s = {};
  const as = name => client(server.base, s[name]);

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["p1", "p2", "t1", "pa", "supt1", "vp1"]) s[n] = await login(server.base, idp, n, { email_verified: true });
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => { await app?.end(); await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only the student's school leaders see and change guardian links", async () => {
    const list = await as("p1")("GET", `/api/students/${ID.alice}/guardians`);
    assert.equal(list.status, 200); assert.ok(list.body.data.some(g => g.userId === USERS.pa[0] && g.status === "active"));
    assert.equal((await as("vp1")("GET", `/api/students/${ID.alice}/guardians`)).status, 200);
    assert.equal((await as("p2")("GET", `/api/students/${ID.alice}/guardians`)).status, 404, "another school");
    assert.equal((await as("t1")("GET", `/api/students/${ID.alice}/guardians`)).status, 403);
    assert.equal((await as("pa")("POST", `/api/students/${ID.alice}/guardians/${USERS.pa[0]}/disable`, { reason: "test" })).status, 403);
    assert.equal((await as("p1")("POST", `/api/students/${ID.alice}/guardians/${USERS.pa[0]}/disable`, {})).body.error, "reason_required");
  });

  it("ending a link stops every family view of that child at once", async () => {
    for (const p of FAMILY_VIEWS()) assert.equal((await as("pa")("GET", p)).status, 200, `before: ${p}`);
    const r = await as("p1")("POST", `/api/students/${ID.alice}/guardians/${USERS.pa[0]}/disable`, { reason: "Court order received by the office" });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.data.note, /pick-up restriction/);
    for (const p of FAMILY_VIEWS()) assert.ok([403, 404].includes((await as("pa")("GET", p)).status), `after: ${p}`);
    assert.ok(!(await as("pa")("GET", "/api/family/children")).body.data.some(c => c.id === ID.alice), "Alice is gone from their children");
    const audit = await admin.query("SELECT 1 FROM audit_events WHERE action='disable_guardian_link' AND resource_id=$1", [ID.alice]);
    assert.equal(audit.rowCount, 1);
  });

  it("a disabled guardian can't switch their own link back on", async () => {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','parent',true), set_config('app.school_id',$3,true)", [ID.d1, USERS.pa[0], ID.s1]);
      await assert.rejects(app.query("UPDATE student_user_links SET status='active' WHERE user_id=$1 AND student_id=$2", [USERS.pa[0], ID.alice]), /only by accepting an invitation/);
    } finally { await app.query("ROLLBACK"); }
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','parent',true), set_config('app.school_id',$3,true)", [ID.d1, USERS.pa[0], ID.s1]);
      await assert.rejects(app.query("INSERT INTO student_user_links(district_id,user_id,student_id,relationship,status) VALUES($1,$2,$3,'parent','active')", [ID.d1, USERS.pa[0], ID.bob]), /only by accepting an invitation|row-level/);
    } finally { await app.query("ROLLBACK"); }
  });

  it("restoring the link brings access back", async () => {
    assert.equal((await as("supt1")("POST", `/api/students/${ID.alice}/guardians/${USERS.pa[0]}/enable`, { reason: "Order lifted" })).status, 200);
    for (const p of FAMILY_VIEWS()) assert.equal((await as("pa")("GET", p)).status, 200, `restored: ${p}`);
    assert.equal((await as("p1")("POST", `/api/students/${ID.alice}/guardians/${USERS.pa[0]}/enable`, { reason: "again" })).body.error, "no_disabled_guardian_link");
  });
});
